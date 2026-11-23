import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTask, GitHubClient } from "./github.ts";
import { createGitHubClient } from "./github.ts";
import { activeNotificationChannels, deliverNotice, notificationPlan, postNotice, type DeliveredNotice, type NotifyChannel } from "./notify.ts";
import { armSteer, emptyState, initialTask, presentUsage, readState, withStateLock, type StateFile, type TaskNotice } from "./state.ts";
import { runWatcher } from "./watch.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilot-agents-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

function task(id: string, state: string, requested = "missing-model-123"): StateFile {
  const file = emptyState();
  file.models.accepted = ["mai-code-2"];
  file.tasks[id] = initialTask({
    id,
    repo: "octocat/hello-world",
    requestedModel: requested,
    state,
    createdAt: "2026-11-22T00:00:00Z",
    updatedAt: "2026-11-22T00:00:00Z",
  });
  return file;
}

async function save(path: string, file: StateFile): Promise<void> {
  await withStateLock(path, (state) => {
    state.tasks = file.tasks;
    state.models = file.models;
  });
}

function client(
  responses: AgentTask[],
  findPullRequest: GitHubClient["findPullRequest"] = async () => ({ number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" }),
): GitHubClient {
  return {
    async createTask() {
      throw new Error("not called");
    },
    async getTask() {
      const next = responses.shift();
      if (!next) throw new Error("no response");
      return next;
    },
    findPullRequest,
    async getPullRequest() {
      throw new Error("not called");
    },
    async steerTask() {
      throw new Error("not called");
    },
    async abortTask() {
      throw new Error("not called");
    },
    async getTaskEvents() {
      throw new Error("not called");
    },
  };
}

function remote(id: string, state: string, extra: Partial<AgentTask> = {}): AgentTask {
  return { id, state, created_at: "2026-11-22T00:00:00Z", updated_at: "2026-11-22T00:01:00Z", ...extra };
}

function ackDelivery(channels: NotifyChannel[] = ["system"], handler?: (notice: TaskNotice) => void | Promise<void>) {
  return async (notice: TaskNotice): Promise<DeliveredNotice> => {
    await handler?.(notice);
    return { channels };
  };
}

describe("watcher", () => {
  it("treats idle as final and notifies once", async () => {
    const statePath = await tempState();
    await save(statePath, task("task-1", "in_progress"));
    const notices: string[] = [];
    const github = client([
      remote("task-1", "in_progress"),
      remote("task-1", "idle"),
    ]);
    await runWatcher({
      client: github,
      statePath,
      deliver: ackDelivery(["system"], (notice) => {
        notices.push(notice.state);
      }),
      intervalMs: 0,
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(notices).toEqual([]);
    expect((await readState(statePath)).tasks["task-1"]?.state).toBe("in_progress");
    await runWatcher({
      client: github,
      statePath,
      deliver: ackDelivery(["system"], (notice) => {
        notices.push(notice.state);
      }),
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual(["idle"]);
    await runWatcher({
      client: github,
      statePath,
      deliver: ackDelivery(["system"], (notice) => {
        notices.push(notice.state);
      }),
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual(["idle"]);
    expect((await readState(statePath)).tasks["task-1"]?.notified_at).toBeTruthy();
  });

  it("notifies once for a new steer turn", async () => {
    const statePath = await tempState();
    await save(statePath, task("task-1", "in_progress"));
    const notices: Array<{ state: string; session_id: string | null }> = [];
    const deliver = ackDelivery(["system"], (notice) => {
      notices.push({ state: notice.state, session_id: notice.session_id });
    });
    const session = { id: "session-1", state: "idle", created_at: "2026-11-22T00:00:01Z" };
    await runWatcher({
      client: client([remote("task-1", "idle", { session_count: 1, sessions: [session] })]),
      statePath,
      deliver,
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual([{ state: "idle", session_id: "session-1" }]);
    await withStateLock(statePath, (state) => {
      const saved = state.tasks["task-1"];
      if (!saved) throw new Error("missing task");
      armSteer(saved, 1, "2026-11-22T00:10:00.000Z");
    });
    await runWatcher({
      client: client([remote("task-1", "idle", { session_count: 1, sessions: [session] })]),
      statePath,
      deliver,
      intervalMs: 0,
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(notices).toHaveLength(1);
    await runWatcher({
      client: client([
        remote("task-1", "in_progress", { session_count: 1, sessions: [{ ...session, state: "in_progress" }] }),
        remote("task-1", "idle", { session_count: 1, sessions: [{ ...session, completed_at: "2026-11-22T00:20:00Z" }] }),
      ]),
      statePath,
      deliver,
      intervalMs: 0,
      maxCycles: 3,
      sleep: async () => {},
    });
    expect(notices).toEqual([
      { state: "idle", session_id: "session-1" },
      { state: "idle", session_id: "session-1" },
    ]);
    await runWatcher({
      client: client([]),
      statePath,
      deliver,
      intervalMs: 0,
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(notices).toHaveLength(2);
    expect((await readState(statePath)).tasks["task-1"]?.steer).toMatchObject({
      at: "2026-11-22T00:10:00.000Z",
      session_count: 1,
      turn_seen: true,
      notified: true,
    });
  });

  it("notifies once when a steer opens another session that is already final", async () => {
    const statePath = await tempState();
    await save(statePath, task("task-1", "idle"));
    await withStateLock(statePath, (state) => {
      const saved = state.tasks["task-1"];
      if (!saved) throw new Error("missing task");
      saved.notified_at = "2026-11-22T00:05:00.000Z";
      saved.session_id = "session-1";
      armSteer(saved, 1, "2026-11-22T00:10:00.000Z");
    });
    const notices: Array<string | null> = [];
    const deliver = ackDelivery(["system"], (notice) => {
      notices.push(notice.session_id);
    });
    await runWatcher({
      client: client([remote("task-1", "idle", {
        session_count: 1,
        sessions: [{ id: "session-1", state: "idle", created_at: "2026-11-22T00:00:01Z" }],
      })]),
      statePath,
      deliver,
      intervalMs: 0,
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(notices).toEqual([]);
    await runWatcher({
      client: client([remote("task-1", "idle", {
        session_count: 2,
        sessions: [
          { id: "session-1", state: "idle", created_at: "2026-11-22T00:00:01Z" },
          { id: "session-2", state: "idle", created_at: "2026-11-22T00:30:00Z" },
        ],
      })]),
      statePath,
      deliver,
      intervalMs: 0,
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(notices).toEqual(["session-2"]);
    await runWatcher({
      client: client([]),
      statePath,
      deliver,
      intervalMs: 0,
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(notices).toEqual(["session-2"]);
  });

  it("steered + failed delivery -> runWatcher returns", async () => {
    const statePath = await tempState();
    await withStateLock(statePath, (state) => {
      state.tasks["task-1"] = {
        ...initialTask({
          id: "task-1",
          repo: "octocat/hello-world",
          requestedModel: "grok-4.7",
          state: "idle",
          createdAt: "2026-11-22T00:00:00Z",
          updatedAt: "2026-11-22T00:01:00Z",
        }),
        steer: { at: "2026-11-22T00:10:00Z", session_count: 1, turn_seen: true, notified: false },
        delivery: { status: "failed", reason: "all configured channels failed (system)" },
        notified_at: "2026-11-22T00:05:00Z",
      };
    });
    let polls = 0;
    await runWatcher({
      client: client([]),
      statePath,
      deliver: async () => ({ channels: [] }),
      intervalMs: 0,
      sleep: async () => {
        polls += 1;
      },
    });
    expect(polls).toBe(0);
  });

  it("re-steer after failed delivery notifies", async () => {
    const statePath = await tempState();
    await withStateLock(statePath, (state) => {
      state.tasks["task-1"] = {
        ...initialTask({
          id: "task-1",
          repo: "octocat/hello-world",
          requestedModel: "grok-4.7",
          state: "idle",
          createdAt: "2026-11-22T00:00:00Z",
          updatedAt: "2026-11-22T00:01:00Z",
        }),
        steer: { at: "2026-11-22T00:10:00Z", session_count: 1, turn_seen: true, notified: false },
        delivery: { status: "failed", reason: "all configured channels failed (system)" },
        notified_at: "2026-11-22T00:05:00Z",
      };
    });
    await withStateLock(statePath, (state) => {
      const saved = state.tasks["task-1"];
      if (!saved) throw new Error("missing task");
      armSteer(saved, 1, "2026-11-22T00:30:00Z");
    });
    const notices: Array<string | null> = [];
    await runWatcher({
      client: client([remote("task-1", "idle", {
        session_count: 2,
        sessions: [
          { id: "session-1", state: "idle", created_at: "2026-11-22T00:00:01Z" },
          { id: "session-2", state: "idle", created_at: "2026-11-22T00:40:00Z" },
        ],
      })]),
      statePath,
      deliver: ackDelivery(["webhook"], (notice) => {
        notices.push(notice.session_id);
      }),
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual(["session-2"]);
    const saved = (await readState(statePath)).tasks["task-1"];
    expect(saved?.delivery).toBeNull();
    expect(saved?.steer?.notified).toBe(true);
  });

  it("records failed delivery when the system notifier fails and no URL is set", async () => {
    const statePath = await tempState();
    const logPath = join(statePath, "../watch-fail.log");
    const binDir = await mkdtemp(join(tmpdir(), "copilot-notify-bin-"));
    dirs.push(binDir);
    const notifySend = join(binDir, "notify-send");
    await writeFile(notifySend, "#!/bin/sh\n");
    await chmod(notifySend, 0o755);
    const previousLog = process.env.COPILOT_AGENTS_LOG;
    const previousPath = process.env.PATH;
    process.env.COPILOT_AGENTS_LOG = logPath;
    process.env.PATH = binDir;
    await save(statePath, task("task-1", "in_progress"));
    try {
    await runWatcher({
      client: client([remote("task-1", "completed")]),
      statePath,
      deliver: (notice) => deliverNotice(notice, { COPILOT_AGENTS_LOG: logPath, PATH: binDir }, fetch, spawnEnoent(), "linux"),
      intervalMs: 0,
      sleep: async () => {},
    });
    } finally {
      if (previousLog === undefined) delete process.env.COPILOT_AGENTS_LOG;
      else process.env.COPILOT_AGENTS_LOG = previousLog;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const saved = await readState(statePath);
    expect(saved.tasks["task-1"]?.notified_at).toBeNull();
    expect(saved.tasks["task-1"]?.delivery).toEqual({
      status: "failed",
      reason: "all configured channels failed (system)",
    });
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("Notification delivery failed for task task-1");
    expect(log).toContain("ENOENT notify-send");
  });

  it("stores a model rejection in state and in the notification", async () => {
    const statePath = await tempState();
    await save(statePath, task("task-1", "queued", "missing-model-123"));
    const notices: Array<string | null> = [];
    await runWatcher({
      client: client([remote("task-1", "failed", {
        sessions: [{
          id: "session-1",
          state: "failed",
          created_at: "2026-11-22T00:00:01Z",
          error: { message: "The selected model isn't available" },
        }],
      })]),
      statePath,
      deliver: ackDelivery(["system"], (notice) => {
        notices.push(notice.error);
      }),
      intervalMs: 0,
      sleep: async () => {},
    });
    const saved = await readState(statePath);
    expect(saved.models.rejected).toContain("missing-model-123");
    expect(saved.models.accepted).toEqual(["mai-code-2"]);
    expect(saved.tasks["task-1"]?.error).toContain("Accepted models observed: mai-code-2");
    expect(notices[0]).toContain('The model "missing-model-123" is not available');
    expect(notices[0]).toContain("Detail: The selected model isn't available");
  });

  it("resumes a pending task and posts to the local receiver", async () => {
    const statePath = await tempState();
    await save(statePath, task("task-1", "in_progress", "grok-4.7"));
    const received: Array<{ authorization: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}/hook`;
    try {
      const deliver = ackDelivery(["webhook"], async (notice) => {
        await postNotice(url, notice, "Bearer aviso");
      });
      await runWatcher({
        client: client([remote("task-1", "in_progress")]),
        statePath,
        deliver,
        intervalMs: 0,
        maxCycles: 1,
        sleep: async () => {},
      });
      expect(received).toHaveLength(0);
      await runWatcher({
        client: client([remote("task-1", "completed", {
          sessions: [{
            id: "session-1",
            state: "completed",
            created_at: "2026-11-22T00:00:01Z",
            completed_at: "2026-11-22T00:05:00Z",
            model: "sweagent-capi:grok-4.7",
            usage: { type: "ai_credits", amount: 344_355_000 },
          }],
          artifacts: [
            { type: "pull", provider: "github", data: { id: 42 } },
            { type: "branch", provider: "github", data: { head_ref: "copilot/demo", base_ref: "main" } },
          ],
        })]),
        statePath,
        deliver,
        intervalMs: 0,
        sleep: async () => {},
      });
      await runWatcher({
        client: client([]),
        statePath,
        deliver,
        intervalMs: 0,
        sleep: async () => {},
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe("Bearer aviso");
    expect(received[0]?.body).toMatchObject({
      task_id: "task-1",
      repo: "octocat/hello-world",
      state: "completed",
      requested_model: "grok-4.7",
      resolved_model: "sweagent-capi:grok-4.7",
      pull_request: { id: 42, number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" },
      branch: { head_ref: "copilot/demo", base_ref: "main" },
      error: null,
      usage: { type: "ai_credits", amount: 344_355_000, amount_human: 0.344355 },
      created_at: "2026-11-22T00:00:00Z",
      completed_at: "2026-11-22T00:05:00Z",
    });
  });
});

describe("system notification", () => {
  it("omits system from active channels when notify-send is not on PATH", () => {
    expect(activeNotificationChannels("linux", {
      PATH: "/nonexistent",
      COPILOT_AGENTS_NOTIFY_URL: "http://127.0.0.1/hook",
    })).toEqual(["webhook"]);
    expect(activeNotificationChannels("linux", { PATH: "/nonexistent" })).toEqual([]);
  });

  it("treats signal kill as system notification failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-agents-"));
    dirs.push(dir);
    const logPath = join(dir, "watch.log");
    const notifySend = join(dir, "notify-send");
    await writeFile(notifySend, "#!/bin/sh\n");
    await chmod(notifySend, 0o755);
    let spawnCalls = 0;
    const spawnKill = ((...args: Parameters<ReturnType<typeof spawnExitNull>>) => {
      spawnCalls += 1;
      return spawnExitNull()(...args);
    }) as ReturnType<typeof spawnExitNull>;
    const delivered = await deliverNotice(sampleNotice(), {
      COPILOT_AGENTS_LOG: logPath,
      PATH: dir,
    }, fetch, spawnKill, "linux");
    expect(spawnCalls).toBe(1);
    expect(delivered.channels).toEqual([]);
    expect(await readFile(logPath, "utf8")).toContain("signal notify-send");
  });

  it("prepares Windows, macOS, and Linux notifications without the token", () => {
    const env = { PATH: "/usr/bin", GITHUB_PERSONAL_ACCESS_TOKEN: "test-token", SystemRoot: "C:\\Windows" };
    const windows = notificationPlan("win32", "Copilot completed", "octocat/hello-world", env);
    const mac = notificationPlan("darwin", "Copilot completed", "octocat/hello-world", env);
    const linux = notificationPlan("linux", "Copilot completed", "octocat/hello-world", env);
    expect(windows?.command).toBe("powershell.exe");
    expect(windows?.args).toContain("-Command");
    expect(mac?.command).toBe("osascript");
    expect(linux?.command).toBe("notify-send");
    for (const plan of [windows, mac, linux]) {
      expect(plan?.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
      expect(JSON.stringify(plan)).not.toContain("test-token");
      expect(plan?.env.COPILOT_AGENTS_NOTIFY_TITLE).toBe("Copilot completed");
    }
  });

  it("logs ENOENT from notify-send and sends the POST", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-agents-"));
    dirs.push(dir);
    const logPath = join(dir, "watch.log");
    const notifySend = join(dir, "notify-send");
    await writeFile(notifySend, "#!/bin/sh\n");
    await chmod(notifySend, 0o755);
    let posted = false;
    const delivered = await deliverNotice(sampleNotice(), {
      COPILOT_AGENTS_LOG: logPath,
      COPILOT_AGENTS_NOTIFY_URL: "http://notification.example/hook",
      PATH: dir,
    }, async () => {
      posted = true;
      return new Response(null, { status: 204 });
    }, spawnEnoent(), "linux");
    expect(delivered.channels).toEqual(["webhook"]);
    expect(posted).toBe(true);
    expect(await readFile(logPath, "utf8")).toContain("ENOENT notify-send");
  });
});

describe("credits and pull request", () => {
  it("divides nano-credits by 1e9", () => {
    expect(presentUsage({ type: "ai_credits", amount: 344_355_000 })).toEqual({
      type: "ai_credits",
      amount: 344_355_000,
      amount_human: 0.344355,
    });
    expect(presentUsage({ type: "premium_requests", amount: 3 })).toEqual({
      type: "premium_requests",
      amount: 3,
      amount_human: 3,
    });
  });

  it("renotifies a final task and fills number and html_url", async () => {
    const statePath = await tempState();
    await writeFile(statePath, `${JSON.stringify(finishedState(), null, 2)}\n`);
    const seen: string[] = [];
    const github = createGitHubClient({
      token: "test-token",
      fetch: mockFetch((url) => {
        seen.push(url);
        return new Response(JSON.stringify([
          { id: 41, number: 1, html_url: "https://github.com/octocat/hello-world/pull/1" },
          { id: 42, number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" },
        ]), { status: 200 });
      }),
    });
    const notices: TaskNotice[] = [];
    await runWatcher({
      client: github,
      statePath,
      deliver: ackDelivery(["system"], (notice) => {
        notices.push(notice);
      }),
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(seen).toEqual([
      "https://api.github.com/repos/octocat/hello-world/pulls?state=all&head=octocat%3Acopilot%2Fdemo&per_page=100",
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.pull_request).toEqual({
      id: 42,
      number: 7,
      html_url: "https://github.com/octocat/hello-world/pull/7",
    });
    expect(notices[0]?.usage).toEqual({ type: "ai_credits", amount: 344_355_000, amount_human: 0.344355 });
    expect(notices[0]?.resolved_model).toBe("sweagent-capi:grok-4.7");
    const saved = await readState(statePath);
    expect(saved.tasks["task-1"]?.notified_at).toBeTruthy();
    expect(saved.tasks["task-1"]?.pull_request).toEqual(notices[0]?.pull_request);
  });

  it("notifies with null number and html_url when the pull request API fails", async () => {
    const statePath = await tempState();
    const logPath = join(statePath, "../watch.log");
    const previous = process.env.COPILOT_AGENTS_LOG;
    process.env.COPILOT_AGENTS_LOG = logPath;
    await writeFile(statePath, `${JSON.stringify(finishedState(), null, 2)}\n`);
    const notices: TaskNotice[] = [];
    try {
      await runWatcher({
        client: createGitHubClient({
          token: "test-token",
          fetch: mockFetch(() => new Response(JSON.stringify({ message: "boom test-token" }), { status: 500 })),
        }),
        statePath,
        deliver: ackDelivery(["system"], (notice) => {
          notices.push(notice);
        }),
        intervalMs: 0,
        sleep: async () => {},
      });
    } finally {
      if (previous === undefined) delete process.env.COPILOT_AGENTS_LOG;
      else process.env.COPILOT_AGENTS_LOG = previous;
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]?.pull_request).toEqual({ id: 42, number: null, html_url: null });
    expect((await readState(statePath)).tasks["task-1"]?.notified_at).toBeTruthy();
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("Could not resolve pull request 42 for task-1");
    expect(log).toContain("boom");
    expect(log).not.toContain("test-token");
  });
});

function finishedState(): StateFile {
  return {
    tasks: {
      "task-1": {
        task_id: "task-1",
        repo: "octocat/hello-world",
        requested_model: "grok-4.7",
        state: "completed",
        resolved_model: "sweagent-capi:grok-4.7",
        pull_request: { id: 42 } as StateFile["tasks"][string]["pull_request"],
        branch: { head_ref: "copilot/demo", base_ref: "main" },
        artifacts: [
          { type: "pull", id: 42 },
          { type: "branch", head_ref: "copilot/demo", base_ref: "main" },
        ],
        error: null,
        usage: { type: "ai_credits", amount: 344_355_000, amount_human: 0.3 },
        created_at: "2026-11-22T00:00:00Z",
        updated_at: "2026-11-22T00:01:00Z",
        completed_at: "2026-11-22T00:05:00Z",
        notified_at: null,
      },
    },
    models: { accepted: ["grok-4.7"], rejected: [] },
  };
}

function sampleNotice(): TaskNotice {
  return {
    task_id: "task-1",
    repo: "octocat/hello-world",
    state: "completed",
    requested_model: null,
    resolved_model: null,
    pull_request: null,
    branch: null,
    artifacts: [],
    error: null,
    usage: null,
    created_at: null,
    updated_at: null,
    completed_at: null,
    session_id: null,
    notified: false,
  };
}

function spawnExitNull(): typeof import("node:child_process").spawn {
  const impl = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", null, "SIGKILL"));
    return child;
  };
  return impl as unknown as typeof import("node:child_process").spawn;
}

function spawnEnoent(): typeof import("node:child_process").spawn {
  const impl = () => {
    const child = new EventEmitter();
    setImmediate(() => {
      const error = new Error("spawn notify-send ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      child.emit("error", error);
    });
    return child;
  };
  return impl as unknown as typeof import("node:child_process").spawn;
}

function mockFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
}
