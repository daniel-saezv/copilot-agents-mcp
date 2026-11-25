import { compactStringify, compactValue } from "./compact.ts";

export const API_VERSION = "2026-03-10";
export const GITHUB_APP_SLUG = "copilot-agents-mcp";

export function githubAppInstallUrl(): string {
  return `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;
}

export function appNotInstalledMessage(): string {
  return `The app is not installed in any repository. Install it at ${githubAppInstallUrl()}.`;
}

export const TASK_HAS_NO_PULL_REQUEST = "task_has_no_pull_request";
export const TASK_PULL_REQUEST_NOT_OPEN = "task_pull_request_not_open";

export class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}

export const NO_SESSION_MESSAGE =
  "No GitHub session is available. A prior `npx copilot-agents-mcp login` stores credentials in the OS keyring, which may be unreachable from this process (for example a different D-Bus session on Linux). Set GITHUB_PERSONAL_ACCESS_TOKEN in the environment or run `npx copilot-agents-mcp login` in the same session as this server.";

export const NO_SESSION_STALE_WARNING =
  "No GitHub session in this process; returning stored data only (not refreshed). Set GITHUB_PERSONAL_ACCESS_TOKEN or run `npx copilot-agents-mcp login`.";

export type GithubPermission = "Agent tasks" | "Pull requests" | "Contents: write";

export type ErrorCode =
  | "invalid_argument"
  | "owner_token_invalid"
  | "not_authenticated"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_timeout"
  | "upstream_error"
  | "model_unavailable"
  | "conflict";

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retry_after_s?: number;
  };
};

export class CodedToolFailure extends ToolFailure {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retry_after_s?: number;

  constructor(code: ErrorCode, message: string, options?: { retryable?: boolean; retry_after_s?: number }) {
    super(message);
    this.name = "CodedToolFailure";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.retry_after_s = options?.retry_after_s;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
      },
    };
    if (this.retry_after_s !== undefined) body.error.retry_after_s = this.retry_after_s;
    return body;
  }
}

type ApiFailure = ErrorBody["error"];

export class GitHubError extends CodedToolFailure {
  constructor(message: string, failure?: Omit<ApiFailure, "message">) {
    super(failure?.code ?? "upstream_error", message, failure);
    this.name = "GitHubError";
  }
}

export class ModelsError extends CodedToolFailure {
  constructor(message: string, failure?: Omit<ApiFailure, "message">) {
    super(failure?.code ?? "upstream_error", message, failure);
    this.name = "ModelsError";
  }
}

export function toolError(message: string | ErrorBody) {
  const body = typeof message === "string" ? legacyErrorBody(message) : message;
  const text = compactStringify(body);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

export function toolJson(value: Record<string, unknown>) {
  const compact = compactValue(value) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: compactStringify(compact) }],
    structuredContent: compact,
  };
}

function legacyErrorBody(message: string): ErrorBody {
  return {
    error: {
      code: classifyMessage(message),
      message,
      retryable: /retry after \d+ seconds/i.test(message) || message.includes("rate limit"),
      ...(retryAfterFromMessage(message) !== undefined ? { retry_after_s: retryAfterFromMessage(message) } : {}),
    },
  };
}

function classifyMessage(message: string): ErrorCode {
  if (message === NO_SESSION_MESSAGE) return "not_authenticated";
  if (/missing required parameter/i.test(message)) return "invalid_argument";
  if (/^repo must use/i.test(message)) return "invalid_argument";
  if (/is not available\. Accepted models/i.test(message)) return "model_unavailable";
  if (/HTTP 404/.test(message) || /not found/i.test(message)) return "not_found";
  if (/HTTP 403/.test(message) || /Missing .* permission/i.test(message)) return "forbidden";
  if (/HTTP 429/.test(message) || /rate limit/i.test(message)) return "rate_limited";
  if (/HTTP 504|timeout/i.test(message)) return "upstream_timeout";
  if (/HTTP \d+/.test(message)) return "upstream_error";
  return "invalid_argument";
}

function retryAfterFromMessage(message: string): number | undefined {
  const match = /retry after (\d+) seconds/i.exec(message);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export function failureToError(error: unknown): ErrorBody {
  if (error instanceof CodedToolFailure) return error.toBody();
  const message = failureMessage(error);
  return legacyErrorBody(message);
}

export function failureMessage(error: unknown): string {
  if (
    error instanceof ToolFailure
    || error instanceof GitHubError
    || error instanceof ModelsError
    || error instanceof AuthError
    || error instanceof KeyringError
  ) {
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Unexpected error.";
}

export function modelUnavailableMessage(model: string, accepted: readonly string[]): string {
  const list = accepted.length > 0 ? [...accepted].sort().join(", ") : "none";
  return `The model "${model}" is not available. Accepted models observed: ${list}.`;
}

const MODEL_UNAVAILABLE = /model (?:is not|isn.?t) available/i;

export function isModelUnavailable(message: string): boolean {
  return MODEL_UNAVAILABLE.test(message);
}

type HeaderLookup = { get(name: string): string | null };

export function formatApiError(status: number, headers: HeaderLookup, body: unknown): string {
  return apiFailure(status, headers, body).message;
}

export function apiFailure(
  status: number,
  headers: HeaderLookup,
  body: unknown,
  context?: { permission?: GithubPermission; createTask?: boolean; appRepository?: boolean },
): ApiFailure {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const upstreamMessage = typeof body === "string" ? body : typeof record.message === "string" ? record.message : "";
  const retry = retrySeconds(headers);
  const limited = status === 429 || (status === 403 && (
    retry !== null || headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(upstreamMessage)
  ));
  let code: ErrorCode = "upstream_error";
  let hint = "The upstream request failed. Check GitHub service status before trying again.";
  if (limited) {
    code = "rate_limited";
    hint = "GitHub rate limit exceeded. Wait before trying again.";
  } else if (status === 401) {
    code = "not_authenticated";
    hint = "Authentication failed. Run `npx copilot-agents-mcp login` or check GITHUB_PERSONAL_ACCESS_TOKEN.";
  } else if (status === 403) {
    code = "forbidden";
    hint = "Access denied. Check repository access and credential permissions.";
    if (context?.createTask) {
      hint += " Copilot coding agent may not be enabled for this repository. Ask a repository or organization administrator to enable it and check the organization's model policy for agent tasks.";
    }
  } else if (status === 404) {
    code = "not_found";
    hint = "Resource not found or is not accessible. Check the repository or task ID and your access.";
    if (context?.appRepository) hint += ` Install the app for the repository: ${githubAppInstallUrl()}.`;
  } else if (status === 400 || status === 422) {
    code = "invalid_argument";
    hint = "Validation Failed. Check the task arguments.";
    const details = flattenErrors(record.errors);
    if (details) hint = `Validation Failed: ${details}. Check the task arguments.`;
  } else if (status === 409) {
    code = "conflict";
    hint = "The request conflicts with the current state. Read the task's current status before trying again.";
  } else if (status === 408 || status === 504) {
    code = "upstream_timeout";
    hint = "The upstream request timed out. Check the task's current status before trying again.";
  }
  if ([400, 409, 422].includes(status) && /^cannot abort:\s*no active session[.!]?$/i.test(upstreamMessage.trim())) {
    hint = "cannot abort: no active session. Read the task's current status.";
  }
  if ((status === 403 || status === 422) && /model/i.test(upstreamMessage)
    && /not (?:allowed|available|enabled|supported)|disabled|policy|isn.?t available/i.test(upstreamMessage)) {
    hint += " The selected model is not allowed or available for agent tasks. Use list_copilot_models and check the organization's model policy.";
  }
  const missing = context?.permission ? missingPermission(status, headers, body, context.permission) : null;
  let message = `HTTP ${status}: ${missing ? `${missing} ` : ""}${hint}`;
  if (limited && retry !== null) message += ` Retry after ${retry} seconds.`;
  return {
    code,
    message,
    retryable: limited || status === 408 || status >= 500,
    ...(limited && retry !== null ? { retry_after_s: retry } : {}),
  };
}

function flattenErrors(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  const parts: string[] = [];
  for (const item of errors) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const field = typeof record.field === "string" ? record.field : "";
    const code = typeof record.code === "string" ? record.code : "";
    if (["prompt", "model", "base_ref", "head_ref", "custom_agent", "create_pull_request"].includes(field)
      && ["missing_field", "invalid", "missing", "already_exists", "unprocessable"].includes(code)) {
      parts.push(`${field} ${code}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function retrySeconds(headers: HeaderLookup): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter.trim()) && Number.isSafeInteger(Number(retryAfter))) return Number(retryAfter);
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset && /^\d+$/.test(reset.trim()) && Number.isSafeInteger(Number(reset))) {
    return Math.max(0, Number(reset.trim()) - Math.floor(Date.now() / 1000));
  }
  return null;
}

