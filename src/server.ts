import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CodedToolFailure,
  failureMessage,
  failureToError,
  modelUnavailableMessage,
  NO_SESSION_MESSAGE,
  NO_SESSION_STALE_WARNING,
  TASK_HAS_NO_PULL_REQUEST,
  TASK_PULL_REQUEST_NOT_OPEN,
  toolError,
  toolJson,
  ToolFailure,
} from "./errors.ts";
import type { AgentTask, GitHubClient } from "./github.ts";
import { presentSweModelsResult, sweModelsResultSchema, type SweModelsResult } from "./swe-models.ts";
import { TOOLS, toolNames } from "./selection.ts";
import { deliveryForTask, shouldSpawnWatcher } from "./delivery.ts";
import { createFollowUpNextStep, followUpBlock } from "./follow-up.ts";
import { activeNotificationChannels, appendWatcherLog, notificationChannelsForTask } from "./notify.ts";
import { compactGetTask } from "./task-present.ts";
import { mapRawState } from "./task-status.ts";
import { prUrl, resolveTaskPageUrl } from "./task-urls.ts";
import {
  aggregateNextCheckAfter,
  filterTasks,
  freshnessMs,
  listCounts,
  listNextStep,
  needsFetch,
  resolveNextCheckAfter,
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
  readState,
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

const OWNER_FIELD =
  "Stable agent name (e.g. your bot's name). Required for multi-agent setups: pass owner=<your agent name> on every create so list_agent_tasks with that owner shows only your tasks. Not a security boundary.";

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
  mode: z.enum(["push", "check_later"]),
  channels: z.array(z.enum(["webhook"])).optional(),
  check_after: z.string(),
  min_interval_s: z.number(),
  check_with: z.literal("list_agent_tasks"),
}).strict();

const createOutput = z.object({
  task_id: z.string(),
  repo: z.string(),
  owner: z.string().optional(),
  status: z.enum(["working", "needs_input", "completed", "failed", "cancelled"]),
  terminal: z.boolean(),
  requested_model: z.string(),
  delivery: z.enum(["not_configured", "pending", "delivered", "failed"]),
  session_url: z.string().optional(),
  pr_url: z.string().optional(),
  follow_up: followUpSchema,
  next_step: z.string(),
}).strict();

const SERVER_INSTRUCTIONS = [
  "Copilot cloud tasks take minutes. Tools never wait.",
  "Always pass owner=<your agent name> to create_agent_task so list_agent_tasks with that owner shows only your tasks.",
  "A webhook is the RECOMMENDED completion path. Clients that can receive webhooks should register one from the start with `webhook register` (local CLI, not an MCP tool).",
  "After create_agent_task, end your turn and follow next_step; do not poll in a loop.",
  "check_later is the supported fallback: end your turn, schedule a check at check_after if possible, never poll in a loop.",
  "First list check not before follow_up.check_after; call list_agent_tasks with your owner at most every follow_up.min_interval_s seconds until all_terminal is true.",
  "get_agent_task returns one task's full result (once, not in a loop).",
  "steer_agent_task sends a user message to a running task with an open pull request; abort_agent_task requests cancellation (experimental GitHub endpoints).",
  "With an eligible owner webhook or COPILOT_AGENTS_NOTIFY_URL set, the watcher POSTs JSON when a task reaches a terminal state—wake on that webhook and call get_agent_task once. Otherwise follow check_later in next_step.",
].join(" ");

const CREATE_TASK_GUIDANCE =
  "Returns immediately with task_id. Pass owner=<your agent name> unless this server runs a single agent. Follow next_step.";

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

export function buildServer(deps: ServerDeps): McpServer {
  const enabled = new Set(toolNames());
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
  if (enabled.has("list_copilot_models")) {
    server.registerTool("list_copilot_models", {
      title: "List Copilot models",
      description: "Read /agents/swe/models and return the ID, name, vendor, preview flag, token prices or multiplier, and promotion when present.",
      inputSchema: z.object({}).strict(),
      outputSchema: sweModelsResultSchema,
      annotations: toolAnnotations("list_copilot_models", "List Copilot models"),
    }, async () => run(async () => presentSweModelsResult(await deps.readModels())));
  }
  return server;
}

