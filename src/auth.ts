import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { API_VERSION, appNotInstalledMessage, AuthError, KeyringError, NO_SESSION_MESSAGE, redact, redactTokenShapes } from "./errors.ts";
import { withDirectoryLock } from "./state.ts";

export const KEYRING_SERVICE = "copilot-agents-mcp:github.com";
export const DEFAULT_GITHUB_APP_CLIENT_ID = "Iv23liNbsc3GH7vmP8OT";
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MARGIN_MINUTES = ACCESS_TOKEN_REFRESH_MARGIN_MS / 60_000;
const RELOGIN_MESSAGE = "The GitHub session expired or is no longer valid. Run `npx copilot-agents-mcp login`.";
const REFRESH_NOT_SAVED = "The refresh token stored in the keyring is no longer valid. The new session remains in memory, and saving it will be retried. If this process exits before the save succeeds, run `npx copilot-agents-mcp login`.";
const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_DELAY_MS = 50;
const OAUTH_TIMEOUT_MS = 30_000;
const APP_LOOKUP_TIMEOUT_MS = 10_000;

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
    return name || "user";
  } catch {
    return "user";
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
  const verb = names.length === 1 ? "is ignored" : "are ignored";
  return `${names.join(" and ")} ${verb}. Set GITHUB_PERSONAL_ACCESS_TOKEN or run \`npx copilot-agents-mcp login\`.`;
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
  sleep?: (ms: number) => Promise<void>;
}): AppSession {
  let memory: StoredCredential | null = null;
  let pendingSave = false;
  let storeUnread = false;
  let inflight: Promise<StoredCredential> | null = null;
  let warnedStore = false;
  let warnedSave = false;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));

  function warnStore(message: string): void {
    if (warnedStore) return;
    warnedStore = true;
    options.warn(redactTokenShapes(message));
  }

  function warnSave(): void {
    if (warnedSave) return;
    warnedSave = true;
    options.warn(redactTokenShapes(REFRESH_NOT_SAVED));
  }

  function tryWrite(credential: StoredCredential): boolean {
    try {
      options.store.write(serialize(credential));
      return true;
    } catch {
      return false;
    }
  }

  async function persist(credential: StoredCredential): Promise<void> {
    memory = credential;
    pendingSave = true;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(WRITE_RETRY_DELAY_MS);
      if (tryWrite(credential)) {
        pendingSave = false;
        return;
      }
    }
    warnSave();
  }

  function read(): StoredCredential | null {
    if (pendingSave) {
      if (memory && tryWrite(memory)) pendingSave = false;
      return memory;
    }
    if (storeUnread) return memory;
    try {
      const raw = options.store.read();
      if (raw === null) {
        memory = null;
        return null;
      }
      const parsed = parseStored(raw);
      if (!parsed) {
        warnStore("The keyring session cannot be read. Run `npx copilot-agents-mcp login`.");
        memory = null;
        return null;
      }
      memory = parsed;
      return parsed;
    } catch (error) {
      if (!(error instanceof KeyringError)) throw error;
      warnStore(`No keyring is available (${error.message}). The token remains only in this process's memory and is not written to disk.`);
      return memory;
    }
  }

  function clear(): void {
    memory = null;
    pendingSave = false;
    try {
      options.store.delete();
    } catch (error) {
      if (!(error instanceof KeyringError)) throw error;
      storeUnread = true;
      warnStore(`Could not delete the keyring session (${error.message}). The token has not been written to disk.`);
    }
  }

  function begin(rejected?: string): Promise<StoredCredential> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        return await withDirectoryLock(options.lockPath, () => refreshLocked(rejected), {
          timeoutMs: 60_000,
          busyMessage: "Could not refresh the session: the refresh lock is in use.",
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
      await persist(next);
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
  options.stdout(`Open ${device.verificationUri}`);
  options.stdout(`Enter code ${device.userCode}.`);
  options.stdout(`The code expires in ${minutes} minutes. Do not enter a code that you did not request.`);
  const grant = await pollDevice(device, options);
  const credential = toStored(grant, options.now());
  const encoded = serialize(credential);
  if (!options.persistent) {
    options.store.write(encoded);
    options.stderr("No keyring is available. The token remains only in this process's memory, is not written to disk, and is lost when the process exits.");
    await warnIfAppNotInstalled(credential.access_token, options);
    return { where: "memory", credential };
  }
  try {
    options.store.write(encoded);
  } catch (error) {
    if (!(error instanceof KeyringError)) throw error;
    options.stderr(redactTokenShapes(`No keyring is available (${error.message}). The token remains only in this process's memory, is not written to disk, and is lost when the process exits.`));
    await warnIfAppNotInstalled(credential.access_token, options);
    return { where: "memory", credential };
  }
  options.stdout("Session saved in the system keyring.");
  await warnIfAppNotInstalled(credential.access_token, options);
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
    ? "The keyring session was deleted."
    : result === "absent"
      ? "No keyring session was found."
      : "The keyring could not be used. The token has not been written to disk.";
  return [
    head,
    "To revoke access: GitHub → Settings → Applications → Authorized GitHub Apps.",
    "To remove the app from a repository or organization, uninstall it.",
  ].join("\n");
}

export function statusReport(input: {
  env: NodeJS.ProcessEnv;
  stored: StoredCredential | null;
  keyring: "ready" | "memory";
  account: string;
  appName?: string | null;
  appNotInstalled?: boolean;
}): string {
  if (personalAccessToken(input.env)) {
    const lines = ["Active credential: PAT (GITHUB_PERSONAL_ACCESS_TOKEN environment variable)."];
    if (input.stored) lines.push("A GitHub App session is stored, but it is not used while that variable is set.");
    return lines.join("\n");
  }
  if (!input.stored) return NO_SESSION_MESSAGE;
  const where = input.keyring === "memory"
    ? "only in this process's memory"
    : `in the system keyring (account "${input.account}")`;
  const clientId = githubAppClientId(input.env);
  const source = clientIdFromEnv(input.env)
    ? "COPILOT_AGENTS_GITHUB_APP_CLIENT_ID environment variable"
    : "default value";
  const appName = input.appName?.trim() || "unknown";
  const lines = [
    `Active credential: GitHub App, ${where}.`,
    input.appNotInstalled ? appNotInstalledMessage() : `App: ${appName}.`,
    `Client ID: ${clientId} (${source}).`,
    `The access token expires at ${new Date(input.stored.expires_at).toISOString()}. It refreshes ${MARGIN_MINUTES} minutes before expiry and also when GitHub returns 401.`,
  ];
  if (input.stored.refresh_expires_at !== null) {
    lines.push(`The refresh token expires at ${new Date(input.stored.refresh_expires_at).toISOString()}.`);
  } else {
    lines.push("The refresh token has no expiry time.");
  }
  if (input.keyring === "memory") lines.push("No keyring is available. The token is not on disk and is lost when the process exits.");
  return lines.join("\n");
}

export async function readGitHubAppName(accessToken: string, fetchImpl: typeof fetch): Promise<string | null> {
  return (await readGitHubApp(accessToken, fetchImpl)).name;
}

export async function readGitHubApp(accessToken: string, fetchImpl: typeof fetch): Promise<{ name: string | null; empty: boolean }> {
  try {
    const body = await readGitHubJson(fetchImpl, "https://api.github.com/user/installations", accessToken);
    if (!body) return { name: null, empty: false };
    if (body.total_count === 0) return { name: null, empty: true };
    const slug = installedAppSlug(body);
    if (!slug) return { name: null, empty: false };
    const app = await readGitHubJson(fetchImpl, `https://api.github.com/apps/${encodeURIComponent(slug)}`);
    const name = app && typeof app.name === "string" ? app.name.trim() : "";
    return { name: name || null, empty: false };
  } catch {
    return { name: null, empty: false };
  }
}

async function warnIfAppNotInstalled(accessToken: string, options: {
  fetchImpl: typeof fetch;
  stdout: (line: string) => void;
}): Promise<void> {
  const app = await readGitHubApp(accessToken, options.fetchImpl);
  if (app.empty) options.stdout(appNotInstalledMessage());
}

function clientIdFromEnv(env: NodeJS.ProcessEnv): boolean {
  const override = env.COPILOT_AGENTS_GITHUB_APP_CLIENT_ID;
  return typeof override === "string" && override.trim() !== "";
}

function installedAppSlug(body: Record<string, unknown>): string | null {
  const installations = body.installations;
  if (!Array.isArray(installations)) return null;
  for (const item of installations) {
    if (!item || typeof item !== "object") continue;
    const slug = "app_slug" in item ? item.app_slug : undefined;
    if (typeof slug === "string" && slug.trim()) return slug.trim();
  }
  return null;
}

async function readGitHubJson(
  fetchImpl: typeof fetch,
  url: string,
  token?: string,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "copilot-agents-mcp",
    "x-github-api-version": API_VERSION,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(APP_LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
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
  if (typeof body.error === "string") throw new AuthError(safeOAuthMessage("GitHub rejected the device flow", body, []));
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new AuthError("GitHub did not return a verification code.");
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
    const remaining = deadline - options.now();
    await options.sleep(Math.min(interval * 1000, remaining));
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
  throw new AuthError("The code expired. Run `npx copilot-agents-mcp login` again.");
}

function deviceFailure(body: Record<string, unknown>, deviceCode: string): string {
  const code = typeof body.error === "string" ? body.error : "";
  if (code === "access_denied") return "You denied the authorization.";
  if (code === "expired_token" || code === "token_expired") {
    return "The code expired. Run `npx copilot-agents-mcp login` again.";
  }
  if (code === "device_flow_disabled") return "The GitHub App does not have device flow enabled.";
  return safeOAuthMessage("GitHub rejected the device flow", body, [deviceCode]);
}

async function requestRefresh(clientId: string, refreshToken: string, fetchImpl: typeof fetch): Promise<TokenGrant> {
  const body = await postOAuth(ACCESS_TOKEN_URL, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, fetchImpl, [refreshToken]);
  if (body.error === "bad_refresh_token") throw new BadRefreshToken();
  if (typeof body.error === "string") throw new AuthError(safeOAuthMessage("GitHub rejected the refresh", body, [refreshToken]));
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
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeout(error)) throw new AuthError(`GitHub did not respond in time (${OAUTH_TIMEOUT_MS / 1000} s).`);
    const message = error instanceof Error ? error.message : "network error";
    throw new AuthError(redactSecrets(`Could not call GitHub: ${message}`, secrets));
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
    throw new AuthError(`GitHub returned HTTP ${response.status} and a non-JSON body.`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.error === "string" || response.ok) return record;
  throw new AuthError(`GitHub returned HTTP ${response.status}.`);
}

function readGrant(body: Record<string, unknown>): TokenGrant {
  if (typeof body.access_token !== "string" || !body.access_token) throw new AuthError("GitHub did not return an access token.");
  if (typeof body.refresh_token !== "string" || !body.refresh_token) {
    throw new AuthError("GitHub did not return a refresh token. The app must issue expiring user tokens.");
  }
  if (typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new AuthError("GitHub did not return the access token expiry.");
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

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = redact(out, secret);
  return redactTokenShapes(out);
}
