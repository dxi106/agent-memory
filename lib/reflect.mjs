import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  paths,
  loadConfig,
  listLessons,
  listCandidates,
  writeCandidate,
} from "./storage.mjs";
import { readSignalsSince } from "./signals.mjs";
import { serializeLesson } from "./lesson.mjs";
import {
  REFLECTION_PROMPT_VERSION,
  REFLECTION_SYSTEM_PREAMBLE,
  REFLECTION_USER_PROMPT,
} from "./reflection-prompt.mjs";
import { syncToObsidian } from "./obsidian.mjs";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const VALID_CATEGORIES = new Set(["behavioral", "code", "workflow"]);
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_LOOKBACK = 7;
const DEFAULT_MIN_SIGNALS = 3;
const CANDIDATE_CONFIDENCE = 0.35;

function timestampStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
}

function clamp(n, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, n));
}

async function loadKnowledgeBase(home) {
  const kdir = paths(home).knowledge;
  let files;
  try {
    files = await readdir(kdir);
  } catch {
    return "";
  }
  const out = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".md")) continue;
    const text = await readFile(join(kdir, f), "utf8");
    out.push(`## ${f}\n\n${text}`);
  }
  return out.join("\n\n");
}

function formatLessonsForPrompt(lessons) {
  if (lessons.length === 0) return "_(none)_";
  return lessons
    .map((l) => {
      const m = l.meta || {};
      const conf = (m.confidence ?? 0).toFixed(2);
      return `### ${m.id} — ${m.title} (${m.category}, ${conf})\n${(l.body || "").trim()}`;
    })
    .join("\n\n");
}

function formatSignalsForPrompt(signals) {
  if (signals.length === 0) return "_(none)_";
  // Keep it terse — a one-line summary per signal is enough for the model
  // to spot patterns without blowing up the input.
  return signals
    .map((s) => {
      const cwd = s.cwd ? ` cwd=${s.cwd}` : "";
      return `- [${s.ts}] ${s.type}${cwd}: ${(s.summary || "").trim()}`;
    })
    .join("\n");
}

/**
 * Assemble a Messages API request shaped for prompt caching:
 * - tools: none
 * - system: [preamble, existing lessons, knowledge base]  (stable; cached)
 * - messages: [user with recent signals]                  (volatile; per-run)
 *
 * The last system block carries an ephemeral cache_control marker so the
 * stable prefix (preamble + lessons + KB) gets cached across nightly runs.
 */
export async function buildReflectionRequest({ home, signals, model = DEFAULT_MODEL, lessons }) {
  const activeLessons = lessons || (await listLessons(home));
  const kb = await loadKnowledgeBase(home);

  const system = [
    { type: "text", text: REFLECTION_SYSTEM_PREAMBLE },
    {
      type: "text",
      text: `# EXISTING LESSONS\n\n${formatLessonsForPrompt(activeLessons)}`,
    },
    {
      type: "text",
      text: `# KNOWLEDGE BASE\n\n${kb || "_(none)_"}`,
      // ↓ Cache breakpoint sits on the LAST stable block, so the preamble +
      // lessons + KB are all cached together. Signals (volatile) go in messages.
      cache_control: { type: "ephemeral" },
    },
  ];

  const user = `${REFLECTION_USER_PROMPT}\n\n# RECENT SIGNALS\n\n${formatSignalsForPrompt(signals)}`;

  return {
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  };
}

