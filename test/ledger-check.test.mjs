import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCitedPrs,
  isFeaturePr,
  findMissingCloseouts,
  fetchLedgerText,
  fetchMergedPrs,
  runLedgerCheck,
  safeLedgerCheck,
  LEDGER_PATH,
} from "../lib/ledger-check.mjs";

// ---------------------------------------------------------------------------
// Fixtures.
//
// These are trimmed from the REAL artifacts, read from origin/main on
// 2026-08-06 — not invented. The ledger's citation style (a `| #580 |` table
// column under a `### 2026-08-05 — CAL-619 (PR #580, …)` heading) is what the
// parser has to cope with, and inventing a tidier shape would test a ledger
// that does not exist.
// ---------------------------------------------------------------------------

const LEDGER = `# Review findings ledger

Every **above-LOW** review finding, logged when its PR merges, with a category.

## Recurring categories

| Category | Count |
| --- | --- |
| Falsely-green test | 4 |

## Findings log

### 2026-08-05 — CAL-619 (PR #580, plan-gate ledger)

| PR | Gate | Category | Finding |
| --- | --- | --- | --- |
| #580 | Security (R1) | Sensitive data | absolute paths in a committed artifact |
| #580 | Codex (R1) | Falsely-green test | matched any date-prefixed row |

### 2026-07-31 — CAL-608 (PR #572, per-slide weight)

| PR | Gate | Category | Finding |
| --- | --- | --- | --- |
| #572 | Code (R1) | Dead read path | weight read but never applied |

### 2026-07-31 — CAL-609 (PR #574, rubric criteria)

| #574 | Codex (R2) | Rubric remove forces 100% | renormalisation not covered |
`;

/** The real merged list, trimmed. Titles are verbatim. */
const MERGED = [
  { number: 593, title: "CAL-616 (PR2/3): backfill rubric-less decks" },
  { number: 590, title: "docs: CAL-623 alert provisioned + fix the metric command" },
  { number: 589, title: "chore: drop CAL-639-BUILD-HANDOFF.md from the repo root" },
  { number: 586, title: "docs: close out CAL-627 — plan merged, ledger note logged" },
  { number: 585, title: "docs: log PR #580's above-LOW findings to the review ledger" },
  { number: 580, title: "Plan-gate findings ledger: derive it, and categorise all 269" },
  { number: 578, title: "fix(e2e): seed a rubric in the three deck specs CAL-617 made" },
  { number: 577, title: "CAL-617: refuse to start a presentation against a deck with no rubric" },
  { number: 574, title: "CAL-609: add and remove criteria in the deck grading rubric" },
  { number: 573, title: "docs: close out CAL-608 — plan status merged, ledger rows logged" },
  { number: 572, title: "CAL-608: remove the inert per-slide Weight from the read path" },
  { number: 571, title: "CAL-606: deck editor edits expected objections as a list" },
  { number: 569, title: "Add the /spec skill: turn a ticket into an evidence-first plan" },
];

const numbers = (r) => r.missing.map((m) => m.number).sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// Citation parsing.
// ---------------------------------------------------------------------------

test("parseCitedPrs finds every PR the ledger cites, in headings and table cells", () => {
  const cited = parseCitedPrs(LEDGER);
  assert.equal(cited.has(580), true, "cited in both a heading and a table column");
  assert.equal(cited.has(572), true, "cited in a heading as (PR #572, …)");
  assert.equal(cited.has(574), true, "cited only in a table cell");
  assert.equal(cited.has(577), false, "#577 has no row — this is the whole point");
});

test("parseCitedPrs does not mistake a category count or a round marker for a PR", () => {
  // `| Falsely-green test | 4 |` and `(R1)` must not become PRs #4 / #1.
  const cited = parseCitedPrs(LEDGER);
  for (const n of [1, 2, 4]) {
    assert.equal(cited.has(n), false, `#${n} is a round/count, not a PR citation`);
  }
});

// ---------------------------------------------------------------------------
// R7 / R8 — the pair the plan names.
// ---------------------------------------------------------------------------

test("R7: a PR cited by a ledger row is not flagged", () => {
  const r = findMissingCloseouts({ ledgerText: LEDGER, mergedPrs: MERGED });
  assert.equal(numbers(r).includes(572), false, "#572 has a close-out row");
});

test("R8: a merged feature PR with no citing row IS flagged", () => {
  const r = findMissingCloseouts({ ledgerText: LEDGER, mergedPrs: MERGED });
  assert.equal(numbers(r).includes(577), true, "#577 merged with no ledger row");
});

