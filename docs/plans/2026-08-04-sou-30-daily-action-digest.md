---
ticket: SOU-30
subsystems: [digest, session-start-adapter, launchd-jobs, candidate-store]
status: intent
---

# SOU-30 — Daily action digest

Turns captured findings into a small, dated action queue that arrives at the
first session of the day. Design agreed with Dan 2026-08-03; the ledger item was
reshaped 2026-08-03 after its premise was disproven (see the ticket's pinned
comment).

**Repo:** `dxi106/agent-memory` (NOT callelo). Branch
`feat/sou-30-daily-action-digest`.

---

## How this works today

Read from the code on `origin/main` @ `9be717b`, 2026-08-04. The tree was
confirmed current: `git rev-list --count HEAD..origin/main` → `0`, and
`ls-remote origin main` → `9be717b`, matching local `HEAD`.

### The store is the repo

`resolveHome()` (`lib/paths.mjs:7-9`) resolves to
`$AGENTMEM_HOME || ~/Documents/code/agent-memory` — **the store home is the git
checkout itself**. `paths()` (`lib/paths.mjs:11-25`) names `lessons`,
`candidates`, `signals`, `archive`, `reflections`, `knowledge`. Live data is
gitignored per an explicit "public ENGINE / local data" split
(`.gitignore:26-52`): each data dir is `dir/*` + `!dir/.gitkeep`.

Note `recommendations/` is gitignored (`.gitignore:38`) but is **absent from
`paths()`** — `coach.mjs` computes it independently. Any new data dir must be
added in both places or it will diverge the same way.

### The live install is a symlink into the working tree

`/opt/homebrew/lib/node_modules/agentmem` →
`/Users/daniacono/Documents/code/agent-memory` (verified via `readlink`).
**The checked-out branch of this repo IS the running tool** for every Claude
session on this machine.

### What runs on a schedule — measured, not assumed

`launchctl list | grep -i agentmem` returns exactly one job:

```
-	0	com.dxi106.agentmem.reflect
```

`~/Library/LaunchAgents/` contains only
`com.dxi106.agentmem.reflect.plist` (nightly 03:15, `RunAtLoad false`).

- `reflect` — **installed and running.**
- `coach run` — **not installed.** A template exists at
  `adapters/launchd/com.example.agentmem.coach.plist`.
- `ingest --source github` — **not installed, and no template exists at all.**
  `adapters/launchd/` holds only the coach and reflect plists.

`ingest-state.json` corroborates: `dxi106/callelo.last_processed_pr_id: 219`,
`last_run_at: 2026-05-31T13:56:30Z`.

### The SessionStart hook already exists and is already wired

`adapters/claude-code/session-start.mjs` (57 lines) is registered in
`~/.claude/settings.json` under `SessionStart`, alongside
`~/.claude/hooks/load-daily-context.py` (an unrelated Obsidian daily-note
reader). It:

1. `selectForInjection(home, cwd, 12)` — top 12 scoped lessons (line 33).
2. `getPendingRecommendations(home, cwd)` — appends a *reactive* tip hint
   (lines 34, 43-45).
3. Joins non-empty `parts` into one `additionalContext` (lines 49-55); returns
   bare `{continue:true}` when there is nothing (line 47).

It makes **no network and no model call** today. That property is load-bearing
and this change must preserve it.

**Consequence: build step 4 is not a new hook.** It is a third `part` in an
adapter that is already installed, already tested, and already returns silence
correctly. No settings.json change, no install step, no second hook racing the
first.

### Digest machinery that already exists (and why neither is reused)

- `coach weekly` (`bin/agentmem.mjs:95`, `lib/coach.mjs:686-702`) writes
  `recommendations/weekly/YYYY-WW.md`. This is precisely the weekly-review
  pattern the ticket rejects — dead nine weeks. Not extended.
