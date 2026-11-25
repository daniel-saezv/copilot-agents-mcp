import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.ts";
import { initialTask, readState, withStateLock } from "./state.ts";
import type { GitHubClient } from "./github.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(elicitation = false, existingPath?: string) {
  vi.stubEnv("COPILOT_AGENTS_NOTIFY_URL", "");
  const dir = await mkdtemp(join(tmpdir(), "completion-test-"));
  dirs.push(dir);
  const path = existingPath ?? join(dir, "state.json");
  const github: GitHubClient = {
    createTask: vi.fn().mockResolvedValue({ id: "new-task", state: "queued", created_at: "2026-11-25T00:00:00Z" }),
    getTask: vi.fn().mockResolvedValue({
      id: "owned-task", state: "completed", session_count: 1,
      artifacts: [{ type: "pull", data: { id: 1, number: 1 } }],
    }),
    getPullRequest: vi.fn().mockResolvedValue({ state: "open" }),
    findPullRequest: vi.fn(),
    steerTask: vi.fn().mockResolvedValue(undefined),
    abortTask: vi.fn(),
  };
  const launchWatcher = vi.fn();
  const server = buildServer({
    statePath: path, readToken: () => "github-credential", clientForToken: () => github,
    readModels: async () => { throw new Error("unused"); }, launchWatcher,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "completion-test", version: "1" }, elicitation ? { capabilities: { elicitation: { form: {} } } } : {});
  const elicit = vi.fn().mockResolvedValue({ action: "decline" });
  if (elicitation) client.setRequestHandler(ElicitRequestSchema, elicit);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
    const body = (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!result.isError) expect(result.structuredContent).toEqual(body);
    return { result, body, text };
  };
  const close = async () => { await client.close(); await server.close(); };
  return { path, github, launchWatcher, call, close, elicit };
}

const createArgs = { repo: "o/r", prompt: "tiny edit", model: "m" };
const token = "private-owner-capability";
async function owner(path: string, label = "client", ownerToken = token) {
  await withStateLock(path, (state) => {
    state.webhooks ??= {};
    state.webhooks[label] = {
      url: "https://public.example/hidden-query?secret=value",
      keyFilePath: join(path, "hidden-auth"), registeredAt: "2026-11-24T00:00:00Z",
      ownerTokenHash: createHash("sha256").update(ownerToken).digest("hex"),
    };
    state.tasks["owned-task"] = initialTask({
      id: "owned-task", repo: "o/r", requestedModel: "m", state: "completed", owner: "client",
      createdAt: "2026-11-25T00:00:00Z", updatedAt: null,
    });
  });
}

