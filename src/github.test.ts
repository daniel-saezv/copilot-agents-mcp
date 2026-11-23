import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_VERSION, formatApiError } from "./errors.ts";
import { assertSchema, createGitHubClient, officialSchema } from "./github.ts";

const token = "test-token";

function fixture(name: string): { schema: unknown; example: unknown } {
  return JSON.parse(readFileSync(new URL(`../fixtures/openapi/${name}`, import.meta.url), "utf8")) as { schema: unknown; example: unknown };
}

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

describe("OpenAPI contract", () => {
  it("accepts the official create and read task examples", () => {
    for (const name of ["create-task.response.json", "get-task.response.json"] as const) {
      const file = fixture(name);
      expect(() => assertSchema(officialSchema(name), file.example, name)).not.toThrow();
    }
  });

  it("sends the pinned version and unchanged model, then validates the response", async () => {
    const created = fixture("create-task.response.json").example;
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const client = createGitHubClient({
      token,
      fetch: mockFetch((url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify(created), { status: 201 });
      }),
    });
    const task = await client.createTask({
      owner: "octocat",
      repo: "hello-world",
      prompt: "Fix the button",
      model: "missing-model-123",
      base_ref: "main",
      create_pull_request: true,
    });
    expect(task.id).toBe((created as { id: string }).id);
    expect(seen?.url).toBe("https://api.github.com/agents/repos/octocat/hello-world/tasks");
    const headers = new Headers(seen?.init?.headers);
    expect(headers.get("x-github-api-version")).toBe(API_VERSION);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      prompt: "Fix the button",
      model: "missing-model-123",
      base_ref: "main",
      create_pull_request: true,
    });
  });

  it("rejects a response that does not match the schema", async () => {
    const client = createGitHubClient({
      token,
      fetch: mockFetch(() => new Response(JSON.stringify({ state: "nope" }), { status: 200 })),
    });
    await expect(client.getTask({ taskId: "task-1" })).rejects.toThrow(/does not match the .* schema/);
  });

  it("accepts a session with usage and the model returned by the API", () => {
    const file = fixture("get-task.response.json");
    const example = structuredClone(file.example) as { sessions: Array<Record<string, unknown>> };
    const session = example.sessions[0];
    if (!session) throw new Error("the example has no session");
    session.model = "sweagent-capi:mai-code-2";
    session.usage = { type: "ai_credits", amount: 60454886000 };
    session.error = { message: "The selected model isn't available" };
    assertSchema(officialSchema("get-task.response.json"), example, "read task");
  });

  it("flattens a 422 and a rate limit without copying the token", async () => {
    const limited = createGitHubClient({
      token,
      fetch: mockFetch(() => new Response(JSON.stringify({ message: "API rate limit exceeded for test-token" }), {
        status: 429,
        headers: { "retry-after": "12" },
      })),
    });
    await expect(limited.getTask({ taskId: "task-1" })).rejects.toThrow(/Retry after 12 seconds/);
    await expect(limited.getTask({ taskId: "task-1" })).rejects.toThrow(/\[redacted\]/);
    const invalid = createGitHubClient({
      token,
      fetch: mockFetch(() => new Response(JSON.stringify({
        message: "Validation Failed",
        errors: [{ field: "prompt", code: "missing_field" }],
      }), { status: 422 })),
    });
    await expect(invalid.createTask({
      owner: "octocat",
      repo: "hello-world",
      prompt: "x",
      model: "mai-code-2",
    })).rejects.toThrow("Validation Failed: prompt missing_field");
  });
});

