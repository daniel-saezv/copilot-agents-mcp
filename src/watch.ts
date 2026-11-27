import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GitHubClient } from "./github.ts";
import { failureMessage } from "./errors.ts";
import { appendWatcherLog, notificationChannelsForTask, type DeliveredNotice, type NotifyChannel } from "./notify.ts";
import { shouldSpawnWatcher } from "./delivery.ts";
import { acquireDirectoryLock, releaseDirectoryLock } from "./dir-lock.ts";
import { awaitingSteer, fillPullRequest, headRefOf, isFinalState, observe, presentUsage, readState, toDeliveryNotice, withStateLock, type TaskNotice, type TrackedTask } from "./state.ts";

export async function runWatcher(options: {
  client: Pick<GitHubClient, "getTask" | "findPullRequest">;
  statePath: string;
  deliver: (notice: TaskNotice, task: TrackedTask) => Promise<DeliveredNotice>;
  intervalMs: number;
  maxCycles?: number;
  sleep?: (ms: number) => Promise<void>;
  channels?: NotifyChannel[];
}): Promise<void> {
  const sleep = options.sleep ?? delay;
  let cycles = 0;
  for (;;) {
    await refreshPending(options);
    await notifyFinal(options, options.channels);
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

async function notifyFinal(
  options: {
    client: Pick<GitHubClient, "getTask" | "findPullRequest">;
    statePath: string;
    deliver: (notice: TaskNotice, task: TrackedTask) => Promise<DeliveredNotice>;
  },
  channelOverride?: NotifyChannel[],
): Promise<void> {
  const ready = await withStateLock(options.statePath, (state) => {
    return Object.values(state.tasks)
      .filter((task) => readyToNotify(task) && shouldSpawnWatcher(channelOverride ?? notificationChannelsForTask(task, state)))
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
    let headRef = tracked.branch?.head_ref;
    if (tracked.pull_request && tracked.pull_request.number === null && !headRef) {
      const slash = tracked.repo.indexOf("/");
      const owner = slash > 0 ? tracked.repo.slice(0, slash) : undefined;
      const repo = slash > 0 ? tracked.repo.slice(slash + 1) : undefined;
      try {
        const remote = await options.client.getTask({ taskId, owner, repo });
        headRef = headRefOf(remote, tracked);
      } catch {
        // Fall through to fillPullRequest, which logs the missing head_ref.
      }
    }
    await fillPullRequest(tracked, (input) => options.client.findPullRequest(input), (line) => appendWatcherLog(line), headRef);
    const claimed = await withStateLock(options.statePath, (state) => {
      const task = state.tasks[taskId];
      if (!task || !readyToNotify(task)) return null;
      task.pull_request = tracked.pull_request;
      task.usage = tracked.usage;
      return { notice: toDeliveryNotice(task), task, channels: channelOverride ?? notificationChannelsForTask(task, state) };
    });
    if (!claimed) continue;
    let delivered: DeliveredNotice;
    try {
      delivered = await options.deliver(claimed.notice, claimed.task);
    } catch (error) {
      console.error(`Could not notify for task ${taskId}: ${failureMessage(error)}`);
      delivered = { channels: [] };
    }
    if (delivered.channels.length === 0) {
      const configured = claimed.channels;
      const reason = configured.length === 0
        ? "no notification channels configured"
        : `all configured channels failed (${configured.join(", ")})`;
      const line = `Notification delivery failed for task ${taskId}: ${reason}`;
      await appendWatcherLog(line);
      await withStateLock(options.statePath, (state) => {
        const task = state.tasks[taskId];
        if (!task || !readyToNotify(task)) return;
        task.delivery_record = { status: "failed", reason };
      });
      continue;
    }
    await withStateLock(options.statePath, (state) => {
      const task = state.tasks[taskId];
      if (!task || !readyToNotify(task)) return;
      task.delivery_record = { status: "delivered", delivered_via: delivered.channels.join(",") };
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
  if (task.delivery_record?.status === "failed") return false;
  if (!isFinalState(task.state)) return false;
  if (task.steer && task.steer.notified !== true) return task.steer.turn_seen;
  return !task.notified_at;
}

async function hasPending(statePath: string): Promise<boolean> {
  const state = await readState(statePath);
  return Object.values(state.tasks).some((task) => !isFinalState(task.state) || steerPending(task) || (shouldSpawnWatcher(notificationChannelsForTask(task, state)) && readyToNotify(task)));
}

function steerPending(task: TrackedTask): boolean {
  return awaitingSteer(task);
}

export function watcherLockPath(statePath: string): string {
  return `${statePath}.watcher`;
}

const heldWatchers = new Map<string, string>();

export async function acquireWatcher(lockDir: string): Promise<boolean> {
  const held = await acquireDirectoryLock(lockDir, { timeoutMs: 2_000, pollMs: 100 });
  if (!held) return false;
  heldWatchers.set(lockDir, held.owner);
  return true;
}

export async function releaseWatcher(lockDir: string): Promise<void> {
  const owner = heldWatchers.get(lockDir);
  if (!owner) return;
  await releaseDirectoryLock(lockDir, owner);
  heldWatchers.delete(lockDir);
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
