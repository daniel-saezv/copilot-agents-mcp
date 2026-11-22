import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { AuthError, KeyringError, NO_SESSION_MESSAGE, redact, redactTokenShapes } from "./errors.ts";
import { withDirectoryLock } from "./state.ts";

export const KEYRING_SERVICE = "copilot-agents-mcp:github.com";
export const DEFAULT_GITHUB_APP_CLIENT_ID = "Iv23liiE0XVsuSo0WG8z";
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MARGIN_MINUTES = ACCESS_TOKEN_REFRESH_MARGIN_MS / 60_000;
const RELOGIN_MESSAGE = "La sesión de GitHub ha caducado o ya no vale. Ejecuta `npx copilot-agents-mcp login`.";

export type SecretStore = {
  read(): string | null;
  write(value: string): void;
  delete(): void;
};

export type AccessTokenSource = {
  current(): Promise<string>;
  refresh(rejected: string): Promise<string>;
};

export type StoredCredential = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  refresh_expires_at: number | null;
};

export type AppSession = AccessTokenSource & {
  peek(): string | null;
  stored(): StoredCredential | null;
};

type TokenGrant = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number | null;
};

class BadRefreshToken extends Error {
  constructor() {
    super("bad_refresh_token");
    this.name = "BadRefreshToken";
  }
}

export function systemAccount(): string {
  try {
    const name = userInfo().username.trim();
    return name || "usuario";
  } catch {
    return "usuario";
  }
}

export function githubAppClientId(env: NodeJS.ProcessEnv): string {
  const override = env.COPILOT_AGENTS_GITHUB_APP_CLIENT_ID;
  if (typeof override === "string" && override.trim()) return override.trim();
  return DEFAULT_GITHUB_APP_CLIENT_ID;
}

export function personalAccessToken(env: NodeJS.ProcessEnv): string | null {
  const value = env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readActiveToken(env: NodeJS.ProcessEnv, readApp: () => string | null): string | null {
  return personalAccessToken(env) ?? readApp();
}

export function ignoredTokenWarning(env: NodeJS.ProcessEnv): string | null {
  if (personalAccessToken(env)) return null;
  const names = ["GH_TOKEN", "GITHUB_TOKEN"].filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "";
  });
  if (names.length === 0) return null;
  const verb = names.length === 1 ? "Se ignora" : "Se ignoran";
  return `${verb} ${names.join(" y ")}. Define GITHUB_PERSONAL_ACCESS_TOKEN o ejecuta \`npx copilot-agents-mcp login\`.`;
}

export function authLockPath(statePath: string): string {
  return join(dirname(statePath), "auth.lock");
}

export function createMemoryStore(): SecretStore {
  let value: string | null = null;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    delete: () => {
      value = null;
    },
  };
}

