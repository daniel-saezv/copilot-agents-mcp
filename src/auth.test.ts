import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  DEFAULT_GITHUB_APP_CLIENT_ID,
  createAppSession,
  createMemoryStore,
  githubAppClientId,
  loginWithDeviceFlow,
  logoutLocal,
  logoutMessage,
  statusReport,
  systemAccount,
  type SecretStore,
  type StoredCredential,
} from "./auth.ts";
import { KeyringError } from "./errors.ts";
import { createGitHubClient } from "./github.ts";

const dirs: string[] = [];
const NOW = 1_700_000_000_000;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilot-auth-"));
  dirs.push(dir);
  return join(dir, "auth.lock");
}

function memoryStore(initial: string | null = null): SecretStore & { snapshot(): string | null } {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    delete: () => {
      value = null;
    },
    snapshot: () => value,
  };
}

function credential(input: { access: string; refresh: string; expiresAt: number; refreshExpiresAt?: number | null }): string {
  const stored: StoredCredential = {
    access_token: input.access,
    refresh_token: input.refresh,
    expires_at: input.expiresAt,
    refresh_expires_at: input.refreshExpiresAt === undefined ? NOW + 1_000_000_000 : input.refreshExpiresAt,
  };
  return JSON.stringify(stored);
}

function oauth(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("renovación", () => {
  it("varias llamadas a la vez renuevan una sola vez y todas reciben el token nuevo", async () => {
    const store = memoryStore(credential({
      access: "access-viejo",
      refresh: "refresh-viejo",
      expiresAt: NOW + 60_000,
    }));
    let calls = 0;
    const session = createAppSession({
      store,
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      warn: () => {},
      fetchImpl: async (_input, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { grant_type?: string; refresh_token?: string; client_id?: string };
        expect(body.grant_type).toBe("refresh_token");
        expect(body.client_id).toBe("client-de-prueba");
        expect(body.refresh_token).toBe("refresh-viejo");
        expect(String(init?.body)).not.toContain("client_secret");
        return oauth({
          access_token: "access-nuevo",
          refresh_token: "refresh-nuevo",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
        });
      },
    });
    const tokens = await Promise.all([session.current(), session.current(), session.current(), session.current()]);
    expect(calls).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(["access-nuevo"]));
    await expect(session.current()).resolves.toBe("access-nuevo");
    expect(calls).toBe(1);
    const saved = JSON.parse(store.snapshot() ?? "") as StoredCredential;
    expect(saved.access_token).toBe("access-nuevo");
    expect(saved.refresh_token).toBe("refresh-nuevo");
    expect(saved.expires_at).toBe(NOW + 28_800 * 1000);
  });

  it("no renueva un token al que le quedan más de 5 minutos", async () => {
    let calls = 0;
    const session = createAppSession({
      store: memoryStore(credential({
        access: "access-vigente",
        refresh: "refresh-vigente",
        expiresAt: NOW + ACCESS_TOKEN_REFRESH_MARGIN_MS + 60_000,
      })),
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      warn: () => {},
      fetchImpl: async () => {
        calls += 1;
        throw new Error("no debía renovar");
      },
    });
    await expect(session.current()).resolves.toBe("access-vigente");
    expect(calls).toBe(0);
  });

  it("si otro proceso ya renovó, relee el llavero y no llama a refresh", async () => {
    let reads = 0;
    const expiring = credential({ access: "access-viejo", refresh: "refresh-viejo", expiresAt: NOW + 60_000 });
    const fresh = credential({ access: "access-ajeno", refresh: "refresh-ajeno", expiresAt: NOW + 3_600_000 });
    const store = memoryStore(expiring);
    store.read = () => {
      reads += 1;
      if (reads === 1) return expiring;
      return fresh;
    };
    let calls = 0;
    const session = createAppSession({
      store,
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      warn: () => {},
      fetchImpl: async () => {
        calls += 1;
        return oauth({});
      },
    });
    await expect(session.current()).resolves.toBe("access-ajeno");
    expect(calls).toBe(0);
  });

  it("un 401 provoca una renovación y el reintento usa el token nuevo", async () => {
    const example = JSON.parse(readFileSync(new URL("../fixtures/openapi/get-task.response.json", import.meta.url), "utf8")) as { example: { id: string } };
    const store = memoryStore(credential({
      access: "access-viejo",
      refresh: "refresh-viejo",
      expiresAt: NOW + 3_600_000,
    }));
    let refreshes = 0;
    const session = createAppSession({
      store,
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      warn: () => {},
      fetchImpl: async () => {
        refreshes += 1;
        return oauth({
          access_token: "access-nuevo",
          refresh_token: "refresh-nuevo",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        });
      },
    });
    const seen: string[] = [];
    const client = createGitHubClient({
      token: "no-usar",
      tokens: session,
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        seen.push(authorization);
        if (seen.length === 1) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        return new Response(JSON.stringify(example.example), { status: 200 });
      },
    });
    const task = await client.getTask({ taskId: "task-1" });
    expect(task.id).toBe(example.example.id);
    expect(refreshes).toBe(1);
    expect(seen).toEqual(["Bearer access-viejo", "Bearer access-nuevo"]);
  });

  it("bad_refresh_token pide iniciar sesión y borra la sesión guardada", async () => {
    const store = memoryStore(credential({
      access: "access-viejo",
      refresh: "refresh-viejo",
      expiresAt: NOW + 60_000,
    }));
    let calls = 0;
    const warnings: string[] = [];
    const session = createAppSession({
      store,
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      warn: (message) => warnings.push(message),
      fetchImpl: async () => {
        calls += 1;
        return oauth({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
      },
    });
    await expect(session.current()).rejects.toThrow(/login/);
    await expect(session.current()).rejects.toThrow(/login/);
    expect(calls).toBe(1);
    expect(store.snapshot()).toBeNull();
    expect(warnings.join("\n")).not.toContain("refresh-viejo");
    expect(warnings.join("\n")).not.toContain("access-viejo");
  });

  it("si el llavero falla al guardar, el token nuevo se queda en memoria y no va a disco", async () => {
    let writes = 0;
    const warnings: string[] = [];
    const session = createAppSession({
      store: {
        read: () => credential({ access: "access-viejo", refresh: "refresh-viejo", expiresAt: NOW + 60_000 }),
        write: () => {
          writes += 1;
          throw new KeyringError("lleno");
        },
        delete: () => {
          throw new Error("no borrar");
        },
      },
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      warn: (message) => warnings.push(message),
      fetchImpl: async () => oauth({
        access_token: "access-nuevo",
        refresh_token: "refresh-nuevo",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      }),
    });
    await expect(session.current()).resolves.toBe("access-nuevo");
    await expect(session.current()).resolves.toBe("access-nuevo");
    expect(writes).toBe(1);
    const shown = warnings.join("\n");
    expect(shown).toMatch(/memoria/);
    expect(shown).toMatch(/disco/);
    expect(shown).not.toContain("access-nuevo");
    expect(shown).not.toContain("refresh-nuevo");
  });
});

describe("device flow", () => {
  it("respeta interval y slow_down, guarda la sesión y no imprime secretos", async () => {
    const store = memoryStore();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sleeps: number[] = [];
    let polls = 0;
    const saved = await loginWithDeviceFlow({
      clientId: "client-de-prueba",
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      store,
      persistent: true,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetchImpl: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        expect(body.client_id).toBe("client-de-prueba");
        expect(JSON.stringify(body)).not.toContain("client_secret");
        if (url.endsWith("/device/code")) {
          expect(body.scope).toBe("offline_access");
          return oauth({
            device_code: "device-code-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          });
        }
        polls += 1;
        expect(body.device_code).toBe("device-code-1");
        expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
        if (polls === 1) return oauth({ error: "authorization_pending" });
        if (polls === 2) return oauth({ error: "slow_down", interval: 10 });
        return oauth({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
        });
      },
    });
    expect(sleeps).toEqual([5_000, 5_000, 10_000]);
    expect(saved.where).toBe("keyring");
    const shown = [...stdout, ...stderr].join("\n");
    expect(shown).toContain("https://github.com/login/device");
    expect(shown).toContain("ABCD-EFGH");
    expect(shown).toContain("15 minutos");
    expect(shown).toContain("No introduzcas un código que no hayas pedido tú.");
    expect(shown).not.toContain("device-code-1");
    expect(shown).not.toContain("access-1");
    expect(shown).not.toContain("refresh-1");
    const stored = JSON.parse(store.snapshot() ?? "") as StoredCredential;
    expect(stored.access_token).toBe("access-1");
    expect(stored.refresh_token).toBe("refresh-1");
  });

  it("si el llavero falla, deja el token en memoria y avisa sin escribir el secreto", async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const saved = await loginWithDeviceFlow({
      clientId: "client-de-prueba",
      now: () => NOW,
      sleep: async () => {},
      store: {
        read: () => null,
        write: () => {
          throw new KeyringError("secret-service no está");
        },
        delete: () => {},
      },
      persistent: true,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetchImpl: async (input) => {
        if (String(input).endsWith("/device/code")) {
          return oauth({
            device_code: "device-code-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          });
        }
        return oauth({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        });
      },
    });
    expect(saved.where).toBe("memory");
    expect(saved.credential.access_token).toBe("access-1");
    const shown = [...stdout, ...stderr].join("\n");
    expect(shown).toMatch(/memoria/);
    expect(shown).toMatch(/disco/);
    expect(shown).not.toContain("access-1");
    expect(shown).not.toContain("refresh-1");
  });
});

describe("estado y logout", () => {
  it("el estado no incluye el token", () => {
    expect(githubAppClientId({})).toBe(DEFAULT_GITHUB_APP_CLIENT_ID);
    expect(DEFAULT_GITHUB_APP_CLIENT_ID).toBe("Iv23liiE0XVsuSo0WG8z");
    expect(githubAppClientId({ COPILOT_AGENTS_GITHUB_APP_CLIENT_ID: " otro " })).toBe("otro");
    const name = userInfo().username.trim();
    expect(systemAccount()).toBe(name || "usuario");
    const stored: StoredCredential = {
      access_token: "access-secreto",
      refresh_token: "refresh-secreto",
      expires_at: NOW + 3_600_000,
      refresh_expires_at: NOW + 86_400_000,
    };
    const text = statusReport({
      env: {},
      stored,
      keyring: "ready",
      account: "ada",
    });
    expect(text).toContain("llavero");
    expect(text).toContain("ada");
    expect(text).toContain("5 minutos");
    expect(text).not.toContain("access-secreto");
    expect(text).not.toContain("refresh-secreto");
    const pat = statusReport({
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "from-pat" },
      stored,
      keyring: "ready",
      account: "ada",
    });
    expect(pat).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(pat).not.toContain("from-pat");
    expect(pat).not.toContain("access-secreto");
  });

  it("logout es idempotente y explica cómo revocar", () => {
    const store = createMemoryStore();
    store.write("sesión");
    expect(logoutLocal(store)).toBe("removed");
    expect(logoutLocal(store)).toBe("absent");
    const message = logoutMessage("removed");
    expect(message).toContain("Authorized GitHub Apps");
    expect(message).toContain("desinstálala");
    expect(logoutMessage("unavailable")).toMatch(/disco/);
  });
});
