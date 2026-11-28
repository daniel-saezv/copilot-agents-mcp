import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { authLockPath } from "./auth.ts";
import { acquireDirectoryLock, isLocked, releaseDirectoryLock } from "./lock.ts";
import { readState, withDirectoryLock, withStateLock } from "./state.ts";
import { watcherLockPath } from "./watch.ts";

const worker = fileURLToPath(new URL("./lock.worker.ts", import.meta.url));
const processes = 8;
const iterations = 200;
const directories: string[] = [];
const children: ChildProcess[] = [];
const signals = process.platform !== "win32";

afterEach(async () => {
  const pending = children.splice(0);
  for (const child of pending) stopChild(child);
  await Promise.all(pending.map((child) => whenExited(child)));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sqlite lock", () => {
  it("keeps 8 processes from losing increments or overlapping inside the state lock", async () => {
    const dir = await tempDir();
    const report = await runWorkers("state", dir);
    expect(report.count, report.detail).toBe(processes * iterations);
    expect(report.overlaps, report.detail).toBe(0);
    expect(report.errors, report.detail).toEqual([]);
    console.log(`state lock: count=${report.count} overlaps=${report.overlaps} errors=${report.errors.length}`);
  }, 60_000);

  it("keeps 8 processes from losing increments or overlapping inside the watcher lock", async () => {
    const dir = await tempDir();
    const report = await runWorkers("watcher", dir);
    expect(report.count, report.detail).toBe(processes * iterations);
    expect(report.overlaps, report.detail).toBe(0);
    expect(report.errors, report.detail).toEqual([]);
    console.log(`watcher lock: count=${report.count} overlaps=${report.overlaps} errors=${report.errors.length}`);
  }, 60_000);

  it.skipIf(!signals)("acquires promptly after the holder is killed with SIGKILL", async () => {
    const { lock, child } = await heldChild();
    const killAt = Date.now();
    process.kill(pidOf(child), "SIGKILL");
    await once(child, "exit");
    const deadAt = Date.now();
    const held = await acquireDirectoryLock(lock, { timeoutMs: 5_000, pollMs: 10 });
    const acquireMs = Date.now() - deadAt;
    expect(held, `kill-9 acquire ${acquireMs}ms`).not.toBeNull();
    expect(acquireMs, `kill-9 acquire ${acquireMs}ms`).toBeLessThan(1_000);
    console.log(`kill-9: exit ${deadAt - killAt}ms after SIGKILL, acquire ${acquireMs}ms after exit`);
    if (held) await releaseDirectoryLock(lock, held.owner);
  }, 15_000);

  it.skipIf(!signals)("does not steal a SIGSTOP'd holder and keeps the timeout message", async () => {
    const { lock, child } = await heldChild();
    process.kill(pidOf(child), "SIGSTOP");
    await delay(50);
    const started = Date.now();
    await expect(withDirectoryLock(lock, async () => {}, { timeoutMs: 400 })).rejects.toThrow(
      "Could not save local state: the file is in use.",
    );
    const waitedMs = Date.now() - started;
    expect(waitedMs, `SIGSTOP waiter returned in ${waitedMs}ms`).toBeGreaterThanOrEqual(400);
    await expect(withDirectoryLock(lock, async () => {}, {
      timeoutMs: 300,
      busyMessage: "Could not refresh the session: the refresh lock is in use.",
    })).rejects.toThrow("Could not refresh the session: the refresh lock is in use.");
    console.log(`SIGSTOP: waiter gave up after ${waitedMs}ms without taking the lock`);
    process.kill(pidOf(child), "SIGCONT");
  }, 15_000);

  it("keeps the lock after garbage collection finalizes unreachable objects", async () => {
    const { lock, child, stderr } = await heldChild(["--expose-gc"]);
    const started = Date.now();
    const stolen = await acquireDirectoryLock(lock, { timeoutMs: 300, pollMs: 20 });
    const waitedMs = Date.now() - started;
    expect(stolen).toBeNull();
    expect(waitedMs).toBeGreaterThanOrEqual(300);
    console.log(`gc: waiter waited ${waitedMs}ms and did not acquire`);
    child.stdin?.write("release\n");
    child.stdin?.end();
    const [status] = await once(child, "exit") as [number | null];
    expect(status, stderr()).toBe(0);
    const held = await acquireDirectoryLock(lock, { timeoutMs: 2_000, pollMs: 20 });
    expect(held).not.toBeNull();
    if (held) await releaseDirectoryLock(lock, held.owner);
  }, 15_000);

  it("ignores a legacy directory lock and uses the sqlite file names", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "state.json");
    const legacy = `${statePath}.lock`;
    await mkdir(legacy);
    await writeFile(join(legacy, "pid"), "1\n");
    await withStateLock(statePath, (state) => {
      state.models.accepted.push("kept");
    });
    expect((await readState(statePath)).models.accepted).toEqual(["kept"]);
    expect(await readFile(join(legacy, "pid"), "utf8")).toBe("1\n");
    expect(await exists(`${statePath}.lock.sqlite`)).toBe(true);
    expect(watcherLockPath(statePath)).toBe(`${statePath}.watcher.lock.sqlite`);
    expect(authLockPath(statePath)).toBe(join(dir, "auth.lock.sqlite"));
  });

  it("holds watcher locks for two state files in one directory at the same time", async () => {
    const dir = await tempDir();
    const first = spawnHolder(join(dir, "botA.json"), "watch-hold");
    const second = spawnHolder(join(dir, "botB.json"), "watch-hold");
    await Promise.all([first.held, second.held]);
    expect(first.child.exitCode).toBeNull();
    expect(second.child.exitCode).toBeNull();
    expect(watcherLockPath(join(dir, "botA.json"))).toBe(join(dir, "botA.json.watcher.lock.sqlite"));
    expect(watcherLockPath(join(dir, "botB.json"))).toBe(join(dir, "botB.json.watcher.lock.sqlite"));
    const done = Promise.all([childExit(first.child), childExit(second.child)]);
    releaseHolder(first.child);
    releaseHolder(second.child);
    const [statusA, statusB] = await done;
    expect(statusA, first.stderr()).toBe(0);
    expect(statusB, second.stderr()).toBe(0);
  }, 15_000);

  it("recognizes SQLITE_BUSY and SQLITE_LOCKED by code, including extended codes", () => {
    expect(isLocked({ errcode: 5, message: "nope" })).toBe(true);
    expect(isLocked({ errcode: 6, message: "nope" })).toBe(true);
    expect(isLocked({ errcode: (1 << 8) | 5, message: "nope" })).toBe(true);
    expect(isLocked({ errstr: 6, message: "database is locked" })).toBe(true);
    expect(isLocked({ errstr: "SQLITE_BUSY", message: "nope" })).toBe(true);
    expect(isLocked({ errcode: 26, message: "database is locked" })).toBe(false);
    expect(isLocked({ message: "database is locked" })).toBe(false);
  });

  it("names the lock path when the file is not a database and leaves the file in place", async () => {
    const dir = await tempDir();
    const lock = join(dir, "state.json.lock.sqlite");
    await writeFile(lock, "not a database");
    const started = Date.now();
    await expect(acquireDirectoryLock(lock, { timeoutMs: 5_000, pollMs: 20 })).rejects.toThrow(
      `Could not open lock ${lock}: file is not a database`,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await readFile(lock, "utf8")).toBe("not a database");
  });
});

