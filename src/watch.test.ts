import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTask, GitHubClient } from "./github.ts";
import { notificationPlan, postNotice } from "./notify.ts";
import { emptyState, initialTask, readState, withStateLock, type StateFile } from "./state.ts";
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

function task(id: string, state: string, requested = "modelo-inexistente-123"): StateFile {
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

function client(responses: AgentTask[]): GitHubClient {
  return {
    async createTask() {
      throw new Error("no se llama");
    },
    async getTask() {
      const next = responses.shift();
      if (!next) throw new Error("sin respuesta");
      return next;
    },
  };
}

function remote(id: string, state: string, extra: Partial<AgentTask> = {}): AgentTask {
  return { id, state, created_at: "2026-11-22T00:00:00Z", updated_at: "2026-11-22T00:01:00Z", ...extra };
}

describe("vigilante", () => {
  it("trata idle como estado final y avisa una sola vez", async () => {
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
      deliver: async (notice) => {
        notices.push(notice.state);
      },
      intervalMs: 0,
      maxCycles: 1,
      sleep: async () => {},
    });
    expect(notices).toEqual([]);
    expect((await readState(statePath)).tasks["task-1"]?.state).toBe("in_progress");
    await runWatcher({
      client: github,
      statePath,
      deliver: async (notice) => {
        notices.push(notice.state);
      },
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual(["idle"]);
    await runWatcher({
      client: github,
      statePath,
      deliver: async (notice) => {
        notices.push(notice.state);
      },
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(notices).toEqual(["idle"]);
    expect((await readState(statePath)).tasks["task-1"]?.notified_at).toBeTruthy();
  });

  it("guarda el rechazo del modelo en el estado y en el aviso", async () => {
    const statePath = await tempState();
    await save(statePath, task("task-1", "queued", "modelo-inexistente-123"));
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
      deliver: async (notice) => {
        notices.push(notice.error);
      },
      intervalMs: 0,
      sleep: async () => {},
    });
    const saved = await readState(statePath);
    expect(saved.models.rejected).toContain("modelo-inexistente-123");
    expect(saved.models.accepted).toEqual(["mai-code-2"]);
    expect(saved.tasks["task-1"]?.error).toContain("Modelos vistos aceptados: mai-code-2");
    expect(notices[0]).toContain("El modelo «modelo-inexistente-123» no está disponible");
    expect(notices[0]).toContain("Detalle: The selected model isn't available");
  });

  it("reanuda una tarea pendiente y hace un POST al receptor local", async () => {
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
    if (!address || typeof address === "string") throw new Error("sin puerto");
    const url = `http://127.0.0.1:${address.port}/hook`;
    try {
      const deliver = async (notice: Parameters<typeof postNotice>[1]) => {
        await postNotice(url, notice, "Bearer aviso");
      };
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
            usage: { type: "ai_credits", amount: 1_500_000_000 },
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
      pull_request: { id: 42 },
      branch: { head_ref: "copilot/demo", base_ref: "main" },
      error: null,
      usage: { type: "ai_credits", amount: 1_500_000_000, amount_human: 1.5 },
      created_at: "2026-11-22T00:00:00Z",
      completed_at: "2026-11-22T00:05:00Z",
    });
  });
});

describe("notificación del sistema", () => {
  it("prepara el aviso de Windows, macOS y Linux sin el token", () => {
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
});
