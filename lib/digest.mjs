// SOU-30 step 3 — the daily action digest.
//
// Turns the pending-candidate backlog into a short, dated, capped list that the
// SessionStart adapter delivers once a day. Everything here is deterministic
// and offline: no network, no model call. That property is load-bearing —
// the hook path must stay free of both.

import { join } from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { listCandidates, paths } from "./storage.mjs";

export const DEFAULT_DIGEST_CAP = 6;
export const LIVENESS_THRESHOLD_DAYS = 3;

// Ordering key. Candidate confidence is a hardcoded 0.35 for every record and
// nothing ever varies it (see the plan's Probe 2), so there is no ranking
// signal — the queue can only be drained oldest-first.
//
// `created` is date-only (`lib/reflect.mjs` slices to 10 chars), so same-day
// ties are the norm, not an edge case: 11 candidates once shared 2026-08-03.
// Sorting on the date alone would hand those ties to readdir order. The `id`
// tie-break is what makes the order total; ids are the filenames, so the
// filesystem already guarantees they are unique.
//
// `created_at` (full ISO, forward-only) is preferred when present. A date-only
// `created` is a prefix of any same-day `created_at`, so the two regimes
// interleave deterministically with no migration and no backfill.
function sortKey(candidate) {
  const meta = candidate?.meta ?? {};
  return {
    when: String(meta.created_at ?? meta.created ?? ""),
    id: String(meta.id ?? ""),
  };
}

export function orderCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka.when !== kb.when) return ka.when < kb.when ? -1 : 1;
    if (ka.id !== kb.id) return ka.id < kb.id ? -1 : 1;
    return 0;
  });
}

export function selectDigestItems(candidates, cap = DEFAULT_DIGEST_CAP) {
  return orderCandidates(candidates).slice(0, Math.max(0, cap));
}

function toUtcDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Goal 4: silence is allowed, unexplained silence is not.
 *
 * Measures the real thing — when a reflection was last written — rather than a
 * stamp asserting that it was. A store that has never reflected does not warn:
 * we cannot claim the job stopped if it never started.
 *
 * Known limit, stated rather than hidden: `reflect` writes no file when it
 * skips under `min_signals_to_reflect`, so a genuinely quiet stretch reads the
 * same as a dead job. Signals arrive from hooks continuously, so a 3-day gap
 * is worth surfacing either way.
 */
export function livenessWarning(
  lastReflection,
  today,
  thresholdDays = LIVENESS_THRESHOLD_DAYS,
) {
  const last = toUtcDay(lastReflection);
  const now = toUtcDay(today);
  if (last === null || now === null) return null;

  const gapDays = Math.floor((now - last) / 86_400_000);
  if (gapDays < thresholdDays) return null;

  return `No reflection has run in ${gapDays} days (last: ${String(lastReflection).slice(0, 10)}) — check \`launchctl list | grep agentmem\` and /tmp/agentmem.reflect.err.log.`;
}

/** The date of the most recent reflection run, or null if there has never been one. */
export async function lastReflectionDate(home) {
  let files;
  try {
    files = await readdir(paths(home).reflections);
  } catch {
    return null;
  }
  const dates = files
    .filter((f) => f.endsWith(".md"))
    // `coach-*.md` lives in the same directory and is not a reflection run.
    .map((f) => f.slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

function render({ today, items, warning, pendingTotal }) {
  const lines = [`# Digest ${today}`, ""];

  if (warning) {
    lines.push(`> ${warning}`, "");
  }

  if (items.length > 0) {
    const shown =
      items.length < pendingTotal
        ? `${items.length} of ${pendingTotal} pending`
        : `${items.length} pending`;
    lines.push(`## Candidates to triage (${shown})`, "");
    // No proposed verdict: every candidate carries an identical 0.35
    // confidence, so there is no signal to base one on. Inventing one would
    // read as a recommendation the data cannot support.
    for (const c of items) {
      lines.push(`- \`${c.meta.id}\` — ${c.meta.title} _(${c.meta.category})_`);
    }
    lines.push("", "Reply with the numbers to promote, e.g. \"promote 1, 3 and 5\".");
  }

  return lines.join("\n") + "\n";
}

/**
 * Build today's digest. Writes nothing when there is nothing to say — an empty
 * daily file is how a digest trains you to stop reading it (A2).
 */
export async function runDigest(
  home,
  { today = new Date().toISOString().slice(0, 10), cap = DEFAULT_DIGEST_CAP } = {},
) {
  const p = paths(home);
  const candidates = await listCandidates(home);
  const items = selectDigestItems(candidates, cap);
  const warning = livenessWarning(await lastReflectionDate(home), today);

  if (items.length === 0 && !warning) {
    return { file: null, items: [], warning: null };
  }

  await mkdir(p.digest, { recursive: true });
  const file = join(p.digest, `${today}.md`);
  await writeFile(file, render({ today, items, warning, pendingTotal: candidates.length }));
  return { file, items, warning };
}