- `appendDigest()` / `syncToObsidian()` (`lib/obsidian.mjs:225,260-265`) already
  write a **daily** `<vault>/<projectDir>/digests/YYYY-MM-DD.md`, with tests at
  `test/obsidian.test.mjs:185-204`. Not reused: it targets an Obsidian vault
  path that need not exist, and it is an *output/publishing* channel. The digest
  queue must be readable by the hook with a plain file read at a path the tool
  controls. Obsidian sync may later publish the digest; it must not own it.

### Invariants the subsystem already maintains

| Invariant | Enforced by |
| --- | --- |
| Live data never committed | `.gitignore` `dir/*` + `!dir/.gitkeep` pattern |
| Fresh clone gets the dir layout | `ensureLayout()` in `lib/storage.mjs:16+`, run by `agentmem init` |
| Ids are filename-safe | `assertSafeId` / `SAFE_ID` (`lib/storage.mjs:8-14`) |
| SessionStart injects nothing when empty | `session-start.mjs:47` |
| Hook does no network / no model call | convention; nothing enforces it today |

---

## Goals (plain English)

1. The background jobs that were never scheduled actually run, **each on its
   intended cadence** — `ingest` and `reflect` nightly, `coach` **weekly**.
2. Once a day, at the first session, I see a **short list of prepared changes**
   with a proposed verdict on each — not a place I have to visit.
3. Approving happens in conversation ("promote 1, 3 and 5").
4. If the nightly job stops running, I find out — silence is allowed, but
   *unexplained* silence is not.
5. A callelo feature PR that merged without a findings-ledger close-out gets
   noticed.

---

## Existence check

| Proposed thing | Status | Evidence |
| --- | --- | --- |
| `agentmem digest` command | **Absent** | `grep -rn "digest" lib bin adapters test` returns only `coach weekly`, obsidian, and a `createHash(...).digest("hex")` |
| SessionStart hook | **Exists + wired** | `adapters/claude-code/session-start.mjs`; registered in `~/.claude/settings.json` |
| Daily-digest file writer | **Exists, wrong owner** | `lib/obsidian.mjs:225` writes to the vault, not the store |
| `coach` launchd job | **Template only, and WEEKLY** | `adapters/launchd/com.example.agentmem.coach.plist` — `Weekday=0`, 04:00; not in `launchctl list`. README:142 calls it "the nightly reflect and weekly coach passes" |
| `ingest` launchd job | **Absent entirely** | no plist template in `adapters/launchd/` |
| Per-repo PR cursor | **Exists** | `ingest-state.json`, callelo at #219 |

**Two cited files are gitignored** (`config.json`, `ingest-state.json`) and so are
absent from any review worktree. Their values here are live-store readings, not
tracked-file anchors; reproduce with `agentmem status` and
`cat $(agentmem-home)/ingest-state.json`. Flagged so a reviewer does not read
their absence as a stale anchor.

This removes the "build a SessionStart hook" work and one of the two "write a
plist" tasks, and it renames step 1 from *install two crons* to *install one
existing template, author one new plist*.

---

## Consumers audit

Everything the change touches, with anchors.

| Surface | `file:line` | Effect |
| --- | --- | --- |
| `paths()` | `lib/paths.mjs:11-25` | add `digest` key — additive, no existing reader breaks |
| `ensureLayout()` | `lib/storage.mjs:16+` | must create `digest/` or a fresh clone lacks it |
| `.gitignore` | `.gitignore:26-52` | add `digest/*` + `!digest/.gitkeep`, matching the existing pattern |
| `session-start.mjs` | `adapters/claude-code/session-start.mjs:36-47` | append a third `part`; the empty-case early return at :47 must still fire |
| `runAdapter()` | `lib/adapters/runtime.mjs` | **new optional 3rd param** `onDelivered`; consumers `post-tool-use.mjs`, `user-prompt-submit.mjs`, `stop.mjs`, `session-start.mjs` all call it with 1 arg and are unaffected — but all four are in scope for the change |
| `reflect` candidate writer | `lib/reflect.mjs:157-169` | add `created_at` (full ISO) alongside `created`; additive, no migration |
| `usage()` | `bin/agentmem.mjs:65-100` | add `digest` line |
| launchd | `adapters/launchd/` | one new template + install of two jobs |
| `ingest-state.json` | gitignored | **not** extended — the ledger check needs no cursor (see below) |

