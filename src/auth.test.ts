import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  DEFAULT_GITHUB_APP_CLIENT_ID,
  createAppSession,
  createMemoryStore,
  githubAppClientId,
  loginWithDeviceFlow,
  logoutLocal,
  logoutMessage,
  readGitHubApp,
  readGitHubAppName,
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

  it("si el llavero falla tras rotar el token, la sesión sigue en memoria y se guarda al recuperarse", async () => {
    let saved: string | null = credential({
      access: "ghu_viejo",
      refresh: "ghr_viejo",
      expiresAt: NOW + 60_000,
    });
    const before = saved;
    let failing = true;
    let writes = 0;
    const delays: number[] = [];
    const warnings: string[] = [];
    const store: SecretStore = {
      read: () => saved,
      write: (next) => {
        writes += 1;
        if (failing) throw new KeyringError("no disponible");
        saved = next;
      },
      delete: () => {
        saved = null;
      },
    };
    const session = createAppSession({
      store,
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      sleep: async (ms) => {
        delays.push(ms);
      },
      warn: (message) => warnings.push(message),
      fetchImpl: async () => oauth({
        access_token: "ghu_nuevo",
        refresh_token: "ghr_nuevo",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      }),
    });
    await expect(session.current()).resolves.toBe("ghu_nuevo");
    await expect(session.current()).resolves.toBe("ghu_nuevo");
    expect(saved).toBe(before);
    expect(writes).toBeGreaterThan(1);
    expect(delays.length).toBeGreaterThan(0);
    expect(delays.every((ms) => ms > 0 && ms < 1_000)).toBe(true);
    const shown = warnings.join("\n");
    expect(shown).toMatch(/ya no es válido/);
    expect(shown).toMatch(/login/);
    expect(shown).not.toMatch(/ghu_|ghr_/);
    failing = false;
    await expect(session.current()).resolves.toBe("ghu_nuevo");
    const parsed = JSON.parse(saved ?? "") as StoredCredential;
    expect(parsed.access_token).toBe("ghu_nuevo");
    expect(parsed.refresh_token).toBe("ghr_nuevo");
    const restarted = createAppSession({
      store,
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      warn: () => {},
      fetchImpl: async () => {
        throw new Error("no debía renovar");
      },
    });
    await expect(restarted.current()).resolves.toBe("ghu_nuevo");
  });

  it("un error que no es KeyringError al guardar no pierde el token en memoria", async () => {
    const store = memoryStore(credential({
      access: "ghu_viejo",
      refresh: "ghr_viejo",
      expiresAt: NOW + 60_000,
    }));
    store.write = () => {
      throw new Error("fallo ajeno al llavero");
    };
    const session = createAppSession({
      store,
      lockPath: await lockPath(),
      clientId: "client-de-prueba",
      now: () => NOW,
      sleep: async () => {},
      warn: () => {},
      fetchImpl: async () => oauth({
        access_token: "ghu_nuevo",
        refresh_token: "ghr_nuevo",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      }),
    });
    await expect(session.current()).resolves.toBe("ghu_nuevo");
    expect(session.peek()).toBe("ghu_nuevo");
    expect(session.stored()?.refresh_token).toBe("ghr_nuevo");
    expect(store.snapshot()).toContain("ghu_viejo");
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

  it("la última espera del sondeo no pasa del plazo", async () => {
    let now = NOW;
    const sleeps: number[] = [];
    const expiresIn = 8;
    const interval = 5;
    await expect(loginWithDeviceFlow({
      clientId: "client-de-prueba",
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      store: memoryStore(),
      persistent: true,
      stdout: () => {},
      stderr: () => {},
      fetchImpl: async (input) => {
        if (String(input).endsWith("/device/code")) {
          return oauth({
            device_code: "device-code-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: expiresIn,
            interval,
          });
        }
        return oauth({ error: "authorization_pending" });
      },
    })).rejects.toThrow(/caducado/);
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(expiresIn * 1000);
    expect(sleeps.at(-1)).toBeLessThan(interval * 1000);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("corta la llamada OAuth a los 30 s", async () => {
    const deadlines: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      deadlines.push(ms);
      return AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    });
    try {
      await expect(loginWithDeviceFlow({
        clientId: "client-de-prueba",
        now: () => NOW,
        sleep: async () => {},
        store: memoryStore(),
        persistent: true,
        stdout: () => {},
        stderr: () => {},
        fetchImpl: async (_input, init) => {
          if (init?.signal?.aborted) throw init.signal.reason;
          throw new Error("la llamada no traía plazo");
        },
      })).rejects.toThrow(/30 s/);
      expect(deadlines).toContain(30_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("avisa si la app no está instalada y el login termina igual", async () => {
    const stdout: string[] = [];
    const saved = await loginWithDeviceFlow({
      clientId: "client-de-prueba",
      now: () => NOW,
      sleep: async () => {},
      store: memoryStore(),
      persistent: true,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/device/code")) {
          return oauth({
            device_code: "device-code-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          });
        }
        if (url.endsWith("/user/installations")) return oauth({ total_count: 0, installations: [] });
        return oauth({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        });
      },
    });
    expect(saved.where).toBe("keyring");
    const shown = stdout.join("\n");
    expect(shown).toContain("La app no está instalada en ningún repositorio.");
    expect(shown).toContain("https://github.com/apps/copilot-agents-mcp/installations/new");
    expect(shown).not.toContain("access-1");
  });

  it("no avisa en el login si ya hay una instalación", async () => {
    const stdout: string[] = [];
    await loginWithDeviceFlow({
      clientId: "client-de-prueba",
      now: () => NOW,
      sleep: async () => {},
      store: memoryStore(),
      persistent: true,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/device/code")) {
          return oauth({
            device_code: "device-code-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          });
        }
        if (url.endsWith("/user/installations")) {
          return oauth({ total_count: 1, installations: [{ app_slug: "copilot-agents-mcp" }] });
        }
        if (url.includes("/apps/")) return oauth({ name: "copilot-agents-mcp" });
        return oauth({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        });
      },
    });
    const shown = stdout.join("\n");
    expect(shown).not.toContain("no está instalada");
    expect(shown).not.toContain("installations/new");
  });

  it("si la consulta de instalaciones falla, el login sigue sin aviso", async () => {
    const stdout: string[] = [];
    await expect(loginWithDeviceFlow({
      clientId: "client-de-prueba",
      now: () => NOW,
      sleep: async () => {},
      store: memoryStore(),
      persistent: true,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/device/code")) {
          return oauth({
            device_code: "device-code-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          });
        }
        if (url.endsWith("/user/installations")) throw new Error("red");
        return oauth({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        });
      },
    })).resolves.toMatchObject({ where: "keyring" });
    expect(stdout.join("\n")).not.toContain("no está instalada");
  });
});

describe("estado y logout", () => {
  it("el estado muestra el mecanismo y no imprime tokens", () => {
    expect(githubAppClientId({})).toBe(DEFAULT_GITHUB_APP_CLIENT_ID);
    expect(DEFAULT_GITHUB_APP_CLIENT_ID).toBe("Iv23liNbsc3GH7vmP8OT");
    expect(githubAppClientId({ COPILOT_AGENTS_GITHUB_APP_CLIENT_ID: " otro " })).toBe("otro");
    const name = userInfo().username.trim();
    expect(systemAccount()).toBe(name || "usuario");
    const stored: StoredCredential = {
      access_token: "ghu_accesssecreto",
      refresh_token: "ghr_refreshsecreto",
      expires_at: NOW + 3_600_000,
      refresh_expires_at: NOW + 86_400_000,
    };
    const text = statusReport({
      env: {},
      stored,
      keyring: "ready",
      account: "ada",
      appName: "App de ejemplo",
    });
    expect(text).toContain("GitHub App");
    expect(text).toContain("llavero");
    expect(text).toContain("ada");
    expect(text).toContain("App de ejemplo");
    expect(text).toContain(DEFAULT_GITHUB_APP_CLIENT_ID);
    expect(text).toContain("valor por defecto");
    expect(text).toContain(new Date(stored.expires_at).toISOString());
    expect(text).toContain(new Date(stored.refresh_expires_at ?? 0).toISOString());
    expect(text).toContain("5 minutos");
    expect(text).not.toMatch(/ghu_|ghr_/);
    const overridden = statusReport({
      env: { COPILOT_AGENTS_GITHUB_APP_CLIENT_ID: " client-desde-entorno " },
      stored,
      keyring: "ready",
      account: "ada",
      appName: null,
    });
    expect(overridden).toContain("client-desde-entorno");
    expect(overridden).toContain("COPILOT_AGENTS_GITHUB_APP_CLIENT_ID");
    expect(overridden).toContain("desconocido");
    expect(overridden).not.toMatch(/ghu_|ghr_/);
    const pat = statusReport({
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghu_frompat" },
      stored,
      keyring: "ready",
      account: "ada",
    });
    expect(pat).toContain("PAT");
    expect(pat).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(pat).not.toMatch(/ghu_|ghr_/);
  });

  it("lee el nombre público de la app y, si no puede, no falla", async () => {
    const token = "ghu_consulta";
    const name = await readGitHubAppName(token, async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/user/installations")) {
        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
        return oauth({ installations: [{ app_slug: "app-de-prueba" }] });
      }
      expect(headers.get("authorization")).toBeNull();
      expect(url).toContain("/apps/app-de-prueba");
      return oauth({ name: "App de prueba" });
    });
    expect(name).toBe("App de prueba");
    await expect(readGitHubAppName(token, async () => {
      throw new Error(`red ${token}`);
    })).resolves.toBeNull();
    await expect(readGitHubAppName(token, async () => oauth({ installations: [] }))).resolves.toBeNull();
    const stored: StoredCredential = {
      access_token: token,
      refresh_token: "ghr_refreshsecreto",
      expires_at: NOW + 3_600_000,
      refresh_expires_at: NOW + 86_400_000,
    };
    const empty = await readGitHubApp(token, async () => oauth({ total_count: 0, installations: [] }));
    const text = statusReport({
      env: {},
      stored,
      keyring: "ready",
      account: "ada",
      appName: empty.name,
      appNotInstalled: empty.empty,
    });
    expect(text).toContain("La app no está instalada en ningún repositorio.");
    expect(text).toContain("https://github.com/apps/copilot-agents-mcp/installations/new");
    expect(text).not.toContain("desconocido");
    expect(text).not.toMatch(/ghu_|ghr_/);
    const failed = await readGitHubApp(token, async () => {
      throw new Error("red");
    });
    const unknown = statusReport({
      env: {},
      stored,
      keyring: "ready",
      account: "ada",
      appName: failed.name,
      appNotInstalled: failed.empty,
    });
    expect(unknown).toContain("desconocido");
    expect(unknown).not.toContain("installations/new");
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
