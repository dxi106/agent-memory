import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureLayout, writeCandidate, paths } from "../lib/storage.mjs";
import { writeRecommendation, setRecommendationStatus } from "../lib/coach.mjs";

import { createMcpServer } from "../lib/mcp.mjs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-mcp-"));
  await ensureLayout(home);
  return home;
}

async function connectedClient(home) {
  const server = createMcpServer({ home });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "agentmem-test", version: "0.0.0" });
  await client.connect(clientT);
  return { client, server };
}

function textOf(result) {
  const block = (result.content || []).find((b) => b.type === "text");
  return block ? block.text : "";
}

function parsedOf(result) {
  return JSON.parse(textOf(result));
}

test("server lists all SOU-23 tools", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "coach_accept",
    "coach_dismiss",
    "coach_snooze",
    "get_coaching_tips",
    "inject",
    "list_pending",
    "promote",
    "recall",
    "reject",
    "remember_correction",
    "remember_decision",
    "remember_praise",
  ]);
});

test("remember_correction writes a correction signal to today's jsonl", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "remember_correction",
    arguments: { summary: "don't mock the DB", scope: "example-app" },
  });
  assert.equal(result.isError, undefined);
  const day = new Date().toISOString().slice(0, 10);
  const file = join(paths(home).signals, `${day}.jsonl`);
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const sig = JSON.parse(lines[0]);
  assert.equal(sig.type, "correction");
  assert.equal(sig.host, "mcp");
  assert.equal(sig.summary, "don't mock the DB");
  assert.equal(sig.scope, "example-app");
});

test("remember_praise writes a praise signal", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "remember_praise",
    arguments: { summary: "exactly what I wanted" },
  });
  assert.equal(result.isError, undefined);
  const day = new Date().toISOString().slice(0, 10);
  const lines = (await readFile(join(paths(home).signals, `${day}.jsonl`), "utf8")).trim().split("\n");
  const sig = JSON.parse(lines[0]);
  assert.equal(sig.type, "praise");
  assert.equal(sig.summary, "exactly what I wanted");
});

test("remember_decision writes a manual signal with decision + reason", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "remember_decision",
    arguments: {
      decision: "use Railway for example-service",
      reason: "free tier and easy cron",
      scope: "example-service",
    },
  });
  assert.equal(result.isError, undefined);
  const day = new Date().toISOString().slice(0, 10);
  const lines = (await readFile(join(paths(home).signals, `${day}.jsonl`), "utf8")).trim().split("\n");
  const sig = JSON.parse(lines[0]);
  assert.equal(sig.type, "manual");
  assert.match(sig.summary, /use Railway/);
  assert.match(sig.summary, /free tier/);
  assert.equal(sig.scope, "example-service");
});

test("remember_correction without a summary returns a clean tool error", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "remember_correction",
    arguments: { summary: "" },
  });
  // Empty summary is rejected.
  assert.equal(result.isError, true);
});

test("recall returns lessons whose scope matches and whose body matches the query", async () => {
  const home = await tmpHome();
  // Seed a global lesson and a scoped-to-example-app lesson.
  await writeCandidate(home, {
    meta: {
      id: "global-1",
      title: "Be concise",
      category: "behavioral",
      confidence: 0.5,
      scope: { repos: ["*"] },
    },
    body: "**Rule:** keep replies concise and direct.",
  });
  await writeCandidate(home, {
    meta: {
      id: "scoped-1",
      title: "Use Inworld for podcast",
      category: "code",
      confidence: 0.8,
      scope: { repos: ["example-app"] },
    },
    body: "Prefer Inworld TTS for podcast generation.",
  });
  const { promoteCandidate } = await import("../lib/storage.mjs");
  await promoteCandidate(home, "global-1");
  await promoteCandidate(home, "scoped-1");

  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "recall",
    arguments: { query: "Inworld", scope: "/Users/x/example-app", limit: 5 },
  });
  const parsed = parsedOf(result);
  assert.equal(parsed.lessons.length, 1);
  assert.equal(parsed.lessons[0].id, "scoped-1");
});