**Write-once / composite-key check.** The digest's date-stamp state file is
write-once *per day* with nothing enforcing it; two concurrent first-sessions
can both stamp. The ticket accepts this (cost: seeing the digest twice). Named
here so it is a decision, not an accident.

---

## Load-bearing assumptions

| Assumption | Impact if wrong | Verified how |
| --- | --- | --- |
| `reflect` is the only installed job | step 1 is wrong about what to install | **measured** — `launchctl list`, `ls ~/Library/LaunchAgents` |
| The SessionStart adapter's output reaches the model | the whole delivery mechanism fails | **measured** — this session's own transcript carries the injected `Accumulated lessons for this repo (via agentmem)` block |
| Store home == git checkout | `digest/` would be committed | **read** — `lib/paths.mjs:7-9` + `.gitignore` |
| Candidates are largely duplicates | **FALSE — see below** | **measured** (probe) |
| Candidate confidence can rank the queue | **FALSE — see below** | **measured** (probe + code read) |
| The 6/day cap drains the backlog | **FALSE — see below** | **measured** (arrival rate) |
| Ledger content is recoverable from PR comments | **FALSE** — disproven 2026-08-03, drafter removed | **measured** — `Codex-plan` rows never touch the PR |

### Probe 1 — candidates are NOT mostly duplicates

The ticket's Tier-1 premise: *"The nightly job dedupes first — that's the actual
work. Many of the 52 restate each other or restate active lessons."*

Jaccard over title tokens (stopworded, len>3), 56 candidates × 45 active lessons:

```
candidates=56 lessons=45
lexical near-dupe pairs (cand~cand): 0
candidates restating an ACTIVE lesson: 0
distinct candidates collapsible (lower bound): 0 of 56 = 0%
```

Red-tested at a looser threshold (0.18) to prove the probe is not vacuous — it
then finds 6/56 (11%), of which most are false positives and exactly one is a
true duplicate:

```
cand~cand 0.23
  A: Name handoff files to match the repo's existing convention
  B: Match existing handoff file naming conventions when saving session state
```

**Re-run at the right layer (gate round 1, finding 4).** Titles were the wrong
surface: a candidate persists a `title`, a body (`rule` + `why`) and a repo
`scope`, and duplicates could live in any of them. Re-probed over **title+body**,
with the scope distribution reported:

```
--- BODY+TITLE threshold 0.30 ---
  cand~cand pairs: 1  cand~lesson: 1  collapsible: 2/56 = 4%
--- BODY+TITLE threshold 0.40 ---
  cand~cand pairs: 0  cand~lesson: 0  collapsible: 0/56 = 0%
--- BODY+TITLE threshold 0.50 ---
  cand~cand pairs: 0  cand~lesson: 0  collapsible: 0/56 = 0%

scope distribution: {"callelo":53,"news-podcast":1,"augment-skills":1,"competitor-coach,callelo":1}
```

The conclusion **survives the correction, and the scope reading strengthens it**:
the gate's counter-hypothesis was that differing scopes might legitimately keep
near-identical candidates apart, but **53 of 56 share the single scope
`callelo`** — so scope is not masking duplicates. If these were operational
duplicates they would collide, and at a 0.40 threshold nothing does.

**Dedupe is not the actual work.** Measured lexical duplication over title+body
is ≤4%.

**Residual, stated rather than hidden:** every method used here is lexical, so it
bounds *wording* overlap, not meaning. Two candidates expressing one rule in
disjoint vocabulary would be missed at any layer. What this licenses is narrow
and is exactly the design decision drawn: **do not assume the backlog collapses
via dedupe.** It does not license "there are no semantic duplicates."

### Probe 2 — candidate confidence is inert, so nothing can rank the queue

All 56 candidates carry **confidence exactly 0.35**:

```
  56 0.35
```

