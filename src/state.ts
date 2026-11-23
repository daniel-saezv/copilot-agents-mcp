import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentSession, AgentTask } from "./github.ts";
import { failureMessage, isModelUnavailable, modelUnavailableMessage } from "./errors.ts";

export const MODEL_PREFIX = "sweagent-capi:";
export const FINAL_STATES = new Set(["completed", "failed", "timed_out", "cancelled", "idle"]);

export type Usage = {
  type: "ai_credits" | "premium_requests";
  amount: number;
  amount_human: number;
};

export type TrackedArtifact =
  | { type: "pull"; id: number }
  | { type: "branch"; head_ref: string; base_ref: string };

export type PullRequestRef = {
  id: number;
  number: number | null;
  html_url: string | null;
};

export type SteerWatch = {
  at: string;
  session_count: number;
  turn_seen: boolean;
  notified: boolean;
};

export type TaskDelivery = {
  status: "failed";
  reason: string;
};

export type TrackedTask = {
  task_id: string;
  repo: string;
  requested_model: string | null;
  state: string;
  resolved_model: string | null;
  pull_request: PullRequestRef | null;
  branch: { head_ref: string; base_ref: string } | null;
  artifacts: TrackedArtifact[];
  error: string | null;
  usage: Usage | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  notified_at: string | null;
  delivery?: TaskDelivery | null;
  session_id?: string | null;
  steer?: SteerWatch | null;
};

export type Catalog = { accepted: string[]; rejected: string[] };

export type StateFile = {
  tasks: Record<string, TrackedTask>;
  models: Catalog;
};

export type TaskStatus = {
  task_id: string;
  repo: string;
  state: string;
  requested_model: string | null;
  resolved_model: string | null;
  pull_request: PullRequestRef | null;
  branch: { head_ref: string; base_ref: string } | null;
  artifacts: TrackedArtifact[];
  error: string | null;
  usage: Usage | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  session_id: string | null;
  notified: boolean;
};

export type TaskNotice = TaskStatus & { session_id: string | null };

export function emptyState(): StateFile {
  return { tasks: {}, models: { accepted: [], rejected: [] } };
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.COPILOT_AGENTS_STATE_PATH ?? join(home, ".copilot-agents-mcp", "state.json");
}

export function normalizeModel(model: string): string {
  return model.startsWith(MODEL_PREFIX) ? model.slice(MODEL_PREFIX.length) : model;
}

export function isFinalState(state: string): boolean {
  return FINAL_STATES.has(state);
}

export function taskSessionCount(task: AgentTask, fallback = 0): number {
  if (typeof task.session_count === "number" && Number.isFinite(task.session_count)) return task.session_count;
  if (task.sessions) return task.sessions.length;
  return fallback;
}

export function armSteer(task: TrackedTask, sessionCount: number, at: string): void {
  task.delivery = null;
  task.steer = { at, session_count: sessionCount, turn_seen: false, notified: false };
}

export function noteSteerTurn(steer: SteerWatch, task: AgentTask): void {
  if (steer.turn_seen) return;
  const count = taskSessionCount(task, steer.session_count);
  if (count > steer.session_count || !isFinalState(task.state)) steer.turn_seen = true;
}

export function awaitingSteer(task: TrackedTask): boolean {
  if (task.delivery?.status === "failed") return false;
  return Boolean(task.steer && task.steer.notified !== true);
}

export function toNotice(task: TrackedTask): TaskStatus {
  return {
    task_id: task.task_id,
    repo: task.repo,
    state: task.state,
    requested_model: task.requested_model,
    resolved_model: task.resolved_model,
    pull_request: task.pull_request,
    branch: task.branch,
    artifacts: task.artifacts,
    error: task.error,
    usage: task.usage,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
    session_id: task.session_id ?? null,
    notified: Boolean(task.notified_at),
  };
}

export function toDeliveryNotice(task: TrackedTask): TaskNotice {
  return { ...toNotice(task), session_id: task.session_id ?? null };
}

