import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCandidate } from "../lib/storage.mjs";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/agentmem.mjs", import.meta.url));

async function run(home, ...args) {
  return execFileAsync("node", [BIN, ...args], { env: { ...process.env, AGENTMEM_HOME: home } });
}

async function tmpHome() {
  return await mkdtemp(join(tmpdir(), "agentmem-cli-"));
}

test("init creates the store and reports success", async () => {
  const home = await tmpHome();
  const { stdout } = await run(home, "init");
  assert.match(stdout, /Initialized agentmem/);
});

test("status on a fresh store shows zero counts", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { stdout } = await run(home, "status");
  assert.match(stdout, /Active lessons:\s+0/);
  assert.match(stdout, /Pending candidates:\s+0/);
});

test("signal records and is reflected in status", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { stdout: sigOut } = await run(home, "signal", "correction", "use the Grep tool");
  assert.match(sigOut, /signal recorded: correction/);
  const { stdout: statusOut } = await run(home, "status");
  assert.match(statusOut, /Signals \(7d\):\s+1/);
});

test("promote moves a candidate into active lessons and exports AGENTS.md", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: { id: "demo", title: "Always lint before commit", category: "workflow", confidence: 0.35, scope: { repos: ["*"] } },
    body: "**Rule:** run the linter before committing.",
  });
  const { stdout: promoteOut } = await run(home, "promote", "demo");
  assert.match(promoteOut, /promoted: demo/);

  const { stdout: listOut } = await run(home, "list");
  assert.match(listOut, /demo/);
  assert.match(listOut, /Always lint before commit/);

  const agents = await readFile(join(home, "AGENTS.md"), "utf8");
  assert.match(agents, /BEGIN agentmem lessons/);
  assert.match(agents, /run the linter before committing/);
});

test("promote all promotes every pending candidate and exports once", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: { id: "bulk-a", title: "Rule A", category: "workflow", confidence: 0.4, scope: { repos: ["*"] } },
    body: "**Rule:** A.",
  });
  await writeCandidate(home, {
    meta: { id: "bulk-b", title: "Rule B", category: "code", confidence: 0.5, scope: { repos: ["*"] } },
    body: "**Rule:** B.",
  });
  await writeCandidate(home, {
    meta: { id: "bulk-c", title: "Rule C", category: "behavioral", confidence: 0.6, scope: { repos: ["*"] } },
    body: "**Rule:** C.",
  });

  const { stdout } = await run(home, "promote", "all");
  assert.match(stdout, /promoted 3/);
  assert.match(stdout, /bulk-a/);
  assert.match(stdout, /bulk-b/);
  assert.match(stdout, /bulk-c/);

  const { stdout: listOut } = await run(home, "list");
  assert.match(listOut, /Rule A/);
  assert.match(listOut, /Rule B/);
  assert.match(listOut, /Rule C/);

  const agents = await readFile(join(home, "AGENTS.md"), "utf8");
  assert.match(agents, /Rule A/);
  assert.match(agents, /Rule B/);
  assert.match(agents, /Rule C/);

  const index = await readFile(join(home, "INDEX.md"), "utf8");
  assert.match(index, /Rule A/);
  assert.match(index, /Rule B/);
  assert.match(index, /Rule C/);
});

test("promote all is a no-op when there are no candidates", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { stdout } = await run(home, "promote", "all");
  assert.match(stdout, /no candidates/i);
});

test("inject prints scoped lessons as bullet lines", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: { id: "g", title: "Global rule", category: "behavioral", confidence: 0.9, scope: { repos: ["*"] } },
    body: "**Rule:** be concise.",
  });
  await run(home, "promote", "g");
  const { stdout } = await run(home, "inject", "--scope", "/Users/x/code/whatever");
  assert.match(stdout, /Global rule/);
});

test("unknown command prints usage", async () => {
  const home = await tmpHome();
  const { stdout } = await run(home, "frobnicate");
  assert.match(stdout, /Usage: agentmem/);
});

test("inject --scope with no value errors instead of using 'undefined'", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await assert.rejects(
    () => run(home, "inject", "--scope"),
    (err) => /--scope requires/i.test(err.stderr || err.message),
  );
});

test("help lists the new reflect/ingest commands", async () => {
  const home = await tmpHome();
  const { stdout } = await run(home, "help");
  assert.match(stdout, /reflect/);
  assert.match(stdout, /ingest/);
});