// ---------------------------------------------------------------------------
// R8b — the over-blocking guard that R7 does NOT actually provide.
//
// The plan claims "a checker that flags everything passes R8; R7 is what stops
// that". Measured against the real corpus on 2026-08-06, that is not so: R7
// only forbids flagging a CITED PR, so "flag every uncited merged PR" satisfies
// both R7 and R8 while emitting 34 lines out of 41 merged PRs — into a digest
// capped at 6. Every one of the 22 extra is a docs/chore/build PR that will
// never have a ledger row, because the ledger records above-LOW findings from
// the review gate and those PRs do not go through it.
//
// This is the test that actually kills flag-everything.
// ---------------------------------------------------------------------------

test("R8b: docs, chore, build and fix-prefixed PRs are never flagged", () => {
  const r = findMissingCloseouts({ ledgerText: LEDGER, mergedPrs: MERGED });
  const flagged = numbers(r);
  for (const n of [590, 589, 586, 585, 578, 569]) {
    assert.equal(flagged.includes(n), false, `#${n} is not feature work — flagging it is noise`);
  }
});

test("R8b: the flagged set is exactly the uncited feature PRs, nothing else", () => {
  const r = findMissingCloseouts({ ledgerText: LEDGER, mergedPrs: MERGED });
  // 593 and 571 are ticket-prefixed and uncited; 577 likewise. 572/574/580 are
  // cited. Everything else in the fixture is docs/chore/other.
  assert.deepEqual(numbers(r), [571, 577, 593]);
});

// Found in the live run, not by reasoning: #595 "CAL-644 plan: store a wildcard
// sentinel…" was flagged. It is a plan document — it goes through the plan gate,
// not the code-review gate, so it can never earn a ledger row. Left in, it sits
// in the digest every day with no action that would clear it, which is exactly
// the noise that teaches you to skip the section.
//
// Bound, stated: this is a title heuristic. A PR that does not follow the
// repo's naming convention is misclassified in either direction, and no test
// here can catch that.
test("a ticket-prefixed PLAN or SPEC PR is not implementation work", () => {
  assert.equal(isFeaturePr("CAL-644 plan: store a wildcard sentinel"), false);
  assert.equal(isFeaturePr("CAL-619 spec: derive the ledger"), false);
  assert.equal(isFeaturePr("SOU-30 plan: daily action digest"), false);
  assert.equal(isFeaturePr("CAL-644: store a wildcard sentinel"), true,
    "the implementation PR for the same ticket still counts");
  assert.equal(isFeaturePr("CAL-617: planned rollout of the rubric guard"), true,
    "'planned' in the summary is not a plan PR");
});

test("isFeaturePr keys off a ticket prefix, not the word CAL", () => {
  assert.equal(isFeaturePr("CAL-617: refuse to start"), true);
  assert.equal(isFeaturePr("SOU-30: daily action digest"), true, "must not be callelo-specific");
  assert.equal(isFeaturePr("CAL-616 (PR2/3): backfill"), true, "split-PR suffix still counts");
  assert.equal(isFeaturePr("docs: close out CAL-608 — ledger rows logged"), false,
    "a docs PR that MENTIONS a ticket is still a docs PR");
  assert.equal(isFeaturePr("fix(e2e): seed a rubric in the CAL-617 specs"), false);
  assert.equal(isFeaturePr("chore: drop CAL-639-BUILD-HANDOFF.md"), false);
});

// ---------------------------------------------------------------------------
// Never infer absence from a truncated page.
//
// The check answers "which merged PRs have no row". If the fetch returned only
// the newest N and N stops short of the window, the PRs below the cut are
// unexamined — reporting them as fine is a false clean, which is the failure
// this whole check exists to prevent, one level up.
// ---------------------------------------------------------------------------

test("a merged list that stops short of the window reports incomplete, not clean", () => {
  const r = findMissingCloseouts({
    ledgerText: LEDGER,
    mergedPrs: MERGED.filter((p) => p.number >= 580),
    since: 547,
  });
  assert.equal(r.complete, false, "the page never reached #547 — say so");
  assert.equal(r.oldestSeen, 580);
});

test("a merged list that reaches the window floor reports complete", () => {
  const r = findMissingCloseouts({ ledgerText: LEDGER, mergedPrs: MERGED, since: 569 });
  assert.equal(r.complete, true);
});

test("PRs older than the window floor are not flagged — the ledger did not exist yet", () => {
  const r = findMissingCloseouts({
    ledgerText: LEDGER,
    mergedPrs: [...MERGED, { number: 400, title: "CAL-100: ancient feature work" }],
    since: 547,
  });
  assert.equal(numbers(r).includes(400), false);
});

