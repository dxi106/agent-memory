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

// --- Review round 1 -------------------------------------------------------
// Three findings from the code/security/Codex reviews of b8cc53a. Each test
// below pins the fix and names the mutation that would undo it.

// KILLS: dropping the `stop_reason` completeness check from isTruncated, so the
// `output_tokens >= cap` fallback fires even when the API has explicitly said
// the response ENDED. A model whose finished answer lands exactly on the budget
// would then be rejected as truncated and the whole run would hard-fail —
// turning a good run into a failed one. (Codex review, P2.)
test("isTruncated trusts an explicit non-truncating stop_reason at the exact cap", () => {
  for (const reason of ["end_turn", "stop_sequence", "tool_use"]) {
    assert.equal(
      isTruncated({ stop_reason: reason, usage: { output_tokens: 4096 } }, 4096),
      false,
      `stop_reason=${reason} says the model finished; the token count must not override it`,
    );
  }
});

// KILLS: making the above so permissive that the fallback stops working. The
// fallback exists for responses that carry NO stop_reason, which is the shape
// the 2026-08-07 payload presented. This is the paired control.
test("isTruncated still catches a cap-length response that carries no stop_reason", () => {
  assert.equal(isTruncated({ usage: { output_tokens: 4096 } }, 4096), true);
  assert.equal(isTruncated({ stop_reason: null, usage: { output_tokens: 4096 } }, 4096), true);
});

// KILLS: interpolating V8's JSON.parse error into the thrown message. V8 quotes
// the first ~10 characters of the input VERBATIM when the parse fails at
// position 0 — the common case, where the model emitted prose. That message now
// reaches stderr and, under launchd, /tmp/agentmem.coach.err.log (mode 0644 in a
// world-readable directory). The raw output belongs in the run log, not there.
// (Security review, LOW-blocking under the data-exposure carve-out.)
test("parseModelJson does not echo the model's own text into the thrown message", () => {
  const private_ = "Ada Lovelace's transcript: ada@example.com said the quiet part";
  assert.throws(
    () => parseModelJson(private_, "coaching"),
    (e) => {
      assert.ok(
        !/Ada|Lovelace|example\.com|quiet part/.test(e.message),
        `the model's text leaked into the message: ${e.message}`,
      );
      return e instanceof ModelOutputError && e.kind === "unparseable";
    },
  );
});

// KILLS: re-attaching the raw payload to the error object. `raw` was an own
// enumerable property holding up to ~64KB of transcript-derived text, which
// console.error(err) / util.inspect(err) / JSON.stringify(err) all serialize.
// No consumer ever read it. (Security review — latent, not live, but the fix is
// a deletion.)
test("a ModelOutputError does not carry the raw payload on the error object", async () => {
  const { inspect } = await import("node:util");
  const private_ = "PRIVATE-TRANSCRIPT-MARKER not json at all";
  let err;
  try {
    parseModelJson(private_, "coaching");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected a throw");
  assert.ok(!("raw" in err), "the error must not retain the payload");
  assert.ok(!inspect(err).includes("PRIVATE-TRANSCRIPT-MARKER"), "inspect() leaked the payload");
  assert.ok(!JSON.stringify(err).includes("PRIVATE-TRANSCRIPT-MARKER"), "JSON leaked the payload");
});

// KILLS: replacing the linear first-`{`..last-`}` slice with something that
// changes which span is recovered. This pins the SEMANTICS the greedy regex had,
// so the swap to a linear scan (which removes its quadratic backtracking on
// unbalanced input) is provably behaviour-preserving.
test("parseModelJson recovers the span from the first brace to the last", () => {
  const parsed = parseModelJson('preamble {"a": {"b": 1}} trailer', "coaching");
  assert.deepEqual(parsed, { a: { b: 1 } });
});

// KILLS: the pathological input for the old greedy regex — many opening braces
// and no closing one, which backtracked quadratically (measured 6.5s at 128KB).
// A linear scan bails immediately. The assertion is on the OUTCOME, not the
// clock, so it is not timing-flaky.
test("parseModelJson rejects a large unbalanced payload instead of chewing on it", () => {
  const pathological = "{".repeat(50_000);
  assert.throws(
    () => parseModelJson(pathological, "coaching"),
    (e) => e instanceof ModelOutputError && e.kind === "unparseable",
  );
});

// --- Review round 2 -------------------------------------------------------

// KILLS: accepting a top-level JSON array. `typeof [] === "object"`, so the
// scalar guard above waves an array straight through; both passes then read a
// missing `recommendations` / `candidates` key as an empty list and exit 0.
// That is SOU-40's exact signature, and the accounted-for guard CANNOT catch
// it, because `proposed` is 0 and the guard's own precondition is false.
// Confirmed by execution before this test was written: a two-recommendation
// array produced { recs: 0, proposed: 0, rejected: [] }. (Codex round 2.)
test("parseModelJson rejects a top-level array, which would read as zero items", () => {
  for (const raw of ['[{"id": "a"}, {"id": "b"}]', "[]"]) {
    assert.throws(
      () => parseModelJson(raw, "coaching"),
      (e) => e instanceof ModelOutputError && e.kind === "unparseable",
      `a top-level array must not be read as an answer: ${raw}`,
    );
  }
});

// KILLS: over-tightening the check above into "reject anything unusual". A
// plain object is the contract, and an object whose list is legitimately empty
// stays a quiet success. The paired control.
test("parseModelJson still accepts an ordinary object", () => {
  assert.deepEqual(parseModelJson('{"recommendations": []}', "coaching"), { recommendations: [] });
});

// KILLS: listing "pause_turn" as a completed stop_reason. Anthropic classifies
// it as INCOMPLETE — the server-tool loop hit its iteration limit, the model did
// not finish. Treating it as complete suppresses the fallback. Dormant today
// (neither pass sends `tools`), which is exactly why it needs a test: it goes
// live the moment anyone adds one.
test("isTruncated does not accept pause_turn as a finished response", () => {
  assert.equal(isTruncated({ stop_reason: "pause_turn", usage: { output_tokens: 4096 } }, 4096), true);
});

// KILLS: failing to treat a context-window overflow as truncation. It is a
// distinct stop_reason from max_tokens and means the same thing for us: the
// answer is cut off and the run must not be reported as a success.
test("isTruncated treats a context-window overflow as truncation", () => {
  assert.equal(
    isTruncated({ stop_reason: "model_context_window_exceeded", usage: { output_tokens: 10 } }, 4096),
    true,
  );
});

// KILLS: reporting nothing when V8 gives no position. Measured on node v24.7.0:
// a parse that fails at position 0 — the common case, where the model emitted
// prose — produces "Unexpected token 'D', \"Dan Iacono\"... is not valid JSON",
// which carries NO position. Dropping V8's message to stop it echoing the
// model's text (round 1) therefore silently removed the diagnostic exactly
// where an operator most needs one. The size is leak-free and always available.
test("parseModelJson reports the size of what it could not read when V8 gives no position", () => {
  const prose = "I could not comply with that request.";
  assert.throws(
    () => parseModelJson(prose, "coaching"),
    (e) => {
      assert.match(e.message, new RegExp(`${prose.length} characters`), `no size reported: ${e.message}`);
      assert.ok(!/could not comply/.test(e.message), `leaked the model's text: ${e.message}`);
      return true;
    },
  );
});
