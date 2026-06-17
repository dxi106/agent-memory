import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLayout, writeCandidate, promoteCandidate, paths } from "../lib/storage.mjs";
import { readSignalsSince } from "../lib/signals.mjs";
import { writeRecommendation, setRecommendationStatus } from "../lib/coach.mjs";

function scriptPath(name) {
  return fileURLToPath(new URL(`../adapters/claude-code/${name}`, import.meta.url));
}

function runScript(name, home, payload) {
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath(name)], { env: { ...process.env, AGENTMEM_HOME: home } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(typeof payload === "string" ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-adp-"));
  await ensureLayout(home);
  return home;
}

test("session-start injects scoped lessons as additionalContext", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "inj", title: "Be concise", category: "behavioral", confidence: 0.9, scope: { repos: ["*"] } },
    body: "**Rule:** keep answers short.",
  });
  await promoteCandidate(home, "inj");
  const { stdout, code } = await runScript("session-start.mjs", home, { cwd: "/Users/x/code/whatever" });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /Be concise/);
});

test("session-start emits a bare continue when there are no lessons", async () => {
  const home = await tmpHome();
  const { stdout, code } = await runScript("session-start.mjs", home, { cwd: "/tmp" });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { continue: true });
});

test("session-start mentions pending coaching tip count when recs are present", async () => {
  const home = await tmpHome();
  // Seed a lesson so the existing lesson-injection path still has content
  // — we want to verify BOTH pieces (lessons + tip hint) land in additionalContext.
  await writeCandidate(home, {
    meta: { id: "inj2", title: "Be concise", category: "behavioral", confidence: 0.9, scope: { repos: ["*"] } },
    body: "**Rule:** keep answers short.",
  });
  await promoteCandidate(home, "inj2");
  // Seed two pending recommendations — one of them mentioning the cwd.
  await writeRecommendation(home, {
    id: "rec-scoped",
    title: "Plan mode for multi-file changes",
    severity: "high",
    category: "feature_miss",
    body: "You edited files in /Users/x/code/whatever many times.",
    evidence: ["session A edited /Users/x/code/whatever/foo.js", "session B too"],
    next_step: "Use /plan first.",
  });
  await writeRecommendation(home, {
    id: "rec-other",
    title: "Some other tip",
    severity: "low",
    category: "anti_pattern",
    body: "Unrelated repo content.",
    evidence: ["e1", "e2"],
    next_step: "n",
  });
  const { stdout, code } = await runScript("session-start.mjs", home, { cwd: "/Users/x/code/whatever" });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  // Existing lesson injection still works.
  assert.match(out.hookSpecificOutput.additionalContext, /Be concise/);
  // New: pending tip count + framing line.
  assert.match(out.hookSpecificOutput.additionalContext, /pending coaching tips? for this repo/i);
  assert.match(out.hookSpecificOutput.additionalContext, /get_coaching_tips/);
  // Critical framing — must NOT be a session opener.
  assert.match(out.hookSpecificOutput.additionalContext, /NEVER as a session opener/);
});

test("session-start omits the tip hint when there are no pending recs", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "inj3", title: "Be concise", category: "behavioral", confidence: 0.9, scope: { repos: ["*"] } },
    body: "**Rule:** keep answers short.",
  });
  await promoteCandidate(home, "inj3");
  const { stdout, code } = await runScript("session-start.mjs", home, { cwd: "/Users/x/code/whatever" });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /pending coaching tips/i);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /get_coaching_tips/);
});

test("session-start excludes dismissed/snoozed recs from the tip count", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "inj4", title: "Be concise", category: "behavioral", confidence: 0.9, scope: { repos: ["*"] } },
    body: "**Rule:** keep answers short.",
  });
  await promoteCandidate(home, "inj4");
  await writeRecommendation(home, {
    id: "rec-dismissed",
    title: "Dismissed tip",
    severity: "high",
    category: "feature_miss",
    body: "Body in /Users/x/code/whatever",
    evidence: ["e for /Users/x/code/whatever", "e2"],
    next_step: "n",
  });
  await setRecommendationStatus(home, "rec-dismissed", "dismissed");
  const { stdout, code } = await runScript("session-start.mjs", home, { cwd: "/Users/x/code/whatever" });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  // Dismissed → no hint.
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /pending coaching tips/i);
});

test("session-start emits a continue when no lessons but pending tips exist", async () => {
  // Edge case: store has pending recs but no lessons. Old behaviour would
  // bail out with bare {continue:true}; new behaviour should still surface
  // the tip count.
  const home = await tmpHome();
  await writeRecommendation(home, {
    id: "rec-only",
    title: "Some tip",
    severity: "medium",
    category: "feature_miss",
    body: "Body for /Users/x/code/whatever",
    evidence: ["e /Users/x/code/whatever", "e2"],
    next_step: "n",
  });
  const { stdout, code } = await runScript("session-start.mjs", home, { cwd: "/Users/x/code/whatever" });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.continue, true);
  // The output must contain the tip hint even with no lessons.
  assert.match(out.hookSpecificOutput.additionalContext, /pending coaching tips? for this repo/i);
});

test("user-prompt-submit writes a correction signal", async () => {
  const home = await tmpHome();
  const { code } = await runScript("user-prompt-submit.mjs", home, {
    session_id: "s1",
    cwd: "/Users/x/code/example-app",
    prompt: "no, don't mock the database",
  });
  assert.equal(code, 0);
  const signals = await readSignalsSince(paths(home).signals, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, "correction");
});

test("user-prompt-submit writes nothing for a neutral prompt", async () => {
  const home = await tmpHome();
  await runScript("user-prompt-submit.mjs", home, { session_id: "s1", cwd: "/tmp", prompt: "add a button" });
  const signals = await readSignalsSince(paths(home).signals, 1);
  assert.equal(signals.length, 0);
});

test("post-tool-use emits a retry signal only on the repeated call", async () => {
  const home = await tmpHome();
  const payload = { session_id: "s1", cwd: "/tmp", tool_name: "Bash", tool_input: { command: "npm test" } };
  await runScript("post-tool-use.mjs", home, payload);
  let signals = await readSignalsSince(paths(home).signals, 1);
  assert.equal(signals.length, 0);
  await runScript("post-tool-use.mjs", home, payload);
  signals = await readSignalsSince(paths(home).signals, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, "retry");
});

test("adapters are fail-safe on garbage input (exit 0, valid JSON)", async () => {
  const home = await tmpHome();
  const { stdout, code } = await runScript("post-tool-use.mjs", home, "this is not json{{{");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { continue: true });
});

test("stop is a fail-safe no-op", async () => {
  const home = await tmpHome();
  const { stdout, code } = await runScript("stop.mjs", home, { session_id: "s1" });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { continue: true });
});
