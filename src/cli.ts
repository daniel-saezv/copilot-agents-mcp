#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  authLockPath,
  createAppSession,
  createMemoryStore,
  githubAppClientId,
  ignoredTokenWarning,
  loginWithDeviceFlow,
  logoutLocal,
  logoutMessage,
  personalAccessToken,
  readActiveToken,
  readGitHubApp,
  statusReport,
  systemAccount,
  type AppSession,
  type SecretStore,
  type StoredCredential,
} from "./auth.ts";
import { createGitHubClient } from "./github.ts";
import { startHttpServer } from "./http.ts";
import { NO_SESSION_MESSAGE, ToolFailure } from "./errors.ts";
import { readSweModels } from "./swe-models.ts";
import { assertSelection, splitList, type Selection } from "./selection.ts";
import { buildServer, defaultLaunchWatcher, packageVersion } from "./server.ts";
import { defaultStatePath } from "./state.ts";
import { deliverNotice } from "./notify.ts";
import { acquireWatcher, releaseWatcher, runWatcher, watcherLockPath } from "./watch.ts";

export type ServeCommand = { command: "serve"; http: false; selection: Selection } | { command: "serve"; http: true; port: number; selection: Selection };
export type WatchCommand = { command: "watch" };
export type CliCommand = ServeCommand | WatchCommand | { command: "login" } | { command: "logout" } | { command: "status" } | { command: "version" };

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliCommand {
  const args = [...argv];
  if (args.includes("--version")) return { command: "version" };
  if (args[0] === "watch") {
    if (args.length > 1) throw new Error("watch no admite más argumentos.");
    return { command: "watch" };
  }
  if (args[0] === "login") {
    if (args.length > 1) throw new Error("login no admite más argumentos.");
    return { command: "login" };
  }
  if (args[0] === "logout") {
    if (args.length > 1) throw new Error("logout no admite más argumentos.");
    return { command: "logout" };
  }
  if (args[0] === "auth") {
    if (args[1] !== "status" || args.length !== 2) throw new Error("Usa `auth status`.");
    return { command: "status" };
  }
  let http = false;
  let port: number | undefined;
  let toolsets: string[] | undefined;
  let tools: string[] | undefined;
  let exclude: string[] | undefined;
  let readOnly = false;
  let features: string[] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") throw new Help();
    if (arg === "--http") {
      http = true;
      continue;
    }
    if (arg === "--read-only") {
      readOnly = true;
      continue;
    }
    const value = valueOf(arg, args, index);
    if (value.consumed) index += 1;
    if (value.name === "--port") {
      port = Number(value.text);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port tiene que ser un entero entre 0 y 65535.");
      continue;
    }
    if (value.name === "--toolsets") {
      toolsets = splitList(value.text);
      continue;
    }
    if (value.name === "--tools") {
      tools = splitList(value.text);
      continue;
    }
    if (value.name === "--exclude-tools") {
      exclude = splitList(value.text);
      continue;
    }
    if (value.name === "--features") {
      features = splitList(value.text);
      continue;
    }
    throw new Error(`Argumento desconocido: ${arg}`);
  }
  const selection: Selection = {
    exclude: exclude ?? (env.GITHUB_EXCLUDE_TOOLS ? splitList(env.GITHUB_EXCLUDE_TOOLS) : []),
    readOnly: readOnly || /^(1|true)$/i.test(env.GITHUB_READ_ONLY ?? ""),
    features: features ?? [],
  };
  if (toolsets) selection.toolsets = toolsets;
  else if (env.GITHUB_TOOLSETS) selection.toolsets = splitList(env.GITHUB_TOOLSETS);
  if (tools) selection.tools = tools;
  else if (env.GITHUB_TOOLS) selection.tools = splitList(env.GITHUB_TOOLS);
  assertSelection(selection);
  if (http) return { command: "serve", http: true, port: port ?? 3333, selection };
  if (port !== undefined) throw new Error("--port solo se usa con --http.");
  return { command: "serve", http: false, selection };
}

function valueOf(arg: string, args: string[], index: number): { name: string | undefined; text: string; consumed: boolean } {
  const names = ["--port", "--toolsets", "--tools", "--exclude-tools", "--features"];
  for (const name of names) {
    if (arg === name) {
      const text = args[index + 1];
      if (!text || text.startsWith("--")) throw new Error(`Falta el valor de ${name}.`);
      return { name, text, consumed: true };
    }
    if (arg.startsWith(`${name}=`)) return { name, text: arg.slice(name.length + 1), consumed: false };
  }
  return { name: undefined, text: "", consumed: false };
}

class Help extends Error {
  constructor() {
    super(helpText());
    this.name = "Help";
  }
}

function helpText(): string {
  return [
    "copilot-agents-mcp",
    "  Servidor MCP por stdio.",
    "copilot-agents-mcp --version",
    "  Muestra la versión de package.json.",
    "copilot-agents-mcp --http [--port 3333]",
    "  Servidor MCP por HTTP en 127.0.0.1.",
    "copilot-agents-mcp watch",
    "  Vigila las tareas pendientes y avisa una vez al terminar.",
    "copilot-agents-mcp login",
    "  Inicia sesión con la GitHub App y guarda el token en el llavero.",
    "copilot-agents-mcp logout",
    "  Borra la sesión del llavero.",
    "copilot-agents-mcp auth status",
    "  Dice qué credencial está activa, sin mostrar el token.",
    "",
    "Opciones: --toolsets, --tools, --exclude-tools, --read-only, --features",
    "Variables: GITHUB_PERSONAL_ACCESS_TOKEN, COPILOT_AGENTS_GITHUB_APP_CLIENT_ID,",
    "GITHUB_TOOLSETS, GITHUB_TOOLS, GITHUB_EXCLUDE_TOOLS, GITHUB_READ_ONLY,",
    "COPILOT_AGENTS_NOTIFY_URL, COPILOT_AGENTS_NOTIFY_AUTHORIZATION, COPILOT_AGENTS_STATE_PATH",
  ].join("\n");
}