test("reflect fails clearly when no API key source is available", async () => {
  const home = await tmpHome();
  await run(home, "init");
  // Append a signal so reflect actually tries to construct a client (otherwise
  // it skips on min_signals_to_reflect and the resolver is never called).
  const { appendSignal } = await import("../lib/signals.mjs");
  const { paths } = await import("../lib/storage.mjs");
  for (let i = 0; i < 3; i++) {
    await appendSignal(paths(home).signals, {
      host: "claude-code",
      type: "correction",
      summary: `test signal ${i}`,
    });
  }
  // PATH without /usr/bin so the `security` CLI isn't found → keychain reader
  // fails → resolver throws the clear "no API key" error. /bin is kept so any
  // Node-internal subprocess that needs /bin/sh still works.
  const sandboxedPath = "/usr/local/bin:/opt/homebrew/bin:/bin";
  await assert.rejects(
    () =>
      execFileAsync("node", [BIN, "reflect"], {
        env: {
          AGENTMEM_HOME: home,
          AGENTMEM_API_KEY: "",
          PATH: sandboxedPath,
          HOME: process.env.HOME,
        },
      }),
    (err) => {
      const out = err.stderr || err.message;
      return /no Anthropic API key/i.test(out) && /security add-generic-password/.test(out);
    },
  );
});

test("help lists the new coach commands", async () => {
  const home = await tmpHome();
  const { stdout } = await run(home, "help");
  assert.match(stdout, /coach/);
});

test("coach list shows pending recommendations", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "2026-05-31-x", title: "Use plan mode", severity: "high",
    category: "feature_miss", body: "b", evidence: ["1", "2"], next_step: "s",
  });
  const { stdout } = await run(home, "coach", "list");
  assert.match(stdout, /Use plan mode/);
  assert.match(stdout, /high/);
});

test("coach (bare) is the same as coach list", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "2026-05-31-y", title: "Use hooks", severity: "medium",
    category: "feature_miss", body: "b", evidence: ["1", "2"], next_step: "s",
  });
  const { stdout } = await run(home, "coach");
  assert.match(stdout, /Use hooks/);
});

test("coach show prints the full rec markdown", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "2026-05-31-z", title: "Show me", severity: "low",
    category: "anti_pattern", body: "Detail body.", evidence: ["1", "2"], next_step: "s",
  });
  const { stdout } = await run(home, "coach", "show", "2026-05-31-z");
  assert.match(stdout, /id: 2026-05-31-z/);
  assert.match(stdout, /Detail body/);
});

test("coach show all prints every pending recommendation, skipping non-pending", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation, setRecommendationStatus } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "r-show-1", title: "First tip", severity: "high", category: "feature_miss",
    body: "Body of first.", evidence: ["1", "2"], next_step: "do x",
  });
  await writeRecommendation(home, {
    id: "r-show-2", title: "Second tip", severity: "medium", category: "feature_miss",
    body: "Body of second.", evidence: ["1", "2"], next_step: "do y",
  });
  await writeRecommendation(home, {
    id: "r-show-dis", title: "Dismissed tip", severity: "low", category: "feature_miss",
    body: "Body of dismissed.", evidence: ["1", "2"], next_step: "do z",
  });
  await setRecommendationStatus(home, "r-show-dis", "dismissed");

  const { stdout } = await run(home, "coach", "show", "all");
  assert.match(stdout, /r-show-1/);
  assert.match(stdout, /First tip/);
  assert.match(stdout, /Body of first/);
  assert.match(stdout, /r-show-2/);
  assert.match(stdout, /Second tip/);
  assert.match(stdout, /Body of second/);
  assert.doesNotMatch(stdout, /Dismissed tip/);
  assert.doesNotMatch(stdout, /Body of dismissed/);

  // Records are separated by exactly one `---` line surrounded by single
  // blank lines — not the triple-blank-line block that a naive
  // console.log(text) of a trailing-newline file would produce.
  assert.doesNotMatch(stdout, /\n\n\n---/);
  assert.doesNotMatch(stdout, /---\n\n\n/);
  assert.match(stdout, /\n---\n/);
});

test("coach show all is a no-op when nothing is pending", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { stdout } = await run(home, "coach", "show", "all");
  assert.match(stdout, /no pending/i);
});

