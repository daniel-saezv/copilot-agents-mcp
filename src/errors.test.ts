import { describe, expect, it } from "vitest";
import { apiFailure, failureToError, GitHubError, ModelsError, redact, redactTokenShapes } from "./errors.ts";

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

  describe("API failures", () => {
    it("keeps explicit status codes through error serialization instead of guessing from hints", () => {
      for (const ErrorClass of [GitHubError, ModelsError]) {
        const failure = apiFailure(422, new Headers(), { message: "Not Found" });
        expect(failureToError(new ErrorClass(failure.message, failure)).error).toMatchObject({
          code: "invalid_argument",
          retryable: false,
        });
      }
    });

    it("preserves only recognized validation fields and codes", () => {
      const failure = apiFailure(422, new Headers(), {
        message: "private-message",
        errors: [
          { field: "prompt", code: "missing_field", message: "private-message" },
          { field: "private-field", code: "invalid" },
          { field: "model", code: "private-code" },
          "private-error",
        ],
      });
      expect(failure.message).toContain("Validation Failed: prompt missing_field");
      expect(JSON.stringify(failure)).not.toContain("private-");
    });

    it("keeps known permission hints but rejects arbitrary header names and values", () => {
      const failure = apiFailure(403, new Headers({
        "x-accepted-github-permissions": "contents=write, metadata=read, private-header=read, pull_requests=private-value",
      }), { message: "private-message" }, { permission: "Agent tasks" });
      expect(failure.code).toBe("forbidden");
      expect(failure.message).toContain("Missing permissions: Contents: write and Metadata: read.");
      expect(JSON.stringify(failure)).not.toContain("private-");
    });

    it("preserves only the exact safe abort-refusal signal", () => {
      const message = "cannot abort: no active session";
      expect(apiFailure(422, new Headers(), { message }).message).toContain(message);
      for (const unsafe of [`private-secret ${message}`, `${message} private-secret`]) {
        const failure = apiFailure(422, new Headers(), { message: unsafe });
        expect(failure.message).not.toContain("private-secret");
        expect(failure.message).not.toContain(message);
      }
    });

    it("recognizes an exhausted 403 even when its reset time is missing", () => {
      const failure = apiFailure(403, new Headers({ "x-ratelimit-remaining": "0" }), { message: "forbidden" });
      expect(failure).toMatchObject({ code: "rate_limited", retryable: true });
      expect(failure).not.toHaveProperty("retry_after_s");
    });

    it.each(["not-a-number", "9".repeat(400)])("does not copy invalid retry metadata", (retry) => {
      const failure = apiFailure(429, new Headers({ "retry-after": retry }), { message: "private-message" });
      expect(failure).toMatchObject({ code: "rate_limited", retryable: true });
      expect(failure).not.toHaveProperty("retry_after_s");
      expect(failure.message).not.toContain(retry);
    });
  });
});