import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readState, toDeliveryNotice, type StateFile, type TaskNotice, type TrackedTask } from "./state.ts";
import { ownerWebhook } from "./webhooks.ts";
import { postOwnerNotice, webhookPost } from "./webhook-http.ts";

export const NOTIFY_URL_ENV = "COPILOT_AGENTS_NOTIFY_URL";
export const NOTIFY_AUTHORIZATION_ENV = "COPILOT_AGENTS_NOTIFY_AUTHORIZATION";

export type NotifyChannel = "webhook";

export type DeliveredNotice = {
  channels: NotifyChannel[];
};

export function activeNotificationChannels(_platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): NotifyChannel[] {
  return baseEnv[NOTIFY_URL_ENV]?.trim() ? ["webhook"] : [];
}

export function notificationChannelsForTask(task: TrackedTask, state: StateFile, env: NodeJS.ProcessEnv = process.env): NotifyChannel[] {
  if (task.owner && state.completion_prefs?.[task.owner]?.strategy === "check_later") return [];
  return ownerWebhook(state, task) ? ["webhook"] : activeNotificationChannels(process.platform, env);
}

export async function deliverTaskNotice(
  task: TrackedTask,
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  ownerPost: typeof postOwnerNotice = postOwnerNotice,
): Promise<DeliveredNotice> {
  const state = await readState(statePath);
  if (task.owner && state.completion_prefs?.[task.owner]?.strategy === "check_later") return { channels: [] };
  const registration = ownerWebhook(state, task);
  if (!registration) return deliverNotice(toDeliveryNotice(task), env, fetchImpl);
  try {
    const authorization = await readFile(registration.keyFilePath, "utf8");
    await ownerPost(registration.url, toDeliveryNotice(task), authorization, env);
    return { channels: ["webhook"] };
  } catch {
    await appendWatcherLog("Could not POST the owner task notification.", env);
    return { channels: [] };
  }
}

export function createNextStep(channels: NotifyChannel[]): string {
  if (channels.length === 0) {
    return "Task queued. Do not poll. End your turn; no notification channel is configured (set COPILOT_AGENTS_NOTIFY_URL). Call get_agent_task once later.";
  }
  return "Task queued. Do not poll. End your turn; you will be notified via webhook when the task finishes. Call get_agent_task once later.";
}

export async function appendWatcherLog(line: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const logPath = env.COPILOT_AGENTS_LOG?.trim();
  if (!logPath) {
    console.error(line);
    return;
  }
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${line}\n`, "utf8");
  } catch {
    console.error(line);
  }
}

export async function postNotice(url: string, notice: TaskNotice, authorization: string | undefined, fetchImpl: typeof fetch = fetch): Promise<void> {
  const { body, headers } = webhookPost(notice, authorization);
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Notification POST returned HTTP ${response.status}.`);
}

export async function deliverNotice(
  notice: TaskNotice,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveredNotice> {
  const channels: NotifyChannel[] = [];
  const url = env[NOTIFY_URL_ENV]?.trim();
  if (url) {
    try {
      await postNotice(url, notice, env[NOTIFY_AUTHORIZATION_ENV]?.trim() || undefined, fetchImpl);
      channels.push("webhook");
    } catch (error) {
      const message = error instanceof Error ? error.message : "webhook delivery failed";
      await appendWatcherLog(`Could not POST the task notification: ${message}`, env);
    }
  }
  return { channels };
}