test("coach accept updates status to accepted", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation, getRecommendationStatus } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "r-acc", title: "T", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  const { stdout } = await run(home, "coach", "accept", "r-acc");
  assert.match(stdout, /accepted/i);
  assert.equal(await getRecommendationStatus(home, "r-acc"), "accepted");
});

test("coach accept all accepts every pending recommendation", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation, getRecommendationStatus, setRecommendationStatus } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "r-bulk-1", title: "T1", severity: "high", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await writeRecommendation(home, {
    id: "r-bulk-2", title: "T2", severity: "medium", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await writeRecommendation(home, {
    id: "r-bulk-3", title: "T3", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  // A dismissed rec must stay dismissed (bulk only touches pending).
  await writeRecommendation(home, {
    id: "r-bulk-dis", title: "T4", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await setRecommendationStatus(home, "r-bulk-dis", "dismissed");

  const { stdout } = await run(home, "coach", "accept", "all");
  assert.match(stdout, /accepted 3/i);

  assert.equal(await getRecommendationStatus(home, "r-bulk-1"), "accepted");
  assert.equal(await getRecommendationStatus(home, "r-bulk-2"), "accepted");
  assert.equal(await getRecommendationStatus(home, "r-bulk-3"), "accepted");
  assert.equal(await getRecommendationStatus(home, "r-bulk-dis"), "dismissed");
});

test("coach accept all is a no-op when nothing is pending", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { stdout } = await run(home, "coach", "accept", "all");
  assert.match(stdout, /no pending/i);
});

test("coach dismiss is sticky", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation, getRecommendationStatus } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "r-dis", title: "T", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await run(home, "coach", "dismiss", "r-dis");
  assert.equal(await getRecommendationStatus(home, "r-dis"), "dismissed");
});

test("coach snooze N days sets status + snooze_until", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation, getRecommendation } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "r-sno", title: "T", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  const { stdout } = await run(home, "coach", "snooze", "r-sno", "14");
  assert.match(stdout, /snoozed/i);
  const r = await getRecommendation(home, "r-sno");
  assert.equal(r.meta.status, "snoozed");
  assert.match(r.meta.snooze_until, /^\d{4}-\d{2}-\d{2}$/);
});

test("coach weekly writes a digest file", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeRecommendation } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "rw1", title: "Weekly1", severity: "high", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  const { stdout } = await run(home, "coach", "weekly");
  assert.match(stdout, /weekly/i);
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(home, "recommendations", "weekly"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}\.md$/);
});

test("coach run fails clearly when no API key source is available", async () => {
  const home = await tmpHome();
  await run(home, "init");
  // Seed at least one signal so the pass tries to construct a client.
  const { appendSignal } = await import("../lib/signals.mjs");
  const { paths } = await import("../lib/storage.mjs");
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "x",
  });
  const sandboxedPath = "/usr/local/bin:/opt/homebrew/bin:/bin";
  await assert.rejects(
    () =>
      execFileAsync("node", [BIN, "coach", "run"], {
        env: {
          AGENTMEM_HOME: home,
          AGENTMEM_API_KEY: "",
          PATH: sandboxedPath,
          HOME: process.env.HOME,
        },
      }),
    (err) => {
      const out = err.stderr || err.message;
      return /no Anthropic API key/i.test(out);
    },
  );
});

test("ingest with no projects dir reports zero signals (no crash)", async () => {
  const home = await tmpHome();
  await run(home, "init");
  // Write a config that points at a nonexistent projects dir
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(home, "config.json"), JSON.stringify({
    reflection: { lookback_days: 7 },
    sources: { claude_code_projects_dir: "/definitely/not/here" },
  }));
  const { stdout } = await run(home, "ingest", "--since", "7d");
  assert.match(stdout, /wrote 0 signal/);
});

test("ingest --source github with empty watch_repos is a no-op", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(home, "config.json"), JSON.stringify({
    watch_repos: [],
  }));
  const { stdout } = await run(home, "ingest", "--source", "github");
  assert.match(stdout, /watch_repos is empty/);
});

test("ingest --source rejects unknown source values", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await assert.rejects(
    () => run(home, "ingest", "--source", "twitter"),
    (err) => /unsupported --source/.test(err.stderr || err.message),
  );
});

test("help mentions the new --source github flag", async () => {
  const home = await tmpHome();
  const { stdout } = await run(home, "help");
  assert.match(stdout, /--source github/);
});

