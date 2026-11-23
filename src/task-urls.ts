import type { TrackedTask } from "./state.ts";

export function githubPageUrl(url: string | null | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    if (parsed.pathname.toLowerCase().startsWith("/api/")) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function resolveTaskPageUrl(input: { html_url?: string | null; url?: string | null }): string | undefined {
  return githubPageUrl(input.html_url) ?? githubPageUrl(input.url);
}

export function sessionUrl(task: Pick<TrackedTask, "html_url" | "task_id">): string | undefined {
  return githubPageUrl(task.html_url);
}

export function prUrl(task: Pick<TrackedTask, "pull_request">): string | undefined {
  const url = task.pull_request?.html_url;
  return githubPageUrl(url);
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