export function createAppSession(options: {
  store: SecretStore;
  lockPath: string;
  clientId: string;
  fetchImpl: typeof fetch;
  now: () => number;
  warn: (message: string) => void;
}): AppSession {
  let memory: StoredCredential | null = null;
  let memoryOnly = false;
  let inflight: Promise<StoredCredential> | null = null;
  let warned = false;

  function warnOnce(message: string): void {
    if (warned) return;
    warned = true;
    options.warn(redactTokenShapes(message));
  }

  function read(): StoredCredential | null {
    if (memoryOnly) return memory;
    try {
      const raw = options.store.read();
      if (raw === null) {
        memory = null;
        return null;
      }
      const parsed = parseStored(raw);
      if (!parsed) {
        warnOnce("La sesión del llavero no se puede leer. Ejecuta `npx copilot-agents-mcp login`.");
        memory = null;
        return null;
      }
      memory = parsed;
      return parsed;
    } catch (error) {
      if (!(error instanceof KeyringError)) throw error;
      memoryOnly = true;
      warnOnce(`No hay llavero disponible (${error.message}). El token se queda solo en la memoria de este proceso y no se escribe en disco.`);
      return memory;
    }
  }

  function write(credential: StoredCredential): void {
    memory = credential;
    if (memoryOnly) return;
    try {
      options.store.write(serialize(credential));
    } catch (error) {
      if (!(error instanceof KeyringError)) throw error;
      memoryOnly = true;
      warnOnce(`No se pudo guardar la sesión en el llavero (${error.message}). El token se queda solo en la memoria de este proceso y no se escribe en disco.`);
    }
  }

  function clear(): void {
    memory = null;
    if (memoryOnly) return;
    try {
      options.store.delete();
    } catch (error) {
      if (!(error instanceof KeyringError)) throw error;
      memoryOnly = true;
      warnOnce(`No se pudo borrar la sesión del llavero (${error.message}). No se ha escrito el token en disco.`);
    }
  }

  function begin(rejected?: string): Promise<StoredCredential> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        return await withDirectoryLock(options.lockPath, () => refreshLocked(rejected), {
          timeoutMs: 60_000,
          busyMessage: "No se pudo renovar la sesión: el bloqueo de renovación está en uso.",
        });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function refreshLocked(rejected?: string): Promise<StoredCredential> {
    const latest = read();
    if (latest && reusable(latest, rejected, options.now())) return latest;
    if (!latest) throw new AuthError(NO_SESSION_MESSAGE);
    if (latest.refresh_expires_at !== null && latest.refresh_expires_at <= options.now()) {
      clear();
      throw new AuthError(RELOGIN_MESSAGE);
    }
    try {
      const grant = await requestRefresh(options.clientId, latest.refresh_token, options.fetchImpl);
      const next = toStored(grant, options.now());
      write(next);
      return next;
    } catch (error) {
      if (error instanceof BadRefreshToken) {
        clear();
        throw new AuthError(RELOGIN_MESSAGE);
      }
      throw error;
    }
  }

  return {
    peek() {
      return read()?.access_token ?? null;
    },
    stored() {
      const credential = read();
      return credential ? { ...credential } : null;
    },
    async current() {
      if (inflight) return (await inflight).access_token;
      const credential = read();
      if (!credential) throw new AuthError(NO_SESSION_MESSAGE);
      if (!expiring(credential, options.now())) return credential.access_token;
      return (await begin()).access_token;
    },
    async refresh(rejected) {
      if (inflight) {
        const next = await inflight;
        if (next.access_token !== rejected) return next.access_token;
      }
      const credential = read();
      if (credential && credential.access_token !== rejected && !expiring(credential, options.now())) {
        return credential.access_token;
      }
      return (await begin(rejected)).access_token;
    },
  };
}

