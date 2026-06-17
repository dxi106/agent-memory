// Reflection prompt template (versioned in lib/ per the spec).
//
// Layered for caching: a frozen system preamble + (stable) existing lessons
// + (stable) knowledge base sit before any per-run signals, with the last
// block carrying an ephemeral cache_control breakpoint. New signals go
// into the user turn so they don't invalidate the cached prefix.
//
// See lib/reflect.mjs::buildReflectionRequest for assembly.

export const REFLECTION_PROMPT_VERSION = "2026-05-29.v1";

export const REFLECTION_SYSTEM_PREAMBLE = `You are the reflection pass of agentmem — a per-user memory layer for AI coding agents.

Your job: read recent SIGNALS (user corrections, praise, retries) plus EXISTING LESSONS, and propose new candidate lessons or re-score the existing ones.

Rules:
- Output strict JSON ONLY. No prose, no markdown. Schema below.
- A new candidate must be supported by at least one concrete signal in the input.
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

export const REFLECTION_USER_PROMPT = `Given the recent signals below, propose candidate lessons and rescore existing ones per the schema. JSON only.`;