function extractText(response) {
  const blocks = response?.content || [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function tryParseJson(raw) {
  if (!raw) return null;
  // Model may wrap in a code fence despite our instructions — strip it.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Last-ditch: pull the first {...} block out of the response.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function sanitizeCandidate(c) {
  if (!c || typeof c !== "object") return null;
  if (typeof c.id !== "string" || !SAFE_ID.test(c.id)) return null;
  if (!VALID_CATEGORIES.has(c.category)) return null;
  if (typeof c.title !== "string" || !c.title.trim()) return null;

  const scope = Array.isArray(c.scope) && c.scope.length > 0
    ? c.scope.filter((s) => typeof s === "string" && s.trim())
    : ["*"];

  const ruleLine = typeof c.rule === "string" && c.rule.trim() ? c.rule.trim() : "";
  const whyLine = typeof c.why === "string" && c.why.trim() ? c.why.trim() : "";
  const body = [ruleLine, whyLine].filter(Boolean).join("\n\n") || "**Rule:** _(empty — model proposed without body)_";

  return {
    meta: {
      id: c.id,
      title: c.title.trim(),
      category: c.category,
      confidence: CANDIDATE_CONFIDENCE,
      created: new Date().toISOString().slice(0, 10),
      source: "reflection",
      scope: { repos: scope },
    },
    body,
  };
}

/**
 * Apply a rescore delta to an existing lesson file, in place.
 * confirm = +evidence_for_step (config), contradict = -evidence_against_step.
 */
async function rescoreLesson(home, id, delta, config) {
  const lessons = await listLessons(home);
  const lesson = lessons.find((l) => l.meta.id === id);
  if (!lesson) return false;

  const c = config.confidence || {};
  const step = delta === "confirm"
    ? c.evidence_for_step ?? 0.15
    : -(c.evidence_against_step ?? 0.25);
  const next = clamp((lesson.meta.confidence ?? 0) + step);

  lesson.meta.confidence = Number(next.toFixed(2));
  lesson.meta.last_evidence = new Date().toISOString().slice(0, 10);

  await writeFile(lesson.path, serializeLesson(lesson));
  return true;
}

async function writeReflectionLog(home, payload) {
  const stamp = timestampStamp();
  const dir = paths(home).reflections;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${stamp}.md`);
  const lines = [
    `# Reflection ${stamp}`,
    "",
    `- prompt_version: ${REFLECTION_PROMPT_VERSION}`,
    `- model: ${payload.model}`,
    `- signals_considered: ${payload.signalsCount}`,
    `- candidates_proposed: ${payload.proposedCount}`,
    `- candidates_written: ${payload.writtenCount}`,
    `- rescored: ${payload.rescoredCount}`,
    `- dry_run: ${payload.dryRun}`,
    "",
    "## Raw model output",
    "",
    "```",
    payload.rawOutput || "(empty)",
    "```",
  ];
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

/**
 * Run a reflection pass.
 *
 * @param {object} opts
 * @param {string} opts.home  - agentmem home
 * @param {object} opts.client - Anthropic SDK client (or a stub with .messages.create)
 * @param {boolean} [opts.dryRun]
 *
 * Returns { skipped, reason, candidates, rescored, logPath }.
 */
export async function runReflection({ home, client, dryRun = false }) {
  const config = await loadConfig(home).catch(() => ({}));
  const rconfig = config.reflection || {};
  const lookback = rconfig.lookback_days ?? DEFAULT_LOOKBACK;
  const minSignals = rconfig.min_signals_to_reflect ?? DEFAULT_MIN_SIGNALS;
  const model = rconfig.model || DEFAULT_MODEL;

  const signals = await readSignalsSince(paths(home).signals, lookback);

  if (signals.length < minSignals) {
    return {
      skipped: true,
      reason: `min_signals_to_reflect=${minSignals}, got ${signals.length}`,
      candidates: [],
      rescored: [],
    };
  }

  const req = await buildReflectionRequest({ home, signals, model });

  const response = await client.messages.create(req);
  const raw = extractText(response);
  const parsed = tryParseJson(raw) || {};

  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const rawRescore = Array.isArray(parsed.rescore) ? parsed.rescore : [];

  const candidates = [];
  for (const rc of rawCandidates) {
    const sanitized = sanitizeCandidate(rc);
    if (!sanitized) continue;
    candidates.push(sanitized);

    if (!dryRun) {
      // Skip if a candidate or active lesson with this id already exists —
      // first-write-wins so a flaky model can't clobber a human's promote.
      const cands = await listCandidates(home);
      if (cands.some((c) => c.meta.id === sanitized.meta.id)) continue;
      const lessons = await listLessons(home);
      if (lessons.some((l) => l.meta.id === sanitized.meta.id)) continue;
      await writeCandidate(home, sanitized);
    }
  }

  const rescored = [];
  if (!dryRun) {
    for (const r of rawRescore) {
      if (!r || typeof r.id !== "string" || !SAFE_ID.test(r.id)) continue;
      if (r.delta !== "confirm" && r.delta !== "contradict") continue;
      const ok = await rescoreLesson(home, r.id, r.delta, config);
      if (ok) rescored.push(r);
    }
  }

  const logPath = await writeReflectionLog(home, {
    model,
    signalsCount: signals.length,
    proposedCount: rawCandidates.length,
    // candidates[] holds everything that PASSED sanitization; the dry-run path
    // doesn't write them to disk, so count zero writes for traceability.
    writtenCount: dryRun ? 0 : candidates.length,
    rescoredCount: rescored.length,
    dryRun,
    rawOutput: raw,
  });

  if (!dryRun) {
    const signalBreakdown = signals.reduce((acc, s) => {
      if (s.type === "correction") acc.correction = (acc.correction || 0) + 1;
      else if (s.type === "praise") acc.praise = (acc.praise || 0) + 1;
      else if (s.type === "retry") acc.retry = (acc.retry || 0) + 1;
      return acc;
    }, {});
    try {
      await syncToObsidian({
        home,
        triggeredBy: "reflect",
        pass: {
          kind: "reflect",
          timestamp: new Date().toISOString(),
          signalsConsidered: signals.length,
          signalBreakdown,
          newCandidates: candidates.map((c) => ({ id: c.meta.id, title: c.meta.title })),
          rescoredCount: rescored.length,
        },
      });
    } catch (e) {
      // Sync is best-effort — never fail the reflect pass on a vault hiccup.
      console.error(`obsidian sync failed: ${e.message}`);
    }
  }

  return {
    skipped: false,
    candidates,
    rescored,
    logPath,
    usage: response?.usage,
  };
}

/**
 * Construct an Anthropic SDK client from the resolved API key.
 * Key source order: AGENTMEM_API_KEY env → macOS Keychain → clear error.
 * (See lib/secrets.mjs.) Caller can override for testing.
 */
export async function defaultClient() {
  const { resolveApiKey } = await import("./secrets.mjs");
  const apiKey = await resolveApiKey();
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey });
}
