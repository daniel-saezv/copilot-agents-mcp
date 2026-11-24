import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, supportsNode } from "./cli.ts";
import { WEBHOOK_ERROR, WEBHOOK_INPUT_ERROR } from "./webhooks.ts";
import { TOOL_NAMES } from "./selection.ts";
import { buildServer, type ServerDeps } from "./server.ts";
import { createGitHubClient } from "./github.ts";

const cliEntry = fileURLToPath(new URL("./cli.ts", import.meta.url));
const nodeOk = supportsNode(process.versions.node);
const testDirs: string[] = [];
function testDir(prefix: string): string {
  const dir = mkdtempSync(join(process.cwd(), prefix));
  testDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(testDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fragmentsOf(value: string, minLength = 4): string[] {
  const out = new Set<string>();
  for (let len = minLength; len <= value.length; len += 1) {
    for (let index = 0; index <= value.length - len; index += 1) {
      out.add(value.slice(index, index + len));
    }
  }
  return [...out];
}

function assertNotifySecretsHidden(output: string, urlSecret: string, authSecret: string, patSecret: string): void {
  expect(output).not.toContain(patSecret);
  expect(output).not.toContain(urlSecret);
  expect(output).not.toContain(authSecret);
  const url = new URL(urlSecret);
  expect(output).not.toContain(url.host);
  expect(output).not.toContain(url.pathname);
  const bearerTail = authSecret.slice("Bearer ".length);
  expect(output).not.toContain(bearerTail);
  for (const marker of [
    "notify-host-LEAK7",
    "path-segment-XY99",
    "key-part-SECRET88",
    "SECRET88_abcd",
    "LEAK99_not_for_output",
  ]) {
    expect(output).not.toContain(marker);
  }
  for (const secret of [urlSecret, authSecret, patSecret]) {
    for (const fragment of fragmentsOf(secret, 10)) {
      expect(output).not.toContain(fragment);
    }
  }
}

async function listedToolNames(deps: ServerDeps): Promise<string[]> {
  const mcp = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await client.listTools();
  await client.close();
  await mcp.close();
  return result.tools.map((tool) => tool.name).sort();
}

function minimalDeps(statePath: string): ServerDeps {
  return {
    statePath,
    clientForToken: () => createGitHubClient({ token: "test-token" }),
    readToken: () => "test-token",
    readModels: async () => {
      throw new Error("models");
    },
    launchWatcher: () => {},
  };
}

describe("auth status CLI", () => {
  it.skipIf(!nodeOk)("prints auth status diagnostics only on the CLI without leaking notify values", async () => {
    const home = await mkdtemp(join(process.cwd(), ".copilot-cas-"));
    testDirs.push(home);
    const statePath = join(home, "state.json");
    await mkdir(home, { recursive: true });

    const patSecret = "ghp_pat_LEAK99_not_for_output";
    const urlSecret = "https://notify-host-LEAK7.example/webhook/path-segment-XY99";
    const authSecret = "Bearer key-part-SECRET88_abcd";

    const run = spawnSync(process.execPath, [cliEntry, "auth", "status"], {
      env: {
        ...process.env,
        NO_COLOR: "1",
        GITHUB_PERSONAL_ACCESS_TOKEN: patSecret,
        COPILOT_AGENTS_NOTIFY_URL: urlSecret,
        COPILOT_AGENTS_NOTIFY_AUTHORIZATION: authSecret,
        COPILOT_AGENTS_STATE_PATH: statePath,
      },
      encoding: "utf8",
    });

    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(run.status).toBe(0);
    expect(output).toContain("Local diagnostics:");
    expect(output).toContain("COPILOT_AGENTS_NOTIFY_URL: yes");
    expect(output).toContain("PAT");
    assertNotifySecretsHidden(output, urlSecret, authSecret, patSecret);
  });
});

describe("webhook CLI secrets", () => {
  it("rejects malformed webhook argv without reflecting any argument, including version flags", () => {
    for (const args of [
      ["register", "--url", "URL_SECRET"],
      ["register", "--owner", "bad AUTH_SECRET"],
      ["register", "--owner", "owner", "--auth", "AUTH_SECRET"],
      ["register", "--owner", "owner", "--url-file", "URL_SECRET", "--url-file", "again"],
      ["register", "--owner", "owner", "--version"],
      ["list", "--version", "URL_SECRET"],
      ["remove", "--owner", "owner", "URL_SECRET"],
      ["AUTH_SECRET"],
      ["register", "--owner"],
    ]) {
      expect(() => parseArgs(["webhook", ...args])).toThrow(new Error(WEBHOOK_ERROR));
    }
  });

  it.skipIf(!nodeOk)("registers, lists, diagnoses, removes, and fails without exposing URL path/query or authorization", async () => {
    const dir = testDir(".webhook-cli-");
    const url = "https://8.8.8.8/URL_PATH_SECRET?key=URL_QUERY_SECRET";
    const auth = "AUTH_MARKER_SECRET";
    const urlFile = join(dir, "url");
    const authFile = join(dir, "auth");
    await writeFile(urlFile, `${url}\n`);
    await writeFile(authFile, `${auth}\n`);
    const env = {
      ...process.env,
      NO_COLOR: "1",
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_PAT_MARKER_SECRET",
      COPILOT_AGENTS_STATE_PATH: join(dir, "state.json"),
      COPILOT_AGENTS_NOTIFY_URL: url,
      COPILOT_AGENTS_NOTIFY_AUTHORIZATION: auth,
    };
    const run = (args: string[], expectedStatus = 0) => {
      const child = spawnSync(process.execPath, [cliEntry, ...args], { env, input: `${url}\n${auth}\n`, encoding: "utf8" });
      const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
      expect(child.status).toBe(expectedStatus);
      for (const marker of [url, auth, "URL_PATH_SECRET", "URL_QUERY_SECRET", "AUTH_MARKER_SECRET", "PAT_MARKER_SECRET"]) {
        expect(output).not.toContain(marker);
      }
      const parsedUrl = new URL(url);
      for (const secret of [parsedUrl.pathname, parsedUrl.search, auth]) {
        for (const fragment of fragmentsOf(secret, 10)) expect(output).not.toContain(fragment);
      }
      return output;
    };
    expect(run(["webhook", "register", "--owner", "owner", "--url-file", urlFile, "--auth-file", authFile])).toContain("Webhook registered.");
    const listing = run(["webhook", "list"]);
    expect(listing).toContain("owner\t8.8.8.8\t");
    expect(listing).toContain(`\t${join(dir, createHash("sha256").update("owner").digest("hex"))}\t`);
    expect(run(["auth", "status"])).toContain("key present: yes — mode0600: yes");
    expect(run(["webhook", "register", "--owner", "owner"], 1)).toContain(WEBHOOK_INPUT_ERROR);
    expect(run(["webhook", "register", "--owner", "owner", "--url-file", urlFile], 1)).toContain(WEBHOOK_INPUT_ERROR);
    expect(run(["webhook", "register", "--owner", "owner", "--url-file", join(dir, "missing"), "--auth-file", authFile], 1)).toContain(WEBHOOK_ERROR);
    await writeFile(authFile, `${auth}\r\nInjected: AUTH_MARKER_SECRET`);
    expect(run(["webhook", "register", "--owner", "owner", "--url-file", urlFile, "--auth-file", authFile], 1)).toContain(WEBHOOK_ERROR);
    await writeFile(authFile, auth);
    await writeFile(urlFile, "https://127.0.0.1/URL_PATH_SECRET?key=URL_QUERY_SECRET");
    expect(run(["webhook", "register", "--owner", "owner", "--url-file", urlFile, "--auth-file", authFile], 1)).toContain(WEBHOOK_ERROR);
    for (const args of [
      ["webhook", "register", "--owner", "owner", "--url", url, "--auth", auth],
      ["webhook", "register", "--owner", auth, "--version"],
      ["webhook", "list", "--version", url],
      ["webhook", auth],
    ]) expect(run(args, 1)).toContain(WEBHOOK_ERROR);
    expect(run([url, auth], 1)).toContain("Unknown argument.");
    expect(run([auth, url], 1)).toContain("Unknown argument.");
    expect(run(["webhook", "--help"])).toContain("webhook register");
    expect(run(["webhook", "register", "--help"])).toContain("webhook register");
    expect(run(["webhook", "remove", "--owner", "owner"])).toContain("Webhook removed.");
    expect(run(["webhook", "remove", "--owner", "owner"])).toContain("Webhook removed.");
    expect(run(["webhook", "list"])).toBe("");
  });
});
describe("MCP surface unchanged", () => {
  it("still exposes exactly six tools on tools/list", async () => {
    const dir = testDir(".auth-status-mcp-");
    const statePath = join(dir, "state.json");
    const names = await listedToolNames(minimalDeps(statePath));
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(6);
  });

  it("does not embed auth status diagnostics in server instructions", async () => {
    const dir = testDir(".auth-status-mcp-");
    const statePath = join(dir, "state.json");
    const mcp = buildServer(minimalDeps(statePath));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).not.toContain("Local diagnostics");
    expect(instructions).not.toContain("auth-status-probe");
    expect(instructions).not.toContain("webhook: not configured");
    await client.close();
    await mcp.close();
  });
});