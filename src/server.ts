import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { failureMessage, modelUnavailableMessage, NO_SESSION_MESSAGE, TASK_HAS_NO_PULL_REQUEST, TASK_PULL_REQUEST_NOT_OPEN, toolError, toolJson, ToolFailure } from "./errors.ts";
import type { AgentTask, GitHubClient, TaskEvent } from "./github.ts";
import { sweModelsResultSchema, type SweModelsResult } from "./swe-models.ts";
import { selectToolNames, TOOLS, type Selection } from "./selection.ts";
import { activeNotificationChannels, appendWatcherLog } from "./notify.ts";
import { armSteer, fillPullRequest, headRefOf, initialTask, normalizeModel, observe, taskSessionCount, toNotice, withStateLock } from "./state.ts";
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

const createInput = z.object({
  repo: z.string().describe("Repository in owner/name form."),
  prompt: z.string().describe("Instructions for the agent."),
  model: z.string().describe("Model sent unchanged to the API without a closed allowlist."),
  base_ref: z.string().optional().describe("Base branch for a new branch or pull request."),
  head_ref: z.string().optional().describe("Existing branch. With base_ref, the agent commits to this branch."),
  custom_agent: z.string().optional().describe("Custom agent name without the extension."),
  create_pull_request: z.boolean().optional().describe("When true, the API creates a pull request."),
}).strict();

const notificationOutput = z.object({
  channels: z.array(z.enum(["system", "webhook"])),
  watcher_started: z.boolean(),
}).strict();

const createOutput = z.object({
  task_id: z.string(),
  repo: z.string(),
  state: z.string(),
  requested_model: z.string(),
  created_at: z.string().nullable(),
  html_url: z.string().nullable(),
  notification: notificationOutput,
}).strict();

const SERVER_INSTRUCTIONS = [
  "GitHub Copilot agent tasks run in the cloud and often take minutes.",
  "create_agent_task returns right after the task is queued; do not wait on the tool or poll get_agent_task in a loop.",
  "End your turn after create_agent_task; completion is signaled outside MCP (see notification.channels in the create response).",
  "Call get_agent_task once later when the user asks or after you receive a completion signal.",
].join(" ");

const CREATE_TASK_GUIDANCE = "Returns immediately; do not poll in a loop—end your turn and wait for notification.channels or a user prompt before calling get_agent_task.";

const artifactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pull"), id: z.number() }).strict(),
  z.object({ type: z.literal("branch"), head_ref: z.string(), base_ref: z.string() }).strict(),
]);

const usageSchema = z.object({
  type: z.enum(["ai_credits", "premium_requests"]),
  amount: z.number().describe("Raw value from the API. ai_credits uses nano-units."),
  amount_human: z.number().describe("ai_credits divided by 1e9. premium_requests is unchanged."),
}).strict();

const pullRequestSchema = z.object({
  id: z.number().describe("Internal API ID, not the pull request number."),
  number: z.number().nullable(),
  html_url: z.string().nullable(),
}).strict();

const statusOutput = z.object({
  task_id: z.string(),
  repo: z.string(),
  state: z.string(),
  requested_model: z.string().nullable(),
  resolved_model: z.string().nullable().describe("sessions[].model exactly as returned by the API."),
  pull_request: pullRequestSchema.nullable(),
  branch: z.object({ head_ref: z.string(), base_ref: z.string() }).strict().nullable(),
  artifacts: z.array(artifactSchema),
  error: z.string().nullable(),
  usage: usageSchema.nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  session_id: z.string().nullable().describe("ID of the task's latest session."),
  notified: z.boolean().describe("True when the watcher recorded a successful completion notification."),
}).strict();

const getInput = z.object({
  task_id: z.string().describe("Task identifier."),
  repo: z.string().optional().describe("Repository in owner/name form. If omitted, use the saved repository or user endpoint."),
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
}).strict();

const eventsInput = z.object({
  task_id: z.string().describe("Task identifier."),
  page: z.number().int().positive().describe("Page, starting at 1."),
  per_page: z.number().int().positive().describe("Events per page."),
}).strict();

const eventOutput = z.object({
  id: z.string().nullable(),
  timestamp: z.string().nullable(),
  parentId: z.string().nullable(),
  type: z.string(),
  data: z.unknown(),
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
      annotations: annotations("POST", "Launch Copilot task"),
    }, async (args) => run(() => createTask(args, deps)));
  }
  if (enabled.has("get_agent_task")) {
    server.registerTool("get_agent_task", {
      title: "Get task status",
      description: "Read a GitHub Copilot agent task once.",
      inputSchema: getInput,
      outputSchema: statusOutput,
      annotations: annotations("GET", "Get task status"),
    }, async (args) => run(() => readTask(args, deps)));
  }
  if (enabled.has("steer_agent_task")) {
    server.registerTool("steer_agent_task", {
      title: "Steer task",
      description: `${experimentalNotice} Each steer consumes credits. The agent applies the instruction after its current tool call finishes. Send an instruction to a task with an open pull request.`,
      inputSchema: steerInput,
      outputSchema: steerOutput,
      annotations: annotations("POST", "Steer task"),
    }, async (args) => run(() => steerTask(args, deps)));
  }
  if (enabled.has("abort_agent_task")) {
    server.registerTool("abort_agent_task", {
      title: "Abort task",
      description: `${experimentalNotice} Send {type: "abort"} to the steer endpoint, as VS Code does in tasksClient.ts, to stop the task. This has not been verified against GitHub.`,
      inputSchema: abortInput,
      outputSchema: abortOutput,
      annotations: annotations("POST", "Abort task"),
    }, async (args) => run(() => abortTask(args, deps)));
  }
  if (enabled.has("get_agent_task_events")) {
    server.registerTool("get_agent_task_events", {
      title: "Get task events",
      description: `${experimentalNotice} Read one page of task events (read-only).`,
      inputSchema: eventsInput,
      outputSchema: eventsOutput,
      annotations: annotations("GET", "Get task events"),
    }, async (args) => run(() => readEvents(args, deps)));
  }
  if (enabled.has("list_copilot_models")) {
    server.registerTool("list_copilot_models", {
      title: "List Copilot models",
      description: "Read /agents/swe/models and return the ID, name, vendor, preview flag, token prices or multiplier, and promotion when present.",
      inputSchema: z.object({}).strict(),
      outputSchema: sweModelsResultSchema,
      annotations: annotations("GET", "List Copilot models"),
    }, async () => run(() => deps.readModels()));
  }
  return server;
}

