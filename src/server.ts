import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CodedToolFailure,
  failureMessage,
  failureToError,
  modelUnavailableMessage,
  NO_SESSION_MESSAGE,
  TASK_HAS_NO_PULL_REQUEST,
  TASK_PULL_REQUEST_NOT_OPEN,
  toolError,
  toolJson,
  ToolFailure,
} from "./errors.ts";
import type { AgentTask, GitHubClient, TaskEvent } from "./github.ts";
import { sweModelsResultSchema, type SweModelsResult } from "./swe-models.ts";
import { selectToolNames, TOOLS, type Selection } from "./selection.ts";
import { shouldSpawnWatcher } from "./delivery.ts";
import { createFollowUpNextStep, followUpBlock } from "./follow-up.ts";
import { activeNotificationChannels, appendWatcherLog } from "./notify.ts";
import { compactGetTask } from "./task-present.ts";
import { mapRawState } from "./task-status.ts";
import {
  filterTasks,
  formatCheckAfterLocal,
  freshnessMs,
  listCounts,
  listNextStep,
  needsFetch,
  OwnerValidationError,
  pruneRegistry,
  refreshTasks,
  toListRow,
  validateOwner,
} from "./tasks.ts";
import {
  armSteer,
  fillPullRequest,
  headRefOf,
  initialTask,
  isFinalState,
  normalizeModel,
  observe,
  taskSessionCount,
  withStateLock,
  type TrackedTask,
} from "./state.ts";
import { startDetachedWatcher } from "./watch.ts";

export function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error("package.json has no version.");
  }
  return parsed.version;
}

export type ServerDeps = {
  clientForToken: (token: string) => GitHubClient;
  statePath: string;
  readToken: () => string | null;
  readModels: () => Promise<SweModelsResult>;
  launchWatcher: () => void;
};

const OWNER_FIELD = "Stable name of the agent or bot launching the task (e.g. your own name). Several agents may share this server; pass the same owner every time and filter list_agent_tasks by it.";

const createInput = z.object({
  repo: z.string().describe("Repository in owner/name form."),
  prompt: z.string().describe("Instructions for the agent."),
  model: z.string().describe("Model sent unchanged to the API without a closed allowlist."),
  base_ref: z.string().optional().describe("Base branch for a new branch or pull request."),
  head_ref: z.string().optional().describe("Existing branch. With base_ref, the agent commits to this branch."),
  custom_agent: z.string().optional().describe("Custom agent name without the extension."),
  create_pull_request: z.boolean().optional().describe("When true, the API creates a pull request."),
  owner: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional().describe(OWNER_FIELD),
}).strict();

const followUpSchema = z.object({
  mode: z.enum(["push", "user_push", "check_later"]),
  channels: z.array(z.enum(["webhook", "system"])).optional(),
  check_after: z.string(),
  min_interval_s: z.number(),
  check_with: z.literal("list_agent_tasks"),
  session_url: z.string().optional(),
}).strict();

const createOutput = z.object({
  task_id: z.string(),
  repo: z.string(),
  owner: z.string().optional(),
  status: z.enum(["working", "needs_input", "completed", "failed", "cancelled"]),
  terminal: z.boolean(),
  requested_model: z.string(),
  session_url: z.string().optional(),
  follow_up: followUpSchema,
  next_step: z.string(),
}).strict();

const SERVER_INSTRUCTIONS = [
  "Copilot cloud tasks take minutes. Tools never wait.",
  "Pass a stable owner (your own name) to create_agent_task.",
  "After creating, end your turn and follow next_step.",
  "To check progress, call list_agent_tasks with your owner, once, no more often than every 5 minutes; stop checking when all_terminal is true.",
  "Call get_agent_task for one task's full result.",
].join(" ");

const CREATE_TASK_GUIDANCE =
  "Returns immediately with task_id. The task keeps running in the cloud for minutes; the task_id stays valid while GitHub keeps the task. Follow next_step.";

