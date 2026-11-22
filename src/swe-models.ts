import { z } from "zod";
import { ModelsError, redact } from "./errors.ts";

export const GRAPHQL_URL = "https://api.github.com/graphql";
export const ENDPOINTS_QUERY = "query { viewer { copilotEndpoints { api } } }";
export const SWE_MODELS_PATH = "/agents/swe/models";
export const SWE_MODELS_API_VERSION = "2026-01-09";
export const COPILOT_INTEGRATION_ID = "vscode-chat";

const tokenPricesSchema = z.object({
  input_price: z.number(),
  output_price: z.number(),
  cache_price: z.number(),
  batch_size: z.number(),
}).strict();

const promoSchema = z.object({
  discount_percent: z.number(),
  ends_at: z.string(),
  message: z.string(),
}).strict();

const sweModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  preview: z.boolean(),
  policy: z.object({ state: z.string() }).strict().optional(),
  billing: z.object({
    token_prices: tokenPricesSchema.optional(),
    promo: promoSchema.optional(),
    multiplier: z.number().optional(),
  }).strict(),
}).strict();

export const sweModelsResultSchema = z.object({
  source: z.object({
    url: z.string(),
    fetched_at: z.string(),
  }).strict(),
  models: z.array(sweModelSchema),
}).strict();

export type SweModel = z.infer<typeof sweModelSchema>;
export type SweModelsResult = z.infer<typeof sweModelsResultSchema>;

export function validateSweModels(payload: unknown): SweModel[] {
  if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, "data") || !Array.isArray(payload.data)) {
    throw new ModelsError("falta data");
  }
  return payload.data.map((item, index) => readModel(item, index));
}

export async function readSweModels(options: {
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<SweModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const api = await readApiBase(fetchImpl, options.token);
  const url = `${api}${SWE_MODELS_PATH}`;
  const body = await readJson(fetchImpl, options.token, url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${options.token}`,
      "user-agent": "copilot-agents-mcp",
      "x-github-api-version": SWE_MODELS_API_VERSION,
      "copilot-integration-id": COPILOT_INTEGRATION_ID,
    },
  });
  let models: SweModel[];
  try {
    models = validateSweModels(body);
  } catch (error) {
    if (error instanceof ModelsError) {
      throw new ModelsError(`GET ${url} respondió HTTP 200 y el formato no cuadra: ${error.message}`);
    }
    throw error;
  }
  return {
    source: { url, fetched_at: now().toISOString() },
    models,
  };
}

async function readApiBase(fetchImpl: typeof fetch, token: string): Promise<string> {
  const body = await readJson(fetchImpl, token, GRAPHQL_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "copilot-agents-mcp",
    },
    body: JSON.stringify({ query: ENDPOINTS_QUERY }),
  });
  const api = readApi(body);
  if (api === null) {
    throw new ModelsError(`POST ${GRAPHQL_URL} respondió HTTP 200 y el formato no cuadra: falta data.viewer.copilotEndpoints.api`);
  }
  return api;
}

function readApi(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.viewer)) return null;
  const endpoints = body.data.viewer.copilotEndpoints;
  if (!isRecord(endpoints) || typeof endpoints.api !== "string") return null;
  const api = endpoints.api.replace(/\/$/, "");
  if (!/^https?:\/\//.test(api)) return null;
  return api;
}

async function readJson(fetchImpl: typeof fetch, token: string, url: string, init: RequestInit): Promise<unknown> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "error de red";
    throw new ModelsError(redact(`No se pudo llamar a ${method} ${url}: ${message}`, token));
  }
  if (response.status !== 200) {
    throw new ModelsError(redact(`${method} ${url} respondió HTTP ${response.status}.`, token));
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelsError(`${method} ${url} respondió HTTP 200 y el cuerpo no es JSON.`);
  }
}

function readModel(item: unknown, index: number): SweModel {
  const where = `data[${index}]`;
  if (!isRecord(item)) throw new ModelsError(`${where} no es un objeto`);
  const model: SweModel = {
    id: readString(item, "id", `${where}.id`),
    name: readString(item, "name", `${where}.name`),
    vendor: readString(item, "vendor", `${where}.vendor`),
    preview: readBoolean(item, "preview", `${where}.preview`),
    billing: {},
  };
  if (!isRecord(item.billing)) throw new ModelsError(`falta ${where}.billing`);
  const multiplier = Object.prototype.hasOwnProperty.call(item.billing, "multiplier");
  if (multiplier) {
    model.billing.multiplier = readNumber(item.billing, "multiplier", `${where}.billing.multiplier`);
  } else {
    if (!isRecord(item.policy)) throw new ModelsError(`falta ${where}.policy.state`);
    model.policy = { state: readString(item.policy, "state", `${where}.policy.state`) };
    model.billing.token_prices = readPrices(item.billing.token_prices, `${where}.billing.token_prices`);
  }
  if (isRecord(item.policy) && multiplier) {
    model.policy = { state: readString(item.policy, "state", `${where}.policy.state`) };
  }
  if (Object.prototype.hasOwnProperty.call(item.billing, "token_prices") && multiplier) {
    model.billing.token_prices = readPrices(item.billing.token_prices, `${where}.billing.token_prices`);
  }
  if (Object.prototype.hasOwnProperty.call(item.billing, "promo")) {
    model.billing.promo = readPromo(item.billing.promo, `${where}.billing.promo`);
  }
  return model;
}

function readPrices(value: unknown, path: string): SweModel["billing"]["token_prices"] {
  if (!isRecord(value)) throw new ModelsError(`falta ${path}`);
  return {
    input_price: readNumber(value, "input_price", `${path}.input_price`),
    output_price: readNumber(value, "output_price", `${path}.output_price`),
    cache_price: readNumber(value, "cache_price", `${path}.cache_price`),
    batch_size: readNumber(value, "batch_size", `${path}.batch_size`),
  };
}

function readPromo(value: unknown, path: string): NonNullable<SweModel["billing"]["promo"]> {
  if (!isRecord(value)) throw new ModelsError(`falta ${path}`);
  return {
    discount_percent: readNumber(value, "discount_percent", `${path}.discount_percent`),
    ends_at: readString(value, "ends_at", `${path}.ends_at`),
    message: readString(value, "message", `${path}.message`),
  };
}

function readString(record: Record<string, unknown>, key: string, path: string): string {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new ModelsError(`falta ${path}`);
  if (typeof record[key] !== "string") throw new ModelsError(`${path} no es string`);
  return record[key];
}

function readBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new ModelsError(`falta ${path}`);
  if (typeof record[key] !== "boolean") throw new ModelsError(`${path} no es boolean`);
  return record[key];
}

function readNumber(record: Record<string, unknown>, key: string, path: string): number {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new ModelsError(`falta ${path}`);
  if (typeof record[key] !== "number" || !Number.isFinite(record[key])) throw new ModelsError(`${path} no es number`);
  return record[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
