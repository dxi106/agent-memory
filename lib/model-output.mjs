/**
 * The boundary where a model's response becomes our data — SOU-40.
 *
 * Both the coaching pass and the reflection pass previously carried their own
 * copy of a `tryParseJson` that returned `null` on failure, and their own
 * hardcoded `max_tokens: 4096`. Together those two facts produced a run that
 * spent 84,638 input tokens, generated seven complete recommendations, was cut
 * off mid-string at exactly the 4096-token output cap, failed to parse, wrote
 * nothing, and exited 0 with an empty stderr.
 *
 * The rule this module exists to enforce: **"the model had nothing to say" and
 * "we could not read what it said" are different outcomes.** The first is a
 * quiet success. The second is a failed run and must be loud.
 */

import { flattenField } from "./lesson.mjs";

/** Output budget for a pass. The old 4096 was the cap SOU-40 hit exactly. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/** At most this many rejected ids are named; the rest are counted. */
const MAX_REJECTED_LISTED = 10;

/**
 * Render rejected item ids for a log line or an error message.
 *
 * These strings are model-controlled, and they are captured PRECISELY in the
 * case where the id failed validation — so they can carry newlines, code
 * fences and arbitrary length. Both sinks are line-oriented: a markdown `- `
 * item, and stderr, which launchd routes to a world-readable file. A raw
 * newline plus a fence is enough to forge a `## Raw model output` section
 * ahead of the real one. `flattenField` is this repo's existing answer to that
 * hazard, already applied at seven other sites.
 */
export function describeRejected(ids = []) {
  const shown = ids
    .slice(0, MAX_REJECTED_LISTED)
    // flattenField collapses the newlines, which is what actually defeats the
    // forgery — a fence cannot open a block mid-line. The markup characters go
    // too, because a valid id is `[A-Za-z0-9_-]+` and these are precisely the
    // strings that failed that test: there is nothing of value to preserve,
    // and the full payload is in the run log regardless.
    .map((id) => flattenField(id, 60).replace(/[`#<>]/g, ""));
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ");
}

export class ModelOutputError extends Error {
  /**
   * Deliberately carries NO copy of the model's output. An own enumerable
   * property holding the payload is serialized by `console.error(err)`,
   * `util.inspect(err)` and `JSON.stringify(err)` alike — one future logger
   * away from dumping transcript-derived text into a world-readable launchd
   * log. Every caller already has the raw output in scope and writes it to the
   * run log, which is where it belongs.
   *
   * @param {string} message
   * @param {{kind?: "truncated"|"unparseable"|"unaccounted"}} [opts]
   */
  constructor(message, { kind } = {}) {
    super(message);
    this.name = "ModelOutputError";
    this.kind = kind;
  }
}

/**
 * Did the model run out of output budget mid-answer?
 *
 * Two signals, because either can be missing:
 *   - `stop_reason === "max_tokens"` is the API's own statement, and is
 *     authoritative when present.
 *   - `output_tokens >= maxTokens` is what remains visible when it isn't —
 *     and it is the signature actually observed on 2026-08-07 (out=4096
 *     against a 4096 cap).
 *
 * A response carrying neither is treated as complete, so stub clients that
 * report no usage keep working.
 *
 * The token count is a FALLBACK, not a second opinion: when the API has stated
 * a non-truncating reason, that statement wins. Otherwise a finished answer
 * that happened to land exactly on the budget would be rejected as truncated
 * and the whole run would fail — a good run destroyed by the guard meant to
 * protect it.
 */
const COMPLETE_STOP_REASONS = new Set(["end_turn", "stop_sequence", "tool_use", "pause_turn"]);

export function isTruncated(response, maxTokens) {
  if (!response || typeof response !== "object") return false;
  if (response.stop_reason === "max_tokens") return true;
  if (COMPLETE_STOP_REASONS.has(response.stop_reason)) return false;
  const out = response.usage?.output_tokens;
  return Number.isFinite(out) && Number.isFinite(maxTokens) && out >= maxTokens;
}

/**
 * Throw unless the response completed. Callers pass the SAME `max_tokens`
 * they put on the request (`req.max_tokens`) so the check and the budget can
 * never drift apart.
 */
export function assertNotTruncated(response, maxTokens, label = "model") {
  if (!isTruncated(response, maxTokens)) return;
  const out = response?.usage?.output_tokens ?? "unknown";
  throw new ModelOutputError(
    `${label}: the model's response was truncated at the ${maxTokens}-token output cap ` +
    `(stop_reason=${response?.stop_reason ?? "unset"}, output_tokens=${out}). ` +
    `A truncated response is a failed run — nothing was written. ` +
    `Raise ${label}.max_output_tokens in config.json, or narrow the prompt.`,
    { kind: "truncated" },
  );
}

/**
 * Parse a model's JSON answer, or throw.
 *
 * Tolerates the two shapes the model actually emits despite instructions: a
 * ```json code fence, and a JSON object surrounded by prose. What it will not
 * do is report success for input it could not read — that conflation is the
 * whole of SOU-40.
 *
 * @returns {object} the parsed object (which may legitimately be empty)
 * @throws {ModelOutputError} kind "unparseable"
 */
export function parseModelJson(raw, label = "model") {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ModelOutputError(
      `${label}: the model returned no text output. Nothing was written.`,
      { kind: "unparseable" },
    );
  }

  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed;
  let failedAt;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    // Position only. V8 quotes the first ~10 characters of the input verbatim
    // in its own message, and that message travels to stderr — under launchd,
    // into world-readable /tmp. The payload is preserved in the run log; it
    // must not also be echoed into an error string.
    failedAt = /position (\d+)/.exec(e.message)?.[1];
    // Last-ditch: the span from the first `{` to the last `}`, pulling the
    // object out of surrounding prose. A linear scan rather than a greedy
    // /\{[\s\S]*\}/ — identical span, but the regex backtracked quadratically
    // on unbalanced input (measured 6.5s at 128KB of open braces).
    const open = stripped.indexOf("{");
    const close = stripped.lastIndexOf("}");
    if (open !== -1 && close > open) {
      try {
        parsed = JSON.parse(stripped.slice(open, close + 1));
      } catch {
        parsed = undefined;
      }
    }
  }

  // A bare scalar ("42", "null", a quoted string) parses but is not an answer
  // we can read fields off — it would silently degrade to "zero items".
  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    throw new ModelOutputError(
      `${label}: could not parse the model's output as a JSON object` +
      (failedAt ? ` (invalid JSON at character ${failedAt} of ${stripped.length})` : "") +
      `. Nothing was written — the raw response is preserved in the run log.`,
      { kind: "unparseable" },
    );
  }
  return parsed;
}
