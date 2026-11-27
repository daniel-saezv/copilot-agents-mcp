import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// DatabaseSync finalizes on GC and drops the kernel lock. This map is the strong reference.
const heldDatabases = new Map<string, { lock: string; db: DatabaseSync }>();

export async function acquireDirectoryLock(
  lock: string,
  options: { timeoutMs: number; pollMs: number },
): Promise<{ owner: string } | null> {
  await mkdir(dirname(lock), { recursive: true });
  const db = new DatabaseSync(lock, { timeout: 0 });
  const owner = randomUUID();
  const started = Date.now();
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        heldDatabases.set(owner, { lock, db });
        return { owner };
      } catch (error) {
        if (!isLocked(error)) throw error;
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

function isLocked(error: unknown): boolean {
  return /locked|busy/i.test(error instanceof Error ? error.message : String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
