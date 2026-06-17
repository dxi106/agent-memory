import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { paths, loadConfig } from "./storage.mjs";
import { readSignalsSince } from "./signals.mjs";
import { withLock } from "./sync.mjs";
import { notifyHighSeverityRecs } from "./notify.mjs";
import { syncToObsidian } from "./obsidian.mjs";
import {
  COACHING_PROMPT_VERSION,
  COACHING_SYSTEM_PREAMBLE,
  COACHING_USER_PROMPT,
} from "./coaching-prompt.mjs";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const VALID_SEVERITY = new Set(["high", "medium", "low"]);
const VALID_CATEGORY = new Set(["feature_miss", "anti_pattern", "workflow_gap"]);
const VALID_STATUS = new Set(["pending", "accepted", "dismissed", "snoozed"]);
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_LOOKBACK = 7;
const DEFAULT_MAX_RECS = 8;
const DEFAULT_MIN_EVIDENCE = 2;

function assertSafeId(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error(`Invalid id: ${JSON.stringify(id)} (ids must match ${SAFE_ID})`);
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function timestampStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
}

function isoWeek(d = new Date()) {
  // ISO week-numbering: Thursday of the current week determines the year-week.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const diff = (target - firstThursday) / 86400000;
  const week = 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { year: target.getUTCFullYear(), week };
}

function recommendationsDir(home) {
  return join(home, "recommendations");
}

function recommendationPath(home, id) {
  assertSafeId(id);
  return join(recommendationsDir(home), `${id}.md`);
}

/**
 * Parse a single knowledge-base markdown file into entries split on `^## `
 * boundaries. The intro text (above the first `## `) is dropped — it's
 * preamble for humans, not data.
 *
 * Returns [{ name, body }, ...] where `body` is the raw text following the
 * heading up to (but not including) the next `^## ` heading, trimmed.
 */
function parseKnowledgeFile(text) {
  const lines = text.split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) {
        current.body = current.body.join("\n").trim();
        entries.push(current);
      }
      current = { name: m[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) {
    current.body = current.body.join("\n").trim();
    entries.push(current);
  }
  return entries;
}

/**
 * Load the coaching knowledge base from `knowledge/`.
 *
 * Returns { features, bestPractices, antiPatterns }, each an array of
 * { name, body } parsed from the corresponding markdown file.
 */
export async function loadKnowledgeBase(home) {
  const kdir = paths(home).knowledge;
  async function tryRead(name) {
    try {
      const text = await readFile(join(kdir, name), "utf8");
      return parseKnowledgeFile(text);
    } catch {
      return [];
    }
  }
  return {
    features: await tryRead("claude-code-features.md"),
    bestPractices: await tryRead("anthropic-best-practices.md"),
    antiPatterns: await tryRead("anti-patterns.md"),
  };
}

/**
 * Roll up structured statistics across a signal window — small enough to
 * embed in the coaching prompt without blowing up token use, rich enough
 * for the model to reason about frequency-based patterns.
 */
export function collectUsageStats(signals) {
  const stats = {
    totalSignals: signals.length,
    byType: {},
    byTool: {},
    sessions: 0,
    cwds: 0,
  };
  const sessionSet = new Set();
  const cwdSet = new Set();
  for (const s of signals) {
    if (s.type) stats.byType[s.type] = (stats.byType[s.type] || 0) + 1;
    if (s.tool) stats.byTool[s.tool] = (stats.byTool[s.tool] || 0) + 1;
    if (s.session) sessionSet.add(s.session);
    if (s.cwd) cwdSet.add(s.cwd);
  }
  stats.sessions = sessionSet.size;
  stats.cwds = cwdSet.size;
  return stats;
}

function formatKnowledgeForPrompt(knowledge) {
  function formatGroup(name, entries) {
    if (entries.length === 0) return `## ${name}\n\n_(none)_`;
    const blocks = entries.map((e) => `### ${e.name}\n${e.body}`).join("\n\n");
    return `## ${name}\n\n${blocks}`;
  }
  return [
    formatGroup("Claude Code features", knowledge.features),
    formatGroup("Best practices", knowledge.bestPractices),
    formatGroup("Anti-patterns", knowledge.antiPatterns),
  ].join("\n\n");
}

function formatLessonsForPrompt(lessons) {
  if (lessons.length === 0) return "_(none)_";
  return lessons
    .map((l) => {
      const m = l.meta || {};
      const conf = (m.confidence ?? 0).toFixed(2);
      return `- ${m.id} (${m.category}, ${conf}): ${m.title}`;
    })
    .join("\n");
}

