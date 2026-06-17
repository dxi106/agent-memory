import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, paths } from "../lib/storage.mjs";
import { appendSignal, readSignalsSince } from "../lib/signals.mjs";
import {
  ingestGitHubRepos,
  isLgtmComment,
  isHotFilePath,
  parseRevertSubject,
  signalKeyForGithub,
  loadIngestState,
  saveIngestState,
  CONVENTION_FILE_PATTERNS,
} from "../lib/ingest-github.mjs";

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-gh-"));
  await ensureLayout(home);
  return home;
}

// ----- isLgtmComment -------------------------------------------------------

test("isLgtmComment flags pure LGTM bodies", () => {
  assert.equal(isLgtmComment("LGTM"), true);
  assert.equal(isLgtmComment("lgtm!"), true);
  assert.equal(isLgtmComment("looks good"), true);
  assert.equal(isLgtmComment("Looks good to me"), true);
  assert.equal(isLgtmComment("ship it"), true);
  assert.equal(isLgtmComment("  +1  "), true);
  assert.equal(isLgtmComment(":+1:"), true);
});

test("isLgtmComment flags nit-prefixed bodies", () => {
  assert.equal(isLgtmComment("nit: rename this var"), true);
  assert.equal(isLgtmComment("Nit: typo"), true);
  assert.equal(isLgtmComment("NIT: prefer const"), true);
});

test("isLgtmComment flags single-emoji bodies", () => {
  assert.equal(isLgtmComment(":shipit:"), true);
  assert.equal(isLgtmComment("🚢"), true);
  assert.equal(isLgtmComment("👍"), true);
});

test("isLgtmComment does NOT flag substantive feedback", () => {
  assert.equal(
    isLgtmComment("This breaks when the input is null — please add a guard"),
    false,
  );
  assert.equal(isLgtmComment("Why are we using a global here?"), false);
  // 'Looks good' is LGTM, but real feedback that mentions it is not.
  assert.equal(
    isLgtmComment("Looks good overall, but the retry logic is racy — see line 42"),
    false,
  );
});

test("isLgtmComment handles empty / whitespace bodies", () => {
  assert.equal(isLgtmComment(""), true);
  assert.equal(isLgtmComment("   \n  "), true);
  assert.equal(isLgtmComment(null), true);
  assert.equal(isLgtmComment(undefined), true);
});

test("isLgtmComment does NOT flag disapproval shortcodes or emoji", () => {
  // Code-review finding #1: the catch-all regex /^:[a-z0-9_+-]+:[!.]?$/i
  // matched :-1: because '-' was in the char class, and the single-codepoint
  // emoji check treated 👎 as "non-letter, length 1" → LGTM. Both are the
  // OPPOSITE of LGTM — substantive disapproval, the most valuable signal.
  assert.equal(isLgtmComment(":-1:"), false);
  assert.equal(isLgtmComment("👎"), false);
  assert.equal(isLgtmComment("👎🏽"), false);
  assert.equal(isLgtmComment(":x:"), false);
  assert.equal(isLgtmComment(":no_entry:"), false);
  // Concerning/uncertain reactions are also feedback, not noise.
  assert.equal(isLgtmComment(":warning:"), false);
  assert.equal(isLgtmComment(":exclamation:"), false);
});

// ----- parseRevertSubject --------------------------------------------------

test("parseRevertSubject extracts the reverted subject", () => {
  const r = parseRevertSubject('Revert "Add new flaky retry path"');
  assert.equal(r.isRevert, true);
  assert.equal(r.revertedSubject, "Add new flaky retry path");
});

test("parseRevertSubject handles trailing PR number", () => {
  const r = parseRevertSubject('Revert "Add foo (#42)"');
  assert.equal(r.isRevert, true);
  assert.equal(r.revertedSubject, "Add foo (#42)");
});

test("parseRevertSubject returns isRevert=false for normal commits", () => {
  const r = parseRevertSubject("feat: add stuff");
  assert.equal(r.isRevert, false);
  assert.equal(r.revertedSubject, null);
});