export async function loginWithDeviceFlow(options: {
  clientId: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  store: SecretStore;
  persistent: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<{ where: "keyring" | "memory"; credential: StoredCredential }> {
  const device = await requestDeviceCode(options.clientId, options.fetchImpl);
  const minutes = Math.max(1, Math.round(device.expiresIn / 60));
  options.stdout(`Abre ${device.verificationUri}`);
  options.stdout(`Introduce el código ${device.userCode}.`);
  options.stdout(`El código caduca en ${minutes} minutos. No introduzcas un código que no hayas pedido tú.`);
  const grant = await pollDevice(device, options);
  const credential = toStored(grant, options.now());
  const encoded = serialize(credential);
  if (!options.persistent) {
    options.store.write(encoded);
    options.stderr("No hay llavero. El token queda solo en la memoria de este proceso, no se ha escrito en disco y se pierde al salir.");
    return { where: "memory", credential };
  }
  try {
    options.store.write(encoded);
  } catch (error) {
    if (!(error instanceof KeyringError)) throw error;
    options.stderr(redactTokenShapes(`No hay llavero disponible (${error.message}). El token queda solo en la memoria de este proceso, no se ha escrito en disco y se pierde al salir.`));
    return { where: "memory", credential };
  }
  options.stdout("Sesión guardada en el llavero del sistema.");
  return { where: "keyring", credential };
}

export function logoutLocal(store: SecretStore): "removed" | "absent" | "unavailable" {
  let existing: string | null;
  try {
    existing = store.read();
  } catch (error) {
    if (error instanceof KeyringError) return "unavailable";
    throw error;
  }
  try {
    store.delete();
  } catch (error) {
    if (error instanceof KeyringError) return "unavailable";
    throw error;
  }
  return existing ? "removed" : "absent";
}

export function logoutMessage(result: "removed" | "absent" | "unavailable"): string {
  const head = result === "removed"
    ? "Se ha borrado la sesión del llavero."
    : result === "absent"
      ? "No había una sesión en el llavero."
      : "No se pudo usar el llavero. No se ha escrito el token en disco.";
  return [
    head,
    "Para revocar el acceso: GitHub → Settings → Applications → Authorized GitHub Apps.",
    "Para quitar la app de un repositorio o de una organización, desinstálala.",
  ].join("\n");
}

export function statusReport(input: {
  env: NodeJS.ProcessEnv;
  stored: StoredCredential | null;
  keyring: "ready" | "memory";
  account: string;
}): string {
  if (personalAccessToken(input.env)) {
    const lines = ["Credencial activa: GITHUB_PERSONAL_ACCESS_TOKEN."];
    if (input.stored) lines.push("Hay una sesión de GitHub App guardada, pero no se usa mientras esa variable esté definida.");
    return lines.join("\n");
  }
  if (!input.stored) return NO_SESSION_MESSAGE;
  const where = input.keyring === "memory"
    ? "solo en la memoria de este proceso"
    : `en el llavero del sistema (cuenta «${input.account}»)`;
  const lines = [
    `Credencial activa: GitHub App, ${where}.`,
    `El access token caduca el ${new Date(input.stored.expires_at).toISOString()}. Se renueva solo ${MARGIN_MINUTES} minutos antes, y también si GitHub responde 401.`,
  ];
  if (input.stored.refresh_expires_at !== null) {
    lines.push(`El refresh token caduca el ${new Date(input.stored.refresh_expires_at).toISOString()}.`);
  }
  if (input.keyring === "memory") lines.push("No hay llavero: el token no está en disco y se pierde al salir.");
  return lines.join("\n");
}

type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

async function requestDeviceCode(clientId: string, fetchImpl: typeof fetch): Promise<DeviceCode> {
  const body = await postOAuth(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: "offline_access",
  }, fetchImpl, []);
  if (typeof body.error === "string") throw new AuthError(safeOAuthMessage("GitHub rechazó el device flow", body, []));
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new AuthError("GitHub no devolvió el código de verificación.");
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 900;
  const interval = typeof body.interval === "number" && body.interval >= 1 ? body.interval : 5;
  const verificationUri = typeof body.verification_uri === "string" && body.verification_uri
    ? body.verification_uri
    : "https://github.com/login/device";
  return { deviceCode: body.device_code, userCode: body.user_code, verificationUri, expiresIn, interval };
}

async function pollDevice(device: DeviceCode, options: {
  clientId: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<TokenGrant> {
  const deadline = options.now() + device.expiresIn * 1000;
  let interval = device.interval;
  while (options.now() < deadline) {
    await options.sleep(interval * 1000);
    if (options.now() >= deadline) break;
    const body = await postOAuth(ACCESS_TOKEN_URL, {
      client_id: options.clientId,
      device_code: device.deviceCode,
      grant_type: DEVICE_GRANT,
    }, options.fetchImpl, [device.deviceCode]);
    if (typeof body.error !== "string") return readGrant(body);
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      const announced = typeof body.interval === "number" ? body.interval : interval + 5;
      interval = announced > interval ? announced : interval + 5;
      continue;
    }
    throw new AuthError(deviceFailure(body, device.deviceCode));
  }
  throw new AuthError("El código ha caducado. Vuelve a ejecutar `npx copilot-agents-mcp login`.");
}

function deviceFailure(body: Record<string, unknown>, deviceCode: string): string {
  const code = typeof body.error === "string" ? body.error : "";
  if (code === "access_denied") return "Has cancelado la autorización.";
  if (code === "expired_token" || code === "token_expired") {
    return "El código ha caducado. Vuelve a ejecutar `npx copilot-agents-mcp login`.";
  }
  if (code === "device_flow_disabled") return "El device flow no está activado en la GitHub App.";
  return safeOAuthMessage("GitHub rechazó el device flow", body, [deviceCode]);
}

async function requestRefresh(clientId: string, refreshToken: string, fetchImpl: typeof fetch): Promise<TokenGrant> {
  const body = await postOAuth(ACCESS_TOKEN_URL, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, fetchImpl, [refreshToken]);
  if (body.error === "bad_refresh_token") throw new BadRefreshToken();
  if (typeof body.error === "string") throw new AuthError(safeOAuthMessage("GitHub rechazó la renovación", body, [refreshToken]));
  return readGrant(body);
}

async function postOAuth(
  url: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  secrets: string[],
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "copilot-agents-mcp",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "error de red";
    throw new AuthError(redactSecrets(`No se pudo llamar a GitHub: ${message}`, secrets));
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthError(`GitHub respondió HTTP ${response.status} y el cuerpo no es JSON.`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.error === "string" || response.ok) return record;
  throw new AuthError(`GitHub respondió HTTP ${response.status}.`);
}

function readGrant(body: Record<string, unknown>): TokenGrant {
  if (typeof body.access_token !== "string" || !body.access_token) throw new AuthError("GitHub no devolvió un access token.");
  if (typeof body.refresh_token !== "string" || !body.refresh_token) {
    throw new AuthError("GitHub no devolvió un refresh token. La app tiene que emitir tokens de usuario que caducan.");
  }
  if (typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new AuthError("GitHub no devolvió la caducidad del access token.");
  }
  const refreshExpiresIn = typeof body.refresh_token_expires_in === "number" && Number.isFinite(body.refresh_token_expires_in)
    ? body.refresh_token_expires_in
    : null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    refreshExpiresIn,
  };
}

function toStored(grant: TokenGrant, now: number): StoredCredential {
  return {
    access_token: grant.accessToken,
    refresh_token: grant.refreshToken,
    expires_at: now + grant.expiresIn * 1000,
    refresh_expires_at: grant.refreshExpiresIn === null ? null : now + grant.refreshExpiresIn * 1000,
  };
}

function serialize(credential: StoredCredential): string {
  return JSON.stringify({
    access_token: credential.access_token,
    refresh_token: credential.refresh_token,
    expires_at: credential.expires_at,
    refresh_expires_at: credential.refresh_expires_at,
  });
}

function parseStored(raw: string): StoredCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.access_token !== "string" || !record.access_token) return null;
  if (typeof record.refresh_token !== "string" || !record.refresh_token) return null;
  if (typeof record.expires_at !== "number" || !Number.isFinite(record.expires_at)) return null;
  if (record.refresh_expires_at !== null && (typeof record.refresh_expires_at !== "number" || !Number.isFinite(record.refresh_expires_at))) {
    return null;
  }
  return {
    access_token: record.access_token,
    refresh_token: record.refresh_token,
    expires_at: record.expires_at,
    refresh_expires_at: record.refresh_expires_at,
  };
}

function expiring(credential: StoredCredential, now: number): boolean {
  return credential.expires_at - now <= ACCESS_TOKEN_REFRESH_MARGIN_MS;
}

function reusable(credential: StoredCredential, rejected: string | undefined, now: number): boolean {
  if (expiring(credential, now)) return false;
  if (rejected !== undefined && credential.access_token === rejected) return false;
  return true;
}

function safeOAuthMessage(prefix: string, body: Record<string, unknown>, secrets: string[]): string {
  const code = typeof body.error === "string" ? body.error : "";
  const description = typeof body.error_description === "string" ? body.error_description : "";
  const detail = [code, description].filter(Boolean).join(": ");
  return redactSecrets(detail ? `${prefix}: ${detail}` : prefix, secrets);
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = redact(out, secret);
  return redactTokenShapes(out);
}
