import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { PricingError } from "./errors.ts";
import type { AgentTask, GitHubClient } from "./github.ts";
import { startHttpServer } from "./http.ts";
import { selectToolNames, TOOLS, type Selection } from "./selection.ts";
import { buildServer, type ServerDeps } from "./server.ts";
import type { PricingResult } from "./pricing.ts";
import { readState, withStateLock } from "./state.ts";

const dirs: string[] = [];
const UPDATE = process.env.UPDATE_TOOLSNAPS === "true";

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilot-agents-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

const baseSelection: Selection = { exclude: [], readOnly: false, features: [] };

async function listedTools(selection: Selection, deps: ServerDeps) {
  const mcp = buildServer(selection, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await client.listTools();
  await client.close();
  await mcp.close();
  return result.tools;
}

function deps(statePath: string, client: GitHubClient, launchWatcher: () => void, readToken: () => string | null = () => "test-token"): ServerDeps {
  return {
    statePath,
    clientForToken: () => client,
    readToken,
    readPricing: async () => {
      throw new Error("pricing");
    },
    launchWatcher,
  };
}

describe("herramientas", () => {
  it("exige readOnlyHint según el método y publica el esquema", async () => {
    const statePath = await tempPath();
    const tools = await listedTools(baseSelection, deps(statePath, unusedClient(), () => {}));
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    for (const tool of tools) {
      const meta = TOOLS.find((item) => item.name === tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(meta?.method === "GET");
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(meta?.method === "GET");
      expect(tool.annotations?.openWorldHint).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(TOOLS).toEqual([
      { name: "create_agent_task", toolset: "copilot_tasks", method: "POST" },
      { name: "get_agent_task", toolset: "copilot_tasks", method: "GET" },
      { name: "list_copilot_models", toolset: "copilot_models", method: "GET" },
    ]);
    const dir = fileURLToPath(new URL("./__toolsnaps__/", import.meta.url));
    await mkdir(dir, { recursive: true });
    for (const tool of tools) {
      const path = join(dir, `${tool.name}.snap`);
      const text = `${JSON.stringify(tool, null, 2)}\n`;
      if (UPDATE) {
        await writeFile(path, text);
        continue;
      }
      expect(await readFile(path, "utf8")).toBe(text);
    }
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const block = renderTools(tools);
    const match = /<!-- START AUTOMATED TOOLS -->\n([\s\S]*?)\n<!-- END AUTOMATED TOOLS -->/.exec(readme);
    expect(match?.[1]).toBe(block);
  });

  it("corta un modelo ya rechazado y no llama a la API", async () => {
    const statePath = await tempPath();
    await withStateLock(statePath, (state) => {
      state.models.accepted = ["mai-code-2", "grok-4.7"];
      state.models.rejected = ["modelo-inexistente-123"];
    });
    let called = false;
    const result = await callTool(statePath, {
      async createTask() {
        called = true;
        throw new Error("no");
      },
      async getTask() {
        throw new Error("no");
      },
    }, "create_agent_task", {
      repo: "octocat/hello-world",
      prompt: "hola",
      model: "modelo-inexistente-123",
    });
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Modelos vistos aceptados: grok-4.7, mai-code-2");
  });

  it("lanza cualquier modelo, lo guarda y arranca el vigilante", async () => {
    const statePath = await tempPath();
    let launched = 0;
    let body: unknown;
    const result = await callTool(statePath, {
      async createTask(input) {
        body = input;
        return { id: "task-1", state: "queued", created_at: "2026-11-22T00:00:00Z", html_url: "https://github.com/octocat/hello-world/copilot/tasks/task-1" };
      },
      async getTask() {
        throw new Error("no");
      },
    }, "create_agent_task", {
      repo: "octocat/hello-world",
      prompt: "hola",
      model: "modelo-libre",
      base_ref: "main",
    }, () => {
      launched += 1;
    });
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({ model: "modelo-libre", owner: "octocat", repo: "hello-world", base_ref: "main" });
    expect(launched).toBe(1);
    expect((await readState(statePath)).tasks["task-1"]?.requested_model).toBe("modelo-libre");
  });

  it("muestra el rechazo tardío al leer el estado", async () => {
    const statePath = await tempPath();
    await withStateLock(statePath, (state) => {
      state.models.accepted = ["mai-code-2"];
      state.tasks["task-1"] = {
        task_id: "task-1",
        repo: "octocat/hello-world",
        requested_model: "claude-sonnet-4.6",
        state: "queued",
        resolved_model: null,
        pull_request: null,
        branch: null,
        artifacts: [],
        error: null,
        usage: null,
        created_at: "2026-11-22T00:00:00Z",
        updated_at: null,
        completed_at: null,
        notified_at: null,
      };
    });
    const result = await callTool(statePath, {
      async createTask() {
        throw new Error("no");
      },
      async getTask(): Promise<AgentTask> {
        return {
          id: "task-1",
          state: "failed",
          created_at: "2026-11-22T00:00:00Z",
          updated_at: "2026-11-22T00:01:00Z",
          sessions: [{
            state: "failed",
            created_at: "2026-11-22T00:00:01Z",
            error: { message: "The selected model isn't available" },
          }],
        };
      },
    }, "get_agent_task", { task_id: "task-1" });
    expect(textOf(result)).toContain("El modelo «claude-sonnet-4.6» no está disponible");
    expect(textOf(result)).toContain("mai-code-2");
  });

  it("devuelve los precios leídos y un error si el formato cambia", async () => {
    const statePath = await tempPath();
    const payload: PricingResult = {
      page: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
      sources: [{ url: "https://example.test/tabla", fetched_at: "2026-11-22T00:00:00.000Z" }],
      models: [{
        name: "MAI Code 2",
        provider: "Microsoft",
        price: [{
          tier: null,
          threshold: null,
          input_per_1m_tokens: "0.50",
          cached_input_per_1m_tokens: "0.025",
          output_per_1m_tokens: "2.50",
          cache_write_per_1m_tokens: null,
        }],
        offers: [{
          ends_on: "2027-05-17",
          input_per_1m_tokens: "0.50",
          cached_input_per_1m_tokens: "0.025",
          output_per_1m_tokens: "2.50",
          standard_price: {
            starts_on: "2027-05-18",
            input_per_1m_tokens: "1.00",
            cached_input_per_1m_tokens: "0.05",
            output_per_1m_tokens: "5.00",
          },
        }],
      }],
    };
    const ok = await callTool(statePath, unusedClient(), "list_copilot_models", {}, () => {}, async () => payload);
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toContain("2027-05-17");
    const bad = await callTool(statePath, unusedClient(), "list_copilot_models", {}, () => {}, async () => {
      throw new PricingError("La página de precios no tiene el formato esperado: campo desconocido extra.");
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("campo desconocido extra");
  });

  it("en solo lectura no publica la herramienta de escritura", () => {
    expect(selectToolNames({ ...baseSelection, readOnly: true })).toEqual(["get_agent_task", "list_copilot_models"]);
    expect(selectToolNames({ exclude: [], readOnly: false, features: [], toolsets: ["copilot_models"] })).toEqual(["list_copilot_models"]);
    expect(selectToolNames({ exclude: ["get_agent_task"], readOnly: false, features: [] })).toEqual(["create_agent_task", "list_copilot_models"]);
  });
});

describe("HTTP local", () => {
  it("escucha en 127.0.0.1 y aplica las cabeceras X-MCP-*", async () => {
    const statePath = await tempPath();
    const http = await startHttpServer({
      port: 0,
      selection: baseSelection,
      deps: deps(statePath, unusedClient(), () => {}),
    });
    expect(http.host).toBe("127.0.0.1");
    try {
      const readonly = await listOverHttp(http.url, { "X-MCP-Readonly": "true" });
      expect(readonly.map((tool) => tool.name)).toEqual(["get_agent_task", "list_copilot_models"]);
      const models = await listOverHttp(`${http.url}/x/copilot_models`, { "X-MCP-Toolsets": "copilot_models" });
      expect(models.map((tool) => tool.name)).toEqual(["list_copilot_models"]);
      const denied = await fetch(http.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-mcp-toolsets": "nope",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(denied.status).toBe(400);
      expect(await denied.text()).toContain("Toolset desconocido");
    } finally {
      await http.close();
    }
  });
});

function renderTools(tools: Array<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean } }>): string {
  const lines = ["| Herramienta | Toolset | Solo lectura | Descripción |", "| --- | --- | --- | --- |"];
  for (const tool of tools) {
    const meta = TOOLS.find((item) => item.name === tool.name);
    const readOnly = tool.annotations?.readOnlyHint ? "sí" : "no";
    lines.push(`| \`${tool.name}\` | ${meta?.toolset ?? ""} | ${readOnly} | ${tool.description ?? ""} |`);
  }
  return lines.join("\n");
}

async function callTool(
  statePath: string,
  client: GitHubClient,
  name: string,
  args: Record<string, unknown>,
  launchWatcher: () => void = () => {},
  readPricing?: ServerDeps["readPricing"],
) {
  const serverDeps = deps(statePath, client, launchWatcher);
  if (readPricing) serverDeps.readPricing = readPricing;
  const mcp = buildServer(baseSelection, serverDeps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const mcpClient = new Client({ name: "test", version: "0.0.0" });
  await mcpClient.connect(clientTransport);
  const result = await mcpClient.callTool({ name, arguments: args });
  await mcpClient.close();
  await mcp.close();
  return result;
}

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first: unknown = content[0];
  return first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
}

function unusedClient(): GitHubClient {
  return {
    async createTask() {
      throw new Error("no");
    },
    async getTask() {
      throw new Error("no");
    },
  };
}

async function listOverHttp(url: string, headers: Record<string, string>) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  const result = await client.listTools();
  await client.close();
  return result.tools;
}