test("parseRevertSubject handles null/empty input", () => {
  assert.equal(parseRevertSubject("").isRevert, false);
  assert.equal(parseRevertSubject(null).isRevert, false);
});

// ----- isHotFilePath -------------------------------------------------------

test("isHotFilePath excludes lockfiles + generated files from hot-file accounting", () => {
  // Lockfiles change on every install; not a signal.
  assert.equal(isHotFilePath("package-lock.json"), false);
  assert.equal(isHotFilePath("yarn.lock"), false);
  assert.equal(isHotFilePath("pnpm-lock.yaml"), false);
  assert.equal(isHotFilePath("poetry.lock"), false);
});

test("isHotFilePath includes source files", () => {
  assert.equal(isHotFilePath("lib/foo.mjs"), true);
  assert.equal(isHotFilePath("src/index.ts"), true);
});

// ----- CONVENTION_FILE_PATTERNS -------------------------------------------

test("CONVENTION_FILE_PATTERNS matches the spec'd convention files", () => {
  const matches = (p) => CONVENTION_FILE_PATTERNS.some((re) => re.test(p));
  assert.equal(matches("CLAUDE.md"), true);
  assert.equal(matches("AGENTS.md"), true);
  assert.equal(matches(".cursorrules"), true);
  assert.equal(matches("knowledge/features.md"), true);
  assert.equal(matches("knowledge/anti-patterns.md"), true);
  assert.equal(matches("README.md"), false);
  assert.equal(matches("lib/foo.mjs"), false);
});

// ----- signalKeyForGithub --------------------------------------------------

test("signalKeyForGithub is stable across identical signals", () => {
  const a = signalKeyForGithub({
    type: "review_comment",
    raw: { repo: "x/y", pr: 42, comment_id: 123 },
  });
  const b = signalKeyForGithub({
    type: "review_comment",
    raw: { repo: "x/y", pr: 42, comment_id: 123 },
  });
  assert.equal(a, b);
});

test("signalKeyForGithub differs across distinct events", () => {
  const a = signalKeyForGithub({
    type: "review_comment",
    raw: { repo: "x/y", pr: 42, comment_id: 123 },
  });
  const b = signalKeyForGithub({
    type: "review_comment",
    raw: { repo: "x/y", pr: 42, comment_id: 124 },
  });
  assert.notEqual(a, b);
});

// ----- loadIngestState / saveIngestState ----------------------------------

test("loadIngestState returns an empty state when no file exists", async () => {
  const home = await tmpHome();
  const state = await loadIngestState(home);
  assert.deepEqual(state, { repos: {} });
});

test("saveIngestState + loadIngestState round-trips", async () => {
  const home = await tmpHome();
  const state = {
    repos: {
      "example-user/agent-memory": {
        last_processed_pr_id: 12,
        last_processed_commit_sha: "abc123",
      },
    },
  };
  await saveIngestState(home, state);
  const loaded = await loadIngestState(home);
  assert.deepEqual(loaded, state);
});

// ----- ingestGitHubRepos: empty watch list --------------------------------

test("ingestGitHubRepos with empty repos list is a no-op", async () => {
  const home = await tmpHome();
  let calls = 0;
  const ghFetch = async () => {
    calls += 1;
    return [];
  };
  const result = await ingestGitHubRepos({ home, repos: [], ghFetch });
  assert.equal(result.signalsWritten, 0);
  assert.equal(calls, 0, "ghFetch should not be called when repos is empty");
});

// ----- ingestGitHubRepos: review_comment ----------------------------------

function nowIso() {
  return new Date().toISOString();
}

function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

function fakeGhFetch(routes) {
  return async (path) => {
    if (routes[path] !== undefined) return routes[path];
    // Allow regex-keyed routes by checking each
    for (const [pattern, body] of Object.entries(routes)) {
      if (pattern.startsWith("re:")) {
        const re = new RegExp(pattern.slice(3));
        if (re.test(path)) return body;
      }
    }
    return [];
  };
}