const getInput = z.object({
  task_id: z.string().describe("Task identifier."),
  repo: z.string().optional().describe("Repository in owner/name form. If omitted, use the saved repository or user endpoint."),
  verbose: z.boolean().optional().describe("Include raw state, models, usage, and full error."),
}).strict();

const listInput = z.object({
  owner: z.string().optional().describe(OWNER_FIELD),
  task_ids: z.array(z.string()).max(50).optional(),
  status: z.enum(["pending", "terminal", "all"]).optional(),
  repo: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
  verbose: z.boolean().optional(),
}).strict();

const experimentalNotice = "[Experimental] Undocumented internal GitHub endpoint that can change without notice.";

const steerInput = z.object({
  task_id: z.string().describe("Task identifier."),
  content: z.string().describe("Instructions to send to the task."),
}).strict();

const steerOutput = z.object({
  task_id: z.string(),
  accepted: z.boolean(),
  session_count: z.number(),
}).strict();

const abortInput = z.object({
  task_id: z.string().describe("Task identifier."),
}).strict();

const abortOutput = z.object({
  task_id: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
  status: z.enum(["working", "needs_input", "completed", "failed", "cancelled"]).optional(),
  terminal: z.boolean().optional(),
}).strict();

const eventsInput = z.object({
  task_id: z.string().describe("Task identifier."),
  page: z.number().int().positive().describe("Page, starting at 1."),
  per_page: z.number().int().positive().describe("Events per page."),
}).strict();

const eventOutput = z.object({
  id: z.string().optional(),
  timestamp: z.string().optional(),
  parentId: z.string().optional(),
  type: z.string(),
  data: z.unknown().optional(),
}).strict();

const eventsOutput = z.object({
  task_id: z.string(),
  page: z.number(),
  per_page: z.number(),
  total: z.number(),
  events: z.array(eventOutput),
}).strict();

export function buildServer(selection: Selection, deps: ServerDeps): McpServer {
  const enabled = new Set(selectToolNames(selection));
  const server = new McpServer({
    name: "copilot-agents-mcp",
    version: packageVersion(),
  }, {
    instructions: SERVER_INSTRUCTIONS,
  });
  if (enabled.has("create_agent_task")) {
    server.registerTool("create_agent_task", {
      title: "Launch Copilot task",
      description: `Launch a GitHub Copilot cloud agent task. The model is sent unchanged. If the model was already rejected, the tool skips the API call and lists accepted models observed so far. ${CREATE_TASK_GUIDANCE}`,
      inputSchema: createInput,
      outputSchema: createOutput,
      annotations: toolAnnotations("create_agent_task", "Launch Copilot task"),
    }, async (args) => run(() => createTask(args, deps)));
  }
  if (enabled.has("get_agent_task")) {
    server.registerTool("get_agent_task", {
      title: "Get task status",
      description: "Read one task once. Returns status, terminal and a one-line summary. Do not call repeatedly; use list_agent_tasks for periodic checks.",
      inputSchema: getInput,
      annotations: toolAnnotations("get_agent_task", "Get task status"),
    }, async (args) => run(() => readTask(args, deps)));
  }
  if (enabled.has("list_agent_tasks")) {
    server.registerTool("list_agent_tasks", {
      title: "List tracked tasks",
      description: "One call to check all tracked tasks. Use it for scheduled checks. When all_terminal is true, stop checking. Several agents may share this server; owner is a labeling convention, not a security boundary.",
      inputSchema: listInput,
      annotations: toolAnnotations("list_agent_tasks", "List tracked tasks"),
    }, async (args) => run(() => listAgentTasks(args, deps)));
  }
  if (enabled.has("steer_agent_task")) {
    server.registerTool("steer_agent_task", {
      title: "Steer task",
      description: `${experimentalNotice} Each steer consumes credits. The agent applies the instruction after its current tool call finishes. Send an instruction to a task with an open pull request.`,
      inputSchema: steerInput,
      outputSchema: steerOutput,
      annotations: toolAnnotations("steer_agent_task", "Steer task"),
    }, async (args) => run(() => steerTask(args, deps)));
  }
  if (enabled.has("abort_agent_task")) {
    server.registerTool("abort_agent_task", {
      title: "Abort task",
      description: `${experimentalNotice} Send {type: "abort"} to the steer endpoint, as VS Code does in tasksClient.ts, to stop the task. This has not been verified against GitHub.`,
      inputSchema: abortInput,
      outputSchema: abortOutput,
      annotations: toolAnnotations("abort_agent_task", "Abort task"),
    }, async (args) => run(() => abortTask(args, deps)));
  }
  if (enabled.has("get_agent_task_events")) {
    server.registerTool("get_agent_task_events", {
      title: "Get task events",
      description: `${experimentalNotice} Read one page of task events (read-only).`,
      inputSchema: eventsInput,
      outputSchema: eventsOutput,
      annotations: toolAnnotations("get_agent_task_events", "Get task events"),
    }, async (args) => run(() => readEvents(args, deps)));
  }
  if (enabled.has("list_copilot_models")) {
    server.registerTool("list_copilot_models", {
      title: "List Copilot models",
      description: "Read /agents/swe/models and return the ID, name, vendor, preview flag, token prices or multiplier, and promotion when present.",
      inputSchema: z.object({}).strict(),
      outputSchema: sweModelsResultSchema,
      annotations: toolAnnotations("list_copilot_models", "List Copilot models"),
    }, async () => run(() => deps.readModels()));
  }
  return server;
}

