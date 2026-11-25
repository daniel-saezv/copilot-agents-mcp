import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expectedVersion = pkg.version;
const expectedTools = [
  "abort_agent_task",
  "create_agent_task",
  "get_agent_task",
  "list_agent_tasks",
  "list_copilot_models",
  "set_completion_strategy",
  "steer_agent_task",
];

assertPackManifestHasBin();

const dir = mkdtempSync(join(tmpdir(), "copilot-pack-"));
const tarball = join(dir, "package.tgz");

try {
  const packed = JSON.parse(run("pnpm", ["pack", "--out", tarball, "--json"], { cwd: root }));
  if (typeof packed.filename !== "string" || !packed.filename.endsWith(".tgz")) {
    throw new Error("pnpm pack did not return a tarball.");
  }
  const intendedFiles = new Set([
    "CHANGELOG.md",
    "docs/tools.md",
    "fixtures/openapi/create-task.request.json",
    "fixtures/openapi/create-task.response.json",
    "fixtures/openapi/get-task.response.json",
    "LICENSE",
    "package.json",
    "README.md",
  ]);
  for (const file of packed.files) {
    if (!/^dist\/[a-z][a-z-]*\.js$/.test(file.path) && !intendedFiles.has(file.path)) {
      throw new Error(`Unexpected package file: ${file.path}.`);
    }
  }
  console.log(`pack files ${packed.files.map((file) => file.path).join(", ")}`);
  assertTarballPackageJsonHasBin(tarball);
  run("pnpm", ["init"], { cwd: dir });
  run("pnpm", ["add", "--ignore-scripts", tarball], { cwd: dir });

  const binLink = join(dir, "node_modules", ".bin", "copilot-agents-mcp");
  if (!existsSync(binLink)) {
    throw new Error("Installed package did not expose bin copilot-agents-mcp in node_modules/.bin.");
  }

  const cli = join(dir, "node_modules", "copilot-agents-mcp", "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error(`Packed install is missing ${cli}.`);
  }

  const version = run(process.execPath, [cli, "--version"], { cwd: dir }).trim();
  if (version !== expectedVersion) {
    throw new Error(`--version printed ${JSON.stringify(version)}.`);
  }
  console.log(`--version ${version}`);

  const names = await listedTools(process.execPath, cli);
  console.log(`tools/list ${names.join(", ")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function assertPackManifestHasBin() {
  const result = spawnSync("pnpm", ["pack", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/bin\[.+\].*invalid and removed/i.test(output)) {
    throw new Error(
      `pnpm pack --dry-run rejected package.json bin:\n${output}`,
    );
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(output || `pnpm pack --dry-run exited ${result.status}.`);
  }
}

function assertTarballPackageJsonHasBin(tarballPath) {
  const listing = run("tar", ["-tzf", tarballPath], { cwd: root });
  if (!listing.split("\n").some((line) => line === "package/dist/cli.js")) {
    throw new Error("Packed tarball does not contain package/dist/cli.js.");
  }
  const pkg = JSON.parse(run("tar", ["-xOf", tarballPath, "package/package.json"], { cwd: root }));
  const bin = pkg?.bin?.["copilot-agents-mcp"];
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error(`Packed package.json is missing bin.copilot-agents-mcp (got ${JSON.stringify(pkg?.bin)}).`);
  }
}

async function listedTools(node, cli) {
  const env = { ...process.env };
  delete env.GITHUB_PERSONAL_ACCESS_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const transport = new StdioClientTransport({
    command: node,
    args: [cli],
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
      throw new Error(`initialize advertised ${JSON.stringify(version)}.`);
    }
    const listed = await withTimeout(client.listTools(), 20_000, "tools/list");
    const names = listed.tools.map((tool) => tool.name).sort();
    if (names.join("\n") !== expectedTools.join("\n")) {
      throw new Error(`tools/list returned ${names.join(", ")}.`);
    }
    return names;
  } catch (error) {
    const detail = stderr.join("");
    const message = error instanceof Error ? error.message : "the server did not respond";
    throw new Error(detail ? `${message}\n${detail}` : message);
  } finally {
    await client.close().catch(() => {});
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not respond within ${ms / 1000} s.`)), ms);
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
    throw new Error([result.stdout, result.stderr, `${command} exited ${result.status}.`].filter(Boolean).join("\n"));
  }
  return result.stdout ?? "";
}