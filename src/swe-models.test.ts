import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "./server.ts";
import {
  COPILOT_INTEGRATION_ID,
  ENDPOINTS_QUERY,
  GRAPHQL_URL,
  SWE_MODELS_API_VERSION,
  readSweModels,
  validateSweModels,
  type SweModel,
} from "./swe-models.ts";

const prices = {
  input_price: 11,
  output_price: 22,
  cache_price: 3,
  batch_size: 1000,
};

const tokenModel = {
  id: "test-model-a",
  name: "Modelo de prueba A",
  vendor: "Fabricante Ficticio",
  preview: false,
  policy: { state: "enabled" },
  billing: { token_prices: { ...prices } },
};

const promoModel = {
  id: "test-model-b",
  name: "Modelo de prueba B",
  vendor: "Otro Fabricante",
  preview: true,
  policy: { state: "disabled" },
  billing: {
    token_prices: { input_price: 4, output_price: 5, cache_price: 1, batch_size: 10 },
    promo: {
      discount_percent: 15,
      ends_at: "2099-01-01T00:00:00Z",
      message: "oferta inventada",
    },
  },
};

const pricedWithoutPolicy = {
  id: "test-model-c",
  name: "Modelo sin política",
  vendor: "Fabricante Ficticio",
  preview: false,
  billing: { token_prices: { input_price: 7, output_price: 8, cache_price: 2, batch_size: 100 } },
};

const routerModel = {
  id: "test-router",
  name: "Enrutador de prueba",
  vendor: "Fabricante Ficticio",
  preview: false,
  billing: { multiplier: 1.25 },
};

const routerWithPromo = {
  id: "test-router-promo",
  name: "Enrutador con promo",
  vendor: "Fabricante Ficticio",
  preview: true,
  billing: {
    multiplier: 2,
    promo: {
      discount_percent: 5,
      ends_at: "2099-06-01T00:00:00Z",
      message: "promo del enrutador",
    },
  },
};

const fixtures = [
  { data: [] },
  { data: [tokenModel] },
  { data: [pricedWithoutPolicy] },
  { data: [promoModel] },
  { data: [routerModel] },
  { data: [routerWithPromo] },
  { data: [tokenModel, promoModel, pricedWithoutPolicy, routerModel, routerWithPromo] },
];

describe("validador de /agents/swe/models", () => {
  it("conserva los campos de interés en todos los fixtures sintéticos", () => {
    for (const fixture of fixtures) {
      const models = validateSweModels(fixture);
      expect(models).toHaveLength(fixture.data.length);
      fixture.data.forEach((input, index) => {
        const output = models[index];
        expect(output).toBeDefined();
        expectSame(input, output as SweModel);
      });
    }
  });

  it("rechaza un formato incompleto o de tipo incorrecto y no devuelve modelos", () => {
    expect(() => validateSweModels({})).toThrow(/falta data/);
    expect(() => validateSweModels({ data: { id: "test-model-a" } })).toThrow(/falta data/);
    const { id, ...withoutId } = tokenModel;
    expect(id).toBe("test-model-a");
    expect(() => validateSweModels({ data: [withoutId] })).toThrow(/falta data\[0\]\.id/);
    expect(() => validateSweModels({ data: [{ ...tokenModel, preview: "no" }] })).toThrow(/data\[0\]\.preview no es boolean/);
    expect(() => validateSweModels({ data: [{ ...tokenModel, billing: {} }] })).toThrow(/falta data\[0\]\.billing\.token_prices/);
    expect(() => validateSweModels({
      data: [{ ...tokenModel, billing: { token_prices: { ...prices, batch_size: "mil" } } }],
    })).toThrow(/data\[0\]\.billing\.token_prices\.batch_size no es number/);
    expect(() => validateSweModels({ data: [{ id: "test-router", name: "Enrutador", vendor: "Ficticio", preview: false, billing: { multiplier: "alto" } }] })).toThrow(/data\[0\]\.billing\.multiplier no es number/);
    expect(() => validateSweModels({ data: [{ ...promoModel, billing: { ...promoModel.billing, promo: { discount_percent: 15, message: "sin fecha" } } }] })).toThrow(/falta data\[0\]\.billing\.promo\.ends_at/);
    expect(() => validateSweModels({
      data: [tokenModel, { id: "test-model-d", name: "Incompleto", vendor: "Ficticio", preview: false, policy: { state: "enabled" }, billing: {} }],
    })).toThrow(/falta data\[1\]\.billing\.token_prices/);
    expect(() => validateSweModels({
      data: [{ ...pricedWithoutPolicy, policy: {} }],
    })).toThrow(/falta data\[0\]\.policy\.state/);
  });

  it("no guarda la URL del endpoint ni modelos reales", () => {
    const source = readFileSync(new URL("./swe-models.ts", import.meta.url), "utf8");
    expect(source).not.toContain("api.individual.githubcopilot.com");
    expect(source).not.toContain("mai-code-2");
    expect(source).not.toContain("github/docs");
  });
});