function toolAnnotations(
  name: (typeof TOOLS)[number]["name"] | "create_agent_task",
  title: string,
) {
  const readOnly = name === "get_agent_task" || name === "list_agent_tasks" || name === "get_agent_task_events" || name === "list_copilot_models";
  const destructive = name === "abort_agent_task";
  const idempotent = readOnly || name === "abort_agent_task";
  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: true,
  };
}

async function run(action: () => Promise<object>) {
  try {
    return toolJson(await action() as Record<string, unknown>);
  } catch (error) {
  if (error instanceof OwnerValidationError) {
      return toolError(new CodedToolFailure("invalid_argument", error.message).toBody());
    }
    if (error instanceof CodedToolFailure) return toolError(error.toBody());
    return toolError(failureToError(error));
  }
}

async function createTask(args: z.infer<typeof createInput>, deps: ServerDeps) {
  const repo = required(args.repo, "repo");
  const prompt = required(args.prompt, "prompt");
  const model = required(args.model, "model");
  const taskOwner = args.owner !== undefined ? validateOwner(args.owner) : undefined;
  const parsed = parseRepo(repo);
  const blocked = await withStateLock(deps.statePath, (state) => {
    const key = normalizeModel(model);
    if (!state.models.rejected.includes(key)) return null;
    return modelUnavailableMessage(model, state.models.accepted);
  });
  if (blocked) throw new CodedToolFailure("model_unavailable", blocked);
  const token = deps.readToken();
  if (!token) throw new CodedToolFailure("not_authenticated", NO_SESSION_MESSAGE);
  const channels = activeNotificationChannels(process.platform, process.env);
  const deliveryRecord = channels.length > 0 ? { status: "pending" as const } : null;
  const task = await deps.clientForToken(token).createTask({
    owner: parsed.owner,
    repo: parsed.repo,
    prompt,
    model,
    ...(args.base_ref !== undefined ? { base_ref: args.base_ref } : {}),
    ...(args.head_ref !== undefined ? { head_ref: args.head_ref } : {}),
    ...(args.custom_agent !== undefined ? { custom_agent: args.custom_agent } : {}),
    ...(args.create_pull_request !== undefined ? { create_pull_request: args.create_pull_request } : {}),
  });
  const mapped = mapRawState(task.state);
  await withStateLock(deps.statePath, (state) => {
    state.tasks[task.id] = initialTask({
      id: task.id,
      repo,
      requestedModel: model,
      state: task.state,
      createdAt: task.created_at ?? null,
      updatedAt: task.updated_at ?? null,
      ...(taskOwner ? { owner: taskOwner } : {}),
      deliveryRecord,
      htmlUrl: task.html_url ?? task.url ?? null,
    });
  });
  let watcher_started = false;
  if (shouldSpawnWatcher(channels)) {
    try {
      deps.launchWatcher();
      watcher_started = true;
    } catch (error) {
      console.error(`Could not start the watcher: ${error instanceof Error ? error.message : "error"}.`);
    }
  }
  const session = task.html_url ?? task.url ?? undefined;
  const follow_up = followUpBlock(channels, watcher_started, Date.now(), session);
  const planMode = follow_up.mode;
  const next_step = createFollowUpNextStep(planMode, taskOwner, task.id, channels.length > 0 && !watcher_started);
  const body: Record<string, unknown> = {
    task_id: task.id,
    repo,
    status: mapped.status,
    terminal: mapped.terminal,
    requested_model: model,
    follow_up,
    next_step,
  };
  if (taskOwner) body.owner = taskOwner;
  if (session) body.session_url = session;
  return body;
}