test("recall with no query returns all in-scope lessons up to limit", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "a1", title: "A", category: "behavioral", confidence: 0.7, scope: { repos: ["*"] } },
    body: "rule a",
  });
  await writeCandidate(home, {
    meta: { id: "a2", title: "B", category: "behavioral", confidence: 0.6, scope: { repos: ["*"] } },
    body: "rule b",
  });
  const { promoteCandidate } = await import("../lib/storage.mjs");
  await promoteCandidate(home, "a1");
  await promoteCandidate(home, "a2");

  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "recall",
    arguments: { scope: "/tmp/anywhere", limit: 1 },
  });
  const parsed = parsedOf(result);
  assert.equal(parsed.lessons.length, 1);
  assert.equal(parsed.lessons[0].id, "a1"); // higher confidence wins
});

test("inject returns formatted bullet lines for in-scope lessons", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: {
      id: "g",
      title: "Global rule",
      category: "behavioral",
      confidence: 0.9,
      scope: { repos: ["*"] },
    },
    body: "**Rule:** be concise.",
  });
  const { promoteCandidate } = await import("../lib/storage.mjs");
  await promoteCandidate(home, "g");

  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "inject",
    arguments: { scope: "/Users/x/code/whatever", limit: 5 },
  });
  const text = textOf(result);
  assert.match(text, /Global rule/);
  assert.match(text, /be concise/);
});

test("list_pending returns candidates and pending coach recommendations", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "cand1", title: "Pending lesson", category: "code", confidence: 0.3, scope: { repos: ["*"] } },
    body: "**Rule:** something.",
  });
  await writeRecommendation(home, {
    id: "rec-pending",
    title: "Try plan mode",
    severity: "high",
    category: "feature_miss",
    body: "body",
    evidence: ["a", "b"],
    next_step: "use it",
  });
  await writeRecommendation(home, {
    id: "rec-dismissed",
    title: "Other",
    severity: "low",
    category: "feature_miss",
    body: "body",
    evidence: ["a", "b"],
    next_step: "x",
  });
  await setRecommendationStatus(home, "rec-dismissed", "dismissed");

  const { client } = await connectedClient(home);
  const result = await client.callTool({ name: "list_pending", arguments: {} });
  const parsed = parsedOf(result);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].id, "cand1");
  assert.equal(parsed.recommendations.length, 1);
  assert.equal(parsed.recommendations[0].id, "rec-pending");
});

test("promote moves a candidate into active lessons via MCP", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "p1", title: "T", category: "code", confidence: 0.3, scope: { repos: ["*"] } },
    body: "**Rule:** x.",
  });
  const { client } = await connectedClient(home);
  const result = await client.callTool({ name: "promote", arguments: { id: "p1" } });
  assert.equal(result.isError, undefined);
  const { listLessons, listCandidates } = await import("../lib/storage.mjs");
  assert.equal((await listLessons(home)).length, 1);
  assert.equal((await listCandidates(home)).length, 0);
});

test("reject removes a candidate via MCP", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "r1", title: "T", category: "code", confidence: 0.3, scope: { repos: ["*"] } },
    body: "**Rule:** x.",
  });
  const { client } = await connectedClient(home);
  const result = await client.callTool({ name: "reject", arguments: { id: "r1" } });
  assert.equal(result.isError, undefined);
  const { listCandidates } = await import("../lib/storage.mjs");
  assert.equal((await listCandidates(home)).length, 0);
});

test("promote with an unknown id returns a clean tool error, not a server crash", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({ name: "promote", arguments: { id: "nope" } });
  assert.equal(result.isError, true);
  // Server should still respond to a subsequent call.
  const ok = await client.callTool({
    name: "remember_correction",
    arguments: { summary: "still alive" },
  });
  assert.equal(ok.isError, undefined);
});

test("promote rejects path-traversal ids without crashing the server", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "promote",
    arguments: { id: "../../etc/passwd" },
  });
  assert.equal(result.isError, true);
});

