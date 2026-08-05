import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, paths, writeCandidate } from "../lib/storage.mjs";
import {
  orderCandidates,
  selectDigestItems,
  livenessWarning,
  runDigest,
  lastReflectionDate,
  LIVENESS_THRESHOLD_DAYS,
} from "../lib/digest.mjs";

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-digest-"));
  await ensureLayout(home);
  return home;
}

// A candidate as `reflect` actually writes one. `created` is date-only
// (lib/reflect.mjs slices to 10 chars); `created_at` is the forward-only full
// timestamp and is absent on every candidate written before SOU-30.
function candidate(id, { created, created_at } = {}) {
  const meta = {
    id,
    title: `title for ${id}`,
    category: "behavioral",
    confidence: 0.35,
    created: created ?? id.slice(0, 10),
    source: "reflection",
    scope: { repos: ["callelo"] },
  };
  if (created_at) meta.created_at = created_at;
  return { meta, body: "**Rule:** something.\n\n**Why:** because." };
}

const ids = (list) => list.map((c) => c.meta.id);

async function exists(file) {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// R3 — ordering is by (created, id), not directory enumeration order.
// Kills: a comparator on `created` alone, which leaves same-day ties to readdir.
// ---------------------------------------------------------------------------
test("R3: candidates sharing a created date are ordered by id, not input order", () => {
  const input = [
    candidate("2026-08-03-zebra"),
    candidate("2026-08-03-alpha"),
    candidate("2026-08-03-mango"),
  ];
  assert.deepEqual(ids(orderCandidates(input)), [
    "2026-08-03-alpha",
    "2026-08-03-mango",
    "2026-08-03-zebra",
  ]);
});

test("R3: older created dates come first regardless of id", () => {
  const input = [
    candidate("2026-08-04-alpha"),
    candidate("2026-08-01-zebra"),
  ];
  assert.deepEqual(ids(orderCandidates(input)), [
    "2026-08-01-zebra",
    "2026-08-04-alpha",
  ]);
});

// ---------------------------------------------------------------------------
// R3b — stable under shuffled enumeration.
// Kills: any comparator that is not total, and any pass-through of readdir order.
// ---------------------------------------------------------------------------
test("R3b: ordering is identical when directory enumeration is reversed", () => {
  const input = [
    candidate("2026-08-01-b"),
    candidate("2026-08-03-a"),
    candidate("2026-08-03-c"),
    candidate("2026-08-02-d"),
  ];
  const forward = ids(orderCandidates(input));
  const reversed = ids(orderCandidates([...input].reverse()));
  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward, [
    "2026-08-01-b",
    "2026-08-02-d",
    "2026-08-03-a",
    "2026-08-03-c",
  ]);
});

test("R3b: orderCandidates does not mutate its input", () => {
  const input = [candidate("2026-08-03-z"), candidate("2026-08-01-a")];
  const before = ids(input);
  orderCandidates(input);
  assert.deepEqual(ids(input), before);
});

// ---------------------------------------------------------------------------
// R12 — forward ordering is total under identical created_at.
// Kills: a `created_at`-only comparator, which hands colliding timestamps back
// to enumeration order. One reflect pass writes several candidates in a loop,
// so same-millisecond values are plausible.
// ---------------------------------------------------------------------------
test("R12: identical created_at values are broken by id, stably", () => {
  const stamp = "2026-08-05T03:15:00.000Z";
  const input = [
    candidate("2026-08-05-yankee", { created_at: stamp }),
    candidate("2026-08-05-alpha", { created_at: stamp }),
    candidate("2026-08-05-mike", { created_at: stamp }),
  ];
  const forward = ids(orderCandidates(input));
  const reversed = ids(orderCandidates([...input].reverse()));
  assert.deepEqual(forward, [
    "2026-08-05-alpha",
    "2026-08-05-mike",
    "2026-08-05-yankee",
  ]);
  assert.deepEqual(reversed, forward);
});

test("R12: a legacy date-only candidate and a created_at candidate sort deterministically", () => {
  // Legacy `created` is date-only, so it is a prefix of any same-day
  // `created_at`. The order must be total and repeatable across both regimes.
  const input = [
    candidate("2026-08-05-newer", { created_at: "2026-08-05T03:15:00.000Z" }),
    candidate("2026-08-05-legacy"),
    candidate("2026-08-04-older", { created_at: "2026-08-04T23:00:00.000Z" }),
  ];
  const forward = ids(orderCandidates(input));
  assert.deepEqual(forward, [
    "2026-08-04-older",
    "2026-08-05-legacy",
    "2026-08-05-newer",
  ]);
  assert.deepEqual(ids(orderCandidates([...input].reverse())), forward);
});

// ---------------------------------------------------------------------------
// R2 — the cap.
// Kills: returning everything, or capping after the file is rendered.
// ---------------------------------------------------------------------------
test("R2: selectDigestItems returns at most `cap` items", () => {
  const input = Array.from({ length: 11 }, (_, i) =>
    candidate(`2026-08-0${(i % 3) + 1}-item${String(i).padStart(2, "0")}`),
  );
  assert.equal(selectDigestItems(input, 6).length, 6);
  assert.equal(selectDigestItems(input, 2).length, 2);
});

test("R2: the cap takes the oldest items, not an arbitrary slice", () => {
  const input = [
    candidate("2026-08-05-e"),
    candidate("2026-08-01-a"),
    candidate("2026-08-04-d"),
    candidate("2026-08-02-b"),
  ];
  assert.deepEqual(ids(selectDigestItems(input, 2)), [
    "2026-08-01-a",
    "2026-08-02-b",
  ]);
});