async function readTask(args: z.infer<typeof getInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const verbose = args.verbose === true;
  const known = await withStateLock(deps.statePath, (state) => state.tasks[taskId] ?? null);
  const repo = args.repo?.trim() || known?.repo || "";
  const parsed = repo ? parseRepo(repo) : null;
  const token = deps.readToken();
  if (!token) throw new CodedToolFailure("not_authenticated", NO_SESSION_MESSAGE);
  const client = deps.clientForToken(token);
  const channels = activeNotificationChannels(process.platform, process.env);
  const freshness = freshnessMs(process.env);
  const checkAfter = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  let tracked: TrackedTask;
  let cached = false;
  if (known && mapRawState(known.state).terminal) {
    tracked = known;
    if (tracked.pull_request && tracked.pull_request.number === null && parsed) {
      let headRef = tracked.branch?.head_ref;
      if (!headRef) {
        const remote = await client.getTask({
          taskId,
          owner: parsed.owner,
          repo: parsed.repo,
        });
        headRef = headRefOf(remote, tracked);
      }
      await fillPullRequest(
        tracked,
        (input) => client.findPullRequest(input),
        (line) => appendWatcherLog(line),
        headRef,
      );
      await withStateLock(deps.statePath, (state) => {
        const saved = state.tasks[tracked.task_id];
        if (saved) {
          saved.pull_request = tracked.pull_request;
          saved.pr_title = tracked.pr_title ?? null;
        }
      });
    }
  } else if (known && !needsFetch(known, freshness)) {
    tracked = known;
    cached = true;
  } else {
    try {
      const remote = await client.getTask({
        taskId,
        ...(parsed ? { owner: parsed.owner, repo: parsed.repo } : {}),
      });
      tracked = await withStateLock(deps.statePath, (state) => {
        const row = observe(state, remote, {
          repo: repo || state.tasks[taskId]?.repo || "",
          requestedModel: state.tasks[taskId]?.requested_model ?? known?.requested_model ?? null,
        });
        row.last_fetched_at = new Date().toISOString();
        return row;
      });
      if (mapRawState(tracked.state).terminal) {
        await fillPullRequest(
          tracked,
          (input) => client.findPullRequest(input),
          (line) => appendWatcherLog(line),
          headRefOf(remote, tracked),
        );
        await withStateLock(deps.statePath, (state) => {
          const saved = state.tasks[tracked.task_id];
          if (saved) {
            saved.pull_request = tracked.pull_request;
            saved.pr_title = tracked.pr_title ?? null;
          }
        });
      }
    } catch (error) {
      if (known) {
        tracked = known;
        return {
          ...compactGetTask(tracked, channels, { verbose, checkAfter, cached: true }),
          stale: true,
          warnings: [`could not refresh 1 task: ${failureMessage(error)}`],
        };
      }
      const message = failureMessage(error);
      if (/HTTP 404|not found/i.test(message)) {
        throw new CodedToolFailure("not_found", `Task ${taskId} was not found.`);
      }
      throw error;
    }
  }
  return compactGetTask(tracked, channels, { verbose, checkAfter, cached });
}

