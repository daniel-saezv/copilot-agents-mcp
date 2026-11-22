import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentTask } from "./github.ts";
import { isModelUnavailable, modelUnavailableMessage } from "./errors.ts";

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

export type TrackedTask = {
  task_id: string;
  repo: string;
  requested_model: string | null;
  state: string;
  resolved_model: string | null;
  pull_request: { id: number } | null;
  branch: { head_ref: string; base_ref: string } | null;
  artifacts: TrackedArtifact[];
  error: string | null;
  usage: Usage | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  notified_at: string | null;
};

export type Catalog = { accepted: string[]; rejected: string[] };

export type StateFile = {
  tasks: Record<string, TrackedTask>;
  models: Catalog;
};

export type TaskNotice = {
  task_id: string;
  repo: string;
  state: string;
  requested_model: string | null;
  resolved_model: string | null;
  pull_request: { id: number } | null;
  branch: { head_ref: string; base_ref: string } | null;
  artifacts: TrackedArtifact[];
  error: string | null;
  usage: Usage | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
};

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

export function toNotice(task: TrackedTask): TaskNotice {
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
  };
}

export function presentUsage(usage: { type?: string; amount?: number } | undefined): Usage | null {
  if (!usage || (usage.type !== "ai_credits" && usage.type !== "premium_requests") || typeof usage.amount !== "number") {
    return null;
  }
  if (usage.type === "ai_credits") {
    return { type: usage.type, amount: usage.amount, amount_human: Math.round((usage.amount / 1_000_000_000) * 10) / 10 };
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
    error = `${modelUnavailableMessage(context.requestedModel, state.models.accepted)} Detalle: ${unavailable}`;
  }
  const latestModel = [...sessions].reverse().find((session) => typeof session.model === "string" && session.model.trim());
  const latestUsage = [...sessions].reverse().find((session) => session.usage);
  const artifacts = mapArtifacts(task.artifacts);
  const pull = artifacts.find((artifact) => artifact.type === "pull");
  const branch = artifacts.find((artifact) => artifact.type === "branch");
  const completed = [...sessions].reverse().find((session) => session.completed_at);
  const existing = state.tasks[task.id];
  const tracked: TrackedTask = {
    task_id: task.id,
    repo: context.repo || existing?.repo || "",
    requested_model: context.requestedModel ?? existing?.requested_model ?? null,
    state: task.state,
    resolved_model: latestModel?.model ?? null,
    pull_request: pull?.type === "pull" ? { id: pull.id } : null,
    branch: branch?.type === "branch" ? { head_ref: branch.head_ref, base_ref: branch.base_ref } : null,
    artifacts,
    error,
    usage: presentUsage(latestUsage?.usage),
    created_at: task.created_at ?? null,
    updated_at: task.updated_at ?? null,
    completed_at: completed?.completed_at ?? null,
    notified_at: existing?.notified_at ?? null,
  };
  state.tasks[task.id] = tracked;
  return tracked;
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

export async function withStateLock<T>(statePath: string, fn: (state: StateFile) => Promise<T> | T): Promise<T> {
  const lock = `${statePath}.lock`;
  await acquire(lock);
  try {
    const state = await readState(statePath);
    const result = await fn(state);
    await writeState(statePath, state);
    return result;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
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
    throw new Error("El estado local no es JSON válido.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("El estado local no es válido.");
  const record = parsed as Record<string, unknown>;
  if (!record.tasks || typeof record.tasks !== "object" || !record.models || typeof record.models !== "object") {
    throw new Error("El estado local no es válido.");
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

async function acquire(lock: string): Promise<void> {
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
      if (Date.now() - started > 10_000) throw new Error("No se pudo guardar el estado local: el archivo está en uso.");
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