test("obsidian sync reports skip when config is not enabled", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { stdout } = await run(home, "obsidian", "sync");
  assert.match(stdout, /obsidian: skipped/);
  assert.match(stdout, /not enabled/);
});

test("obsidian sync writes pending.md when enabled and prints the path", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { mkdtemp: mkdtempFn, writeFile: writeFileFs } = await import("node:fs/promises");
  const { tmpdir: tmpdirFn } = await import("node:os");
  const vault = await mkdtempFn(join(tmpdirFn(), "obs-vault-"));
  await writeFileFs(
    join(home, "config.json"),
    JSON.stringify({ obsidian: { enabled: true, vault_path: vault, project_dir: "p" } }, null, 2),
  );
  const { stdout } = await run(home, "obsidian", "sync");
  assert.match(stdout, /pending: /);
  assert.match(stdout, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// --- list -------------------------------------------------------------------

test("list reports when there are no active lessons", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { stdout } = await run(home, "list");
  assert.match(stdout, /No active lessons\./);
});

test("list --candidates shows pending candidates and reports empty otherwise", async () => {
  const home = await tmpHome();
  await run(home, "init");

  const { stdout: emptyOut } = await run(home, "list", "--candidates");
  assert.match(emptyOut, /No candidates\./);

  await writeCandidate(home, {
    meta: { id: "cand-1", title: "Pending rule", category: "workflow", confidence: 0.35, scope: { repos: ["*"] } },
    body: "**Rule:** stay pending.",
  });
  const { stdout } = await run(home, "list", "--candidates");
  assert.match(stdout, /cand-1/);
  assert.match(stdout, /\[workflow\]/);
  assert.match(stdout, /0\.35/);
  assert.match(stdout, /Pending rule/);
});

// --- show -------------------------------------------------------------------

test("show prints a candidate's serialized frontmatter and body", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: { id: "show-me", title: "Showable rule", category: "code", confidence: 0.5, scope: { repos: ["*"] } },
    body: "**Rule:** be visible.",
  });
  const { stdout } = await run(home, "show", "show-me");
  assert.match(stdout, /id: show-me/);
  assert.match(stdout, /Showable rule/);
  assert.match(stdout, /be visible/);
});

test("show without an id errors with usage", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await assert.rejects(
    () => run(home, "show"),
    (err) => /usage: agentmem show/i.test(err.stderr || err.message),
  );
});

test("show with an unknown id errors with Not found", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await assert.rejects(
    () => run(home, "show", "nope"),
    (err) => /not found: nope/i.test(err.stderr || err.message),
  );
});

// --- reject -----------------------------------------------------------------

test("reject discards a candidate so it no longer lists", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: { id: "junk", title: "Drop me", category: "behavioral", confidence: 0.35, scope: { repos: ["*"] } },
    body: "**Rule:** discard.",
  });

  const { stdout } = await run(home, "reject", "junk");
  assert.match(stdout, /rejected: junk/);

  const { stdout: listOut } = await run(home, "list", "--candidates");
  assert.match(listOut, /No candidates\./);
});

test("reject without an id errors with usage", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await assert.rejects(
    () => run(home, "reject"),
    (err) => /usage: agentmem reject/i.test(err.stderr || err.message),
  );
});

// --- retire -----------------------------------------------------------------

test("retire archives an active lesson and removes it from the list", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: { id: "old", title: "Stale rule", category: "workflow", confidence: 0.6, scope: { repos: ["*"] } },
    body: "**Rule:** no longer relevant.",
  });
  await run(home, "promote", "old");

  const { stdout } = await run(home, "retire", "old");
  assert.match(stdout, /retired: old/);

  const { stdout: listOut } = await run(home, "list");
  assert.match(listOut, /No active lessons\./);

  const archived = await readFile(join(home, "archive", "old.md"), "utf8");
  assert.match(archived, /no longer relevant/);
});

test("retire of an unknown lesson errors", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await assert.rejects(
    () => run(home, "retire", "ghost"),
    (err) => /lesson not found: ghost/i.test(err.stderr || err.message),
  );
});

// --- export -----------------------------------------------------------------

