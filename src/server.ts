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
import { OwnerTokenError, resolveOwnerToken } from "./webhooks.ts";
import { completionSetup, completionSetupSchema, completionStrategySchema, setCompletionStrategy } from "./completion.ts";

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
  "Exact owner label for read-only filtering. Not authentication; use owner_token to authenticate creation, steering, cancellation (abort), and set_completion_strategy.";
const ownerTokenInput = z.string().optional().describe("Private owner token issued by local webhook register. Omit for unowned tasks; never paste tokens into chat.");

const createInput = z.object({
  repo: z.string().describe("Required repository in owner/name form, e.g. octocat/hello-world; surrounding whitespace is trimmed."),
  prompt: z.string().describe("Required non-blank task instructions; surrounding whitespace is trimmed. Never include credentials."),
  model: z.string().describe("Required non-blank model ID, e.g. gpt-6.1-sol; trimmed and sent unchanged without a closed allowlist. Discover IDs with list_copilot_models."),
  base_ref: z.string().optional().describe("Base branch for a new branch or pull request, e.g. main. Omit to use GitHub's default."),
  head_ref: z.string().optional().describe("Existing branch. With base_ref, the agent commits to this branch. Omit to let GitHub choose."),
  custom_agent: z.string().optional().describe("Custom agent name without the extension. Omit to use GitHub's default agent."),
  create_pull_request: z.boolean().optional().describe("When true, the API creates a pull request. Omit to use GitHub's default."),
  owner_token: ownerTokenInput,
}).strict();

const followUpSchema = z.object({
  mode: z.enum(["push", "check_later"]).describe("Wake on a webhook, or end the turn and schedule a later check."),
  channels: z.array(z.enum(["webhook"])).optional().describe("Configured notification channels, when available."),
  check_after: z.string().describe("ISO 8601 timestamp; do not check before this time."),
  min_interval_s: z.number().describe("Minimum seconds between subsequent checks."),
  check_with: z.literal("list_agent_tasks").describe("Tool to call for a scheduled check."),
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
  setup: completionSetupSchema.optional(),
}).strict();

const SERVER_INSTRUCTIONS = [
  "Copilot cloud tasks take minutes. Tools never wait.",
  "Use the private owner_token issued by local webhook register on create_agent_task, steer_agent_task, abort_agent_task, and set_completion_strategy. Without a token, creation is unowned; owned tasks require their matching token to steer or abort.",
  "If create_agent_task or list_agent_tasks returns setup, ask once and save the user's choice with set_completion_strategy. Never request webhook secrets or owner tokens in chat.",
  "A webhook is the RECOMMENDED completion path: configure `webhook register` locally before creating tasks; never pass webhook secrets through MCP.",
  "An eligible owner webhook or COPILOT_AGENTS_NOTIFY_URL enables watcher notifications. Wake on the webhook and call get_agent_task once.",
  "After create_agent_task, follow next_step and end your turn. check_later is the fallback: schedule list_agent_tasks at follow_up.check_after if possible, never poll in a loop.",
  "Check no sooner than check_after, space later checks by at least follow_up.min_interval_s, and stop scheduled checks when all_terminal is true.",
  "Use get_agent_task for one task's result, list_agent_tasks for scheduled batch checks, and list_copilot_models to discover model IDs.",
  "steer_agent_task sends instructions to a task with an open pull request and consumes credits; abort_agent_task requests cancellation. Both use experimental GitHub endpoints.",
].join(" ");

const CREATE_TASK_GUIDANCE =
  "Returns immediately with task_id. Follow next_step. If setup is present, ask once and record the answer with set_completion_strategy.";

const getInput = z.object({
  task_id: z.string().describe("Required non-blank identifier returned by create_agent_task; surrounding whitespace is trimmed."),
  repo: z.string().optional().describe("Repository in owner/name form. If omitted, use the saved repository or user endpoint."),
  verbose: z.boolean().optional().describe("Include raw state, models, usage, artifacts, and error (up to 2048 characters). Default false."),
}).strict();

