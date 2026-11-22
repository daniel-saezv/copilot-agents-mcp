import { parse } from "yaml";
import { z } from "zod";
import { PricingError } from "./errors.ts";

export const PRICING_PAGE = "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";
export const PRICING_TABLE_URL = "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml";
export const PRICING_NOTES_URL = "https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-billing/models-and-pricing.md";

const ROW_KEYS = new Set([
  "model",
  "provider",
  "release_status",
  "category",
  "input",
  "cached_input",
  "output",
  "cache_write",
  "threshold",
  "tier",
  "notes",
]);

const PRICE = /^\$(\d+(?:\.\d+)?)$/;
const MODEL_NAME = /^(.+?)(?:\[\^([A-Za-z0-9_-]+)\])?$/;
const OFFER = /promotional pricing of \$(\d+(?:\.\d+)?) per 1M input tokens, \$(\d+(?:\.\d+)?) per 1M cached input tokens, and \$(\d+(?:\.\d+)?) per 1M output tokens (?:until|through) ([A-Z][a-z]+ \d{1,2}, \d{4})/;
const STANDARD = /Starting ([A-Z][a-z]+ \d{1,2}, \d{4}), pricing is \$(\d+(?:\.\d+)?) per 1M input tokens, \$(\d+(?:\.\d+)?) per 1M cached input tokens, and \$(\d+(?:\.\d+)?) per 1M output tokens/;

const MONTHS: Record<string, string> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};

const priceRowSchema = z.object({
  tier: z.string().nullable(),
  threshold: z.string().nullable(),
  input_per_1m_tokens: z.string(),
  cached_input_per_1m_tokens: z.string(),
  output_per_1m_tokens: z.string(),
  cache_write_per_1m_tokens: z.string().nullable(),
}).strict();

const standardPriceSchema = z.object({
  starts_on: z.string(),
  input_per_1m_tokens: z.string(),
  cached_input_per_1m_tokens: z.string(),
  output_per_1m_tokens: z.string(),
}).strict();

const offerSchema = z.object({
  ends_on: z.string(),
  input_per_1m_tokens: z.string(),
  cached_input_per_1m_tokens: z.string(),
  output_per_1m_tokens: z.string(),
  standard_price: standardPriceSchema.nullable(),
}).strict();

const modelSchema = z.object({
  name: z.string(),
  provider: z.string(),
  price: z.array(priceRowSchema),
  offers: z.array(offerSchema),
}).strict();

export const pricingResultSchema = z.object({
  page: z.string(),
  sources: z.array(z.object({ url: z.string(), fetched_at: z.string() }).strict()),
  models: z.array(modelSchema),
}).strict();

export type PricingResult = z.infer<typeof pricingResultSchema>;

type PriceRow = z.infer<typeof priceRowSchema>;
type Offer = z.infer<typeof offerSchema>;