Because `CANDIDATE_CONFIDENCE = 0.35` is a hardcoded constant stamped at
creation (`lib/reflect.mjs:24`, used at `:163`), and the only rescoring path,
`rescoreLesson()` (`lib/reflect.mjs:174-191`), resolves its target via
`listLessons(home)` (`:176`) — **candidates are not in that set and can never be
rescored.** `promote_threshold: 0.6` (`config.json`) is therefore unreachable
for a candidate by construction.

Consequences the design must absorb:

- There is **no deterministic signal to pick "the top 6"** — every candidate is
  identical to any ranker.
- Bulk-reject-by-confidence is impossible.
- This is a pre-existing defect, not one this ticket introduces. This plan does
  **not** fix it (that is its own ticket); it routes around it by ordering on a
  stable key — see below.

#### Ordering key (corrected after gate round 1, finding 2)

`created` alone is **not** a usable FIFO key: it is written as
`new Date().toISOString().slice(0, 10)` (`lib/reflect.mjs:164`) — a date, with no
time. Same-day ties are not an edge case but the norm: **11 candidates share
`2026-08-03`**. Sorting on `created` alone would let directory enumeration decide
order, which is not stable.

**Order by the composite `(created, id)`, ascending.** Candidate ids are already
`YYYY-MM-DD-slug` (e.g. `2026-07-06-design-foundation-before-role-play`) and are
unique — they are the filenames, and uniqueness is enforced by the filesystem
plus `SAFE_ID` (`lib/storage.mjs:8-14`). Lexicographic order on that pair is
**total, deterministic and stable across runs**, needs **no migration**, and
leaves the existing 56 files untouched.

Be precise about what this buys: it delivers *stable, deterministic* ordering
that drains oldest-day-first. It does **not** reconstruct true arrival order
*within* a day — that information was never recorded and cannot be recovered.
Draining a backlog needs the former, so this is sufficient; the plan does not
claim the latter.

**Additive, forward-only:** new candidates also record a full ISO timestamp
(`created_at`), so ordering becomes true-FIFO for everything created from here
on, with no backfill and no change to how the existing 56 sort. Readers prefer
`created_at` when present and fall back to `(created, id)`.

### Probe 3 — the cap does not drain the backlog

Arrival rate, by `created` date:

```
2026-08-01: 2    2026-08-02: 0    2026-08-03: 11    2026-08-04: 4
```

17 in 4 days = **~4.25/day**; trailing 7 days = 23 = 3.3/day. Backlog **56**
(status: `Active lessons 45 / Pending candidates 56 / Signals(7d) 159`). The
ticket was written at 52 — it grew 4 in one day.

At a 6/day cap **shared across all three Tier-1 types**, if candidates take the
whole cap the net drain is ~1.75/day → **32 days**, not "under two weeks"; if
they take 4, net drain is ~0 and the queue **never drains**.

This is a genuine fork and is carried to Dan below rather than silently
resolved.

### Probe 4 — MEMORY.md is a near-term hard failure, not hygiene

```
MEMORY.md: 21,284 bytes | 96 files | 94 index lines | 33,834 words total
```

The ticket recorded 93 files / 91 lines. A PostToolUse hook fired during this
very session: *"The memory index at MEMORY.md is 20.6KB, approaching the 24.4KB
read limit. Compact it to under 17.1KB now."* At ~3 files/day it reaches the
limit within days. Build step 2 is time-sensitive and should not wait behind
steps 3–4.

---

## Simplicity check

**1. What requirement justifies each component?**

| Component | Requirement | Verdict |
| --- | --- | --- |
| `agentmem digest` | goals 2, 4, 5 | keep — the only genuinely new code |
| third `part` in session-start | goal 2 | keep — ~15 lines |
| coach + ingest plists | goal 1 | keep |
| liveness stamp + 3-day warning | goal 4 | keep — this is the requirement the ticket exists to satisfy |
| missing-close-out check | goal 5 | keep — mechanical |
| ~~LLM ledger drafter~~ | *premise disproven* | **cut** (Dan, 2026-08-03) |
| ~~ledger docs-only PR path~~ | only existed to land drafted rows | **cut** |
| ~~output-shape validation~~ | only existed to police the drafter | **cut** |
| ~~separate ledger cursor at #550~~ | only existed to feed the drafter | **cut** |

