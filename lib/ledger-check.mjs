import { resolveProductionFetcher } from "./ingest-github.mjs";

// Goal 5: a feature PR that merged without a findings-ledger close-out gets
// noticed. One digest line each, no LLM pass, no drafting, no PR creation.
//
// The ledger (`docs/review-findings-ledger.md` in the watched repo) records
// every above-LOW review finding when its PR merges. A feature PR with no
// citing row means the review rounds it burned were never written down, so the
// next plan cannot learn from them — which is the entire reason the ledger
// exists.

/** Default watched repo. Overridable so this is not hard-wired to one project. */
export const LEDGER_REPO = "dxi106/callelo";
export const LEDGER_PATH = "docs/review-findings-ledger.md";

/**
 * The ledger begins at #547. Earlier PRs merged before it existed and can never
 * acquire a row, so flagging them is permanent, unfixable noise.
 */
export const FIRST_LEDGER_PR = 547;

/**
 * A feature PR is one whose title OPENS with a ticket id.
 *
 * Deliberately a prefix, not a search: `docs: close out CAL-608 — ledger rows
 * logged` mentions a ticket and is precisely the kind of PR that must not be
 * flagged — it IS somebody's close-out. Deliberately not `CAL-` either; SOU-
 * and any other tracker read the same way, and a checker that only understands
 * one project's prefix is a checker that silently passes everything on the next
 * project.
 */
export const TICKET_PREFIX = /^[A-Z]{2,6}-\d+\b/;

/**
 * …but a ticket id followed by `plan:` / `spec:` is a DOCUMENT for that ticket,
 * not its implementation. Plans go through the plan gate, not the code-review
 * gate, so they can never earn a ledger row. Found in the live run: #595
 * "CAL-644 plan: store a wildcard sentinel…" was flagged, and nothing anyone
 * could do would ever clear it.
 *
 * Anchored to the token right after the id, so "CAL-617: planned rollout …"
 * — where "planned" is prose in the summary — is still implementation work.
 */
const DOC_SUFFIX = /^[A-Z]{2,6}-\d+\s+(plan|spec|docs?)\b/i;

/** PR citations in the ledger, as a Set of numbers. */
export function parseCitedPrs(markdown) {
  const cited = new Set();
  for (const m of String(markdown ?? "").matchAll(/#(\d+)/g)) {
    cited.add(Number(m[1]));
  }
  return cited;
}

export function isFeaturePr(title) {
  const t = String(title ?? "").trim();
  return TICKET_PREFIX.test(t) && !DOC_SUFFIX.test(t);
}

/**
 * Which merged feature PRs have no ledger row.
 *
 * `complete` is not decoration. This answers "which PRs are missing a
 * close-out", so a merged list that stopped short of `since` leaves the PRs
 * below the cut UNEXAMINED — and reporting those as fine is a false clean, the
 * exact failure the check exists to catch, one level up. The caller must be
 * able to tell "nothing missing" from "I did not look that far back".
 */
export function findMissingCloseouts({ ledgerText, mergedPrs = [], since = FIRST_LEDGER_PR } = {}) {
  const cited = parseCitedPrs(ledgerText);
  const numbers = mergedPrs.map((p) => p.number).filter((n) => Number.isFinite(n));
  const oldestSeen = numbers.length > 0 ? Math.min(...numbers) : null;

  const missing = mergedPrs
    .filter((p) => p.number >= since)
    .filter((p) => isFeaturePr(p.title))
    .filter((p) => !cited.has(p.number))
    .sort((a, b) => b.number - a.number)
    .map((p) => ({ number: p.number, title: String(p.title ?? "") }));

  return {
    missing,
    // No page at all is not "complete" — it is "we saw nothing".
    complete: oldestSeen !== null && oldestSeen <= since,
    oldestSeen,
  };
}

/**
 * The ledger text, read from `main` on the server.
 *
 * **Never read this from a local working tree.** The session that wrote the
 * SOU-30 plan did exactly that against a callelo checkout six commits behind,
 * concluded the #572 rows did not exist, and was wrong. A stale local read is
 * the known way to get a confidently false answer here, and the failure is
 * silent: every PR whose row landed in those six commits reads as missing.
 * `ref` is pinned rather than left to the API's default branch so the read
 * cannot drift with a repo setting.
 */
export async function fetchLedgerText(fetcher, { repo = LEDGER_REPO, path = LEDGER_PATH, ref = "main" } = {}) {
  const res = await fetcher(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (!res || res.encoding !== "base64" || typeof res.content !== "string") {
    // Returning "" here would parse to zero citations and flag EVERY feature
    // PR — a wall of false positives that reads exactly like a real backlog.
    throw new Error(
      `fetchLedgerText: cannot decode ${path} (encoding=${JSON.stringify(res?.encoding)})`,
    );
  }
  return Buffer.from(res.content, "base64").toString("utf8");
}

/** Merged PRs, newest first. Closed-but-never-merged PRs are not merges. */
export async function fetchMergedPrs(fetcher, { repo = LEDGER_REPO, limit = 100 } = {}) {
  const res = await fetcher(
    `/repos/${repo}/pulls?state=closed&sort=created&direction=desc&per_page=${limit}`,
  );
  return (Array.isArray(res) ? res : [])
    .filter((p) => p && p.merged_at)
    .map((p) => ({ number: p.number, title: String(p.title ?? "") }))
    .sort((a, b) => b.number - a.number);
}

/**
 * Both fetches plus the comparison. Errors are NOT caught: a failed fetch that
 * degraded to an empty result would report a clean ledger, which is worse than
 * reporting nothing. The digest caller decides what a failure looks like.
 */
export async function runLedgerCheck({
  fetcher,
  repo = LEDGER_REPO,
  since = FIRST_LEDGER_PR,
  limit = 100,
} = {}) {
  const [ledgerText, mergedPrs] = await Promise.all([
    fetchLedgerText(fetcher, { repo }),
    fetchMergedPrs(fetcher, { repo, limit }),
  ]);
  return { repo, ...findMissingCloseouts({ ledgerText, mergedPrs, since }) };
}

/**
 * runLedgerCheck, with every failure converted into a REPORTED failure.
 *
 * runLedgerCheck itself must not catch — a fetch that degraded to an empty
 * result would report a clean ledger, and a false clean is precisely what this
 * feature exists to prevent. But a GitHub outage must not take down the offline
 * half of the digest either. So the catching happens here, once, and the
 * failure travels as `error` so the render can print "could not run" rather
 * than letting an absent section mean "nothing missing".
 *
 * `resolveFetcher` is a parameter so this is testable without a network: the
 * alternative was an env-var backdoor that disables production behaviour, which
 * would leave this seam permanently unexercised.
 */
export async function safeLedgerCheck({
  resolveFetcher = resolveProductionFetcher,
  repo = LEDGER_REPO,
  since = FIRST_LEDGER_PR,
  limit = 100,
} = {}) {
  const failed = (error) => ({ repo, missing: [], complete: false, oldestSeen: null, error });
  try {
    const fetcher = await resolveFetcher();
    if (!fetcher) return failed("no GitHub credentials (`gh auth login` or GITHUB_TOKEN)");
    return await runLedgerCheck({ fetcher, repo, since, limit });
  } catch (err) {
    return failed(err?.message ? String(err.message) : String(err));
  }
}
