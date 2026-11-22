import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { ModelsError, TASK_HAS_NO_PULL_REQUEST, TASK_PULL_REQUEST_NOT_OPEN } from "./errors.ts";
import { createGitHubClient, type AgentTask, type GitHubClient } from "./github.ts";
import { startHttpServer } from "./http.ts";
import { selectToolNames, TOOLS, type Selection } from "./selection.ts";
import { buildServer, type ServerDeps } from "./server.ts";
import type { SweModelsResult } from "./swe-models.ts";
import { defaultStatePath, initialTask, readState, withStateLock } from "./state.ts";
import { acquireWatcher, releaseWatcher, runWatcher, watcherLockPath } from "./watch.ts";

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
    readModels: async () => {
      throw new Error("models");
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
      { name: "steer_agent_task", toolset: "copilot_tasks", method: "POST" },
      { name: "abort_agent_task", toolset: "copilot_tasks", method: "POST" },
      { name: "get_agent_task_events", toolset: "copilot_tasks", method: "GET" },
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
      async findPullRequest() {
        throw new Error("no");
      },
      async getPullRequest() {
        throw new Error("no");
      },
      async steerTask() {
        throw new Error("no");
      },
      async abortTask() {
        throw new Error("no");
      },
      async getTaskEvents() {
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
      async findPullRequest() {
        throw new Error("no");
      },
      async getPullRequest() {
        throw new Error("no");
      },
      async steerTask() {
        throw new Error("no");
      },
      async abortTask() {
        throw new Error("no");
      },
      async getTaskEvents() {
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
      async findPullRequest() {
        throw new Error("no");
      },
      async getPullRequest() {
        throw new Error("no");
      },
      async steerTask() {
        throw new Error("no");
      },
      async abortTask() {
        throw new Error("no");
      },
      async getTaskEvents() {
        throw new Error("no");
      },
    }, "get_agent_task", { task_id: "task-1" });
    expect(textOf(result)).toContain("El modelo «claude-sonnet-4.6» no está disponible");
    expect(textOf(result)).toContain("mai-code-2");
  });

  it("añade number y html_url y sigue si la API de pull requests falla", async () => {
    const statePath = await tempPath();
    const example = structuredClone(JSON.parse(readFileSync(new URL("../fixtures/openapi/get-task.response.json", import.meta.url), "utf8")).example) as AgentTask;
    const session = example.sessions?.[0];
    if (!session) throw new Error("el ejemplo no trae sesión");
    session.usage = { type: "ai_credits", amount: 344_355_000 };
    await withStateLock(statePath, (state) => {
      state.tasks[example.id] = {
        task_id: example.id,
        repo: "octocat/hello-world",
        requested_model: "claude-sonnet-4.6",
        state: "queued",
        resolved_model: null,
        pull_request: null,
        branch: null,
        artifacts: [],
        error: null,
        usage: null,
        created_at: null,
        updated_at: null,
        completed_at: null,
        notified_at: null,
      };
    });
    const failing = createGitHubClient({
      token: "test-token",
      fetch: taskFetch(example, () => new Response(JSON.stringify({ message: "no" }), { status: 502 })),
    });
    const broken = await callTool(statePath, failing, "get_agent_task", { task_id: example.id });
    expect(broken.isError).toBeUndefined();
    expect(JSON.parse(textOf(broken)).pull_request).toEqual({ id: 42, number: null, html_url: null });
    const urls: string[] = [];
    const client = createGitHubClient({
      token: "test-token",
      fetch: taskFetch(example, (url) => {
        urls.push(url);
        return new Response(JSON.stringify([
          { id: 42, number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" },
        ]), { status: 200 });
      }),
    });
    const ok = await callTool(statePath, client, "get_agent_task", { task_id: example.id });
    expect(ok.isError).toBeUndefined();
    const body = JSON.parse(textOf(ok)) as { pull_request: unknown; usage: unknown; branch: unknown; resolved_model: string };
    expect(body.pull_request).toEqual({ id: 42, number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" });
    expect(body.usage).toEqual({ type: "ai_credits", amount: 344_355_000, amount_human: 0.344355 });
    expect(body.resolved_model).toBe("claude-sonnet-4.6");
    expect(urls.some((url) => url.includes("head=octocat%3Acopilot%2Ffix-1"))).toBe(true);
  });

  it("no busca la pull request si la tarea ya trae number y html_url", async () => {
    const statePath = await tempPath();
    const example = structuredClone(JSON.parse(readFileSync(new URL("../fixtures/openapi/get-task.response.json", import.meta.url), "utf8")).example) as AgentTask;
    const pull = example.artifacts?.find((artifact) => artifact.type === "pull");
    if (!pull?.data) throw new Error("el ejemplo no trae pull");
    pull.data.number = 7;
    pull.data.html_url = "https://github.com/octocat/hello-world/pull/7";
    await withStateLock(statePath, (state) => {
      state.tasks[example.id] = {
        task_id: example.id,
        repo: "octocat/hello-world",
        requested_model: "claude-sonnet-4.6",
        state: "queued",
        resolved_model: null,
        pull_request: null,
        branch: null,
        artifacts: [],
        error: null,
        usage: null,
        created_at: null,
        updated_at: null,
        completed_at: null,
        notified_at: null,
      };
    });
    let pulls = 0;
    const client = createGitHubClient({
      token: "test-token",
      fetch: taskFetch(example, () => {
        pulls += 1;
        return new Response("[]", { status: 200 });
      }),
    });
    const result = await callTool(statePath, client, "get_agent_task", { task_id: example.id });
    expect(result.isError).toBeUndefined();
    expect(pulls).toBe(0);
    expect(JSON.parse(textOf(result)).pull_request).toEqual({
      id: 42,
      number: 7,
      html_url: "https://github.com/octocat/hello-world/pull/7",
    });
  });

  it("devuelve los modelos leídos y un error si el formato no cuadra", async () => {
    const statePath = await tempPath();
    const payload: SweModelsResult = {
      source: { url: "https://copilot.example.test/agents/swe/models", fetched_at: "2099-01-01T00:00:00.000Z" },
      models: [{
        id: "test-model-a",
        name: "Modelo de prueba A",
        vendor: "Fabricante Ficticio",
        preview: false,
        policy: { state: "enabled" },
        billing: {
          token_prices: { input_price: 11, output_price: 22, cache_price: 3, batch_size: 1000 },
        },
      }],
    };
    const ok = await callTool(statePath, unusedClient(), "list_copilot_models", {}, () => {}, async () => payload);
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toContain("test-model-a");
    expect(textOf(ok)).toContain("https://copilot.example.test/agents/swe/models");
    const bad = await callTool(statePath, unusedClient(), "list_copilot_models", {}, () => {}, async () => {
      throw new ModelsError("GET https://copilot.example.test/agents/swe/models respondió HTTP 200 y el formato no cuadra: falta data[0].billing.token_prices");
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("falta data[0].billing.token_prices");
    expect(textOf(bad)).not.toContain("test-model-a");
  });

  it("en solo lectura no publica la herramienta de escritura", () => {
    expect(selectToolNames({ ...baseSelection, readOnly: true })).toEqual(["get_agent_task", "get_agent_task_events", "list_copilot_models"]);
    expect(selectToolNames({ exclude: [], readOnly: false, features: [], toolsets: ["copilot_models"] })).toEqual(["list_copilot_models"]);
    expect(selectToolNames({ exclude: ["get_agent_task"], readOnly: false, features: [] })).toEqual([
      "create_agent_task",
      "steer_agent_task",
      "abort_agent_task",
      "get_agent_task_events",
      "list_copilot_models",
    ]);
  });
});

describe("redirección experimental", () => {
  it("no llama a steer si la tarea no tiene pull request", async () => {
    const statePath = await tempPath();
    let steers = 0;
    let pulls = 0;
    const result = await callTool(statePath, steerClient({
      task: { id: "task-1", state: "idle", html_url: "https://github.com/octocat/hello-world/copilot/tasks/task-1" },
      onSteer() {
        steers += 1;
      },
      onPull() {
        pulls += 1;
      },
    }), "steer_agent_task", { task_id: "task-1", content: "sigue con los tests" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(TASK_HAS_NO_PULL_REQUEST);
    expect(textOf(result)).not.toContain("pull_request_closed");
    expect(steers).toBe(0);
    expect(pulls).toBe(0);
  });

  it("no llama a steer si la pull request no está abierta", async () => {
    const statePath = await tempPath();
    let steers = 0;
    let pulls = 0;
    const result = await callTool(statePath, steerClient({
      task: taskWithPull(7),
      pull: { number: 7, state: "closed" },
      onPull() {
        pulls += 1;
      },
      onSteer() {
        steers += 1;
      },
    }), "steer_agent_task", { task_id: "task-1", content: "sigue con los tests" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(TASK_PULL_REQUEST_NOT_OPEN);
    expect(textOf(result)).not.toContain("pull_request_closed");
    expect(steers).toBe(0);
    expect(pulls).toBe(1);
  });

  it("resuelve el número, guarda el steer y arranca el vigilante", async () => {
    const statePath = await tempPath();
    let steers = 0;
    let launched = 0;
    let lookups = 0;
    let content = "";
    const result = await callTool(statePath, steerClient({
      task: taskWithPull(null),
      pull: { number: 7, state: "open" },
      onLookup() {
        lookups += 1;
      },
      onSteer(value) {
        steers += 1;
        content = value;
      },
    }), "steer_agent_task", { task_id: "task-1", content: "sigue con los tests" }, () => {
      launched += 1;
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ task_id: "task-1", accepted: true, session_count: 1 });
    expect(steers).toBe(1);
    expect(lookups).toBe(1);
    expect(content).toBe("sigue con los tests");
    expect(launched).toBe(1);
    const saved = (await readState(statePath)).tasks["task-1"];
    expect(saved?.steer).toMatchObject({ session_count: 1, turn_seen: false, notified: false });
    expect(saved?.steer?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(saved?.repo).toBe("octocat/hello-world");
  });

  it("persiste el steer aceptado y lo conserva cuando el vigilante avisa", async () => {
    const statePath = await tempPath();
    const steered = await callTool(statePath, steerClient({
      task: taskWithPull(7),
      pull: { number: 7, state: "open" },
    }), "steer_agent_task", { task_id: "task-1", content: "sigue con los tests" });
    expect(steered.isError).toBeUndefined();
    const raw = JSON.parse(await readFile(statePath, "utf8")) as { tasks: Record<string, { steer?: { at: string; session_count: number; notified: boolean } }> };
    const before = raw.tasks["task-1"]?.steer;
    expect(before).toMatchObject({ session_count: 1, notified: false });
    expect(before?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const notices: string[] = [];
    let reads = 0;
    await runWatcher({
      client: {
        ...unusedClient(),
        async getTask() {
          reads += 1;
          return {
            id: "task-1",
            state: "idle",
            session_count: 2,
            sessions: [
              { id: "session-antigua", state: "idle", created_at: "2026-11-22T00:00:01Z" },
              { id: "session-reciente", state: "idle", created_at: "2026-11-22T00:40:00Z" },
            ],
          };
        },
      },
      statePath,
      deliver: async (notice) => {
        notices.push(notice.session_id ?? "");
      },
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual(["session-reciente"]);
    const after = (await readState(statePath)).tasks["task-1"]?.steer;
    expect(after).toEqual({
      at: before?.at,
      session_count: 1,
      turn_seen: true,
      notified: true,
    });
    await runWatcher({
      client: unusedClient(),
      statePath,
      deliver: async (notice) => {
        notices.push(notice.session_id ?? "");
      },
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual(["session-reciente"]);
    expect((await readState(statePath)).tasks["task-1"]?.steer).toEqual(after);
    expect(reads).toBe(1);
  });

  it("devuelve la sesión más reciente", async () => {
    const statePath = await tempPath();
    const result = await callTool(statePath, {
      ...unusedClient(),
      async getTask() {
        return {
          id: "task-1",
          state: "idle",
          sessions: [
            { id: "session-reciente", state: "idle", created_at: "2026-11-22T00:40:00Z" },
            { id: "session-antigua", state: "idle", created_at: "2026-11-22T00:00:01Z" },
          ],
        };
      },
    }, "get_agent_task", { task_id: "task-1", repo: "acme/demo" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result)).session_id).toBe("session-reciente");
    expect((await readState(statePath)).tasks["task-1"]?.session_id).toBe("session-reciente");
  });

  it("crea el directorio por defecto del estado", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-home-"));
    dirs.push(home);
    const statePath = defaultStatePath({}, home);
    expect(statePath).toBe(join(home, ".copilot-agents-mcp", "state.json"));
    await withStateLock(statePath, (state) => {
      state.tasks["task-1"] = initialTask({
        id: "task-1",
        repo: "acme/demo",
        requestedModel: "modelo-sintetico",
        state: "queued",
        createdAt: null,
        updatedAt: null,
      });
    });
    expect((await readState(statePath)).tasks["task-1"]?.repo).toBe("acme/demo");
    const watcherHome = await mkdtemp(join(tmpdir(), "copilot-home-"));
    dirs.push(watcherHome);
    const watcherState = defaultStatePath({}, watcherHome);
    const lock = watcherLockPath(watcherState);
    expect(await acquireWatcher(lock)).toBe(true);
    try {
      await withStateLock(watcherState, (state) => {
        state.models.accepted.push("modelo-sintetico");
      });
    } finally {
      await releaseWatcher(lock);
    }
    expect((await readState(watcherState)).models.accepted).toEqual(["modelo-sintetico"]);
  });

  it("aborta la tarea y lee la página de eventos", async () => {
    const statePath = await tempPath();
    const events = JSON.parse(readFileSync(new URL("../fixtures/internal/events.json", import.meta.url), "utf8")) as {
      events: Array<{ type: string; timestamp?: string }>;
      total: number;
    };
    let aborted = 0;
    let seen: { page: number; perPage: number } | undefined;
    const github: GitHubClient = {
      ...unusedClient(),
      async abortTask() {
        aborted += 1;
      },
      async getTaskEvents(_taskId, page, perPage) {
        seen = { page, perPage };
        return events;
      },
    };
    const abortedResult = await callTool(statePath, github, "abort_agent_task", { task_id: "task-1" });
    expect(abortedResult.isError).toBeUndefined();
    expect(JSON.parse(textOf(abortedResult))).toEqual({ task_id: "task-1", accepted: true });
    expect(aborted).toBe(1);
    const listed = await callTool(statePath, github, "get_agent_task_events", { task_id: "task-1", page: 2, per_page: 2 });
    expect(listed.isError).toBeUndefined();
    const body = JSON.parse(textOf(listed)) as { total: number; events: Array<{ type: string; timestamp: string | null }> };
    expect(seen).toEqual({ page: 2, perPage: 2 });
    expect(body.total).toBe(events.total);
    expect(body.events.map((event) => event.type)).toEqual(events.events.map((event) => event.type));
    expect(body.events.some((event) => event.timestamp === "0001-01-01T00:00:00Z")).toBe(true);
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
      expect(readonly.map((tool) => tool.name)).toEqual(["get_agent_task", "get_agent_task_events", "list_copilot_models"]);
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
  readModels?: ServerDeps["readModels"],
) {
  const serverDeps = deps(statePath, client, launchWatcher);
  if (readModels) serverDeps.readModels = readModels;
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

function taskWithPull(number: number | null): AgentTask {
  return {
    id: "task-1",
    state: "idle",
    session_count: 1,
    html_url: "https://github.com/octocat/hello-world/copilot/tasks/task-1",
    sessions: [{ id: "session-1", state: "idle", created_at: "2026-11-22T00:00:01Z", head_ref: "copilot/demo" }],
    artifacts: [{ type: "pull", data: number === null ? { id: 42 } : { id: 42, number } }],
  };
}

function steerClient(options: {
  task: AgentTask;
  pull?: { number: number; state: string };
  onSteer?: (content: string) => void;
  onPull?: () => void;
  onLookup?: () => void;
}): GitHubClient {
  return {
    ...unusedClient(),
    async getTask() {
      return options.task;
    },
    async findPullRequest() {
      options.onLookup?.();
      if (!options.pull) return null;
      return { number: options.pull.number, html_url: "https://github.com/octocat/hello-world/pull/7" };
    },
    async getPullRequest() {
      options.onPull?.();
      if (!options.pull) throw new Error("sin pull");
      return options.pull;
    },
    async steerTask(_taskId, content) {
      options.onSteer?.(content);
    },
  };
}

function unusedClient(): GitHubClient {
  return {
    async createTask() {
      throw new Error("no");
    },
    async getTask() {
      throw new Error("no");
    },
    async findPullRequest() {
      throw new Error("no");
    },
    async getPullRequest() {
      throw new Error("no");
    },
    async steerTask() {
      throw new Error("no");
    },
    async abortTask() {
      throw new Error("no");
    },
    async getTaskEvents() {
      throw new Error("no");
    },
  };
}

function taskFetch(example: AgentTask, pulls: (url: string) => Response): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/pulls?")) return pulls(url);
    return new Response(JSON.stringify(example), { status: 200 });
  }) as typeof fetch;
}

async function listOverHttp(url: string, headers: Record<string, string>) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  const result = await client.listTools();
  await client.close();
  return result.tools;
}
