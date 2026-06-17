import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, writeCandidate, promoteCandidate } from "../lib/storage.mjs";
import { appendSignal } from "../lib/signals.mjs";
import {
  statusSummary,
  findEntry,
  selectForInjection,
  exportAgents,
} from "../lib/commands.mjs";

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-cmd-"));
  await ensureLayout(home);
  return home;
}

function lesson(id, category, confidence, repos, body = "do the thing") {
  return { meta: { id, title: `T-${id}`, category, confidence, scope: { repos } }, body: `**Rule:** ${body}` };
}

async function addLesson(home, ...args) {
  await writeCandidate(home, lesson(...args));
  await promoteCandidate(home, args[0]);
}

test("statusSummary counts lessons, candidates, and recent signals", async () => {
  const home = await tmpHome();
  await addLesson(home, "l1", "code", 0.7, ["*"]);
  await writeCandidate(home, lesson("c1", "code", 0.35, ["*"]));
  await appendSignal(join(home, "signals"), { host: "claude-code", type: "correction", summary: "x" });
  const s = await statusSummary(home);
  assert.equal(s.lessons, 1);
  assert.equal(s.candidates, 1);
  assert.equal(s.signals7d, 1);
});

test("findEntry locates a promoted lesson by id", async () => {
  const home = await tmpHome();
  await addLesson(home, "l2", "behavioral", 0.6, ["*"]);
  const entry = await findEntry(home, "l2");
  assert.equal(entry.meta.id, "l2");
});

test("findEntry returns null for unknown id", async () => {
  const home = await tmpHome();
  assert.equal(await findEntry(home, "ghost"), null);
});

test("selectForInjection always includes global (*) lessons", async () => {
  const home = await tmpHome();
  await addLesson(home, "g1", "code", 0.5, ["*"]);
  const picked = await selectForInjection(home, "/Users/x/code/anything", 12);
  assert.deepEqual(picked.map((l) => l.meta.id), ["g1"]);
});

test("selectForInjection includes repo-scoped lessons when cwd matches", async () => {
  const home = await tmpHome();
  await addLesson(home, "r1", "code", 0.5, ["example-app"]);
  const picked = await selectForInjection(home, "/Users/x/code/example-app", 12);
  assert.deepEqual(picked.map((l) => l.meta.id), ["r1"]);
});

test("selectForInjection excludes repo-scoped lessons when cwd does not match", async () => {
  const home = await tmpHome();
  await addLesson(home, "r2", "code", 0.5, ["example-app"]);
  const picked = await selectForInjection(home, "/Users/x/code/other-project", 12);
  assert.deepEqual(picked, []);
});

test("selectForInjection sorts by confidence desc and respects limit", async () => {
  const home = await tmpHome();
  await addLesson(home, "low", "code", 0.30, ["*"]);
  await addLesson(home, "high", "code", 0.90, ["*"]);
  await addLesson(home, "mid", "code", 0.60, ["*"]);
  const picked = await selectForInjection(home, "/tmp", 2);
  assert.deepEqual(picked.map((l) => l.meta.id), ["high", "mid"]);
});

