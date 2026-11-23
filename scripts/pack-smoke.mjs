import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

assertPublishManifestHasBin();

const packed = JSON.parse(run("npm", ["pack", "--json"], { cwd: root }));
const filename = packed[0]?.filename;
if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
  throw new Error("npm pack did not return a tarball.");
}
assertTarballPackageJsonHasBin(join(root, filename));

const tarball = join(root, filename);
const dir = mkdtempSync(join(tmpdir(), "copilot-pack-"));

try {
  run("npm", ["init", "-y"], { cwd: dir });
  run("npm", ["install", "--ignore-scripts", "--no-fund", "--no-audit", tarball], { cwd: dir });

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
  rmSync(tarball, { force: true });
}

function assertPublishManifestHasBin() {
  const npm = process.env.npm_execpath ? process.execPath : "npm";
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, "publish", "--dry-run"]
    : ["publish", "--dry-run"];
  const result = spawnSync(npm, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/bin\[.+\].*invalid and removed/i.test(output)) {
    throw new Error(
      `npm publish --dry-run rejected package.json bin (see @npmcli/package-json normalizePackageBin / secureAndUnixifyPath):\n${output}`,
    );
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !/requires you to be logged in/i.test(output)) {
    throw new Error(output || `npm publish --dry-run exited ${result.status}.`);
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