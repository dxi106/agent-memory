import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPending, renderDigestSection, collectPendingState, writePending, appendDigest, syncToObsidian } from "../lib/obsidian.mjs";
import { ensureLayout, paths, writeCandidate } from "../lib/storage.mjs";
import { appendSignal } from "../lib/signals.mjs";
import { writeRecommendation, setRecommendationStatus } from "../lib/coach.mjs";
import { writeFile as writeFileFs } from "node:fs/promises";

test("renderPending formats coaching tips, candidates, signal counts, and an updated-at line", () => {
  const state = {
    updatedAt: "2026-06-01T12:34:56Z",
    triggeredBy: "coach",
    coachingTips: [
      { id: "2026-05-31-x", severity: "high", title: "Use plan mode", body: "Detail line 1.\nDetail line 2.", nextStep: "Try plan mode tomorrow" },
      { id: "2026-05-31-y", severity: "medium", title: "Tighten scope", body: "Detail.", nextStep: "Sub-issue per concern" },
    ],
    candidates: [
      { id: "2026-06-01-foo", category: "workflow", confidence: 0.45, title: "Prefer Grep tool", body: "Body of foo." },
    ],
    counts: {
      activeLessons: 12,
      signals7d: { total: 42, correction: 6, praise: 1, retry: 3 },
    },
  };
  const md = renderPending(state);
  assert.match(md, /^# Pending — agentmem/);
  assert.match(md, /Last updated: 2026-06-01T12:34:56Z \(triggered by coach\)/);
  assert.match(md, /## Coaching tips \(2\)/);
  assert.match(md, /### \[HIGH\] 2026-05-31-x — Use plan mode/);
  assert.match(md, /Try plan mode tomorrow/);
  assert.match(md, /## Candidate lessons \(1\)/);
  assert.match(md, /### 2026-06-01-foo — Prefer Grep tool/);
  assert.match(md, /workflow • confidence 0\.45/);
  assert.match(md, /## Store at a glance/);
  assert.match(md, /Active lessons:\s+12/);
  assert.match(md, /Signals \(last 7d\):\s+42 \(corrections 6 · praise 1 · retries 3\)/);
});

test("renderPending shows empty-section placeholders when there is nothing to triage", () => {
  const md = renderPending({
    updatedAt: "2026-06-01T00:00:00Z",
    triggeredBy: "manual",
    coachingTips: [],
    candidates: [],
    counts: { activeLessons: 0, signals7d: { total: 0 } },
  });
  assert.match(md, /## Coaching tips \(0\)\n\n_No pending coaching tips\._/);
  assert.match(md, /## Candidate lessons \(0\)\n\n_No pending candidates\._/);
});

test("renderDigestSection — reflect kind shows counts, new candidates, rescored count", () => {
  const md = renderDigestSection({
    kind: "reflect",
    timestamp: "2026-06-01T09:15:00Z",
    signalsConsidered: 42,
    signalBreakdown: { correction: 6, praise: 1, retry: 3 },
    newCandidates: [
      { id: "2026-06-01-foo", title: "Prefer Grep tool" },
      { id: "2026-06-01-bar", title: "Verify env-var necessity" },
    ],
    rescoredCount: 3,
  });
  assert.match(md, /^## reflect — 2026-06-01T09:15:00Z/m);
  assert.match(md, /Signals considered:\s+42/);
  assert.match(md, /corrections 6 · praise 1 · retries 3/);
  assert.match(md, /New candidates \(2\):/);
  assert.match(md, /- 2026-06-01-foo — Prefer Grep tool/);
  assert.match(md, /Rescored lessons:\s+3/);
});

test("renderDigestSection — coach kind shows recs + skipped breakdown", () => {
  const md = renderDigestSection({
    kind: "coach",
    timestamp: "2026-06-01T09:17:00Z",
    signalsConsidered: 42,
    newRecommendations: [
      { id: "2026-06-01-z", severity: "high", title: "Adopt plan mode for 3+ file changes" },
    ],
    skipped: { dismissed: 0, snoozed: 0, existing: 2 },
  });
  assert.match(md, /^## coach — 2026-06-01T09:17:00Z/m);
  assert.match(md, /Signals considered:\s+42/);
  assert.match(md, /New recommendations \(1\):/);
  assert.match(md, /- \[HIGH\] 2026-06-01-z — Adopt plan mode/);
  assert.match(md, /Skipped:\s+0 dismissed · 0 snoozed · 2 already on file/);
});

test("renderDigestSection — empty new-list shows placeholder", () => {
  const md = renderDigestSection({
    kind: "reflect",
    timestamp: "2026-06-01T09:15:00Z",
    signalsConsidered: 0,
    signalBreakdown: {},
    newCandidates: [],
    rescoredCount: 0,
  });
  assert.match(md, /New candidates: none/);
});

test("collectPendingState gathers tips + candidates + signal counts from a tmp home", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-collect-"));
  await ensureLayout(home);
  await writeCandidate(home, {
    meta: { id: "cand-1", title: "Cand title", category: "workflow", confidence: 0.5, scope: { repos: ["*"] } },
    body: "Cand body.",
  });
  await writeRecommendation(home, {
    id: "rec-1", title: "Rec title", severity: "high", category: "feature_miss",
    body: "Rec body.", evidence: ["1", "2"], next_step: "Do x",
  });
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "s1" });
  await appendSignal(paths(home).signals, { host: "claude-code", type: "praise", summary: "s2" });
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "s3" });

  const state = await collectPendingState(home, { triggeredBy: "manual" });
  assert.equal(state.triggeredBy, "manual");
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.coachingTips.length, 1);
  assert.equal(state.coachingTips[0].id, "rec-1");
  assert.equal(state.coachingTips[0].nextStep, "Do x");
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].id, "cand-1");
  assert.equal(state.counts.signals7d.total, 3);
  assert.equal(state.counts.signals7d.correction, 2);
  assert.equal(state.counts.signals7d.praise, 1);
});

test("collectPendingState filters out dismissed/snoozed/accepted recommendations", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-collect-"));
  await ensureLayout(home);
  await writeRecommendation(home, {
    id: "r-pending", title: "Keep", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await writeRecommendation(home, {
    id: "r-dismissed", title: "Drop", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  await setRecommendationStatus(home, "r-dismissed", "dismissed");
  const state = await collectPendingState(home, { triggeredBy: "manual" });
  assert.deepEqual(state.coachingTips.map((t) => t.id), ["r-pending"]);
});

test("collectPendingState excludes ts-less and malformed signal entries from the 7d count", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-collect-ts-"));
  await ensureLayout(home);
  const todayFile = join(paths(home).signals, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const eightDaysAgo = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
  const today = new Date().toISOString();
  await writeFileFs(todayFile, [
    JSON.stringify({ host: "x", type: "correction", ts: today, summary: "good" }),
    JSON.stringify({ host: "x", type: "correction", summary: "no-ts" }),
    JSON.stringify({ host: "x", type: "correction", ts: "garbage", summary: "bad-ts" }),
    JSON.stringify({ host: "x", type: "correction", ts: eightDaysAgo, summary: "old" }),
    "",
  ].join("\n"));
  const state = await collectPendingState(home, { triggeredBy: "manual" });
  assert.equal(state.counts.signals7d.total, 1);
  assert.equal(state.counts.signals7d.correction, 1);
});

test("writePending creates the project dir and writes pending.md", async () => {
  const vault = await mkdtemp(join(tmpdir(), "obs-vault-"));
  const projectDir = "Projects/agentmem";
  const md = "# Pending — agentmem\n\nbody\n";
  const written = await writePending({ vaultPath: vault, projectDir }, md);
  assert.equal(written, join(vault, projectDir, "pending.md"));
  const onDisk = await readFile(written, "utf8");
  assert.equal(onDisk, md);
});

test("writePending overwrites an existing pending.md", async () => {
  const vault = await mkdtemp(join(tmpdir(), "obs-vault-"));
  const projectDir = "p";
  await writePending({ vaultPath: vault, projectDir }, "old\n");
  const newMd = "new\n";
  const path = await writePending({ vaultPath: vault, projectDir }, newMd);
  assert.equal(await readFile(path, "utf8"), newMd);
});

test("appendDigest creates today's digest with header when the file is new", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-home-"));
  await ensureLayout(home);
  const vault = await mkdtemp(join(tmpdir(), "obs-digest-"));
  const projectDir = "p";
  const path = await appendDigest(home, { vaultPath: vault, projectDir }, "2026-06-01", "## reflect — t1\n- x\n");
  assert.equal(path, join(vault, projectDir, "digests", "2026-06-01.md"));
  const content = await readFile(path, "utf8");
  assert.match(content, /^# 2026-06-01\n/);
  assert.match(content, /## reflect — t1\n- x/);
});

test("appendDigest appends a second section to an existing day's file", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-home-"));
  await ensureLayout(home);
  const vault = await mkdtemp(join(tmpdir(), "obs-digest-"));
  const projectDir = "p";
  await appendDigest(home, { vaultPath: vault, projectDir }, "2026-06-01", "## reflect — t1\n- x\n");
  await appendDigest(home, { vaultPath: vault, projectDir }, "2026-06-01", "## coach — t2\n- y\n");
  const content = await readFile(join(vault, projectDir, "digests", "2026-06-01.md"), "utf8");
  assert.match(content, /reflect — t1[\s\S]*coach — t2/);
  assert.match(content, /\n---\n/);
});

async function seedConfig(home, cfg) {
  await writeFileFs(join(home, "config.json"), JSON.stringify(cfg, null, 2));
}

test("syncToObsidian no-ops when obsidian config is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-sync-"));
  await ensureLayout(home);
  await seedConfig(home, {});
  const result = await syncToObsidian({ home });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "obsidian config not enabled");
});

test("syncToObsidian writes pending.md when enabled and no pass payload is supplied", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-sync-"));
  await ensureLayout(home);
  const vault = await mkdtemp(join(tmpdir(), "obs-vault-"));
  await seedConfig(home, {
    obsidian: { enabled: true, vault_path: vault, project_dir: "p" },
  });
  const result = await syncToObsidian({ home, triggeredBy: "manual" });
  assert.equal(result.pendingPath, join(vault, "p", "pending.md"));
  assert.equal(result.digestPath, null);
  const pending = await readFile(result.pendingPath, "utf8");
  assert.match(pending, /# Pending — agentmem/);
  assert.match(pending, /triggered by manual/);
});

test("syncToObsidian writes pending.md AND appends a digest section when pass is supplied", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-sync-"));
  await ensureLayout(home);
  const vault = await mkdtemp(join(tmpdir(), "obs-vault-"));
  await seedConfig(home, {
    obsidian: { enabled: true, vault_path: vault, project_dir: "p" },
  });
  const result = await syncToObsidian({
    home,
    triggeredBy: "coach",
    pass: {
      kind: "coach",
      timestamp: "2026-06-01T09:17:00Z",
      signalsConsidered: 5,
      newRecommendations: [{ id: "r1", severity: "high", title: "T" }],
      skipped: { dismissed: 0, snoozed: 0, existing: 0 },
    },
  });
  assert.ok(result.pendingPath);
  assert.ok(result.digestPath);
  const digest = await readFile(result.digestPath, "utf8");
  assert.match(digest, /^# \d{4}-\d{2}-\d{2}\n/);
  assert.match(digest, /## coach — 2026-06-01T09:17:00Z/);
});
