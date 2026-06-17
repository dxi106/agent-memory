import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, paths } from "../lib/storage.mjs";
import { appendSignal } from "../lib/signals.mjs";
import {
  loadKnowledgeBase,
  collectUsageStats,
  buildCoachingPrompt,
  parseCoachResponse,
  writeRecommendation,
  listRecommendations,
  getRecommendation,
  getRecommendationStatus,
  setRecommendationStatus,
  runCoachingPass,
  weeklyDigest,
  isDismissed,
  isSnoozed,
} from "../lib/coach.mjs";

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-coach-"));
  await ensureLayout(home);
  await writeFile(join(home, "config.json"), JSON.stringify({
    coaching: {
      lookback_days: 7,
      model: "claude-sonnet-4-6",
      max_recommendations_per_run: 8,
      min_evidence_per_recommendation: 2,
    },
  }));
  return home;
}

function fakeClient(handler) {
  return {
    messages: {
      create: handler,
    },
  };
}

function jsonResponse(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    stop_reason: "end_turn",
  };
}

async function seedKnowledge(home) {
  const kdir = paths(home).knowledge;
  await mkdir(kdir, { recursive: true });
  await writeFile(join(kdir, "claude-code-features.md"), [
    "# Claude Code features",
    "",
    "preamble text",
    "",
    "---",
    "",
    "## Plan mode",
    "",
    "**What:** Plan mode does X.",
    "**Miss-signature:** Many edits without EnterPlanMode.",
    "",
    "---",
    "",
    "## Hooks",
    "",
    "**What:** Hooks do Y.",
    "**Miss-signature:** Repeated manual lint commands.",
    "",
  ].join("\n"));
  await writeFile(join(kdir, "anthropic-best-practices.md"), [
    "# Best practices",
    "",
    "## Test-driven development",
    "",
    "**What:** Write the failing test first.",
    "**Skip-signature:** Code without tests.",
    "",
  ].join("\n"));
  await writeFile(join(kdir, "anti-patterns.md"), [
    "# Anti-patterns",
    "",
    "## Apologizing instead of fixing",
    "",
    "**What it looks like:** Multiple apologies in one turn.",
    "**Counter-pattern:** Fix, don't apologize.",
    "",
  ].join("\n"));
}

// ------ loadKnowledgeBase ------

test("loadKnowledgeBase parses each markdown file into entries split on ^## boundaries", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  const kb = await loadKnowledgeBase(home);
  assert.equal(kb.features.length, 2);
  assert.equal(kb.features[0].name, "Plan mode");
  assert.match(kb.features[0].body, /Plan mode does X/);
  assert.equal(kb.features[1].name, "Hooks");

  assert.equal(kb.bestPractices.length, 1);
  assert.equal(kb.bestPractices[0].name, "Test-driven development");

  assert.equal(kb.antiPatterns.length, 1);
  assert.equal(kb.antiPatterns[0].name, "Apologizing instead of fixing");
});

test("loadKnowledgeBase returns empty arrays when knowledge dir is empty", async () => {
  const home = await tmpHome();
  const kb = await loadKnowledgeBase(home);
  assert.deepEqual(kb, { features: [], bestPractices: [], antiPatterns: [] });
});

// ------ collectUsageStats ------

test("collectUsageStats aggregates tool / signal / session / cwd stats", async () => {
  const signals = [
    { ts: "2026-05-29T10:00:00Z", type: "tool", tool: "Bash", session: "s1", cwd: "/r/a", summary: "grep" },
    { ts: "2026-05-29T10:01:00Z", type: "tool", tool: "Bash", session: "s1", cwd: "/r/a", summary: "grep" },
    { ts: "2026-05-29T10:02:00Z", type: "tool", tool: "Edit", session: "s2", cwd: "/r/b", summary: "file" },
    { ts: "2026-05-29T11:00:00Z", type: "correction", session: "s1", cwd: "/r/a", summary: "no, use Grep" },
  ];
  const stats = collectUsageStats(signals);
  assert.equal(stats.totalSignals, 4);
  assert.equal(stats.byType.tool, 3);
  assert.equal(stats.byType.correction, 1);
  assert.equal(stats.byTool.Bash, 2);
  assert.equal(stats.byTool.Edit, 1);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.cwds, 2);
});

test("collectUsageStats handles empty signal list", () => {
  const stats = collectUsageStats([]);
  assert.equal(stats.totalSignals, 0);
  assert.deepEqual(stats.byType, {});
  assert.deepEqual(stats.byTool, {});
});

