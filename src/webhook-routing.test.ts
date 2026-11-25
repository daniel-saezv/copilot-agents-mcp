import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "./github.ts";
import { deliverTaskNotice, notificationChannelsForTask } from "./notify.ts";
import { buildServer } from "./server.ts";
import { emptyState, initialTask, readState, withStateLock, type TrackedTask } from "./state.ts";
import { runWatcher } from "./watch.ts";
import { webhookKeyPath } from "./webhooks.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "webhook-routing-"));
  dirs.push(dir);
  const path = join(dir, "state.json");
  const keyFilePath = webhookKeyPath(path, "client");
  await writeFile(keyFilePath, "routing-secret", { mode: 0o600 });
  await withStateLock(path, (state) => {
    state.webhooks = {
      client: { url: "https://public.example/secret", keyFilePath, registeredAt: "2026-11-23T00:00:00Z" },
      other: { url: "https://other.example/secret", keyFilePath, registeredAt: "2026-11-23T00:00:00Z" },
    };
  });
  const task = initialTask({
    id: "task-1", repo: "o/r", requestedModel: "m", state: "idle", owner: "client",
    createdAt: "2026-11-24T00:00:00Z", updatedAt: "2026-11-24T00:01:00Z",
  });
  return { path, task };
}

describe("owner webhook routing", () => {
  it("routes only the task's owner and does not fall back on failed owner delivery", async () => {
    const { path, task } = await fixture();
    const ownerPost = vi.fn().mockResolvedValue(undefined);
    const globalPost = vi.fn<typeof fetch>();
    const env = { COPILOT_AGENTS_NOTIFY_URL: "https://global.example", COPILOT_AGENTS_LOG: join(dirs[0] ?? "", "watch.log") };
    expect(await deliverTaskNotice(task, path, env, globalPost, ownerPost)).toEqual({ channels: ["webhook"] });
    expect(ownerPost).toHaveBeenCalledExactlyOnceWith("https://public.example/secret", expect.objectContaining({ task_id: "task-1" }), "routing-secret", env);
    expect(globalPost).not.toHaveBeenCalled();
    ownerPost.mockRejectedValue(new Error("secret from network"));
    expect(await deliverTaskNotice(task, path, env, globalPost, ownerPost)).toEqual({ channels: [] });
    expect(globalPost).not.toHaveBeenCalled();
  });

  it.each([
    { owner: undefined }, { owner: "unknown" }, { owner: "Client" },
    { created_at: "2026-11-22T00:00:00Z" }, { created_at: "2026-11-23T00:00:00Z" },
    { created_at: null }, { created_at: "invalid" },
  ])("preserves global fallback for ineligible tasks: %j", async (change) => {
    const { path, task } = await fixture();
    const ownerPost = vi.fn();
    const globalPost = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const env = { COPILOT_AGENTS_NOTIFY_URL: "https://global.example", COPILOT_AGENTS_NOTIFY_AUTHORIZATION: "global-secret" };
    expect(await deliverTaskNotice({ ...task, ...change }, path, env, globalPost, ownerPost)).toEqual({ channels: ["webhook"] });
    expect(ownerPost).not.toHaveBeenCalled();
    expect(globalPost).toHaveBeenCalledWith(env.COPILOT_AGENTS_NOTIFY_URL, expect.objectContaining({
      headers: {
        "Content-Type": "application/json",
        Authorization: "global-secret",
        "Idempotency-Key": "task-1:completed",
      },
    }));
    expect(notificationChannelsForTask({ ...task, ...change }, await readState(path), {})).toEqual([]);
  });

  it("keeps unconfigured tasks on the existing check_later path", async () => {
    const { path, task } = await fixture();
    expect(notificationChannelsForTask(task, await readState(path), {})).toEqual(["webhook"]);
    expect(notificationChannelsForTask(task, emptyState(), {})).toEqual([]);
    expect(await deliverTaskNotice({ ...task, owner: undefined }, path, {})).toEqual({ channels: [] });
  });

  it("watches owner tasks without global configuration and records delivery once", async () => {
    vi.stubEnv("COPILOT_AGENTS_NOTIFY_URL", "");
    const { path, task } = await fixture();
    await withStateLock(path, (state) => { state.tasks[task.task_id] = task; });
    const deliver = vi.fn().mockResolvedValue({ channels: ["webhook"] });
    const client = createGitHubClient({ token: "test" });
    await runWatcher({ statePath: path, client, deliver, intervalMs: 1, maxCycles: 1 });
    await runWatcher({ statePath: path, client, deliver, intervalMs: 1, maxCycles: 1 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ owner: "client", task_id: task.task_id });
    expect((await readState(path)).tasks[task.task_id]?.delivery_record).toEqual({ status: "delivered", delivered_via: "webhook" });
  });

  it.each(["client", "unregistered"])("creates %s tasks with the appropriate follow_up and persists before watcher start", async (owner) => {
    vi.stubEnv("COPILOT_AGENTS_NOTIFY_URL", "");
    const { path, task } = await fixture();
    const github = createGitHubClient({ token: "test" });
    github.createTask = async () => ({ id: task.task_id, state: "in_progress", created_at: task.created_at ?? undefined });
    const launchWatcher = vi.fn();
    let atLaunch: Promise<TrackedTask | undefined> | undefined;
    launchWatcher.mockImplementation(() => { atLaunch = readState(path).then((state) => state.tasks[task.task_id]); });
    const server = buildServer({
      statePath: path, readToken: () => "test", clientForToken: () => github,
      readModels: async () => { throw new Error("unused"); }, launchWatcher,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "create_agent_task", arguments: { repo: "o/r", prompt: "tiny edit", model: "m", owner } });
      const body = result.structuredContent as Record<string, unknown> | undefined;
      expect(body).toMatchObject({ owner, follow_up: { mode: owner === "client" ? "push" : "check_later" } });
      const recommendation = "No webhook: using check_later. Recommended: configure one with `webhook register`.";
      if (owner === "unregistered") expect(body?.next_step).toContain(recommendation);
      else expect(body?.next_step).not.toContain(recommendation);
      if (owner === "client") {
        expect(launchWatcher).toHaveBeenCalledOnce();
        expect(await atLaunch).toMatchObject({ task_id: task.task_id, owner });
      } else expect(launchWatcher).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