function annotations(method: "GET" | "POST", title: string) {
  return {
    title,
    readOnlyHint: method === "GET",
    destructiveHint: false,
    idempotentHint: method === "GET",
    openWorldHint: true,
  };
}

async function run(action: () => Promise<object>) {
  try {
    return toolJson(await action() as Record<string, unknown>);
  } catch (error) {
    return toolError(failureMessage(error));
  }
}

async function createTask(args: z.infer<typeof createInput>, deps: ServerDeps) {
  const repo = required(args.repo, "repo");
  const prompt = required(args.prompt, "prompt");
  const model = required(args.model, "model");
  const parsed = parseRepo(repo);
  const blocked = await withStateLock(deps.statePath, (state) => {
    const key = normalizeModel(model);
    if (!state.models.rejected.includes(key)) return null;
    return modelUnavailableMessage(model, state.models.accepted);
  });
  if (blocked) throw new ToolFailure(blocked);
  const token = deps.readToken();
  if (!token) throw new ToolFailure(NO_SESSION_MESSAGE);
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
  await withStateLock(deps.statePath, (state) => {
    state.tasks[task.id] = initialTask({
      id: task.id,
      repo,
      requestedModel: model,
      state: task.state,
      createdAt: task.created_at ?? null,
      updatedAt: task.updated_at ?? null,
    });
  });
  let watcher_started = false;
  try {
    deps.launchWatcher();
    watcher_started = true;
  } catch (error) {
    console.error(`Could not start the watcher: ${error instanceof Error ? error.message : "error"}.`);
  }
  return {
    task_id: task.id,
    repo,
    state: task.state,
    requested_model: model,
    created_at: task.created_at ?? null,
    html_url: task.html_url ?? null,
    notification: {
      channels: activeNotificationChannels(process.platform, process.env),
      watcher_started,
    },
  };
}

async function readTask(args: z.infer<typeof getInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const known = await withStateLock(deps.statePath, (state) => state.tasks[taskId] ?? null);
  const repo = args.repo?.trim() || known?.repo || "";
  const parsed = repo ? parseRepo(repo) : null;
  const token = deps.readToken();
  if (!token) throw new ToolFailure(NO_SESSION_MESSAGE);
  const client = deps.clientForToken(token);
  const remote = await client.getTask({
    taskId,
    ...(parsed ? { owner: parsed.owner, repo: parsed.repo } : {}),
  });
  const tracked = await withStateLock(deps.statePath, (state) => {
    return observe(state, remote, {
      repo: repo || state.tasks[taskId]?.repo || "",
      requestedModel: state.tasks[taskId]?.requested_model ?? known?.requested_model ?? null,
    });
  });
  await fillPullRequest(
    tracked,
    (input) => client.findPullRequest(input),
    (line) => appendWatcherLog(line),
    headRefOf(remote, tracked),
  );
  await withStateLock(deps.statePath, (state) => {
    const saved = state.tasks[tracked.task_id];
    if (saved) saved.pull_request = tracked.pull_request;
  });
  return toNotice(tracked);
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
  try {
    deps.launchWatcher();
  } catch (error) {
    console.error(`Could not start the watcher: ${error instanceof Error ? error.message : "error"}.`);
  }
  return { task_id: taskId, accepted: true, session_count: sessionCount };
}

async function abortTask(args: z.infer<typeof abortInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const token = deps.readToken();
  if (!token) throw new ToolFailure(NO_SESSION_MESSAGE);
  await deps.clientForToken(token).abortTask(taskId);
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
  return {
    id: event.id ?? null,
    timestamp: event.timestamp ?? null,
    parentId: event.parentId ?? null,
    type: event.type,
    data: event.data ?? null,
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
  if (!value.trim()) throw new ToolFailure(`missing required parameter: ${name}`);
  return value.trim();
}

export function parseRepo(repo: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!match?.[1] || !match[2]) throw new ToolFailure("repo must use the owner/name form.");
  return { owner: match[1], repo: match[2] };
}

export function defaultLaunchWatcher(): void {
  startDetachedWatcher();
}

export { TOOLS };