// ------ buildCoachingPrompt ------

test("buildCoachingPrompt places knowledge + format spec in cache-eligible system and signals in user", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  const knowledge = await loadKnowledgeBase(home);
  const signals = [{ ts: "2026-05-29T10:00:00Z", type: "tool", tool: "Bash", summary: "grep foo" }];
  const stats = collectUsageStats(signals);
  const req = buildCoachingPrompt({
    signals,
    lessons: [],
    knowledge,
    usageStats: stats,
    model: "claude-sonnet-4-6",
  });
  assert.equal(req.model, "claude-sonnet-4-6");
  assert.ok(Array.isArray(req.system));
  // Stable prefix carries the cache breakpoint.
  const last = req.system[req.system.length - 1];
  assert.equal(last.cache_control?.type, "ephemeral");
  // Knowledge content reaches the system blocks.
  const sysText = req.system.map((b) => b.text).join("\n");
  assert.match(sysText, /Plan mode/);
  assert.match(sysText, /Apologizing instead of fixing/);
  // Volatile signals + stats live in the user message.
  const userText = req.messages[0].content;
  assert.match(userText, /grep foo/);
});

// ------ parseCoachResponse ------

test("parseCoachResponse extracts a recommendations array", () => {
  const raw = JSON.stringify({
    recommendations: [
      {
        id: "2026-05-31-use-plan-mode",
        title: "Use plan mode for multi-file changes",
        severity: "high",
        category: "feature_miss",
        body: "You edited foo.js 5 times without planning.",
        evidence: ["session A: 5 Edits to foo.js", "session B: 3 Edits to foo.js"],
        next_step: "Try /plan first next time.",
      },
    ],
  });
  const out = parseCoachResponse(raw);
  assert.equal(out.recommendations.length, 1);
  assert.equal(out.recommendations[0].id, "2026-05-31-use-plan-mode");
  assert.equal(out.recommendations[0].evidence.length, 2);
});

test("parseCoachResponse tolerates a code-fence wrapping", () => {
  const raw = "```json\n" + JSON.stringify({ recommendations: [] }) + "\n```";
  const out = parseCoachResponse(raw);
  assert.deepEqual(out.recommendations, []);
});

test("parseCoachResponse drops recommendations with fewer than 2 evidence entries", () => {
  const raw = JSON.stringify({
    recommendations: [
      { id: "2026-05-31-a", title: "A", severity: "high", category: "feature_miss", body: "x", evidence: ["only one"], next_step: "x" },
      { id: "2026-05-31-b", title: "B", severity: "low", category: "anti_pattern", body: "x", evidence: ["one", "two"], next_step: "x" },
    ],
  });
  const out = parseCoachResponse(raw);
  assert.equal(out.recommendations.length, 1);
  assert.equal(out.recommendations[0].id, "2026-05-31-b");
});

test("parseCoachResponse drops recommendations with unsafe ids", () => {
  const raw = JSON.stringify({
    recommendations: [
      { id: "../../../etc/passwd", title: "T", severity: "high", category: "anti_pattern", body: "x", evidence: ["1", "2"], next_step: "x" },
    ],
  });
  const out = parseCoachResponse(raw);
  assert.equal(out.recommendations.length, 0);
});

test("parseCoachResponse returns empty list for unparseable input", () => {
  assert.deepEqual(parseCoachResponse("not json at all").recommendations, []);
  assert.deepEqual(parseCoachResponse("").recommendations, []);
});

// ------ writeRecommendation ------

