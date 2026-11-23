import { describe, expect, it } from "vitest";
import { redact, redactTokenShapes } from "./errors.ts";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64urlSegment(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const ch = BASE64URL[i % BASE64URL.length] ?? "A";
    out += ch;
  }
  return out;
}

function syntheticGhsJwt(totalLength = 520): string {
  const prefix = "ghs_";
  const dots = 2;
  const body = totalLength - prefix.length - dots;
  const segLen = Math.floor(body / 3);
  const extra = body - segLen * 3;
  const segments = [
    base64urlSegment(segLen),
    base64urlSegment(segLen),
    base64urlSegment(segLen + extra),
  ];
  const token = `${prefix}${segments.join(".")}`;
  expect(token.length).toBe(totalLength);
  expect(token).toMatch(/^ghs_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  return token;
}

describe("redactTokenShapes", () => {
  it("redacts a full JWT-format ghs_ installation token with no leftover segments", () => {
    const token = syntheticGhsJwt();
    const input = `Bearer ${token} trailing`;
    const output = redactTokenShapes(input);
    expect(output).toBe("Bearer [redacted] trailing");
    expect(output).not.toContain(".");
    for (const segment of token.slice(4).split(".")) {
      expect(output).not.toContain(segment);
    }
  });

  it("preserves sentence punctuation after a redacted token", () => {
    const token = syntheticGhsJwt();
    expect(redactTokenShapes(`Token ${token}.`)).toBe("Token [redacted].");
    expect(redactTokenShapes(`Token ${token}, next`)).toBe("Token [redacted], next");
    expect(redactTokenShapes(`(Token ${token})`)).toBe("(Token [redacted])");
  });

  it("redacts classic github_pat_ and gh* user tokens", () => {
    expect(redactTokenShapes("github_pat_11AAAbbbbCCCCdddd")).toBe("[redacted]");
    expect(redactTokenShapes("secret ghu_0123456789abcdef")).toBe("secret [redacted]");
    expect(redactTokenShapes("use gho_abcdefghijklmnop")).toBe("use [redacted]");
    expect(redactTokenShapes("x ghr_zzzzzzzzzzzzzzzz")).toBe("x [redacted]");
  });

  it("does not redact normal words that share a prefix", () => {
    expect(redactTokenShapes("ghost.")).toBe("ghost.");
    expect(redactTokenShapes("high_level")).toBe("high_level");
    expect(redactTokenShapes("no secrets here.")).toBe("no secrets here.");
  });

  it("redacts a short dotted ghs_ example and keeps a trailing period", () => {
    expect(redactTokenShapes("Token ghs_aaa.bbb.ccc.")).toBe("Token [redacted].");
  });
});

describe("redact", () => {
  it("replaces an exact secret substring", () => {
    expect(redact("key=abc123", "abc123")).toBe("key=[redacted]");
  });
});