import type { TrackedTask } from "./state.ts";
import { githubPageUrl } from "./task-urls.ts";

export type TaskStatusName = "working" | "needs_input" | "completed" | "failed" | "cancelled";

export type MappedStatus = {
  status: TaskStatusName;
  terminal: boolean;
};

export const DOCUMENTED_TASK_STATES = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "idle",
  "waiting_for_user",
  "timed_out",
  "cancelled",
] as const;

const RAW_TO_STATUS: Record<(typeof DOCUMENTED_TASK_STATES)[number], MappedStatus> = {
  queued: { status: "working", terminal: false },
  in_progress: { status: "working", terminal: false },
  completed: { status: "completed", terminal: true },
  failed: { status: "failed", terminal: true },
  idle: { status: "completed", terminal: true },
  waiting_for_user: { status: "needs_input", terminal: false },
  timed_out: { status: "failed", terminal: true },
  cancelled: { status: "cancelled", terminal: true },
};

export function isKnownRawState(rawState: string): boolean {
  const normalized = rawState.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RAW_TO_STATUS, normalized);
}

export function mapRawState(rawState: string): MappedStatus {
  const normalized = rawState.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(RAW_TO_STATUS, normalized)) {
    return RAW_TO_STATUS[normalized as keyof typeof RAW_TO_STATUS];
  }
  return { status: "failed", terminal: true };
}

export function unknownStateWarning(rawState: string): string | undefined {
  if (isKnownRawState(rawState)) return undefined;
  return `Unknown GitHub task state "${sanitizeLine(rawState, 80)}"; treated as failed.`;
}

export function isMappedTerminal(status: TaskStatusName): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function sanitizeLine(text: string, maxLen: number): string {
  const stripped = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (stripped.length <= maxLen) return stripped;
  return `${stripped.slice(0, maxLen - 1)}…`;
}

export function durationLabel(task: Pick<TrackedTask, "created_at" | "completed_at" | "updated_at">, now = Date.now()): string {
  const start = Date.parse(task.created_at ?? task.updated_at ?? "");
  const end = Date.parse(task.completed_at ?? task.updated_at ?? "");
  const startMs = Number.isFinite(start) ? start : now;
  const endMs = Number.isFinite(end) ? end : now;
  const minutes = Math.max(1, Math.round(Math.abs(endMs - startMs) / 60_000));
  return `${minutes}m`;
}

export type SummaryContext = {
  checkAfter?: string;
};

export function buildSummary(task: TrackedTask, context: SummaryContext = {}): string {
  const mapped = mapRawState(task.state);
  const dur = durationLabel(task);
  if (mapped.status === "working") {
    if (context.checkAfter) return `Working for ${dur}. Check again after ${context.checkAfter}.`;
    return `Working for ${dur}.`;
  }
  if (mapped.status === "needs_input") {
    const line = task.error ? sanitizeLine(task.error, 120) : "agent";
    return `Waiting for input: ${line}.`;
  }
  if (mapped.status === "completed") {
    const pr = task.pull_request;
    if (pr?.number !== null && pr?.number !== undefined) {
      const prTitle = resolvePullTitle(task);
      if (prTitle) return `Completed in ${dur}: opened PR #${pr.number} '${sanitizeLine(prTitle, 60)}'.`;
      return `Completed in ${dur}: opened PR #${pr.number}.`;
    }
    if (pr && pr.number === null) {
      return `Completed in ${dur}: opened a pull request (number not resolved yet).`;
    }
    const head = task.branch?.head_ref;
    if (head) return `Completed in ${dur} on branch ${sanitizeLine(head, 40)}.`;
    return `Completed in ${dur}; no changes.`;
  }
  if (mapped.status === "failed") {
    if (!isKnownRawState(task.state)) {
      return `Failed: unknown state ${sanitizeLine(task.state, 80)}.`;
    }
    if (task.state === "timed_out") return `Failed: timed out after ${dur}.`;
    const line = task.error ? sanitizeLine(task.error, 100) : "unknown error";
    return `Failed after ${dur}: ${line}.`;
  }
  return `Cancelled after ${dur}.`;
}

function resolvePullTitle(task: TrackedTask): string | null {
  return task.pr_title ?? null;
}

export function pullRequestView(task: TrackedTask): { number?: number; url?: string; id?: number } | undefined {
  const pr = task.pull_request;
  if (!pr) return undefined;
  const page = pr.html_url ? githubPageUrl(pr.html_url) : undefined;
  if (pr.number !== null && page) return { number: pr.number, url: page };
  if (pr.number !== null) return { number: pr.number };
  return { id: pr.id };
}