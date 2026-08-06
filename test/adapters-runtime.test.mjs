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

// ---------------------------------------------------------------------------
// The flush guard must not become a WORSE failure than the one it replaced.
//
// Awaiting the write callback holds the process open, which reintroduced two
// problems the old synchronous exit could not have: an unhandled 'error' event
// on stdout, and an indefinite wait when nothing drains the pipe. A SessionStart
// hook that hangs is worse than one that truncates.
// ---------------------------------------------------------------------------

/**
 * Spawn an adapter and control what happens to its stdout. The three modes are
 * genuinely different failures and must not be conflated:
 *   "drain"   — a normal reader
 *   "stall"   — pipe open, never read: the buffer fills and write() never
 *               completes. This is the HANG case.
 *   "destroy" — reader goes away: stdout emits 'error'. This is the EPIPE case.
 */
async function spawnAdapter(bodySource, { mode }) {
  const dir = await mkdtemp(join(tmpdir(), "agentmem-pipe-"));
  const script = join(dir, "adapter.mjs");
  await writeFile(
    script,
    `import { runAdapter } from ${JSON.stringify(RUNTIME)};\n` +
      `const STAMP = ${JSON.stringify(join(dir, "stamp.txt"))};\n` +
      bodySource,
  );

  const { spawn } = await import("node:child_process");
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn("node", [script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    if (mode === "drain") child.stdout.resume();
    else if (mode === "destroy") child.stdout.destroy();
    // "stall": deliberately neither read nor closed.

    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ hung: true, ms: Date.now() - started, stderr, dir });
    }, 15000);

    child.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ hung: false, code, ms: Date.now() - started, stderr, dir });
    });
  });
}

test("a payload nobody drains does not hang the host session", async () => {
  const r = await spawnAdapter(
    `await runAdapter(async () => ({ continue: true, blob: "x".repeat(500000) }));`,
    { mode: "stall" },
  );
  assert.equal(r.hung, false, `adapter never terminated (${r.ms}ms) — a hung SessionStart hook blocks the session`);
  assert.equal(r.code, 0, "the fail-safe contract requires exit 0");
});

test("a reader that goes away does not produce a crash or a stack trace", async () => {
  const r = await spawnAdapter(
    `await runAdapter(async () => ({ continue: true, blob: "x".repeat(3000) }));`,
    { mode: "destroy" },
  );
  assert.equal(r.code, 0, `exited ${r.code}: ${r.stderr.split("\n")[0]}`);
  assert.doesNotMatch(r.stderr, /EPIPE|node:events|at runAdapter/, "no unhandled error may reach stderr");
});

test("the stamp does not fire when the payload never reached the reader", async () => {
  // Otherwise the day is marked delivered on a write the user never received —
  // R9's failure, relocated from the body layer to the write layer.
  // Must exceed the 64 KB pipe buffer: a small payload lands in the buffer even
  // when nobody reads it, so its write callback legitimately fires and the
  // stamp is correct. Only a payload that cannot fit exercises a failed flush.
  const { readFile: rf } = await import("node:fs/promises");
  const r = await spawnAdapter(
    `import { writeFileSync } from "node:fs";\n` +
      `await runAdapter(\n` +
      `  async () => ({ continue: true, blob: "x".repeat(500000) }),\n` +
      `  { continue: true },\n` +
      `  () => writeFileSync(STAMP, "delivered"),\n` +
      `);`,
    { mode: "stall" },
  );
  assert.equal(r.code, 0);
  let stamp = null;
  try {
    stamp = await rf(join(r.dir, "stamp.txt"), "utf8");
  } catch {}
  assert.equal(stamp, null, "a failed write must not burn the day");
});

test("PIN: a drained large payload still flushes whole and stamps", async () => {
  const r = await spawnAdapter(
    `import { writeFileSync } from "node:fs";\n` +
      `await runAdapter(\n` +
      `  async () => ({ continue: true, blob: "x".repeat(200000) }),\n` +
      `  { continue: true },\n` +
      `  () => writeFileSync(STAMP, "delivered"),\n` +
      `);`,
    { mode: "drain" },
  );
  assert.equal(r.hung, false);
  assert.equal(r.code, 0);
});
