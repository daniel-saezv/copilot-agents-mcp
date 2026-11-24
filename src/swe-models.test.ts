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
  name: "Test model A",
  vendor: "Fictional vendor",
  preview: false,
  policy: { state: "enabled" },
  billing: { token_prices: { ...prices } },
};

const promoModel = {
  id: "test-model-b",
  name: "Test model B",
  vendor: "Other vendor",
  preview: true,
  policy: { state: "disabled" },
  billing: {
    token_prices: { input_price: 4, output_price: 5, cache_price: 1, batch_size: 10 },
    promo: {
      discount_percent: 15,
      ends_at: "2099-01-01T00:00:00Z",
      message: "fictional offer",
    },
  },
};

const pricedWithoutPolicy = {
  id: "test-model-c",
  name: "Model without policy",
  vendor: "Fictional vendor",
  preview: false,
  billing: { token_prices: { input_price: 7, output_price: 8, cache_price: 2, batch_size: 100 } },
};

const routerModel = {
  id: "test-router",
  name: "Test router",
  vendor: "Fictional vendor",
  preview: false,
  billing: { multiplier: 1.25 },
};

const routerWithPromo = {
  id: "test-router-promo",
  name: "Router with promotion",
  vendor: "Fictional vendor",
  preview: true,
  billing: {
    multiplier: 2,
    promo: {
      discount_percent: 5,
      ends_at: "2099-06-01T00:00:00Z",
      message: "router promotion",
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

describe("/agents/swe/models validator", () => {
  it("preserves relevant fields across all synthetic fixtures", () => {
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

  it("rejects incomplete or incorrectly typed formats without returning models", () => {
    expect(() => validateSweModels({})).toThrow(/missing data/);
    expect(() => validateSweModels({ data: { id: "test-model-a" } })).toThrow(/missing data/);
    const { id, ...withoutId } = tokenModel;
    expect(id).toBe("test-model-a");
    expect(() => validateSweModels({ data: [withoutId] })).toThrow(/missing data\[0\]\.id/);
    expect(() => validateSweModels({ data: [{ ...tokenModel, preview: "no" }] })).toThrow(/data\[0\]\.preview is not a boolean/);
    expect(() => validateSweModels({ data: [{ ...tokenModel, billing: {} }] })).toThrow(/missing data\[0\]\.billing\.token_prices/);
    expect(() => validateSweModels({
      data: [{ ...tokenModel, billing: { token_prices: { ...prices, batch_size: "mil" } } }],
    })).toThrow(/data\[0\]\.billing\.token_prices\.batch_size is not a number/);
    expect(() => validateSweModels({ data: [{ id: "test-router", name: "Router", vendor: "Fictional", preview: false, billing: { multiplier: "high" } }] })).toThrow(/data\[0\]\.billing\.multiplier is not a number/);
    expect(() => validateSweModels({ data: [{ ...promoModel, billing: { ...promoModel.billing, promo: { discount_percent: 15, message: "without date" } } }] })).toThrow(/missing data\[0\]\.billing\.promo\.ends_at/);
    expect(() => validateSweModels({
      data: [tokenModel, { id: "test-model-d", name: "Incomplete", vendor: "Fictional", preview: false, policy: { state: "enabled" }, billing: {} }],
    })).toThrow(/missing data\[1\]\.billing\.token_prices/);
  });

  it("does not store a real endpoint URL or real models", () => {
    const source = readFileSync(new URL("./swe-models.ts", import.meta.url), "utf8");
    expect(source).not.toContain("api.individual.githubcopilot.com");
    expect(source).not.toContain("mai-code-2");
    expect(source).not.toContain("github/docs");
  });
});

describe("/agents/swe/models reader", () => {
  it("gets the base through GraphQL and cites the endpoint and fetch time", async () => {
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

  it("returns isError when GraphQL or GET does not return 200", async () => {
    const graphql = await toolError(async (url) => {
      if (url === GRAPHQL_URL) return new Response("no", { status: 401 });
      throw new Error("GET should not be called");
    });
    expect(graphql.isError).toBe(true);
    expect(textOf(graphql)).toContain("HTTP 401");
    expect(textOf(graphql)).toContain(GRAPHQL_URL);
    expect(textOf(graphql)).not.toContain("test-secret");

    const get = await toolError(async (url) => {
      if (url === GRAPHQL_URL) return json({ data: { viewer: { copilotEndpoints: { api: "https://copilot.example.test" } } } });
      return new Response("no", { status: 503 });
    });
    expect(get.isError).toBe(true);
    expect(textOf(get)).toContain("HTTP 503");
    expect(textOf(get)).toContain("https://copilot.example.test/agents/swe/models");
    expect(textOf(get)).not.toContain("test-secret");
  });

  it("returns isError for an invalid format without partial data", async () => {
    const result = await toolError(async (url) => {
      if (url === GRAPHQL_URL) return json({ data: { viewer: { copilotEndpoints: { api: "https://copilot.example.test" } } } });
      return json({ data: [tokenModel, { id: "test-model-c", name: "Incomplete", vendor: "Fictional", preview: false, policy: { state: "enabled" }, billing: {} }] });
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 200");
    expect(textOf(result)).toContain("https://copilot.example.test/agents/swe/models");
    expect(textOf(result)).toContain("data[1].billing.token_prices");
    expect(textOf(result)).not.toContain("test-model-a");
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("omits policy from tool output even when upstream sends it", async () => {
    const policyEmptyObject = {
      ...pricedWithoutPolicy,
      id: "test-model-policy-empty-object",
      policy: {},
    };
    const policyNullState = {
      ...pricedWithoutPolicy,
      id: "test-model-policy-null-state",
      policy: { state: null },
    };
    const result = await callListModels(async (url) => {
      if (url === GRAPHQL_URL) return json({ data: { viewer: { copilotEndpoints: { api: "https://copilot.example.test" } } } });
      return json({
        data: [pricedWithoutPolicy, policyEmptyObject, policyNullState, tokenModel],
      });
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result)) as { models: Array<Record<string, unknown>> };
    for (const model of body.models) {
      expect(model).not.toHaveProperty("policy");
    }
  });
});

function expectSame(input: {
  id: string;
  name: string;
  vendor: string;
  preview: boolean;
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

async function callListModels(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mcp = buildServer({
    statePath: "/tmp/unused-swe-models.json",
    clientForToken: () => ({
      async createTask() {
        throw new Error("no");
      },
      async getTask() {
        throw new Error("no");
      },
      async findPullRequest() {
        return null;
      },
      async getPullRequest() {
        throw new Error("no");
      },
      async steerTask() {
        throw new Error("no");
      },
      async abortTask() {
        throw new Error("no");
      },
    }),
    readToken: () => "test-secret",
    launchWatcher: () => {},
    readModels: () => readSweModels({
      token: "test-secret",
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

async function toolError(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mcp = buildServer({
    statePath: "/tmp/unused-swe-models.json",
    clientForToken: () => ({
      async createTask() {
        throw new Error("no");
      },
      async getTask() {
        throw new Error("no");
      },
      async findPullRequest() {
        return null;
      },
      async getPullRequest() {
        throw new Error("no");
      },
      async steerTask() {
        throw new Error("no");
      },
      async abortTask() {
        throw new Error("no");
      },
    }),
    readToken: () => "test-secret",
    launchWatcher: () => {},
    readModels: () => readSweModels({
      token: "test-secret",
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

describe("models and session", () => {
  it("refreshes once when GraphQL returns 401 and uses the new token", async () => {
    let refreshes = 0;
    let graphql = 0;
    const result = await readSweModels({
      token: "access-viejo",
      tokens: {
        async current() {
          return "access-viejo";
        },
        async refresh(rejected) {
          expect(rejected).toBe("access-viejo");
          refreshes += 1;
          return "access-nuevo";
        },
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get("authorization");
        if (url === GRAPHQL_URL) {
          graphql += 1;
          if (graphql === 1) {
            expect(authorization).toBe("Bearer access-viejo");
            return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
          }
          expect(authorization).toBe("Bearer access-nuevo");
          return json({ data: { viewer: { copilotEndpoints: { api: "https://copilot.example.test" } } } });
        }
        expect(authorization).toBe("Bearer access-nuevo");
        return json({ data: [tokenModel] });
      },
    });
    expect(refreshes).toBe(1);
    expect(result.models.map((model) => model.id)).toEqual(["test-model-a"]);
  });

  it("names Agent tasks when the integration lacks permission", async () => {
    const error = await readSweModels({
      token: "access-1",
      fetchImpl: async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.message).toContain("Missing Agent tasks permission");
    expect(error.message).toContain("HTTP 403");
    expect(error.message).not.toContain("access-1");
  });
});