test("ingestGitHubRepos emits review_comment signals on merged PRs (filters LGTM)", async () => {
  const home = await tmpHome();
  const repo = "example-user/agent-memory";
  const mergedAt = daysAgoIso(2);

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [
      { number: 7, merged_at: mergedAt, html_url: `https://github.com/${repo}/pull/7`, title: "Fix retry loop", user: { login: "alice" } },
    ],
    [`/repos/${repo}/pulls/7/comments`]: [
      {
        id: 1001,
        body: "LGTM!",
        user: { login: "bob" },
        created_at: mergedAt,
        path: "lib/foo.mjs",
        html_url: `https://github.com/${repo}/pull/7#discussion_r1001`,
      },
      {
        id: 1002,
        body: "This breaks when the input is null — guard required.",
        user: { login: "carol" },
        created_at: mergedAt,
        path: "lib/foo.mjs",
        html_url: `https://github.com/${repo}/pull/7#discussion_r1002`,
      },
      {
        id: 1003,
        body: "nit: rename this var",
        user: { login: "dave" },
        created_at: mergedAt,
        path: "lib/foo.mjs",
        html_url: `https://github.com/${repo}/pull/7#discussion_r1003`,
      },
    ],
    [`/repos/${repo}/issues/7/comments`]: [],
    [`/repos/${repo}/pulls/7/reviews`]: [],
    [`/repos/${repo}/commits?since=${encodeURIComponent(daysAgoIso(30).slice(0, 10))}&per_page=100`]: [],
    ["re:^/repos/" + repo.replace("/", "\\/") + "/commits"]: [],
  });

  const result = await ingestGitHubRepos({
    home,
    repos: [repo],
    since: 30,
    ghFetch,
    now: () => new Date(),
  });

  const signals = await readSignalsSince(paths(home).signals, 1);
  const reviewSignals = signals.filter((s) => s.type === "review_comment");
  assert.equal(reviewSignals.length, 1, "exactly one substantive comment emitted");
  assert.equal(reviewSignals[0].host, "github");
  assert.match(reviewSignals[0].summary, /breaks when the input is null/);
  assert.equal(reviewSignals[0].raw.repo, repo);
  assert.equal(reviewSignals[0].raw.pr, 7);
  assert.equal(reviewSignals[0].raw.comment_id, 1002);
  assert.ok(result.signalsWritten >= 1);
});

test("ingestGitHubRepos truncates review_comment summary to 200 chars", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";
  const longBody = "this is real critical feedback " + "x".repeat(500);
  const mergedAt = daysAgoIso(1);

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [
      { number: 1, merged_at: mergedAt, html_url: `https://github.com/${repo}/pull/1`, title: "x", user: { login: "a" } },
    ],
    [`/repos/${repo}/pulls/1/comments`]: [
      { id: 1, body: longBody, user: { login: "b" }, created_at: mergedAt, html_url: "x", path: "lib/foo.mjs" },
    ],
    [`/repos/${repo}/issues/1/comments`]: [],
    [`/repos/${repo}/pulls/1/reviews`]: [],
  });

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const signals = await readSignalsSince(paths(home).signals, 1);
  const rc = signals.find((s) => s.type === "review_comment");
  assert.ok(rc, "expected a review_comment signal");
  assert.ok(rc.summary.length <= 200, `summary too long: ${rc.summary.length}`);
});

test("ingestGitHubRepos skips PRs that are NOT merged", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";
  const closedAt = daysAgoIso(1);

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [
      // closed without merging
      { number: 5, merged_at: null, closed_at: closedAt, html_url: "x", title: "abandoned", user: { login: "a" } },
    ],
    // If the ingester incorrectly fetches comments on a non-merged PR,
    // we'd notice in signal output.
    [`/repos/${repo}/pulls/5/comments`]: [
      { id: 99, body: "this is substantive feedback that should never appear", user: { login: "b" }, created_at: closedAt, html_url: "x", path: "lib/foo.mjs" },
    ],
    [`/repos/${repo}/issues/5/comments`]: [],
    [`/repos/${repo}/pulls/5/reviews`]: [],
  });

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const signals = await readSignalsSince(paths(home).signals, 1);
  const reviewSignals = signals.filter((s) => s.type === "review_comment");
  assert.equal(reviewSignals.length, 0);
});