test("export regenerates the AGENTS.md lessons block and prints the path", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: { id: "exp", title: "Exportable rule", category: "code", confidence: 0.7, scope: { repos: ["*"] } },
    body: "**Rule:** export me.",
  });
  await run(home, "promote", "exp");

  const { stdout } = await run(home, "export");
  assert.match(stdout, /exported lessons to/);
  assert.match(stdout, /AGENTS\.md/);

  const agents = await readFile(join(home, "AGENTS.md"), "utf8");
  assert.match(agents, /BEGIN agentmem lessons/);
  assert.match(agents, /export me/);
});

// --- reindex ----------------------------------------------------------------

test("reindex rebuilds INDEX.md to reflect active lessons", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: { id: "idx", title: "Indexable rule", category: "behavioral", confidence: 0.8, scope: { repos: ["*"] } },
    body: "**Rule:** index me.",
  });
  await run(home, "promote", "idx");

  // promote already reindexes; reindex on its own must be idempotent and keep the entry.
  await run(home, "reindex");
  const index = await readFile(join(home, "INDEX.md"), "utf8");
  assert.match(index, /Indexable rule/);
});

// --- SOU-30: the digest command --------------------------------------------

test("digest on a fresh store writes nothing and says so", async () => {
  const home = await tmpHome();
  await run(home, "init");
  const { stdout } = await run(home, "digest", "--no-ledger");
  assert.match(stdout, /nothing to do/i);
});

test("digest lists pending candidates and writes the dated file", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: {
      id: "2026-08-01-use-the-grep-tool",
      title: "Use the Grep tool",
      category: "workflow",
      confidence: 0.35,
      created: "2026-08-01",
      source: "reflection",
      scope: { repos: ["callelo"] },
    },
    body: "**Rule:** use it.",
  });

  const { stdout } = await run(home, "digest", "--no-ledger");
  assert.match(stdout, /2026-08-01-use-the-grep-tool/);

  const today = new Date().toISOString().slice(0, 10);
  const written = await readFile(join(home, "digest", `${today}.md`), "utf8");
  assert.match(written, /Use the Grep tool/);
});

test("digest appears in the usage text", async () => {
  const home = await tmpHome();
  const { stdout } = await run(home, "help");
  assert.match(stdout, /^\s+digest\b/m);
});

// `--cap ""` used to coerce to 0 via Number(""), so a wrapper invoking
// `agentmem digest --cap "$UNSET_VAR"` reported "nothing to do" and exited 0
// with a full backlog — silent death in the feature built to defeat silent death.
test("digest --cap rejects values that are not non-negative integers", async () => {
  const home = await tmpHome();
  await run(home, "init");

  for (const bad of ["", " ", "abc", "-1", "3.5", "Infinity", "1e3"]) {
    await assert.rejects(
      () => run(home, "digest", "--no-ledger", "--cap", bad),
      (e) => /non-negative integer/.test(e.stderr ?? ""),
      `--cap ${JSON.stringify(bad)} should have been rejected`,
    );
  }
  await assert.rejects(() => run(home, "digest", "--no-ledger", "--cap"), /./);
});

test("digest --cap limits how many candidates are listed", async () => {
  const home = await tmpHome();
  await run(home, "init");
  for (const d of ["01", "02", "03"]) {
    await writeCandidate(home, {
      meta: {
        id: `2026-08-${d}-item`,
        title: `Item ${d}`,
        category: "workflow",
        confidence: 0.35,
        created: `2026-08-${d}`,
        source: "reflection",
        scope: { repos: ["callelo"] },
      },
      body: "**Rule:** x.",
    });
  }

  const { stdout } = await run(home, "digest", "--no-ledger", "--cap", "2");
  assert.match(stdout, /2026-08-01-item/);
  assert.match(stdout, /2026-08-02-item/);
  assert.doesNotMatch(stdout, /2026-08-03-item/);
});