function toolAnnotations(
  name: (typeof TOOLS)[number]["name"] | "create_agent_task",
  title: string,
) {
  const readOnly = name === "get_agent_task" || name === "list_agent_tasks" || name === "list_copilot_models";
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
  const localTask = initialTask({
    id: task.id,
    repo,
    requestedModel: model,
    state: task.state,
    createdAt: task.created_at ?? null,
    updatedAt: task.updated_at ?? null,
    ...(taskOwner ? { owner: taskOwner } : {}),
    htmlUrl: resolveTaskPageUrl(task) ?? null,
  });
  const followUpNow = Date.now();
  const { channels, hasWebhookRegistration } = await withStateLock(deps.statePath, (state) => {
    const configured = notificationChannelsForTask(localTask, state);
    localTask.delivery_record = configured.length > 0 ? { status: "pending" } : null;
    localTask.check_after = followUpBlock(configured, false, followUpNow).check_after;
    state.tasks[task.id] = localTask;
    return {
      channels: configured,
      hasWebhookRegistration: taskOwner !== undefined && Object.hasOwn(state.webhooks ?? {}, taskOwner),
    };
  });
  const mapped = mapRawState(task.state);
  let watcher_started = false;
  if (shouldSpawnWatcher(channels)) {
    try {
      deps.launchWatcher();
      watcher_started = true;
    } catch (error) {
      console.error(`Could not start the watcher: ${error instanceof Error ? error.message : "error"}.`);
    }
  }
  const session = resolveTaskPageUrl(task);
  const follow_up = followUpBlock(channels, watcher_started, followUpNow);
  const planMode = follow_up.mode;
  let next_step = createFollowUpNextStep(
    planMode,
    taskOwner,
    task.id,
    channels.length > 0 && !watcher_started,
    follow_up.check_after,
  );
  if (taskOwner && !hasWebhookRegistration) {
    next_step += "\nNo webhook: using check_later. Recommended: configure one with `webhook register`.";
  }
  const stored = await withStateLock(deps.statePath, (state) => state.tasks[task.id] ?? null);
  const delivery = deliveryForTask(stored ?? localTask, channels);
  const body: Record<string, unknown> = {
    task_id: task.id,
    repo,
    status: mapped.status,
    terminal: mapped.terminal,
    requested_model: model,
    delivery,
    follow_up,
    next_step,
  };
  if (taskOwner) body.owner = taskOwner;
  if (session) body.session_url = session;
  const createdPr = stored ? prUrl(stored) : undefined;
  if (createdPr) body.pr_url = createdPr;
  return body;
}

