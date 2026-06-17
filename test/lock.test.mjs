import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../lib/sync.mjs";

async function tmpHome() {
  return mkdtemp(join(tmpdir(), "agentmem-lock-"));
}

test("withLock runs fn and returns its value", async () => {
  const home = await tmpHome();
  const result = await withLock(home, async () => 42);
  assert.equal(result, 42);
});

test("withLock releases the lockfile after a successful run", async () => {
  const home = await tmpHome();
  await withLock(home, async () => "ok");
  await assert.rejects(() => stat(join(home, ".lock")));
});

test("withLock releases the lockfile even when fn throws", async () => {
  const home = await tmpHome();
  await assert.rejects(() =>
    withLock(home, async () => {
      throw new Error("boom");
    }),
  );
  await assert.rejects(() => stat(join(home, ".lock")));
});

test("withLock serializes overlapping callers (mutual exclusion)", async () => {
  const home = await tmpHome();
  let active = 0;
  let maxActive = 0;
  // withLock guarantees mutual exclusion, not FIFO order — so assert that the
  // two critical sections never run at the same time, regardless of which
  // acquires the lock first.
  const body = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active -= 1;
  };
  await Promise.all([withLock(home, body), withLock(home, body)]);
  assert.equal(maxActive, 1, "critical sections must not overlap");
});

test("withLock throws a clear error when the lock can't be acquired", async () => {
  const home = await tmpHome();
  // Pre-create a stale lock so acquisition never succeeds.
  await writeFile(join(home, ".lock"), String(process.pid));
  await assert.rejects(
    () => withLock(home, async () => "never", { attempts: 2, delayMs: 1 }),
    /could not acquire/i,
  );
  // The pre-existing lock must be left intact (not deleted by a failed acquire).
  const buf = await readFile(join(home, ".lock"), "utf8");
  assert.equal(buf.trim(), String(process.pid));
});
