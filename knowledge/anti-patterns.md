# Anti-patterns — for the coaching engine

Known failure modes observed across coding-agent sessions. Each entry has a `What it looks like` (observable in transcripts), a `Why it's bad` (consequence), and a `Counter-pattern` (the corrective behavior). The `Reference:` line points at the source where applicable.

Each entry: `## Anti-pattern` heading, four labeled lines. Parser splits on `^## ` boundaries.

---

## Agent stops after posting reviews

**What it looks like:** A dispatched agent runs the full TDD + code-review + security-review cycle, both reviews come back clean, the agent writes "Proceeding to merge per the iterate-and-merge protocol" (or "Ready to merge") — and then stops. `gh pr merge` is never run. PR remains OPEN; main thread has to recover by merging directly.
**Why it's bad:** The whole point of the iterate-and-merge loop is to land low-risk reviewed changes without extra round-trips. An agent that does 99% of the work and leaves the final 30-second `gh pr merge` undone defeats the delegation. Recurring this session (SOU-14, SOU-26, attempted SOU-15) — three for three.
**Counter-pattern:** For dispatched code-change tickets, plan for main-thread merge as the default — not the exception. Either split the dispatch into impl-and-merge as two separate tasks, OR explicitly run `gh pr merge` from the main thread after the agent returns "reviews clean." Don't expect the agent to complete the merge step despite any prompt instructions.
**Reference:** `feedback-agent-stops-at-review-pattern.md`

---

## Narrating internal deliberation instead of acting

**What it looks like:** Long assistant turns full of "Let me think about this…", "I'm going to consider whether…", "On the one hand X, on the other hand Y…" with no tool calls and no decision at the end. The user reads it and has to prompt "ok so what?" to get an action.
**Why it's bad:** Reasoning is what `ultrathink` is for. User-visible text should be *communication* — what you found, what you changed, what's next — not a transcript of internal thought. Narration without action wastes the user's reading time and signals indecision.
**Counter-pattern:** Internal deliberation stays internal (or goes in an extended-thinking block). User-facing text is short, decided, and ends with either an action or a question. State results and decisions directly. If a thought is worth communicating, it's worth one sentence, not a paragraph of qualifiers.
**Reference:** general Claude Code text-output guidance ("State results and decisions directly")

---

## Apologizing instead of fixing

**What it looks like:** "Sorry, I should have caught that," "My apologies for the confusion," "You're right, I made an error" — repeated multiple times in a turn before (or instead of) actually addressing the issue. Especially common after the user points out a mistake.
**Why it's bad:** Performative apology eats turn budget and trains the user that pushback gets sympathy instead of correction. The right response to a bug or wrong claim is a concrete fix, not a feeling.
**Counter-pattern:** One acknowledging sentence ("That was wrong — fixing now.") followed immediately by the actual investigation/fix. Never two apologies in one turn. Never apologize before knowing what went wrong.
**Reference:** general Claude tone guidance

---

## Parallel agents racing on a shared working tree

**What it looks like:** User dispatches two or more `Agent` calls in parallel against the same repo path, with `subagent_type` for either or both. The agents each `git checkout` different branches, stomping each other's working tree. Symptoms: an agent sees files unexpectedly missing, finds itself on the wrong branch, or its commit lands on a sibling agent's branch.
**Why it's bad:** Git has one working tree per repo (without explicit worktrees). Two agents sharing it inevitably race. The losing agent produces silently-wrong results.
**Counter-pattern:** Either serialize (default to one agent per repo at a time) OR use `isolation: "worktree"` in the `Agent` tool, which creates a proper git worktree per agent. Per the user's `feedback-default-to-serial-work-parallelization` memory: within-repo work is serial by default; cross-repo parallel up to 3 streams; worktrees are an explicit exception.
**Reference:** `feedback-parallel-agents-share-worktree.md`, `feedback-default-to-serial-work-parallelization.md`

---

## General-purpose subagent for code or security reviews

**What it looks like:** `Agent(subagent_type: "general-purpose", prompt: "review this PR for correctness bugs…")` instead of `subagent_type: "feature-dev:code-reviewer"`. Similarly: a `general-purpose` agent invoking the security-review skill itself rather than the user invoking it.
**Why it's bad:** Specialized review agents have purpose-tuned prompts and tool sets — `feature-dev:code-reviewer` knows to do confidence-based filtering of findings, focuses on high-priority issues, and applies project conventions. A `general-purpose` agent doing the same work produces lower-quality, lower-confidence findings — including the false positives that erode trust.
**Counter-pattern:** `/code-review` → `feature-dev:code-reviewer` agent. `/security-review` → invoke the `security-review` skill (in main thread; cd into the repo first if it errors on cwd). Never `general-purpose` for either of these.
**Reference:** `feedback-specialized-review-agents.md`

