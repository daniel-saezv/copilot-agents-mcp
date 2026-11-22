#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGitHubClient } from "./github.ts";
import { startHttpServer } from "./http.ts";
import { readPricing } from "./pricing.ts";
import { assertSelection, splitList, type Selection } from "./selection.ts";
import { buildServer, defaultLaunchWatcher } from "./server.ts";
import { defaultStatePath } from "./state.ts";
import { deliverNotice } from "./notify.ts";
import { acquireWatcher, releaseWatcher, runWatcher, watcherLockPath } from "./watch.ts";

const TOKEN_ENVS = ["GITHUB_PERSONAL_ACCESS_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

export function readGitHubToken(env: NodeJS.ProcessEnv): string | null {
  for (const name of TOKEN_ENVS) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export type ServeCommand = { command: "serve"; http: false; selection: Selection } | { command: "serve"; http: true; port: number; selection: Selection };
export type WatchCommand = { command: "watch" };
export type CliCommand = ServeCommand | WatchCommand;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliCommand {
  const args = [...argv];
  if (args[0] === "watch") {
    if (args.length > 1) throw new Error("watch no admite más argumentos.");
    return { command: "watch" };
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
    "copilot-agents-mcp --http [--port 3333]",
    "  Servidor MCP por HTTP en 127.0.0.1.",
    "copilot-agents-mcp watch",
    "  Vigila las tareas pendientes y avisa una vez al terminar.",
    "",
    "Opciones: --toolsets, --tools, --exclude-tools, --read-only, --features",
    "Variables: GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_TOOLSETS, GITHUB_TOOLS,",
    "GITHUB_EXCLUDE_TOOLS, GITHUB_READ_ONLY, COPILOT_AGENTS_NOTIFY_URL,",
    "COPILOT_AGENTS_NOTIFY_AUTHORIZATION, COPILOT_AGENTS_STATE_PATH",
  ].join("\n");
}

async function serve(command: ServeCommand): Promise<void> {
  const statePath = defaultStatePath();
  const deps = {
    statePath,
    readToken: () => readGitHubToken(process.env),
    clientForToken: (token: string) => createGitHubClient({ token }),
    readPricing,
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
  const token = readGitHubToken(process.env);
  if (!token) {
    console.error("Falta la variable de entorno GITHUB_PERSONAL_ACCESS_TOKEN.");
    process.exitCode = 1;
    return;
  }
  const statePath = defaultStatePath();
  const lock = watcherLockPath(statePath);
  const acquired = await acquireWatcher(lock);
  if (!acquired) return;
  try {
    const interval = Number(process.env.COPILOT_AGENTS_POLL_INTERVAL_MS ?? "15000");
    await runWatcher({
      client: createGitHubClient({ token }),
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
    else await serve(command);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Error.");
    process.exitCode = error instanceof Help ? 0 : 1;
  }
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
