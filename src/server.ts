import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { failureMessage, modelUnavailableMessage, TASK_HAS_NO_PULL_REQUEST, TASK_PULL_REQUEST_NOT_OPEN, toolError, toolJson, ToolFailure } from "./errors.ts";
import type { AgentTask, GitHubClient, TaskEvent } from "./github.ts";
import { sweModelsResultSchema, type SweModelsResult } from "./swe-models.ts";
import { selectToolNames, TOOLS, type Selection } from "./selection.ts";
import { appendWatcherLog } from "./notify.ts";
import { armSteer, fillPullRequest, headRefOf, initialTask, normalizeModel, observe, taskSessionCount, toNotice, withStateLock } from "./state.ts";
import { startDetachedWatcher } from "./watch.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export type ServerDeps = {
  clientForToken: (token: string) => GitHubClient;
  statePath: string;
  readToken: () => string | null;
  readModels: () => Promise<SweModelsResult>;
  launchWatcher: () => void;
};

const createInput = z.object({
  repo: z.string().describe("Repositorio en la forma owner/name."),
  prompt: z.string().describe("Instrucción para el agente."),
  model: z.string().describe("Modelo. Se envía tal cual a la API, sin una lista cerrada."),
  base_ref: z.string().optional().describe("Rama base para la rama nueva o la pull request."),
  head_ref: z.string().optional().describe("Rama existente. Con base_ref, el agente hace commit en esa rama."),
  custom_agent: z.string().optional().describe("Nombre del custom agent, sin la extensión."),
  create_pull_request: z.boolean().optional().describe("Si es true, la API abre una pull request."),
}).strict();

const createOutput = z.object({
  task_id: z.string(),
  repo: z.string(),
  state: z.string(),
  requested_model: z.string(),
  created_at: z.string().nullable(),
  html_url: z.string().nullable(),
}).strict();

const artifactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pull"), id: z.number() }).strict(),
  z.object({ type: z.literal("branch"), head_ref: z.string(), base_ref: z.string() }).strict(),
]);

const usageSchema = z.object({
  type: z.enum(["ai_credits", "premium_requests"]),
  amount: z.number().describe("Valor crudo de la API. Con ai_credits está en nano unidades."),
  amount_human: z.number().describe("ai_credits dividido entre 1e9. premium_requests se deja igual."),
}).strict();

const pullRequestSchema = z.object({
  id: z.number().describe("Id interno de la API. No es el número de la pull request."),
  number: z.number().nullable(),
  html_url: z.string().nullable(),
}).strict();

const statusOutput = z.object({
  task_id: z.string(),
  repo: z.string(),
  state: z.string(),
  requested_model: z.string().nullable(),
  resolved_model: z.string().nullable().describe("sessions[].model, tal como lo devuelve la API."),
  pull_request: pullRequestSchema.nullable(),
  branch: z.object({ head_ref: z.string(), base_ref: z.string() }).strict().nullable(),
  artifacts: z.array(artifactSchema),
  error: z.string().nullable(),
  usage: usageSchema.nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  completed_at: z.string().nullable(),
}).strict();

const getInput = z.object({
  task_id: z.string().describe("Identificador de la tarea."),
  repo: z.string().optional().describe("Repositorio owner/name. Si se omite, se usa el guardado al lanzar o el endpoint de usuario."),
}).strict();

const experimental = "Endpoints internos no documentados de GitHub que pueden cambiar sin aviso. Cada steer consume créditos. El agente aplica la instrucción después de terminar la herramienta que esté ejecutando.";

const steerInput = z.object({
  task_id: z.string().describe("Identificador de la tarea."),
  content: z.string().describe("Instrucción que se envía a la tarea."),
}).strict();

const steerOutput = z.object({
  task_id: z.string(),
  accepted: z.boolean(),
  session_count: z.number(),
}).strict();

const abortInput = z.object({
  task_id: z.string().describe("Identificador de la tarea."),
}).strict();

const abortOutput = z.object({
  task_id: z.string(),
  accepted: z.boolean(),
}).strict();

