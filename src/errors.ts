export const API_VERSION = "2026-03-10";

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

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

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
  if (error instanceof ToolFailure || error instanceof GitHubError || error instanceof PricingError) {
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
