import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { supportsNode } from "./cli.ts";
import { TOOL_NAMES } from "./selection.ts";
import { buildServer, type ServerDeps } from "./server.ts";
import { createGitHubClient } from "./github.ts";

const cliEntry = fileURLToPath(new URL("./cli.ts", import.meta.url));
const nodeOk = supportsNode(process.versions.node);

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
  for (const secret of [urlSecret, authSecret]) {
    for (const fragment of fragmentsOf(secret)) {
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
    const home = await mkdtemp(join(tmpdir(), "copilot-cas-"));
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

describe("MCP surface unchanged", () => {
  it("still exposes exactly six tools on tools/list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-status-mcp-"));
    const statePath = join(dir, "state.json");
    const names = await listedToolNames(minimalDeps(statePath));
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(6);
  });

  it("does not embed auth status diagnostics in server instructions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-status-mcp-"));
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