import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSignal, readSignalsSince } from "../lib/signals.mjs";

async function tmpSignalsDir() {
  return await mkdtemp(join(tmpdir(), "agentmem-signals-"));
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

test("appendSignal writes a readable JSONL line", async () => {
  const dir = await tmpSignalsDir();
  await appendSignal(dir, { host: "claude-code", type: "correction", summary: "no, use the Grep tool" });
  const signals = await readSignalsSince(dir, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, "correction");
  assert.equal(signals[0].summary, "no, use the Grep tool");
  assert.equal(signals[0].host, "claude-code");
});

test("appendSignal fills in an ISO timestamp when missing", async () => {
  const dir = await tmpSignalsDir();
  const written = await appendSignal(dir, { host: "cowork", type: "praise", summary: "perfect" });
  assert.match(written.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("appendSignal preserves a provided timestamp", async () => {
  const dir = await tmpSignalsDir();
  const ts = "2026-05-01T12:00:00.000Z";
  const written = await appendSignal(dir, { ts, host: "cowork", type: "manual", summary: "x" });
  assert.equal(written.ts, ts);
});

test("appendSignal appends rather than overwrites", async () => {
  const dir = await tmpSignalsDir();
  await appendSignal(dir, { host: "claude-code", type: "retry", summary: "first" });
  await appendSignal(dir, { host: "claude-code", type: "retry", summary: "second" });
  const signals = await readSignalsSince(dir, 1);
  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((s) => s.summary), ["first", "second"]);
});

test("readSignalsSince excludes signals older than the window", async () => {
  const dir = await tmpSignalsDir();
  const oldDate = isoDaysAgo(30);
  await writeFile(
    join(dir, `${oldDate}.jsonl`),
    JSON.stringify({ ts: `${oldDate}T00:00:00Z`, host: "claude-code", type: "correction", summary: "ancient" }) + "\n",
  );
  await appendSignal(dir, { host: "claude-code", type: "correction", summary: "recent" });
  const signals = await readSignalsSince(dir, 7);
  assert.deepEqual(signals.map((s) => s.summary), ["recent"]);
});

test("readSignalsSince returns empty array for an empty dir", async () => {
  const dir = await tmpSignalsDir();
  const signals = await readSignalsSince(dir, 7);
  assert.deepEqual(signals, []);
});