export function presentUsage(usage: { type?: string; amount?: number } | undefined): Usage | null {
  if (!usage || (usage.type !== "ai_credits" && usage.type !== "premium_requests") || typeof usage.amount !== "number") {
    return null;
  }
  if (usage.type === "ai_credits") {
    return { type: usage.type, amount: usage.amount, amount_human: usage.amount / 1_000_000_000 };
  }
  return { type: usage.type, amount: usage.amount, amount_human: usage.amount };
}

export function rememberAccepted(state: StateFile, model: string): void {
  state.models.rejected = state.models.rejected.filter((item) => item !== model);
  if (!state.models.accepted.includes(model)) state.models.accepted.push(model);
  state.models.accepted.sort();
  state.models.rejected.sort();
}

export function rememberRejected(state: StateFile, model: string): void {
  state.models.accepted = state.models.accepted.filter((item) => item !== model);
  if (!state.models.rejected.includes(model)) state.models.rejected.push(model);
  state.models.accepted.sort();
  state.models.rejected.sort();
}

export function observe(state: StateFile, task: AgentTask, context: { repo: string; requestedModel: string | null }): TrackedTask {
  const sessions = [...(task.sessions ?? [])].sort((left, right) => (left.created_at ?? "").localeCompare(right.created_at ?? ""));
  for (const session of sessions) {
    if (typeof session.model === "string" && session.model.trim()) rememberAccepted(state, normalizeModel(session.model));
  }
  const messages = sessions.flatMap((session) => (session.error?.message ? [session.error.message] : []));
  const unavailable = messages.find((message) => isModelUnavailable(message));
  let error = messages.at(-1) ?? null;
  if (unavailable && context.requestedModel) {
    rememberRejected(state, normalizeModel(context.requestedModel));
    error = `${modelUnavailableMessage(context.requestedModel, state.models.accepted)} Detail: ${unavailable}`;
  }
  const latestModel = [...sessions].reverse().find((session) => typeof session.model === "string" && session.model.trim());
  const latestUsage = [...sessions].reverse().find((session) => session.usage);
  const artifacts = mapArtifacts(task.artifacts);
  const branch = artifacts.find((artifact) => artifact.type === "branch");
  const completed = [...sessions].reverse().find((session) => session.completed_at);
  const existing = state.tasks[task.id];
  const steer = existing?.steer ? { ...existing.steer } : null;
  if (steer) noteSteerTurn(steer, task);
  const tracked: TrackedTask = {
    task_id: task.id,
    repo: context.repo || existing?.repo || "",
    requested_model: context.requestedModel ?? existing?.requested_model ?? null,
    state: task.state,
    resolved_model: latestModel?.model ?? null,
    pull_request: readPull(task, existing),
    branch: branch?.type === "branch" ? { head_ref: branch.head_ref, base_ref: branch.base_ref } : null,
    artifacts,
    error,
    usage: presentUsage(latestUsage?.usage),
    created_at: task.created_at ?? null,
    updated_at: task.updated_at ?? null,
    completed_at: completed?.completed_at ?? null,
    notified_at: existing?.notified_at ?? null,
    session_id: latestSessionId(sessions) ?? existing?.session_id ?? null,
    steer,
  };
  state.tasks[task.id] = tracked;
  return tracked;
}

export function headRefOf(task: AgentTask, tracked: Pick<TrackedTask, "branch">): string | undefined {
  if (tracked.branch?.head_ref) return tracked.branch.head_ref;
  const sessions = [...(task.sessions ?? [])].reverse();
  for (const session of sessions) {
    if (session.head_ref) return session.head_ref;
  }
  return undefined;
}

export async function fillPullRequest(
  task: TrackedTask,
  lookup: (input: { owner: string; repo: string; id: number; headRef: string }) => Promise<{ number: number; html_url: string } | null>,
  log: (line: string) => void | Promise<void>,
  headRef = task.branch?.head_ref,
): Promise<void> {
  const pull = task.pull_request;
  if (!pull) return;
  if (pull.number == null) pull.number = null;
  if (pull.html_url == null) pull.html_url = null;
  if (pull.number !== null && pull.html_url !== null) return;
  const slash = task.repo.indexOf("/");
  if (slash <= 0 || !headRef) {
    await log(`Could not resolve pull request ${pull.id} for ${task.task_id}: the repository or head_ref is missing.`);
    return;
  }
  try {
    const found = await lookup({
      owner: task.repo.slice(0, slash),
      repo: task.repo.slice(slash + 1),
      id: pull.id,
      headRef,
    });
    if (!found) {
      await log(`Could not resolve pull request ${pull.id} for ${task.task_id}: the list does not contain that ID.`);
      return;
    }
    pull.number = found.number;
    pull.html_url = found.html_url;
  } catch (error) {
    await log(`Could not resolve pull request ${pull.id} for ${task.task_id}: ${failureMessage(error)}`);
  }
}

