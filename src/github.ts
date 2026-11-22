import { readFileSync } from "node:fs";
import { Ajv, type AnySchema } from "ajv";
import addFormatsDefault from "ajv-formats";
import type { AccessTokenSource } from "./auth.ts";
import { GitHubError, API_VERSION, formatApiError, missingPermission, redact, withMissingAppInstall, type GithubPermission } from "./errors.ts";

export type AgentSession = {
  id?: string;
  state?: string;
  created_at?: string;
  completed_at?: string;
  model?: string;
  error?: { message?: string };
  usage?: { type: "ai_credits" | "premium_requests"; amount: number };
  head_ref?: string;
};

export type AgentArtifact = {
  provider?: string;
  type?: string;
  data?: { id?: number; number?: number; html_url?: string; head_ref?: string; base_ref?: string };
};

export type AgentTask = {
  id: string;
  state: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  url?: string;
  session_count?: number;
  sessions?: AgentSession[];
  artifacts?: AgentArtifact[];
};

export type TaskEvent = {
  id?: string;
  timestamp?: string;
  parentId?: string | null;
  type: string;
  data?: unknown;
};

export type TaskEventsPage = {
  events: TaskEvent[];
  total: number;
};

export type CreateTaskInput = {
  owner: string;
  repo: string;
  prompt: string;
  model: string;
  base_ref?: string;
  head_ref?: string;
  custom_agent?: string;
  create_pull_request?: boolean;
};

export interface GitHubClient {
  createTask(input: CreateTaskInput): Promise<AgentTask>;
  getTask(input: { taskId: string; owner?: string; repo?: string }): Promise<AgentTask>;
  findPullRequest(input: { owner: string; repo: string; id: number; headRef: string }): Promise<{ number: number; html_url: string } | null>;
  getPullRequest(input: { owner: string; repo: string; number: number }): Promise<{ number: number; state: string }>;
  steerTask(taskId: string, content: string): Promise<void>;
  abortTask(taskId: string): Promise<void>;
  getTaskEvents(taskId: string, page: number, perPage: number): Promise<TaskEventsPage>;
}

const INTERNAL_AGENTS_BASE = "https://api.github.com/cmc_internal/api/agents";

type Validate = ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };

const SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "enum",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "const",
  "not",
]);

function openApiToJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((item) => openApiToJsonSchema(item));
  if (!schema || typeof schema !== "object") return schema;
  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "format" && value !== "date-time") continue;
    output[key] = openApiToJsonSchema(value);
  }
  if (input.nullable === true) {
    const type = output.type;
    if (typeof type === "string") output.type = [type, "null"];
    else if (Array.isArray(type) && !type.includes("null")) output.type = [...type, "null"];
    else if (Array.isArray(output.oneOf)) output.oneOf = [...output.oneOf, { type: "null" }];
    else output.type = ["null"];
  }
  return output;
}

function loadValidator(name: string): Validate {
  const file = new URL(`../fixtures/openapi/${name}`, import.meta.url);
  const payload = JSON.parse(readFileSync(file, "utf8")) as { schema: unknown };
  const ajv = new Ajv({ allErrors: true, strict: false });
  const addFormats = addFormatsDefault as unknown as ((instance: Ajv) => void) & { default?: (instance: Ajv) => void };
  (addFormats.default ?? addFormats)(ajv);
  return ajv.compile(openApiToJsonSchema(payload.schema) as AnySchema) as Validate;
}

const createResponse = loadValidator("create-task.response.json");
const getResponse = loadValidator("get-task.response.json");

const officialSchemas = {
  "create-task.response.json": createResponse,
  "get-task.response.json": getResponse,
} as const;

export function officialSchema(name: keyof typeof officialSchemas): Validate {
  return officialSchemas[name];
}