---

## `/clear` never invoked in long sessions

**What it looks like:** Sessions exceeding 500 messages (or several hours of wall-clock) with no `/clear` or `/compact` invocation. User notices Claude "forgetting" things established earlier in the session, or re-asking for context that was already given. The model's first responses in the session were sharper than its current responses.
**Why it's bad:** Prompt cache TTL is ~5 minutes. After the cache turns over, every turn re-reads the accumulated history with degraded attention. Long sessions cost more per turn AND produce worse output. The initial coaching report found this in 459/468 sessions (98%).
**Counter-pattern:** Treat `/clear` like committing in git — at task boundaries, not as a panic move. New ticket, new feature, new debugging session → `/clear`. Keep the session focused on one logical scope.
**Reference:** `lessons/behavioral/2026-05-30-clear-discipline-at-task-boundaries.md`

---

## `ANTHROPIC_API_KEY` set in the shell

**What it looks like:** `export ANTHROPIC_API_KEY=sk-ant-…` in `~/.zshrc` or similar. Claude Code launches in a shell with that env var present.
**Why it's bad:** Claude Code reads `ANTHROPIC_API_KEY` itself. When set, the CLI routes through the user's pay-per-token API key instead of their Max plan auth — silently switching billing modes without the user knowing. Per the user's correction on 2026-05-29, this confused Claude Code repeatedly.
**Counter-pattern:** Store the key under a different env var name (`AGENTMEM_API_KEY`, etc.) OR in the macOS Keychain. For `agentmem reflect` specifically, both paths are supported via the resolver shipped in SOU-25.
**Reference:** `lessons/workflow/2026-05-29-no-anthropic-key-in-shell.md`

---

## Default to general-purpose subagent dispatch

**What it looks like:** Almost every `Agent` call uses `subagent_type: "general-purpose"` regardless of task shape. Especially: pure file searches that should be `Explore`, design tasks that should be `Plan`, Claude Code feature questions that should be `claude-code-guide`. The initial coaching report found 356/430 (83%) of dispatches were `general-purpose`.
**Why it's bad:** `general-purpose` carries the full toolset (Edit, Write, Bash, all MCP tools), which is unnecessary overhead for read-only tasks and slows things down. Specialized agents have tighter prompts and faster startup.
**Counter-pattern:** Before dispatching, glance at the available `subagent_type` list. Match the task: search → Explore; design → Plan; review → feature-dev:code-reviewer; Claude Code question → claude-code-guide. `general-purpose` is the right answer only when the agent legitimately needs the full toolset.
**Reference:** `lessons/behavioral/...subagent-types...` (encoded in SOU-2 closure, present in MEMORY.md via the session-2026-05-30 closing comment)

---

## Skipping the existence-check before dispatching against a ticket

**What it looks like:** Spawning an `Agent` on a backlog ticket without first grepping the target repo for prior implementation. The agent dutifully builds the feature — only for the user (or the agent late in its run) to discover an earlier ship of the same thing already exists.
**Why it's bad:** The 2026-04-29 ticket sweep produced duplicates of already-shipped work because the dispatch didn't check first. Wasted agent runtime, polluted git history, and confusing PR review for the user.
**Counter-pattern:** Before dispatching, run `Grep`/`Glob` for the feature's symbols/keywords in the target repo. If anything matches, read it and decide — close as duplicate, extend, or proceed with awareness of the prior work.
**Reference:** `feedback-existence-check-before-dispatch.md`

---

## Skipping `git fetch` before reviewing repo state

**What it looks like:** Agent reviews/comments on the state of a repo it cloned/checked out hours or days ago without first `git fetch`-ing. Decisions made off a stale baseline — "this feature doesn't exist" when it was merged yesterday.
**Why it's bad:** A many-commits-stale checkout produces confidently-wrong answers ("this feature doesn't exist") about a repo that actually changed. Reviewing the wrong reality is worse than admitting you didn't review.
**Counter-pattern:** `git -C <path> fetch` (or check behind-count) before any review, comparison, or "does X exist in this repo" assertion. Especially for repos with active development across multiple Macs / agents.
**Reference:** `feedback-fetch-before-reviewing-repo.md`
