# Claude Code features — catalog for the coaching engine

Hand-curated reference of Claude Code capabilities that users routinely fail to discover. Each entry has a `Miss-signature` describing an empirically observable pattern in session transcripts that indicates the user isn't using the feature — the coaching engine consumes these to surface targeted recommendations.

Each entry: `## Feature` heading, then four labeled lines (What / When to use / Miss-signature / Surface to user as). Parser splits on `^## ` boundaries.

---

## Plan mode

**What:** A first-class "design the change before touching code" mode entered via `/plan` or the `EnterPlanMode` tool. The agent thinks through the approach, files involved, and risks, then exits with an explicit plan that you accept, revise, or reject before any edit lands.
**When to use:** Changes touching 3+ files, anything with architectural impact, or anywhere "make sure we agree on the approach first" is worth a round-trip.
**Miss-signature:** Long sessions with many `Edit`/`Write` revisions on the same files, repeated user corrections of approach, and zero or unbalanced `EnterPlanMode`/`ExitPlanMode` calls. Particularly: ≥3× same-file edits without a preceding `EnterPlanMode`.
**Surface to user as:** "This kind of multi-file change usually goes better through `/plan` — want me to sketch the approach first before editing?"

---

## Worktrees

**What:** Isolated checkouts of the same repo at different branches/commits, so multiple agents can work in parallel without stomping each other's `git checkout`. Available via the `Agent` tool's `isolation: "worktree"` parameter or the `superpowers:using-git-worktrees` skill.
**When to use:** Whenever two or more agents are working in the same repo concurrently (parallel feature branches, parallel review + impl streams). Also when you want a clean workspace for a risky operation without disturbing your active branch.
**Miss-signature:** Multiple parallel `Agent` dispatches with `subagent_type: "general-purpose"` against the same repo path and no `isolation` flag. Also: user complaining about "branch switched under me" or "agent overwrote my changes."
**Surface to user as:** "Running these in parallel without `isolation: \"worktree\"` is the race the `feedback-parallel-agents-share-worktree` memory warns about. Worth either serializing or adding the flag."

---

## Custom slash commands

**What:** User-defined commands at `~/.claude/commands/<name>.md` (or project-level `.claude/commands/<name>.md`) that expand to a prompt template. Invoked as `/<name>` from the prompt box.
**When to use:** Any multi-line preamble you find yourself typing more than twice — `/code-review`, `/deploy`, `/security-review`, `/pr`, etc.
**Miss-signature:** User pastes near-identical multi-line preambles across sessions (e.g., "run /code-review then /security-review, fix any above-Low findings, then…"). Specifically: ≥3 sessions in a 30-day window with the same opening 200+ character preamble.
**Surface to user as:** "You've typed this preamble verbatim N times this month — worth a slash command at `~/.claude/commands/<name>.md`."

---

## Hooks

**What:** Lifecycle scripts registered in `~/.claude/settings.json` under `hooks.{SessionStart,UserPromptSubmit,PreToolUse,PostToolUse,Stop,…}`. Run synchronously as part of the session loop; can inject context, log signals, block tool calls, or just observe.
**When to use:** Anything you want to happen automatically at a lifecycle moment — daily briefing on SessionStart, signal capture on UserPromptSubmit, blocking a dangerous Bash pattern via PreToolUse, etc.
**Miss-signature:** User repeatedly runs the same post-edit command manually (linter, formatter, test) — a hook would do this on every Edit. Also: user has a recurring instruction in CLAUDE.md that a hook could enforce mechanically.
**Surface to user as:** "You run `npm run lint` after every edit by hand — this is exactly what a PostToolUse hook automates."

---

## MCP servers

**What:** Model Context Protocol servers (local or remote) that expose tools to the agent — Linear, Slack, Gmail, Notion, Playwright, Granola, Google Calendar/Drive, and many more. Registered in Claude Code config; tools appear as `mcp__<server>__<tool>` in the agent's tool surface.
**When to use:** Whenever the data or action you want is in an external system that has an MCP server. Beats copy-pasting from the web UI of that service.
**Miss-signature:** User pastes content from Slack/Gmail/Linear/Notion into a prompt instead of having the agent fetch it. Particularly: paste blocks >500 chars from a known-MCP-supported service.
**Surface to user as:** "Linear has an MCP server — `mcp__linear-server__get_issue SOU-X` is faster than pasting the description."

---

## `/clear` and compaction

**What:** `/clear` resets the conversation state, keeping only system prompt + CLAUDE.md context. `/compact` summarizes the existing conversation and continues. Both reset the prompt-cache TTL and reclaim attention budget.
**When to use:** Between unrelated tasks. Treat `/clear` like committing in git — at task boundaries, not as a panic move.
**Miss-signature:** Sessions exceeding 500 messages with no `/clear` or `/compact` invocation; sessions exceeding 2 hours wall-clock without a reset; user re-explaining context that was established earlier in the same session (a sign the model is losing it).
**Surface to user as:** "This session is at ~800 messages and you're starting a different ticket — worth a `/clear`."

---

## Specialized subagent types

