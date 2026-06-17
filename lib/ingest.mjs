import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { appendSignal, readSignalsSince } from "./signals.mjs";
import { paths } from "./paths.mjs";
import { classifyPrompt } from "./adapters/claude-code.mjs";

const MAX_SUMMARY = 200;

// Synthetic prompts that look like user input in the transcript but are
// actually injected by Claude Code / skill loaders / slash commands.
// Treating them as user signals produces noise that swamps real
// corrections (the trigger words in classifyPrompt frequently appear
// incidentally in these payloads).
//
// Each regex matches the START of the prompt text, after trim. Skill
// manifests and command caveats arrive verbatim with these prefixes.
const SYNTHETIC_PROMPT_PATTERNS = [
  /^<task-notification\b/i,
  /^<local-command-caveat\b/i,
  /^<command-name\b/i,
  /^<command-message\b/i,
  /^<command-args\b/i,
  /^<system-reminder\b/i,
  /^<bash-(input|stdout|stderr)\b/i,
  /^Base directory for this skill:/i,
  // Slash-command paste pattern: long preamble starting "You are a
  // senior <role>". We're not the harness; an actual user pasting this
  // is rare enough that the noise it generates isn't worth the catch.
  /^You are a (senior|principal|staff)\s+\w+/i,
];

function isSyntheticPrompt(text) {
  const head = (text || "").trimStart().slice(0, 200);
  return SYNTHETIC_PROMPT_PATTERNS.some((re) => re.test(head));
}

export function parseTranscriptLine(line) {
  if (!line || typeof line !== "string") return null;
  const s = line.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Stable hash for deduping signals across capture paths (hook + ingest).
 * Built from (session_id, ts, summary) — those uniquely identify a
 * user turn or tool call. host is intentionally excluded so the same
 * conceptual event captured by two paths collapses to one key.
 *
 * Fields are joined with a printable "|" delimiter so degenerate boundary
 * cases ({sid:"ab", ts:"c"} vs {sid:"a", ts:"bc"}) can't collide.
 */
export function signalKey(signal) {
  const sid = signal.session_id || "";
  const ts = signal.ts || "";
  const summary = (signal.summary || "").trim();
  return createHash("sha1")
    .update(`${sid}|${ts}|${summary}`)
    .digest("hex");
}

function truncate(text) {
  const t = (text || "").trim();
  return t.length <= MAX_SUMMARY ? t : t.slice(0, MAX_SUMMARY - 1) + "…";
}

function userPromptText(event) {
  const content = event?.message?.content;
  if (!content) return null;
  if (typeof content === "string") return content;
  // Claude Code's user content can be an array of blocks. Tool results show
  // up here too — skip them; only treat actual text blocks as prompts.
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    return text || null;
  }
  return null;
}

function assistantToolCalls(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === "tool_use");
}

function cutoffMs(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.getTime();
}

function eventTsMs(ev) {
  const ts = ev?.timestamp;
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Scan Claude Code transcripts under projectsDir, extract correction +
 * retry signals heuristically, dedupe against existing signals (both
 * the live hook path and prior ingest runs), and append the new ones.
 *
 * Returns { count, scannedFiles }.
 */
export async function ingestClaudeCodeTranscripts({ home, projectsDir, since = 7 }) {
  const sigDir = paths(home).signals;
  let scannedFiles = 0;
  let written = 0;

  // Bail cleanly if the projects dir doesn't exist (e.g. a fresh Mac).
  let projectDirs;
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return { count: 0, scannedFiles: 0 };
  }

  // Dedup set seeded from existing signals.
  const existingSignals = await readSignalsSince(sigDir, Math.max(since, 1));
  const seen = new Set(existingSignals.map(signalKey));

  const cutoff = cutoffMs(since);

  for (const proj of projectDirs) {
    const projPath = join(projectsDir, proj);
    let st;
    try {
      st = await stat(projPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let files;
    try {
      files = await readdir(projPath);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(projPath, f);
      let fst;
      try {
        fst = await stat(full);
      } catch {
        continue;
      }
      // Skip files whose mtime is older than the window — fast path so
      // we don't open ancient session logs to find every line is too old.
      if (fst.mtimeMs < cutoff) continue;
      scannedFiles += 1;

      const text = await readFile(full, "utf8");
      const lines = text.split("\n");
      const sessionRetryState = new Map(); // sessionId -> { lastKey }

      for (const line of lines) {
        const ev = parseTranscriptLine(line);
        if (!ev) continue;
        if (eventTsMs(ev) < cutoff) continue;

        // ---- correction / praise from user prompts -------------------
        if (ev.type === "user") {
          const promptText = userPromptText(ev);
          if (!promptText) continue;
          if (isSyntheticPrompt(promptText)) continue;
          const sigType = classifyPrompt(promptText);
          if (!sigType) continue;

          const sig = {
            ts: ev.timestamp || new Date().toISOString(),
            host: "claude-code",
            type: sigType,
            session_id: ev.sessionId,
            cwd: ev.cwd,
            summary: truncate(promptText),
            source: "ingest",
          };
          const key = signalKey(sig);
          if (seen.has(key)) continue;
          seen.add(key);
          await appendSignal(sigDir, sig);
          written += 1;
          continue;
        }

        // ---- retry from consecutive identical tool calls -------------
        if (ev.type === "assistant") {
          const calls = assistantToolCalls(ev);
          if (calls.length === 0) continue;
          const sid = ev.sessionId || "_";
          const state = sessionRetryState.get(sid) || { lastKey: null };

          for (const call of calls) {
            const callKey = `${call.name}:${JSON.stringify(call.input ?? {})}`;
            if (state.lastKey === callKey) {
              const sig = {
                ts: ev.timestamp || new Date().toISOString(),
                host: "claude-code",
                type: "retry",
                session_id: ev.sessionId,
                cwd: ev.cwd,
                tool: call.name,
                summary: `repeated ${call.name} call`,
                source: "ingest",
              };
              const key = signalKey(sig);
              if (!seen.has(key)) {
                seen.add(key);
                await appendSignal(sigDir, sig);
                written += 1;
              }
            }
            state.lastKey = callKey;
          }
          sessionRetryState.set(sid, state);
        }
      }
    }
  }

  return { count: written, scannedFiles };
}
