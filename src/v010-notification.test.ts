import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "./github.ts";
import { CodedToolFailure } from "./errors.ts";
import { buildSummary, DOCUMENTED_TASK_STATES, mapRawState, unknownStateWarning } from "./task-status.ts";
import { createFollowUpNextStep, followUpBlock } from "./follow-up.ts";
import { deliveryForTask } from "./delivery.ts";
import {
  filterTasks,
  freshnessMs,
  listCounts,
  listNextStep,
  needsFetch,
  OwnerValidationError,
  pruneRegistry,
  REGISTRY_PRUNE_TERMINAL_MS,
  validateOwner,
} from "./tasks.ts";
import { initialTask, readState, withStateLock, type TrackedTask } from "./state.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilot-v010-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

describe("v0.1.0 status mapping", () => {
  it("maps every documented OpenAPI task state", () => {
    for (const raw of DOCUMENTED_TASK_STATES) {
      expect(mapRawState(raw).status).toBeTruthy();
    }
  });

  const cases: Array<[string, ReturnType<typeof mapRawState>]> = [
    ["queued", { status: "working", terminal: false }],
    ["in_progress", { status: "working", terminal: false }],
    ["waiting_for_user", { status: "needs_input", terminal: false }],
    ["idle", { status: "completed", terminal: true }],
    ["completed", { status: "completed", terminal: true }],
    ["failed", { status: "failed", terminal: true }],
    ["timed_out", { status: "failed", terminal: true }],
    ["cancelled", { status: "cancelled", terminal: true }],
    ["mystery_upstream", { status: "failed", terminal: true }],
  ];
  for (const [raw, expected] of cases) {
    it(`maps ${raw}`, () => {
      expect(mapRawState(raw)).toEqual(expected);
      const task = initialTask({ id: "t", repo: "o/r", requestedModel: "m", state: raw, createdAt: "2026-01-01T00:00:00Z", updatedAt: null });
      expect(buildSummary(task).length).toBeLessThanOrEqual(160);
    });
  }
});

