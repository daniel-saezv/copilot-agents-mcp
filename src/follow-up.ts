import type { NotifyChannel } from "./notify.ts";

export type FollowUpMode = "push" | "user_push" | "check_later";

export type FollowUpBlock = {
  mode: FollowUpMode;
  channels?: Array<"webhook" | "system">;
  check_after: string;
  min_interval_s: number;
  check_with: "list_agent_tasks";
  session_url?: string;
};

export const DEFAULT_FIRST_CHECK_MS = 10 * 60 * 1000;
export const DEFAULT_MIN_INTERVAL_S = 300;

export function agentFacingChannels(channels: NotifyChannel[]): Array<"webhook" | "system"> {
  const out: Array<"webhook" | "system"> = [];
  if (channels.includes("webhook")) out.push("webhook");
  return out;
}

export function followUpMode(
  channels: NotifyChannel[],
  watcherStarted: boolean,
): { mode: FollowUpMode; channels: Array<"webhook" | "system">; degraded?: boolean } {
  const webhook = channels.includes("webhook");
  const system = channels.includes("system");
  const agentChannels = agentFacingChannels(channels);
  if (webhook && watcherStarted) {
    return { mode: "push", channels: agentChannels };
  }
  if (webhook && !watcherStarted) {
    return { mode: "check_later", channels: [], degraded: true };
  }
  if (system && !webhook) {
    return { mode: "user_push", channels: [] };
  }
  return { mode: "check_later", channels: [] };
}

export function followUpBlock(
  channels: NotifyChannel[],
  watcherStarted: boolean,
  now = Date.now(),
  sessionUrl?: string,
): FollowUpBlock {
  const plan = followUpMode(channels, watcherStarted);
  const block: FollowUpBlock = {
    mode: plan.mode,
    check_after: new Date(now + DEFAULT_FIRST_CHECK_MS).toISOString(),
    min_interval_s: DEFAULT_MIN_INTERVAL_S,
    check_with: "list_agent_tasks",
  };
  if (plan.channels.length > 0) block.channels = plan.channels;
  if (sessionUrl) block.session_url = sessionUrl;
  return block;
}

export function createFollowUpNextStep(
  mode: FollowUpMode,
  owner: string | undefined,
  taskId: string,
  watcherDegraded: boolean,
): string {
  if (watcherDegraded && mode === "check_later") {
    return `${checkLaterBase(owner, taskId)} The notifier could not start.`;
  }
  if (mode === "push") {
    return "Task queued; cloud tasks usually take 5-30 minutes. End your turn now. Do not wait and do not call get_agent_task in a loop. A completion notice will be POSTed to the configured endpoint. If you are woken by it, call get_agent_task once for the result.";
  }
  if (mode === "user_push") {
    const schedule = scheduleClause(owner, taskId);
    return `Task queued; cloud tasks usually take 5-30 minutes. End your turn now and do not poll. The user will get a desktop notification when it finishes; you will not. ${schedule} Otherwise tell the user to ask you for the result later.`;
  }
  const schedule = scheduleClause(owner, taskId);
  return `Task queued; cloud tasks usually take 5-30 minutes. Nothing will notify you. End your turn now; do not wait or call tools in a loop. ${schedule} Otherwise tell the user to ask you for the result later.`;
}

function scheduleClause(owner: string | undefined, taskId: string): string {
  const filter = owner
    ? `schedule one for check_after that calls list_agent_tasks with owner="${owner}"`
  : `schedule one for check_after that calls list_agent_tasks with task_ids=["${taskId}"]`;
  return `If you can schedule a later check, ${filter}, repeating no more often than every 5 minutes and stopping when all_terminal is true.`;
}

function checkLaterBase(owner: string | undefined, taskId: string): string {
  const schedule = scheduleClause(owner, taskId);
  return `Task queued; cloud tasks usually take 5-30 minutes. Nothing will notify you. End your turn now; do not wait or call tools in a loop. ${schedule}`;
}