// ---------------------------------------------------------------------------
// The ledger is read from origin/main, never a local working tree.
//
// Not a style point. The session that wrote the SOU-30 plan read a callelo
// checkout six commits behind, concluded the #572 rows did not exist, and was
// wrong. A local read is the known way to get a confidently false answer here.
// ---------------------------------------------------------------------------

test("fetchLedgerText pins the read to main and decodes the blob", async () => {
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    return { content: Buffer.from("# ledger\n| #1 |", "utf8").toString("base64"), encoding: "base64" };
  };

  const text = await fetchLedgerText(fetcher, { repo: "o/r" });

  assert.equal(text, "# ledger\n| #1 |");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/repos\/o\/r\/contents\//, "must go through the contents API");
  assert.ok(calls[0].includes(LEDGER_PATH), "must request the ledger path");
  assert.match(calls[0], /[?&]ref=main\b/, "must pin to main, not the caller's default");
});

test("fetchLedgerText refuses a blob it cannot decode rather than returning empty", async () => {
  // An empty string parses to zero citations, which would flag EVERY feature PR.
  // Failing loudly is the only safe direction.
  const fetcher = async () => ({ content: "", encoding: "none" });
  await assert.rejects(() => fetchLedgerText(fetcher, { repo: "o/r" }), /encoding|decode/i);
});

test("fetchMergedPrs returns only merged PRs, newest first", async () => {
  const fetcher = async () => [
    { number: 10, title: "merged one", merged_at: "2026-08-01T00:00:00Z" },
    { number: 9, title: "closed, never merged", merged_at: null },
    { number: 8, title: "merged two", merged_at: "2026-07-30T00:00:00Z" },
  ];
  const prs = await fetchMergedPrs(fetcher, { repo: "o/r" });
  assert.deepEqual(prs.map((p) => p.number), [10, 8]);
  assert.deepEqual(prs.map((p) => p.title), ["merged one", "merged two"]);
});

test("runLedgerCheck wires the two fetches together and returns the flagged set", async () => {
  const fetcher = async (path) => {
    if (path.includes("/contents/")) {
      return { content: Buffer.from(LEDGER, "utf8").toString("base64"), encoding: "base64" };
    }
    return MERGED.map((p) => ({ ...p, merged_at: "2026-08-01T00:00:00Z" }));
  };

  const r = await runLedgerCheck({ fetcher, repo: "o/r", since: 569 });
  assert.deepEqual(numbers(r), [571, 577, 593]);
  assert.equal(r.complete, true);
});

test("runLedgerCheck surfaces a fetch failure instead of reporting a clean result", async () => {
  const fetcher = async () => {
    throw new Error("gh: not authenticated");
  };
  await assert.rejects(() => runLedgerCheck({ fetcher, repo: "o/r" }), /not authenticated/);
});

// ---------------------------------------------------------------------------
// safeLedgerCheck — every failure becomes a REPORTED failure.
//
// `resolveFetcher` is injected rather than read from an env-var backdoor,
// because a backdoor that disables production behaviour would leave this exact
// seam — the one that decides what a failure looks like — permanently
// unexercised.
// ---------------------------------------------------------------------------


test("safeLedgerCheck reports missing credentials instead of an empty clean result", async () => {
  const r = await safeLedgerCheck({ resolveFetcher: async () => null, repo: "o/r" });
  assert.match(r.error, /credential|gh auth|GITHUB_TOKEN/i);
  assert.equal(r.complete, false, "no credentials means nothing was examined");
  assert.deepEqual(r.missing, []);
});

test("safeLedgerCheck carries a fetch failure rather than swallowing it", async () => {
  const r = await safeLedgerCheck({
    resolveFetcher: async () => async () => {
      throw new Error("GitHub API 503");
    },
    repo: "o/r",
  });
  assert.match(r.error, /503/);
  assert.equal(r.complete, false);
});

test("safeLedgerCheck carries a resolver failure too", async () => {
  const r = await safeLedgerCheck({
    resolveFetcher: async () => {
      throw new Error("gh binary missing");
    },
    repo: "o/r",
  });
  assert.match(r.error, /gh binary missing/);
});

test("safeLedgerCheck passes a successful result straight through, with no error key set", async () => {
  const fetcher = async (path) =>
    path.includes("/contents/")
      ? { content: Buffer.from(LEDGER, "utf8").toString("base64"), encoding: "base64" }
      : MERGED.map((p) => ({ ...p, merged_at: "2026-08-01T00:00:00Z" }));

  const r = await safeLedgerCheck({ resolveFetcher: async () => fetcher, repo: "o/r", since: 569 });

  assert.equal(r.error, undefined, "a clean run must not carry an error key");
  assert.equal(r.complete, true);
  assert.deepEqual(numbers(r), [571, 577, 593]);
});
