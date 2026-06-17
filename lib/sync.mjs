import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Acquire a lockfile at <home>/.lock. Returns true if acquired,
 * false if a lockfile already exists (concurrent run).
 *
 * Uses { flag: "wx" } so the create is atomic — wins exactly one writer.
 */
async function acquireLock(lockPath) {
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
}

async function releaseLock(lockPath) {
  try {
    await unlink(lockPath);
  } catch {
    // best-effort
  }
}

/**
 * Acquire `<home>/.lock` with short backoff, run `fn`, and release the lock
 * in a finally block. Used by exportAgents (and any other writer that needs
 * to serialize against in-process or cross-process callers) to avoid
 * read-modify-write races on store-level files like AGENTS.md.
 *
 * Callers want the work to complete, so we retry the acquire up to
 * `attempts` times with `delayMs` between tries before giving up.
 * Default: 60 × 100ms = 6 s.
 *
 * If we still can't acquire the lock, we throw a clear error rather than
 * silently dropping the write.
 */
export async function withLock(home, fn, { attempts = 60, delayMs = 100 } = {}) {
  const lockPath = join(home, ".lock");
  for (let i = 0; i < attempts; i++) {
    if (await acquireLock(lockPath)) {
      try {
        return await fn();
      } finally {
        await releaseLock(lockPath);
      }
    }
    // Skip the trailing sleep after the last failed attempt — we're about
    // to throw, no reason to add another delayMs of latency.
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `could not acquire ${lockPath} after ${attempts} attempts — another agentmem process may be stuck. If stale, remove it manually.`,
  );
}
