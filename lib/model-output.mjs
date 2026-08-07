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

/** Output budget for a pass. The old 4096 was the cap SOU-40 hit exactly. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

export class ModelOutputError extends Error {
  /**
   * @param {string} message
   * @param {{kind?: "truncated"|"unparseable"|"unaccounted", raw?: string}} [opts]
   */
  constructor(message, { kind, raw } = {}) {
    super(message);
    this.name = "ModelOutputError";
    this.kind = kind;
    this.raw = raw;
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
 */
export function isTruncated(response, maxTokens) {
  if (!response || typeof response !== "object") return false;
  if (response.stop_reason === "max_tokens") return true;
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
      { kind: "unparseable", raw: typeof raw === "string" ? raw : "" },
    );
  }

  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed;
  let firstError;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    firstError = e;
    // Last-ditch: pull the outermost {...} block out of surrounding prose.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
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
      (firstError ? ` (${firstError.message})` : "") +
      `. Nothing was written — the raw response is preserved in the run log.`,
      { kind: "unparseable", raw },
    );
  }
  return parsed;
}