function latestSessionId(sessions: AgentSession[]): string | null {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const id = sessions[index]?.id;
    if (id) return id;
  }
  return null;
}

function readPull(task: AgentTask, existing: TrackedTask | undefined): PullRequestRef | null {
  for (const artifact of task.artifacts ?? []) {
    if (artifact.type !== "pull" || typeof artifact.data?.id !== "number") continue;
    const number = typeof artifact.data.number === "number" ? artifact.data.number : null;
    const htmlUrl = typeof artifact.data.html_url === "string" && artifact.data.html_url ? artifact.data.html_url : null;
    const previous = existing?.pull_request?.id === artifact.data.id ? existing.pull_request : undefined;
    return {
      id: artifact.data.id,
      number: number ?? previous?.number ?? null,
      html_url: htmlUrl ?? previous?.html_url ?? null,
    };
  }
  return null;
}

function mapArtifacts(artifacts: AgentTask["artifacts"]): TrackedArtifact[] {
  const mapped: TrackedArtifact[] = [];
  for (const artifact of artifacts ?? []) {
    if (artifact.type === "pull" && typeof artifact.data?.id === "number") {
      mapped.push({ type: "pull", id: artifact.data.id });
    } else if (artifact.type === "branch" && artifact.data?.head_ref && artifact.data.base_ref) {
      mapped.push({ type: "branch", head_ref: artifact.data.head_ref, base_ref: artifact.data.base_ref });
    }
  }
  return mapped;
}

export function initialTask(input: {
  id: string;
  repo: string;
  requestedModel: string;
  state: string;
  createdAt: string | null;
  updatedAt: string | null;
}): TrackedTask {
  return {
    task_id: input.id,
    repo: input.repo,
    requested_model: input.requestedModel,
    state: input.state,
    resolved_model: null,
    pull_request: null,
    branch: null,
    artifacts: [],
    error: null,
    usage: null,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    completed_at: null,
    notified_at: null,
  };
}

export async function withDirectoryLock<T>(
  lock: string,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number; busyMessage?: string },
): Promise<T> {
  await acquire(
    lock,
    options?.timeoutMs ?? 10_000,
    options?.busyMessage ?? "Could not save local state: the file is in use.",
  );
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function withStateLock<T>(statePath: string, fn: (state: StateFile) => Promise<T> | T): Promise<T> {
  return withDirectoryLock(`${statePath}.lock`, async () => {
    const state = await readState(statePath);
    const result = await fn(state);
    await writeState(statePath, state);
    return result;
  });
}

export async function readState(statePath: string): Promise<StateFile> {
  try {
    return parseState(await readFile(statePath, "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return emptyState();
    throw error;
  }
}

function parseState(text: string): StateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The local state is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The local state is invalid.");
  const record = parsed as Record<string, unknown>;
  if (!record.tasks || typeof record.tasks !== "object" || !record.models || typeof record.models !== "object") {
    throw new Error("The local state is invalid.");
  }
  return record as StateFile;
}

async function writeState(statePath: string, state: StateFile): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tmp, statePath);
  } catch {
    await rm(statePath, { force: true });
    await rename(tmp, statePath);
  }
}

async function acquire(lock: string, timeoutMs: number, busyMessage: string): Promise<void> {
  await mkdir(dirname(lock), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "pid"), String(process.pid));
      return;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (!(await lockAlive(lock))) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(busyMessage);
      await delay(50);
    }
  }
}

async function lockAlive(lock: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(join(lock, "pid"), "utf8")).trim());
    return Number.isInteger(pid) && processAlive(pid);
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