const listInput = z.object({
  owner: z.string().optional().describe(OWNER_FIELD),
  task_ids: z.array(z.string().describe("Locally tracked task identifier.")).max(50).optional().describe("Filter to at most 50 task IDs. Omit or pass [] for all tracked IDs; unknown IDs produce warnings."),
  status: z.enum(["pending", "terminal", "all"]).optional().describe("Filter by lifecycle status. Default all; completed tasks are visible for seven days."),
  repo: z.string().optional().describe("Exact repository filter in owner/name form. Omit for all repositories."),
  limit: z.number().int().positive().max(50).optional().describe("Maximum rows returned, 1-50; default 20. Counts cover every matching task, not just returned rows."),
  verbose: z.boolean().optional().describe("Compatibility flag, default false. List rows remain compact; use get_agent_task with verbose=true for details."),
}).strict();

const experimentalNotice = "[Experimental] Undocumented internal GitHub endpoint that can change without notice.";

const steerInput = z.object({
  task_id: z.string().describe("Required non-blank task identifier returned by create_agent_task."),
  content: z.string().describe("Required non-blank follow-up instructions, trimmed before sending. Each call consumes credits; never include credentials."),
  owner_token: ownerTokenInput,
}).strict();

const steerOutput = z.object({
  task_id: z.string(),
  accepted: z.boolean(),
  session_count: z.number(),
}).strict();

const abortInput = z.object({
  task_id: z.string().describe("Required non-blank task identifier returned by create_agent_task."),
  owner_token: ownerTokenInput,
}).strict();

const abortOutput = z.object({
  task_id: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
  status: z.enum(["working", "needs_input", "completed", "failed", "cancelled"]).optional(),
  terminal: z.boolean().optional(),
}).strict();

const taskRowFields = {
  task_id: z.string(),
  repo: z.string(),
  owner: z.string().optional(),
  status: z.enum(["working", "needs_input", "completed", "failed", "cancelled"]),
  terminal: z.boolean(),
  summary: z.string(),
  pr_url: z.string().optional(),
  session_url: z.string().optional(),
  updated_at: z.string().optional(),
  stale: z.boolean().optional(),
  cached: z.boolean().optional(),
  warning: z.string().optional(),
};

const branchFields = {
  head_ref: z.string(),
  base_ref: z.string(),
};

const getOutput = z.object({
  ...taskRowFields,
  delivery: z.enum(["not_configured", "pending", "delivered", "failed"]),
  next_step: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  completed_at: z.string().optional(),
  state: z.string().optional(),
  requested_model: z.string().optional(),
  resolved_model: z.string().optional(),
  pull_request: z.object({
    id: z.number().optional(),
    number: z.number().optional(),
    url: z.string().optional(),
  }).strict().optional(),
  branch: z.object(branchFields).strict().optional(),
  artifacts: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("pull"), id: z.number() }).strict(),
    z.object({ type: z.literal("branch"), ...branchFields }).strict(),
  ])).optional(),
  usage: z.object({
    type: z.enum(["ai_credits", "premium_requests"]),
    amount: z.number(),
    amount_human: z.number(),
  }).strict().optional(),
  session_id: z.string().optional(),
  created_at: z.string().optional(),
  error: z.string().optional(),
  delivered_via: z.string().optional(),
}).strict();

