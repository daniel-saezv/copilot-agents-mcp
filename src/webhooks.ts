import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readState, withStateLock, type StateFile, type TrackedTask } from "./state.ts";
import { validateOwner } from "./tasks.ts";
import { validateWebhookUrl, WebhookValidationError } from "./webhook-http.ts";

export type WebhookRegistration = NonNullable<StateFile["webhooks"]>[string];
export const WEBHOOK_ERROR = "Could not complete webhook operation.";
export const WEBHOOK_INPUT_ERROR = "Invalid webhook input. Use a valid --owner, secret files (--url-file and --auth-file) or hidden terminal prompts, and a nonempty single-line Authorization value.";

export function webhookKeyPath(statePath: string, owner: string): string {
  const digest = createHash("sha256").update(validateOwner(owner)).digest("hex");
  return join(dirname(statePath), digest);
}

export function ownerWebhook(state: StateFile, task: TrackedTask): WebhookRegistration | undefined {
  if (!task.owner || !task.created_at || !Object.hasOwn(state.webhooks ?? {}, task.owner)) return undefined;
  const registration = state.webhooks?.[task.owner];
  if (registration && Date.parse(task.created_at) > Date.parse(registration.registeredAt)) return registration;
  return undefined;
}

export async function registerWebhook(
  statePath: string,
  owner: string,
  url: string,
  authorization: string,
  options?: { env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<void> {
  try {
    owner = validateOwner(owner);
  } catch {
    throw new Error(WEBHOOK_INPUT_ERROR);
  }
  if (!authorization.trim() || /[\r\n]/.test(authorization)) throw new Error(WEBHOOK_INPUT_ERROR);
  try {
    await validateWebhookUrl(url, options?.env ?? process.env);
    await withStateLock(statePath, async (state) => {
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
        value: { url, keyFilePath, registeredAt: new Date((options?.now ?? Date.now)()).toISOString() },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  } catch (error) {
    if (error instanceof WebhookValidationError) throw error;
    throw new Error(WEBHOOK_ERROR);
  }
}

export async function removeWebhook(statePath: string, owner: string): Promise<void> {
  try {
    owner = validateOwner(owner);
    await withStateLock(statePath, async (state) => {
      await rm(webhookKeyPath(statePath, owner), { force: true });
      if (state.webhooks) Reflect.deleteProperty(state.webhooks, owner);
    });
  } catch {
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
      return { owner, host: new URL(registration.url).hostname, keyFilePath, registeredAt: registration.registeredAt, keyPresent, keyMode0600 };
    }));
  } catch {
    throw new Error(WEBHOOK_ERROR);
  }
}
