---
id: 2026-01-01-use-plan-mode
severity: medium
category: feature_miss
status: pending
snooze_until: null
created: '2026-01-01'
evidence:
  - >-
    [2026-01-01T10:20:00] correction cwd=example-app: agent started editing
    across 6 files, user stopped it to realign on approach mid-change.
  - >-
    [2026-01-02T15:40:00] retry cwd=example-app: multi-file refactor was redone
    twice after the design shifted partway through.
next_step: >-
  For changes spanning 3+ files or with architectural impact, enter plan mode
  first, get the plan approved, then execute — instead of editing straight away.
related_knowledge: claude-code-features.md#plan-mode
---
# You're doing multi-file changes without plan mode

Two recent sessions show large, multi-file edits being started without an
up-front plan, then partially reworked once the approach changed. Claude Code's
plan mode is built for exactly this: it produces a reviewable plan you
accept/revise before any code is written, which avoids the propose → push back →
re-propose loop on bigger changes.

This isn't about every change — trivial edits don't need it. The pattern to
fix is the 3+ file / architectural-impact change that's currently going
straight to implementation.
