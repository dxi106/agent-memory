// Normalization logic for Claude Code hook payloads → canonical signals.
// Pure functions, unit-tested. The adapter scripts in adapters/claude-code/
// are thin stdin/stdout wrappers around these.

// Tightened to favor precision: weak tokens ("no", "works", "wait") only count
// in clearly corrective/affirmative contexts, not as incidental words.
const CORRECTION_RE =
  /(^\s*(no|nope|stop)\b)|\b(don'?t|do not|wrong|incorrect|undo|revert|instead|you missed|that'?s not|that is not|not what i)\b/i;
const PRAISE_RE =
  /\b(perfect|exactly|awesome|nailed it|love it|thank you|thanks)\b|works (great|perfectly)|that'?s (it|right|perfect)|nice (job|work)|looks good/i;

export function classifyPrompt(text) {
  if (!text || typeof text !== "string") return null;
  if (CORRECTION_RE.test(text)) return "correction";
  if (PRAISE_RE.test(text)) return "praise";
  return null;
}

function truncate(s, n = 200) {
  const t = (s || "").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

export function signalFromUserPromptSubmit(payload) {
  const type = classifyPrompt(payload?.prompt);
  if (!type) return null;
  return {
    host: "claude-code",
    type,
    session_id: payload.session_id,
    cwd: payload.cwd,
    summary: truncate(payload.prompt),
  };
}

function callKey(payload) {
  return `${payload?.tool_name}:${JSON.stringify(payload?.tool_input ?? {})}`;
}

export function detectRetry(payload, priorState = {}) {
  const key = callKey(payload);
  if (priorState.lastKey === key) {
    return {
      signal: {
        host: "claude-code",
        type: "retry",
        session_id: payload.session_id,
        cwd: payload.cwd,
        tool: payload.tool_name,
        summary: `repeated ${payload.tool_name} call`,
      },
      state: { lastKey: key },
    };
  }
  return { signal: null, state: { lastKey: key } };
}