function formatSignalsForPrompt(signals) {
  if (signals.length === 0) return "_(none)_";
  return signals
    .map((s) => {
      const tool = s.tool ? ` tool=${s.tool}` : "";
      const cwd = s.cwd ? ` cwd=${s.cwd}` : "";
      return `- [${s.ts}] ${s.type}${tool}${cwd}: ${(s.summary || "").trim()}`;
    })
    .join("\n");
}

function formatStatsForPrompt(stats) {
  const toolLines = Object.entries(stats.byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join("\n");
  const typeLines = Object.entries(stats.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join("\n");
  return [
    `- total signals: ${stats.totalSignals}`,
    `- distinct sessions: ${stats.sessions}`,
    `- distinct cwds: ${stats.cwds}`,
    "- by type:",
    typeLines || "  _(none)_",
    "- by tool:",
    toolLines || "  _(none)_",
  ].join("\n");
}

/**
 * Build a Messages API request shaped for prompt caching:
 *   system: [preamble, knowledge base]              (stable; cached)
 *   user:   recent signals + stats + active lessons (volatile; per-run)
 *
 * Lessons go in the volatile user message because they grow over time and
 * would otherwise constantly invalidate the cache. The knowledge base is
 * the dominant stable mass — that's what we want cached.
 */
export function buildCoachingPrompt({ signals, lessons, knowledge, usageStats, model = DEFAULT_MODEL, config = {} }) {
  const max = config.max_recommendations_per_run ?? DEFAULT_MAX_RECS;
  const system = [
    { type: "text", text: COACHING_SYSTEM_PREAMBLE },
    {
      type: "text",
      text: `# KNOWLEDGE BASE\n\n${formatKnowledgeForPrompt(knowledge)}`,
      cache_control: { type: "ephemeral" },
    },
  ];
  const user = [
    `# CONFIG`,
    `- max_recommendations_per_run: ${max}`,
    "",
    `# ACTIVE LESSONS (already in agentmem — don't re-propose these as anti-patterns)`,
    "",
    formatLessonsForPrompt(lessons || []),
    "",
    `# USAGE STATS`,
    "",
    formatStatsForPrompt(usageStats),
    "",
    `# RECENT SIGNALS`,
    "",
    formatSignalsForPrompt(signals),
    "",
    COACHING_USER_PROMPT,
  ].join("\n");

  return {
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  };
}

function tryParseJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function sanitizeRecommendation(r, minEvidence) {
  if (!r || typeof r !== "object") return null;
  if (typeof r.id !== "string" || !SAFE_ID.test(r.id)) return null;
  if (!VALID_SEVERITY.has(r.severity)) return null;
  if (!VALID_CATEGORY.has(r.category)) return null;
  if (typeof r.title !== "string" || !r.title.trim()) return null;
  if (typeof r.body !== "string" || !r.body.trim()) return null;
  if (!Array.isArray(r.evidence)) return null;
  const evidence = r.evidence
    .filter((e) => typeof e === "string" && e.trim())
    .map((e) => e.trim());
  if (evidence.length < minEvidence) return null;
  const nextStep = typeof r.next_step === "string" && r.next_step.trim() ? r.next_step.trim() : "";
  if (!nextStep) return null;
  const related = typeof r.related_knowledge === "string" && r.related_knowledge.trim()
    ? r.related_knowledge.trim()
    : null;
  return {
    id: r.id,
    title: r.title.trim(),
    severity: r.severity,
    category: r.category,
    body: r.body.trim(),
    evidence,
    next_step: nextStep,
    related_knowledge: related,
  };
}

/**
 * Parse the model's JSON output into validated recommendations.
 *
 * Drops recs that:
 *   - have an unsafe id (path traversal)
 *   - have an unknown severity/category
 *   - have fewer than `minEvidence` evidence entries (default 2)
 *   - are missing title/body/next_step
 *
 * Never throws on bad input — coaching is best-effort; a bad model run
 * shouldn't crash the launchd cron.
 */
export function parseCoachResponse(raw, { minEvidence = DEFAULT_MIN_EVIDENCE } = {}) {
  if (raw && typeof raw === "object" && Array.isArray(raw.content)) {
    raw = raw.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  const parsed = tryParseJson(raw) || {};
  const list = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  const out = [];
  for (const r of list) {
    const ok = sanitizeRecommendation(r, minEvidence);
    if (ok) out.push(ok);
  }
  return { recommendations: out };
}

function serializeRecommendation(rec, meta = {}) {
  const fullMeta = {
    id: rec.id,
    severity: rec.severity,
    category: rec.category,
    status: meta.status || "pending",
    snooze_until: meta.snooze_until ?? null,
    created: meta.created || todayISO(),
    evidence: rec.evidence,
    next_step: rec.next_step,
    ...(rec.related_knowledge ? { related_knowledge: rec.related_knowledge } : {}),
  };
  const body = `# ${rec.title}\n\n${rec.body}\n`;
  return matter.stringify(body, fullMeta);
}

/**
 * Write `recommendations/<id>.md`. Uses withLock to keep concurrent
 * coach-run + accept/dismiss calls from racing.
 */
export async function writeRecommendation(home, rec) {
  assertSafeId(rec?.id);
  const dir = recommendationsDir(home);
  await mkdir(dir, { recursive: true });
  return withLock(home, async () => {
    const file = recommendationPath(home, rec.id);
    await writeFile(file, serializeRecommendation(rec));
    return file;
  });
}

async function readRecommendationFile(file) {
  try {
    const text = await readFile(file, "utf8");
    const parsed = matter(text);
    return { meta: parsed.data, body: parsed.content, path: file };
  } catch {
    return null;
  }
}

export async function listRecommendations(home) {
  const dir = recommendationsDir(home);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const r = await readRecommendationFile(join(dir, f));
    if (r) out.push(r);
  }
  return out;
}

export async function getRecommendation(home, id) {
  assertSafeId(id);
  return readRecommendationFile(recommendationPath(home, id));
}

/**
 * Inline snooze check that operates on already-loaded meta — avoids the
 * extra per-rec file read that `isSnoozed(home, id)` would incur. Identical
 * semantics: snoozed iff status==="snoozed" AND snooze_until is a string
 * date >= today.
 */
function isSnoozedFromMeta(meta) {
  if (!meta || meta.status !== "snoozed") return false;
  const until = meta.snooze_until;
  if (!until || typeof until !== "string") return false;
  return until >= todayISO();
}

/**
 * Return pending coaching recommendations (status === "pending", not snoozed)
 * optionally filtered to a working-directory scope.
 *
 * Scope-matching is intentionally cheap: we substring-match the cwd against
 * the rec's body/evidence/next_step. The MCP `get_coaching_tips` tool uses
 * the same heuristic — see lib/mcp.mjs. Tiny defence against over-match:
 * we ignore "trivial" scopes (empty, "/", "/Users", etc.) that would
 * substring-match every path-bearing rec.
 *
 * If no scope is provided, every pending non-snoozed rec is returned.
 *
 * Used by:
 *   - adapters/claude-code/session-start.mjs to inject a one-line "you have
 *     N pending coaching tips" hint into Claude's SessionStart context
 *   - any other surface that wants to count relevant pending tips
 *
 * Perf note: SessionStart is a hot path — we filter in-memory off the single
 * listRecommendations() read and avoid the per-rec re-read that the public
 * `isSnoozed(home, id)` would do.
 */
export async function getPendingRecommendations(home, scope) {
  const all = await listRecommendations(home);
  const usableScope = isMeaningfulScope(scope) ? scope : null;
  const out = [];
  for (const r of all) {
    if ((r.meta?.status || "pending") !== "pending") continue;
    if (isSnoozedFromMeta(r.meta)) continue;
    if (usableScope) {
      const hay = `${r.body || ""} ${(r.meta?.evidence || []).join(" ")} ${r.meta?.next_step || ""}`;
      if (!hay.includes(usableScope)) continue;
    }
    out.push(r);
  }
  return out;
}

// Reject scopes that are too short or too generic to be a useful substring
// filter — these would match almost every path-bearing rec body and inflate
// the SessionStart tip count to nonsense.
function isMeaningfulScope(scope) {
  if (typeof scope !== "string") return false;
  const s = scope.trim();
  if (s.length < 4) return false; // includes "", "/", "/x"
  const trivial = new Set(["/Users", "/Users/", "/home", "/home/", "/tmp", "/tmp/"]);
  if (trivial.has(s)) return false;
  return true;
}

export async function getRecommendationStatus(home, id) {
  const r = await getRecommendation(home, id);
  if (!r) return null;
  return r.meta.status || "pending";
}

/**
 * Mutate a recommendation's status. For snooze, pass `{ days: N }` —
 * snooze_until is set to today + N days (ISO date).
 */
export async function setRecommendationStatus(home, id, status, opts = {}) {
  assertSafeId(id);
  if (!VALID_STATUS.has(status)) {
    throw new Error(`Invalid status: ${JSON.stringify(status)} (must be one of ${[...VALID_STATUS].join(", ")})`);
  }
  return withLock(home, async () => {
    const file = recommendationPath(home, id);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new Error(`Recommendation not found: ${id}`);
    }
    const parsed = matter(text);
    parsed.data.status = status;
    if (status === "snoozed") {
      const days = Number(opts.days ?? 7);
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + days);
      parsed.data.snooze_until = d.toISOString().slice(0, 10);
    } else {
      parsed.data.snooze_until = null;
    }
    await writeFile(file, matter.stringify(parsed.content, parsed.data));
    return parsed.data;
  });
}

