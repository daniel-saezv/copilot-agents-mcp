import type { GitHubClient } from "./github.ts";
import { buildSummary, mapRawState, unknownStateWarning, type MappedStatus } from "./task-status.ts";
import { DEFAULT_MIN_INTERVAL_S } from "./follow-up.ts";
import { formatCheckAfterUtc } from "./time-format.ts";
import { prUrl, sessionUrl } from "./task-urls.ts";
import {
  fillPullRequest,
  headRefOf,
  isFinalState,
  observe,
  type StateFile,
  type TrackedTask,
  withStateLock,
} from "./state.ts";
import { deliveryForTask } from "./delivery.ts";
import type { NotifyChannel } from "./notify.ts";

export const DEFAULT_FRESHNESS_MS = 60_000;
export const LIST_HIDE_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;
export const REGISTRY_PRUNE_TERMINAL_MS = 30 * 24 * 60 * 60 * 1000;
export const OWNER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const LIST_LIMIT_MAX = 50;

export type ListStatusFilter = "pending" | "terminal" | "all";

export type ListAgentTasksInput = {
  owner?: string;
  task_ids?: string[];
  status?: ListStatusFilter;
  repo?: string;
  limit?: number;
  verbose?: boolean;
};

export type ListTaskRow = {
  task_id: string;
  repo: string;
  owner?: string;
  status: MappedStatus["status"];
  terminal: boolean;
  summary: string;
  pr_url?: string;
  session_url?: string;
  updated_at?: string;
  stale?: true;
  cached?: true;
  warning?: string;
};

export function resolveNextCheckAfter(task: TrackedTask, now = Date.now()): string {
  const stored = task.check_after?.trim();
  if (stored) {
    const storedMs = Date.parse(stored);
    if (Number.isFinite(storedMs) && now < storedMs) return stored;
  }
  const lastFetch = Date.parse(task.last_fetched_at ?? "");
  const anchorMs = Number.isFinite(lastFetch)
    ? lastFetch
    : (stored && Number.isFinite(Date.parse(stored)) ? Date.parse(stored) : now);
  return new Date(anchorMs + DEFAULT_MIN_INTERVAL_S * 1000).toISOString();
}

export function aggregateNextCheckAfter(tasks: TrackedTask[], now = Date.now()): string | undefined {
  const pending = tasks.filter((task) => !mapRawState(task.state).terminal);
  if (pending.length === 0) return undefined;
  let latest = 0;
  for (const task of pending) {
    const next = Date.parse(resolveNextCheckAfter(task, now));
    if (Number.isFinite(next) && next > latest) latest = next;
  }
  if (latest > 0) return new Date(latest).toISOString();
  const first = pending[0];
  return first ? resolveNextCheckAfter(first, now) : undefined;
}

export function freshnessMs(): number {
  return DEFAULT_FRESHNESS_MS;
}

export function validateOwner(owner: string): string {
  const trimmed = owner.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new OwnerValidationError("owner must be 1-64 characters.");
  }
  if (!OWNER_PATTERN.test(trimmed)) {
    throw new OwnerValidationError("owner must match [A-Za-z0-9._-].");
  }
  return trimmed;
}

export class OwnerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerValidationError";
  }
}

export function ownerMatches(stored: string | undefined, filter: string): boolean {
  if (!stored) return false;
  return stored.toLowerCase() === filter.toLowerCase();
}

export function pruneRegistry(state: StateFile, now = Date.now()): void {
  const remove = new Set<string>();
  for (const [id, task] of Object.entries(state.tasks)) {
    if (!isFinalState(task.state)) continue;
    const stamp = Date.parse(task.completed_at ?? task.updated_at ?? task.created_at ?? "");
    if (!Number.isFinite(stamp)) continue;
    if (now - stamp > REGISTRY_PRUNE_TERMINAL_MS) remove.add(id);
  }
  if (remove.size === 0) return;
  state.tasks = Object.fromEntries(Object.entries(state.tasks).filter(([id]) => !remove.has(id)));
}

export function listVisible(task: TrackedTask, now = Date.now()): boolean {
  if (!isFinalState(task.state)) return true;
  const stamp = Date.parse(task.completed_at ?? task.updated_at ?? task.created_at ?? "");
  if (!Number.isFinite(stamp)) return true;
  return now - stamp <= LIST_HIDE_TERMINAL_MS;
}