describe("pull request", () => {
  it("selects the ID from the list filtered by head", async () => {
    let seen = "";
    const client = createGitHubClient({
      token,
      fetch: mockFetch((url, init) => {
        seen = url;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
        return new Response(JSON.stringify([
          { id: 41, number: 1, html_url: "https://github.com/octocat/hello-world/pull/1" },
          { id: 42, number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" },
        ]), { status: 200 });
      }),
    });
    await expect(client.findPullRequest({
      owner: "octocat",
      repo: "hello-world",
      id: 42,
      headRef: "copilot/demo",
    })).resolves.toEqual({ number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" });
    expect(seen).toBe("https://api.github.com/repos/octocat/hello-world/pulls?state=all&head=octocat%3Acopilot%2Fdemo&per_page=100");
  });

  it("returns null when that ID is not in the list", async () => {
    const client = createGitHubClient({
      token,
      fetch: mockFetch(() => new Response(JSON.stringify([{ id: 9, number: 1, html_url: "https://github.com/octocat/hello-world/pull/1" }]), { status: 200 })),
    });
    await expect(client.findPullRequest({
      owner: "octocat",
      repo: "hello-world",
      id: 42,
      headRef: "copilot/demo",
    })).resolves.toBeNull();
  });
});

describe("internal task API", () => {
  const internalBase = "https://internal.test/agents";

  it("sends steer and abort without the API version and accepts an empty 202", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createGitHubClient({
      token,
      internalBaseUrl: internalBase,
      fetch: mockFetch((url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 202 });
      }),
    });
    await expect(client.steerTask("task-1", "continue with the tests")).resolves.toBeUndefined();
    await expect(client.abortTask("task-1")).resolves.toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${internalBase}/tasks/task-1/steer`,
      `${internalBase}/tasks/task-1/steer`,
    ]);
    const steer = calls[0];
    const abort = calls[1];
    if (!steer || !abort) throw new Error("missing calls");
    expect(steer.init?.method).toBe("POST");
    expect(abort.init?.method).toBe("POST");
    for (const call of [steer, abort]) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("authorization")).toBe("Bearer test-token");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-github-api-version")).toBeNull();
    }
    expect(JSON.parse(String(steer.init?.body))).toEqual({ content: "continue with the tests", type: "user_message" });
    expect(JSON.parse(String(abort.init?.body))).toEqual({ type: "abort" });
    const fallback = createGitHubClient({
      token,
      fetch: mockFetch((url) => {
        expect(url).toBe("https://api.github.com/cmc_internal/api/agents/tasks/task-1/steer");
        return new Response(null, { status: 202 });
      }),
    });
    await expect(fallback.abortTask("task-1")).resolves.toBeUndefined();
  });

  it("maps a steer 404", async () => {
    const body = JSON.parse(readFileSync(new URL("../fixtures/internal/not-found.json", import.meta.url), "utf8")) as unknown;
    const client = createGitHubClient({
      token,
      internalBaseUrl: internalBase,
      fetch: mockFetch(() => new Response(JSON.stringify(body), { status: 404 })),
    });
    await expect(client.steerTask("missing-task", "continue")).rejects.toThrow("not found");
    await expect(client.abortTask("missing-task")).rejects.toThrow("not found");
  });

  it("names the repository for an app 404 and preserves GitHub's message for a PAT", async () => {
    const notFound = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const missingIntegration = () => new Response(JSON.stringify({ message: "Integration not found" }), { status: 404 });
    const app = createGitHubClient({
      token: "ghu_app",
      tokens: {
        async current() {
          return "ghu_app";
        },
        async refresh() {
          return "ghu_app";
        },
      },
      fetch: mockFetch(() => notFound()),
    });
    await expect(app.getTask({ owner: "octocat", repo: "ghost-repo", taskId: "task-1" })).rejects.toThrow(
      "Repository octocat/ghost-repo was not found or is not accessible.",
    );
    const appMissing = createGitHubClient({
      token: "ghu_app",
      tokens: {
        async current() {
          return "ghu_app";
        },
        async refresh() {
          return "ghu_app";
        },
      },
      fetch: mockFetch(() => missingIntegration()),
    });
    await expect(appMissing.getTask({ owner: "octocat", repo: "hello-world", taskId: "task-1" })).rejects.toThrow(
      "Install the app for octocat/hello-world: https://github.com/apps/copilot-agents-mcp/installations/new. Integration not found",
    );
    await expect(app.steerTask("task-1", "continue")).rejects.toThrow("Not Found");
    await expect(app.steerTask("task-1", "continue")).rejects.not.toThrow(/installations\/new/);
    const pat = createGitHubClient({
      token,
      fetch: mockFetch(() => notFound()),
    });
    await expect(pat.getTask({ owner: "octocat", repo: "hello-world", taskId: "task-1" })).rejects.toThrow("Not Found");
    await expect(pat.getTask({ owner: "octocat", repo: "hello-world", taskId: "task-1" })).rejects.not.toThrow(/Install the app/);
  });

  it("gets an events page and preserves an empty timestamp", async () => {
    const body = JSON.parse(readFileSync(new URL("../fixtures/internal/events.json", import.meta.url), "utf8")) as {
      events: Array<{ type: string; timestamp?: string }>;
      total: number;
    };
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const client = createGitHubClient({
      token,
      internalBaseUrl: internalBase,
      fetch: mockFetch((url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    });
    const page = await client.getTaskEvents("task-1", 2, 2);
    expect(seen?.url).toBe(`${internalBase}/tasks/task-1/events?per_page=2&page=2`);
    expect(seen?.init?.method).toBe("GET");
    const headers = new Headers(seen?.init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-github-api-version")).toBeNull();
    expect(page.total).toBe(4);
    expect(page.events.map((event) => event.type)).toEqual([
      "session.requested",
      "user.message",
      "tool.execution_start",
      "assistant.usage",
    ]);
    expect(page.events[0]?.timestamp).toBe("0001-01-01T00:00:00Z");
  });

  it("reads a pull request by number with the public API version", async () => {
    let seen = "";
    const client = createGitHubClient({
      token,
      fetch: mockFetch((url, init) => {
        seen = url;
        expect(new Headers(init?.headers).get("x-github-api-version")).toBe(API_VERSION);
        return new Response(JSON.stringify({ number: 7, state: "open" }), { status: 200 });
      }),
    });
    await expect(client.getPullRequest({ owner: "octocat", repo: "hello-world", number: 7 })).resolves.toEqual({
      number: 7,
      state: "open",
    });
    expect(seen).toBe("https://api.github.com/repos/octocat/hello-world/pulls/7");
  });
});

describe("app credential", () => {
  it("refreshes once and retries with the new token after a 401", async () => {
    const seen: string[] = [];
    let refreshes = 0;
    const client = createGitHubClient({
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
      fetch: mockFetch((_url, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        seen.push(authorization);
        if (seen.length === 1) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        return new Response(JSON.stringify(fixture("get-task.response.json").example), { status: 200 });
      }),
    });
    await expect(client.getTask({ taskId: "task-1" })).resolves.toMatchObject({ id: expect.any(String) });
    expect(refreshes).toBe(1);
    expect(seen).toEqual(["Bearer access-viejo", "Bearer access-nuevo"]);
  });

  it("does not retry a 401 with a fixed token", async () => {
    let calls = 0;
    const client = createGitHubClient({
      token,
      fetch: mockFetch(() => {
        calls += 1;
        return new Response("{}", { status: 401 });
      }),
    });
    await expect(client.getTask({ taskId: "task-1" })).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });

  it("names the missing permission", async () => {
    const denied = (body: unknown, headers?: Record<string, string>) => createGitHubClient({
      token,
      fetch: mockFetch(() => new Response(JSON.stringify(body), { status: 403, headers })),
    });
    await expect(denied({
      message: "user does not have write access to every repository",
      errors: [{ code: "repository_write_access_required" }],
    }).steerTask("task-1", "continue")).rejects.toThrow(/Missing Contents: write permission/);
    await expect(denied({ message: "Resource not accessible by integration" }).getPullRequest({
      owner: "octocat",
      repo: "hello-world",
      number: 7,
    })).rejects.toThrow(/Missing Pull requests permission/);
    await expect(denied({ message: "Resource not accessible by integration" }).getTask({
      taskId: "task-1",
    })).rejects.toThrow(/Missing Agent tasks permission/);
    await expect(denied({ message: "Resource not accessible by integration" }, {
      "x-accepted-github-permissions": "contents=write, metadata=read",
    }).getTask({ taskId: "task-1" })).rejects.toThrow("Missing permissions: Contents: write and Metadata: read.");
  });
});

describe("timeouts", () => {
  it("times out while reading the response body", async () => {
    const example = fixture("get-task.response.json").example;
    const client = createGitHubClient({
      token,
      fetchTimeoutMs: 50,
      fetch: (async (_input, init) => ({
        ok: true,
        async text() {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
        },
      })) as typeof fetch,
    });
    await expect(client.getTask({ taskId: (example as { id: string }).id })).rejects.toThrow(/timed out after 50 milliseconds/);
  });

  it("fails create_agent_task when the GitHub fetch never resolves", async () => {
    const client = createGitHubClient({
      token,
      fetchTimeoutMs: 50,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
    });
    await expect(client.createTask({
      owner: "octocat",
      repo: "hello-world",
      prompt: "x",
      model: "mai-code-2",
    })).rejects.toThrow(/timed out after 50 milliseconds/);
  });
});

describe("formatApiError", () => {
  it("calculates the wait from x-ratelimit-reset", () => {
    const reset = String(Math.floor(Date.now() / 1000) + 30);
    const text = formatApiError(403, {
      get(name) {
        if (name === "x-ratelimit-remaining") return "0";
        if (name === "x-ratelimit-reset") return reset;
        return null;
      },
    }, { message: "API rate limit exceeded" });
    expect(text).toMatch(/Retry after \d+ seconds/);
  });
});
