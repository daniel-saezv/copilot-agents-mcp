import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireDirectoryLock, releaseDirectoryLock } from "./lock.ts";
import { withStateLock } from "./state.ts";
import { acquireWatcher, releaseWatcher, watcherLockPath } from "./watch.ts";

const kind = process.argv[2];
const target = process.argv[3];
const iterations = Number(process.argv[4]);

if (kind === "hold" || kind === "watch-hold") {
  if (!target) {
    process.stderr.write("usage: lock.worker.ts hold <lock> | watch-hold <state>\n");
    process.exit(1);
  }
  try {
    if (kind === "hold") await hold(target);
    else await watchHold(target);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
} else {
  if ((kind !== "state" && kind !== "watcher") || !target || !Number.isInteger(iterations) || iterations <= 0) {
    process.stderr.write("usage: lock.worker.ts <state|watcher> <dir> <iterations>\n");
    process.exit(1);
  }
  try {
    const result = await run(kind, target, iterations);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
}

async function watchHold(statePath: string): Promise<void> {
  const lock = watcherLockPath(statePath);
  if (!await acquireWatcher(lock)) throw new Error("watcher lock timed out");
  await signalHeld();
  await waitForRelease();
  await releaseWatcher(lock);
}

async function hold(lock: string): Promise<void> {
  const held = await acquireDirectoryLock(lock, { timeoutMs: 5_000, pollMs: 20 });
  if (!held) throw new Error("could not acquire lock");
  const gc = (globalThis as { gc?: (options?: { execution?: "sync"; type?: "major" }) => void }).gc;
  if (process.execArgv.includes("--expose-gc")) {
    if (typeof gc !== "function") throw new Error("gc was not exposed");
    gc({ execution: "sync", type: "major" });
    await new Promise((resolve) => setImmediate(resolve));
    gc({ execution: "sync", type: "major" });
  }
  await signalHeld();
  await waitForRelease();
  await releaseDirectoryLock(lock, held.owner);
}

function signalHeld(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write("held\n", () => resolve());
  });
}

async function waitForRelease(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString("utf8");
    if (text.includes("release")) return;
  }
}

async function run(
  mode: "state" | "watcher",
  dir: string,
  rounds: number,
): Promise<{ overlaps: number; errors: string[] }> {
  let overlaps = 0;
  const errors: string[] = [];
  for (let index = 0; index < rounds; index += 1) {
    try {
      if (mode === "state") overlaps += await incrementState(dir);
      else overlaps += await incrementWatcher(dir);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { overlaps, errors };
}

async function incrementState(dir: string): Promise<number> {
  let overlaps = 0;
  await withStateLock(join(dir, "state.json"), async () => {
    overlaps += await bumpCounter(dir);
  });
  return overlaps;
}

async function incrementWatcher(dir: string): Promise<number> {
  const lock = watcherLockPath(join(dir, "state.json"));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await acquireWatcher(lock)) break;
    if (Date.now() > deadline) throw new Error("watcher lock timed out");
  }
  try {
    return await bumpCounter(dir);
  } finally {
    await releaseWatcher(lock);
  }
}

async function bumpCounter(dir: string): Promise<number> {
  const counterPath = join(dir, "counter");
  const insidePath = join(dir, "inside");
  const overlaps = await markInside(insidePath) ? 0 : 1;
  const current = await readCount(counterPath);
  await writeFile(counterPath, `${current + 1}\n`);
  if (overlaps === 0) await rm(insidePath, { force: true });
  return overlaps;
}

async function markInside(path: string): Promise<boolean> {
  try {
    await writeFile(path, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function readCount(path: string): Promise<number> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (isCode(error, "ENOENT")) return 0;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