export function filterTasks(state: StateFile, input: ListAgentTasksInput, now = Date.now()): {
  tasks: TrackedTask[];
  matched: TrackedTask[];
  warnings: string[];
  total_matched: number;
} {
  const warnings: string[] = [];
  const status = input.status ?? "all";
  const limit = input.limit ?? 20;
  if (limit > LIST_LIMIT_MAX) {
    throw new OwnerValidationError(`limit must be at most ${LIST_LIMIT_MAX}.`);
  }
  const repoFilter = input.repo?.trim();
  const ownerFilter = input.owner?.trim() ? validateOwner(input.owner.trim()) : undefined;
  const idSet = input.task_ids?.length ? new Set(input.task_ids) : null;

  if (idSet) {
    for (const id of idSet) {
      if (!state.tasks[id]) warnings.push(`unknown task_id: ${id}`);
    }
  }

  let rows = Object.values(state.tasks).filter((task) => listVisible(task, now));
  if (idSet) rows = rows.filter((task) => idSet.has(task.task_id));
  if (ownerFilter) rows = rows.filter((task) => ownerMatches(task.owner, ownerFilter));
  if (repoFilter) rows = rows.filter((task) => task.repo.toLowerCase() === repoFilter.toLowerCase());
  if (status !== "all") {
    rows = rows.filter((task) => {
      const mapped = mapRawState(task.state);
      return status === "terminal" ? mapped.terminal : !mapped.terminal;
    });
  }
  rows.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  return { tasks: rows.slice(0, limit), matched: rows, warnings, total_matched: rows.length };
}

export function listCounts(tasks: TrackedTask[]): { pending_count: number; terminal_count: number; all_terminal: boolean } {
  let pending = 0;
  let terminal = 0;
  for (const task of tasks) {
    if (mapRawState(task.state).terminal) terminal += 1;
    else pending += 1;
  }
  return { pending_count: pending, terminal_count: terminal, all_terminal: pending === 0 };
}

export function listNextStep(
  counts: { pending_count: number; all_terminal: boolean },
  matchedEmpty: boolean,
  registryEmpty: boolean,
  checkAfter?: string,
): string {
  if (registryEmpty) return "No tracked tasks.";
  if (matchedEmpty) return "No tasks match this filter.";
  if (counts.all_terminal) {
    return "No tasks are running. If you scheduled a check for these tasks, delete it now.";
  }
  const n = counts.pending_count;
  const suffix = checkAfter ? ` End your turn; first check not before ${formatCheckAfterUtc(checkAfter)} (not sooner than 5 minutes).` : "";
  return `${n} task${n === 1 ? "" : "s"} still working.${suffix}`;
}

export function toListRow(task: TrackedTask, options?: { stale?: boolean; cached?: boolean; checkAfter?: string }): ListTaskRow {
  const mapped = mapRawState(task.state);
  const row: ListTaskRow = {
    task_id: task.task_id,
    repo: task.repo,
    status: mapped.status,
    terminal: mapped.terminal,
    summary: buildSummary(task, { checkAfter: options?.checkAfter }),
    updated_at: task.updated_at ?? undefined,
  };
  const warning = unknownStateWarning(task.state);
  if (warning) row.warning = warning;
  if (task.owner) row.owner = task.owner;
  const session = sessionUrl(task);
  if (session) row.session_url = session;
  const link = prUrl(task);
  if (link) row.pr_url = link;
  if (options?.stale) row.stale = true;
  if (options?.cached) row.cached = true;
  return row;
}

export function needsFetch(task: TrackedTask, freshness: number, now = Date.now()): boolean {
  if (task.steer && !task.steer.turn_seen) return true;
  if (mapRawState(task.state).terminal) return false;
  const last = Date.parse(task.last_fetched_at ?? "");
  if (!Number.isFinite(last) || now - last >= freshness) return true;
  return false;
}

export async function refreshTasks(
  statePath: string,
  client: GitHubClient,
  taskIds: string[],
  freshness: number,
  log: (line: string) => void | Promise<void>,
): Promise<{ refreshed: Set<string>; failures: Map<string, string> }> {
  const failures = new Map<string, string>();
  const refreshed = new Set<string>();
  const concurrency = 4;
  let index = 0;
  async function worker() {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= taskIds.length) return;
      const taskId = taskIds[current] ?? "";
      const meta = await withStateLock(statePath, (state) => {
        const task = state.tasks[taskId];
        if (!task || !needsFetch(task, freshness)) return null;
        return { repo: task.repo, requestedModel: task.requested_model };
      });
      if (!meta) continue;
      const slash = meta.repo.indexOf("/");
      const owner = slash > 0 ? meta.repo.slice(0, slash) : undefined;
      const repo = slash > 0 ? meta.repo.slice(slash + 1) : undefined;
      try {
        const remote = await client.getTask({ taskId, owner, repo });
        const tracked = await withStateLock(statePath, (state) => {
          const row = observe(state, remote, { repo: meta.repo, requestedModel: meta.requestedModel });
          row.last_fetched_at = new Date().toISOString();
          return row;
        });
        await fillPullRequest(tracked, (input) => client.findPullRequest(input), log, headRefOf(remote, tracked));
        await withStateLock(statePath, (state) => {
          const saved = state.tasks[taskId];
          if (saved) saved.pull_request = tracked.pull_request;
        });
        refreshed.add(taskId);
      } catch (error) {
        failures.set(taskId, error instanceof Error ? error.message : "refresh failed");
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, taskIds.length) }, () => worker()));
  return { refreshed, failures };
}

export function deliveryField(task: TrackedTask, channels: NotifyChannel[]): string {
  return deliveryForTask(task, channels);
}