// ----- ingestGitHubRepos: revert detection --------------------------------

test("ingestGitHubRepos emits a revert signal on a Revert-prefixed commit", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": [
      {
        sha: "deadbeef",
        commit: { message: 'Revert "Add flaky retry path"\n\nThis reverts commit cafef00d.', author: { date: daysAgoIso(1) } },
        html_url: `https://github.com/${repo}/commit/deadbeef`,
      },
      {
        sha: "cafef00d",
        commit: { message: "Add flaky retry path", author: { date: daysAgoIso(2) } },
        html_url: `https://github.com/${repo}/commit/cafef00d`,
      },
    ],
  });

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const signals = await readSignalsSince(paths(home).signals, 1);
  const reverts = signals.filter((s) => s.type === "revert");
  assert.equal(reverts.length, 1);
  assert.equal(reverts[0].raw.repo, repo);
  assert.equal(reverts[0].raw.revert_sha, "deadbeef");
  assert.equal(reverts[0].raw.reverted_sha, "cafef00d");
  assert.match(reverts[0].summary, /Revert/i);
});

test("ingestGitHubRepos does NOT emit revert for a non-Revert commit", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": [
      {
        sha: "abc",
        commit: { message: "feat: new feature", author: { date: daysAgoIso(1) } },
        html_url: "x",
      },
    ],
  });

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const signals = await readSignalsSince(paths(home).signals, 1);
  assert.equal(signals.filter((s) => s.type === "revert").length, 0);
});

// ----- ingestGitHubRepos: hot_file ----------------------------------------

test("ingestGitHubRepos emits hot_file when a file is touched ≥N commits in window", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  // 5 commits, all touching lib/hot.mjs in the last 7 days → above default threshold (5/14d).
  const recentCommits = Array.from({ length: 6 }, (_, i) => ({
    sha: `c${i}`,
    commit: { message: `feat: change ${i}`, author: { date: daysAgoIso(i + 1) } },
    html_url: "x",
  }));

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": recentCommits,
    // Each commit's files endpoint
    [`/repos/${repo}/commits/c0`]: { sha: "c0", files: [{ filename: "lib/hot.mjs" }] },
    [`/repos/${repo}/commits/c1`]: { sha: "c1", files: [{ filename: "lib/hot.mjs" }] },
    [`/repos/${repo}/commits/c2`]: { sha: "c2", files: [{ filename: "lib/hot.mjs" }] },
    [`/repos/${repo}/commits/c3`]: { sha: "c3", files: [{ filename: "lib/hot.mjs" }] },
    [`/repos/${repo}/commits/c4`]: { sha: "c4", files: [{ filename: "lib/hot.mjs" }] },
    [`/repos/${repo}/commits/c5`]: { sha: "c5", files: [{ filename: "lib/cold.mjs" }] },
  });

  await ingestGitHubRepos({
    home,
    repos: [repo],
    since: 30,
    ghFetch,
    hotFileThreshold: 5,
    hotFileWindowDays: 14,
  });
  const signals = await readSignalsSince(paths(home).signals, 1);
  const hot = signals.filter((s) => s.type === "hot_file");
  assert.equal(hot.length, 1);
  assert.equal(hot[0].raw.repo, repo);
  assert.equal(hot[0].raw.path, "lib/hot.mjs");
  assert.equal(hot[0].raw.commit_count, 5);
});