test("get_coaching_tips returns only pending recs whose cwd-scoped files exist", async () => {
  const home = await tmpHome();
  // Two pending recs: one references the real cwd (we'll use home itself), one
  // references a path that doesn't exist.
  await writeRecommendation(home, {
    id: "rec-cwd-match",
    title: "Relevant tip",
    severity: "high",
    category: "feature_miss",
    body: "Use this in " + home,
    evidence: [`cwd=${home}`, "second piece"],
    next_step: "do x",
  });
  await writeRecommendation(home, {
    id: "rec-cwd-miss",
    title: "Irrelevant tip",
    severity: "medium",
    category: "feature_miss",
    body: "Use this in /definitely/not/here",
    evidence: ["cwd=/definitely/not/here", "second"],
    next_step: "do y",
  });
  // And a snoozed rec for cwd-match: should also be filtered.
  await writeRecommendation(home, {
    id: "rec-snoozed",
    title: "Snoozed",
    severity: "low",
    category: "feature_miss",
    body: home,
    evidence: [`cwd=${home}`, "second"],
    next_step: "do z",
  });
  await setRecommendationStatus(home, "rec-snoozed", "snoozed", { days: 14 });

  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "get_coaching_tips",
    arguments: { scope: home, limit: 5 },
  });
  const parsed = parsedOf(result);
  const ids = parsed.recommendations.map((r) => r.id);
  assert.ok(ids.includes("rec-cwd-match"));
  assert.ok(!ids.includes("rec-cwd-miss"));
  assert.ok(!ids.includes("rec-snoozed"));
});

test("get_coaching_tips sorts by severity BEFORE applying the limit (high-severity wins)", async () => {
  const home = await tmpHome();
  // Write 2 lows first, then 1 high — directory-read order will put the lows
  // first. If the implementation breaks at limit BEFORE sorting, the high tip
  // would be silently dropped.
  await writeRecommendation(home, {
    id: "rec-low-a",
    title: "Low A",
    severity: "low",
    category: "feature_miss",
    body: home,
    evidence: [`cwd=${home}`, "x"],
    next_step: "do",
  });
  await writeRecommendation(home, {
    id: "rec-low-b",
    title: "Low B",
    severity: "low",
    category: "feature_miss",
    body: home,
    evidence: [`cwd=${home}`, "x"],
    next_step: "do",
  });
  await writeRecommendation(home, {
    id: "rec-high",
    title: "High",
    severity: "high",
    category: "feature_miss",
    body: home,
    evidence: [`cwd=${home}`, "x"],
    next_step: "do",
  });
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "get_coaching_tips",
    arguments: { scope: home, limit: 1 },
  });
  const parsed = parsedOf(result);
  assert.equal(parsed.recommendations.length, 1);
  assert.equal(parsed.recommendations[0].id, "rec-high");
});

test("promote via MCP rebuilds INDEX.md so it doesn't drift", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "idx1", title: "Index me", category: "code", confidence: 0.5, scope: { repos: ["*"] } },
    body: "**Rule:** x.",
  });
  // Start with a stale INDEX (zero lessons).
  await writeFile(join(home, "INDEX.md"), "# agentmem index\n\n_0 active lessons_\n");

  const { client } = await connectedClient(home);
  await client.callTool({ name: "promote", arguments: { id: "idx1" } });
  const index = await readFile(join(home, "INDEX.md"), "utf8");
  assert.match(index, /_1 active lessons_/);
  assert.match(index, /Index me/);
});

test("get_coaching_tips honors the limit", async () => {
  const home = await tmpHome();
  for (let i = 0; i < 3; i++) {
    await writeRecommendation(home, {
      id: `rec-many-${i}`,
      title: `Tip ${i}`,
      severity: "high",
      category: "feature_miss",
      body: home,
      evidence: [`cwd=${home}`, "second"],
      next_step: "do",
    });
  }
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "get_coaching_tips",
    arguments: { scope: home, limit: 2 },
  });
  const parsed = parsedOf(result);
  assert.equal(parsed.recommendations.length, 2);
});

test("recall fails safe with an empty store (no lessons)", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "recall",
    arguments: { query: "anything", scope: "/tmp", limit: 5 },
  });
  const parsed = parsedOf(result);
  assert.deepEqual(parsed.lessons, []);
});

