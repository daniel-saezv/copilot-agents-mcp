import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EMPTY_LOCK_GRACE_MS = 2_000;

type DirectoryLockHook = () => Promise<void>;

export const directoryLockTestHooks: {
  beforePublish: DirectoryLockHook | null;
  beforeTakeEmpty: DirectoryLockHook | null;
  beforeOwnerlessTakeover: DirectoryLockHook | null;
  beforeOwnerlessRename: DirectoryLockHook | null;
  beforeOwnerlessSettle: DirectoryLockHook | null;
  beforeRestore: DirectoryLockHook | null;
} = {
  beforePublish: null,
  beforeTakeEmpty: null,
  beforeOwnerlessTakeover: null,
  beforeOwnerlessRename: null,
  beforeOwnerlessSettle: null,
  beforeRestore: null,
};

export async function acquireDirectoryLock(
  lock: string,
  options: { timeoutMs: number; pollMs: number },
): Promise<{ owner: string } | null> {
  await mkdir(dirname(lock), { recursive: true });
  const owner = `${process.pid}\n${randomUUID()}\n`;
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const inspection = await inspect(lock);
      if (inspection.kind === "absent") continue;
      if (inspection.kind === "live") {
        if (Date.now() - started > options.timeoutMs) return null;
        await delay(options.pollMs);
        continue;
      }
      const removed = await steal(lock, inspection.owner);
      if (!removed) {
        if (Date.now() - started > options.timeoutMs) return null;
        await delay(options.pollMs);
      }
      continue;
    }
    if (directoryLockTestHooks.beforePublish !== null) await directoryLockTestHooks.beforePublish();
    try {
      await writeFile(join(lock, "owner"), owner, { flag: "wx" });
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "EEXIST")) continue;
      throw error;
    }
    try {
      if (await readFile(join(lock, "owner"), "utf8") === owner) return { owner };
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
}