test("ingestGitHubRepos does NOT emit hot_file when below threshold", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  const recentCommits = Array.from({ length: 3 }, (_, i) => ({
    sha: `c${i}`,
    commit: { message: `c ${i}`, author: { date: daysAgoIso(i + 1) } },
    html_url: "x",
  }));

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": recentCommits,
    [`/repos/${repo}/commits/c0`]: { sha: "c0", files: [{ filename: "lib/warm.mjs" }] },
    [`/repos/${repo}/commits/c1`]: { sha: "c1", files: [{ filename: "lib/warm.mjs" }] },
    [`/repos/${repo}/commits/c2`]: { sha: "c2", files: [{ filename: "lib/warm.mjs" }] },
  });

  await ingestGitHubRepos({
    home,
    repos: [repo],
    since: 30,
    ghFetch,
    hotFileThreshold: 5,
    hotFileWindowDays: 14,
  });
  const signals = await readSignalsSince(paths(home).signals, 1);
  assert.equal(signals.filter((s) => s.type === "hot_file").length, 0);
});

test("ingestGitHubRepos excludes lockfiles from hot_file accounting", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  const recentCommits = Array.from({ length: 10 }, (_, i) => ({
    sha: `c${i}`,
    commit: { message: `c ${i}`, author: { date: daysAgoIso(i + 1) } },
    html_url: "x",
  }));

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": recentCommits,
    [`/repos/${repo}/commits/c0`]: { sha: "c0", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c1`]: { sha: "c1", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c2`]: { sha: "c2", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c3`]: { sha: "c3", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c4`]: { sha: "c4", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c5`]: { sha: "c5", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c6`]: { sha: "c6", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c7`]: { sha: "c7", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c8`]: { sha: "c8", files: [{ filename: "package-lock.json" }] },
    [`/repos/${repo}/commits/c9`]: { sha: "c9", files: [{ filename: "package-lock.json" }] },
  });

  await ingestGitHubRepos({
    home,
    repos: [repo],
    since: 30,
    ghFetch,
    hotFileThreshold: 5,
    hotFileWindowDays: 14,
  });
  const signals = await readSignalsSince(paths(home).signals, 1);
  assert.equal(signals.filter((s) => s.type === "hot_file").length, 0);
});

// ----- ingestGitHubRepos: convention_change -------------------------------

test("ingestGitHubRepos emits convention_change for CLAUDE.md/AGENTS.md edits", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  const commit = {
    sha: "conv1",
    commit: { message: "docs: update conventions", author: { date: daysAgoIso(1) } },
    html_url: `https://github.com/${repo}/commit/conv1`,
  };

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": [commit],
    [`/repos/${repo}/commits/conv1`]: {
      sha: "conv1",
      files: [
        { filename: "CLAUDE.md", patch: "@@ -1,3 +1,4 @@\n+new rule about feature branches", status: "modified" },
      ],
    },
  });

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const signals = await readSignalsSince(paths(home).signals, 1);
  const cc = signals.filter((s) => s.type === "convention_change");
  assert.equal(cc.length, 1);
  assert.equal(cc[0].raw.repo, repo);
  assert.equal(cc[0].raw.path, "CLAUDE.md");
  assert.equal(cc[0].raw.sha, "conv1");
  assert.match(cc[0].summary, /CLAUDE\.md/);
});

test("ingestGitHubRepos emits convention_change for knowledge/*.md edits", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  const commit = {
    sha: "kn1",
    commit: { message: "kb: anti-patterns update", author: { date: daysAgoIso(1) } },
    html_url: "x",
  };

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": [commit],
    [`/repos/${repo}/commits/kn1`]: {
      sha: "kn1",
      files: [{ filename: "knowledge/anti-patterns.md", patch: "@@ ...", status: "modified" }],
    },
  });

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const signals = await readSignalsSince(paths(home).signals, 1);
  const cc = signals.filter((s) => s.type === "convention_change");
  assert.equal(cc.length, 1);
  assert.equal(cc[0].raw.path, "knowledge/anti-patterns.md");
});

test("ingestGitHubRepos does NOT emit convention_change for README.md", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": [
      { sha: "r1", commit: { message: "docs: readme", author: { date: daysAgoIso(1) } }, html_url: "x" },
    ],
    [`/repos/${repo}/commits/r1`]: { sha: "r1", files: [{ filename: "README.md", patch: "@@ ...", status: "modified" }] },
  });

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const signals = await readSignalsSince(paths(home).signals, 1);
  assert.equal(signals.filter((s) => s.type === "convention_change").length, 0);
});