async function serve(command: ServeCommand): Promise<void> {
  warnIgnored(process.env);
  const statePath = defaultStatePath();
  const pat = personalAccessToken(process.env);
  const session = pat ? null : await openAppSession(process.env, statePath);
  const readToken = () => readActiveToken(process.env, () => session?.peek() ?? null);
  const deps = {
    statePath,
    readToken,
    clientForToken: (token: string) => createGitHubClient({ token, tokens: session ?? undefined }),
    readModels: async () => {
      const token = readToken();
      if (!token) throw new ToolFailure(NO_SESSION_MESSAGE);
      return readSweModels({ token, tokens: session ?? undefined });
    },
    launchWatcher: defaultLaunchWatcher,
  };
  if (!command.http) {
    const mcp = buildServer(command.selection, deps);
    await mcp.connect(new StdioServerTransport());
    return;
  }
  const http = await startHttpServer({ port: command.port, selection: command.selection, deps });
  console.error(`copilot-agents-mcp escuchando en ${http.url}`);
}

async function watch(): Promise<void> {
  warnIgnored(process.env);
  const statePath = defaultStatePath();
  const pat = personalAccessToken(process.env);
  const session = pat ? null : await openAppSession(process.env, statePath);
  const token = readActiveToken(process.env, () => session?.peek() ?? null);
  if (!token) {
    console.error(NO_SESSION_MESSAGE);
    process.exitCode = 1;
    return;
  }
  const lock = watcherLockPath(statePath);
  const acquired = await acquireWatcher(lock);
  if (!acquired) return;
  try {
    const interval = Number(process.env.COPILOT_AGENTS_POLL_INTERVAL_MS ?? "15000");
    await runWatcher({
      client: createGitHubClient({ token, tokens: session ?? undefined }),
      statePath,
      deliver: (notice) => deliverNotice(notice),
      intervalMs: Number.isFinite(interval) && interval >= 0 ? interval : 15_000,
    });
  } finally {
    await releaseWatcher(lock);
  }
}

async function main(): Promise<void> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 18)) {
    console.error(`Hace falta Node.js 22.18 o posterior. Hay ${process.versions.node}.`);
    process.exitCode = 1;
    return;
  }
  try {
    const command = parseArgs(process.argv.slice(2), process.env);
    if (command.command === "watch") await watch();
    else if (command.command === "login") await login();
    else if (command.command === "logout") await logout();
    else if (command.command === "status") await status();
    else if (command.command === "version") console.log(packageVersion());
    else await serve(command);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Error.");
    process.exitCode = error instanceof Help ? 0 : 1;
  }
}

function warnIgnored(env: NodeJS.ProcessEnv): void {
  const message = ignoredTokenWarning(env);
  if (message) console.error(message);
}

async function openSecretStore(warnOnFailure: boolean): Promise<{ store: SecretStore; persistent: boolean }> {
  try {
    const { systemSecretStore } = await import("./keyring.ts");
    return { store: systemSecretStore(), persistent: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "error desconocido";
    if (warnOnFailure) {
      console.error(`No hay llavero disponible (${reason}). El token se queda solo en la memoria de este proceso y no se escribe en disco.`);
    }
    return { store: createMemoryStore(), persistent: false };
  }
}

async function openAppSession(env: NodeJS.ProcessEnv, statePath: string): Promise<AppSession> {
  const opened = await openSecretStore(true);
  return createAppSession({
    store: opened.store,
    lockPath: authLockPath(statePath),
    clientId: githubAppClientId(env),
    fetchImpl: fetch,
    now: () => Date.now(),
    warn: (message) => console.error(message),
  });
}

async function login(): Promise<void> {
  warnIgnored(process.env);
  if (personalAccessToken(process.env)) {
    console.error("GITHUB_PERSONAL_ACCESS_TOKEN está definida y tiene prioridad. La sesión de la app no se usará hasta quitar esa variable.");
  }
  const opened = await openSecretStore(true);
  await loginWithDeviceFlow({
    clientId: githubAppClientId(process.env),
    fetchImpl: fetch,
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    now: () => Date.now(),
    store: opened.store,
    persistent: opened.persistent,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
}

async function logout(): Promise<void> {
  warnIgnored(process.env);
  const opened = await openSecretStore(true);
  console.log(logoutMessage(logoutLocal(opened.store)));
}

async function status(): Promise<void> {
  warnIgnored(process.env);
  const pat = personalAccessToken(process.env);
  const opened = await openSecretStore(!pat);
  let stored: StoredCredential | null = null;
  if (opened.persistent || !pat) {
    const session = createAppSession({
      store: opened.store,
      lockPath: authLockPath(defaultStatePath()),
      clientId: githubAppClientId(process.env),
      fetchImpl: fetch,
      now: () => Date.now(),
      warn: (message) => {
        if (!pat) console.error(message);
      },
    });
    stored = session.stored();
  }
  const app = !pat && stored ? await readGitHubApp(stored.access_token, fetch) : null;
  console.log(statusReport({
    env: process.env,
    stored,
    keyring: opened.persistent ? "ready" : "memory",
    account: systemAccount(),
    appName: app?.name ?? null,
    appNotInstalled: app?.empty === true,
  }));
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (invokedDirectly()) {
  void main();
}
