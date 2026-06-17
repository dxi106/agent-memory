# Anthropic / superpowers best practices — for the coaching engine

Process patterns the agent should follow, drawn from the superpowers skill manifest and Anthropic guidance. Each entry has a `Skip-signature` — what it looks like when the user/agent is *not* applying the pattern. The coaching engine uses these to surface "this is the pattern that fits, here's the skill to invoke."

Each entry: `## Pattern` heading, four labeled lines (What / When to apply / Why it works / Skip-signature). Parser splits on `^## ` boundaries.

---

## Test-driven development (red → green → refactor)

**What:** Write the failing test first, run it, watch it fail for the expected reason, then write the minimal code to make it pass. Refactor with tests green. The `superpowers:test-driven-development` skill enforces this.
**When to apply:** Any new feature or bug fix where the behavior is well-defined. Especially anywhere a regression would be expensive — security-critical paths, data integrity, public APIs.
**Why it works:** A test that passed immediately proves nothing — it might test the wrong thing, miss edge cases, or just match the implementation by accident. Watching the test fail first proves it actually tests something. Tests-after answer "what does this do"; tests-first answer "what should this do" — they discover edge cases instead of remembering them.
**Skip-signature:** New code added in `lib/`, `src/`, or similar without a corresponding new test in `test/`/`__tests__/`/`spec/` in the same commit or PR. Particularly: PR with `Files changed: N` where the test ratio is <0.3 and the code paths are non-trivial.

---

## Brainstorming before creative work

**What:** Use `superpowers:brainstorming` before any new feature, component, or behavior change. Explores user intent, requirements, constraints, and design tradeoffs before any code is written. Output is alignment, not artifacts.
**When to apply:** Anything that's not a trivial bugfix or one-shot edit. Specifically: when the user says "build X", "let's add Y", "what would it take to Z", or "I want to be able to…".
**Why it works:** Cheap to change a design in conversation; expensive to change it in code after 200 lines exist. Brainstorming surfaces hidden assumptions, alternative approaches, and edge cases the user wouldn't have thought to mention upfront.
**Skip-signature:** Session goes directly from a "let's build X" prompt to Edit/Write of new files within 10 turns, with no `Skill` invocation for `superpowers:brainstorming` and no `EnterPlanMode` call. Resulting code often gets revised heavily within the next 50 turns — that revision was the brainstorming, just performed in code rather than in conversation.

---

## Verification before completion

**What:** Run the actual thing (start the app, fire the request, exercise the feature) before claiming "done." Tests passing is necessary but not sufficient — they verify code correctness, not feature correctness. The `superpowers:verification-before-completion` skill and the `verify` command structure this.
**When to apply:** Before any "this is done" / "ready to merge" / "go ahead and ship" claim. Especially for UI changes, scripts/Makefile/dev-tooling changes, and anything that touches a live service.
**Why it works:** Structural tests catch source-text invariants; they don't catch host-side state, configuration mismatches, missing env vars, broken adapters, or "works on my machine" deltas. The user's memory entry `feedback-verify-end-to-end-not-just-tests` documents this exact failure mode.
**Skip-signature:** Agent claims "ready to merge" or "all done" without a transcript entry showing the actual command being run and its output observed. Particularly for UI features (no screenshot or browser interaction visible) and for scripts (no execution against real services).

---

## Code review + security review cycle before merging

**What:** Before merging to main, run `/code-review` (uses `feature-dev:code-reviewer` for correctness bugs) and `/security-review` (the security-review skill for vulnerabilities). Fix anything above Low. Iterate until clean. Then merge if low-risk.
**When to apply:** Every non-trivial code-change PR. Especially anything touching auth, secrets, file I/O paths, or external network calls.
**Why it works:** Two different lenses catch different bug classes — correctness bugs are obvious to a correctness reviewer and invisible to a security reviewer (and vice versa). Running both before merge is cheaper than fixing the regression in production. The user's `feedback-iterate-and-merge-low-risk` memory codifies this loop.
**Skip-signature:** PR opened and merged in the same session without any `Skill` invocation for `code-review` or `security-review`, AND without any explicit "I reviewed it" annotation. Particularly: code-change PRs (not data/docs) that merge to main with zero review turns.

---

## Iterate-and-merge with auto-merge on low-risk

**What:** After the review cycle is clean and the change is genuinely low-risk (small surface, no migrations, no production-data implications), merge directly — don't punt to "user, please review." Documented in `feedback-iterate-and-merge-low-risk`.
**When to apply:** Reviewed, all-tests-passing, low-risk PRs in personal/maintainer-controlled repos. Skip for: schema migrations, anything touching production data, anything where the user has signaled they want to inspect.
**Why it works:** Manual approval as a default for low-risk reviewed changes is friction without proportional safety. The user has signaled (via the memory) that auto-merge on clean reviews is the preferred pattern. Holding things at "ready for your approval" delays value without reducing risk.
**Skip-signature:** Reviewed-clean PRs sitting OPEN for >24 hours with no further activity. Especially: PRs where the dispatched agent posted "Proceeding to merge per the iterate-and-merge protocol" but never ran `gh pr merge` — the `feedback-agent-stops-at-review-pattern` failure mode.

---

## Systematic debugging (over jumping to solutions)

**What:** Before proposing a fix, characterize the bug systematically — reproduce, narrow the failure, identify the smallest input that triggers it, hypothesize a root cause, test the hypothesis. The `superpowers:systematic-debugging` skill structures this.
**When to apply:** Any unexpected behavior, test failure, or "this used to work." Especially: intermittent bugs, "works locally but fails in CI" bugs, and bugs where the first guess didn't fix it.
**Why it works:** Solution-jumping costs you the chance to actually find the cause. The fix that "seems to work" because you added defensive code often masks the real bug, which resurfaces elsewhere later. Systematic narrowing lands on the root, not a symptom.
**Skip-signature:** Bug report → immediate Edit of suspected file → claim of fix, without any reproduction step, log inspection, or test that would actually fail before the fix and pass after. Particularly when the same bug class returns in a different surface within weeks.

---

## Skill invocation as a discipline

**What:** When a skill matches a task — invoke it. The `Skill` tool loads guidance specific to that workflow (brainstorming, TDD, debugging, plans, reviews, etc.). The using-superpowers skill itself is the rule: "if you think there is even a 1% chance a skill might apply, invoke it."
**When to apply:** Before answering or acting on any task that has a matching skill. The skill manifest is loaded into context at session start; check it before defaulting to ad-hoc work.
**Why it works:** Skills encode patterns that have been tuned over many sessions — the right discipline at the right moment. Ad-hoc work re-invents process every time, with worse results.
**Skip-signature:** A whole multi-hour coding session with zero `Skill` invocations for `superpowers:*` skills, despite the work being clearly skill-shaped (features built without brainstorming, code written without TDD, claims of done without verification).