export function parsePricing(tableYaml: string, notesMarkdown: string): Omit<PricingResult, "page" | "sources"> {
  let parsed: unknown;
  try {
    parsed = parse(tableYaml);
  } catch {
    throw new PricingError("La página de precios no tiene el formato esperado: la tabla no es YAML válido.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new PricingError("La página de precios no tiene el formato esperado: la tabla no es una lista de modelos.");
  }
  const notes = parseNotes(notesMarkdown);
  const grouped = new Map<string, { name: string; provider: string; price: PriceRow[]; offers: Offer[] }>();
  for (const row of parsed) {
    const item = readRow(row);
    const key = `${item.provider}\u0000${item.name}`;
    let model = grouped.get(key);
    if (!model) {
      model = { name: item.name, provider: item.provider, price: [], offers: [] };
      grouped.set(key, model);
    }
    model.price.push(item.price);
    if (item.footnote) {
      const note = notes.get(item.footnote);
      if (!note) {
        throw new PricingError(`La página de precios no tiene el formato esperado: falta la nota ${item.footnote}.`);
      }
      const offer = readOffer(note, item.footnote);
      if (!model.offers.some((current) => current.ends_on === offer.ends_on && current.input_per_1m_tokens === offer.input_per_1m_tokens)) {
        model.offers.push(offer);
      }
    }
  }
  return { models: [...grouped.values()] };
}

export async function readPricing(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<PricingResult> {
  const fetchedAt = now().toISOString();
  const [tableYaml, notesMarkdown] = await Promise.all([
    fetchText(fetchImpl, PRICING_TABLE_URL),
    fetchText(fetchImpl, PRICING_NOTES_URL),
  ]);
  const parsed = parsePricing(tableYaml, notesMarkdown);
  return pricingResultSchema.parse({
    page: PRICING_PAGE,
    sources: [
      { url: PRICING_TABLE_URL, fetched_at: fetchedAt },
      { url: PRICING_NOTES_URL, fetched_at: fetchedAt },
    ],
    models: parsed.models,
  });
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "text/plain, text/markdown, application/yaml", "user-agent": "copilot-agents-mcp" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "error de red";
    throw new PricingError(`No se pudo leer la página de precios: ${message}`);
  }
  if (!response.ok) throw new PricingError(`No se pudo leer la página de precios (HTTP ${response.status}) en ${url}.`);
  return response.text();
}

function readRow(row: unknown): { name: string; provider: string; footnote: string | null; price: PriceRow } {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new PricingError("La página de precios no tiene el formato esperado: una fila no es un objeto.");
  }
  const record = row as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ROW_KEYS.has(key)) {
      throw new PricingError(`La página de precios no tiene el formato esperado: campo desconocido ${key}.`);
    }
  }
  requireString(record, "release_status");
  requireString(record, "category");
  const model = requireString(record, "model");
  const named = MODEL_NAME.exec(model);
  if (!named?.[1] || model.includes("[^") && !named[2]) {
    throw new PricingError("La página de precios no tiene el formato esperado: el nombre de un modelo no se reconoce.");
  }
  const name = named[1].trim();
  if (!name || name.includes("[^")) {
    throw new PricingError("La página de precios no tiene el formato esperado: el nombre de un modelo no se reconoce.");
  }
  return {
    name,
    provider: requireString(record, "provider"),
    footnote: named[2] ?? null,
    price: {
      tier: optionalString(record, "tier"),
      threshold: optionalString(record, "threshold"),
      input_per_1m_tokens: requirePrice(record, "input"),
      cached_input_per_1m_tokens: requirePrice(record, "cached_input"),
      output_per_1m_tokens: requirePrice(record, "output"),
      cache_write_per_1m_tokens: readCacheWrite(record),
    },
  };
}

function readCacheWrite(record: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, "cache_write")) return null;
  const value = record.cache_write;
  if (value === "Not applicable") return null;
  if (typeof value !== "string" || !PRICE.test(value)) {
    throw new PricingError("La página de precios no tiene el formato esperado: cache_write no es un precio.");
  }
  return PRICE.exec(value)?.[1] ?? null;
}

function requirePrice(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !PRICE.test(value)) {
    throw new PricingError(`La página de precios no tiene el formato esperado: ${field} no es un precio por 1M tokens.`);
  }
  const amount = PRICE.exec(value)?.[1];
  if (!amount) throw new PricingError(`La página de precios no tiene el formato esperado: ${field} no es un precio por 1M tokens.`);
  return amount;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new PricingError(`La página de precios no tiene el formato esperado: falta ${field}.`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, field) || record[field] === null) return null;
  const value = record[field];
  if (typeof value !== "string") {
    throw new PricingError(`La página de precios no tiene el formato esperado: ${field} no es texto.`);
  }
  return value;
}

function parseNotes(markdown: string): Map<string, string> {
  const notes = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\[\^([A-Za-z0-9_-]+)\]:\s*(\S.*)$/.exec(line);
    if (match?.[1] && match[2]) notes.set(match[1], match[2].trim());
  }
  return notes;
}

function readOffer(note: string, id: string): Offer {
  const offer = OFFER.exec(note);
  if (!offer?.[1] || !offer[2] || !offer[3] || !offer[4]) {
    throw new PricingError(`La página de precios no tiene el formato esperado: la nota ${id} no tiene una oferta con fecha de fin.`);
  }
  let standard: Offer["standard_price"] = null;
  if (note.includes("Starting ")) {
    const next = STANDARD.exec(note);
    if (!next?.[1] || !next[2] || !next[3] || !next[4]) {
      throw new PricingError(`La página de precios no tiene el formato esperado: la nota ${id} no describe el precio posterior.`);
    }
    standard = {
      starts_on: englishDate(next[1]),
      input_per_1m_tokens: next[2],
      cached_input_per_1m_tokens: next[3],
      output_per_1m_tokens: next[4],
    };
  }
  return {
    ends_on: englishDate(offer[4]),
    input_per_1m_tokens: offer[1],
    cached_input_per_1m_tokens: offer[2],
    output_per_1m_tokens: offer[3],
    standard_price: standard,
  };
}

function englishDate(value: string): string {
  const match = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  const month = match?.[1] ? MONTHS[match[1]] : undefined;
  if (!match?.[2] || !match[3] || !month) {
    throw new PricingError(`La página de precios no tiene el formato esperado: fecha no reconocida (${value}).`);
  }
  return `${match[3]}-${month}-${match[2].padStart(2, "0")}`;
}
