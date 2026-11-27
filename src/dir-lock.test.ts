import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readState, withStateLock } from "./state.ts";
import { acquireWatcher, releaseWatcher, watcherLockPath } from "./watch.ts";

const worker = fileURLToPath(new URL("./dir-lock.worker.ts", import.meta.url));
const processes = 8;
const iterations = 200;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("directory lock", () => {
  it("keeps 8 processes from losing increments or overlapping inside the state lock", async () => {
    const dir = await tempDir();
    const report = await runWorkers("state", dir);
    expect(report.count, report.detail).toBe(processes * iterations);
    expect(report.overlaps, report.detail).toBe(0);
    expect(report.errors, report.detail).toEqual([]);
  }, 60_000);

  it("keeps 8 processes from losing increments or overlapping inside the watcher lock", async () => {
    const dir = await tempDir();
    const report = await runWorkers("watcher", dir);
    expect(report.count, report.detail).toBe(processes * iterations);
    expect(report.overlaps, report.detail).toBe(0);
    expect(report.errors, report.detail).toEqual([]);
  }, 60_000);

  it("takes over a lock whose holder process is already dead", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "state.json");
    const dead = await exitedPid();
    await plantDeadLock(`${statePath}.lock`, dead);
    await withStateLock(statePath, (state) => {
      state.models.accepted.push("recovered");
    });
    expect((await readState(statePath)).models.accepted).toEqual(["recovered"]);

    const watcher = watcherLockPath(statePath);
    await plantDeadLock(watcher, dead);
    expect(await acquireWatcher(watcher)).toBe(true);
    await releaseWatcher(watcher);
  }, 40_000);

  it("does not remove a lock whose owner token was replaced before release", async () => {
    const dir = await tempDir();
    const statePath = join(dir, "state.json");
    const lock = `${statePath}.lock`;
    const dead = await exitedPid();
    await withStateLock(statePath, async () => {
      await writeFile(join(lock, "owner"), `${dead}\n${randomUUID()}\n`);
      await writeFile(join(lock, "pid"), `${dead}\n`);
    });
    expect(await exists(lock)).toBe(true);

    const watcher = watcherLockPath(statePath);
    expect(await acquireWatcher(watcher)).toBe(true);
    await writeFile(join(watcher, "owner"), `${dead}\n${randomUUID()}\n`);
    await writeFile(join(watcher, "pid"), `${dead}\n`);
    await releaseWatcher(watcher);
    expect(await exists(watcher)).toBe(true);
  });
});

async function runWorkers(kind: "state" | "watcher", dir: string): Promise<{ count: number; overlaps: number; errors: string[]; detail: string }> {
  const children = Array.from({ length: processes }, () => spawn(process.execPath, [worker, kind, dir, String(iterations)], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  try {
    const results = await Promise.all(children.map((child) => collect(child)));
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
    for (const child of children) child.kill();
  }
}

async function collect(child: ReturnType<typeof spawn>): Promise<{ status: number; overlaps: number; errors: string[]; stderr: string }> {
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

async function plantDeadLock(lock: string, pid: number): Promise<void> {
  await mkdir(lock);
  const body = `${pid}\n`;
  await writeFile(join(lock, "pid"), body);
  await writeFile(join(lock, "owner"), `${pid}\n${randomUUID()}\n`);
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("child pid missing");
  return child.pid;
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

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
