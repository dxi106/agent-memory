import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { appendSignal, readSignalsSince } from "./signals.mjs";
import { paths } from "./paths.mjs";

const execFileAsync = promisify(execFile);

const MAX_SUMMARY = 200;
const DEFAULT_MAX_PRS = 50;
const DEFAULT_HOT_FILE_THRESHOLD = 5;
const DEFAULT_HOT_FILE_WINDOW_DAYS = 14;
// Cap the per-commit detail-fetch loop (each commit needs a separate
// `/repos/<r>/commits/<sha>` request for the file list). Code-review
// finding #3 (2026-05-31): the prior uncapped loop could issue 100×N
// requests on a daily ingest across N watched repos, burning gh-CLI's
// 5000 req/hr quota and silently dropping signals when transient rate-
// limit errors hit `.catch(() => null)`.
const DEFAULT_MAX_COMMITS = 50;
const REVERT_PAIR_WINDOW_DAYS = 7;

// Files whose churn never carries useful "this is hot" signal — they change
// on every install / regenerate, swamping real source-file churn.
const HOT_FILE_DENYLIST = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)Pipfile\.lock$/i,
  /(^|\/)Gemfile\.lock$/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)Cargo\.lock$/i,
  /(^|\/)go\.sum$/i,
  /(^|\/)\.DS_Store$/,
];

// Files that, when modified, constitute a documented-convention change.
// CLAUDE.md / AGENTS.md / .cursorrules are read directly by tools; anything
// under knowledge/ is the coaching KB the reflect/coach passes consume.
export const CONVENTION_FILE_PATTERNS = [
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)AGENTS\.md$/,
  /(^|\/)\.cursorrules$/,
  /(^|\/)knowledge\/[^/]+\.md$/,
];