Four components fell out because the requirement justifying them was removed —
the "over-engineering enters as a leftover" shape. With the drafter gone,
**every part of the digest is deterministic and unit-testable.**

**2. What was searched to confirm each new thing does not exist?** See the
existence-check table — each row cites its grep or `launchctl` output.

**3. Simpler design rejected.** *Extend `coach weekly` instead of adding
`digest`.* Rejected: it is the weekly-review shape that has been dead nine
weeks, and the ticket's central claim is that cadence is the failure. Also
considered: *write the digest into the Obsidian vault via the existing
`appendDigest`*. Rejected: the hook would then depend on a vault path outside
the tool's control; publishing there later is fine, owning it there is not.

**Scale, measured today (2026-08-04):** 45 lessons, 56 candidates, 159 signals
in 7d, 96 memory files, 4 watched repos, callelo at PR ~#578. Everything is
hundreds of small files — no pagination, no index, no database is warranted.

---

## The ledger check (reshaped)

For each merged callelo PR, does any row in `docs/review-findings-ledger.md`
cite it? If not, one digest line. No LLM pass, no drafting, no PR creation.

**The ledger must be read from `origin/main`, never from a local working tree.**
This is not theoretical: the session that wrote this plan initially read a
callelo checkout that was **6 commits behind**, concluded the #572 rows did not
exist, and was wrong. Read via the GitHub API (or an explicit fetch of the blob
at `origin/main`), and treat a local checkout as untrusted.

Currently firing, verified against `origin/main`: ledger cites
`#547 #549 #550 #572 #574`; merged since include **#571, #576, #577, #578** —
four PRs with no close-out. Rows arrive via *separate* close-out PRs (#573 → for
#572; #575 → for #574), so the check must attribute a row to the PR it *cites*,
not the PR that added the row.

---

## Delivery and the once-per-day stamp (corrected after gate round 1, finding 3)

The naive design — *stamp the date, then emit* — has a failure the ticket's
"concurrent first-sessions" note does not cover, and it is the more dangerous
one. `runAdapter` (`lib/adapters/runtime.mjs`) is fail-safe **by design**:

```js
try { const out = await fn(); process.stdout.write(JSON.stringify(out ?? fallback)); }
catch { process.stdout.write(JSON.stringify(fallback)); }
process.exit(0);
```

Any throw inside the adapter body is swallowed and a bare `{continue:true}` is
written. So if the stamp is written inside `fn()` and anything afterwards throws
— a malformed digest file, a permissions error — **the day is marked as
delivered while the user saw nothing**, and every later session that day is
suppressed. That breaks goal 2 silently, which is the worst failure shape for a
feature whose whole purpose is to defeat silent breakage.

**Design: the stamp is written only after the bytes are out.** Add an optional
`onDelivered` callback to `runAdapter`, invoked *after* the successful
`process.stdout.write` and before `process.exit(0)`, itself wrapped in
`try/catch` so it can never break the fail-safe contract:

```js
export async function runAdapter(fn, fallback = { continue: true }, onDelivered) {
  let delivered = false;
  try { const out = await fn(); process.stdout.write(JSON.stringify(out ?? fallback)); delivered = true; }
  catch { process.stdout.write(JSON.stringify(fallback)); }
  if (delivered) { try { await onDelivered?.(); } catch {} }
  process.exit(0);
}
```

The parameter is optional, so the other three adapters (`post-tool-use`,
`user-prompt-submit`, `stop`) are unaffected — but they are in the consumers
audit because the shared runtime changes.

**What this guarantees, precisely:** the stamp means *"the digest was written to
stdout"*, not *"the human read it."* The hook cannot observe whether the host
consumed its output, and this plan does not claim otherwise. It converts the
failure from *silently burning the day* into *retrying later the same day*,
which is the property goal 2 needs.

The concurrent-first-session race is unchanged and still accepted: two sessions
can both deliver, costing a duplicate view. Under the new ordering that is
strictly better than the alternative, since a lost digest is now impossible and a
repeated one is merely noise.

## Red tests (written first)

Each names the assertion and today's failure message.

| # | Test | Asserts | Failure today |
| --- | --- | --- | --- |
| R1 | `digest writes no file when there is nothing to do` | no `digest/YYYY-MM-DD.md` created | `Error: Cannot find module '../lib/digest.mjs'` → **must be fixed to a real red**: create the module exporting a stub first, so the red is behavioural |
| R2 | `digest caps Tier 1 items per day` | ≤ N items in the file | stub returns everything |
| R3 | `digest orders candidates by (created, id)` | total, stable order; **two candidates sharing a `created` date sort by id, not directory order** | stub preserves directory order |
| R3b | `ordering is stable across shuffled directory enumeration` | same output when readdir order is reversed | stub is enumeration-dependent |
| R9 | `stamp is NOT written when the adapter body throws` | next session that day still gets the digest | stamp written before emit → day burned |
| R10 | `onDelivered failure cannot break the fail-safe contract` | adapter still exits 0 with valid JSON | callback throw escapes |
| R4 | `session-start injects the digest once per day` | second invocation same day adds no digest part | no digest part exists |
| R5 | `session-start still returns {continue:true} with no digest` | empty case preserved | — **this already passes: it is a PIN, not a red test** |
| R6 | `liveness warning fires after 3 days with no successful run` | one warning line | no stamp is read |
| R7 | `a PR cited by a ledger row is not flagged` | #572 absent from output | no checker |
| R8 | `a merged PR with no citing row IS flagged` | #577 present | no checker |

R1's naive form fails on a missing module, which proves nothing (the skill's
"red state that is really a compile error" trap). The module lands first as a
stub so every red above fails *behaviourally*.

