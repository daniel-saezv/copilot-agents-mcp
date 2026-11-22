import { readFileSync } from "node:fs";
import { Ajv, type AnySchema } from "ajv";
import addFormatsDefault from "ajv-formats";
import { GitHubError, API_VERSION, formatApiError, redact } from "./errors.ts";

export type AgentSession = {
  id?: string;
  state?: string;
  created_at?: string;
  completed_at?: string;
  model?: string;
  error?: { message?: string };
  usage?: { type: "ai_credits" | "premium_requests"; amount: number };
};

export type AgentArtifact = {
  provider?: string;
  type?: string;
  data?: { id?: number; head_ref?: string; base_ref?: string };
};

export type AgentTask = {
  id: string;
  state: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  url?: string;
  sessions?: AgentSession[];
  artifacts?: AgentArtifact[];
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
}

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
}): GitHubClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  return {
    createTask(input) {
      const body: Record<string, unknown> = { prompt: input.prompt, model: input.model };
      if (input.base_ref !== undefined) body.base_ref = input.base_ref;
      if (input.head_ref !== undefined) body.head_ref = input.head_ref;
      if (input.custom_agent !== undefined) body.custom_agent = input.custom_agent;
      if (input.create_pull_request !== undefined) body.create_pull_request = input.create_pull_request;
      return request({
        token: options.token,
        fetchImpl,
        baseUrl,
        path: `/agents/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/tasks`,
        method: "POST",
        body,
        validate: createResponse,
        label: "crear la tarea",
      });
    },
    getTask(input) {
      const path = input.owner && input.repo
        ? `/agents/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/tasks/${encodeURIComponent(input.taskId)}`
        : `/agents/tasks/${encodeURIComponent(input.taskId)}`;
      return request({
        token: options.token,
        fetchImpl,
        baseUrl,
        path,
        method: "GET",
        validate: getResponse,
        label: "leer la tarea",
      });
    },
  };
}

async function request(options: {
  token: string;
  fetchImpl: typeof fetch;
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  validate: Validate;
  label: string;
}): Promise<AgentTask> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "user-agent": "copilot-agents-mcp",
    "x-github-api-version": API_VERSION,
  };
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
    throw new GitHubError(redact(`No se pudo llamar a la API de GitHub: ${message}`, options.token));
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
  if (!response.ok) {
    const message = parsed === null && text
      ? `HTTP ${response.status}`
      : formatApiError(response.status, response.headers, parsed);
    throw new GitHubError(redact(message, options.token));
  }
  if (parsed === null) throw new GitHubError(`La respuesta de GitHub no es JSON (HTTP ${response.status}).`);
  assertSchema(options.validate, parsed, options.label);
  return parsed as AgentTask;
}
