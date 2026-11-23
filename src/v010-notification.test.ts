import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "./github.ts";
import { CodedToolFailure } from "./errors.ts";
import { buildSummary, mapRawState } from "./task-status.ts";
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
  const cases: Array<[string, ReturnType<typeof mapRawState>]> = [
    ["working", { status: "working", terminal: false }],
    ["queued", { status: "working", terminal: false }],
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
    const recent = new Date().toISOString();
    const slightlyOlder = new Date(Date.now() - 60_000).toISOString();
    await withStateLock(path, (state) => {
      for (let i = 0; i < 3; i++) {
        state.tasks[`idle-${i}`] = {
          ...initialTask({
            id: `idle-${i}`,
            repo: "o/r",
            requestedModel: "m",
            state: "idle",
            createdAt: slightlyOlder,
            updatedAt: slightlyOlder,
          }),
          completed_at: slightlyOlder,
        };
      }
      state.tasks.run = initialTask({
        id: "run",
        repo: "o/r",
        requestedModel: "m",
        state: "working",
        createdAt: recent,
        updatedAt: recent,
      });
    });
    const { matched, tasks } = filterTasks(await readState(path), { limit: 2 });
    expect(tasks).toHaveLength(2);
    expect(listCounts(matched)).toMatchObject({ pending_count: 1, all_terminal: false });
  });

  it("rejects limit above the cap", async () => {
    const path = await stateFile();
    const state = await readState(path);
    expect(() => filterTasks(state, { limit: 51 })).toThrow(OwnerValidationError);
  });

  it("counts per owner", async () => {
    const path = await stateFile();
    await withStateLock(path, (state) => {
      state.tasks.a = { ...initialTask({ id: "a", repo: "o/r", requestedModel: "m", state: "working", createdAt: null, updatedAt: null, owner: "Alice" }), owner: "alice" };
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
      state.tasks.a = { ...initialTask({ id: "a", repo: "o/r", requestedModel: "m", state: "working", createdAt: null, updatedAt: null }), owner: "thrall" };
      state.tasks.b = { ...initialTask({ id: "b", repo: "o/r", requestedModel: "m", state: "working", createdAt: null, updatedAt: null }), owner: "other" };
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
    const text = createFollowUpNextStep("push", "thrall", "abc", false);
    expect(text).toBe("Task queued; cloud tasks usually take 5-30 minutes. End your turn now. Do not wait and do not call get_agent_task in a loop. A completion notice will be POSTed to the configured endpoint. If you are woken by it, call get_agent_task once for the result.");
  });

  it("check_after default 10 minutes and min_interval 300", () => {
    const now = Date.parse("2026-11-23T20:00:00.000Z");
    const block = followUpBlock(["webhook"], true, now);
    expect(block.min_interval_s).toBe(300);
    expect(block.check_after).toBe("2026-11-23T20:10:00.000Z");
  });

  it("owner substitution in user_push", () => {
    const text = createFollowUpNextStep("user_push", "thrall", "abc", false);
    expect(text).toContain('owner="thrall"');
  });

  it("task_ids fallback", () => {
    const text = createFollowUpNextStep("check_later", undefined, "abc", false);
    expect(text).toContain('task_ids=["abc"]');
  });
});

describe("v0.1.0 cache and retention", () => {
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
      ...initialTask({ id: "t", repo: "o/r", requestedModel: "m", state: "working", createdAt: null, updatedAt: null }),
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
});