async function readTask(args: z.infer<typeof getInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const verbose = args.verbose === true;
  const known = await withStateLock(deps.statePath, (state) => state.tasks[taskId] ?? null);
  const repo = args.repo?.trim() || known?.repo || "";
  const parsed = repo ? parseRepo(repo) : null;
  const token = deps.readToken();
  const channels = known
    ? notificationChannelsForTask(known, await readState(deps.statePath))
    : activeNotificationChannels(process.platform, process.env);
  const freshness = freshnessMs();
  const now = Date.now();
  if (!token) {
    if (known && mapRawState(known.state).terminal) {
      const checkAfter = resolveNextCheckAfter(known, now);
      return {
        ...compactGetTask(known, channels, { verbose, checkAfter, cached: true }),
        stale: true,
        warnings: [NO_SESSION_STALE_WARNING],
      };
    }
    throw new CodedToolFailure("not_authenticated", NO_SESSION_MESSAGE);
  }
  const client = deps.clientForToken(token);
  let tracked: TrackedTask;
  let cached = false;
  if (known && !needsFetch(known, freshness)) {
    tracked = known;
    cached = true;
    if (mapRawState(tracked.state).terminal && tracked.pull_request && tracked.pull_request.number === null && parsed) {
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
        const checkAfter = resolveNextCheckAfter(tracked, now);
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
  const checkAfter = resolveNextCheckAfter(tracked, now);
  return compactGetTask(tracked, channels, { verbose, checkAfter, cached });
}

async function listAgentTasks(args: z.infer<typeof listInput>, deps: ServerDeps) {
  const token = deps.readToken();
  const freshness = freshnessMs();
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
  let page: TrackedTask[] = [];
  await withStateLock(deps.statePath, (state) => {
    pruneRegistry(state, now);
    registryEmpty = Object.keys(state.tasks).length === 0;
    const result = filterTasks(state, input, now);
    matched = result.matched;
    page = result.tasks;
    warnings = result.warnings;
    matchedEmpty = !registryEmpty && result.total_matched === 0;
  });
  const staleOnly = !token;
  if (staleOnly) {
    const hasPending = matched.some((task) => !mapRawState(task.state).terminal);
    if (hasPending) throw new CodedToolFailure("not_authenticated", NO_SESSION_MESSAGE);
    const counts = listCounts(matched);
    const checkAfter = aggregateNextCheckAfter(matched, now);
    const rows = page.map((task) => toListRow(task, { checkAfter: resolveNextCheckAfter(task, now) }));
    const staleWarnings = [...warnings, NO_SESSION_STALE_WARNING];
    return {
      tasks: rows,
      pending_count: counts.pending_count,
      terminal_count: counts.terminal_count,
      all_terminal: counts.all_terminal,
      next_step: listNextStep(counts, matchedEmpty, registryEmpty, checkAfter),
      warnings: staleWarnings,
      stale: true,
    };
  }
  const client = deps.clientForToken(token);
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
  const checkAfter = aggregateNextCheckAfter(updated.matched, now);
  const rows = updated.page.map((task) => toListRow(task, {
    stale: staleIds.has(task.task_id) ? true : undefined,
    checkAfter: resolveNextCheckAfter(task, now),
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
  const savedState = await readState(deps.statePath);
  const steered = savedState.tasks[taskId];
  if (steered && shouldSpawnWatcher(notificationChannelsForTask(steered, savedState))) {
    try {
      deps.launchWatcher();
    } catch (error) {
      console.error(`Could not start the watcher: ${error instanceof Error ? error.message : "error"}.`);
    }
  }
  return { task_id: taskId, accepted: true, session_count: sessionCount };
}

function isAbortNoSessionError(message: string): boolean {
  return /cannot abort/i.test(message) && /no active session/i.test(message);
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
  const client = deps.clientForToken(token);
  try {
    await client.abortTask(taskId);
  } catch (error) {
    const message = failureMessage(error);
    if (isAbortNoSessionError(message) && known?.repo) {
      const parsed = parseRepo(known.repo);
      const remote = await client.getTask({
        taskId,
        owner: parsed.owner,
        repo: parsed.repo,
      });
      const tracked = await withStateLock(deps.statePath, (state) => {
        const row = observe(state, remote, {
          repo: known.repo,
          requestedModel: state.tasks[taskId]?.requested_model ?? known.requested_model ?? null,
        });
        row.last_fetched_at = new Date().toISOString();
        return row;
      });
      if (isFinalState(tracked.state)) {
        const mapped = mapRawState(tracked.state);
        return {
          task_id: taskId,
          accepted: false,
          reason: "already finished",
          status: mapped.status,
          terminal: true,
        };
      }
    }
    throw error;
  }
  await withStateLock(deps.statePath, (state) => {
    const task = state.tasks[taskId];
    if (task) task.last_fetched_at = null;
  });
  const current = await withStateLock(deps.statePath, (state) => state.tasks[taskId] ?? null);
  const mapped = mapRawState(current?.state ?? "in_progress");
  return {
    task_id: taskId,
    accepted: true,
    status: mapped.status,
    terminal: mapped.terminal,
  };
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
