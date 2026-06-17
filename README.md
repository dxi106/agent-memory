# agentmem

A cross-tool memory + coaching layer for AI coding agents (Claude Code, Cowork,
and any MCP-capable host).

It does two things:

1. **Memory** — silently captures *signals* (corrections, praise, retries) from
   your agent sessions, distills them into approved *lessons* (rules the agent
   should follow), and regenerates an `AGENTS.md` your agents read.
2. **Coaching** — periodically reviews those signals against a knowledge base of
   agent best-practices and surfaces *recommendations* for **you**: features
   you're not using, anti-patterns to drop, workflow gaps to close.

The pipeline, in one line:

```
capture (hooks/MCP) → reflect → lessons (for the agent)
                              ↘ coach → recommendations (for you) → nudge
```

> **signal vs lesson vs coaching:** a *signal* is a raw captured event; a
> *lesson* is a rule for the **agent** (distilled from many signals, approval-
> gated into `AGENTS.md`); a *coaching recommendation* is a tip for **you**
> about using your tools better. Same input, two different outputs.

Storage is plain files — markdown lessons + JSONL signals, searched by
keyword/scope. No vector DB, no embeddings (see *Design notes* at the bottom for
why).

---

## Prerequisites

- **Node ≥ 18**
- **macOS** if you want the Keychain API-key storage and the `launchd` cron
  templates (the CLI itself is cross-platform)
- The **`gh` CLI** (optional) — only for the GitHub ingester; falls back to a
  `GITHUB_TOKEN` env var