// ----- ingestGitHubRepos: state-based dedup -------------------------------

test("ingestGitHubRepos dedupes against ingest-state on second run", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";
  const mergedAt = daysAgoIso(1);

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [
      { number: 9, merged_at: mergedAt, html_url: "x", title: "t", user: { login: "a" } },
    ],
    [`/repos/${repo}/pulls/9/comments`]: [
      { id: 555, body: "Real critical pushback — this allocates O(n^2).", user: { login: "b" }, created_at: mergedAt, html_url: "x", path: "lib/foo.mjs" },
    ],
    [`/repos/${repo}/issues/9/comments`]: [],
    [`/repos/${repo}/pulls/9/reviews`]: [],
    "re:^/repos/example-user/x/commits": [],
  });

  // First run writes a signal
  const r1 = await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  assert.ok(r1.signalsWritten >= 1, "first run should write at least one signal");

  // Second run: same data, should not duplicate
  const r2 = await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const reviewSignals = (await readSignalsSince(paths(home).signals, 1)).filter(
    (s) => s.type === "review_comment",
  );
  assert.equal(reviewSignals.length, 1, "no duplicate review_comment");
  assert.equal(r2.signalsWritten, 0, "second run writes no signals");
});

test("ingestGitHubRepos updates last_processed_commit_sha after a run", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";

  const ghFetch = fakeGhFetch({
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [],
    "re:^/repos/example-user/x/commits\\?since=": [
      { sha: "newest", commit: { message: "feat", author: { date: daysAgoIso(1) } }, html_url: "x" },
      { sha: "older", commit: { message: "feat", author: { date: daysAgoIso(2) } }, html_url: "x" },
    ],
    [`/repos/${repo}/commits/newest`]: { sha: "newest", files: [{ filename: "lib/x.mjs" }] },
    [`/repos/${repo}/commits/older`]: { sha: "older", files: [{ filename: "lib/x.mjs" }] },
  });

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch });
  const state = await loadIngestState(home);
  assert.equal(state.repos[repo].last_processed_commit_sha, "newest");
});

// ----- ingestGitHubRepos: per-repo PR cap ---------------------------------

test("ingestGitHubRepos caps PR processing at maxPrsPerRepo", async () => {
  const home = await tmpHome();
  const repo = "example-user/x";
  const mergedAt = daysAgoIso(1);

  // 100 merged PRs returned; default cap is 50, custom cap is 3.
  const prs = Array.from({ length: 100 }, (_, i) => ({
    number: i + 1,
    merged_at: mergedAt,
    html_url: "x",
    title: `pr ${i + 1}`,
    user: { login: "a" },
  }));

  const calls = { comments: 0 };
  const ghFetch = async (path) => {
    if (path.includes("/pulls?state=closed")) return prs;
    if (/\/pulls\/\d+\/comments/.test(path)) {
      calls.comments += 1;
      return [];
    }
    if (/\/issues\/\d+\/comments/.test(path)) return [];
    if (/\/pulls\/\d+\/reviews/.test(path)) return [];
    return [];
  };

  await ingestGitHubRepos({ home, repos: [repo], since: 30, ghFetch, maxPrsPerRepo: 3 });
  assert.equal(calls.comments, 3, "should only fetch comments for first 3 PRs");
});

// ----- ingestGitHubRepos: error tolerance ---------------------------------

test("ingestGitHubRepos surfaces a clear error when ghFetch throws", async () => {
  const home = await tmpHome();
  const ghFetch = async () => {
    throw new Error("rate limited");
  };
  // Should not crash hard — return errors[] instead.
  const result = await ingestGitHubRepos({ home, repos: ["example-user/x"], since: 30, ghFetch });
  assert.equal(result.signalsWritten, 0);
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /rate limited/);
});