test("writeRecommendation writes a markdown file with frontmatter under recommendations/", async () => {
  const home = await tmpHome();
  const rec = {
    id: "2026-05-31-use-plan-mode",
    title: "Use plan mode",
    severity: "high",
    category: "feature_miss",
    body: "Body text here.",
    evidence: ["one", "two"],
    next_step: "Try /plan.",
    related_knowledge: "claude-code-features.md#plan-mode",
  };
  const file = await writeRecommendation(home, rec);
  const text = await readFile(file, "utf8");
  assert.match(text, /---/);
  assert.match(text, /id: 2026-05-31-use-plan-mode/);
  assert.match(text, /severity: high/);
  assert.match(text, /status: pending/);
  assert.match(text, /# Use plan mode/);
  assert.match(text, /Body text here/);
});

test("writeRecommendation refuses path-traversal ids", async () => {
  const home = await tmpHome();
  await assert.rejects(
    () => writeRecommendation(home, {
      id: "../escape", title: "x", severity: "high", category: "feature_miss",
      body: "x", evidence: ["1", "2"], next_step: "x",
    }),
    /invalid id/i,
  );
});

// ------ list / status transitions ------

test("listRecommendations returns rec entries with parsed frontmatter", async () => {
  const home = await tmpHome();
  await writeRecommendation(home, {
    id: "r1", title: "T1", severity: "high", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await writeRecommendation(home, {
    id: "r2", title: "T2", severity: "low", category: "anti_pattern",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  const recs = await listRecommendations(home);
  assert.equal(recs.length, 2);
  const ids = recs.map((r) => r.meta.id).sort();
  assert.deepEqual(ids, ["r1", "r2"]);
});

test("setRecommendationStatus accepts updates the frontmatter", async () => {
  const home = await tmpHome();
  await writeRecommendation(home, {
    id: "r1", title: "T", severity: "high", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await setRecommendationStatus(home, "r1", "accepted");
  const status = await getRecommendationStatus(home, "r1");
  assert.equal(status, "accepted");
});

test("setRecommendationStatus dismiss + dismiss is sticky (isDismissed true)", async () => {
  const home = await tmpHome();
  await writeRecommendation(home, {
    id: "r1", title: "T", severity: "high", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await setRecommendationStatus(home, "r1", "dismissed");
  assert.equal(await isDismissed(home, "r1"), true);
});

test("setRecommendationStatus snooze sets snooze_until and isSnoozed checks the date", async () => {
  const home = await tmpHome();
  await writeRecommendation(home, {
    id: "r1", title: "T", severity: "high", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await setRecommendationStatus(home, "r1", "snoozed", { days: 7 });
  const status = await getRecommendationStatus(home, "r1");
  assert.equal(status, "snoozed");
  assert.equal(await isSnoozed(home, "r1"), true);
});

test("setRecommendationStatus snooze with 0 days yields not-snoozed today", async () => {
  const home = await tmpHome();
  await writeRecommendation(home, {
    id: "r1", title: "T", severity: "high", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  // Set a past snooze date directly via setRecommendationStatus(-1)
  await setRecommendationStatus(home, "r1", "snoozed", { days: -1 });
  assert.equal(await isSnoozed(home, "r1"), false);
});

test("setRecommendationStatus throws for unknown id", async () => {
  const home = await tmpHome();
  await assert.rejects(
    () => setRecommendationStatus(home, "nope", "accepted"),
    /not found/i,
  );
});

test("setRecommendationStatus rejects unsafe id", async () => {
  const home = await tmpHome();
  await assert.rejects(
    () => setRecommendationStatus(home, "../oops", "accepted"),
    /invalid id/i,
  );
});

// ------ runCoachingPass ------

test("runCoachingPass writes recommendations and a log when the model returns recs", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  for (let i = 0; i < 3; i++) {
    await appendSignal(paths(home).signals, {
      host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
    });
  }
  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-prefer-grep-tool",
        title: "Prefer Grep tool over bash grep",
        severity: "medium",
        category: "feature_miss",
        body: "You're using bash grep often; the Grep tool is faster.",
        evidence: ["s1: grep foo (Bash)", "s2: grep bar (Bash)"],
        next_step: "Use the Grep tool for content search.",
      },
    ],
  }));
  const result = await runCoachingPass({ home, client });
  assert.equal(result.skipped, false);
  assert.equal(result.recommendations.length, 1);

  const recs = await listRecommendations(home);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].meta.id, "2026-05-31-prefer-grep-tool");

  const logs = await readdir(paths(home).reflections);
  const coachLogs = logs.filter((f) => f.startsWith("coach-"));
  assert.equal(coachLogs.length, 1);
});

test("runCoachingPass --dry-run does not write recs or log", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-x", title: "X", severity: "low", category: "feature_miss",
        body: "b", evidence: ["one", "two"], next_step: "s",
      },
    ],
  }));
  const result = await runCoachingPass({ home, client, dryRun: true });
  assert.equal(result.skipped, false);
  assert.equal(result.recommendations.length, 1);
  const recs = await listRecommendations(home);
  assert.equal(recs.length, 0);
});

test("runCoachingPass skips when there are no signals at all", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  let called = false;
  const client = fakeClient(async () => { called = true; return jsonResponse({ recommendations: [] }); });
  const result = await runCoachingPass({ home, client });
  assert.equal(called, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no signals/i);
});

