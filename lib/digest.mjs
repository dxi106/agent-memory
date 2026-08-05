// SOU-30 step 3 — the daily action digest.
//
// STUB. Landed ahead of its tests on purpose: R1's naive form fails with
// `Cannot find module '../lib/digest.mjs'`, which proves nothing about
// behaviour. With the module present but naive, every red below fails for the
// reason its name claims. See the plan's "Red tests" table.

import { join } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import { listCandidates, paths } from "./storage.mjs";

export const DEFAULT_DIGEST_CAP = 6;
export const LIVENESS_THRESHOLD_DAYS = 3;

// STUB: preserves directory enumeration order.
export function orderCandidates(candidates) {
  return candidates;
}

// STUB: ignores the cap.
export function selectDigestItems(candidates, cap = DEFAULT_DIGEST_CAP) {
  return orderCandidates(candidates);
}

// STUB: never warns.
export function livenessWarning(lastReflectionDate, today, thresholdDays = LIVENESS_THRESHOLD_DAYS) {
  return null;
}

// STUB: always writes a file, even with nothing to say.
export async function runDigest(home, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const p = paths(home);
  const candidates = await listCandidates(home);
  const items = selectDigestItems(candidates);
  const file = join(p.digest, `${today}.md`);
  await writeFile(file, `# Digest ${today}\n`);
  return { file, items, warning: null };
}

export async function lastReflectionDate(home) {
  let files;
  try {
    files = await readdir(paths(home).reflections);
  } catch {
    return null;
  }
  const dates = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}