const eventsInput = z.object({
  task_id: z.string().describe("Identificador de la tarea."),
  page: z.number().int().positive().describe("Página, desde 1."),
  per_page: z.number().int().positive().describe("Eventos por página."),
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
    version: pkg.version,
  });
  if (enabled.has("create_agent_task")) {
    server.registerTool("create_agent_task", {
      title: "Lanzar tarea de Copilot",
      description: "Lanza una tarea del agente de Copilot en la nube. El modelo se envía tal cual. Si ese modelo ya se vio rechazado, no llama a la API y lista los modelos vistos aceptados.",
      inputSchema: createInput,
      outputSchema: createOutput,
      annotations: annotations("POST", "Lanzar tarea de Copilot"),
    }, async (args) => run(() => createTask(args, deps)));
  }
  if (enabled.has("get_agent_task")) {
    server.registerTool("get_agent_task", {
      title: "Estado de una tarea",
      description: "Lee una vez el estado de una tarea del agente de Copilot.",
      inputSchema: getInput,
      outputSchema: statusOutput,
      annotations: annotations("GET", "Estado de una tarea"),
    }, async (args) => run(() => readTask(args, deps)));
  }
  if (enabled.has("steer_agent_task")) {
    server.registerTool("steer_agent_task", {
      title: "Redirigir una tarea",
      description: `[Experimental] ${experimental} Envía una instrucción a una tarea con pull request abierta.`,
      inputSchema: steerInput,
      outputSchema: steerOutput,
      annotations: annotations("POST", "Redirigir una tarea"),
    }, async (args) => run(() => steerTask(args, deps)));
  }
  if (enabled.has("abort_agent_task")) {
    server.registerTool("abort_agent_task", {
      title: "Abortar una tarea",
      description: `[Experimental] ${experimental} Aborta una tarea.`,
      inputSchema: abortInput,
      outputSchema: abortOutput,
      annotations: annotations("POST", "Abortar una tarea"),
    }, async (args) => run(() => abortTask(args, deps)));
  }
  if (enabled.has("get_agent_task_events")) {
    server.registerTool("get_agent_task_events", {
      title: "Eventos de una tarea",
      description: `[Experimental] ${experimental} Lee una página de eventos de una tarea.`,
      inputSchema: eventsInput,
      outputSchema: eventsOutput,
      annotations: annotations("GET", "Eventos de una tarea"),
    }, async (args) => run(() => readEvents(args, deps)));
  }
  if (enabled.has("list_copilot_models")) {
    server.registerTool("list_copilot_models", {
      title: "Modelos de Copilot",
      description: "Lee /agents/swe/models y devuelve id, nombre, vendor, preview, el precio por tokens o el multiplier, y la promo si existe.",
      inputSchema: z.object({}).strict(),
      outputSchema: sweModelsResultSchema,
      annotations: annotations("GET", "Modelos de Copilot"),
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
  if (!token) throw new ToolFailure("Falta la variable de entorno GITHUB_PERSONAL_ACCESS_TOKEN.");
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
  try {
    deps.launchWatcher();
  } catch (error) {
    console.error(`No se pudo arrancar el vigilante: ${error instanceof Error ? error.message : "error"}.`);
  }
  return {
    task_id: task.id,
    repo,
    state: task.state,
    requested_model: model,
    created_at: task.created_at ?? null,
    html_url: task.html_url ?? null,
  };
}

async function readTask(args: z.infer<typeof getInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const known = await withStateLock(deps.statePath, (state) => state.tasks[taskId] ?? null);
  const repo = args.repo?.trim() || known?.repo || "";
  const parsed = repo ? parseRepo(repo) : null;
  const token = deps.readToken();
  if (!token) throw new ToolFailure("Falta la variable de entorno GITHUB_PERSONAL_ACCESS_TOKEN.");
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
  if (!token) throw new ToolFailure("Falta la variable de entorno GITHUB_PERSONAL_ACCESS_TOKEN.");
  const client = deps.clientForToken(token);
  const known = await withStateLock(deps.statePath, (state) => state.tasks[taskId] ?? null);
  const remote = await client.getTask({
    taskId,
    ...(known?.repo ? parseRepo(known.repo) : {}),
  });
  const repo = known?.repo || repoFromTaskUrl(remote.html_url);
  if (!repo) throw new ToolFailure(`No se conoce el repositorio de la tarea ${taskId}.`);
  const parsed = parseRepo(repo);
  const pull = pullArtifact(remote);
  if (!pull) throw new ToolFailure(`${TASK_HAS_NO_PULL_REQUEST}: la tarea ${taskId} no tiene pull request.`);
  const number = await resolvePullNumber(client, remote, known, parsed, pull);
  const opened = await client.getPullRequest({ owner: parsed.owner, repo: parsed.repo, number });
  if (opened.state !== "open") {
    throw new ToolFailure(`${TASK_PULL_REQUEST_NOT_OPEN}: la pull request ${number} de ${repo} no está abierta.`);
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
    console.error(`No se pudo arrancar el vigilante: ${error instanceof Error ? error.message : "error"}.`);
  }
  return { task_id: taskId, accepted: true, session_count: sessionCount };
}

async function abortTask(args: z.infer<typeof abortInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const token = deps.readToken();
  if (!token) throw new ToolFailure("Falta la variable de entorno GITHUB_PERSONAL_ACCESS_TOKEN.");
  await deps.clientForToken(token).abortTask(taskId);
  return { task_id: taskId, accepted: true };
}

async function readEvents(args: z.infer<typeof eventsInput>, deps: ServerDeps) {
  const taskId = required(args.task_id, "task_id");
  const token = deps.readToken();
  if (!token) throw new ToolFailure("Falta la variable de entorno GITHUB_PERSONAL_ACCESS_TOKEN.");
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
  if (!headRef) throw new ToolFailure(`No se puede comprobar la pull request ${pull.id} de la tarea ${task.id}: falta head_ref.`);
  const found = await client.findPullRequest({ owner: repo.owner, repo: repo.repo, id: pull.id, headRef });
  if (!found) throw new ToolFailure(`No se puede comprobar la pull request ${pull.id} de la tarea ${task.id}: la lista no incluye esa id.`);
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
  if (!match?.[1] || !match[2]) throw new ToolFailure("repo debe tener la forma owner/name.");
  return { owner: match[1], repo: match[2] };
}

export function defaultLaunchWatcher(): void {
  startDetachedWatcher();
}

export { TOOLS };
