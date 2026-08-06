import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const RUNTIME = fileURLToPath(new URL("../lib/adapters/runtime.mjs", import.meta.url));

// runAdapter calls process.exit, so it can only be observed from a child
// process. Each case is a throwaway adapter script.
async function runAdapter(bodySource) {
  const dir = await mkdtemp(join(tmpdir(), "agentmem-adapter-"));
  const script = join(dir, "adapter.mjs");
  await writeFile(
    script,
    `import { runAdapter } from ${JSON.stringify(RUNTIME)};\n` +
      `const STAMP = ${JSON.stringify(join(dir, "stamp.txt"))};\n` +
      bodySource,
  );
  let stdout = "";
  let code = 0;
  try {
    ({ stdout } = await execFileAsync("node", [script], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    stdout = e.stdout ?? "";
    code = e.code ?? 1;
  }
  let stamp = null;
  try {
    stamp = await readFile(join(dir, "stamp.txt"), "utf8");
  } catch {}
  return { stdout, code, stamp };
}

// ---------------------------------------------------------------------------
// R9 — the stamp must not be written when the adapter body throws.
//
// runAdapter is fail-safe by design: it swallows everything and writes a bare
// {continue:true}. So a stamp written inside the body marks the day delivered
// while the user saw nothing, and every later session that day is suppressed —
// silent failure in the feature whose entire purpose is defeating silent
// failure.
// Kills: stamping before the emit, or stamping regardless of outcome.
// ---------------------------------------------------------------------------
test("R9: onDelivered does not fire when the adapter body throws", async () => {
  const { stdout, code, stamp } = await runAdapter(`
    import { writeFileSync } from "node:fs";
    await runAdapter(
      async () => { throw new Error("boom"); },
      { continue: true },
      () => writeFileSync(STAMP, "delivered"),
    );
  `);

  assert.equal(stamp, null, "the day must not be marked delivered when nothing was emitted");
  assert.equal(stdout, '{"continue":true}', "the fail-safe payload must still be written");
  assert.equal(code, 0, "the adapter must never fail the host session");
});

test("R9: onDelivered fires on the success path", async () => {
  const { stdout, stamp } = await runAdapter(`
    import { writeFileSync } from "node:fs";
    await runAdapter(
      async () => ({ continue: true, ok: 1 }),
      { continue: true },
      () => writeFileSync(STAMP, "delivered"),
    );
  `);

  assert.equal(stamp, "delivered");
  assert.match(stdout, /"ok":1/);
});

// ---------------------------------------------------------------------------
// R10 — a failing callback must not break the fail-safe contract.
// Kills: an unwrapped onDelivered call, which would escape and kill the host.
// ---------------------------------------------------------------------------
test("R10: a throwing onDelivered still leaves valid JSON and exit 0", async () => {
  const { stdout, code } = await runAdapter(`
    await runAdapter(
      async () => ({ continue: true, ok: 1 }),
      { continue: true },
      () => { throw new Error("stamp failed"); },
    );
  `);

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { continue: true, ok: 1 });
});

test("R10: a rejecting async onDelivered is also contained", async () => {
  const { stdout, code } = await runAdapter(`
    await runAdapter(
      async () => ({ continue: true, ok: 2 }),
      { continue: true },
      async () => { throw new Error("async stamp failed"); },
    );
  `);

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { continue: true, ok: 2 });
});

// ---------------------------------------------------------------------------
// R11 — delivery means flushed, not "write() returned".
//
// Measured on this machine: write-then-exit truncates a piped payload at
// exactly 65536 bytes. All four adapters already write-then-exit, so the lesson
// injection itself would silently lose its tail past 64 KB.
// Kills: process.exit(0) placed before the write callback resolves.
// ---------------------------------------------------------------------------
test("R11: a payload larger than the 64 KB pipe buffer arrives whole", async () => {
  const { stdout } = await runAdapter(`
    await runAdapter(async () => ({ continue: true, blob: "x".repeat(200000) }));
  `);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.blob.length, 200000, `payload truncated to ${stdout.length} bytes`);
});

test("R11: the stamp is written only after a large payload has flushed", async () => {
  const { stdout, stamp } = await runAdapter(`
    import { writeFileSync } from "node:fs";
    await runAdapter(
      async () => ({ continue: true, blob: "y".repeat(200000) }),
      { continue: true },
      () => writeFileSync(STAMP, String(JSON.stringify({ continue: true, blob: "y".repeat(200000) }).length)),
    );
  `);

  assert.equal(JSON.parse(stdout).blob.length, 200000);
  assert.ok(stamp, "onDelivered must still run after a flushed large write");
});

// ---------------------------------------------------------------------------
// The existing contract, pinned — these already hold and are not red-first
// evidence. They exist so the onDelivered change cannot quietly alter them.
// ---------------------------------------------------------------------------
test("PIN: a body returning undefined falls back", async () => {
  const { stdout, code } = await runAdapter(`await runAdapter(async () => undefined);`);
  assert.deepEqual(JSON.parse(stdout), { continue: true });
  assert.equal(code, 0);
});

test("PIN: omitting onDelivered entirely is fine — the other three adapters do", async () => {
  const { stdout, code } = await runAdapter(`await runAdapter(async () => ({ continue: true, n: 3 }));`);
  assert.deepEqual(JSON.parse(stdout), { continue: true, n: 3 });
  assert.equal(code, 0);
});
