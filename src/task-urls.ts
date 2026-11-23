import type { TrackedTask } from "./state.ts";

export function sessionUrl(task: Pick<TrackedTask, "html_url" | "task_id">): string | undefined {
  const url = task.html_url?.trim();
  if (url) return url;
  return undefined;
}

export function prUrl(task: Pick<TrackedTask, "pull_request">): string | undefined {
  const url = task.pull_request?.html_url?.trim();
  if (url) return url;
  return undefined;
}

export function appendUrlHints(summary: string, session?: string, pr?: string): string {
  const hints: string[] = [];
  if (session) hints.push(`Session: ${session}`);
  if (pr) hints.push(`PR: ${pr}`);
  if (hints.length === 0) return summary;
  const suffix = ` ${hints.join(" ")}`;
  const next = `${summary.replace(/\.\s*$/, "")}.${suffix}`;
  return next.length <= 160 ? next : summary;
}