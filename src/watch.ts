import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitHubClient } from "./github.ts";
import { failureMessage } from "./errors.ts";
import { isFinalState, observe, readState, toNotice, withStateLock, type TaskNotice } from "./state.ts";

export async function runWatcher(options: {
  client: Pick<GitHubClient, "getTask">;
  statePath: string;
  deliver: (notice: TaskNotice) => Promise<void>;
  intervalMs: number;
  maxCycles?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = options.sleep ?? delay;
  let cycles = 0;
  for (;;) {
    await refreshPending(options);
    await notifyFinal(options);
    if (!(await hasPending(options.statePath))) return;
    cycles += 1;
    if (options.maxCycles !== undefined && cycles >= options.maxCycles) return;
    await sleep(options.intervalMs);
  }
}

async function refreshPending(options: {
  client: Pick<GitHubClient, "getTask">;
  statePath: string;
}): Promise<void> {
  const pending = await withStateLock(options.statePath, (state) => {
    return Object.values(state.tasks)
      .filter((task) => !isFinalState(task.state))
      .map((task) => ({ taskId: task.task_id, repo: task.repo, requestedModel: task.requested_model }));
  });
  for (const task of pending) {
    const slash = task.repo.indexOf("/");
    const owner = slash > 0 ? task.repo.slice(0, slash) : undefined;
    const repo = slash > 0 ? task.repo.slice(slash + 1) : undefined;
    try {
      const remote = await options.client.getTask({ taskId: task.taskId, owner, repo });
      await withStateLock(options.statePath, (state) => {
        observe(state, remote, { repo: task.repo, requestedModel: task.requestedModel });
      });
    } catch (error) {
      console.error(`No se pudo leer la tarea ${task.taskId}: ${failureMessage(error)}`);
    }
  }
}

async function notifyFinal(options: {
  statePath: string;
  deliver: (notice: TaskNotice) => Promise<void>;
}): Promise<void> {
  const ready = await withStateLock(options.statePath, (state) => {
    return Object.values(state.tasks)
      .filter((task) => isFinalState(task.state) && !task.notified_at)
      .map((task) => task.task_id);
  });
  for (const taskId of ready) {
    const notice = await withStateLock(options.statePath, (state) => {
      const task = state.tasks[taskId];
      if (!task || !isFinalState(task.state) || task.notified_at) return null;
      task.notified_at = new Date().toISOString();
      return toNotice(task);
    });
    if (!notice) continue;
    try {
      await options.deliver(notice);
    } catch (error) {
      await withStateLock(options.statePath, (state) => {
        const task = state.tasks[taskId];
        if (task) task.notified_at = null;
      });
      console.error(`No se pudo avisar de la tarea ${taskId}: ${failureMessage(error)}`);
    }
  }
}

async function hasPending(statePath: string): Promise<boolean> {
  const state = await readState(statePath);
  return Object.values(state.tasks).some((task) => !isFinalState(task.state) || !task.notified_at);
}

export function watcherLockPath(statePath: string): string {
  return `${statePath}.watcher`;
}

export async function acquireWatcher(lockDir: string): Promise<boolean> {
  await mkdir(dirname(lockDir), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, "pid"), String(process.pid));
      return true;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (!(await watcherAlive(lockDir))) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 2_000) return false;
      await delay(100);
    }
  }
}

export async function releaseWatcher(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true });
}

async function watcherAlive(lockDir: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(join(lockDir, "pid"), "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isCode(error, "EPERM");
    }
  } catch {
    return false;
  }
}

export function startDetachedWatcher(env: NodeJS.ProcessEnv = process.env): void {
  const logPath = env.COPILOT_AGENTS_LOG;
  const stderr = logPath ? openSync(logPath, "a") : "ignore";
  const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.ts", import.meta.url)), "watch"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", stderr],
    env,
  });
  if (typeof stderr === "number") closeSync(stderr);
  child.unref();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
