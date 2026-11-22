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

describe("contrato del OpenAPI", () => {
  it("acepta los ejemplos oficiales de crear y leer una tarea", () => {
    for (const name of ["create-task.response.json", "get-task.response.json"] as const) {
      const file = fixture(name);
      expect(() => assertSchema(officialSchema(name), file.example, name)).not.toThrow();
    }
  });

  it("envía la versión fijada y el modelo tal cual, y valida la respuesta", async () => {
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
      prompt: "Arregla el botón",
      model: "modelo-inexistente-123",
      base_ref: "main",
      create_pull_request: true,
    });
    expect(task.id).toBe((created as { id: string }).id);
    expect(seen?.url).toBe("https://api.github.com/agents/repos/octocat/hello-world/tasks");
    const headers = new Headers(seen?.init?.headers);
    expect(headers.get("x-github-api-version")).toBe(API_VERSION);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      prompt: "Arregla el botón",
      model: "modelo-inexistente-123",
      base_ref: "main",
      create_pull_request: true,
    });
  });

  it("rechaza una respuesta que no cumple el esquema", async () => {
    const client = createGitHubClient({
      token,
      fetch: mockFetch(() => new Response(JSON.stringify({ state: "nope" }), { status: 200 })),
    });
    await expect(client.getTask({ taskId: "task-1" })).rejects.toThrow(/no cumple el esquema/);
  });

  it("acepta una sesión con uso y con el modelo que devuelve la API", () => {
    const file = fixture("get-task.response.json");
    const example = structuredClone(file.example) as { sessions: Array<Record<string, unknown>> };
    const session = example.sessions[0];
    if (!session) throw new Error("el ejemplo no trae sesión");
    session.model = "sweagent-capi:mai-code-2";
    session.usage = { type: "ai_credits", amount: 60454886000 };
    session.error = { message: "The selected model isn't available" };
    assertSchema(officialSchema("get-task.response.json"), example, "leer la tarea");
  });

  it("aplana un 422 y un límite de tasa sin copiar el token", async () => {
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
  it("elige la id de la lista filtrada por head", async () => {
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

  it("devuelve null si esa id no está en la lista", async () => {
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

describe("API interna de tareas", () => {
  const internalBase = "https://internal.test/agents";

  it("envía steer y abort sin la versión de la API y acepta un 202 vacío", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createGitHubClient({
      token,
      internalBaseUrl: internalBase,
      fetch: mockFetch((url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 202 });
      }),
    });
    await expect(client.steerTask("task-1", "sigue con los tests")).resolves.toBeUndefined();
    await expect(client.abortTask("task-1")).resolves.toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${internalBase}/tasks/task-1/steer`,
      `${internalBase}/tasks/task-1/steer`,
    ]);
    const steer = calls[0];
    const abort = calls[1];
    if (!steer || !abort) throw new Error("faltan llamadas");
    expect(steer.init?.method).toBe("POST");
    expect(abort.init?.method).toBe("POST");
    for (const call of [steer, abort]) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("authorization")).toBe("Bearer test-token");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-github-api-version")).toBeNull();
    }
    expect(JSON.parse(String(steer.init?.body))).toEqual({ content: "sigue con los tests", type: "user_message" });
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

  it("mapea un 404 de steer", async () => {
    const body = JSON.parse(readFileSync(new URL("../fixtures/internal/not-found.json", import.meta.url), "utf8")) as unknown;
    const client = createGitHubClient({
      token,
      internalBaseUrl: internalBase,
      fetch: mockFetch(() => new Response(JSON.stringify(body), { status: 404 })),
    });
    await expect(client.steerTask("task-ausente", "sigue")).rejects.toThrow("not found");
    await expect(client.abortTask("task-ausente")).rejects.toThrow("not found");
  });

  it("pide una página de eventos y conserva el timestamp vacío", async () => {
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

  it("lee una pull request por número con la versión pública", async () => {
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

describe("formatApiError", () => {
  it("calcula la espera con x-ratelimit-reset", () => {
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