async function heldChild(execArgv: string[] = []): Promise<{ lock: string; child: ChildProcess; stderr: () => string }> {
  const dir = await tempDir();
  const lock = join(dir, "state.json.lock.sqlite");
  const stderr: Buffer[] = [];
  const child = spawn(process.execPath, [...execArgv, worker, "hold", lock], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  await waitForHeld(child, stderr);
  return { lock, child, stderr: () => Buffer.concat(stderr).toString("utf8") };
}

function spawnHolder(target: string, kind: "hold" | "watch-hold"): { child: ChildProcess; stderr: () => string; held: Promise<void> } {
  const stderr: Buffer[] = [];
  const child = spawn(process.execPath, [worker, kind, target], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return { child, stderr: () => Buffer.concat(stderr).toString("utf8"), held: waitForHeld(child, stderr) };
}

function releaseHolder(child: ChildProcess): void {
  child.stdin?.write("release\n");
  child.stdin?.end();
}

function childExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
  });
}

function waitForHeld(child: ChildProcess, stderr: Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error(`holder did not start: ${buf} ${Buffer.concat(stderr).toString("utf8")}`));
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("held\n")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (status) => {
      clearTimeout(timer);
      reject(new Error(`holder exited ${status}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function runWorkers(kind: "state" | "watcher", dir: string): Promise<{ count: number; overlaps: number; errors: string[]; detail: string }> {
  const spawned = Array.from({ length: processes }, () => spawn(process.execPath, [worker, kind, dir, String(iterations)], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  children.push(...spawned);
  try {
    const results = await Promise.all(spawned.map((child) => collect(child)));
    const overlaps = results.reduce((sum, result) => sum + result.overlaps, 0);
    const errors = results.flatMap((result) => result.errors);
    const crashes = results.filter((result) => result.status !== 0);
    const count = await readCount(join(dir, "counter"));
    const detail = [
      `count=${count}`,
      `overlaps=${overlaps}`,
      `errors=${errors.length}`,
      `crashes=${crashes.length}`,
      errors.slice(0, 4).join(" | "),
      crashes.map((crash) => crash.stderr.trim()).filter(Boolean).slice(0, 2).join(" | "),
    ].filter(Boolean).join("; ");
    if (crashes.length > 0) {
      errors.push(...crashes.map((crash) => crash.stderr.trim() || `exit ${crash.status}`));
    }
    return { count, overlaps, errors, detail };
  } finally {
    for (const child of spawned) stopChild(child);
  }
}

async function collect(child: ChildProcess): Promise<{ status: number; overlaps: number; errors: string[]; stderr: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [status] = await once(child, "exit") as [number | null];
  const out = Buffer.concat(stdout).toString("utf8").trim();
  const err = Buffer.concat(stderr).toString("utf8");
  if (!out) return { status: status ?? 1, overlaps: 0, errors: [], stderr: err };
  const parsed = JSON.parse(out) as { overlaps: number; errors: string[] };
  return { status: status ?? 1, overlaps: parsed.overlaps, errors: parsed.errors, stderr: err };
}

async function readCount(path: string): Promise<number> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(value) ? value : 0;
  } catch (error) {
    if (isCode(error, "ENOENT")) return 0;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilot-lock-"));
  directories.push(dir);
  return dir;
}

function whenExited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
}

function pidOf(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error("holder pid missing");
  return child.pid;
}

function stopChild(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(child.pid, "SIGCONT");
  } catch {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
