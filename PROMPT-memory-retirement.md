# Prompt — memory maintenance (retirement / anchors / links)

Paste the block below into a fresh session. It is self-contained.

Renamed from "retirement / cluster merge" on 2026-08-06: two clusters were read
file-by-file and produced **one** retirement and **zero** merges. Consolidation
is not this store's lever. Anchor and link rot is.

---

```
Task: maintain my Claude memory store for the callelo project.

Memory dir: /Users/daniacono/.claude/projects/-Volumes-FastSSD-code-callelo/memory/
Index:      that dir's MEMORY.md — one line per memory, loaded into context every
            session. Each memory is its own .md file with YAML frontmatter
            (name / description / metadata.type) and a body; bodies link to each
            other with [[wikilinks]].

State as of 2026-08-06 (verified, re-derived — not inherited):
  MEMORY.md   16,295 bytes, 108 entries, 0 missing, 0 unindexed
  Wikilinks   6 dangling, ALL deliberate ticket markers — a new one is a defect
  Anchors     261 verified (44 paths, 46 bare filenames, 171 symbols), 0 past EOF
  Read limit  24,400 bytes  →  ~8.1 KB headroom, roughly 54 more entries

NOT urgent, and the reason is now measured rather than assumed. Other sessions
add memories concurrently, so re-derive these numbers; do not inherit them.

WHAT PREVIOUS PASSES ALREADY SETTLED — do not redo:

  - Hook-shortening (2026-08-05): mechanical, cut 16%, touched no memory file.
  - Cluster "test quality & falsifiability" (12 files, read in full):
    ZERO merges, ZERO retirements. Four of the twelve were mis-clustered by hook
    and are about other things entirely. Three are hubs with 15-20 inbound links.
  - Cluster "callelo product facts" (13 files, read in full, verified against
    origin/main): ONE retirement (gslides fixture → absorbed into
    cal-434-parked-opt-in-only + repeat-asks-are-a-documentation-defect).
    Ten verified accurate. Two needed anchor/tense refreshes only.
  - Full anchor sweep + all 9 line-numbered anchors hand-verified (2026-08-06).
  - Link hygiene: dangling 12 → 6; cross-system prefix convention adopted.

  - Cluster "wave fork resolutions" (3 files, read in full 2026-08-06):
    ZERO merges, ZERO retirements. The hypothesis that dated decision records go
    stale was WRONG — each fork carries an explicitly-extracted generalised
    principle ("*Generalise:* …"), which is exactly what CLAUDE.md's
    fork-resolution gate mandates be kept as durable precedent. They are the
    precedent store, not history.

  Measured yield across 28 files in three clusters: ONE retirement, ZERO merges.
  Stop reading clusters hoping for redundancy. It is not there.

  Remaining unread clusters, for reference only:
    e2e / Playwright ~13 | epistemics / measurement ~11 | Codex review ~7
    review process ~7 | jest mechanics ~3

THE DEFECT CLASS NEITHER CHECK CATCHES — unlinked refinements.

  A memory can be partly superseded by a LATER memory with no link between them,
  so recalling the older one gives you the un-narrowed rule. Found 2026-08-06:
  Dan narrowed generated-identifiers-ship-with-an-edit-path on 2026-08-01
  (CAL-565), and the narrowing lived only inside wave5-fork-resolutions. Read
  strictly, the un-narrowed precedent pointed at building an entire scenario
  editor inside a bug fix — the opposite of what Dan chose. Fixed by adding a
  SCOPE LIMIT section plus a back-link.

  How to hunt these: read any memory that says it "refines" / "narrows" /
  "supersedes" another, and confirm the TARGET links back. A one-way refinement
  is invisible from the thing it corrects. Zero-inbound-link memories are the
  place to start looking (wave-3 still has none).

WHAT IS ACTUALLY WORTH DOING, in priority order:

1. Run all four integrity checks + the anchor check (below). Fix what they find.
   This is the whole routine maintenance job and it is mostly mechanical.

2. Hand-verify the line-numbered anchors. There are only ~9; `grep -onE` them
   out and read each cited line on origin/main. This is NOT automatable at this
   scale and it out-performs the tool: on 2026-08-06 three of nine had drifted,
   and chasing one of them surfaced a SEMANTIC staleness no checker would see
   (a subsystem Gotcha cited as "never ticketed" had since been fixed by CAL-639).

3. Only then, if asked, read a cluster.

Rules:
  - Never delete a memory file without my explicit go-ahead on that specific file.
  - Verify against origin/main, never the working tree. Check
    `git rev-list --count HEAD..origin/main` FIRST — it has been 13-14 behind,
    and a stale tree produces findings that are just old code. If you find it
    stale mid-task, RE-RUN every conclusion already drawn, not just the next one.
  - A merge must preserve every [[wikilink]] target that still exists, and every
    concrete detail (file paths, flag names, error strings, ticket ids). If a
    detail can't survive the merge, that's an argument against merging.
  - Retiring is not deleting: prefer moving a retired memory's content into the
    memory that supersedes it, so the lesson survives even when the file doesn't.
  - Cite what a file ACTUALLY says, not what its title implies. A title that
    sounds duplicative usually isn't; that distinction is the whole job.
  - After ANY edit to MEMORY.md, re-run the integrity check and show me the
    output. A typo'd filename breaks recall silently — that is exactly how
    diagnose-e2e-from-the-trace-not-a-rerun.md sat unindexed and invisible from
    2026-07-26 to 2026-08-05.
  - Present decisions one at a time with a recommendation, not as a batch.

Integrity check (run from the memory dir):
  grep -c '^- \[' MEMORY.md
  while IFS= read -r f; do [ -f "$f" ] || echo "MISSING: $f"; done \
    < <(grep -oE '\]\([^)]+\.md\)' MEMORY.md | sed 's/^](//;s/)$//')
  for f in *.md; do [ "$f" = MEMORY.md ] && continue; \
    grep -q "($f)" MEMORY.md || echo "UNINDEXED: $f"; done
  grep -ohE '\[\[[^]]+\]\]' *.md | sed 's/\[\[//;s/\]\]//' | sort -u \
    | grep -v ':' \
    | while IFS= read -r t; do [ -f "$t.md" ] || echo "DANGLING: [[$t]]"; done

The fourth check (added 2026-08-05) covers the associative path, which the first
three do not. MEMORY.md can be perfectly consistent while a [[wikilink]] inside a
memory body points at a slug that no longer exists — recall follows the link, hits
nothing, and nothing reports it. Same silent-failure shape as the unindexed
orphan, one layer down. It caught a real typo'd link within twenty minutes of
being added.

DANGLING output should now contain ONLY ticket-shaped markers ([[CAL-603]],
[[CAL-635]]) — deliberate placeholders for memories not yet written. Leave them.
Anything else is a defect: either a genuine rename (repoint it to the live
successor) or a cross-system reference that is missing its prefix.

Cross-system links carry a `system:` prefix and are skipped by `grep -v ':'` —
e.g. [[agentmem:warn-before-parallel-agents]] names a lesson in CLAUDE.md's
agentmem block, not a file in this store. Use the prefix for any target living in
another system. Never invent a same-store target to silence a dangling link.

Anchor check (verifies file:line and symbol citations against real code):
  ./anchor-check.py origin/main          # run from /Volumes/FastSSD/code/agent-memory

  Red-test it FIRST — it is a check, and a check you have not seen fail is
  decoration:
    ANCHOR_MEM_DIR=./anchor-check-fixture ./anchor-check.py origin/main
  Expect exactly 4 findings (one per detector) and the known-good file clean.
  Its first real run reported 5 false "broken paths" from a regex bug; the
  fixture had only covered .ts, not .tsx/.json. Keep the fixture covering every
  extension the store actually cites.

  It catches: dead file paths, lines past EOF, missing bare filenames, absent
  symbols. It does NOT catch line drift inside a file that still exists — that is
  the most common real decay, and step 2 above is how it gets caught. Do not
  claim the tool covers it.

  Expect ~22 correctly-absent hits, all triaged and expected: runtime artifacts
  (e2e/.auth/*.json, error-context.md), paths outside the repo (.claude/**,
  .mcp.json, codex-companion.mjs), identifiers from other systems (agentmem,
  Codex, Claude Code tools, Cloud Monitoring), things cited as hypotheticals
  (pg_notify), and two CAL-434 orphans annotated in-place as historical.
  Triage before believing any of it.

Start with step 1 and report back.
```

---

## Why the prompt is shaped this way

- **It leads with "not urgent," and now with measured evidence.** A retirement
  pass run under size pressure deletes something load-bearing. Two clusters read
  in full yielded one retirement, so the urgency was never there.
- **It records what previous passes settled.** The original version said "start
  with test quality & falsifiability — I believe it has the most genuine
  redundancy." That was tested and produced zero. Leaving that line in would make
  every fresh session redo it.
- **It forbids working from the index hooks.** The hooks were deliberately
  compressed on 2026-08-05; they understate the differences between memories.
  Four of twelve files in the first cluster were mis-grouped by hook alone.
- **It puts the mechanical checks first and cluster-reading last**, which is the
  reverse of the original order — because that is where the defects actually were.
- **It carries both checks inline**, because this store's two real failure modes
  are silent: an unindexed orphan, and an anchor that points at code that moved.
- **It says to verify against origin/main and to re-run prior conclusions on
  discovering staleness**, because a 13-commit-behind checkout produced a
  confident, wrong "this memory asserts enforcement that doesn't exist" report
  on 2026-08-05.