export async function isDismissed(home, id) {
  const status = await getRecommendationStatus(home, id);
  return status === "dismissed";
}

export async function isSnoozed(home, id) {
  const r = await getRecommendation(home, id);
  if (!r) return false;
  if (r.meta.status !== "snoozed") return false;
  const until = r.meta.snooze_until;
  if (!until || typeof until !== "string") return false;
  return until >= todayISO();
}

async function writeCoachingLog(home, payload) {
  const stamp = timestampStamp();
  const dir = paths(home).reflections;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `coach-${stamp}.md`);
  const lines = [
    `# Coaching pass ${stamp}`,
    "",
    `- prompt_version: ${COACHING_PROMPT_VERSION}`,
    `- model: ${payload.model}`,
    `- signals_considered: ${payload.signalsCount}`,
    `- recs_proposed: ${payload.proposedCount}`,
    `- recs_written: ${payload.writtenCount}`,
    `- recs_skipped_dismissed: ${payload.skippedDismissed}`,
    `- recs_skipped_snoozed: ${payload.skippedSnoozed}`,
    `- recs_skipped_existing: ${payload.skippedExisting ?? 0}`,
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

function extractText(response) {
  const blocks = response?.content || [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Run a coaching pass.
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {object} opts.client - Anthropic SDK client (or stub with messages.create)
 * @param {number} [opts.sinceDays] - override lookback
 * @param {boolean} [opts.dryRun]
 *
 * Behaviour:
 *   - skips if there are zero signals in the lookback window
 *   - for each proposed rec: drops if id is already present as dismissed
 *     or still-snoozed; otherwise writes recommendations/<id>.md (or skips
 *     write on dryRun)
 *   - writes a log to reflections/coach-<timestamp>.md (suppressed on dryRun)
 */
export async function runCoachingPass({ home, client, sinceDays, dryRun = false, lessons, runNotifier } = {}) {
  const config = await loadConfig(home).catch(() => ({}));
  const cconfig = config.coaching || {};
  const nconfig = config.nudge || {};
  const lookback = sinceDays ?? cconfig.lookback_days ?? DEFAULT_LOOKBACK;
  const model = cconfig.model || DEFAULT_MODEL;
  const minEvidence = cconfig.min_evidence_per_recommendation ?? DEFAULT_MIN_EVIDENCE;

  const signals = await readSignalsSince(paths(home).signals, lookback);
  if (signals.length === 0) {
    return {
      skipped: true,
      reason: `no signals in the last ${lookback} day(s)`,
      recommendations: [],
    };
  }

  const knowledge = await loadKnowledgeBase(home);
  const usageStats = collectUsageStats(signals);
  const { listLessons } = await import("./storage.mjs");
  const activeLessons = lessons || (await listLessons(home));

  const req = buildCoachingPrompt({
    signals,
    lessons: activeLessons,
    knowledge,
    usageStats,
    model,
    config: cconfig,
  });
  const response = await client.messages.create(req);
  const raw = extractText(response);
  const parsed = parseCoachResponse(raw, { minEvidence });

  let skippedDismissed = 0;
  let skippedSnoozed = 0;
  let skippedExisting = 0;
  const written = [];
  // First-write-wins within a single pass so a flaky model returning the same
  // id twice can't overwrite its own earlier write. Mirrors reflect.mjs.
  const seenThisPass = new Set();
  for (const rec of parsed.recommendations) {
    if (seenThisPass.has(rec.id)) {
      skippedExisting += 1;
      continue;
    }
    if (await isDismissed(home, rec.id)) {
      skippedDismissed += 1;
      continue;
    }
    if (await isSnoozed(home, rec.id)) {
      skippedSnoozed += 1;
      continue;
    }
    // If a recommendation already exists for this id (with status accepted,
    // pending, etc.), do NOT clobber it — the user's status takes precedence
    // over a re-proposed write. dismissed/snoozed are handled above; here we
    // catch accepted + already-pending.
    const existing = await getRecommendation(home, rec.id);
    if (existing) {
      skippedExisting += 1;
      seenThisPass.add(rec.id);
      continue;
    }
    if (!dryRun) await writeRecommendation(home, rec);
    written.push(rec);
    seenThisPass.add(rec.id);
  }

  let logPath = null;
  if (!dryRun) {
    logPath = await writeCoachingLog(home, {
      model,
      signalsCount: signals.length,
      proposedCount: parsed.recommendations.length,
      writtenCount: written.length,
      skippedDismissed,
      skippedSnoozed,
      skippedExisting,
      dryRun,
      rawOutput: raw,
    });
  }

  // macOS notifications for newly-written HIGH-severity recs (SOU-19 Part A).
  //
  // NON-NEGOTIABLE invariants — preserve these even when refactoring:
  //   1. Notifications fire ONLY at generation time, never on a schedule.
  //      DO NOT add a launchd timer that pokes this code.
  //   2. Each rec id triggers AT MOST one notification across all coach runs
  //      (enforced by <home>/.notified.json — see lib/notify.mjs).
  //   3. dryRun never side-effects: no notification, no state file mutation.
  //   4. terminal-notifier failures are swallowed; coach pass never crashes here.
  let notified = [];
  if (!dryRun) {
    const enabled = nconfig.macos_notifications_on_high_only !== false;
    notified = await notifyHighSeverityRecs(home, written, { enabled, runNotifier });
  }

  if (!dryRun) {
    try {
      await syncToObsidian({
        home,
        triggeredBy: "coach",
        pass: {
          kind: "coach",
          timestamp: new Date().toISOString(),
          signalsConsidered: signals.length,
          newRecommendations: written.map((r) => ({
            id: r.id,
            severity: r.severity,
            title: r.title,
          })),
          skipped: {
            dismissed: skippedDismissed,
            snoozed: skippedSnoozed,
            existing: skippedExisting,
          },
        },
      });
    } catch (e) {
      console.error(`obsidian sync failed: ${e.message}`);
    }
  }

  return {
    skipped: false,
    recommendations: written,
    skippedDismissed,
    skippedSnoozed,
    skippedExisting,
    notified,
    logPath,
    usage: response?.usage,
  };
}

/**
 * Write a weekly digest of recommendations to recommendations/weekly/YYYY-WW.md.
 */
export async function weeklyDigest(home, { now } = {}) {
  const { year, week } = isoWeek(now || new Date());
  const stamp = `${year}-${String(week).padStart(2, "0")}`;
  const dir = join(recommendationsDir(home), "weekly");
  await mkdir(dir, { recursive: true });
  const recs = await listRecommendations(home);

  const groups = { high: [], medium: [], low: [] };
  for (const r of recs) {
    const sev = VALID_SEVERITY.has(r.meta.severity) ? r.meta.severity : "low";
    groups[sev].push(r);
  }

  const lines = [
    `# Weekly recommendations digest — ${stamp}`,
    "",
    `_${recs.length} recommendation(s) on file_`,
    "",
  ];
  for (const sev of ["high", "medium", "low"]) {
    if (groups[sev].length === 0) continue;
    lines.push(`## ${sev}`);
    lines.push("");
    for (const r of groups[sev]) {
      const title = (r.body.match(/^#\s+(.+)$/m) || [])[1] || r.meta.id;
      const status = r.meta.status || "pending";
      lines.push(`- **${title}** (${r.meta.category}, ${status}) — \`${r.meta.id}\``);
      if (r.meta.next_step) lines.push(`  - next step: ${r.meta.next_step}`);
    }
    lines.push("");
  }
  const file = join(dir, `${stamp}.md`);
  await writeFile(file, lines.join("\n"));
  return file;
}

/**
 * Construct an Anthropic SDK client from the resolved API key.
 * Mirrors lib/reflect.mjs::defaultClient — same env/keychain order.
 */
export async function defaultClient() {
  const { resolveApiKey } = await import("./secrets.mjs");
  const apiKey = await resolveApiKey();
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey });
}
