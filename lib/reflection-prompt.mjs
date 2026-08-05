// Reflection prompt template (versioned in lib/ per the spec).
//
// Layered for caching: a frozen system preamble + (stable) existing lessons
// + (stable) knowledge base sit before any per-run signals, with the last
// block carrying an ephemeral cache_control breakpoint. New signals go
// into the user turn so they don't invalidate the cached prefix.
//
// See lib/reflect.mjs::buildReflectionRequest for assembly.

export const REFLECTION_PROMPT_VERSION = "2026-08-05.v2";

/**
 * Build the system preamble for a reflection run.
 *
 * `maxCandidates` is stated in the prompt so the model ranks and self-limits
 * instead of returning a long list that the caller silently truncates. It is
 * NOT the enforcement point — runReflection caps writes regardless of what
 * comes back. Keep the two in agreement; a test asserts they match.
 *
 * The value is a stable config setting, not a per-run one, so varying it does
 * not churn the cached prefix in practice.
 */
export function reflectionSystemPreamble(maxCandidates) {
  return `You are the reflection pass of agentmem — a per-user memory layer for AI coding agents.

Your job: read recent SIGNALS (user corrections, praise, retries) plus EXISTING LESSONS, and propose new candidate lessons or re-score the existing ones.

The bar for a new candidate is HIGH. Every one you propose costs a human a triage decision, so propose the few that would genuinely change future behaviour — not everything that could be written down.

Rules:
- Output strict JSON ONLY. No prose, no markdown. Schema below.
- Return AT MOST ${maxCandidates} candidates, strongest first. Fewer is better; an empty list is a good answer on a quiet day.
- A new candidate needs a PATTERN, not an incident: either two or more signals pointing the same way, or one unambiguous correction whose lesson clearly generalises beyond the moment it happened.
- Do NOT propose a candidate that restates an EXISTING LESSON, narrows one to a special case, or rephrases another candidate in this same response. If the point is already covered, use "rescore" instead.
- A rule that could only ever apply to the exact situation that produced it is not a lesson. Skip it.
- Prefer general, reusable rules over restating a specific event.
- IDs must match /^[A-Za-z0-9_-]+$/ and follow the format "YYYY-MM-DD-<short-slug>".
- Categories: "behavioral" (how to collaborate), "code" (codebase-specific), "workflow" (tool/process).
- scope is an array of repo-name strings or ["*"] for global.
- Re-score only lessons present in EXISTING LESSONS — never invent ids.
- "confirm" = signals corroborate this lesson (bump confidence).
- "contradict" = signals contradict this lesson (drop confidence).
- If nothing is worth proposing, return empty arrays.

Output schema:
{
  "candidates": [
    {
      "id": "YYYY-MM-DD-short-slug",
      "title": "short imperative",
      "category": "behavioral" | "code" | "workflow",
      "rule": "**Rule:** one or two sentences.",
      "why": "**Why:** one sentence of evidence drawn from the signals.",
      "scope": ["*"] | ["repo-name", ...]
    }
  ],
  "rescore": [
    { "id": "existing-lesson-id", "delta": "confirm" | "contradict" }
  ]
}`;
}

export const REFLECTION_USER_PROMPT = `Given the recent signals below, propose candidate lessons and rescore existing ones per the schema. Return only the strongest few. JSON only.`;
