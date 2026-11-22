import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRICING_NOTES_URL, PRICING_TABLE_URL, parsePricing, pricingResultSchema, readPricing } from "./pricing.ts";

const table = readFileSync(new URL("../fixtures/pricing/models-and-pricing.yml", import.meta.url), "utf8");
const notes = readFileSync(new URL("../fixtures/pricing/models-and-pricing.md", import.meta.url), "utf8");

const mini = `
- model: Demo[^demo-promo]
  provider: test
  release_status: GA
  category: Test
  input: $1.00
  cached_input: $0.10
  output: $2.00
`;

describe("precios", () => {
  it("lee la oferta de MAI Code 2 del fixture de la página real", () => {
    const parsed = parsePricing(table, notes);
    const model = parsed.models.find((item) => item.name === "MAI Code 2");
    expect(model).toMatchObject({
      provider: "microsoft",
      price: [{
        input_per_1m_tokens: "0.50",
        cached_input_per_1m_tokens: "0.025",
        output_per_1m_tokens: "2.50",
      }],
      offers: [{
        ends_on: "2027-05-17",
        input_per_1m_tokens: "0.50",
        cached_input_per_1m_tokens: "0.025",
        output_per_1m_tokens: "2.50",
        standard_price: {
          starts_on: "2027-05-17",
          input_per_1m_tokens: "1.00",
          cached_input_per_1m_tokens: "0.05",
          output_per_1m_tokens: "5.00",
        },
      }],
    });
    expect(parsed.models.find((item) => item.name === "Grok 4.7")?.price).toHaveLength(2);
    expect(pricingResultSchema.safeParse({
      page: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
      sources: [{ url: "https://example.test/table.yml", fetched_at: "2026-11-22T00:00:00.000Z" }],
      models: parsed.models,
    }).success).toBe(true);
  });

  it("falla si el formato cambia y no inventa modelos", () => {
    expect(() => parsePricing("{}\n", "")).toThrow(/formato esperado/);
    expect(() => parsePricing(mini, "[^demo-promo]: texto sin oferta\n")).toThrow(/formato esperado/);
    expect(() => parsePricing(`${mini}  extra: 1\n`, "[^demo-promo]: promotional pricing of $1.00 per 1M input tokens, $0.10 per 1M cached input tokens, and $2.00 per 1M output tokens until May 17, 2027.\n")).toThrow(/desconocido/);
    try {
      parsePricing("{}\n", "");
    } catch (error) {
      expect(String(error)).not.toContain("MAI Code 2");
    }
  });

  it("no guarda una tabla de modelos en el código", () => {
    const source = readFileSync(new URL("./pricing.ts", import.meta.url), "utf8");
    expect(source).not.toContain("MAI Code 2");
    expect(source).not.toContain("mai-code-2");
    expect(source).not.toContain("2027-05-17");
  });

  it("cita la URL leída y la fecha", async () => {
    const result = await readPricing(async (input) => {
      const url = String(input);
      if (url === PRICING_TABLE_URL) return new Response(table);
      if (url === PRICING_NOTES_URL) return new Response(notes);
      return new Response("no", { status: 404 });
    }, () => new Date("2026-11-22T12:00:00.000Z"));
    expect(result.sources).toEqual([
      { url: PRICING_TABLE_URL, fetched_at: "2026-11-22T12:00:00.000Z" },
      { url: PRICING_NOTES_URL, fetched_at: "2026-11-22T12:00:00.000Z" },
    ]);
    expect(result.models.find((item) => item.name === "MAI Code 2")?.offers[0]?.ends_on).toBe("2027-05-17");
  });
});
