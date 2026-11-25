import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, runWebhookCommand, type WebhookCommand } from "./cli.ts";
import { readState, withStateLock } from "./state.ts";
import { OwnerTokenError, registerWebhook, removeWebhook, resolveOwnerToken, webhookKeyPath } from "./webhooks.ts";

vi.mock("./webhook-http.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./webhook-http.ts")>(),
  validateWebhookUrl: vi.fn(async () => ({})),
}));

const dirs: string[] = [];
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

function terminal(enabled: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: enabled, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: enabled, configurable: true });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
  else Reflect.deleteProperty(process.stderr, "isTTY");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "owner-token-cli-"));
  dirs.push(dir);
  const statePath = join(dir, "state.json");
  const urlFile = join(dir, "url");
  const authFile = join(dir, "auth");
  await writeFile(urlFile, "https://8.8.8.8/URL_SECRET?query=QUERY_SECRET");
  await writeFile(authFile, "AUTH_SECRET");
  vi.stubEnv("COPILOT_AGENTS_STATE_PATH", statePath);
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    dir, statePath, stdout, stderr,
    command: { command: "webhook", action: "register", owner: "owner", urlFile, authFile } satisfies WebhookCommand,
  };
}

describe("owner token CLI", () => {
  it("parses only private token files and a flag-only terminal override", () => {
    expect(parseArgs(["webhook", "register", "--owner", "owner", "--token-file", "in", "--token-out", "out", "--force-replace"])).toMatchObject({
      tokenFile: "in", tokenOut: "out", forceReplace: true,
    });
    expect(parseArgs(["webhook", "remove", "--owner", "owner", "--token-file", "in", "--force-replace"])).toMatchObject({
      tokenFile: "in", forceReplace: true,
    });
    for (const flags of [["--token", "TOKEN_SECRET"], ["--force-replace", "--force-replace"], ["--token-out"], ["--token-file", "in", "--token-file", "other"]]) {
      expect(() => parseArgs(["webhook", "register", "--owner", "owner", ...flags])).toThrow();
    }
    expect(() => parseArgs(["webhook", "remove", "--owner", "owner", "--token-out", "out"])).toThrow();
  });

  it("outputs exactly the minted token on stdout and only its hash in state", async () => {
    const { command, statePath, stdout, stderr } = await setup();
    terminal(false);
    await runWebhookCommand(command);
    const token = stdout.mock.calls[0]?.[0] as string;
    expect(stdout).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^cam_ot_[A-Za-z0-9_-]{43}$/));
    expect(stderr).toHaveBeenCalledExactlyOnceWith("Webhook registered.");
    expect(resolveOwnerToken(await readState(statePath), token)).toBe("owner");
    expect(await readFile(statePath, "utf8")).not.toContain(token);
    for (const marker of ["URL_SECRET", "QUERY_SECRET", "AUTH_SECRET"]) {
      expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls])).not.toContain(marker);
    }
  });

  it("writes token-out privately and refuses an existing output path without rotating", async () => {
    const { command, dir, statePath, stdout } = await setup();
    terminal(false);
    const tokenOut = join(dir, "owner-token");
    await runWebhookCommand({ ...command, tokenOut });
    const token = (await readFile(tokenOut, "utf8")).trim();
    expect((await stat(tokenOut)).mode & 0o777).toBe(0o600);
    expect(stdout).not.toHaveBeenCalled();
    const before = await readFile(statePath, "utf8");
    await expect(runWebhookCommand({ ...command, tokenFile: tokenOut, tokenOut })).rejects.toThrow("Could not complete webhook operation.");
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(await readFile(tokenOut, "utf8")).toBe(`${token}\n`);
    expect(await readFile(webhookKeyPath(statePath, "owner"), "utf8")).toBe("AUTH_SECRET");
    expect(resolveOwnerToken(await readState(statePath), token)).toBe("owner");
  });

  it("protects replacement and removal and cleans up output after invalid token", async () => {
    const { command, dir, statePath } = await setup();
    terminal(false);
    const token = await registerWebhook(statePath, "owner", "https://8.8.8.8/", "original");
    const tokenFile = join(dir, "token");
    const tokenOut = join(dir, "new-token");
    await writeFile(tokenFile, "cam_ot_INVALID_SECRET");
    const before = await readFile(statePath, "utf8");
    await expect(runWebhookCommand(command)).rejects.toBeInstanceOf(OwnerTokenError);
    await expect(runWebhookCommand({ ...command, tokenFile, tokenOut })).rejects.toBeInstanceOf(OwnerTokenError);
    await expect(stat(tokenOut)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runWebhookCommand({ command: "webhook", action: "remove", owner: "owner", tokenFile })).rejects.toBeInstanceOf(OwnerTokenError);
    expect(await readFile(statePath, "utf8")).toBe(before);
    await writeFile(tokenFile, `${token}\n`);
    await runWebhookCommand({ command: "webhook", action: "remove", owner: "owner", tokenFile });
    await runWebhookCommand({ command: "webhook", action: "remove", owner: "owner", tokenFile });
    expect((await readState(statePath)).webhooks).toEqual({});
  });

  it("uses a hidden terminal prompt for the previous token when re-registering a removed owner", async () => {
    const { command, statePath, stdout } = await setup();
    const token = await registerWebhook(statePath, "owner", "https://8.8.8.8/", "original");
    await removeWebhook(statePath, "owner", { token });
    terminal(true);
    const setRawMode = process.stdin.setRawMode;
    process.stdin.setRawMode = vi.fn(() => process.stdin);
    const prompts = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => {
      queueMicrotask(() => process.stdin.emit("data", Buffer.from(`${token}\r`)));
      return process.stdin;
    });
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    try {
      await runWebhookCommand(command);
      expect(prompts).toHaveBeenCalledWith("Current owner token: ");
      expect(prompts.mock.calls.flat().join("")).not.toContain(token);
      expect(stdout.mock.calls.flat().join("")).not.toContain(token);
      const state = await readState(statePath);
      expect(() => resolveOwnerToken(state, token)).toThrow(OwnerTokenError);
    } finally {
      if (setRawMode) process.stdin.setRawMode = setRawMode;
      else Reflect.deleteProperty(process.stdin, "setRawMode");
    }
  });

  it("allows force replacement/removal only on a terminal, including legacy migration", async () => {
    const { command, statePath } = await setup();
    await withStateLock(statePath, (state) => {
      state.webhooks = { owner: { url: "https://8.8.8.8/", keyFilePath: webhookKeyPath(statePath, "owner"), registeredAt: "1970-01-01T00:00:00.000Z" } };
    });
    terminal(false);
    await expect(runWebhookCommand({ ...command, forceReplace: true })).rejects.toBeInstanceOf(OwnerTokenError);
    expect((await readState(statePath)).webhooks?.owner?.ownerTokenHash).toBeUndefined();
    terminal(true);
    await runWebhookCommand({ ...command, forceReplace: true });
    expect((await readState(statePath)).webhooks?.owner?.ownerTokenHash).toMatch(/^[a-f0-9]{64}$/);
    terminal(false);
    await expect(runWebhookCommand({ command: "webhook", action: "remove", owner: "owner", forceReplace: true })).rejects.toBeInstanceOf(OwnerTokenError);
    terminal(true);
    await runWebhookCommand({ command: "webhook", action: "remove", owner: "owner", forceReplace: true });
    expect((await readState(statePath)).webhooks).toEqual({});
    await withStateLock(statePath, (state) => {
      state.webhooks = { _default: { url: "https://8.8.8.8/", keyFilePath: webhookKeyPath(statePath, "_default"), registeredAt: "1970-01-01T00:00:00.000Z" } };
    });
    await runWebhookCommand({ command: "webhook", action: "remove", owner: "_default", forceReplace: true });
    expect((await readState(statePath)).webhooks).toEqual({});
  });
});