describe("lectura de /agents/swe/models", () => {
  it("pide la base por GraphQL y cita el endpoint con la fecha de la consulta", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const result = await readSweModels({
      token: "test-token",
      now: () => new Date("2099-01-01T00:00:00.000Z"),
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), init: init ?? {} });
        if (String(input) === GRAPHQL_URL) {
          return json({ data: { viewer: { copilotEndpoints: { api: "https://copilot.example.test/" } } } });
        }
        return json({ data: [tokenModel, routerModel] });
      },
    });
    expect(result.source).toEqual({
      url: "https://copilot.example.test/agents/swe/models",
      fetched_at: "2099-01-01T00:00:00.000Z",
    });
    expect(result.models.map((model) => model.id)).toEqual(["test-model-a", "test-router"]);
    expect(result.models[1]?.billing.multiplier).toBe(1.25);
    const graphql = seen[0];
    const models = seen[1];
    expect(graphql?.url).toBe(GRAPHQL_URL);
    expect(JSON.parse(String(graphql?.init.body))).toEqual({ query: ENDPOINTS_QUERY });
    expect(header(graphql?.init, "authorization")).toBe("Bearer test-token");
    expect(models?.url).toBe("https://copilot.example.test/agents/swe/models");
    expect(header(models?.init, "authorization")).toBe("Bearer test-token");
    expect(header(models?.init, "x-github-api-version")).toBe(SWE_MODELS_API_VERSION);
    expect(header(models?.init, "copilot-integration-id")).toBe(COPILOT_INTEGRATION_ID);
  });

  it("devuelve isError si GraphQL o el GET no responden 200", async () => {
    const graphql = await toolError(async (url) => {
      if (url === GRAPHQL_URL) return new Response("no", { status: 401 });
      throw new Error("el GET no debería llamarse");
    });
    expect(graphql.isError).toBe(true);
    expect(textOf(graphql)).toContain("HTTP 401");
    expect(textOf(graphql)).toContain(GRAPHQL_URL);
    expect(textOf(graphql)).not.toContain("secreto-de-prueba");

    const get = await toolError(async (url) => {
      if (url === GRAPHQL_URL) return json({ data: { viewer: { copilotEndpoints: { api: "https://copilot.example.test" } } } });
      return new Response("no", { status: 503 });
    });
    expect(get.isError).toBe(true);
    expect(textOf(get)).toContain("HTTP 503");
    expect(textOf(get)).toContain("https://copilot.example.test/agents/swe/models");
    expect(textOf(get)).not.toContain("secreto-de-prueba");
  });

  it("devuelve isError si el formato no cuadra y no incluye datos parciales", async () => {
    const result = await toolError(async (url) => {
      if (url === GRAPHQL_URL) return json({ data: { viewer: { copilotEndpoints: { api: "https://copilot.example.test" } } } });
      return json({ data: [tokenModel, { id: "test-model-c", name: "Incompleto", vendor: "Ficticio", preview: false, policy: { state: "enabled" }, billing: {} }] });
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 200");
    expect(textOf(result)).toContain("https://copilot.example.test/agents/swe/models");
    expect(textOf(result)).toContain("data[1].billing.token_prices");
    expect(textOf(result)).not.toContain("test-model-a");
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("devuelve isError si policy viene sin state", async () => {
    const result = await toolError(async (url) => {
      if (url === GRAPHQL_URL) return json({ data: { viewer: { copilotEndpoints: { api: "https://copilot.example.test" } } } });
      return json({ data: [{ ...pricedWithoutPolicy, policy: { terms: "sin estado" } }] });
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 200");
    expect(textOf(result)).toContain("falta data[0].policy.state");
    expect(textOf(result)).not.toContain("test-model-c");
  });
});

function expectSame(input: {
  id: string;
  name: string;
  vendor: string;
  preview: boolean;
  policy?: { state: string };
  billing: {
    token_prices?: { input_price: number; output_price: number; cache_price: number; batch_size: number };
    promo?: { discount_percent: number; ends_at: string; message: string };
    multiplier?: number;
  };
}, output: SweModel) {
  expect(output.id).toBe(input.id);
  expect(output.name).toBe(input.name);
  expect(output.vendor).toBe(input.vendor);
  expect(output.preview).toBe(input.preview);
  if (input.policy) expect(output.policy).toEqual({ state: input.policy.state });
  else expect(output.policy).toEqual({ state: null });
  if (input.billing.token_prices) expect(output.billing.token_prices).toEqual(input.billing.token_prices);
  else expect(output.billing.token_prices).toBeUndefined();
  if (input.billing.promo) expect(output.billing.promo).toEqual(input.billing.promo);
  else expect(output.billing.promo).toBeUndefined();
  if (input.billing.multiplier !== undefined) expect(output.billing.multiplier).toBe(input.billing.multiplier);
  else expect(output.billing.multiplier).toBeUndefined();
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(name);
}

async function toolError(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mcp = buildServer({ exclude: [], readOnly: false, features: [] }, {
    statePath: "/tmp/unused-swe-models.json",
    clientForToken: () => ({
      async createTask() {
        throw new Error("no");
      },
      async getTask() {
        throw new Error("no");
      },
    }),
    readToken: () => "secreto-de-prueba",
    launchWatcher: () => {},
    readModels: () => readSweModels({
      token: "secreto-de-prueba",
      fetchImpl: (input, init) => fetchImpl(String(input), init),
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "list_copilot_models", arguments: {} });
  await client.close();
  await mcp.close();
  return result;
}

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  const first: unknown = result.content[0];
  return first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
}