export function assertSchema(validate: Validate, value: unknown, label: string): void {
  if (validate(value)) return;
  const details = (validate.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "inválido"}`)
    .join("; ");
  throw new GitHubError(`La respuesta de GitHub no cumple el esquema de ${label}: ${details}`);
}

export function createGitHubClient(options: {
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  internalBaseUrl?: string;
  tokens?: AccessTokenSource;
}): GitHubClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const internalBaseUrl = (options.internalBaseUrl ?? INTERNAL_AGENTS_BASE).replace(/\/$/, "");
  const tokens = options.tokens;
  return {
    createTask(input) {
      const body: Record<string, unknown> = { prompt: input.prompt, model: input.model };
      if (input.base_ref !== undefined) body.base_ref = input.base_ref;
      if (input.head_ref !== undefined) body.head_ref = input.head_ref;
      if (input.custom_agent !== undefined) body.custom_agent = input.custom_agent;
      if (input.create_pull_request !== undefined) body.create_pull_request = input.create_pull_request;
      return request({
        token: options.token,
        tokens,
        fetchImpl,
        baseUrl,
        path: `/agents/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/tasks`,
        method: "POST",
        body,
        validate: createResponse,
        label: "crear la tarea",
        permission: "Agent tasks",
      });
    },
    getTask(input) {
      const path = input.owner && input.repo
        ? `/agents/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/tasks/${encodeURIComponent(input.taskId)}`
        : `/agents/tasks/${encodeURIComponent(input.taskId)}`;
      return request({
        token: options.token,
        tokens,
        fetchImpl,
        baseUrl,
        path,
        method: "GET",
        validate: getResponse,
        label: "leer la tarea",
        permission: "Agent tasks",
      });
    },
    async findPullRequest(input) {
      const query = new URLSearchParams({
        state: "all",
        head: `${input.owner}:${input.headRef}`,
        per_page: "100",
      });
      const parsed = await callGitHub({
        token: options.token,
        tokens,
        fetchImpl,
        baseUrl,
        path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls?${query.toString()}`,
        method: "GET",
        permission: "Pull requests",
      });
      return matchPull(parsed, input.id);
    },
    async getPullRequest(input) {
      const parsed = await callGitHub({
        token: options.token,
        tokens,
        fetchImpl,
        baseUrl,
        path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${encodeURIComponent(String(input.number))}`,
        method: "GET",
        permission: "Pull requests",
      });
      return readPullState(parsed, input.number);
    },
    async steerTask(taskId, content) {
      await callGitHub({
        token: options.token,
        tokens,
        fetchImpl,
        baseUrl: internalBaseUrl,
        path: `/tasks/${encodeURIComponent(taskId)}/steer`,
        method: "POST",
        body: { content, type: "user_message" },
        profile: "internal",
        acceptEmpty: true,
        permission: "Contents: write",
      });
    },
    async abortTask(taskId) {
      await callGitHub({
        token: options.token,
        tokens,
        fetchImpl,
        baseUrl: internalBaseUrl,
        path: `/tasks/${encodeURIComponent(taskId)}/steer`,
        method: "POST",
        body: { type: "abort" },
        profile: "internal",
        acceptEmpty: true,
        permission: "Contents: write",
      });
    },
    async getTaskEvents(taskId, page, perPage) {
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1) {
        throw new GitHubError("page y per_page tienen que ser enteros mayores que cero.");
      }
      const query = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      const parsed = await callGitHub({
        token: options.token,
        tokens,
        fetchImpl,
        baseUrl: internalBaseUrl,
        path: `/tasks/${encodeURIComponent(taskId)}/events?${query.toString()}`,
        method: "GET",
        profile: "internal",
        permission: "Agent tasks",
      });
      return parseTaskEvents(parsed);
    },
  };
}

async function request(options: GitHubCall & { validate: Validate; label: string }): Promise<AgentTask> {
  const parsed = await callGitHub(options);
  assertSchema(options.validate, parsed, options.label);
  return parsed as AgentTask;
}

type GitHubCall = {
  token: string;
  tokens?: AccessTokenSource;
  fetchImpl: typeof fetch;
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  profile?: "public" | "internal";
  acceptEmpty?: boolean;
  permission: GithubPermission;
};

async function callGitHub(options: GitHubCall): Promise<unknown> {
  const firstToken = options.tokens ? await options.tokens.current() : options.token;
  const first = await sendGitHub(options, firstToken);
  if (first.response.status === 401 && options.tokens) {
    const nextToken = await options.tokens.refresh(firstToken);
    return acceptGitHub(options, await sendGitHub(options, nextToken), nextToken);
  }
  return acceptGitHub(options, first, firstToken);
}

async function sendGitHub(options: GitHubCall, token: string): Promise<{ response: Response; parsed: unknown; text: string }> {
  const profile = options.profile ?? "public";
  const headers: Record<string, string> = {
    accept: profile === "internal" ? "application/json" : "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "copilot-agents-mcp",
  };
  if (profile === "public") headers["x-github-api-version"] = API_VERSION;
  if (options.body) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await options.fetchImpl(`${options.baseUrl}${options.path}`, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: "error",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "error de red";
    throw new GitHubError(redact(`No se pudo llamar a la API de GitHub: ${message}`, token));
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { response, parsed, text };
}

function acceptGitHub(options: GitHubCall, sent: { response: Response; parsed: unknown; text: string }, token: string): unknown {
  const { response, parsed, text } = sent;
  if (!response.ok) {
    const detail = parsed === null && text
      ? `HTTP ${response.status}`
      : formatApiError(response.status, response.headers, parsed);
    const missing = missingPermission(response.status, response.headers, parsed ?? text, options.permission);
    const message = missing ? `${missing} ${detail}` : detail;
    const annotated = withMissingAppInstall(message, response.status, options.path, options.tokens !== undefined);
    throw new GitHubError(redact(annotated, token));
  }
  if (options.acceptEmpty && response.status === 202) return undefined;
  if (parsed === null) throw new GitHubError(`La respuesta de GitHub no es JSON (HTTP ${response.status}).`);
  return parsed;
}

function readPullState(parsed: unknown, number: number): { number: number; state: string } {
  if (!parsed || typeof parsed !== "object") throw new GitHubError(`La pull request ${number} no es un objeto.`);
  const record = parsed as Record<string, unknown>;
  if (record.number !== number || typeof record.state !== "string" || !record.state) {
    throw new GitHubError(`La pull request ${number} no trae state.`);
  }
  return { number, state: record.state };
}

function parseTaskEvents(parsed: unknown): TaskEventsPage {
  if (!parsed || typeof parsed !== "object") throw new GitHubError("La respuesta de eventos no es un objeto.");
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.events) || typeof record.total !== "number") {
    throw new GitHubError("La respuesta de eventos no trae events y total.");
  }
  const events: TaskEvent[] = [];
  for (const item of record.events) {
    if (!item || typeof item !== "object") throw new GitHubError("Un evento no es un objeto.");
    const event = item as Record<string, unknown>;
    if (typeof event.type !== "string" || !event.type) throw new GitHubError("Un evento no trae type.");
    const parsedEvent: TaskEvent = { type: event.type };
    if (typeof event.id === "string") parsedEvent.id = event.id;
    if (typeof event.timestamp === "string") parsedEvent.timestamp = event.timestamp;
    if (typeof event.parentId === "string" || event.parentId === null) parsedEvent.parentId = event.parentId;
    if ("data" in event) parsedEvent.data = event.data;
    events.push(parsedEvent);
  }
  return { events, total: record.total };
}

function matchPull(parsed: unknown, id: number): { number: number; html_url: string } | null {
  if (!Array.isArray(parsed)) throw new GitHubError("La respuesta de pull requests no es una lista.");
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.id !== id) continue;
    if (typeof record.number !== "number" || typeof record.html_url !== "string" || !record.html_url) {
      throw new GitHubError(`La pull request ${id} no trae number y html_url.`);
    }
    return { number: record.number, html_url: record.html_url };
  }
  return null;
}
