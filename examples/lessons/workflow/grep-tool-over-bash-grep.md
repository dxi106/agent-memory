---
id: grep-tool-over-bash-grep
title: Prefer the dedicated search tool over shelling out to grep
category: workflow
scope:
  repos:
    - '*'
confidence: 1
created: 2026-01-01T00:00:00.000Z
evidence_count: 1
source: manual
last_evidence: '2026-01-01'
---

**Rule:** Use the agent's dedicated code-search tool when searching for content or symbols. Reserve shell `grep` for piping output through other unix commands.

**Why:** The structured search tool returns file/line context, supports include/exclude globs natively, is faster on large repos, and keeps the transcript clean.

**How to apply:** Searching code for content or symbols → use the search tool. Only fall back to shell `grep` when piping/transforming output is part of the same command.
