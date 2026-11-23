import type { NotifyChannel } from "./notify.ts";
import { deliveryForTask } from "./delivery.ts";
import { buildSummary, mapRawState, pullRequestView } from "./task-status.ts";
import type { TrackedTask, Usage } from "./state.ts";
import { formatCheckAfterLocal } from "./tasks.ts";

const ERROR_VERBOSE_MAX = 2048;

export function truncateError(error: string | null): string | undefined {
  if (!error) return undefined;
  if (error.length <= ERROR_VERBOSE_MAX) return error;
  return `${error.slice(0, ERROR_VERBOSE_MAX - 1)}…`;
}

export function compactGetTask(
  task: TrackedTask,
  channels: NotifyChannel[],
  options?: { cached?: boolean; verbose?: boolean; checkAfter?: string },
): Record<string, unknown> {
  const mapped = mapRawState(task.state);
  const delivery = deliveryForTask(task, channels);
  const checkLocal = options?.checkAfter ? formatCheckAfterLocal(options.checkAfter) : undefined;
  const summary = buildSummary(task, { checkAfterLocal: checkLocal });
  const body: Record<string, unknown> = {
    task_id: task.task_id,
    repo: task.repo,
    status: mapped.status,
    terminal: mapped.terminal,
    summary,
    delivery,
  };
  if (task.owner) body.owner = task.owner;
  const pr = pullRequestView(task);
  if (pr) body.pull_request = pr;
  if (task.completed_at) body.completed_at = task.completed_at;
  if (!mapped.terminal && options?.checkAfter) {
    body.next_step = `Still working (${buildSummary(task).match(/for (\d+m)/)?.[1] ?? "a while"}). End your turn; check again after ${formatCheckAfterLocal(options.checkAfter)}.`;
  } else if (mapped.terminal && mapped.status === "completed" && task.pull_request?.number) {
    body.next_step = `PR #${task.pull_request.number} is open for review.`;
  }
  if (options?.cached) body.cached = true;
  if (options?.verbose) {
    body.state = task.state;
    if (task.requested_model) body.requested_model = task.requested_model;
    if (task.resolved_model) body.resolved_model = task.resolved_model;
    if (task.branch) body.branch = task.branch;
    if (task.artifacts.length > 0) body.artifacts = task.artifacts;
    if (task.usage) body.usage = task.usage;
    if (task.session_id) body.session_id = task.session_id;
    if (task.created_at) body.created_at = task.created_at;
    if (task.updated_at) body.updated_at = task.updated_at;
    const err = truncateError(task.error);
    if (err) body.error = err;
    if (task.delivery_record?.delivered_via) body.delivered_via = task.delivery_record.delivered_via;
  }
  return body;
}

export function usageOrUndefined(usage: Usage | null): Usage | undefined {
  return usage ?? undefined;
}