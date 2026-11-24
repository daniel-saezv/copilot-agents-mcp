import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialTask, readState, withStateLock } from "./state.ts";
import { listWebhooks, ownerWebhook, registerWebhook, removeWebhook, webhookKeyPath, WEBHOOK_ERROR, WEBHOOK_INPUT_ERROR } from "./webhooks.ts";
import { validateWebhookUrl, WebhookValidationError } from "./webhook-http.ts";
import { buildLocalStatusDiagnostics } from "./status-local.ts";

vi.mock("./webhook-http.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./webhook-http.ts")>(),
  validateWebhookUrl: vi.fn(async () => ({})),
}));

const dirs: string[] = [];
async function statePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), ".webhooks-test-"));
  dirs.push(dir);
  return join(dir, "state.json");
}
afterEach(async () => {
  vi.mocked(validateWebhookUrl).mockClear();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("owner webhook registry", () => {
  it("writes only the key path to state, preserves tasks, and atomically updates a private key", async () => {
    const path = await statePath();
    await withStateLock(path, (state) => {
      state.models.accepted.push("existing-model");
      state.tasks.task = initialTask({ id: "task", repo: "a/b", requestedModel: "m", state: "queued", createdAt: null, updatedAt: null });
    });
    await registerWebhook(path, "Thrall", "https://8.8.8.8/private?key=URL_SECRET", "AUTH_SECRET", { now: () => 1000 });
    const key = webhookKeyPath(path, "Thrall");
    expect((await lstat(key)).mode & 0o777).toBe(0o600);
    expect(await readFile(key, "utf8")).toBe("AUTH_SECRET");
    const state = await readState(path);
    expect(state.models.accepted).toEqual(["existing-model"]);
    expect(state.tasks.task?.task_id).toBe("task");
    expect(state.webhooks?.Thrall).toEqual({ url: "https://8.8.8.8/private?key=URL_SECRET", keyFilePath: key, registeredAt: "1970-01-01T00:00:01.000Z" });
    expect(await readFile(path, "utf8")).not.toContain("AUTH_SECRET");
    await chmod(key, 0o644);
    await registerWebhook(path, "Thrall", "https://8.8.8.8/replaced", "replacement", { now: () => 2000 });
    expect((await lstat(key)).mode & 0o777).toBe(0o600);
    expect(await readFile(key, "utf8")).toBe("replacement");
    const listed = await listWebhooks(path);
    expect(listed).toEqual([{ owner: "Thrall", host: "8.8.8.8", keyFilePath: key, registeredAt: "1970-01-01T00:00:02.000Z", keyPresent: true, keyMode0600: true }]);
  });

  it("never follows key symlinks during registration, diagnosis, or removal", async () => {
    const path = await statePath();
    const target = join(path, "..", "target");
    await writeFile(target, "untouched");
    const key = webhookKeyPath(path, "owner");
    await symlink(target, key);
    await registerWebhook(path, "owner", "https://8.8.8.8/", "private");
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect((await lstat(key)).isSymbolicLink()).toBe(false);
    await rm(key);
    await symlink(target, key);
    expect((await listWebhooks(path))[0]).toMatchObject({ keyPresent: false, keyMode0600: false });
    await removeWebhook(path, "owner");
    await removeWebhook(path, "owner");
    expect(await listWebhooks(path)).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("untouched");
    await expect(lstat(key)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes exact owners only for tasks created strictly after registration", async () => {
    const path = await statePath();
    await registerWebhook(path, "Thrall", "https://8.8.8.8/", "private", { now: () => 2000 });
    const state = await readState(path);
    const task = initialTask({ id: "task", repo: "a/b", requestedModel: "m", state: "queued", createdAt: "1970-01-01T00:00:02.001Z", updatedAt: null, owner: "Thrall" });
    expect(ownerWebhook(state, task)).toEqual(state.webhooks?.Thrall);
    for (const created_at of [null, "invalid", "1970-01-01T00:00:01.000Z", "1970-01-01T00:00:02.000Z"]) {
      expect(ownerWebhook(state, { ...task, created_at })).toBeUndefined();
    }
    expect(ownerWebhook(state, { ...task, owner: "thrall" })).toBeUndefined();
    expect(ownerWebhook(state, { ...task, owner: undefined })).toBeUndefined();
    await registerWebhook(path, "__proto__", "https://8.8.8.8/", "private");
    expect(Object.hasOwn((await readState(path)).webhooks ?? {}, "__proto__")).toBe(true);
  });

  it("sanitizes validation failures without changing registration or key", async () => {
    const path = await statePath();
    await registerWebhook(path, "owner", "https://8.8.8.8/", "original");
    vi.mocked(validateWebhookUrl).mockRejectedValueOnce(new Error("URL_SECRET AUTH_SECRET"));
    await expect(registerWebhook(path, "owner", "URL_SECRET", "AUTH_SECRET")).rejects.toThrow(new Error(WEBHOOK_ERROR));
    expect(await readFile(webhookKeyPath(path, "owner"), "utf8")).toBe("original");
    await expect(registerWebhook(path, "bad owner", "URL_SECRET", "AUTH_SECRET")).rejects.toThrow(new Error(WEBHOOK_INPUT_ERROR));
    await expect(registerWebhook(path, "owner", "https://8.8.8.8/", "bad\nheader")).rejects.toThrow(new Error(WEBHOOK_INPUT_ERROR));
  });

  it.each(["input", "https", "nonPublic", "allowedHost", "dns"] as const)("preserves the safe %s validation reason without changing the key", async (reason) => {
    const path = await statePath();
    await registerWebhook(path, "owner", "https://8.8.8.8/", "original");
    const before = await readFile(path, "utf8");
    const error = new WebhookValidationError(reason);
    vi.mocked(validateWebhookUrl).mockRejectedValueOnce(error);
    await expect(registerWebhook(path, "owner", "URL_SECRET", "AUTH_SECRET")).rejects.toBe(error);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readFile(webhookKeyPath(path, "owner"), "utf8")).toBe("original");
  });

  it("shows host and key metadata without reading key contents or printing URL secrets", async () => {
    const path = await statePath();
    await registerWebhook(path, "owner", "https://8.8.8.8/URL_SECRET?key=QUERY_SECRET", "AUTH_SECRET");
    const report = () => buildLocalStatusDiagnostics({ COPILOT_AGENTS_STATE_PATH: path });
    expect((await report()).text).toContain("Owner webhook: owner — host: 8.8.8.8 — key present: yes — mode0600: yes");
    await chmod(webhookKeyPath(path, "owner"), 0o644);
    expect((await report()).text).toContain("key present: yes — mode0600: no");
    await rm(webhookKeyPath(path, "owner"));
    const { text } = await report();
    expect(text).toContain("key present: no — mode0600: no");
    for (const marker of ["URL_SECRET", "QUERY_SECRET", "AUTH_SECRET"]) expect(text).not.toContain(marker);
    await removeWebhook(path, "owner");
    await removeWebhook(path, "owner");
    expect(await listWebhooks(path)).toEqual([]);
  });
});
