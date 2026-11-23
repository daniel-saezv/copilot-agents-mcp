import type { NotifyChannel } from "./notify.ts";
import { deliveryForTask } from "./delivery.ts";
import { buildSummary, durationLabel, mapRawState, pullRequestView, unknownStateWarning } from "./task-status.ts";
import type { TrackedTask, Usage } from "./state.ts";
import { formatCheckAfterUtc } from "./time-format.ts";
import { prUrl, sessionUrl } from "./task-urls.ts";

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
  const summary = buildSummary(task, { checkAfter: options?.checkAfter });
  const body: Record<string, unknown> = {
    task_id: task.task_id,
    repo: task.repo,
    status: mapped.status,
    terminal: mapped.terminal,
    summary,
    delivery,
  };
  const warning = unknownStateWarning(task.state);
  if (warning) body.warning = warning;
  if (task.owner) body.owner = task.owner;
  const session = sessionUrl(task);
  if (session) body.session_url = session;
  const prLink = prUrl(task);
  if (prLink) body.pr_url = prLink;
  const pr = pullRequestView(task);
  if (pr && options?.verbose) body.pull_request = pr;
  if (task.completed_at) body.completed_at = task.completed_at;
  if (!mapped.terminal && options?.checkAfter) {
    const dur = durationLabel(task);
    body.next_step = `Still working (${dur}). End your turn; first check not before ${formatCheckAfterUtc(options.checkAfter)}.`;
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