test("runCoachingPass skips re-proposing a dismissed recommendation", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  // Pre-seed a dismissed rec with the same id the model will try to propose.
  await writeRecommendation(home, {
    id: "2026-05-31-prefer-grep", title: "T", severity: "medium", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await setRecommendationStatus(home, "2026-05-31-prefer-grep", "dismissed");

  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-prefer-grep", title: "Prefer Grep tool", severity: "medium",
        category: "feature_miss", body: "Body.", evidence: ["a", "b"], next_step: "s",
      },
    ],
  }));
  await runCoachingPass({ home, client });
  const recs = await listRecommendations(home);
  // Still just the original dismissed rec — no duplicate written.
  assert.equal(recs.length, 1);
  assert.equal(recs[0].meta.status, "dismissed");
});

test("runCoachingPass skips re-proposing a still-snoozed recommendation", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  await writeRecommendation(home, {
    id: "2026-05-31-snoozy", title: "T", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await setRecommendationStatus(home, "2026-05-31-snoozy", "snoozed", { days: 30 });

  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-snoozy", title: "T2", severity: "low",
        category: "feature_miss", body: "body", evidence: ["a", "b"], next_step: "s",
      },
    ],
  }));
  await runCoachingPass({ home, client });
  const recs = await listRecommendations(home);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].meta.status, "snoozed");
});

test("runCoachingPass does NOT clobber an existing accepted recommendation when the model re-proposes the same id", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  // Pre-seed an accepted rec.
  await writeRecommendation(home, {
    id: "2026-05-31-keep-me", title: "Original title", severity: "high",
    category: "feature_miss", body: "Original body.", evidence: ["e1", "e2"], next_step: "do x",
  });
  await setRecommendationStatus(home, "2026-05-31-keep-me", "accepted");

  // Model proposes the same id with different content.
  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-keep-me", title: "New title", severity: "low",
        category: "feature_miss", body: "New body.", evidence: ["a", "b"], next_step: "do y",
      },
    ],
  }));
  const result = await runCoachingPass({ home, client });

  // The accepted rec must be preserved verbatim.
  const r = await getRecommendation(home, "2026-05-31-keep-me");
  assert.equal(r.meta.status, "accepted");
  assert.match(r.body, /Original body/);
  assert.equal(r.meta.severity, "high");
  // The re-proposal should be reflected in the skippedExisting counter,
  // not the written list.
  assert.equal(result.recommendations.length, 0);
  assert.equal(result.skippedExisting, 1);
});

test("runCoachingPass collapses duplicate ids within a single pass (first-write-wins)", async () => {
  const home = await tmpHome();
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-dup", title: "First", severity: "high",
        category: "feature_miss", body: "first body", evidence: ["1", "2"], next_step: "a",
      },
      {
        id: "2026-05-31-dup", title: "Second", severity: "low",
        category: "feature_miss", body: "second body", evidence: ["3", "4"], next_step: "b",
      },
    ],
  }));
  await runCoachingPass({ home, client });
  const recs = await listRecommendations(home);
  const matching = recs.filter((r) => r.meta.id === "2026-05-31-dup");
  assert.equal(matching.length, 1);
  assert.match(matching[0].body, /first body/);
});

// ------ getPendingRecommendations (SOU-19 Part B helper) ------

test("getPendingRecommendations returns pending + non-snoozed recs scoped to cwd", async () => {
  const home = await tmpHome();
  const { writeRecommendation, getPendingRecommendations } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "in-scope", title: "T", severity: "high", category: "feature_miss",
    body: "Body for /Users/me/code/repoA",
    evidence: ["mention /Users/me/code/repoA here", "e2"],
    next_step: "Do thing in /Users/me/code/repoA",
  });
  await writeRecommendation(home, {
    id: "other-scope", title: "T", severity: "medium", category: "feature_miss",
    body: "Body for /Users/me/code/repoB",
    evidence: ["mention /Users/me/code/repoB", "e2"],
    next_step: "n",
  });
  const result = await getPendingRecommendations(home, "/Users/me/code/repoA");
  assert.equal(result.length, 1);
  assert.equal(result[0].meta.id, "in-scope");
});

