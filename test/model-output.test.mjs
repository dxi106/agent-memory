// SOU-40 — the model-output boundary.
//
// On 2026-08-07 a coach run spent 84,638 input tokens, produced seven
// well-formed recommendations, hit max_tokens exactly (out=4096 = the cap),
// was cut mid-string, failed to parse, wrote nothing, and exited 0 with an
// empty stderr. Every test below pins one of the two behaviours that made
// that silent: a truncated response that looked fine, and a parse failure
// that was indistinguishable from "the model had nothing to say".
//
// Each test names the mutation it kills.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  ModelOutputError,
  isTruncated,
  assertNotTruncated,
  parseModelJson,
} from "../lib/model-output.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUNCATED_FIXTURE = join(HERE, "fixtures", "coach-truncated-response.txt");

// ------ isTruncated ------

// KILLS: removing the `stop_reason === "max_tokens"` branch. The API's own
// signal is the authoritative one; without it we would rely purely on a token
// count that a proxy or a future SDK need not report.
test("isTruncated is true when the API says stop_reason=max_tokens", () => {
  const response = { stop_reason: "max_tokens", usage: { output_tokens: 10 } };
  assert.equal(isTruncated(response, 4096), true);
});

// KILLS: removing the `output_tokens >= maxTokens` branch. This is the exact
// signature of the 2026-08-07 run — out=4096 against a 4096 cap — and it is
// what we can still see when stop_reason is absent.
test("isTruncated is true when output_tokens reaches the cap with no stop_reason", () => {
  const response = { usage: { output_tokens: 4096 } };
  assert.equal(isTruncated(response, 4096), true);
});

// KILLS: `return true` — a detector that flags everything proves nothing.
// This is the negative control for the two tests above.
test("isTruncated is false for an ordinary completed response", () => {
  const response = { stop_reason: "end_turn", usage: { output_tokens: 50 } };
  assert.equal(isTruncated(response, 4096), false);
});

// KILLS: treating a response with no usage block as truncated, which would
// break every existing stub client in this suite.
test("isTruncated is false when the response carries no usage or stop_reason", () => {
  assert.equal(isTruncated({ content: [] }, 4096), false);
  assert.equal(isTruncated(null, 4096), false);
});

// KILLS: deleting assertNotTruncated's throw (making it a silent predicate).
test("assertNotTruncated throws a ModelOutputError naming the cap", () => {
  assert.throws(
    () => assertNotTruncated({ stop_reason: "max_tokens", usage: { output_tokens: 4096 } }, 4096, "coaching"),
    (e) => e instanceof ModelOutputError && e.kind === "truncated" && /4096/.test(e.message),
  );
});

// KILLS: making assertNotTruncated throw unconditionally.
test("assertNotTruncated is a no-op for a completed response", () => {
  assert.doesNotThrow(() =>
    assertNotTruncated({ stop_reason: "end_turn", usage: { output_tokens: 50 } }, 4096, "coaching"),
  );
});

// ------ parseModelJson ------

// KILLS: restoring `return null` in either catch block of the old
// tryParseJson. That bare null is what let 84k tokens of input produce
// "wrote 0 recommendation(s)" and exit 0.
test("parseModelJson throws instead of returning null when the output cannot be parsed", () => {
  assert.throws(
    () => parseModelJson("not json at all", "coaching"),
    (e) => e instanceof ModelOutputError && e.kind === "unparseable",
  );
});

// KILLS: `if (!raw) return null`. An empty response to a paid call is a
// failed run, not an empty result.
test("parseModelJson throws on an empty or blank response", () => {
  assert.throws(() => parseModelJson("", "coaching"), ModelOutputError);
  assert.throws(() => parseModelJson("   \n  ", "coaching"), ModelOutputError);
  assert.throws(() => parseModelJson(null, "coaching"), ModelOutputError);
});

// KILLS: conflating the two outcomes in the other direction — making
// parseModelJson throw when the model legitimately had nothing to say.
// Valid JSON with zero items is a SUCCESS.
test("parseModelJson returns valid JSON that contains zero items", () => {
  const parsed = parseModelJson(JSON.stringify({ recommendations: [] }), "coaching");
  assert.deepEqual(parsed, { recommendations: [] });
});

// KILLS: dropping the code-fence strip, which the model emits despite the
// prompt asking it not to.
test("parseModelJson strips a ```json code fence", () => {
  const raw = "```json\n" + JSON.stringify({ candidates: [{ id: "a" }] }) + "\n```";
  assert.deepEqual(parseModelJson(raw, "reflection"), { candidates: [{ id: "a" }] });
});

// KILLS: dropping the greedy {...} fallback, which recovers output the model
// prefixed with prose.
test("parseModelJson recovers a JSON object embedded in surrounding prose", () => {
  const raw = "Here is what I found:\n" + JSON.stringify({ recommendations: [] }) + "\nHope that helps.";
  assert.deepEqual(parseModelJson(raw, "coaching"), { recommendations: [] });
});

// KILLS: any change that lets the real 2026-08-07 truncation shape parse as
// an empty result. The fixture is byte-for-byte the failure geometry of that
// run: six complete recommendations, a seventh cut mid-string, wrapped in a
// fence. Direct parse, fence-stripped parse and the greedy fallback all fail
// on it — exactly as they did on the live payload.
test("parseModelJson rejects the truncated-mid-recommendation payload shape that caused SOU-40", async () => {
  const raw = await readFile(TRUNCATED_FIXTURE, "utf8");
  // Sanity: the payload really does contain complete recommendations that the
  // old code threw away. If this ever stops holding, the fixture is stale.
  assert.equal([...raw.matchAll(/"id":\s*"([^"]+)"/g)].length, 7);
  assert.throws(
    () => parseModelJson(raw, "coaching"),
    (e) => e instanceof ModelOutputError && e.kind === "unparseable",
  );
});

// KILLS: lowering the default back to 4096, the cap the 2026-08-07 run hit
// exactly.
test("DEFAULT_MAX_OUTPUT_TOKENS leaves real headroom above the cap that truncated SOU-40", () => {
  assert.ok(
    DEFAULT_MAX_OUTPUT_TOKENS > 4096,
    `expected more than the 4096 cap that truncated the 2026-08-07 run, got ${DEFAULT_MAX_OUTPUT_TOKENS}`,
  );
});