test("coach_accept sets a pending recommendation's status to accepted via MCP", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  await writeRecommendation(home, {
    id: "rec-acc-1",
    title: "T",
    severity: "low",
    category: "feature_miss",
    body: "b",
    evidence: ["1", "2"],
    next_step: "s",
  });
  const result = await client.callTool({
    name: "coach_accept",
    arguments: { id: "rec-acc-1" },
  });
  assert.equal(result.isError, undefined);
  const { getRecommendationStatus } = await import("../lib/coach.mjs");
  assert.equal(await getRecommendationStatus(home, "rec-acc-1"), "accepted");
});

test("coach_accept returns isError for an unknown id", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "coach_accept",
    arguments: { id: "does-not-exist" },
  });
  assert.equal(result.isError, true);
});

test("coach_accept returns isError when id is missing", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "coach_accept",
    arguments: {},
  });
  assert.equal(result.isError, true);
});

test("coach_dismiss sets a pending recommendation's status to dismissed via MCP", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  await writeRecommendation(home, {
    id: "rec-dis-1",
    title: "T",
    severity: "low",
    category: "feature_miss",
    body: "b",
    evidence: ["1", "2"],
    next_step: "s",
  });
  const result = await client.callTool({
    name: "coach_dismiss",
    arguments: { id: "rec-dis-1" },
  });
  assert.equal(result.isError, undefined);
  const { getRecommendationStatus } = await import("../lib/coach.mjs");
  assert.equal(await getRecommendationStatus(home, "rec-dis-1"), "dismissed");
});

test("coach_dismiss returns isError for an unknown id", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "coach_dismiss",
    arguments: { id: "nope" },
  });
  assert.equal(result.isError, true);
});

test("coach_dismiss returns isError when id is missing", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "coach_dismiss",
    arguments: {},
  });
  assert.equal(result.isError, true);
});

test("coach_snooze sets a pending recommendation to snoozed with snooze_until N days out", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  await writeRecommendation(home, {
    id: "rec-sno-1", title: "T", severity: "low", category: "feature_miss",
    body: "b", evidence: ["1", "2"], next_step: "s",
  });
  const result = await client.callTool({
    name: "coach_snooze",
    arguments: { id: "rec-sno-1", days: 14 },
  });
  assert.equal(result.isError, undefined);
  const { getRecommendation } = await import("../lib/coach.mjs");
  const r = await getRecommendation(home, "rec-sno-1");
  assert.equal(r.meta.status, "snoozed");
  const expected = new Date();
  expected.setUTCDate(expected.getUTCDate() + 14);
  assert.equal(r.meta.snooze_until, expected.toISOString().slice(0, 10));
});

test("coach_snooze returns isError for an unknown id", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const result = await client.callTool({
    name: "coach_snooze",
    arguments: { id: "nope", days: 7 },
  });
  assert.equal(result.isError, true);
});

test("coach_snooze returns isError for missing id or non-numeric days", async () => {
  const home = await tmpHome();
  const { client } = await connectedClient(home);
  const noId = await client.callTool({
    name: "coach_snooze",
    arguments: { days: 7 },
  });
  assert.equal(noId.isError, true);
  const badDays = await client.callTool({
    name: "coach_snooze",
    arguments: { id: "x", days: "soon" },
  });
  assert.equal(badDays.isError, true);
});

test("bin/agentmem-mcp.mjs starts a real stdio server and responds to a tool call", async () => {
  const home = await tmpHome();
  // Append a baseline signal so we can prove the spawned server wrote ours.
  const { execFile } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const bin = fileURLToPath(new URL("../bin/agentmem-mcp.mjs", import.meta.url));
  void execFile; // silence eslint; transport spawns it internally
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin],
    env: { ...process.env, AGENTMEM_HOME: home },
  });
  const client = new Client({ name: "spawn-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "remember_correction",
      arguments: { summary: "spawn check" },
    });
    assert.equal(result.isError, undefined);
    const day = new Date().toISOString().slice(0, 10);
    const lines = (await readFile(join(paths(home).signals, `${day}.jsonl`), "utf8"))
      .trim()
      .split("\n");
    assert.ok(lines.some((l) => JSON.parse(l).summary === "spawn check"));
  } finally {
    await client.close();
  }
});
