import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { CodedToolFailure, ModelsError, TASK_HAS_NO_PULL_REQUEST, TASK_PULL_REQUEST_NOT_OPEN } from "./errors.ts";
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

describe("tools", () => {
  it("publishes server instructions on initialize", async () => {
    const statePath = await tempPath();
    const mcp = buildServer(baseSelection, deps(statePath, unusedClient(), () => {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const instructions = client.getInstructions();
    expect(instructions).toContain("Tools never wait");
    expect(instructions).toContain("list_agent_tasks");
    await client.close();
    await mcp.close();
  });

  it("surfaces GitHub timeouts from create_agent_task", async () => {
    const statePath = await tempPath();
    const client = createGitHubClient({
      token: "test-token",
      fetchTimeoutMs: 50,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
    });
    const result = await callTool(statePath, client, "create_agent_task", {
      repo: "octocat/hello-world",
      prompt: "hola",
      model: "mai-code-2",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timed out after 50 milliseconds");
  });

  it("returns follow_up and responds immediately on create", async () => {
    const statePath = await tempPath();
    const binDir = await mkdtemp(join(tmpdir(), "copilot-notify-bin-"));
    dirs.push(binDir);
    const notifySend = join(binDir, "notify-send");
    await writeFile(notifySend, "#!/bin/sh\n");
    const previousUrl = process.env.COPILOT_AGENTS_NOTIFY_URL;
    const previousPath = process.env.PATH;
    process.env.COPILOT_AGENTS_NOTIFY_URL = "http://127.0.0.1:9/hook";
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    const started = performance.now();
    try {
      const slow: GitHubClient = {
        async createTask() {
          return { id: "task-1", state: "queued" };
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
      const result = await callTool(statePath, slow, "create_agent_task", {
        repo: "octocat/hello-world",
        prompt: "hola",
        model: "freeform-model",
      });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(textOf(result)) as {
        follow_up: { mode: string; channels?: string[]; check_with: string };
        next_step: string;
        status: string;
        delivery: string;
      };
      expect(body.follow_up.mode).toBe("push");
      expect(body.follow_up.channels).toContain("webhook");
      expect(body.follow_up.check_with).toBe("list_agent_tasks");
      expect(body.status).toBe("working");
      expect(body.delivery).toBe("pending");
      expect(body.follow_up).not.toHaveProperty("session_url");
      expect(body.next_step).toContain("Task queued");
      expect(body.next_step).toContain("POSTed");
    } finally {
      if (previousUrl === undefined) delete process.env.COPILOT_AGENTS_NOTIFY_URL;
      else process.env.COPILOT_AGENTS_NOTIFY_URL = previousUrl;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("advertises the package.json version", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const statePath = await tempPath();
    const mcp = buildServer(baseSelection, deps(statePath, unusedClient(), () => {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    expect(client.getServerVersion()).toMatchObject({ name: "copilot-agents-mcp", version: pkg.version });
    await client.close();
    await mcp.close();
  });

  it("sets readOnlyHint by method and publishes the schema", async () => {
    const statePath = await tempPath();
    const tools = await listedTools(baseSelection, deps(statePath, unusedClient(), () => {}));
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    for (const tool of tools) {
      const meta = TOOLS.find((item) => item.name === tool.name);
      const readOnly = meta?.method === "GET";
      const destructive = tool.name === "abort_agent_task";
      const idempotent = readOnly || tool.name === "abort_agent_task";
      if (tool.name === "create_agent_task") {
        expect(tool.annotations?.idempotentHint).toBe(false);
      } else if (tool.name === "steer_agent_task") {
        expect(tool.annotations?.idempotentHint).toBe(false);
        expect(tool.annotations?.destructiveHint).toBe(false);
      } else {
        expect(tool.annotations?.idempotentHint).toBe(idempotent);
        expect(tool.annotations?.destructiveHint).toBe(destructive);
      }
      expect(tool.annotations?.readOnlyHint).toBe(readOnly);
      expect(tool.annotations?.openWorldHint).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(TOOLS).toEqual([
      { name: "create_agent_task", toolset: "copilot_tasks", method: "POST" },
      { name: "get_agent_task", toolset: "copilot_tasks", method: "GET" },
      { name: "list_agent_tasks", toolset: "copilot_tasks", method: "GET" },
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

  it("explains how to sign in without a credential and does not call the API", async () => {
    const statePath = await tempPath();
    const result = await callTool(statePath, unusedClient(), "get_agent_task", { task_id: "task-1" }, () => {}, undefined, () => null);
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result)) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_authenticated");
    expect(body.error.message).toContain("npx copilot-agents-mcp login");
    expect(body.error.message).toContain("keyring");
  });

  it("blocks an already rejected model without calling the API", async () => {
    const statePath = await tempPath();
    await withStateLock(statePath, (state) => {
      state.models.accepted = ["mai-code-2", "grok-4.7"];
      state.models.rejected = ["missing-model-123"];
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
      model: "missing-model-123",
    });
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    const err = JSON.parse(textOf(result)) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("model_unavailable");
    expect(err.error.message).toContain("Accepted models observed: grok-4.7, mai-code-2");
  });

  it("launches any model, stores it, and starts the watcher", async () => {
    const statePath = await tempPath();
    const binDir = await mkdtemp(join(tmpdir(), "copilot-notify-bin-"));
    dirs.push(binDir);
  const notifySend = join(binDir, "notify-send");
    await writeFile(notifySend, "#!/bin/sh\n");
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
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
      model: "freeform-model",
      base_ref: "main",
    }, () => {
      launched += 1;
    });
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({ model: "freeform-model", owner: "octocat", repo: "hello-world", base_ref: "main" });
    expect(launched).toBe(1);
    expect((await readState(statePath)).tasks["task-1"]?.requested_model).toBe("freeform-model");
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  it("shows a delayed model rejection when reading status", async () => {
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
    }, "get_agent_task", { task_id: "task-1", verbose: true });
    expect(textOf(result)).toContain("The model \\\"claude-sonnet-4.6\\\" is not available");
    expect(textOf(result)).toContain("mai-code-2");
  });

  it("adds number and html_url and continues when the pull request API fails", async () => {
    const statePath = await tempPath();
    const example = structuredClone(JSON.parse(readFileSync(new URL("../fixtures/openapi/get-task.response.json", import.meta.url), "utf8")).example) as AgentTask;
    const session = example.sessions?.[0];
    if (!session) throw new Error("the example has no session");
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
    const broken = await callTool(statePath, failing, "get_agent_task", { task_id: example.id, verbose: true });
    expect(broken.isError).toBeUndefined();
    expect(JSON.parse(textOf(broken)).pull_request).toEqual({ id: 42 });
    expect(JSON.parse(textOf(broken)).pr_url).toBeUndefined();
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
    const ok = await callTool(statePath, client, "get_agent_task", { task_id: example.id, verbose: true });
    expect(ok.isError).toBeUndefined();
    const body = JSON.parse(textOf(ok)) as { pr_url?: string; usage: unknown; branch: unknown; resolved_model: string };
    expect(body.pr_url).toBe("https://github.com/octocat/hello-world/pull/7");
    expect(body.usage).toEqual({ type: "ai_credits", amount: 344_355_000, amount_human: 0.344355 });
    expect(body.resolved_model).toBe("claude-sonnet-4.6");
    expect(urls.some((url) => url.includes("head=octocat%3Acopilot%2Ffix-1"))).toBe(true);
  });

  it("does not look up the pull request when the task already has number and html_url", async () => {
    const statePath = await tempPath();
    const example = structuredClone(JSON.parse(readFileSync(new URL("../fixtures/openapi/get-task.response.json", import.meta.url), "utf8")).example) as AgentTask;
    const pull = example.artifacts?.find((artifact) => artifact.type === "pull");
    if (!pull?.data) throw new Error("the example has no pull artifact");
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
    const result = await callTool(statePath, client, "get_agent_task", { task_id: example.id, verbose: true });
    expect(result.isError).toBeUndefined();
    expect(pulls).toBe(0);
    expect(JSON.parse(textOf(result)).pr_url).toBe("https://github.com/octocat/hello-world/pull/7");
  });

  it("returns read models and an error for an invalid format", async () => {
    const statePath = await tempPath();
    const payload: SweModelsResult = {
      source: { url: "https://copilot.example.test/agents/swe/models", fetched_at: "2099-01-01T00:00:00.000Z" },
      models: [{
        id: "test-model-a",
        name: "Test model A",
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
      throw new ModelsError("GET https://copilot.example.test/agents/swe/models returned HTTP 200 with an invalid format: missing data[0].billing.token_prices");
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("missing data[0].billing.token_prices");
    expect(textOf(bad)).not.toContain("test-model-a");
  });

  it("does not publish write tools in read-only mode", () => {
    expect(selectToolNames({ ...baseSelection, readOnly: true })).toEqual(["get_agent_task", "list_agent_tasks", "get_agent_task_events", "list_copilot_models"]);
    expect(selectToolNames({ exclude: [], readOnly: false, features: [], toolsets: ["copilot_models"] })).toEqual(["list_copilot_models"]);
    expect(selectToolNames({ exclude: ["get_agent_task"], readOnly: false, features: [] })).toEqual([
      "create_agent_task",
      "list_agent_tasks",
      "steer_agent_task",
      "abort_agent_task",
      "get_agent_task_events",
      "list_copilot_models",
    ]);
  });
});

describe("experimental task steering", () => {
  it("does not call steer when the task has no pull request", async () => {
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
    }), "steer_agent_task", { task_id: "task-1", content: "continue with the tests" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(TASK_HAS_NO_PULL_REQUEST);
    expect(textOf(result)).not.toContain("pull_request_closed");
    expect(steers).toBe(0);
    expect(pulls).toBe(0);
  });

  it("does not call steer when the pull request is not open", async () => {
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
    }), "steer_agent_task", { task_id: "task-1", content: "continue with the tests" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(TASK_PULL_REQUEST_NOT_OPEN);
    expect(textOf(result)).not.toContain("pull_request_closed");
    expect(steers).toBe(0);
    expect(pulls).toBe(1);
  });

  it("resolves the number, stores the steer, and starts the watcher", async () => {
    const statePath = await tempPath();
    let steers = 0;
    let launched = 0;
    let lookups = 0;
    let content = "";
    const previousUrl = process.env.COPILOT_AGENTS_NOTIFY_URL;
    process.env.COPILOT_AGENTS_NOTIFY_URL = "http://127.0.0.1:9/hook";
    let result;
    try {
      result = await callTool(statePath, steerClient({
        task: taskWithPull(null),
        pull: { number: 7, state: "open" },
        onLookup() {
          lookups += 1;
        },
        onSteer(value) {
          steers += 1;
          content = value;
        },
      }), "steer_agent_task", { task_id: "task-1", content: "continue with the tests" }, () => {
        launched += 1;
      });
    } finally {
      if (previousUrl === undefined) delete process.env.COPILOT_AGENTS_NOTIFY_URL;
      else process.env.COPILOT_AGENTS_NOTIFY_URL = previousUrl;
    }
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ task_id: "task-1", accepted: true, session_count: 1 });
    expect(steers).toBe(1);
    expect(lookups).toBe(1);
    expect(content).toBe("continue with the tests");
    expect(launched).toBe(1);
    const saved = (await readState(statePath)).tasks["task-1"];
    expect(saved?.steer).toMatchObject({ session_count: 1, turn_seen: false, notified: false });
    expect(saved?.steer?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(saved?.repo).toBe("octocat/hello-world");
  });

  it("persists the accepted steer and keeps it when the watcher notifies", async () => {
    const statePath = await tempPath();
    const steered = await callTool(statePath, steerClient({
      task: taskWithPull(7),
      pull: { number: 7, state: "open" },
    }), "steer_agent_task", { task_id: "task-1", content: "continue with the tests" });
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
      channels: ["system"],
      deliver: async (notice) => {
        notices.push(notice.session_id ?? "");
        return { channels: ["system"] as const };
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
      channels: ["system"],
      deliver: async (notice) => {
        notices.push(notice.session_id ?? "");
        return { channels: ["system"] as const };
      },
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual(["session-reciente"]);
    expect((await readState(statePath)).tasks["task-1"]?.steer).toEqual(after);
    expect(reads).toBe(1);
  });

  it("returns the latest session", async () => {
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
    }, "get_agent_task", { task_id: "task-1", repo: "acme/demo", verbose: true });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result)).session_id).toBe("session-reciente");
    expect((await readState(statePath)).tasks["task-1"]?.session_id).toBe("session-reciente");
  });

  it("creates the default state directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "copilot-home-"));
    dirs.push(home);
    const statePath = defaultStatePath({}, home);
    expect(statePath).toBe(join(home, ".copilot-agents-mcp", "state.json"));
    await withStateLock(statePath, (state) => {
      state.tasks["task-1"] = initialTask({
        id: "task-1",
        repo: "acme/demo",
        requestedModel: "synthetic-model",
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
        state.models.accepted.push("synthetic-model");
      });
    } finally {
      await releaseWatcher(lock);
    }
    expect((await readState(watcherState)).models.accepted).toEqual(["synthetic-model"]);
  });

  it("aborts the task and reads an events page", async () => {
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

describe("MCP tool errors", () => {
  const noAuthCases: Array<[string, Record<string, unknown>]> = [
    ["create_agent_task", { repo: "octocat/hello-world", prompt: "hi", model: "mai-code-2" }],
    ["abort_agent_task", { task_id: "task-1" }],
    ["steer_agent_task", { task_id: "task-1", content: "go" }],
    ["get_agent_task_events", { task_id: "task-1", page: 1, per_page: 1 }],
    ["list_copilot_models", {}],
  ];
  for (const [name, args] of noAuthCases) {
    it(`${name} returns coded error without structured output`, async () => {
      const statePath = await tempPath();
      const readModels = name === "list_copilot_models"
        ? async () => {
          throw new CodedToolFailure("not_authenticated", "No GitHub session is available.");
        }
        : undefined;
      const result = await callTool(statePath, unusedClient(), name, args, () => {}, readModels, () => null);
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("structuredContent");
      const body = JSON.parse(textOf(result)) as { error: { code: string } };
      expect(body.error.code).toBe("not_authenticated");
    });
  }

  it("list_agent_tasks returns terminal-only rows when unauthenticated", async () => {
    const statePath = await tempPath();
    await withStateLock(statePath, (state) => {
      state.tasks.done = initialTask({
        id: "done",
        repo: "octocat/hello-world",
        requestedModel: "m",
        state: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    const result = await callTool(statePath, unusedClient(), "list_agent_tasks", {}, () => {}, undefined, () => null);
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result)) as { stale: boolean; warnings: string[]; all_terminal: boolean };
    expect(body.stale).toBe(true);
    expect(body.warnings.some((line) => /session is available|stored data/i.test(line))).toBe(true);
    expect(body.all_terminal).toBe(true);
  });

  it("get_agent_task returns terminal cache when unauthenticated", async () => {
    const statePath = await tempPath();
    await withStateLock(statePath, (state) => {
      state.tasks["task-1"] = initialTask({
        id: "task-1",
        repo: "octocat/hello-world",
        requestedModel: "m",
        state: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    const result = await callTool(statePath, unusedClient(), "get_agent_task", { task_id: "task-1" }, () => {}, undefined, () => null);
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result)) as { terminal: boolean; stale: boolean; warnings: string[] };
    expect(body.terminal).toBe(true);
    expect(body.stale).toBe(true);
    expect(body.warnings.length).toBeGreaterThan(0);
  });
});

describe("PR #18 review regressions", () => {
  it("list_agent_tasks counts pending tasks beyond the page limit", async () => {
    const statePath = await tempPath();
    const newest = new Date().toISOString();
    const middle = new Date(Date.now() - 60_000).toISOString();
    const oldestPending = new Date(Date.now() - 3_600_000).toISOString();
    await withStateLock(statePath, (state) => {
      state.tasks["idle-new"] = {
        ...initialTask({
          id: "idle-new",
          repo: "octocat/hello-world",
          requestedModel: "m",
          state: "idle",
          createdAt: middle,
          updatedAt: newest,
        }),
        completed_at: newest,
      };
      state.tasks["idle-mid"] = {
        ...initialTask({
          id: "idle-mid",
          repo: "octocat/hello-world",
          requestedModel: "m",
          state: "idle",
          createdAt: middle,
          updatedAt: middle,
        }),
        completed_at: middle,
      };
      state.tasks.run = initialTask({
        id: "run",
        repo: "octocat/hello-world",
        requestedModel: "m",
        state: "in_progress",
        createdAt: oldestPending,
        updatedAt: oldestPending,
      });
    });
    const github: GitHubClient = {
      ...unusedClient(),
      async getTask() {
        return { id: "run", state: "in_progress", updated_at: oldestPending };
      },
    };
    const result = await callTool(statePath, github, "list_agent_tasks", { limit: 1 });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result)) as {
      all_terminal: boolean;
      pending_count: number;
      tasks: Array<{ task_id: string }>;
      next_check_after?: string;
    };
    expect(body.all_terminal).toBe(false);
    expect(body.pending_count).toBe(1);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]?.task_id).toBe("idle-new");
    expect(body.next_check_after).toBeDefined();
  });

  it("get_agent_task refetches after steering a terminal task", async () => {
    const statePath = await tempPath();
    const cachedAt = new Date().toISOString();
    await withStateLock(statePath, (state) => {
      state.tasks["task-1"] = {
        ...initialTask({
          id: "task-1",
          repo: "octocat/hello-world",
          requestedModel: "m",
          state: "idle",
          createdAt: "2026-11-22T00:00:00Z",
          updatedAt: "2026-11-22T01:00:00Z",
          htmlUrl: "https://github.com/octocat/hello-world/copilot/tasks/task-1",
        }),
        pull_request: { id: 42, number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" },
        completed_at: "2026-11-22T01:00:00Z",
        last_fetched_at: cachedAt,
      };
    });
    let gets = 0;
    const base = steerClient({
      task: taskWithPull(7),
      pull: { number: 7, state: "open" },
    });
    const client: GitHubClient = {
      ...base,
      async getTask() {
        gets += 1;
        return {
          ...taskWithPull(7),
          state: gets <= 1 ? "idle" : "in_progress",
          updated_at: new Date().toISOString(),
        };
      },
    };
    const steered = await callTool(statePath, client, "steer_agent_task", { task_id: "task-1", content: "continue" });
    expect(steered.isError).toBeUndefined();
    const got = await callTool(statePath, client, "get_agent_task", { task_id: "task-1", repo: "octocat/hello-world" });
    expect(got.isError).toBeUndefined();
    const body = JSON.parse(textOf(got)) as { terminal: boolean; status: string };
    expect(body.terminal).toBe(false);
    expect(body.status).toBe("working");
    expect(gets).toBeGreaterThanOrEqual(2);
  });

  it("abort_agent_task on a finished task validates against the output schema", async () => {
    const statePath = await tempPath();
    await withStateLock(statePath, (state) => {
      state.tasks["task-1"] = initialTask({
        id: "task-1",
        repo: "octocat/hello-world",
        requestedModel: "m",
        state: "idle",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      });
    });
    let aborted = 0;
    const result = await callTool(statePath, {
      ...unusedClient(),
      async abortTask() {
        aborted += 1;
      },
    }, "abort_agent_task", { task_id: "task-1" });
    expect(result.isError).toBeUndefined();
    expect(aborted).toBe(0);
    expect(JSON.parse(textOf(result))).toEqual({
      task_id: "task-1",
      accepted: false,
      reason: "already finished",
      status: "completed",
      terminal: true,
    });
  });

  it("abort_agent_task clears the freshness cache on success", async () => {
    const statePath = await tempPath();
    const fetchedAt = new Date().toISOString();
    await withStateLock(statePath, (state) => {
      state.tasks["task-1"] = {
        ...initialTask({
          id: "task-1",
          repo: "octocat/hello-world",
          requestedModel: "m",
          state: "in_progress",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
        last_fetched_at: fetchedAt,
      };
    });
    const result = await callTool(statePath, { ...unusedClient(), async abortTask() {} }, "abort_agent_task", { task_id: "task-1" });
    expect(result.isError).toBeUndefined();
    expect((await readState(statePath)).tasks["task-1"]?.last_fetched_at).toBeNull();
  });

  it("steer_agent_task does not spawn a watcher without notification channels", async () => {
    const statePath = await tempPath();
    let launched = 0;
    await withNotifyIsolation({ channels: false }, async () => {
      const result = await callTool(statePath, steerClient({
        task: taskWithPull(7),
        pull: { number: 7, state: "open" },
      }), "steer_agent_task", { task_id: "task-1", content: "go" }, () => {
        launched += 1;
      });
      expect(result.isError).toBeUndefined();
    });
    expect(launched).toBe(0);
  });

  it("steer_agent_task spawns the watcher when a channel is configured", async () => {
    const statePath = await tempPath();
    let launched = 0;
    await withNotifyIsolation({ channels: true }, async () => {
      const result = await callTool(statePath, steerClient({
        task: taskWithPull(7),
        pull: { number: 7, state: "open" },
      }), "steer_agent_task", { task_id: "task-1", content: "go" }, () => {
        launched += 1;
      });
      expect(result.isError).toBeUndefined();
    });
    expect(launched).toBe(1);
  });

  it("create_agent_task does not spawn a watcher without notification channels", async () => {
    const statePath = await tempPath();
    let launched = 0;
    await withNotifyIsolation({ channels: false }, async () => {
      const result = await callTool(statePath, {
        ...unusedClient(),
        async createTask() {
          return { id: "task-1", state: "queued" };
        },
      }, "create_agent_task", {
        repo: "octocat/hello-world",
        prompt: "hola",
        model: "mai-code-2",
      }, () => {
        launched += 1;
      });
      expect(result.isError).toBeUndefined();
    });
    expect(launched).toBe(0);
  });

  it("rejects list_agent_tasks limit above 50", async () => {
    const statePath = await tempPath();
    const result = await callTool(statePath, unusedClient(), "list_agent_tasks", { limit: 51 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/50|limit|maximum/i);
  });
});

describe("local HTTP", () => {
  it("listens on 127.0.0.1 and applies X-MCP-* headers", async () => {
    const statePath = await tempPath();
    const http = await startHttpServer({
      port: 0,
      selection: baseSelection,
      deps: deps(statePath, unusedClient(), () => {}),
    });
    expect(http.host).toBe("127.0.0.1");
    try {
      const readonly = await listOverHttp(http.url, { "X-MCP-Readonly": "true" });
      expect(readonly.map((tool) => tool.name)).toEqual(["get_agent_task", "list_agent_tasks", "get_agent_task_events", "list_copilot_models"]);
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
      expect(await denied.text()).toContain("Unknown toolset");
    } finally {
      await http.close();
    }
  });
});

function renderTools(tools: Array<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean } }>): string {
  const lines = ["| Tool | Toolset | Read-only | Description |", "| --- | --- | --- | --- |"];
  for (const tool of tools) {
    const meta = TOOLS.find((item) => item.name === tool.name);
    const readOnly = tool.annotations?.readOnlyHint ? "yes" : "no";
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
  readToken?: () => string | null,
) {
  const serverDeps = deps(statePath, client, launchWatcher, readToken);
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
      if (!options.pull) throw new Error("no pull");
      return options.pull;
    },
    async steerTask(_taskId, content) {
      options.onSteer?.(content);
    },
  };
}

async function withNotifyIsolation(
  options: { channels: boolean },
  run: () => Promise<void>,
): Promise<void> {
  const savedUrl = process.env.COPILOT_AGENTS_NOTIFY_URL;
  const savedPath = process.env.PATH;
  const emptyBin = await mkdtemp(join(tmpdir(), "copilot-empty-path-"));
  dirs.push(emptyBin);
  if (options.channels) {
    process.env.COPILOT_AGENTS_NOTIFY_URL = "http://127.0.0.1:9/hook";
    if (savedPath) process.env.PATH = `${emptyBin}${delimiter}${savedPath}`;
    else process.env.PATH = emptyBin;
  } else {
    process.env.COPILOT_AGENTS_NOTIFY_URL = "";
    process.env.PATH = emptyBin;
  }
  try {
    await run();
  } finally {
    if (savedUrl === undefined) process.env.COPILOT_AGENTS_NOTIFY_URL = "";
    else process.env.COPILOT_AGENTS_NOTIFY_URL = savedUrl;
    if (savedPath === undefined) process.env.PATH = "";
    else process.env.PATH = savedPath;
  }
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
