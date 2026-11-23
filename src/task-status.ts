import type { TrackedTask } from "./state.ts";
import { appendUrlHints, prUrl, sessionUrl } from "./task-urls.ts";

export type TaskStatusName = "working" | "needs_input" | "completed" | "failed" | "cancelled";

export type MappedStatus = {
  status: TaskStatusName;
  terminal: boolean;
};

const RAW_TO_STATUS: Record<string, MappedStatus> = {
  queued: { status: "working", terminal: false },
  working: { status: "working", terminal: false },
  running: { status: "working", terminal: false },
  in_progress: { status: "working", terminal: false },
  needs_input: { status: "needs_input", terminal: false },
  completed: { status: "completed", terminal: true },
  idle: { status: "completed", terminal: true },
  failed: { status: "failed", terminal: true },
  timed_out: { status: "failed", terminal: true },
  cancelled: { status: "cancelled", terminal: true },
};

export function isKnownRawState(rawState: string): boolean {
  return Object.prototype.hasOwnProperty.call(RAW_TO_STATUS, rawState.trim().toLowerCase());
}

export function mapRawState(rawState: string): MappedStatus {
  const normalized = rawState.trim().toLowerCase();
  return RAW_TO_STATUS[normalized] ?? { status: "failed", terminal: true };
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
  checkAfterLocal?: string;
};

export function buildSummary(task: TrackedTask, context: SummaryContext = {}): string {
  const mapped = mapRawState(task.state);
  const dur = durationLabel(task);
  const session = sessionUrl(task);
  const prLink = prUrl(task);
  const withHints = (base: string) => appendUrlHints(base, session, prLink);
  if (mapped.status === "working") {
    if (context.checkAfterLocal) return withHints(`Working for ${dur}. Check again after ${context.checkAfterLocal}.`);
    return withHints(`Working for ${dur}.`);
  }
  if (mapped.status === "needs_input") {
    const line = task.error ? sanitizeLine(task.error, 120) : "agent";
    return withHints(`Waiting for input: ${line}.`);
  }
  if (mapped.status === "completed") {
    const pr = task.pull_request;
    if (pr?.number !== null && pr?.number !== undefined) {
      const prTitle = resolvePullTitle(task);
      if (prTitle) return withHints(`Completed in ${dur}: opened PR #${pr.number} '${sanitizeLine(prTitle, 60)}'.`);
      return withHints(`Completed in ${dur}: opened PR #${pr.number}.`);
    }
    if (pr && pr.number === null) {
      return withHints(`Completed in ${dur}: opened a pull request (number not resolved yet).`);
    }
    const head = task.branch?.head_ref;
    if (head) return withHints(`Completed in ${dur} on branch ${sanitizeLine(head, 40)}.`);
    return withHints(`Completed in ${dur}; no changes.`);
  }
  if (mapped.status === "failed") {
    if (!isKnownRawState(task.state)) {
      return withHints(`Failed: unknown state ${sanitizeLine(task.state, 80)}.`);
    }
    if (task.state === "timed_out") return withHints(`Failed: timed out after ${dur}.`);
    const line = task.error ? sanitizeLine(task.error, 100) : "unknown error";
    return withHints(`Failed after ${dur}: ${line}.`);
  }
  return withHints(`Cancelled after ${dur}.`);
}

function resolvePullTitle(task: TrackedTask): string | null {
  return task.pr_title ?? null;
}

export function pullRequestView(task: TrackedTask): { number?: number; url?: string; id?: number } | undefined {
  const pr = task.pull_request;
  if (!pr) return undefined;
  if (pr.number !== null && pr.html_url) return { number: pr.number, url: pr.html_url };
  if (pr.number !== null) return { number: pr.number };
  return { id: pr.id };
}