const listOutput = z.object({
  tasks: z.array(z.object(taskRowFields).strict()),
  pending_count: z.number().int().nonnegative(),
  terminal_count: z.number().int().nonnegative(),
  all_terminal: z.boolean(),
  next_step: z.string(),
  next_check_after: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  stale: z.boolean().optional(),
  setup: completionSetupSchema.optional(),
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
      description: `Launch a GitHub Copilot cloud agent with repo, prompt, and model; use list_copilot_models to discover IDs. Returns status, delivery, follow_up, and next_step. May fail for authentication, repository access or policy, invalid input, or an unavailable model; previously rejected models skip the API and list accepted models observed so far. ${CREATE_TASK_GUIDANCE}`,
      inputSchema: createInput,
      outputSchema: createOutput,
      annotations: toolAnnotations("create_agent_task", "Launch Copilot task"),
    }, async (args) => run(() => createTask(args, deps)));
  }
  if (enabled.has("get_agent_task")) {
    server.registerTool("get_agent_task", {
      title: "Get task status",
      description: "Read one task's result by task_id; optional repo overrides the saved repository and verbose adds details. Returns status, terminal, summary, delivery, and available PR/session links. Cached results may include stale and warnings after a refresh failure. Check authentication or task/repository access on errors. Use list_agent_tasks for scheduled checks, never call this in a loop.",
      inputSchema: getInput,
      outputSchema: getOutput,
      annotations: toolAnnotations("get_agent_task", "Get task status"),
    }, async (args) => run(() => readTask(args, deps)));
  }
  if (enabled.has("list_agent_tasks")) {
    server.registerTool("list_agent_tasks", {
      title: "List tracked tasks",
      description: "Check locally tracked tasks in one scheduled call, filtered by owner, task_ids, status, or repo. Returns compact rows (limit defaults to 20, maximum 50), counts across all matches, all_terminal, next_step, and next_check_after while pending. Stop checks when all_terminal is true. Refresh failures return stale rows and warnings; pending tasks require authentication. Owner is a read-only label, not authentication; this is not a GitHub-wide task search. If setup is present, ask once and record the answer with set_completion_strategy.",
      inputSchema: listInput,
      outputSchema: listOutput,
      annotations: toolAnnotations("list_agent_tasks", "List tracked tasks"),
    }, async (args) => run(() => listAgentTasks(args, deps)));
  }
  if (enabled.has("steer_agent_task")) {
    server.registerTool("steer_agent_task", {
      title: "Steer task",
      description: `${experimentalNotice} Send content to task_id when continuing or redirecting a task with an open pull request. Owned tasks require their matching owner_token. Each call consumes credits and is not idempotent; the agent applies it after its current tool call. Returns task_id, accepted, and the pre-steer session_count, then watches the new turn when notifications are configured. Errors explain missing authentication, repository, or an absent/closed pull request.`,
      inputSchema: steerInput,
      outputSchema: steerOutput,
      annotations: toolAnnotations("steer_agent_task", "Steer task"),
    }, async (args) => run(() => steerTask(args, deps)));
  }
  if (enabled.has("abort_agent_task")) {
    server.registerTool("abort_agent_task", {
      title: "Abort task",
      description: `${experimentalNotice} Request cancellation of task_id via the internal steer endpoint; not verified against live GitHub. Owned tasks require their matching owner_token. Use only to stop work, not to read status. Returns accepted, status, and terminal; accepted=false with reason when already finished. Acceptance does not mean cancellation has completed. Check authentication and task access on errors.`,
      inputSchema: abortInput,
      outputSchema: abortOutput,
      annotations: toolAnnotations("abort_agent_task", "Abort task"),
    }, async (args) => run(() => abortTask(args, deps)));
  }
  if (enabled.has("list_copilot_models")) {
    server.registerTool("list_copilot_models", {
      title: "List Copilot models",
      description: "Discover model IDs before create_agent_task. Reads /agents/swe/models and returns source metadata plus models with ID, name, vendor, preview, token prices or billing multiplier, and optional promotion/policy. No parameters. Availability remains subject to repository policy. Errors explain missing authentication, upstream access/network failures, or an invalid upstream response.",
      inputSchema: z.object({}).strict(),
      outputSchema: sweModelsResultSchema,
      annotations: toolAnnotations("list_copilot_models", "List Copilot models"),
    }, async () => run(async () => presentSweModelsResult(await deps.readModels())));
  }
  if (enabled.has("set_completion_strategy")) {
    server.registerTool("set_completion_strategy", {
      title: "Set completion strategy",
      description: "Save the user's completion choice: webhook (recommended) or check_later. Webhook setup stays in the local CLI; never pass URLs or secrets through MCP. For webhook, the receiver must wake the agent that owns the task live—silent or muted handlers miss completions or deliver them late; see Platform notes in the README. Returns strategy and next_step.",
      inputSchema: z.object({ owner_token: ownerTokenInput, strategy: completionStrategySchema.describe("User's choice: webhook notifications or scheduled checks.") }).strict(),
      outputSchema: z.object({ strategy: completionStrategySchema, next_step: z.string() }).strict(),
      annotations: toolAnnotations("set_completion_strategy", "Set completion strategy"),
    }, async (args) => run(() => withStateLock(deps.statePath, (state) =>
      setCompletionStrategy(state, resolveOwnerToken(state, args.owner_token), args.strategy))));
  }
  return server;
}

