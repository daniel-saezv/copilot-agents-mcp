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
import { NO_SESSION_MESSAGE, ToolFailure } from "./errors.ts";
import { readSweModels } from "./swe-models.ts";
import { buildServer, defaultLaunchWatcher, packageVersion } from "./server.ts";
import { formatLocalStatusDiagnostics } from "./status-local.ts";
import { defaultStatePath } from "./state.ts";
import { deliverNotice } from "./notify.ts";
import { acquireWatcher, releaseWatcher, runWatcher, watcherLockPath } from "./watch.ts";

export const WATCH_POLL_INTERVAL_MS = 15_000;

export type ServeCommand = { command: "serve" };
export type WatchCommand = { command: "watch" };
export type CliCommand = ServeCommand | WatchCommand | { command: "login" } | { command: "logout" } | { command: "status" } | { command: "version" };

export function parseArgs(argv: string[]): CliCommand {
  const args = [...argv];
  if (args.includes("--version")) return { command: "version" };
  if (args[0] === "watch") {
    if (args.length > 1) throw new Error("watch does not accept additional arguments.");
    return { command: "watch" };
  }
  if (args[0] === "login") {
    if (args.length > 1) throw new Error("login does not accept additional arguments.");
    return { command: "login" };
  }
  if (args[0] === "logout") {
    if (args.length > 1) throw new Error("logout does not accept additional arguments.");
    return { command: "logout" };
  }
  if (args[0] === "auth") {
    if (args[1] !== "status" || args.length !== 2) throw new Error("Use `auth status`.");
    return { command: "status" };
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") throw new Help();
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command: "serve" };
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
    "  MCP server over stdio.",
    "copilot-agents-mcp --version",
    "  Print the version from package.json.",
    "copilot-agents-mcp watch",
    "  Watch pending tasks and notify once when they finish.",
    "copilot-agents-mcp login",
    "  Sign in with the GitHub App and save the token in the keyring.",
    "copilot-agents-mcp logout",
    "  Delete the keyring session.",
    "copilot-agents-mcp auth status",
    "  Show which credential is active without showing the token, plus local diagnostics (state, notify env, D-Bus).",
    "",
    "Environment: GITHUB_PERSONAL_ACCESS_TOKEN, COPILOT_AGENTS_GITHUB_APP_CLIENT_ID,",
    "COPILOT_AGENTS_NOTIFY_URL, COPILOT_AGENTS_NOTIFY_AUTHORIZATION, COPILOT_AGENTS_STATE_PATH,",
    "COPILOT_AGENTS_GITHUB_API_BASE_URL",
  ].join("\n");
}

import { githubApiBase } from "./github-hosts.ts";

export { githubApiBase };

export function warnGithubApiBase(env: NodeJS.ProcessEnv): void {
  const base = githubApiBase(env);
  if (base) console.error(`Using COPILOT_AGENTS_GITHUB_API_BASE_URL=${base}`);
}

function githubClient(token: string, env: NodeJS.ProcessEnv, session: AppSession | null) {
  const baseUrl = githubApiBase(env);
  return createGitHubClient({
    token,
    tokens: session ?? undefined,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

async function serve(): Promise<void> {
  warnIgnored(process.env);
  warnGithubApiBase(process.env);
  const statePath = defaultStatePath();
  const pat = personalAccessToken(process.env);
  const session = pat ? null : await openAppSession(process.env, statePath);
  const readToken = () => readActiveToken(process.env, () => session?.peek() ?? null);
  const deps = {
    statePath,
    readToken,
    clientForToken: (token: string) => githubClient(token, process.env, session),
    readModels: async () => {
      const token = readToken();
      if (!token) throw new ToolFailure(NO_SESSION_MESSAGE);
      return readSweModels({ token, tokens: session ?? undefined });
    },
    launchWatcher: defaultLaunchWatcher,
  };
  const mcp = buildServer(deps);
  await mcp.connect(new StdioServerTransport());
}

async function watch(): Promise<void> {
  warnIgnored(process.env);
  warnGithubApiBase(process.env);
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
    await runWatcher({
      client: githubClient(token, process.env, session),
      statePath,
      deliver: (notice) => deliverNotice(notice),
      intervalMs: WATCH_POLL_INTERVAL_MS,
    });
  } finally {
    await releaseWatcher(lock);
  }
}

export function supportsNode(version: string): boolean {
  const [major] = version.split(".").map(Number);
  return (major ?? 0) >= 26;
}

async function main(): Promise<void> {
  if (!supportsNode(process.versions.node)) {
    console.error(`Node.js 26 or later is required. Found ${process.versions.node}.`);
    process.exitCode = 1;
    return;
  }
  try {
    const command = parseArgs(process.argv.slice(2));
    if (command.command === "watch") await watch();
    else if (command.command === "login") await login();
    else if (command.command === "logout") await logout();
    else if (command.command === "status") await status();
    else if (command.command === "version") console.log(packageVersion());
    else await serve();
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
    const reason = error instanceof Error ? error.message : "unknown error";
    if (warnOnFailure) {
      console.error(`No keyring is available (${reason}). The token remains only in this process's memory and is not written to disk.`);
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
    console.error("GITHUB_PERSONAL_ACCESS_TOKEN is set and takes precedence. The app session will not be used until that variable is removed.");
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
  const credential = statusReport({
    env: process.env,
    stored,
    keyring: opened.persistent ? "ready" : "memory",
    account: systemAccount(),
    appName: app?.name ?? null,
    appNotInstalled: app?.empty === true,
  });
  const local = await formatLocalStatusDiagnostics(process.env);
  console.log(`${credential}\n\n${local}`);
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