- An **Anthropic API key** — only needed for `reflect` and `coach run` (the
  capture/recall/MCP paths don't call any API)

## Install

```bash
git clone <this-repo-url> agent-memory
cd agent-memory
npm install
npm link            # optional: puts `agentmem` on your PATH

agentmem init                      # create the store layout
cp config.example.json config.json # then edit paths/repos for your machine
```

If you skip `npm link`, run the CLI with `node bin/agentmem.mjs <command>`.

**Where the store lives:** by default, `~/Documents/code/agent-memory` (created
on `init` if absent). Set the `AGENTMEM_HOME` env var to put it anywhere else —
point it at this clone's directory, or at an iCloud/Dropbox path to share one
store across machines. Your live data (`signals/`, `lessons/`, `candidates/`,
`recommendations/`, `reflections/`, `config.json`) is **gitignored** — this repo
ships the engine, not your data. See `examples/` for synthetic samples of each
data shape.

## First run

```bash
# 1. Store the Anthropic key in the Keychain (see "API key" below), or:
export AGENTMEM_API_KEY=sk-ant-...

# 2. Capture a signal by hand (hooks/MCP do this automatically — see below)
agentmem signal correction "used a mock where a real DB call was needed"

# 3. Distill recent signals into candidate lessons
agentmem reflect --dry-run

# 4. Generate coaching recommendations from recent signals
agentmem coach run --dry-run

# 5. Review and triage
agentmem list --candidates
agentmem coach list
```

`--dry-run` prints what would be written without persisting — drop it to keep
the results.

---

## CLI commands

Run `agentmem help` for the full list. Highlights:

- `agentmem init` — create the store layout.
- `agentmem status` — counts of lessons / candidates / signals.
- `agentmem signal <type> <summary>` — append a signal by hand.
- `agentmem reflect [--dry-run]` — read recent signals + active lessons + the
  `knowledge/` base, call the model with a versioned, prompt-cached reflection
  prompt, and write candidate lessons (+ re-score existing ones). Reads the key
  from `AGENTMEM_API_KEY` or the macOS Keychain. Logs to
  `reflections/YYYY-MM-DD-HH-MM.md`.
- `agentmem promote <id|all>` / `reject <id>` / `retire <id>` — triage
  candidates and active lessons. `promote` regenerates `AGENTS.md`.
- `agentmem inject [--scope <cwd>]` — print top in-scope lessons (for hooks).
- `agentmem ingest [--since Nd] [--host claude-code]` — scrape Claude Code
  transcripts from `~/.claude/projects/` for signals, deduped against the live
  hook.
- `agentmem ingest --source github [--since 30d]` — scrape the repos in
  `config.watch_repos` for signals that never show up in transcripts (see
  *GitHub ingester*).
- `agentmem coach [list]` — list pending recommendations.
- `agentmem coach run [--since 7d] [--dry-run]` — run a coaching pass.
- `agentmem coach show <id|all>` / `accept <id|all>` / `dismiss <id>` /
  `snooze <id> <days>` — manage recommendations. `dismiss` is sticky.
- `agentmem coach weekly` — write a digest to `recommendations/weekly/YYYY-WW.md`.

## API key

`reflect` and `coach run` resolve the Anthropic key in this order:

1. `AGENTMEM_API_KEY` environment variable (deliberately **not**
   `ANTHROPIC_API_KEY` — that name collides with Claude Code's own auth).
2. macOS Keychain entry under service `agentmem`, account `anthropic`.

Store it once in the Keychain (no plaintext on disk, works for cron too):

```bash
security add-generic-password -s agentmem -a anthropic -T /usr/bin/security -w
```

Rotate with `-U`; delete with `security delete-generic-password -s agentmem -a anthropic`.

## Capture hooks (Claude Code)

`adapters/claude-code/` holds the hook scripts that log signals automatically.
Wire `session-start.mjs` (and the capture hooks) into your Claude Code
`settings.json` hooks so corrections/praise/retries are recorded as they happen.
The hooks write to the same `signals/YYYY-MM-DD.jsonl` the CLI and MCP server use.

## Scheduling (launchd)

Template plists for the nightly reflect and weekly coach passes live in
`adapters/launchd/`. They pull the API key from the Keychain at runtime — no
plaintext on disk. Edit the placeholder node path and repo path, then:

```bash
cp adapters/launchd/com.example.agentmem.reflect.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.example.agentmem.reflect.plist
```

(Do the same with `com.example.agentmem.coach.plist`.) Confirm the node path
matches `which node` on your machine first.

## GitHub ingester

`agentmem ingest --source github` reads `config.watch_repos` and emits four
signal kinds the rest of the pipeline treats like transcript signals:

| Type | What it captures |
|---|---|
| `review_comment` | Non-trivial reviewer pushback on merged PRs (LGTM/`nit:`/emoji-only dropped) |
| `revert` | Commits whose subject starts with `Revert "..."`, paired to the original when possible |
| `hot_file` | Files touched in ≥ N commits over the last M days (lockfiles excluded) |
| `convention_change` | Edits to `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `knowledge/*.md` |

**Auth:** prefers an authenticated `gh` CLI, else a `GITHUB_TOKEN`/`GH_TOKEN`
env var (`repo:read` scope for private repos). Per-repo cursors live in
`ingest-state.json` (gitignored). It does **not** post back to GitHub, scrape
trending/followed repos, or use webhooks — poll-only, daily-ish.

## MCP server

`bin/agentmem-mcp.mjs` is a stdio MCP server exposing the store to any
MCP-capable host (Claude Code, Cowork, Cursor, …). This is the only way for
hosts without a hook surface (e.g. Cowork) to write signals or recall lessons.

| Tool | Does |
|---|---|
| `remember_correction(summary, scope?)` | Append a correction signal |
| `remember_praise(summary, scope?)` | Append a praise signal |
| `remember_decision(decision, reason, scope?)` | Append a decision signal |
| `recall(query?, scope, limit?)` | Keyword + scope search over active lessons |
| `inject(scope, limit?)` | Top in-scope lessons as bullet lines |
| `list_pending()` | Candidate lessons + pending recommendations |
| `promote(id)` / `reject(id)` | Triage a candidate (promote regenerates `AGENTS.md`) |
| `get_coaching_tips(scope?, limit?)` | Pending recommendations for the caller's cwd |

Register it by pointing your host's MCP config `command` at `node` and `args` at
the absolute path of `bin/agentmem-mcp.mjs`. The server reads `AGENTMEM_HOME` to
locate the store and does **not** call the Anthropic API.

## Obsidian sync (optional, read-only)

When `config.obsidian.enabled` is true, each `reflect`/`coach run` writes a
`pending.md` (current tips/candidates/signal counts) and a dated digest into
your vault. The store stays the source of truth — Obsidian is a view. Trigger
manually with `agentmem obsidian sync`. Failures (missing vault, iCloud not
synced) log to stderr but never block a pass.

---

## Design notes — why plain files, not a vector DB

agentmem deliberately stores lessons as markdown and signals as JSONL, searched
by keyword + scope, rather than embeddings in a vector store. At a single
developer's scale the corpus is small enough that retrieval quality isn't the
bottleneck; plain files stay human-readable, git-diffable, and hand-editable;
there's no index to build or embedding cost to pay; and the thing that actually
matters — a human approving each lesson before it changes agent behavior —
doesn't need vector search at all. The capture → reflect → approve → nudge loop
is the point, not retrieval cleverness.

## License

MIT — see [LICENSE](./LICENSE).