R5 is labelled a PIN because the behaviour already holds — shipping it as
red-first evidence would be a false claim.

**Over-blocking check (R8's mirror):** a checker that flags *everything* passes
R8. R7 is what stops that, and both must be in the same commit.

---

## Acceptance criteria

| # | Criterion | Goal | Mutation that breaks it |
| --- | --- | --- | --- |
| A1 | Two new launchd jobs appear in `launchctl list`, `ingest` **nightly** and `coach` **weekly** (`Weekday=0`) — cadence asserted, not just presence | 1 | flip either cadence |
| A2 | Nothing to do → no file → no injection | 2 | make the writer always emit a header |
| A3 | Digest appears once on day's first session, not on the second | 2 | remove the date stamp |
| A4 | Cap respected; order total and stable under `(created, id)` | 2 | return unsorted / uncapped / enumeration-ordered |
| A8 | A throw after the stamp point does not suppress the day | 2, 4 | stamp before emit |
| A5 | No network or model call in the hook path | 2 | add a fetch — asserted by injecting a throwing `fetch` |
| A6 | 3-day silence produces exactly one warning line | 4 | never write the stamp |
| A7 | #577 flagged, #572 not | 5 | flag-all, or flag-none |

---

## Build order

1. **`MEMORY.md` hygiene pass** *(moved up — Probe 4 shows it is days from a
   hard limit)*.
2. **Install the two jobs.** The coach template is **not installable as-is** —
   three substitutions plus a cadence decision:
   - `Label` `com.example.agentmem.coach` → `com.dxi106.agentmem.coach`
   - path `/Users/YOUR_USER/...` → the real home
   - node `/usr/local/bin/node` → **`/opt/homebrew/bin/node`** (what the one
     working job, `com.dxi106.agentmem.reflect`, actually uses; the template's
     path does not exist on this Apple-Silicon machine and would fail silently)
   - keep `Weekday=0` — coach stays **weekly** (see goal 1)

   Then author a **new** nightly `ingest --source github` plist (no template
   exists), scheduled **before** `reflect` so a night's ingested signals are
   visible to that same night's reflection — `reflect` is currently 03:15, so
   `ingest` runs at 03:00, not alongside it.
3. **`agentmem digest`** — FIFO selection, cap, liveness stamp, no-op-writes-
   nothing.
4. **Third `part` in `session-start.mjs`** + date stamp.
5. **Missing-close-out check**, reading the ledger from `origin/main`.
6. **Ticket filing** for Tier 2/3 into SOU and CAL.

**Build constraint — do not switch branches in this checkout.** The live
`agentmem` is npm-linked to this working tree, so a branch switch changes the
running tool for every Claude session on the machine. Build in a `git worktree`,
not in place.

---

## Open fork for Dan

**The 6/day cap does not drain the backlog.** Measured: 56 pending, ~4.25/day
arriving, cap shared across three item types. Best case 32 days; realistically
it treads water. Dedupe does not rescue it (Probe 1: ~1 true duplicate), and
confidence cannot rank it (Probe 2: all 56 identical at 0.35, unreachable
threshold).

- **Option A — bulk-reject the stale tail.** One digest line: *"reject these 19
  candidates created before 2026-07-20?"* Drains immediately, one decision, and
  is deterministic. 19 of 56 qualify today.
- **Option B — raise the cap to ~10 and scope it to candidates only**, giving
  ledger/MEMORY items their own small allowance. Drains in ~2 weeks; costs more
  morning attention.
- **Option C — fix the source.** ~4/day arriving is the real problem; tighten
  `min_signals_to_reflect` / the reflection prompt so fewer, better candidates
  are proposed. Slowest to show an effect; addresses the cause.

**Recommendation: A + C.** A clears the 4-week-old tail in one decision tomorrow
morning; C stops it refilling. B alone spends more of the attention this ticket
is trying to protect.

**Not fixed here:** candidate confidence being inert (Probe 2) is a real
pre-existing defect and deserves its own SOU ticket.

---

## Gate record — Codex adversarial review, round 1

Run against `2d1acb8`, scope `docs/plans/2026-08-04-sou-30-daily-action-digest.md`
(one file, scope-asserted). Verdict: **needs-attention / No-ship**, 3 HIGH +
1 MEDIUM. Every premise was re-verified by execution before being accepted —
none was taken on the reviewer's word.

| # | Finding | Premise verified? | Resolution |
| --- | --- | --- | --- |
| 1 | Goal 1 says nightly; the coach template is weekly | **Yes** — `Weekday=0` in the plist; README:142 says "weekly coach" | Goal 1 and A1 rewritten around real cadences. Coach **stays weekly** — `coaching.lookback_days: 7` means nightly runs would re-derive from overlapping windows. Chose the simpler design over adding a cadence |
| 2 | FIFO not representable — `created` is date-only | **Yes** — `slice(0, 10)` at `lib/reflect.mjs:164`; 11 candidates share `2026-08-03` | Order on composite `(created, id)`: total, stable, zero migration. Added forward-only `created_at` for true FIFO going forward. Claim narrowed to what the data can support |
| 3 | Stamp-then-emit burns the day when the adapter throws | **Yes** — `runAdapter` swallows all exceptions and writes the fallback | Stamp moved behind a post-write `onDelivered` callback; R9/R10 added |
| 4 | Dedupe probe measured titles only — wrong layer | **Yes, methodologically** | Re-probed over title+body and reported scope distribution. **Conclusion survived and strengthened**: ≤4% at 0.30, 0% at 0.40, and 53/56 share one scope so scope was not masking duplicates. Residual (lexical ≠ semantic) now stated explicitly |

Finding 4 is worth naming as a process point: it is the *"probe the layer the
claim needs"* trap from the spec method, and this plan fell into it. The
conclusion happened to hold, but it was under-supported when written — the gate
was right to challenge it regardless of the outcome.

Findings 1–3 all trace to the same spec step: **model the subsystem before
proposing a change.** Each is a property of existing code (a plist's `Weekday`,
a field's granularity, a runtime's error handling) that the "How this works
today" section asserted without reading closely enough. That is the step to
tighten, not the reviewer.
