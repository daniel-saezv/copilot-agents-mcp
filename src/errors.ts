export const API_VERSION = "2026-03-10";

export const TASK_HAS_NO_PULL_REQUEST = "task_has_no_pull_request";
export const TASK_PULL_REQUEST_NOT_OPEN = "task_pull_request_not_open";

export class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

export class ModelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsError";
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

export const NO_SESSION_MESSAGE = "No hay sesión de GitHub. Define GITHUB_PERSONAL_ACCESS_TOKEN o ejecuta `npx copilot-agents-mcp login`.";

export type GithubPermission = "Agent tasks" | "Pull requests" | "Contents: write";

export function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

export function toolJson(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
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
  return "Error inesperado.";
}

export function modelUnavailableMessage(model: string, accepted: readonly string[]): string {
  const list = accepted.length > 0 ? [...accepted].sort().join(", ") : "ninguno";
  return `El modelo «${model}» no está disponible. Modelos vistos aceptados: ${list}.`;
}

const MODEL_UNAVAILABLE = /model (?:is not|isn.?t) available/i;

export function isModelUnavailable(message: string): boolean {
  return MODEL_UNAVAILABLE.test(message);
}

type HeaderLookup = { get(name: string): string | null };

export function formatApiError(status: number, headers: HeaderLookup, body: unknown): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = typeof record.message === "string" && record.message.trim() ? record.message.trim() : `HTTP ${status}`;
  const details = flattenErrors(record.errors);
  let text = details ? `${message}: ${details}` : message;
  const retry = retrySeconds(headers);
  if (retry !== null && (status === 429 || status === 403 || /rate limit/i.test(text))) {
    text += `. Retry after ${retry} seconds`;
  }
  return text;
}

function flattenErrors(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  const parts: string[] = [];
  for (const item of errors) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      parts.push(record.message.trim());
      continue;
    }
    const field = typeof record.field === "string" ? record.field : "";
    const code = typeof record.code === "string" ? record.code : "";
    const text = [field, code].filter(Boolean).join(" ");
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function retrySeconds(headers: HeaderLookup): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) return Number(retryAfter.trim());
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset && /^\d+$/.test(reset.trim())) {
    return Math.max(0, Number(reset.trim()) - Math.floor(Date.now() / 1000));
  }
  return null;
}

export function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

const TOKEN_SHAPE = /\b(?:github_pat_|gh[a-z]_)[A-Za-z0-9_]+\b/g;

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
  if (accepted.length === 1) return `Falta el permiso ${accepted[0]}.`;
  if (accepted.length > 1) return `Faltan los permisos ${joinSpanish(accepted)}.`;
  const blob = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (
    blob.includes("repository_write_access_required")
    || /user does not have write access to every repository/i.test(blob)
  ) {
    return "Falta el permiso Contents: write.";
  }
  if (/resource not accessible by integration/i.test(blob)) return `Falta el permiso ${needed}.`;
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
    if (!slug) continue;
    const name = permissionLabel(slug);
    labels.push(level ? `${name}: ${level}` : name);
  }
  return labels;
}

function permissionLabel(slug: string): string {
  const words = slug.split("_").filter(Boolean);
  const first = words[0];
  if (!first) return slug;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

function joinSpanish(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const last = items[items.length - 1] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${last}`;
}