test("exportAgents inserts a managed lessons block", async () => {
  const home = await tmpHome();
  await writeFile(join(home, "AGENTS.md"), "# Base rules\n\nDo not delete me.\n");
  await addLesson(home, "e1", "code", 0.8, ["*"], "always lint");
  await exportAgents(home);
  const out = await readFile(join(home, "AGENTS.md"), "utf8");
  assert.match(out, /# Base rules/);
  assert.match(out, /Do not delete me\./);
  assert.match(out, /BEGIN agentmem lessons/);
  assert.match(out, /always lint/);
});

test("exportAgents is idempotent (no duplicate blocks)", async () => {
  const home = await tmpHome();
  await writeFile(join(home, "AGENTS.md"), "# Base rules\n");
  await addLesson(home, "e2", "code", 0.8, ["*"]);
  await exportAgents(home);
  await exportAgents(home);
  const out = await readFile(join(home, "AGENTS.md"), "utf8");
  const begins = (out.match(/BEGIN agentmem lessons/g) || []).length;
  assert.equal(begins, 1);
});

test("exportAgents stays single-block when the file is only the managed block (no base text)", async () => {
  const home = await tmpHome();
  // No AGENTS.md base content at all — first export creates a file that is essentially just the block.
  await addLesson(home, "e3", "code", 0.8, ["*"]);
  await exportAgents(home);
  await exportAgents(home);
  await exportAgents(home);
  const out = await readFile(join(home, "AGENTS.md"), "utf8");
  const begins = (out.match(/BEGIN agentmem lessons/g) || []).length;
  assert.equal(begins, 1);
});

test("exportAgents serializes concurrent calls: every concurrent pass's lesson is preserved", async () => {
  // SOU-26 regression test: two (or more) concurrent promote+export passes
  // must NOT silently drop any pass's lesson from the managed AGENTS.md
  // block. Each exportAgents does a read-modify-write on AGENTS.md; without
  // a lock, two passes can interleave such that one pass's listLessons()
  // captures state before another pass's promotion lands, then its writeFile
  // overwrites the other pass's block.
  //
  // We exercise it across multiple trials with many concurrent passes. The
  // final managed block MUST contain every pass's lesson in every trial.
  const TRIALS = 3;
  const N = 8;

  for (let trial = 0; trial < TRIALS; trial++) {
    const home = await tmpHome();
    await writeFile(join(home, "AGENTS.md"), "# Base rules\n\nDo not delete me.\n");

    const ids = Array.from({ length: N }, (_, i) => `t${trial}-race-${String(i).padStart(2, "0")}`);

    await Promise.all(
      ids.map(async (id) => {
        await writeCandidate(home, lesson(id, "code", 0.8, ["*"], `rule ${id}`));
        await promoteCandidate(home, id);
        await exportAgents(home);
      }),
    );

    const out = await readFile(join(home, "AGENTS.md"), "utf8");
    // Base text preserved.
    assert.match(out, /# Base rules/, `trial ${trial}: base text lost`);
    assert.match(out, /Do not delete me\./, `trial ${trial}: base text lost`);
    // Exactly one managed block.
    const begins = (out.match(/BEGIN agentmem lessons/g) || []).length;
    assert.equal(begins, 1, `trial ${trial}: should have exactly one managed block`);
    // Every pass's lesson must be present in the final block.
    for (const id of ids) {
      assert.match(out, new RegExp(`T-${id}\\b`), `trial ${trial}: final AGENTS.md is missing lesson ${id} (lost update)`);
    }
  }
});

test("exportAgents acquires and releases <home>/.lock", async () => {
  // SOU-26: exportAgents must guard the read-modify-write of AGENTS.md with
  // the same `<home>/.lock` lockfile pattern that runSync uses. We verify
  // both halves: the lock is created during the call (and observable mid-
  // flight is hard, so we settle for "no lockfile lingers after a successful
  // call") AND a pre-existing lockfile blocks/serializes the call rather
  // than being ignored.
  const home = await tmpHome();
  await addLesson(home, "lock-1", "code", 0.7, ["*"]);

  await exportAgents(home);

  // Successful call must not leave a lockfile behind.
  await assert.rejects(() => stat(join(home, ".lock")), /ENOENT/);
});

test("exportAgents waits for a held lockfile, then proceeds once it's released", async () => {
  // SOU-26: if another process is holding the lock, exportAgents must not
  // skip the write — it must wait (short backoff) for the lock to be
  // released, then run. This is the opposite of runSync (which fails fast
  // on a held lock) because callers of exportAgents need the write to
  // complete.
  const home = await tmpHome();
  await addLesson(home, "wait-1", "code", 0.7, ["*"]);
  const lockPath = join(home, ".lock");
  await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });

  // Start exportAgents while the lock is held — it should not complete yet.
  let done = false;
  const p = exportAgents(home).then(() => {
    done = true;
  });

  // Yield a few times so the call can attempt acquisition.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(done, false, "exportAgents should not have completed while the lock is held");

  // Release the lock; exportAgents should proceed.
  await unlink(lockPath);
  await p;
  assert.equal(done, true, "exportAgents should complete after the lock is released");

  // Final state: managed block written, lockfile cleaned up.
  const out = await readFile(join(home, "AGENTS.md"), "utf8");
  assert.match(out, /T-wait-1/);
  await assert.rejects(() => stat(lockPath), /ENOENT/);
});

test("exportAgents releases the lock even when the underlying write fails", async () => {
  // SOU-26: the lock must be released in a finally block — otherwise a
  // single failed export would leave a stale lockfile that blocks future
  // exports.
  const home = await tmpHome();
  await addLesson(home, "err-1", "code", 0.7, ["*"]);
  // Make AGENTS.md a directory so writeFile fails with EISDIR.
  await mkdir(join(home, "AGENTS.md"));

  await assert.rejects(() => exportAgents(home));

  // Lock must not linger after the failure.
  await assert.rejects(() => stat(join(home, ".lock")), /ENOENT/);
});