describe("v0.1.0 owners and list filters", () => {
  it("list counts use the full filtered set, not only the page", async () => {
    const path = await stateFile();
    const newest = new Date().toISOString();
    const middle = new Date(Date.now() - 60_000).toISOString();
    const oldestPending = new Date(Date.now() - 3_600_000).toISOString();
    await withStateLock(path, (state) => {
      state.tasks["idle-new"] = {
        ...initialTask({
          id: "idle-new",
          repo: "o/r",
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
          repo: "o/r",
          requestedModel: "m",
          state: "idle",
          createdAt: middle,
          updatedAt: middle,
        }),
        completed_at: middle,
      };
      state.tasks.run = initialTask({
        id: "run",
        repo: "o/r",
        requestedModel: "m",
        state: "in_progress",
        createdAt: oldestPending,
        updatedAt: oldestPending,
      });
    });
    const { matched, tasks } = filterTasks(await readState(path), { limit: 1 });
    expect(tasks.map((t) => t.task_id)).toEqual(["idle-new"]);
    expect(listCounts(matched)).toMatchObject({ pending_count: 1, all_terminal: false });
  });

  it("waiting_for_user counts as pending, not terminal", async () => {
    const path = await stateFile();
    await withStateLock(path, (state) => {
      state.tasks.wait = initialTask({
        id: "wait",
        repo: "o/r",
        requestedModel: "m",
        state: "waiting_for_user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    const matched = filterTasks(await readState(path), {}).matched;
    expect(listCounts(matched)).toMatchObject({ pending_count: 1, terminal_count: 0, all_terminal: false });
    expect(mapRawState("waiting_for_user")).toEqual({ status: "needs_input", terminal: false });
  });

  it("rejects limit above the cap", async () => {
    const path = await stateFile();
    const state = await readState(path);
    expect(() => filterTasks(state, { limit: 51 })).toThrow(OwnerValidationError);
  });

  it("counts per owner", async () => {
    const path = await stateFile();
    await withStateLock(path, (state) => {
      state.tasks.a = { ...initialTask({ id: "a", repo: "o/r", requestedModel: "m", state: "in_progress", createdAt: null, updatedAt: null, owner: "Alice" }), owner: "alice" };
      state.tasks.b = { ...initialTask({ id: "b", repo: "o/r", requestedModel: "m", state: "idle", createdAt: null, updatedAt: null, owner: "bob" }), owner: "bob" };
    });
    const state = await readState(path);
    const alice = filterTasks(state, { owner: "Alice" }).tasks;
    expect(listCounts(alice)).toMatchObject({ pending_count: 1, terminal_count: 0, all_terminal: false });
    const bob = filterTasks(state, { owner: "bob" }).tasks;
    expect(listCounts(bob)).toMatchObject({ pending_count: 0, terminal_count: 1, all_terminal: true });
  });

  it("intersects owner and task_ids", async () => {
    const path = await stateFile();
    await withStateLock(path, (state) => {
      state.tasks.a = { ...initialTask({ id: "a", repo: "o/r", requestedModel: "m", state: "in_progress", createdAt: null, updatedAt: null }), owner: "thrall" };
      state.tasks.b = { ...initialTask({ id: "b", repo: "o/r", requestedModel: "m", state: "in_progress", createdAt: null, updatedAt: null }), owner: "other" };
    });
    const state = await readState(path);
    const rows = filterTasks(state, { owner: "thrall", task_ids: ["a", "b"] });
    expect(rows.tasks.map((t) => t.task_id)).toEqual(["a"]);
    const missing = filterTasks(state, { owner: "thrall", task_ids: ["a", "missing"] });
    expect(missing.warnings).toContain("unknown task_id: missing");
  });
});

describe("v0.1.0 list empty states", () => {
  it("wording", () => {
    expect(listNextStep({ pending_count: 0, all_terminal: true }, false, true)).toBe("No tracked tasks.");
    expect(listNextStep({ pending_count: 0, all_terminal: true }, true, false)).toBe("No tasks match this filter.");
    expect(listNextStep({ pending_count: 0, all_terminal: true }, false, false)).toBe("No tasks are running. If you scheduled a check for these tasks, delete it now.");
  });
});

describe("v0.1.0 delivery matrix", () => {
  it("zero channels", () => {
    const task = initialTask({ id: "t", repo: "o/r", requestedModel: "m", state: "idle", createdAt: null, updatedAt: null });
    expect(deliveryForTask(task, [])).toBe("not_configured");
  });

  it("keeps delivered when channels are empty", () => {
    const task = initialTask({ id: "t", repo: "o/r", requestedModel: "m", state: "idle", createdAt: null, updatedAt: null });
    task.notified_at = "2026-01-01T00:00:00Z";
    expect(deliveryForTask(task, [])).toBe("delivered");
  });

  it("pending and delivered", () => {
    const task = initialTask({ id: "t", repo: "o/r", requestedModel: "m", state: "idle", createdAt: null, updatedAt: null, deliveryRecord: { status: "pending" } });
    expect(deliveryForTask(task, ["webhook"])).toBe("pending");
    task.notified_at = "2026-01-01T00:00:00Z";
    expect(deliveryForTask(task, ["webhook"])).toBe("delivered");
  });
});

describe("v0.1.0 follow_up", () => {
  it("push next_step", () => {
    const checkAfter = "2026-11-23T21:00:00.000Z";
    const text = createFollowUpNextStep("push", "thrall", "abc", false, checkAfter);
    expect(text).toContain("Do not wait and do not call get_agent_task in a loop");
    expect(text).toContain("POSTed");
  });

  it("check_after default 10 minutes and min_interval 300", () => {
    const now = Date.parse("2026-11-23T20:00:00.000Z");
    const block = followUpBlock(["webhook"], true, now);
    expect(block.min_interval_s).toBe(300);
    expect(block.check_after).toBe("2026-11-23T20:10:00.000Z");
  });

  it("owner substitution in user_push", () => {
    const checkAfter = "2026-11-23T21:00:00.000Z";
    const text = createFollowUpNextStep("user_push", "thrall", "abc", false, checkAfter);
    expect(text).toContain('owner="thrall"');
  });

  it("task_ids fallback", () => {
    const checkAfter = "2026-11-23T21:00:00.000Z";
    const text = createFollowUpNextStep("check_later", undefined, "abc", false, checkAfter);
    expect(text).toContain("first check not before");
    expect(text).toContain('then call list_agent_tasks with task_ids=["abc"]');
  });
});

describe("v0.1.0 cache and retention", () => {
  it("unknown terminal upstream state skips refetch", () => {
    const task = initialTask({
      id: "t",
      repo: "o/r",
      requestedModel: "m",
      state: "mystery_upstream",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(needsFetch(task, freshnessMs())).toBe(false);
  });

  it("prunes unknown terminal tasks after retention window", async () => {
    const path = await stateFile();
    const old = new Date(Date.now() - REGISTRY_PRUNE_TERMINAL_MS - 1_000).toISOString();
    await withStateLock(path, (state) => {
      state.tasks.old = {
        ...initialTask({ id: "old", repo: "o/r", requestedModel: "m", state: "mystery_upstream", createdAt: old, updatedAt: old }),
        completed_at: old,
      };
    });
    await withStateLock(path, (state) => pruneRegistry(state));
    expect((await readState(path)).tasks.old).toBeUndefined();
  });

  it("steer on a terminal task forces refetch", () => {
    const task: TrackedTask = {
      ...initialTask({ id: "t", repo: "o/r", requestedModel: "m", state: "idle", createdAt: null, updatedAt: null }),
      last_fetched_at: new Date().toISOString(),
      steer: { at: "2026-01-01T00:00:00Z", session_count: 1, turn_seen: false, notified: false },
    };
    expect(needsFetch(task, freshnessMs())).toBe(true);
  });

  it("cache hit skips fetch", () => {
    const task: TrackedTask = {
      ...initialTask({ id: "t", repo: "o/r", requestedModel: "m", state: "in_progress", createdAt: null, updatedAt: null }),
      last_fetched_at: new Date().toISOString(),
    };
    expect(needsFetch(task, freshnessMs())).toBe(false);
    const terminal = initialTask({ id: "t2", repo: "o/r", requestedModel: "m", state: "idle", createdAt: null, updatedAt: null });
    expect(needsFetch(terminal, freshnessMs())).toBe(false);
  });

  it("prunes terminal tasks after 30 days", async () => {
    const path = await stateFile();
    const old = new Date(Date.now() - REGISTRY_PRUNE_TERMINAL_MS - 1_000).toISOString();
    await withStateLock(path, (state) => {
      state.tasks.old = { ...initialTask({ id: "old", repo: "o/r", requestedModel: "m", state: "idle", createdAt: old, updatedAt: old }), completed_at: old };
    });
    await withStateLock(path, (state) => pruneRegistry(state));
    expect((await readState(path)).tasks.old).toBeUndefined();
  });
});

describe("v0.1.0 owner validation", () => {
  it("rejects bad owners", () => {
    expect(() => validateOwner("")).toThrow(OwnerValidationError);
    expect(() => validateOwner("bad name")).toThrow(OwnerValidationError);
    expect(validateOwner("Thrall")).toBe("Thrall");
  });
});

describe("v0.1.0 legacy tasks without owner", () => {
  it("appear unfiltered", async () => {
    const path = await stateFile();
    await withStateLock(path, (state) => {
      state.tasks.legacy = initialTask({ id: "legacy", repo: "o/r", requestedModel: "m", state: "idle", createdAt: null, updatedAt: null });
    });
    const all = filterTasks(await readState(path), {});
    expect(all.tasks).toHaveLength(1);
    const byOwner = filterTasks(await readState(path), { owner: "nobody" });
    expect(byOwner.tasks).toHaveLength(0);
    const byId = filterTasks(await readState(path), { task_ids: ["legacy"] });
    expect(byId.tasks).toHaveLength(1);
  });
});

describe("v0.1.0 error shape", () => {
  it("serializes coded failures", () => {
    const body = new CodedToolFailure("invalid_argument", "owner must match [A-Za-z0-9._-].").toBody();
    expect(body.error.code).toBe("invalid_argument");
    expect(body.error.retryable).toBe(false);
  });
});

export function unusedClient(): GitHubClient {
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

describe("v0.1.0 session and PR urls", () => {
  it("list rows include session_url and pr_url", async () => {
    const path = await stateFile();
    await withStateLock(path, (state) => {
      state.tasks.done = {
        ...initialTask({
          id: "done",
          repo: "octocat/hello-world",
          requestedModel: "m",
          state: "idle",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          htmlUrl: "https://github.com/octocat/hello-world/copilot/tasks/done",
        }),
        pull_request: { id: 1, number: 2, html_url: "https://github.com/octocat/hello-world/pull/2" },
        completed_at: "2026-01-02T00:00:00Z",
      };
    });
    const row = (await import("./tasks.ts")).toListRow((await readState(path)).tasks.done ?? initialTask({
      id: "x", repo: "o/r", requestedModel: "m", state: "idle", createdAt: null, updatedAt: null,
    }));
    expect(row.session_url).toBe("https://github.com/octocat/hello-world/copilot/tasks/done");
    expect(row.pr_url).toBe("https://github.com/octocat/hello-world/pull/2");
  });
});

describe("v0.1.0 unknown upstream state", () => {
  it("summary mentions the raw state", () => {
    const task = initialTask({
      id: "t",
      repo: "o/r",
      requestedModel: "m",
      state: "mystery_upstream",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: null,
    });
    expect(buildSummary(task)).toContain("unknown state");
    expect(buildSummary(task)).toContain("mystery_upstream");
  });

  it("exposes a warning string", () => {
    expect(unknownStateWarning("mystery_upstream")).toContain("mystery_upstream");
    expect(unknownStateWarning("queued")).toBeUndefined();
  });
});