// Lowercased phrases that, if a comment body matches one verbatim (after
// trim + strip leading punctuation), count as pure-LGTM noise. The list is
// deliberately short; broader fuzzy matching would silence real feedback
// that happens to contain "looks good".
// Strict allowlist of POSITIVE-ONLY single-token approval expressions.
// Anything not in this set is treated as substantive feedback. Code-review
// finding #1 (2026-05-31): the prior catch-all regex matched `:-1:` and the
// single-codepoint check matched `👎`, silently dropping the most valuable
// signal (substantive disapproval). Now strictly allowlisted.
const LGTM_EXACT_BODIES = new Set([
  // English approvals
  "lgtm",
  "lgtm!",
  "lgtm.",
  "+1",
  "looks good",
  "looks good!",
  "looks good to me",
  "looks good to me!",
  "ship it",
  "ship it!",
  "approved",
  "approved!",
  // Positive shortcodes
  ":+1:",
  ":+1:!",
  ":thumbsup:",
  ":shipit:",
  ":tada:",
  ":rocket:",
  ":fire:",
  ":heart:",
  ":heart_eyes:",
  ":white_check_mark:",
  ":ok_hand:",
  ":clap:",
  ":100:",
  // Positive single-codepoint emoji
  "👍",
  "🎉",
  "🚀",
  "🚢",
  "✅",
  "❤️",
  "🔥",
  "💯",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text) {
  const t = (text || "").trim();
  return t.length <= MAX_SUMMARY ? t : t.slice(0, MAX_SUMMARY - 1) + "…";
}

/**
 * Heuristic: should this review comment be skipped as noise?
 *
 * Filters:
 *   - empty/whitespace
 *   - pure LGTM/+1/ship-it (exact-match against a curated list)
 *   - `nit:` prefixed (any case)
 *   - single emoji or `:slug:` GitHub emoji shortcode, optionally with
 *     trailing punctuation
 *
 * Anything else — including bodies that *contain* "looks good" but also
 * substantive text — is treated as real feedback.
 */
export function isLgtmComment(body) {
  if (body == null) return true;
  const trimmed = String(body).trim();
  if (!trimmed) return true;

  // Exact-match against the LGTM/emoji table.
  const lower = trimmed.toLowerCase();
  if (LGTM_EXACT_BODIES.has(lower)) return true;

  // nit:-prefixed bodies are by convention low-stakes style suggestions.
  if (/^nit\s*:/i.test(trimmed)) return true;

  // Strict-allowlist only. Previous heuristics (catch-all `:emoji:` regex,
  // "any non-letter char of length 1–3") silently treated disapproval like
  // `:-1:` and 👎 as LGTM — the OPPOSITE of intent. If you want to add a
  // new positive marker, add it to LGTM_EXACT_BODIES above.
  return false;
}

/**
 * Detect whether a commit message subject starts with `Revert "`.
 *
 * Returns { isRevert, revertedSubject } where revertedSubject is the inner
 * quoted text. Does NOT attempt to extract the reverted SHA from the body —
 * we get that more reliably from pairing the revert subject against a prior
 * commit in the same listing.
 */
export function parseRevertSubject(message) {
  if (!message || typeof message !== "string") {
    return { isRevert: false, revertedSubject: null };
  }
  const subject = message.split("\n", 1)[0];
  const m = subject.match(/^Revert\s+"(.+)"\s*$/);
  if (!m) return { isRevert: false, revertedSubject: null };
  return { isRevert: true, revertedSubject: m[1] };
}

/**
 * Extract a reverted-commit SHA from the body of a revert commit, if
 * GitHub's auto-generated `This reverts commit <sha>.` line is present.
 * Returns null otherwise — caller can still pair by subject.
 */
function extractRevertedShaFromBody(message) {
  if (!message || typeof message !== "string") return null;
  const m = message.match(/This reverts commit ([0-9a-f]{7,40})/i);
  return m ? m[1] : null;
}

export function isHotFilePath(p) {
  if (!p || typeof p !== "string") return false;
  return !HOT_FILE_DENYLIST.some((re) => re.test(p));
}

function isConventionPath(p) {
  if (!p || typeof p !== "string") return false;
  return CONVENTION_FILE_PATTERNS.some((re) => re.test(p));
}

/**
 * Stable hash for a GitHub-sourced signal. Built from type + a discriminator
 * derived from raw fields. The choice of discriminator differs by type:
 *
 *   - review_comment: repo+pr+comment_id
 *   - revert:         repo+revert_sha
 *   - hot_file:       repo+path+window-bucket  (one signal per file per window)
 *   - convention_change: repo+sha+path
 *
 * Hashing into a single key lets us dedup against existing signals without
 * knowing the per-type field layout at the call site.
 */
export function signalKeyForGithub(signal) {
  const t = signal.type || "";
  const r = signal.raw || {};
  let disc = "";
  if (t === "review_comment") disc = `${r.repo}|${r.pr}|${r.comment_id}`;
  else if (t === "revert") disc = `${r.repo}|${r.revert_sha}`;
  else if (t === "hot_file") disc = `${r.repo}|${r.path}|${r.window_bucket || ""}`;
  else if (t === "convention_change") disc = `${r.repo}|${r.sha}|${r.path}`;
  else disc = JSON.stringify(r);
  return createHash("sha1").update(`${t}|${disc}`).digest("hex");
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function statePath(home) {
  return join(home, "ingest-state.json");
}

export async function loadIngestState(home) {
  try {
    const text = await readFile(statePath(home), "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !parsed.repos) {
      return { repos: {} };
    }
    return parsed;
  } catch {
    return { repos: {} };
  }
}

export async function saveIngestState(home, state) {
  const safe = { repos: state?.repos || {} };
  await writeFile(statePath(home), JSON.stringify(safe, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// gh CLI fetcher (production)
// ---------------------------------------------------------------------------

/**
 * Production GitHub fetcher: shells out to `gh api <path>` and parses JSON.
 *
 * - Uses execFile (no shell), so the path argument can't be exploited by
 *   embedded shell metacharacters.
 * - Trusts gh's own auth resolution: keyring on macOS, GITHUB_TOKEN env on
 *   CI, etc.
 * - Throws on non-zero exit; the caller (ingestGitHubRepos) catches and
 *   records the error rather than aborting the whole run.
 *
 * Buffer cap is generous (10MB) — review-comment listings on a noisy PR
 * can be a few hundred KB but rarely more.
 */
export async function ghCliFetch(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`ghCliFetch: path must be an absolute API path, got ${JSON.stringify(path)}`);
  }
  const { stdout } = await execFileAsync(
    "gh",
    ["api", path, "-H", "Accept: application/vnd.github+json"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  if (!stdout || !stdout.trim()) return [];
  return JSON.parse(stdout);
}

/**
 * Fallback fetcher: hits the REST API directly with a GITHUB_TOKEN. Used
 * when `gh` isn't installed (e.g. headless CI without the CLI). Same
 * contract as ghCliFetch: returns parsed JSON, throws on failure.
 */
export async function tokenFetch(path, token) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`tokenFetch: path must be absolute, got ${JSON.stringify(path)}`);
  }
  if (!token) throw new Error("tokenFetch: GITHUB_TOKEN is required");
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agentmem-ingest-github",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Resolve a production fetcher: prefer `gh` if it's authenticated, fall
 * back to GITHUB_TOKEN. Returns null if neither is available — the caller
 * should bail with a clear message.
 */
export async function resolveProductionFetcher({ env = process.env } = {}) {
  // Check gh auth status — succeeds (exit 0) only when authenticated.
  try {
    await execFileAsync("gh", ["auth", "status"], { env });
    return ghCliFetch;
  } catch {
    // fall through to token
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) return (p) => tokenFetch(p, token);
  return null;
}

// ---------------------------------------------------------------------------
// Per-signal-type processors
// ---------------------------------------------------------------------------

async function processReviewComments({
  repo,
  ghFetch,
  since,
  maxPrsPerRepo,
  seen,
  sigDir,
  emitted,
}) {
  const sinceMs = Date.now() - since * 86400000;

  // GitHub's per_page max is 100. Pass min(maxPrsPerRepo, 100) so the config
  // knob actually widens the scan when set above 50 (code-review finding #2,
  // 2026-05-31 — the prior hardcoded per_page=50 silently capped at 50).
  const perPage = Math.min(Math.max(1, maxPrsPerRepo), 100);
  const pulls = await ghFetch(
    `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}`,
  );
  if (!Array.isArray(pulls)) return;

  // Only consider merged PRs whose merge date is in-window.
  const eligible = pulls
    .filter((p) => p && p.merged_at)
    .filter((p) => {
      const mergedMs = Date.parse(p.merged_at);
      return Number.isFinite(mergedMs) && mergedMs >= sinceMs;
    })
    .slice(0, maxPrsPerRepo);

  let highestPr = 0;

  for (const pr of eligible) {
    if (typeof pr.number === "number" && pr.number > highestPr) highestPr = pr.number;

    // Inline review comments (file/line-anchored).
    const inline = await ghFetch(`/repos/${repo}/pulls/${pr.number}/comments`).catch(() => []);
    // PR-level issue comments.
    const issueLevel = await ghFetch(`/repos/${repo}/issues/${pr.number}/comments`).catch(() => []);
    // PR reviews (bodies on approve/comment/request-changes summaries).
    const reviews = await ghFetch(`/repos/${repo}/pulls/${pr.number}/reviews`).catch(() => []);

    const allComments = [
      ...(Array.isArray(inline) ? inline : []),
      ...(Array.isArray(issueLevel) ? issueLevel : []),
      ...(Array.isArray(reviews) ? reviews : []),
    ];

    for (const c of allComments) {
      if (!c || typeof c !== "object") continue;
      if (isLgtmComment(c.body)) continue;

      const sig = {
        ts: c.created_at || c.submitted_at || pr.merged_at || new Date().toISOString(),
        host: "github",
        type: "review_comment",
        summary: truncate(c.body),
        raw: {
          repo,
          pr: pr.number,
          comment_id: c.id,
          author: c.user?.login || null,
          pr_url: pr.html_url || null,
          comment_url: c.html_url || null,
          path: c.path || null,
        },
      };
      const key = signalKeyForGithub(sig);
      if (seen.has(key)) continue;
      seen.add(key);
      await appendSignal(sigDir, sig);
      emitted.count += 1;
    }
  }

  return { highestPr };
}

async function processCommitSignals({
  repo,
  ghFetch,
  since,
  hotFileThreshold,
  hotFileWindowDays,
  maxCommitsPerRepo,
  seen,
  sigDir,
  emitted,
  now,
}) {
  const nowDate = now();
  const sinceDate = new Date(nowDate.getTime() - since * 86400000);
  const sincePath = sinceDate.toISOString().slice(0, 10);

  // GitHub's per_page max is 100. Ask only for what we'll actually process
  // (code-review finding #3, 2026-05-31 — the prior fetch was 100 and the
  // detail-fetch loop was uncapped).
  const perPage = Math.min(Math.max(1, maxCommitsPerRepo), 100);
  const raw = await ghFetch(
    `/repos/${repo}/commits?since=${encodeURIComponent(sincePath)}&per_page=${perPage}`,
  );
  if (!Array.isArray(raw)) return;
  const commits = raw.slice(0, maxCommitsPerRepo);

  // The /commits endpoint returns newest-first. Capture the newest sha so
  // subsequent runs can short-circuit (state hint only — we still dedup
  // per-signal).
  const newestSha = commits[0]?.sha || null;

  // ---- revert detection ---------------------------------------------------
  // Pair revert commits against earlier commits in the same window:
  //   1. Prefer the explicit "This reverts commit <sha>" body line.
  //   2. Otherwise match the reverted subject against a prior commit's
  //      first line (the one inside the surrounding quotes).
  const revertWindowMs = REVERT_PAIR_WINDOW_DAYS * 86400000;
  const bySubject = new Map(); // subject -> { sha, ts }
  // Pre-pass: index non-revert commits' subjects (for fallback pairing).
  for (const c of commits) {
    if (!c?.commit?.message) continue;
    const subject = c.commit.message.split("\n", 1)[0];
    if (!subject.startsWith("Revert ")) {
      bySubject.set(subject, {
        sha: c.sha,
        ts: Date.parse(c.commit?.author?.date || c.commit?.committer?.date || ""),
      });
    }
  }

  for (const c of commits) {
    const message = c?.commit?.message || "";
    const { isRevert, revertedSubject } = parseRevertSubject(message);
    if (!isRevert) continue;

    const revertTs = Date.parse(c.commit?.author?.date || c.commit?.committer?.date || "");
    let revertedSha = extractRevertedShaFromBody(message);
    if (!revertedSha && revertedSubject && bySubject.has(revertedSubject)) {
      const pair = bySubject.get(revertedSubject);
      if (
        !Number.isFinite(revertTs) ||
        !Number.isFinite(pair.ts) ||
        revertTs - pair.ts <= revertWindowMs
      ) {
        revertedSha = pair.sha;
      }
    }

    const sig = {
      ts: c.commit?.author?.date || c.commit?.committer?.date || new Date().toISOString(),
      host: "github",
      type: "revert",
      summary: truncate(`Revert "${revertedSubject || "(unknown)"}" in ${repo}`),
      raw: {
        repo,
        revert_sha: c.sha,
        reverted_sha: revertedSha,
        reverted_subject: revertedSubject,
        commit_url: c.html_url || null,
      },
    };
    const key = signalKeyForGithub(sig);
    if (seen.has(key)) continue;
    seen.add(key);
    await appendSignal(sigDir, sig);
    emitted.count += 1;
  }

  // ---- hot_file detection -------------------------------------------------
  // Re-fetch each commit's files endpoint (the /commits listing doesn't
  // include the file list). We cap at the first 100 commits (the listing
  // page size) to stay within the budget.
  //
  // The hot-file window may be narrower than `since` (e.g. 14d vs 30d) —
  // bucket commits by author date and only count those inside the window.
  const hotWindowMs = hotFileWindowDays * 86400000;
  const hotCutoffMs = nowDate.getTime() - hotWindowMs;
  const fileCommitCount = new Map(); // path -> count
  // We also re-scan files for convention_change emission.
  const conventionEmits = [];

  for (const c of commits) {
    const ts = Date.parse(c.commit?.author?.date || c.commit?.committer?.date || "");
    const detail = await ghFetch(`/repos/${repo}/commits/${c.sha}`).catch(() => null);
    const files = Array.isArray(detail?.files) ? detail.files : [];

    for (const f of files) {
      const fp = f?.filename;
      if (!fp) continue;
      // Convention changes are emitted regardless of hot-file accounting.
      if (isConventionPath(fp)) {
        conventionEmits.push({ commit: c, file: f, ts });
      }
      if (!isHotFilePath(fp)) continue;
      if (Number.isFinite(ts) && ts < hotCutoffMs) continue;
      fileCommitCount.set(fp, (fileCommitCount.get(fp) || 0) + 1);
    }
  }

  for (const [filePath, count] of fileCommitCount) {
    if (count < hotFileThreshold) continue;
    const sig = {
      ts: new Date().toISOString(),
      host: "github",
      type: "hot_file",
      summary: truncate(
        `${filePath} hot in ${repo} — ${count} commits in last ${hotFileWindowDays}d`,
      ),
      raw: {
        repo,
        path: filePath,
        commit_count: count,
        window_days: hotFileWindowDays,
        // Bucket key — one signal per file per window per ingest run. The
        // run-date is granular enough; a single run won't emit twice for
        // the same file, and a follow-up run a day later that crosses the
        // threshold again is genuinely a new signal.
        window_bucket: new Date().toISOString().slice(0, 10),
      },
    };
    const key = signalKeyForGithub(sig);
    if (seen.has(key)) continue;
    seen.add(key);
    await appendSignal(sigDir, sig);
    emitted.count += 1;
  }

  // ---- convention_change --------------------------------------------------
  for (const { commit, file, ts } of conventionEmits) {
    const sig = {
      ts: commit.commit?.author?.date || commit.commit?.committer?.date || new Date().toISOString(),
      host: "github",
      type: "convention_change",
      summary: truncate(
        `${file.filename} changed in ${repo} (${commit.sha.slice(0, 7)})`,
      ),
      raw: {
        repo,
        path: file.filename,
        sha: commit.sha,
        status: file.status || null,
        patch: typeof file.patch === "string" ? file.patch.slice(0, 4000) : null,
        commit_url: commit.html_url || null,
      },
    };
    const key = signalKeyForGithub(sig);
    if (seen.has(key)) continue;
    seen.add(key);
    await appendSignal(sigDir, sig);
    emitted.count += 1;
  }

  return { newestSha };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Scrape watched GitHub repos for signals not visible to transcript/hook
 * scraping. Pure-ish: takes a DI'd fetcher, returns counts + errors.
 *
 * Options:
 *   home:                agentmem store root
 *   repos:               watch list (e.g. ["example-user/agent-memory"])
 *   since:               lookback window in days (default 30)
 *   ghFetch:             async (apiPath) => parsedJson — DI for tests
 *   maxPrsPerRepo:       cap on PR processing per repo (default 50)
 *   maxCommitsPerRepo:   cap on per-commit detail fetches per repo (default 50)
 *   hotFileThreshold:    min commits in window for hot_file (default 5)
 *   hotFileWindowDays:   hot-file window (default 14)
 *   now:                 () => Date — DI for deterministic testing
 *
 * Returns:
 *   { signalsWritten, reposProcessed, errors }
 */
export async function ingestGitHubRepos({
  home,
  repos,
  since = 30,
  ghFetch,
  maxPrsPerRepo = DEFAULT_MAX_PRS,
  maxCommitsPerRepo = DEFAULT_MAX_COMMITS,
  hotFileThreshold = DEFAULT_HOT_FILE_THRESHOLD,
  hotFileWindowDays = DEFAULT_HOT_FILE_WINDOW_DAYS,
  now = () => new Date(),
}) {
  if (!Array.isArray(repos) || repos.length === 0) {
    return { signalsWritten: 0, reposProcessed: 0, errors: [] };
  }
  if (typeof ghFetch !== "function") {
    throw new Error("ingestGitHubRepos: ghFetch is required");
  }

  const sigDir = paths(home).signals;
  const state = await loadIngestState(home);

  // Seed dedup set from recent signals (handles re-runs within the same
  // signal-retention window).
  const existing = await readSignalsSince(sigDir, Math.max(since, 1));
  const seen = new Set();
  for (const s of existing) {
    if (s.host !== "github") continue;
    seen.add(signalKeyForGithub(s));
  }

  const emitted = { count: 0 };
  const errors = [];
  let reposProcessed = 0;

  for (const repo of repos) {
    if (typeof repo !== "string" || !repo.includes("/")) {
      errors.push(new Error(`invalid repo entry: ${JSON.stringify(repo)} (expected "owner/name")`));
      continue;
    }
    try {
      const prRes = await processReviewComments({
        repo,
        ghFetch,
        since,
        maxPrsPerRepo,
        seen,
        sigDir,
        emitted,
      });
      const commitRes = await processCommitSignals({
        repo,
        ghFetch,
        since,
        hotFileThreshold,
        hotFileWindowDays,
        maxCommitsPerRepo,
        seen,
        sigDir,
        emitted,
        now,
      });
      reposProcessed += 1;

      // Update state — best-effort. Don't fail the run if state write later fails.
      const prior = state.repos[repo] || {};
      state.repos[repo] = {
        last_processed_pr_id: Math.max(prior.last_processed_pr_id || 0, prRes?.highestPr || 0),
        last_processed_commit_sha: commitRes?.newestSha || prior.last_processed_commit_sha || null,
        last_run_at: new Date().toISOString(),
      };
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  try {
    await saveIngestState(home, state);
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(`saveIngestState failed: ${err}`));
  }

  return { signalsWritten: emitted.count, reposProcessed, errors };
}