// The stdout of `agentmem digest` reaches a terminal, a launchd log, or an
// agent that ran the command inside a session — the same sink render() flattens
// for. A raw title can inject structure into it.
test("digest stdout flattens a hostile title", async () => {
  const home = await tmpHome();
  await run(home, "init");
  await writeCandidate(home, {
    meta: {
      id: "2026-08-01-hostile",
      title: "Benign\n\n## INJECTED HEADING\n\n```bash\nrm -rf ~\n```",
      category: "workflow",
      confidence: 0.35,
      created: "2026-08-01",
      source: "reflection",
      scope: { repos: ["callelo"] },
    },
    body: "**Rule:** x.",
  });

  const { stdout } = await run(home, "digest", "--no-ledger");
  const injected = stdout.split("\n").filter((l) => /^(## |```)/.test(l));
  assert.deepEqual(injected, [], `structure escaped into stdout: ${JSON.stringify(injected)}`);
  assert.match(stdout, /INJECTED HEADING/, "the text should survive, just not the structure");
});

// ---------------------------------------------------------------------------
// --no-ledger must actually suppress the network check.
//
// Without it every digest test in this file reaches GitHub — which is how this
// was caught: adding the check turned "digest on a fresh store writes nothing"
// into a live API call that returned 14 real PRs.
//
// The assertion is offline by construction. With no `gh` on PATH and no token,
// a check that DID run resolves no fetcher and renders "could not run". So the
// absence of that string is positive evidence the flag was honoured, not just
// the absence of a symptom.
// ---------------------------------------------------------------------------

test("digest --no-ledger runs no close-out check at all", async () => {
  const home = await tmpHome();
  await execFileAsync(process.execPath, [BIN, "init"], { env: { ...process.env, AGENTMEM_HOME: home } });
  await writeFile(join(home, "reflections", "2026-08-06-07-15-00.md"), "# r\n");

  const { stdout } = await execFileAsync(process.execPath, [BIN, "digest", "--no-ledger"], {
    env: {
      ...process.env,
      AGENTMEM_HOME: home,
      PATH: "/nonexistent",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
  });

  assert.doesNotMatch(stdout, /could not run/i, "the check must not have been attempted");
  assert.match(stdout, /nothing to do/i);
});

test("digest without --no-ledger DOES attempt the check, and reports why it could not run", async () => {
  const home = await tmpHome();
  await execFileAsync(process.execPath, [BIN, "init"], { env: { ...process.env, AGENTMEM_HOME: home } });
  await writeFile(join(home, "reflections", "2026-08-06-07-15-00.md"), "# r\n");

  // Same offline environment — so this exercises the default path without a
  // network call, and pins that the default IS to check.
  const { stdout } = await execFileAsync(process.execPath, [BIN, "digest"], {
    env: {
      ...process.env,
      AGENTMEM_HOME: home,
      PATH: "/nonexistent",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
  });

  assert.match(stdout, /close-out check could not run/i);
  assert.match(stdout, /credential|gh auth|GITHUB_TOKEN/i, "say what is missing");
});

test("--no-ledger is documented in the usage text", async () => {
  const { stdout } = await run(await tmpHome(), "help");
  assert.match(stdout, /--no-ledger/);
});

// The CLI summary had two of render()'s three ledger states. The third —
// "scan incomplete, but nothing missing in what I did see" — printed NOTHING,
// so `agentmem digest` reported a bare path with no reason a file was written.
// Reproduced end-to-end before fixing: a fake `gh` on PATH drives the real
// resolveProductionFetcher -> ghCliFetch path with no network.
test("digest CLI reports an incomplete sweep instead of printing nothing", async () => {
  const home = await tmpHome();
  await execFileAsync(process.execPath, [BIN, "init"], {
    env: { ...process.env, AGENTMEM_HOME: home },
  });
  await writeFile(join(home, "reflections", "2026-08-06-07-15-00.md"), "# r\n");

  const bin = await mkdtemp(join(tmpdir(), "agentmem-fakegh-"));
  const ledger = "# Review findings ledger\n\n| #600 | Code | x | y |\n";
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env bash\n` +
      `if [ "$1" = "auth" ]; then exit 0; fi\n` +
      `case "$2" in\n` +
      `  */contents/*) printf '{"encoding":"base64","content":"%s"}\\n' ` +
      `"${Buffer.from(ledger, "utf8").toString("base64")}" ;;\n` +
      `  */pulls*) echo '[{"number":600,"title":"CAL-1: cited feature PR",` +
      `"merged_at":"2026-08-01T00:00:00Z"}]' ;;\n` +
      `esac\nexit 0\n`,
    { mode: 0o755 },
  );

  const { stdout } = await execFileAsync(process.execPath, [BIN, "digest"], {
    env: { ...process.env, AGENTMEM_HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.match(stdout, /600/, "name where the sweep stopped");
  assert.match(stdout, /not checked|incomplete|stopped/i);
});
