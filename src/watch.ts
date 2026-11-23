import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitHubClient } from "./github.ts";
import { failureMessage } from "./errors.ts";
import { activeNotificationChannels, appendWatcherLog, type DeliveredNotice } from "./notify.ts";
import { awaitingSteer, fillPullRequest, isFinalState, observe, presentUsage, readState, toDeliveryNotice, withStateLock, type TaskNotice, type TrackedTask } from "./state.ts";

export async function runWatcher(options: {
  client: Pick<GitHubClient, "getTask" | "findPullRequest">;
  statePath: string;
  deliver: (notice: TaskNotice) => Promise<DeliveredNotice>;
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
      .filter((task) => shouldPoll(task))
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
      console.error(`Could not read task ${task.taskId}: ${failureMessage(error)}`);
    }
  }
}

async function notifyFinal(options: {
  client: Pick<GitHubClient, "findPullRequest">;
  statePath: string;
  deliver: (notice: TaskNotice) => Promise<DeliveredNotice>;
}): Promise<void> {
  const ready = await withStateLock(options.statePath, (state) => {
    return Object.values(state.tasks)
      .filter((task) => readyToNotify(task))
      .map((task) => task.task_id);
  });
  for (const taskId of ready) {
    const tracked = await withStateLock(options.statePath, (state) => {
      const task = state.tasks[taskId];
      if (!task || !readyToNotify(task)) return null;
      refreshUsage(task);
      return task;
    });
    if (!tracked) continue;
    await fillPullRequest(tracked, (input) => options.client.findPullRequest(input), (line) => appendWatcherLog(line));
    const claimed = await withStateLock(options.statePath, (state) => {
      const task = state.tasks[taskId];
      if (!task || !readyToNotify(task)) return null;
      task.pull_request = tracked.pull_request;
      task.usage = tracked.usage;
      return { notice: toDeliveryNotice(task) };
    });
    if (!claimed) continue;
    let delivered: DeliveredNotice;
    try {
      delivered = await options.deliver(claimed.notice);
    } catch (error) {
      console.error(`Could not notify for task ${taskId}: ${failureMessage(error)}`);
      delivered = { channels: [] };
    }
    if (delivered.channels.length === 0) {
      const configured = activeNotificationChannels(process.platform, process.env);
      const reason = configured.length === 0
        ? "no notification channels configured"
        : `all configured channels failed (${configured.join(", ")})`;
      const line = `Notification delivery failed for task ${taskId}: ${reason}`;
      await appendWatcherLog(line);
      await withStateLock(options.statePath, (state) => {
        const task = state.tasks[taskId];
        if (!task || !readyToNotify(task)) return;
        task.delivery = { status: "failed", reason };
      });
      continue;
    }
    await withStateLock(options.statePath, (state) => {
      const task = state.tasks[taskId];
      if (!task || !readyToNotify(task)) return;
      task.delivery = null;
      if (task.steer?.turn_seen) task.steer = { ...task.steer, notified: true };
      task.notified_at = new Date().toISOString();
    });
  }
}

function shouldPoll(task: TrackedTask): boolean {
  if (!isFinalState(task.state)) return true;
  return Boolean(task.steer && !task.steer.turn_seen);
}

function readyToNotify(task: TrackedTask): boolean {
  if (task.delivery?.status === "failed") return false;
  if (!isFinalState(task.state)) return false;
  if (task.steer && task.steer.notified !== true) return task.steer.turn_seen;
  return !task.notified_at;
}

async function hasPending(statePath: string): Promise<boolean> {
  const state = await readState(statePath);
  return Object.values(state.tasks).some((task) => !isFinalState(task.state) || awaitingSteer(task) || readyToNotify(task));
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
  const entry = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "watch"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", stderr],
    env,
  });
  if (typeof stderr === "number") closeSync(stderr);
  child.unref();
}

function refreshUsage(task: TrackedTask): void {
  if (!task.usage) return;
  const next = presentUsage(task.usage);
  if (next) task.usage = next;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
