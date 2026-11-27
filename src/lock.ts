import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type DatabaseSync, type DatabaseSyncOptions } from "node:sqlite";
import * as sqlite from "node:sqlite";

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

const Database = (sqlite as unknown as {
  Database: new (path: string, options?: DatabaseSyncOptions) => DatabaseSync;
}).Database;

// The connection finalizes on GC and drops the kernel lock. This map is the strong reference.
const heldDatabases = new Map<string, { lock: string; db: DatabaseSync }>();

export async function acquireDirectoryLock(
  lock: string,
  options: { timeoutMs: number; pollMs: number },
): Promise<{ owner: string } | null> {
  await mkdir(dirname(lock), { recursive: true });
  let db: DatabaseSync;
  try {
    db = new Database(lock, { timeout: 0 });
  } catch (error) {
    throw lockFailure(lock, error);
  }
  const owner = randomUUID();
  const started = Date.now();
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        heldDatabases.set(owner, { lock, db });
        return { owner };
      } catch (error) {
        if (!isLocked(error)) throw lockFailure(lock, error);
        if (Date.now() - started > options.timeoutMs) return null;
        await delay(options.pollMs);
      }
    }
  } finally {
    if (!heldDatabases.has(owner)) db.close();
  }
}

export async function releaseDirectoryLock(lock: string, owner: string): Promise<void> {
  const held = heldDatabases.get(owner);
  if (!held || held.lock !== lock) return;
  heldDatabases.delete(owner);
  try {
    held.db.exec("ROLLBACK");
  } finally {
    held.db.close();
  }
}

export function isLocked(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { errcode?: unknown; errstr?: unknown };
  const code = primaryCode(record.errcode) ?? primaryCode(record.errstr);
  return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}

function primaryCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value & 0xff;
  if (value === "SQLITE_BUSY") return SQLITE_BUSY;
  if (value === "SQLITE_LOCKED") return SQLITE_LOCKED;
  return null;
}

function lockFailure(lock: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Could not open lock ${lock}: ${detail}`, error instanceof Error ? { cause: error } : undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
