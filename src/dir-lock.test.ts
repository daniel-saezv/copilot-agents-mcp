import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDirectoryLock, directoryLockTestHooks, releaseDirectoryLock } from "./dir-lock.ts";
import { readState, withStateLock } from "./state.ts";
import { acquireWatcher, releaseWatcher, watcherLockPath } from "./watch.ts";

const worker = fileURLToPath(new URL("./dir-lock.worker.ts", import.meta.url));
const processes = 8;
const iterations = 200;
const directories: string[] = [];

afterEach(async () => {
  directoryLockTestHooks.beforePublish = null;
  directoryLockTestHooks.beforeTakeEmpty = null;
  directoryLockTestHooks.beforeRestore = null;
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

  it("does not grant two holders or leave a stale directory when publish stalls on an empty lock", async () => {
    const dir = await tempDir();
    const lock = join(dir, "lock");
    const publishGate = deferred();
    const takeGate = deferred();
    const restoreGate = deferred();
    const publishStarted = deferred();
    const takeStarted = deferred();
    const restoreStarted = deferred();
    let pausedPublish = false;
    let pausedTake = false;
    const held: Array<{ owner: string } | null> = [];

    directoryLockTestHooks.beforePublish = async () => {
      if (pausedPublish) return;
      pausedPublish = true;
      publishStarted.resolve();
      await publishGate.promise;
    };
    directoryLockTestHooks.beforeTakeEmpty = async () => {
      if (pausedTake) return;
      pausedTake = true;
      takeStarted.resolve();
      await takeGate.promise;
    };
    directoryLockTestHooks.beforeRestore = async () => {
      restoreStarted.resolve();
      await restoreGate.promise;
    };

    const options = { timeoutMs: 2_000, pollMs: 20 };
    const pending: Array<Promise<{ owner: string } | null>> = [];
    try {
      const first = acquireDirectoryLock(lock, options);
      pending.push(first);
      await publishStarted.promise;
      const aged = new Date(Date.now() - 10_000);
      await utimes(lock, aged, aged);
      const second = acquireDirectoryLock(lock, options);
      pending.push(second);
      const sawTake = await Promise.race([
        takeStarted.promise.then(() => true),
        second.then(() => false),
      ]);
      expect(sawTake).toBe(true);

      publishGate.resolve();
      held[0] = await first;
      takeGate.resolve();
      const restoring = await Promise.race([
        restoreStarted.promise.then(() => true),
        second.then(() => false),
      ]);
      if (restoring) {
        const third = acquireDirectoryLock(lock, options);
        pending.push(third);
        held[2] = await third;
        restoreGate.resolve();
      }
      held[1] = await second;
      expect(held[0]).not.toBeNull();
      await expectExclusive(dir, lock, held);
    } finally {
      publishGate.resolve();
      takeGate.resolve();
      restoreGate.resolve();
      directoryLockTestHooks.beforePublish = null;
      directoryLockTestHooks.beforeTakeEmpty = null;
      directoryLockTestHooks.beforeRestore = null;
      const settled = await Promise.all(pending.map((attempt) => attempt.catch(() => null)));
      const released = new Set<string>();
      for (const owner of [...held, ...settled]) {
        if (!owner || released.has(owner.owner)) continue;
        released.add(owner.owner);
        await releaseDirectoryLock(lock, owner.owner);
      }
    }
  }, 20_000);

  it.each(["state", "watcher"] as const)("reclaims a legacy dead-pid directory through the %s lock", async (kind) => {
    const dead = await exitedPid();
    const { dir, statePath, lock } = await agedLock(kind, async (path) => {
      await writeFile(join(path, "pid"), `${dead}\n`);
    });
    await expectReclaimed(kind, dir, statePath, lock);
  }, 45_000);

  it.each(["state", "watcher"] as const)("reclaims a directory that only holds a stray claim file through the %s lock", async (kind) => {
    const dead = await exitedPid();
    const { dir, statePath, lock } = await agedLock(kind, async (path) => {
      await writeFile(join(path, `claim.${dead}.${randomUUID()}`), `${dead}\n${randomUUID()}\n`);
    });
    await expectReclaimed(kind, dir, statePath, lock);
  }, 45_000);

  it.each(["state", "watcher"] as const)("does not steal a legacy pid directory while that pid is alive through the %s lock", async (kind) => {
    const { dir, lock } = await agedLock(kind, async (path) => {
      await writeFile(join(path, "pid"), `${process.pid}\n`);
    });
    const held = await acquireDirectoryLock(lock, { timeoutMs: 400, pollMs: 20 });
    expect(held).toBeNull();
    expect(await readFile(join(lock, "pid"), "utf8")).toBe(`${process.pid}\n`);
    expect(await staleNames(dir)).toEqual([]);
  }, 5_000);
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

async function agedLock(
  kind: "state" | "watcher",
  fill: (lock: string) => Promise<void>,
): Promise<{ dir: string; statePath: string; lock: string }> {
  const dir = await tempDir();
  const statePath = join(dir, "state.json");
  const lock = kind === "state" ? `${statePath}.lock` : watcherLockPath(statePath);
  await mkdir(lock);
  await fill(lock);
  const aged = new Date(Date.now() - 10_000);
  await utimes(lock, aged, aged);
  return { dir, statePath, lock };
}

async function expectReclaimed(
  kind: "state" | "watcher",
  dir: string,
  statePath: string,
  lock: string,
): Promise<void> {
  const started = Date.now();
  if (kind === "state") {
    await withStateLock(statePath, (state) => {
      state.models.accepted.push("recovered");
    });
    expect((await readState(statePath)).models.accepted).toEqual(["recovered"]);
  } else {
    const acquired = await acquireWatcher(lock);
    expect(acquired, "watcher lock was not reclaimed").toBe(true);
    await releaseWatcher(lock);
  }
  const elapsed = Date.now() - started;
  expect(elapsed, `${kind} took ${elapsed}ms`).toBeLessThan(1_000);
  expect(await exists(lock)).toBe(false);
  expect(await staleNames(dir)).toEqual([]);
}

async function staleNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes(".stale-"));
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectExclusive(
  dir: string,
  lock: string,
  held: Array<{ owner: string } | null | undefined>,
): Promise<void> {
  const owners = held.flatMap((item) => item ? [item.owner] : []);
  let canonical: string | null = null;
  try {
    canonical = await readFile(join(lock, "owner"), "utf8");
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  const names = await readdir(dir);
  const detail = `holders=${owners.length} canonical=${canonical ?? "absent"} entries=${names.join(",") || "none"}`;
  expect(owners.length, detail).toBeLessThanOrEqual(1);
  expect(owners.every((owner) => owner === canonical), detail).toBe(true);
  expect(names.some((name) => name.includes(".stale-")), detail).toBe(false);
  if (canonical !== null && owners.length === 0) {
    const pid = Number(canonical.split("\n", 1)[0]);
    expect(pid, detail).not.toBe(process.pid);
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