test("getPendingRecommendations rejects trivial scopes to prevent over-match", async () => {
  // Without this guard, scope='/' would substring-match every rec body that
  // contains any absolute path (basically all of them), and SessionStart
  // would tell the model 'you have N tips' even when none are relevant.
  const home = await tmpHome();
  const { writeRecommendation, getPendingRecommendations } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "r-a", title: "T", severity: "high", category: "feature_miss",
    body: "Body for /Users/me/code/repoA",
    evidence: ["e for /Users/me/code/repoA", "e2"],
    next_step: "n",
  });
  await writeRecommendation(home, {
    id: "r-b", title: "T", severity: "medium", category: "feature_miss",
    body: "Body for /Users/me/code/repoB",
    evidence: ["e for /Users/me/code/repoB", "e2"],
    next_step: "n",
  });
  // Trivial scopes should fall back to "no filter" — return everything.
  // Better than returning everything-because-of-substring (same end result
  // here) AND it leaves the door open for the SessionStart adapter to
  // suppress the hint when scope is meaningless if it wants.
  const slash = await getPendingRecommendations(home, "/");
  // Both recs returned (treated as unfiltered).
  assert.equal(slash.length, 2);
  const usersOnly = await getPendingRecommendations(home, "/Users");
  assert.equal(usersOnly.length, 2);
});

test("getPendingRecommendations excludes dismissed and currently-snoozed recs", async () => {
  const home = await tmpHome();
  const {
    writeRecommendation,
    setRecommendationStatus,
    getPendingRecommendations,
  } = await import("../lib/coach.mjs");
  await writeRecommendation(home, {
    id: "live", title: "T", severity: "high", category: "feature_miss",
    body: "Body for /Users/me/code/repoA",
    evidence: ["/Users/me/code/repoA", "e2"],
    next_step: "n",
  });
  await writeRecommendation(home, {
    id: "gone", title: "T", severity: "high", category: "feature_miss",
    body: "Body for /Users/me/code/repoA",
    evidence: ["/Users/me/code/repoA", "e2"],
    next_step: "n",
  });
  await setRecommendationStatus(home, "gone", "dismissed");
  await writeRecommendation(home, {
    id: "zzz", title: "T", severity: "high", category: "feature_miss",
    body: "Body for /Users/me/code/repoA",
    evidence: ["/Users/me/code/repoA", "e2"],
    next_step: "n",
  });
  await setRecommendationStatus(home, "zzz", "snoozed", { days: 7 });

  const out = await getPendingRecommendations(home, "/Users/me/code/repoA");
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.id, "live");
});

// ------ macOS notifications integration (SOU-19 Part A) ------

async function tmpHomeWithNudge(extraNudge = {}) {
  const home = await mkdtemp(join(tmpdir(), "agentmem-coach-"));
  await ensureLayout(home);
  await writeFile(join(home, "config.json"), JSON.stringify({
    coaching: {
      lookback_days: 7,
      model: "claude-sonnet-4-6",
      max_recommendations_per_run: 8,
      min_evidence_per_recommendation: 2,
    },
    nudge: {
      macos_notifications_on_high_only: true,
      ...extraNudge,
    },
  }));
  return home;
}

test("runCoachingPass fires a macOS notification for each new HIGH rec, once", async () => {
  const home = await tmpHomeWithNudge();
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-high-one",
        title: "Use plan mode",
        severity: "high",
        category: "feature_miss",
        body: "Body.",
        evidence: ["e1", "e2"],
        next_step: "Try /plan first",
      },
      {
        id: "2026-05-31-low-one",
        title: "Some low thing",
        severity: "low",
        category: "anti_pattern",
        body: "Body.",
        evidence: ["e1", "e2"],
        next_step: "Whatever",
      },
    ],
  }));

  const calls = [];
  const runNotifier = async (args) => {
    calls.push(args);
    return { ok: true };
  };

  const result1 = await runCoachingPass({ home, client, runNotifier });
  assert.equal(result1.recommendations.length, 2);
  // Only the HIGH-severity rec triggered a notification.
  assert.equal(calls.length, 1);
  assert.match(calls[0].join(" "), /Use plan mode/);
  assert.deepEqual(result1.notified.sort(), ["2026-05-31-high-one"]);

  // Re-running with the same signals must NOT re-fire the notification for
  // the already-surfaced HIGH rec.
  calls.length = 0;
  const result2 = await runCoachingPass({ home, client, runNotifier });
  // The rec already exists, so it's skippedExisting — and no notify either.
  assert.equal(result2.recommendations.length, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(result2.notified, []);
});

