import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readState, withStateLock, type StateFile, type TrackedTask } from "./state.ts";
import { validateOwner } from "./tasks.ts";
import { validateWebhookUrl, WebhookValidationError } from "./webhook-http.ts";

export type WebhookRegistration = NonNullable<StateFile["webhooks"]>[string];
export const WEBHOOK_ERROR = "Could not complete webhook operation.";
export const WEBHOOK_INPUT_ERROR = "Invalid webhook input. Use a valid --owner, secret files (--url-file and --auth-file) or hidden terminal prompts, and a nonempty single-line Authorization value.";

export class OwnerTokenError extends Error {
  constructor() {
    super("A valid owner token is required. Legacy registrations need re-registration with --force-replace.");
    this.name = "OwnerTokenError";
  }
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function matchesToken(hash: string | undefined, digest: Buffer): boolean {
  return Boolean(hash && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(digest, Buffer.from(hash, "hex")));
}

export function resolveOwnerToken(state: StateFile, token?: string): string | undefined {
  if (token === undefined) return undefined;
  const digest = tokenHash(token);
  let owner: string | undefined;
  for (const [candidate, registration] of Object.entries(state.webhooks ?? {})) {
    if (matchesToken(registration.ownerTokenHash, digest)) owner = candidate;
  }
  if (owner === undefined) throw new OwnerTokenError();
  return owner;
}

export type OwnerTokenOptions = { token?: string; forceReplace?: boolean };

function authorizeChange(state: StateFile, owner: string, options?: OwnerTokenOptions): void {
  if (options?.forceReplace) return;
  const registered = Object.hasOwn(state.webhooks ?? {}, owner);
  const removed = Object.hasOwn(state.ownerTokenHashes ?? {}, owner);
  if (!registered && !removed && !Object.values(state.tasks).some((task) => task.owner === owner)) return;
  const hash = registered ? state.webhooks?.[owner]?.ownerTokenHash : state.ownerTokenHashes?.[owner];
  if (options?.token === undefined || !matchesToken(hash, tokenHash(options.token))) throw new OwnerTokenError();
}

export function webhookKeyPath(statePath: string, owner: string): string {
  const digest = createHash("sha256").update(validateOwner(owner)).digest("hex");
  return join(dirname(statePath), digest);
}

export function ownerWebhook(state: StateFile, task: TrackedTask): WebhookRegistration | undefined {
  if (!task.owner || !task.created_at || !Object.hasOwn(state.webhooks ?? {}, task.owner)) return undefined;
  const registration = state.webhooks?.[task.owner];
  if (registration?.ownerTokenHash && Date.parse(task.created_at) > Date.parse(registration.registeredAt)) return registration;
  return undefined;
}

export async function registerWebhook(
  statePath: string,
  owner: string,
  url: string,
  authorization: string,
  options?: OwnerTokenOptions & { env?: NodeJS.ProcessEnv; now?: () => number; prepareToken?: (token: string) => Promise<void> },
): Promise<string> {
  try {
    owner = validateOwner(owner);
    if (owner === "_default") throw new Error(WEBHOOK_INPUT_ERROR);
  } catch {
    throw new Error(WEBHOOK_INPUT_ERROR);
  }
  if (!authorization.trim() || /[\r\n]/.test(authorization)) throw new Error(WEBHOOK_INPUT_ERROR);
  try {
    await validateWebhookUrl(url, options?.env ?? process.env);
    return await withStateLock(statePath, async (state) => {
      authorizeChange(state, owner, options);
      const token = `cam_ot_${randomBytes(32).toString("base64url")}`;
      const registeredAt = new Date((options?.now ?? Date.now)()).toISOString();
      await options?.prepareToken?.(token);
      const keyFilePath = webhookKeyPath(statePath, owner);
      const staging = `${keyFilePath}.${randomUUID()}`;
      try {
        const file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(authorization, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(staging, keyFilePath);
      } finally {
        await rm(staging, { force: true });
      }
      state.webhooks ??= {};
      Object.defineProperty(state.webhooks, owner, {
        value: { url, keyFilePath, registeredAt, ownerTokenHash: tokenHash(token).toString("hex") },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (state.ownerTokenHashes) Reflect.deleteProperty(state.ownerTokenHashes, owner);
      return token;
    });
  } catch (error) {
    if (error instanceof WebhookValidationError || error instanceof OwnerTokenError) throw error;
    throw new Error(WEBHOOK_ERROR);
  }
}

export async function removeWebhook(statePath: string, owner: string, options?: OwnerTokenOptions): Promise<void> {
  try {
    owner = validateOwner(owner);
    await withStateLock(statePath, async (state) => {
      if (!Object.hasOwn(state.webhooks ?? {}, owner)) {
        if (options?.forceReplace) authorizeChange(state, owner, options);
        return;
      }
      authorizeChange(state, owner, options);
      state.ownerTokenHashes ??= {};
      Object.defineProperty(state.ownerTokenHashes, owner, {
        value: state.webhooks?.[owner]?.ownerTokenHash ?? "",
        enumerable: true,
        writable: true,
        configurable: true,
      });
      await rm(webhookKeyPath(statePath, owner), { force: true });
      if (state.webhooks) Reflect.deleteProperty(state.webhooks, owner);
    });
  } catch (error) {
    if (error instanceof OwnerTokenError) throw error;
    throw new Error(WEBHOOK_ERROR);
  }
}

export type ListedWebhook = {
  owner: string;
  host: string;
  keyFilePath: string;
  registeredAt: string;
  keyPresent: boolean;
  keyMode0600: boolean;
  needsReregistration: boolean;
};

export async function listWebhooks(statePath: string): Promise<ListedWebhook[]> {
  try {
    const state = await readState(statePath);
    return await Promise.all(Object.entries(state.webhooks ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(async ([owner, registration]) => {
      let keyPresent = false;
      let keyMode0600 = false;
      const keyFilePath = webhookKeyPath(statePath, owner);
      if (registration.keyFilePath === keyFilePath) {
        try {
          const stat = await lstat(keyFilePath);
          keyPresent = stat.isFile();
          keyMode0600 = keyPresent && (stat.mode & 0o777) === 0o600;
        } catch {
          // A missing or inaccessible key is a diagnostic, not a secret read.
        }
      }
      return { owner, host: new URL(registration.url).hostname, keyFilePath, registeredAt: registration.registeredAt, keyPresent, keyMode0600, needsReregistration: !registration.ownerTokenHash };
    }));
  } catch {
    throw new Error(WEBHOOK_ERROR);
  }
}