test("R2: a shorter list than the cap is returned whole", () => {
  const input = [candidate("2026-08-01-a"), candidate("2026-08-02-b")];
  assert.equal(selectDigestItems(input, 6).length, 2);
});

// ---------------------------------------------------------------------------
// R6 — liveness. Silence is allowed; unexplained silence is not.
// Kills: never warning, warning on every run, or an off-by-one on the threshold.
// ---------------------------------------------------------------------------
test("R6: no warning when a reflection ran within the threshold", () => {
  assert.equal(livenessWarning("2026-08-03", "2026-08-05", 3), null);
  assert.equal(livenessWarning("2026-08-05", "2026-08-05", 3), null);
});

test("R6: a warning fires at exactly the threshold", () => {
  const w = livenessWarning("2026-08-02", "2026-08-05", 3);
  assert.ok(w, "expected a warning at 3 days");
  assert.match(w, /3 days/);
});

test("R6: the warning is a single line", () => {
  const w = livenessWarning("2026-07-25", "2026-08-05", 3);
  assert.ok(w);
  assert.equal(w.split("\n").length, 1, "A6 requires exactly one warning line");
});

test("R6: a store that has never reflected does not warn", () => {
  // Absence of evidence: we cannot claim the job stopped if it never started.
  assert.equal(livenessWarning(null, "2026-08-05", 3), null);
});

test("R6: lastReflectionDate reads the newest reflection, not the newest file", async () => {
  const home = await tmpHome();
  const p = paths(home);
  await writeFile(join(p.reflections, "2026-08-01-07-15-38.md"), "# a\n");
  await writeFile(join(p.reflections, "2026-08-04-07-15-20.md"), "# b\n");
  // coach-* files live in the same dir and are not reflection runs.
  await writeFile(join(p.reflections, "coach-2026-08-05-13-18-09.md"), "# c\n");
  assert.equal(await lastReflectionDate(home), "2026-08-04");
});

// ---------------------------------------------------------------------------
// R1 — no-op writes nothing. This is A2, and it is what stops the digest
// becoming a daily empty file that trains you to ignore it.
// Kills: always emitting a header.
// ---------------------------------------------------------------------------
test("R1: nothing to do writes no file", async () => {
  const home = await tmpHome();
  const today = "2026-08-05";
  // A recent reflection, so liveness is quiet too.
  await writeFile(join(paths(home).reflections, `${today}-07-15-00.md`), "# r\n");

  const result = await runDigest(home, { today });

  assert.equal(result.file, null, "no file should be written when there is nothing to say");
  assert.equal(result.items.length, 0);
  assert.equal(
    await exists(join(paths(home).digest, `${today}.md`)),
    false,
    "digest/YYYY-MM-DD.md must not exist",
  );
});

test("R1: a pending candidate does produce a file", async () => {
  const home = await tmpHome();
  const today = "2026-08-05";
  await writeFile(join(paths(home).reflections, `${today}-07-15-00.md`), "# r\n");
  await writeCandidate(home, candidate("2026-08-01-something"));

  const result = await runDigest(home, { today });

  assert.ok(result.file, "expected a digest file");
  const text = await readFile(result.file, "utf8");
  assert.match(text, /2026-08-01-something/);
});

test("R1: a liveness warning alone is enough to write a file", async () => {
  // No candidates at all, but the nightly job has gone quiet — that is
  // precisely the case goal 4 exists for, and it must not be silent.
  const home = await tmpHome();
  await writeFile(join(paths(home).reflections, "2026-07-25-07-15-00.md"), "# r\n");

  const result = await runDigest(home, { today: "2026-08-05" });

  assert.ok(result.file, "a liveness warning must still produce a digest");
  assert.equal(result.items.length, 0);
  assert.match(await readFile(result.file, "utf8"), /reflection/i);
});

test("R2 (end to end): runDigest respects the cap", async () => {
  const home = await tmpHome();
  const today = "2026-08-05";
  await writeFile(join(paths(home).reflections, `${today}-07-15-00.md`), "# r\n");
  for (let i = 0; i < 9; i++) {
    await writeCandidate(home, candidate(`2026-08-0${(i % 3) + 1}-item${i}`));
  }

  const result = await runDigest(home, { today, cap: 4 });

  assert.equal(result.items.length, 4);
  const text = await readFile(result.file, "utf8");
  assert.equal(text.match(/^\d+\. /gm).length, 4, "the rendered file must also be capped");
});

// Goal 3 is approving in conversation — "promote 1, 3 and 5". The file tells
// you to reply with numbers, so the items have to carry them. Caught by
// reading the artifact a real run produced, not by a test.
test("rendered items are numbered from 1, matching the reply instruction", async () => {
  const home = await tmpHome();
  const today = "2026-08-05";
  await writeFile(join(paths(home).reflections, `${today}-07-15-00.md`), "# r\n");
  await writeCandidate(home, candidate("2026-08-01-alpha"));
  await writeCandidate(home, candidate("2026-08-02-bravo"));

  const { file } = await runDigest(home, { today });
  const text = await readFile(file, "utf8");

  assert.match(text, /^1\. `2026-08-01-alpha`/m);
  assert.match(text, /^2\. `2026-08-02-bravo`/m);
  assert.match(text, /Reply with the numbers/);
});

test("the default threshold is the documented 3 days", () => {
  assert.equal(LIVENESS_THRESHOLD_DAYS, 3);
});
