import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withStateLock } from "./state.ts";
import { acquireWatcher, releaseWatcher, watcherLockPath } from "./watch.ts";

const kind = process.argv[2];
const dir = process.argv[3];
const iterations = Number(process.argv[4]);

if ((kind !== "state" && kind !== "watcher") || !dir || !Number.isInteger(iterations) || iterations <= 0) {
  process.stderr.write("usage: dir-lock.worker.ts <state|watcher> <dir> <iterations>\n");
  process.exit(1);
}

const statePath = join(dir, "state.json");
const counterPath = join(dir, "counter");
const insidePath = join(dir, "inside");

try {
  const result = await run();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}

async function run(): Promise<{ overlaps: number; errors: string[] }> {
  let overlaps = 0;
  const errors: string[] = [];
  for (let index = 0; index < iterations; index += 1) {
    try {
      if (kind === "state") overlaps += await incrementState();
      else overlaps += await incrementWatcher();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { overlaps, errors };
}

async function incrementState(): Promise<number> {
  let overlaps = 0;
  await withStateLock(statePath, async () => {
    overlaps += await bumpCounter();
  });
  return overlaps;
}

async function incrementWatcher(): Promise<number> {
  const lock = watcherLockPath(statePath);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await acquireWatcher(lock)) break;
    if (Date.now() > deadline) throw new Error("watcher lock timed out");
  }
  try {
    return await bumpCounter();
  } finally {
    await releaseWatcher(lock);
  }
}

async function bumpCounter(): Promise<number> {
  const overlaps = await markInside() ? 0 : 1;
  const current = await readCount();
  await writeFile(counterPath, `${current + 1}\n`);
  if (overlaps === 0) await rm(insidePath, { force: true });
  return overlaps;
}

async function markInside(): Promise<boolean> {
  try {
    await writeFile(insidePath, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function readCount(): Promise<number> {
  try {
    const value = Number((await readFile(counterPath, "utf8")).trim());
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (isCode(error, "ENOENT")) return 0;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
