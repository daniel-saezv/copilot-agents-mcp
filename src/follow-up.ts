import type { NotifyChannel } from "./notify.ts";
import { formatCheckAfterUtc } from "./time-format.ts";

export type FollowUpMode = "push" | "check_later";

export type FollowUpBlock = {
  mode: FollowUpMode;
  channels?: Array<"webhook">;
  check_after: string;
  min_interval_s: number;
  check_with: "list_agent_tasks";
};

export const DEFAULT_FIRST_CHECK_MS = 10 * 60 * 1000;
export const DEFAULT_MIN_INTERVAL_S = 300;

export function followUpMode(
  channels: NotifyChannel[],
  watcherStarted: boolean,
): { mode: FollowUpMode; channels: Array<"webhook">; degraded?: boolean } {
  const webhook = channels.includes("webhook");
  if (webhook && watcherStarted) {
    return { mode: "push", channels: ["webhook"] };
  }
  if (webhook && !watcherStarted) {
    return { mode: "check_later", channels: [], degraded: true };
  }
  return { mode: "check_later", channels: [] };
}

export function followUpBlock(
  channels: NotifyChannel[],
  watcherStarted: boolean,
  now = Date.now(),
): FollowUpBlock {
  const plan = followUpMode(channels, watcherStarted);
  const block: FollowUpBlock = {
    mode: plan.mode,
    check_after: new Date(now + DEFAULT_FIRST_CHECK_MS).toISOString(),
    min_interval_s: DEFAULT_MIN_INTERVAL_S,
    check_with: "list_agent_tasks",
  };
  if (plan.channels.length > 0) block.channels = plan.channels;
  return block;
}

export function createFollowUpNextStep(
  mode: FollowUpMode,
  owner: string | undefined,
  taskId: string,
  watcherDegraded: boolean,
  checkAfterIso: string,
): string {
  if (watcherDegraded && mode === "check_later") {
    return `${checkLaterBase(owner, taskId, checkAfterIso)} The notifier could not start.`;
  }
  if (mode === "push") {
    const ownerHint = owner ? "" : " Pass owner=<your agent name> so your scheduled check sees only your tasks.";
    return `Task queued; cloud tasks usually take 5-30 minutes. End your turn now. Do not wait and do not call get_agent_task in a loop.${ownerHint} A completion notice will be POSTed to the configured endpoint. If you are woken by it, call get_agent_task once for the result.`;
  }
  const schedule = scheduleClause(owner, taskId, checkAfterIso);
  const ownerHint = owner ? "" : " Pass owner=<your agent name> so your scheduled check sees only your tasks.";
  return `Task queued; cloud tasks usually take 5-30 minutes. Nothing will notify you. End your turn now; do not wait or call tools in a loop.${ownerHint} ${schedule} Otherwise tell the user to ask you for the result later.`;
}

function scheduleClause(owner: string | undefined, taskId: string, checkAfterIso: string): string {
  const filter = owner
    ? `list_agent_tasks with owner="${owner}"`
    : `list_agent_tasks with task_ids=["${taskId}"]`;
  return `If you can schedule a later check, first check not before ${formatCheckAfterUtc(checkAfterIso)}; then call ${filter}, repeating no more often than every 5 minutes and stopping when all_terminal is true.`;
}

function checkLaterBase(owner: string | undefined, taskId: string, checkAfterIso: string): string {
  const schedule = scheduleClause(owner, taskId, checkAfterIso);
  return `Task queued; cloud tasks usually take 5-30 minutes. Nothing will notify you. End your turn now; do not wait or call tools in a loop. ${schedule}`;
}