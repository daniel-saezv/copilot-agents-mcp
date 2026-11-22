import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = "0.0.1";
const expectedTools = [
  "abort_agent_task",
  "create_agent_task",
  "get_agent_task",
  "get_agent_task_events",
  "list_copilot_models",
  "steer_agent_task",
];

const packed = JSON.parse(run("npm", ["pack", "--json"], { cwd: root }));
const filename = packed[0]?.filename;
if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
  throw new Error("npm pack no devolvió el tarball.");
}
const tarball = join(root, filename);
const dir = mkdtempSync(join(tmpdir(), "copilot-pack-"));

try {
  run("npm", ["init", "-y"], { cwd: dir });
  run("npm", ["install", "--ignore-scripts", "--no-fund", "--no-audit", tarball], { cwd: dir });
  const bin = join(dir, "node_modules", ".bin", "copilot-agents-mcp");
  const version = run(bin, ["--version"], { cwd: dir }).trim();
  if (version !== expectedVersion) {
    throw new Error(`--version imprimió ${JSON.stringify(version)}.`);
  }
  console.log(`--version ${version}`);
  const names = await listedTools(bin);
  console.log(`tools/list ${names.join(", ")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}

async function listedTools(bin) {
  const env = { ...process.env };
  delete env.GITHUB_PERSONAL_ACCESS_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const transport = new StdioClientTransport({
    command: bin,
    args: [],
    env,
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk));
  });
  const client = new Client({ name: "pack-smoke", version: expectedVersion });
  try {
    await withTimeout(client.connect(transport), 20_000, "initialize");
    const version = client.getServerVersion();
    if (version?.version !== expectedVersion) {
      throw new Error(`initialize anunció ${JSON.stringify(version)}.`);
    }
    const listed = await withTimeout(client.listTools(), 20_000, "tools/list");
    const names = listed.tools.map((tool) => tool.name).sort();
    if (names.join("\n") !== expectedTools.join("\n")) {
      throw new Error(`tools/list devolvió ${names.join(", ")}.`);
    }
    return names;
  } catch (error) {
    const detail = stderr.join("");
    const message = error instanceof Error ? error.message : "el servidor no respondió";
    throw new Error(detail ? `${message}\n${detail}` : message);
  } finally {
    await client.close().catch(() => {});
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} no respondió en ${ms / 1000} s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr, `${command} salió ${result.status}.`].filter(Boolean).join("\n"));
  }
  return result.stdout ?? "";
}