describe("completion setup and owner capabilities", () => {
  it.each(["create_agent_task", "list_agent_tasks"])("returns setup once across create/list and reconnection, starting with %s", async (first) => {
    const f = await fixture();
    try {
      const initial = await f.call(first, first === "create_agent_task" ? createArgs : {});
      expect(initial.result.isError).toBeUndefined();
      expect(initial.body.setup).toMatchObject({
        status: "required", record_with: "set_completion_strategy",
        options: [{ id: "webhook", recommended: true }, { id: "check_later" }],
      });
      expect((initial.body.setup as { ask_instruction: string }).ask_instruction).toContain("current language");
      for (const name of ["create_agent_task", "list_agent_tasks"]) {
        expect((await f.call(name, name === "create_agent_task" ? createArgs : {})).body).not.toHaveProperty("setup");
      }
      expect((await readState(f.path)).completion_prefs?._default?.asked_at).toEqual(expect.any(String));
      const restarted = await fixture(false, f.path);
      try {
        expect((await restarted.call("list_agent_tasks")).body).not.toHaveProperty("setup");
      } finally { await restarted.close(); }
    } finally { await f.close(); }
  });

  it("does not elicit or reask an auto-declining elicitation-capable client", async () => {
    const f = await fixture(true);
    try {
      expect((await f.call("create_agent_task", createArgs)).body).toHaveProperty("setup");
      expect((await f.call("list_agent_tasks")).body).not.toHaveProperty("setup");
      expect((await f.call("create_agent_task", createArgs)).body).not.toHaveProperty("setup");
      expect(f.elicit).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("atomically asks once across concurrent calls", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([f.call("list_agent_tasks"), f.call("list_agent_tasks")]);
      expect(results.filter(({ body }) => body.setup)).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["webhook", "check_later"])("persists %s without repeating setup or disclosing tokens/secrets", async (strategy) => {
    const f = await fixture();
    try {
      const saved = await f.call("set_completion_strategy", { strategy });
      expect(saved.body).toMatchObject({ strategy });
      expect(saved.text).not.toMatch(/https:|Authorization.*value=/);
      if (strategy === "webhook") expect(saved.body.next_step).toContain("webhook register --owner");
      expect((await readState(f.path)).completion_prefs?._default).toMatchObject({ strategy, decided_at: expect.any(String) });
      const created = await f.call("create_agent_task", createArgs);
      expect(created.body).not.toHaveProperty("setup");
      expect(created.body).toMatchObject({ follow_up: { mode: "check_later" } });
      await owner(f.path);
      const owned = await f.call("set_completion_strategy", { strategy, owner_token: token });
      expect(owned.text).not.toContain(token);
      expect(JSON.stringify(await readState(f.path))).not.toContain(token);
      expect((await readState(f.path)).completion_prefs?.client?.strategy).toBe(strategy);
      const ownedCreation = await f.call("create_agent_task", { ...createArgs, owner_token: token });
      expect(ownedCreation.body).toMatchObject({ follow_up: { mode: strategy === "webhook" ? "push" : "check_later" } });
    } finally { await f.close(); }
  });

  it("creates unowned without a token and uses global fallback without routing to a registered owner", async () => {
    const f = await fixture();
    try {
      await owner(f.path);
      await f.call("set_completion_strategy", { strategy: "check_later" });
      vi.stubEnv("COPILOT_AGENTS_NOTIFY_URL", "https://global.example/hidden");
      const created = await f.call("create_agent_task", createArgs);
      expect(created.body).not.toHaveProperty("owner");
      expect(created.body).toMatchObject({ follow_up: { mode: "push" } });
      expect((await readState(f.path)).tasks["new-task"]).not.toHaveProperty("owner");
    } finally { await f.close(); }
  });

  it("resolves a token to its owner, suppresses setup, and persists before watcher launch", async () => {
    const f = await fixture();
    try {
      await owner(f.path);
      const created = await f.call("create_agent_task", { ...createArgs, owner_token: token });
      expect(created.body).toMatchObject({ owner: "client", follow_up: { mode: "push" } });
      expect(created.body).not.toHaveProperty("setup");
      expect(created.text).not.toContain(token);
      expect(created.text).not.toContain("hidden-query");
      expect(f.github.createTask).toHaveBeenCalledWith({ owner: "o", repo: "r", prompt: "tiny edit", model: "m" });
      expect((await readState(f.path)).tasks["new-task"]?.owner).toBe("client");
      expect(f.launchWatcher).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it.each(["create_agent_task", "steer_agent_task", "set_completion_strategy"])("rejects invalid tokens before mutation in %s, without token leaks or fallback", async (name) => {
    const f = await fixture();
    const log = vi.spyOn(console, "error");
    try {
      await owner(f.path);
      vi.stubEnv("COPILOT_AGENTS_NOTIFY_URL", "https://global.example");
      const args = name === "create_agent_task" ? createArgs : name === "steer_agent_task" ? { task_id: "owned-task", content: "continue" } : name === "set_completion_strategy" ? { strategy: "webhook" } : {};
      const invalid = await f.call(name, { ...args, owner_token: "invalid-private-token" });
      expect(invalid.result.isError).toBe(true);
      expect(invalid.body).toMatchObject({ error: { code: "owner_token_invalid" } });
      expect(invalid.text).not.toContain("invalid-private-token");
      expect(JSON.stringify(log.mock.calls)).not.toContain("invalid-private-token");
      expect(f.github.createTask).not.toHaveBeenCalled();
      expect(f.github.steerTask).not.toHaveBeenCalled();
      expect(f.launchWatcher).not.toHaveBeenCalled();
      expect((await readState(f.path)).tasks).not.toHaveProperty("new-task");
    } finally { await f.close(); }
  });

  it.each([undefined, "other-owner-token"])("rejects missing or mismatched owned steering token %s before remote reads/steer", async (owner_token) => {
    const f = await fixture();
    try {
      await owner(f.path);
      await owner(f.path, "other", "other-owner-token");
      const invalid = await f.call("steer_agent_task", { task_id: "owned-task", content: "continue", ...(owner_token ? { owner_token } : {}) });
      expect(invalid.body).toMatchObject({ error: { code: "owner_token_invalid" } });
      expect(f.github.getTask).not.toHaveBeenCalled();
      expect(f.github.steerTask).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("accepts matching owned steering token, arms the next turn, and never returns the token", async () => {
    const f = await fixture();
    try {
      await owner(f.path);
      const accepted = await f.call("steer_agent_task", { task_id: "owned-task", content: "continue", owner_token: token });
      expect(accepted.body).toEqual({ task_id: "owned-task", accepted: true, session_count: 1 });
      expect(f.github.steerTask).toHaveBeenCalledExactlyOnceWith("owned-task", "continue");
      expect((await readState(f.path)).tasks["owned-task"]?.steer).toMatchObject({ session_count: 1, notified: false });
      expect(f.launchWatcher).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("revalidates the capability under the steering lock after remote reads", async () => {
    const f = await fixture();
    try {
      await owner(f.path);
      f.github.getPullRequest = vi.fn().mockImplementation(async () => {
        await withStateLock(f.path, (state) => {
          if (state.webhooks?.client) state.webhooks.client.ownerTokenHash = createHash("sha256").update("rotated-capability").digest("hex");
        });
        return { state: "open" };
      });
      const rejected = await f.call("steer_agent_task", { task_id: "owned-task", content: "continue", owner_token: token });
      expect(rejected.body).toMatchObject({ error: { code: "owner_token_invalid" } });
      expect(f.github.steerTask).not.toHaveBeenCalled();
      expect(f.launchWatcher).not.toHaveBeenCalled();
      expect((await readState(f.path)).tasks["owned-task"]?.steer).toBeFalsy();
    } finally { await f.close(); }
  });

  it("keeps creation and routing atomic against concurrent token revocation", async () => {
    const f = await fixture();
    try {
      await owner(f.path);
      vi.stubEnv("COPILOT_AGENTS_NOTIFY_URL", "https://global.example");
      let started!: () => void;
      let finish!: () => void;
      const requestStarted = new Promise<void>((resolve) => { started = resolve; });
      const finishRequest = new Promise<void>((resolve) => { finish = resolve; });
      f.github.createTask = vi.fn().mockImplementation(async () => {
        started();
        await finishRequest;
        return { id: "new-task", state: "queued", created_at: "2026-11-25T00:00:00Z" };
      });
      const creation = f.call("create_agent_task", { ...createArgs, owner_token: token });
      await requestStarted;
      const revocation = withStateLock(f.path, (state) => { delete state.webhooks?.client; });
      finish();
      const created = await creation;
      await revocation;
      expect(created.body).toMatchObject({ owner: "client", follow_up: { mode: "push" } });
      expect((await readState(f.path)).tasks["new-task"]?.owner).toBe("client");
    } finally { await f.close(); }
  });

  it("tracks each unconfigured list owner label independently without authenticating it", async () => {
    const f = await fixture();
    try {
      for (const label of ["unregistered-A", "unregistered-B"]) {
        expect((await f.call("list_agent_tasks", { owner: ` ${label} ` })).body).toHaveProperty("setup");
        expect((await f.call("list_agent_tasks", { owner: label })).body).not.toHaveProperty("setup");
        expect((await readState(f.path)).completion_prefs?.[label]?.asked_at).toEqual(expect.any(String));
      }
      expect((await readState(f.path)).completion_prefs).not.toHaveProperty("_default");
      expect((await f.call("list_agent_tasks")).body).toHaveProperty("setup");
    } finally { await f.close(); }
  });

  it("allows switching an owned task from scheduled checks back to webhook delivery", async () => {
    const f = await fixture();
    try {
      await owner(f.path);
      await f.call("set_completion_strategy", { strategy: "check_later", owner_token: token });
      expect((await f.call("create_agent_task", { ...createArgs, owner_token: token })).body).toMatchObject({ delivery: "not_configured", follow_up: { mode: "check_later" } });
      expect(f.launchWatcher).not.toHaveBeenCalled();
      await f.call("set_completion_strategy", { strategy: "webhook", owner_token: token });
      expect((await f.call("create_agent_task", { ...createArgs, owner_token: token })).body).toMatchObject({ delivery: "pending", follow_up: { mode: "push" } });
      expect(f.launchWatcher).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it.each(["create_agent_task", "steer_agent_task", "set_completion_strategy"])("strictly rejects spoofed owner in %s", async (name) => {
    const f = await fixture();
    try {
      const args = name === "create_agent_task" ? createArgs : name === "steer_agent_task" ? { task_id: "owned-task", content: "continue" } : { strategy: "check_later" };
      expect((await f.call(name, { ...args, owner: "victim" })).result.isError).toBe(true);
      expect(f.github.createTask).not.toHaveBeenCalled();
      expect(f.github.steerTask).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
