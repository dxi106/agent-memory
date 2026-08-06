#!/usr/bin/env node
import { readStdin, parseEvent, runAdapter } from "../../lib/adapters/runtime.mjs";
import { resolveHome } from "../../lib/storage.mjs";
import { selectForInjection } from "../../lib/commands.mjs";
import { getPendingRecommendations } from "../../lib/coach.mjs";
import {
  readDigestFile,
  readDeliveredDate,
  markDelivered,
  wrapUntrusted,
} from "../../lib/digest.mjs";

// SessionStart hook for Claude Code (SOU-13 + SOU-19 Part B).
//
// Three contributions, joined into one `additionalContext` string:
//   1. Top scoped lessons (from agentmem's lesson store) — the model uses
//      these as background context for the session.
//   2. A one-line hint when there are pending coaching tips for this repo,
//      pointing the model at the MCP tool `get_coaching_tips`.
//   3. Today's action digest (SOU-30), at most once per day — the pending
//      candidates to triage. Delivered here so the queue arrives instead of
//      being somewhere you have to remember to visit.
//
// This adapter makes no network and no model call, and must not start: it runs
// on EVERY session start. `test/adapters-session-start.test.mjs` pins that by
// running the hook with a throwing `fetch` installed.
//
// The framing on the tip line is non-negotiable: tips are REACTIVE — call
// the tool only when the user actually does the pattern a tip warns about
// during the session. NEVER as a session opener. This is what stops the
// "agent immediately lectures you with backlogged tips" failure mode.

function buildTipHint(count) {
  // The exact phrasing matters — the test asserts it, and changing it would
  // also change the model's behaviour in production.
  return [
    `You have ${count} pending coaching tip${count === 1 ? "" : "s"} for this repo. The MCP tool \`get_coaching_tips(scope, limit)\` will return them — call it ONLY when the user has done one of the patterns the tips warn about during this session, NEVER as a session opener.`,
  ].join("\n");
}

// Set inside the adapter body only when the digest actually made it into the
// payload, and consumed by onDelivered *after* the bytes have flushed. The
// stamp must never be written on a path the user did not see: runAdapter
// swallows throws, so a stamp taken earlier would burn the day in silence.
let stampDelivery = null;

await runAdapter(async () => {
  const event = parseEvent(await readStdin());
  const cwd = event.cwd || process.cwd();
  const home = resolveHome();

  const lessons = await selectForInjection(home, cwd, 12);
  const pending = await getPendingRecommendations(home, cwd);

  const today = new Date().toISOString().slice(0, 10);
  const digest =
    (await readDeliveredDate(home)) === today ? null : await readDigestFile(home, today);

  const parts = [];
  if (lessons.length > 0) {
    const text = lessons
      .map((l) => `- ${l.meta.title}: ${l.body.replace(/\s+/g, " ").trim()}`)
      .join("\n");
    parts.push(`Accumulated lessons for this repo (via agentmem):\n${text}`);
  }
  if (pending.length > 0) {
    parts.push(buildTipHint(pending.length));
  }
  if (digest) {
    // Wrapped, not spliced: the digest carries model-proposed titles derived
    // from GitHub review comments and transcripts. See wrapUntrusted.
    parts.push(wrapUntrusted(digest));
    stampDelivery = () => markDelivered(resolveHome(), today);
  }

  if (parts.length === 0) return { continue: true };

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: parts.join("\n\n"),
    },
  };
}, { continue: true }, () => stampDelivery?.());