function toolAnnotations(
  name: (typeof TOOLS)[number]["name"] | "create_agent_task",
  title: string,
) {
  const readOnly = name === "get_agent_task" || name === "list_agent_tasks" || name === "list_copilot_models";
  const destructive = name === "abort_agent_task";
  const idempotent = readOnly || name === "abort_agent_task" || name === "set_completion_strategy";
  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: name !== "set_completion_strategy",
  };
}

async function run(action: () => Promise<object>) {
  try {
    return toolJson(await action() as Record<string, unknown>);
  } catch (error) {
    if (error instanceof OwnerTokenError) {
      return toolError(new CodedToolFailure("owner_token_invalid", "Invalid or missing owner_token. Use the matching token from local webhook register in private MCP client configuration.").toBody());
    }
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
  const parsed = parseRepo(repo);
  const { task, taskOwner, localTask, followUpNow, channels, setup } = await withStateLock(deps.statePath, async (state) => {
    const taskOwner = resolveOwnerToken(state, args.owner_token);
    const key = normalizeModel(model);
    if (state.models.rejected.includes(key)) {
      throw new CodedToolFailure("model_unavailable", modelUnavailableMessage(model, state.models.accepted));
    }
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
    const configured = notificationChannelsForTask(localTask, state);
    localTask.delivery_record = configured.length > 0 ? { status: "pending" } : null;
    localTask.check_after = followUpBlock(configured, false, followUpNow).check_after;
    state.tasks[task.id] = localTask;
    return {
      task, taskOwner, localTask, followUpNow,
      channels: configured,
      setup: completionSetup(state, taskOwner),
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
  const next_step = createFollowUpNextStep(
    planMode,
    taskOwner,
    task.id,
    channels.length > 0 && !watcher_started,
    follow_up.check_after,
  );
  const delivery = deliveryForTask(localTask, channels);
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
  if (setup) body.setup = setup;
  if (session) body.session_url = session;
  const createdPr = prUrl(localTask);
  if (createdPr) body.pr_url = createdPr;
  return body;
}

async function readTask(args: z.infer<typeof getInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const verbose = args.verbose === true;
  const currentState = await readState(deps.statePath);
  const known = currentState.tasks[taskId] ?? null;
  const repo = args.repo?.trim() || known?.repo || "";
  const parsed = repo ? parseRepo(repo) : null;
  const token = deps.readToken();
  const channels = known
    ? notificationChannelsForTask(known, currentState)
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
        tracked = await withStateLock(deps.statePath, (state) => {
          const row = observe(state, remote, {
            repo: repo || state.tasks[taskId]?.repo || "",
            requestedModel: state.tasks[taskId]?.requested_model ?? known.requested_model ?? null,
          });
          row.last_fetched_at = new Date().toISOString();
          return row;
        });
        headRef = headRefOf(remote, tracked);
        cached = false;
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
  const owner = args.owner !== undefined ? validateOwner(args.owner) : undefined;
  const token = deps.readToken();
  const freshness = freshnessMs();
  const now = Date.now();
  const input = {
    ...(owner !== undefined ? { owner } : {}),
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
    const setup = await withStateLock(deps.statePath, (state) => completionSetup(state, owner));
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
      ...(setup ? { setup } : {}),
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
  const updatedState = await readState(deps.statePath);
  const updatedResult = filterTasks(updatedState, input, now);
  registryEmpty = Object.keys(updatedState.tasks).length === 0;
  matchedEmpty = !registryEmpty && updatedResult.total_matched === 0;
  const counts = listCounts(updatedResult.matched);
  const checkAfter = aggregateNextCheckAfter(updatedResult.matched, now);
  const rows = updatedResult.tasks.map((task) => toListRow(task, {
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
  const setup = await withStateLock(deps.statePath, (state) => completionSetup(state, owner));
  if (setup) body.setup = setup;
  return body;
}

async function steerTask(args: z.infer<typeof steerInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const content = required(args.content, "content");
  const initialState = await readState(deps.statePath);
  const initialOwner = resolveOwnerToken(initialState, args.owner_token);
  const known = initialState.tasks[taskId] ?? null;
  if (known?.owner && known.owner !== initialOwner) throw new OwnerTokenError();
  const token = deps.readToken();
  if (!token) throw new CodedToolFailure("not_authenticated", NO_SESSION_MESSAGE);
  const client = deps.clientForToken(token);
  const remote = await client.getTask({
    taskId,
    ...(known?.repo ? parseRepo(known.repo) : {}),
  });
  const repo = known?.repo || repoFromTaskUrl(remote.html_url);
  if (!repo) throw new CodedToolFailure("not_found", `The repository for task ${taskId} is unknown.`);
  const parsed = parseRepo(repo);
  const pull = pullArtifact(remote);
  if (!pull) throw new CodedToolFailure("conflict", `${TASK_HAS_NO_PULL_REQUEST}: task ${taskId} has no pull request.`);
  const number = await resolvePullNumber(client, remote, known, parsed, pull);
  const opened = await client.getPullRequest({ owner: parsed.owner, repo: parsed.repo, number });
  if (opened.state !== "open") {
    throw new CodedToolFailure("conflict", `${TASK_PULL_REQUEST_NOT_OPEN}: pull request ${number} in ${repo} is not open.`);
  }
  const sessionCount = taskSessionCount(remote);
  const steeredAt = new Date().toISOString();
  const { steered, channels } = await withStateLock(deps.statePath, async (state) => {
    const owner = resolveOwnerToken(state, args.owner_token);
    if (state.tasks[taskId]?.owner && state.tasks[taskId]?.owner !== owner) throw new OwnerTokenError();
    await client.steerTask(taskId, content);
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
    return { steered: task, channels: notificationChannelsForTask(task, state) };
  });
  if (steered && shouldSpawnWatcher(channels)) {
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
  const initialState = await readState(deps.statePath);
  const initialOwner = resolveOwnerToken(initialState, args.owner_token);
  const known = initialState.tasks[taskId] ?? null;
  if (known?.owner && known.owner !== initialOwner) throw new OwnerTokenError();
  const token = deps.readToken();
  if (!token) throw new CodedToolFailure("not_authenticated", NO_SESSION_MESSAGE);
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
    return await withStateLock(deps.statePath, async (state) => {
      const owner = resolveOwnerToken(state, args.owner_token);
      const task = state.tasks[taskId];
      if (task?.owner && task.owner !== owner) throw new OwnerTokenError();
      await client.abortTask(taskId);
      if (task) task.last_fetched_at = null;
      const mapped = mapRawState(task?.state ?? "in_progress");
      return {
        task_id: taskId,
        accepted: true,
        status: mapped.status,
        terminal: mapped.terminal,
      };
    });
  } catch (error) {
    if (error instanceof OwnerTokenError) throw error;
    const message = failureMessage(error);
    if (isAbortNoSessionError(message) && known?.repo) {
      const parsed = parseRepo(known.repo);
      const remote = await client.getTask({
        taskId,
        owner: parsed.owner,
        repo: parsed.repo,
      });
      const tracked = await withStateLock(deps.statePath, (state) => {
        const owner = resolveOwnerToken(state, args.owner_token);
        if (state.tasks[taskId]?.owner && state.tasks[taskId]?.owner !== owner) throw new OwnerTokenError();
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
    if (parts.length >= 2 && parts[0] && parts[1] && parts[0] !== "copilot") return `${parts[0]}/${parts[1]}`;
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
