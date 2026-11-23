import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { webhookPayloadId } from "./delivery.ts";
import { mapRawState } from "./task-status.ts";
import type { TaskNotice } from "./state.ts";

export const NOTIFY_URL_ENV = "COPILOT_AGENTS_NOTIFY_URL";
export const NOTIFY_AUTHORIZATION_ENV = "COPILOT_AGENTS_NOTIFY_AUTHORIZATION";

export type NotifyChannel = "webhook";

export type DeliveredNotice = {
  channels: NotifyChannel[];
};

export function activeNotificationChannels(_platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): NotifyChannel[] {
  return baseEnv[NOTIFY_URL_ENV]?.trim() ? ["webhook"] : [];
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
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const mapped = mapRawState(notice.state);
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...notice, status: mapped.status, terminal: mapped.terminal, id: webhookPayloadId(notice.task_id, notice.state) }),
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