**What:** The `Agent` tool accepts a `subagent_type` parameter selecting a purpose-tuned agent — `Explore` (read-only fast search), `Plan` (architecture planning), `feature-dev:code-reviewer` (correctness review), `feature-dev:code-explorer` (deep tracing), `feature-dev:code-architect` (blueprints), `claude-code-guide` (Claude Code feature questions). Defaults to `general-purpose` which has the full toolset.
**When to use:** Match the task: lookups → Explore; "design how to add X" → Plan; "review this diff" → feature-dev:code-reviewer; "how do I use Claude Code feature Y" → claude-code-guide.
**Miss-signature:** Ratio of `general-purpose` dispatches to specialized dispatches above ~3:1 in any 30-day window, especially when many dispatches are pure file searches (Explore-shaped) or design tasks (Plan-shaped).
**Surface to user as:** "This dispatch is a pure file search — `Explore` is faster (no Edit/Write loaded) and avoids the general-purpose context overhead."

---

## Background bash + Monitor

**What:** `Bash` tool accepts `run_in_background: true` for long-running commands; output streams to a file. The `Monitor` tool tails the stream until a condition is met (regex match, exit, timeout). Together: don't block the main thread on long ops.
**When to use:** Any command that may take >30 seconds (CI runs, deploys, build pipelines, test suites, npm installs in large repos).
**Miss-signature:** Foreground `Bash` calls with `timeout > 60000` ms set explicitly, or repeated short timeouts as the user keeps re-polling, instead of a single background launch + Monitor.
**Surface to user as:** "This `npm run build` typically takes 3 minutes — `run_in_background: true` plus Monitor lets you do other work while it runs."

---

## `/schedule` and `CronCreate`

**What:** `/schedule` invokes the schedule skill for cron-style remote agents (recurring or one-shot). `CronCreate` is the underlying tool for managing scheduled jobs. Pairs with `RemoteTrigger` and `ScheduleWakeup` for autonomous loops.
**When to use:** Anything recurring — "every weekday morning, summarize my unread Slack DMs"; "every 5 minutes, check if the deploy finished." Also one-time "remind me to look at X tomorrow at 9am."
**Miss-signature:** User manually re-runs the same task on a regular cadence (e.g., daily, weekly) across multiple sessions, instead of scheduling once.
**Surface to user as:** "You've run this Linear-triage manually every Monday for 6 weeks — `/schedule` would do it automatically."

---

## `ultrathink` / extended thinking

**What:** Adding the phrase `ultrathink` (or `think harder`, `think a lot`) to a prompt triggers Claude's extended thinking mode, which allocates more reasoning budget before the response. Particularly effective on Opus.
**When to use:** Genuinely hard reasoning tasks — design tradeoffs, novel debugging, architecture decisions, code reviews where the answer isn't obvious. Cheap relative to a multi-round back-and-forth where you keep asking for deeper analysis.
**Miss-signature:** Sequences where Claude proposes → user pushes back → re-propose → push back ≥3 turns on what appears to be one analytical question. Indicates the first pass was too shallow.
**Surface to user as:** "This is a tradeoff question worth a deeper first pass — try adding `ultrathink` to the prompt."

---

## The `superpowers:*` skill ecosystem

**What:** A plugin collection providing process-discipline skills the agent invokes via the `Skill` tool: `brainstorming` (explore before building), `writing-plans` (TDD task lists), `executing-plans` (work through them with checkpoints), `test-driven-development` (red→green→refactor enforcement), `verification-before-completion` (run the thing before claiming done), `requesting-code-review`, `receiving-code-review`, `systematic-debugging`, `using-git-worktrees`, `dispatching-parallel-agents`, `finishing-a-development-branch`, and more.
**When to use:** Whenever starting a new feature, debugging a bug, or transitioning between dev phases. The right skill structures the work.
**Miss-signature:** Sessions implementing features without invoking `brainstorming` first (creative work without exploration), or implementing without `test-driven-development` (no red→green visible in transcript). Specifically: `Skill` tool invocations for `superpowers:*` averaging < 1 per multi-hour coding session.
**Surface to user as:** "Building this feature? `superpowers:brainstorming` first — locks the requirements before you write code."

---

## Skill invocation by natural language

**What:** Skills can be triggered by phrasing rather than exact names. "Let's brainstorm X", "use TDD for this", "do a security review on the diff" all activate the right skill without remembering the manifest. The agent picks the matching skill from its available-skills list.
**When to use:** Anywhere a skill applies — don't gatekeep on memorizing names.
**Miss-signature:** User remembers a skill exists but worries about typing it wrong, so doesn't invoke. Or asks "what was that skill called" mid-session.
**Surface to user as:** "Just say 'use TDD' or 'let's brainstorm' — the agent matches by intent, not by exact name."

---

## `@file` references in prompts

**What:** Typing `@path/to/file` in the prompt box auto-attaches the file's contents as context (with tab completion). Faster than asking the agent to Read it.
**When to use:** Anywhere you want a specific file in context — referencing a config, a doc, a previous plan. Particularly for files outside the cwd.
**Miss-signature:** User types "look at the file at <path>" instead of `@<path>`, causing an extra Read round-trip.
**Surface to user as:** "Use `@<path>` in the prompt — saves a tool call and the result is right there in context."