export function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

const TOKEN_SHAPE = /\b(?:github_pat_|gh[a-z]_)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g;

export function redactTokenShapes(text: string): string {
  return text.replace(TOKEN_SHAPE, "[redacted]");
}

export function missingPermission(
  status: number,
  headers: HeaderLookup,
  body: unknown,
  needed: GithubPermission,
): string | null {
  if (status !== 403) return null;
  const accepted = acceptedPermissions(headers.get("x-accepted-github-permissions"));
  if (accepted.length === 1) return `Missing ${accepted[0]} permission.`;
  if (accepted.length > 1) return `Missing permissions: ${joinEnglish(accepted)}.`;
  const blob = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (
    blob.includes("repository_write_access_required")
    || /user does not have write access to every repository/i.test(blob)
  ) {
    return "Missing Contents: write permission.";
  }
  if (/resource not accessible by integration/i.test(blob)) return `Missing ${needed} permission.`;
  return null;
}

function acceptedPermissions(header: string | null): string[] {
  if (!header) return [];
  const labels: string[] = [];
  for (const part of header.split(/[;,]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const slug = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase();
    const level = eq === -1 ? "" : trimmed.slice(eq + 1).trim().toLowerCase();
    const name = permissionLabel(slug);
    if (!name || (level && !["read", "write", "admin"].includes(level))) continue;
    labels.push(level ? `${name}: ${level}` : name);
  }
  return labels;
}

function permissionLabel(slug: string): string | undefined {
  const labels: Record<string, string> = {
    agent_tasks: "Agent tasks",
    pull_requests: "Pull requests",
    contents: "Contents",
    metadata: "Metadata",
  };
  return Object.prototype.hasOwnProperty.call(labels, slug) ? labels[slug] : undefined;
}

function joinEnglish(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const last = items[items.length - 1] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${last}`;
}