export async function releaseDirectoryLock(lock: string, owner: string): Promise<void> {
  if (await readMaybe(join(lock, "owner")) !== owner) return;
  const grave = `${lock}.release-${process.pid}-${randomUUID()}`;
  try {
    await rename(lock, grave);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (await readMaybe(join(grave, "owner")) === owner) {
    await rm(grave, { recursive: true, force: true });
    return;
  }
  await restoreDir(grave, lock);
}

type Inspection =
  | { kind: "absent" }
  | { kind: "live" }
  | { kind: "stale"; owner: string | null };

async function inspect(lock: string): Promise<Inspection> {
  const owner = await readMaybe(join(lock, "owner"));
  if (owner !== null) return ownerAlive(owner) ? { kind: "live" } : { kind: "stale", owner };
  try {
    const info = await stat(lock);
    const claim = await readMaybe(join(lock, "claim"));
    if (claim !== null && ownerAlive(claim)) return { kind: "live" };
    const pid = await readMaybe(join(lock, "pid"));
    if (pid !== null && ownerAlive(pid)) return { kind: "live" };
    if (claim === null && Date.now() - info.mtimeMs < EMPTY_LOCK_GRACE_MS) return { kind: "live" };
    return { kind: "stale", owner: null };
  } catch (error) {
    if (isCode(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
}

async function steal(lock: string, expected: string | null): Promise<boolean> {
  if (expected === null) return removeAbandonedEmpty(lock);
  const claim = `${process.pid}\n${randomUUID()}\n`;
  if (!await claimStale(lock, claim)) return false;
  const grave = `${lock}.stale-${process.pid}-${randomUUID()}`;
  let consumed = false;
  try {
    const ownerNow = await readMaybe(join(lock, "owner"));
    const claimNow = await readMaybe(join(lock, "claim"));
    if (ownerNow !== expected || claimNow !== claim || ownerAlive(ownerNow)) return false;
    try {
      await rename(lock, grave);
    } catch (error) {
      if (isCode(error, "ENOENT")) return false;
      throw error;
    }
    const movedOwner = await readMaybe(join(grave, "owner"));
    const movedClaim = await readMaybe(join(grave, "claim"));
    if (movedOwner === expected && movedClaim === claim && !ownerAlive(movedOwner)) {
      await rm(grave, { recursive: true, force: true });
      consumed = true;
      return true;
    }
    await restoreDir(grave, lock);
    return false;
  } finally {
    if (!consumed) await dropClaim(lock, claim);
  }
}

async function removeAbandonedEmpty(lock: string): Promise<boolean> {
  if (directoryLockTestHooks.beforeTakeEmpty !== null) await directoryLockTestHooks.beforeTakeEmpty();
  if (!await ownerlessPastGrace(lock)) return false;
  const claim = await readMaybe(join(lock, "claim"));
  if (claim !== null) {
    if (ownerAlive(claim)) return false;
    if (!await removeFileIfContent(join(lock, "claim"), claim)) return false;
    if (!await ownerlessPastGrace(lock)) return false;
  }
  try {
    await rmdir(lock);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    if (!isCode(error, "ENOTEMPTY")) throw error;
  }
  return takeoverOwnerless(lock);
}

async function ownerlessPastGrace(lock: string): Promise<boolean> {
  if (await readMaybe(join(lock, "owner")) !== null) return false;
  if (ownerAlive(await readMaybe(join(lock, "pid")))) return false;
  try {
    const info = await stat(lock);
    return Date.now() - info.mtimeMs >= EMPTY_LOCK_GRACE_MS;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function takeoverOwnerless(lock: string): Promise<boolean> {
  if (!await ownerlessPastGrace(lock)) return false;
  if (ownerAlive(await readMaybe(join(lock, "claim")))) return false;
  if (directoryLockTestHooks.beforeOwnerlessTakeover !== null) {
    await directoryLockTestHooks.beforeOwnerlessTakeover();
  }
  const claim = `${process.pid}\n${randomUUID()}\n`;
  if (!await claimStale(lock, claim)) return false;
  const grave = `${lock}.stale-${process.pid}-${randomUUID()}`;
  let consumed = false;
  try {
    const ownerNow = await readMaybe(join(lock, "owner"));
    const claimNow = await readMaybe(join(lock, "claim"));
    if (ownerNow !== null || claimNow !== claim || ownerAlive(await readMaybe(join(lock, "pid")))) return false;
    if (directoryLockTestHooks.beforeOwnerlessRename !== null) {
      await directoryLockTestHooks.beforeOwnerlessRename();
    }
    try {
      await rename(lock, grave);
    } catch (error) {
      if (isCode(error, "ENOENT")) return false;
      throw error;
    }
    const movedOwner = await readMaybe(join(grave, "owner"));
    const movedPid = await readMaybe(join(grave, "pid"));
    const movedClaim = await readMaybe(join(grave, "claim"));
    if (directoryLockTestHooks.beforeOwnerlessSettle !== null) {
      await directoryLockTestHooks.beforeOwnerlessSettle();
    }
    if (movedOwner === null && movedClaim === claim && !ownerAlive(movedPid)) {
      await rm(grave, { recursive: true, force: true });
      consumed = true;
      return true;
    }
    await restoreDir(grave, lock);
    return false;
  } finally {
    if (!consumed) await dropClaim(lock, claim);
  }
}

async function claimStale(lock: string, claim: string): Promise<boolean> {
  const path = join(lock, "claim");
  if (await writeExclusive(path, claim)) return true;
  const existing = await readMaybe(path);
  if (existing === null || ownerAlive(existing)) return false;
  if (!await removeFileIfContent(path, existing)) return false;
  return writeExclusive(path, claim);
}

async function dropClaim(lock: string, claim: string): Promise<void> {
  await removeFileIfContent(join(lock, "claim"), claim);
}

async function writeExclusive(path: string, body: string): Promise<boolean> {
  try {
    await writeFile(path, body, { flag: "wx" });
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function removeFileIfContent(path: string, expected: string): Promise<boolean> {
  const aside = `${path}.${process.pid}.${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
  if (await readMaybe(aside) === expected) {
    await rm(aside, { force: true });
    return true;
  }
  try {
    await link(aside, path);
    await rm(aside, { force: true });
  } catch (error) {
    if (!isCode(error, "EEXIST") && !isCode(error, "ENOENT")) throw error;
  }
  return false;
}

async function restoreDir(grave: string, lock: string): Promise<void> {
  if (directoryLockTestHooks.beforeRestore !== null) await directoryLockTestHooks.beforeRestore();
  try {
    await rename(grave, lock);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    if (!isCode(error, "EEXIST") && !isCode(error, "ENOTEMPTY")) throw error;
    if (await readMaybe(join(grave, "owner")) !== null) return;
    await rm(grave, { recursive: true, force: true });
  }
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

function ownerAlive(owner: string | null): boolean {
  const pid = ownerPid(owner);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

function ownerPid(owner: string | null): number | null {
  if (owner === null) return null;
  const line = owner.split("\n", 1)[0];
  if (line === undefined || !/^\d+$/.test(line)) return null;
  const pid = Number(line);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return pid;
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