test("runCoachingPass respects nudge.macos_notifications_on_high_only=false and fires nothing", async () => {
  const home = await tmpHomeWithNudge({ macos_notifications_on_high_only: false });
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-high-off",
        title: "T", severity: "high", category: "feature_miss",
        body: "b", evidence: ["1", "2"], next_step: "n",
      },
    ],
  }));
  const calls = [];
  const result = await runCoachingPass({
    home,
    client,
    runNotifier: async (args) => { calls.push(args); return { ok: true }; },
  });
  assert.equal(result.recommendations.length, 1);
  assert.equal(calls.length, 0);
  assert.deepEqual(result.notified, []);
});

test("runCoachingPass dryRun does not fire notifications even for HIGH recs", async () => {
  const home = await tmpHomeWithNudge();
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-dry-high",
        title: "T", severity: "high", category: "feature_miss",
        body: "b", evidence: ["1", "2"], next_step: "n",
      },
    ],
  }));
  const calls = [];
  const result = await runCoachingPass({
    home, client, dryRun: true,
    runNotifier: async (args) => { calls.push(args); return { ok: true }; },
  });
  assert.equal(result.recommendations.length, 1);
  // Dry-run must not side-effect: no notifications, no state file written.
  assert.equal(calls.length, 0);
});

test("runCoachingPass does not crash when terminal-notifier fails", async () => {
  const home = await tmpHomeWithNudge();
  await seedKnowledge(home);
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "tool", tool: "Bash", summary: "grep foo",
  });
  const client = fakeClient(async () => jsonResponse({
    recommendations: [
      {
        id: "2026-05-31-osafail",
        title: "T", severity: "high", category: "feature_miss",
        body: "b", evidence: ["1", "2"], next_step: "n",
      },
    ],
  }));
  // Simulate non-macOS / missing terminal-notifier.
  const runNotifier = async () => { throw new Error("terminal-notifier: command not found"); };
  const result = await runCoachingPass({ home, client, runNotifier });
  // Coach pass succeeded; the rec was written; nothing was successfully notified.
  assert.equal(result.recommendations.length, 1);
  assert.deepEqual(result.notified, []);
});

// ------ Obsidian sync hook ------

test("runCoachingPass calls syncToObsidian on success (non-dry-run)", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-obs-"));
  await ensureLayout(home);
  const vault = await mkdtemp(join(tmpdir(), "coach-vault-"));
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      obsidian: { enabled: true, vault_path: vault, project_dir: "p" },
      coaching: { min_signals: 1 },
    }, null, 2),
  );
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "x" });
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify({ recommendations: [] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  };
  await runCoachingPass({ home, client: stubClient, dryRun: false });
  const { readFile: readFileFs } = await import("node:fs/promises");
  const pending = await readFileFs(join(vault, "p", "pending.md"), "utf8");
  assert.match(pending, /# Pending — agentmem/);
  const digestPath = join(vault, "p", "digests", new Date().toISOString().slice(0, 10) + ".md");
  const digest = await readFileFs(digestPath, "utf8");
  assert.match(digest, /## coach — /);
});

test("runCoachingPass does NOT write to Obsidian on dry-run", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-obs-dry-"));
  await ensureLayout(home);
  const vault = await mkdtemp(join(tmpdir(), "coach-vault-dry-"));
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      obsidian: { enabled: true, vault_path: vault, project_dir: "p" },
      coaching: { min_signals: 1 },
    }, null, 2),
  );
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "x" });
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify({ recommendations: [] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  };
  await runCoachingPass({ home, client: stubClient, dryRun: true });
  const { readdir: readdirFs } = await import("node:fs/promises");
  await assert.rejects(() => readdirFs(join(vault, "p")), /ENOENT/);
});

// ------ weekly digest ------

test("weeklyDigest writes a digest file under recommendations/weekly/", async () => {
  const home = await tmpHome();
  await writeRecommendation(home, {
    id: "r1", title: "T1", severity: "high", category: "feature_miss",
    body: "b1", evidence: ["1", "2"], next_step: "s1",
  });
  await writeRecommendation(home, {
    id: "r2", title: "T2", severity: "low", category: "anti_pattern",
    body: "b2", evidence: ["1", "2"], next_step: "s2",
  });
  const file = await weeklyDigest(home);
  const text = await readFile(file, "utf8");
  assert.match(text, /Weekly recommendations/i);
  assert.match(text, /T1/);
  assert.match(text, /T2/);
});