async function listAgentTasks(args: z.infer<typeof listInput>, deps: ServerDeps) {
  const token = deps.readToken();
  if (!token) throw new CodedToolFailure("not_authenticated", NO_SESSION_MESSAGE);
  const client = deps.clientForToken(token);
  const freshness = freshnessMs(process.env);
  const now = Date.now();
  const input = {
    ...(args.owner !== undefined ? { owner: args.owner } : {}),
    ...(args.task_ids ? { task_ids: args.task_ids } : {}),
    ...(args.status ? { status: args.status } : {}),
    ...(args.repo ? { repo: args.repo } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    verbose: args.verbose,
  };
  let registryEmpty = false;
  let matchedEmpty = false;
  let warnings: string[] = [];
  let matched: TrackedTask[] = [];
  await withStateLock(deps.statePath, (state) => {
    pruneRegistry(state, now);
    registryEmpty = Object.keys(state.tasks).length === 0;
    const result = filterTasks(state, input, now);
    matched = result.matched;
    warnings = result.warnings;
    matchedEmpty = !registryEmpty && result.total_matched === 0;
  });
  const staleIds = new Set<string>();
  const toRefresh = matched.filter((task) => needsFetch(task, freshness, now)).map((task) => task.task_id);
  if (toRefresh.length > 0) {
    const { failures } = await refreshTasks(deps.statePath, client, toRefresh, freshness, (line) => appendWatcherLog(line));
    for (const [id, reason] of failures) {
      staleIds.add(id);
      warnings.push(`could not refresh 1 task: ${reason}`);
    }
  }
  const updated = await withStateLock(deps.statePath, (state) => {
    const result = filterTasks(state, input, now);
    return { page: result.tasks, matched: result.matched };
  });
  const counts = listCounts(updated.matched);
  const checkAfter = new Date(now + 5 * 60 * 1000).toISOString();
  const checkLocal = formatCheckAfterLocal(checkAfter);
  const rows = updated.page.map((task) => toListRow(task, {
    stale: staleIds.has(task.task_id) ? true : undefined,
    checkAfterLocal: checkLocal,
  }));
  const body: Record<string, unknown> = {
    tasks: rows,
    pending_count: counts.pending_count,
    terminal_count: counts.terminal_count,
    all_terminal: counts.all_terminal,
    next_step: listNextStep(counts, matchedEmpty, registryEmpty, checkAfter),
  };
  if (!counts.all_terminal && counts.pending_count > 0) body.next_check_after = checkAfter;
  if (warnings.length > 0) body.warnings = warnings;
  return body;
}

async function steerTask(args: z.infer<typeof steerInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const content = required(args.content, "content");
  const token = deps.readToken();
  if (!token) throw new ToolFailure(NO_SESSION_MESSAGE);
  const client = deps.clientForToken(token);
  const known = await withStateLock(deps.statePath, (state) => state.tasks[taskId] ?? null);
  const remote = await client.getTask({
    taskId,
    ...(known?.repo ? parseRepo(known.repo) : {}),
  });
  const repo = known?.repo || repoFromTaskUrl(remote.html_url);
  if (!repo) throw new ToolFailure(`The repository for task ${taskId} is unknown.`);
  const parsed = parseRepo(repo);
  const pull = pullArtifact(remote);
  if (!pull) throw new ToolFailure(`${TASK_HAS_NO_PULL_REQUEST}: task ${taskId} has no pull request.`);
  const number = await resolvePullNumber(client, remote, known, parsed, pull);
  const opened = await client.getPullRequest({ owner: parsed.owner, repo: parsed.repo, number });
  if (opened.state !== "open") {
    throw new ToolFailure(`${TASK_PULL_REQUEST_NOT_OPEN}: pull request ${number} in ${repo} is not open.`);
  }
  await client.steerTask(taskId, content);
  const sessionCount = taskSessionCount(remote);
  const steeredAt = new Date().toISOString();
  await withStateLock(deps.statePath, (state) => {
    const task = state.tasks[taskId] ?? initialTask({
      id: remote.id,
      repo,
      requestedModel: known?.requested_model ?? "",
      state: remote.state,
      createdAt: remote.created_at ?? null,
      updatedAt: remote.updated_at ?? null,
    });
    if (!task.repo) task.repo = repo;
    armSteer(task, sessionCount, steeredAt);
    state.tasks[taskId] = task;
  });
  if (shouldSpawnWatcher(activeNotificationChannels(process.platform, process.env))) {
    try {
      deps.launchWatcher();
    } catch (error) {
      console.error(`Could not start the watcher: ${error instanceof Error ? error.message : "error"}.`);
    }
  }
  return { task_id: taskId, accepted: true, session_count: sessionCount };
}

async function abortTask(args: z.infer<typeof abortInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const token = deps.readToken();
  if (!token) throw new CodedToolFailure("not_authenticated", NO_SESSION_MESSAGE);
  const known = await withStateLock(deps.statePath, (state) => state.tasks[taskId] ?? null);
  if (known && isFinalState(known.state)) {
    const mapped = mapRawState(known.state);
    return {
      task_id: taskId,
      accepted: false,
      reason: "already finished",
      status: mapped.status,
      terminal: true,
    };
  }
  await deps.clientForToken(token).abortTask(taskId);
  await withStateLock(deps.statePath, (state) => {
    const task = state.tasks[taskId];
    if (task) task.last_fetched_at = null;
  });
  return { task_id: taskId, accepted: true };
}

async function readEvents(args: z.infer<typeof eventsInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const token = deps.readToken();
  if (!token) throw new ToolFailure(NO_SESSION_MESSAGE);
  const page = await deps.clientForToken(token).getTaskEvents(taskId, args.page, args.per_page);
  return {
    task_id: taskId,
    page: args.page,
    per_page: args.per_page,
    total: page.total,
    events: page.events.map(presentEvent),
  };
}

function presentEvent(event: TaskEvent): z.infer<typeof eventOutput> {
  const body: z.infer<typeof eventOutput> = { type: event.type };
  if (event.id) body.id = event.id;
  if (event.timestamp) body.timestamp = event.timestamp;
  if (event.parentId) body.parentId = event.parentId;
  if (event.data !== undefined) body.data = event.data;
  return body;
}

function pullArtifact(task: AgentTask): { id: number; number: number | null } | null {
  for (const artifact of task.artifacts ?? []) {
    if (artifact.type !== "pull" || typeof artifact.data?.id !== "number") continue;
    return { id: artifact.data.id, number: typeof artifact.data.number === "number" ? artifact.data.number : null };
  }
  return null;
}

async function resolvePullNumber(
  client: GitHubClient,
  task: AgentTask,
  known: { pull_request: { id: number; number: number | null } | null; branch: { head_ref: string; base_ref: string } | null } | null,
  repo: { owner: string; repo: string },
  pull: { id: number; number: number | null },
): Promise<number> {
  if (pull.number !== null) return pull.number;
  if (known?.pull_request?.id === pull.id && known.pull_request.number !== null) return known.pull_request.number;
  const headRef = headRefOf(task, { branch: known?.branch ?? null });
  if (!headRef) throw new ToolFailure(`Cannot verify pull request ${pull.id} for task ${task.id}: head_ref is missing.`);
  const found = await client.findPullRequest({ owner: repo.owner, repo: repo.repo, id: pull.id, headRef });
  if (!found) throw new ToolFailure(`Cannot verify pull request ${pull.id} for task ${task.id}: the list does not contain that ID.`);
  return found.number;
}

function repoFromTaskUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] && parts[1]) return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
  return null;
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new CodedToolFailure("invalid_argument", `missing required parameter: ${name}`);
  return value.trim();
}

export function parseRepo(repo: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!match?.[1] || !match[2]) throw new CodedToolFailure("invalid_argument", "repo must use the owner/name form.");
  return { owner: match[1], repo: match[2] };
}

export function defaultLaunchWatcher(): void {
  startDetachedWatcher();
}

export { TOOLS };
