import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, paths } from "../lib/storage.mjs";
import { appendSignal, readSignalsSince } from "../lib/signals.mjs";
import {
  ingestClaudeCodeTranscripts,
  signalKey,
  parseTranscriptLine,
} from "../lib/ingest.mjs";

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-ingest-"));
  await ensureLayout(home);
  return home;
}

async function tmpProjectsDir() {
  return await mkdtemp(join(tmpdir(), "claude-projects-"));
}

// A timestamp that's recent relative to "now" so fixtures never age out of a
// `since: N days` window (a fixed date would start failing once it's older
// than the window). Defaults to ~1h ago; pass addSeconds to order events.
function recentTs(addSeconds = 0) {
  return new Date(Date.now() - 3600_000 + addSeconds * 1000).toISOString();
}

function userPromptLine(opts) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: opts.content },
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    cwd: opts.cwd || "/Users/x/code/foo",
  });
}

function assistantToolCallLine(opts) {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: opts.id,
          name: opts.toolName,
          input: opts.input,
        },
      ],
    },
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    cwd: opts.cwd || "/Users/x/code/foo",
  });
}

test("parseTranscriptLine returns null for malformed JSON", () => {
  assert.equal(parseTranscriptLine("not json"), null);
  assert.equal(parseTranscriptLine(""), null);
});

test("parseTranscriptLine returns the parsed object for valid JSON", () => {
  const line = JSON.stringify({ type: "user", sessionId: "s1" });
  const parsed = parseTranscriptLine(line);
  assert.equal(parsed.type, "user");
  assert.equal(parsed.sessionId, "s1");
});

test("signalKey is stable for the same (session, ts, summary)", () => {
  const k1 = signalKey({ session_id: "s1", ts: "2026-05-29T10:00:00Z", summary: "no, wrong" });
  const k2 = signalKey({ session_id: "s1", ts: "2026-05-29T10:00:00Z", summary: "no, wrong" });
  assert.equal(k1, k2);
});

test("signalKey differs across sessions", () => {
  const k1 = signalKey({ session_id: "s1", ts: "2026-05-29T10:00:00Z", summary: "x" });
  const k2 = signalKey({ session_id: "s2", ts: "2026-05-29T10:00:00Z", summary: "x" });
  assert.notEqual(k1, k2);
});

test("signalKey resists boundary collisions (no concat ambiguity)", () => {
  // Without delimiters, ("ab"+"c") would collide with ("a"+"bc").
  const k1 = signalKey({ session_id: "ab", ts: "c", summary: "x" });
  const k2 = signalKey({ session_id: "a", ts: "bc", summary: "x" });
  assert.notEqual(k1, k2, "session/ts boundary must not collide");
});

test("ingest extracts a correction signal from a user message", async () => {
  const home = await tmpHome();
  const projects = await tmpProjectsDir();
  const projectDir = join(projects, "-Users-x-code-foo");
  await mkdir(projectDir, { recursive: true });

  const session = "sess-abc";
  await writeFile(
    join(projectDir, `${session}.jsonl`),
    userPromptLine({
      sessionId: session,
      ts: recentTs(),
      content: "no, that's wrong - don't use mocks",
    }) + "\n",
  );

  const result = await ingestClaudeCodeTranscripts({
    home,
    projectsDir: projects,
    since: 7,
  });
  assert.equal(result.count, 1);

  const signals = await readSignalsSince(paths(home).signals, 7);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, "correction");
  assert.equal(signals[0].session_id, session);
});

test("ingest dedupes against signals already captured by the live hook", async () => {
  const home = await tmpHome();
  const projects = await tmpProjectsDir();
  const projectDir = join(projects, "-Users-x-code-foo");
  await mkdir(projectDir, { recursive: true });

  const session = "sess-dup";
  const ts = "2026-05-29T11:00:00.000Z";
  const content = "no, don't use mocks";

  // Hook-captured signal already present
  await appendSignal(paths(home).signals, {
    ts,
    host: "claude-code",
    type: "correction",
    session_id: session,
    cwd: "/Users/x/code/foo",
    summary: content,
  });

  // Transcript line for the same prompt
  await writeFile(
    join(projectDir, `${session}.jsonl`),
    userPromptLine({ sessionId: session, ts, content }) + "\n",
  );

  const before = (await readSignalsSince(paths(home).signals, 7)).length;
  const result = await ingestClaudeCodeTranscripts({ home, projectsDir: projects, since: 7 });
  const after = (await readSignalsSince(paths(home).signals, 7)).length;

  assert.equal(result.count, 0, "no new signals written");
  assert.equal(after, before, "signal count unchanged");
});

test("ingest detects retry from consecutive identical tool calls", async () => {
  const home = await tmpHome();
  const projects = await tmpProjectsDir();
  const projectDir = join(projects, "-Users-x-code-foo");
  await mkdir(projectDir, { recursive: true });

  const session = "sess-retry";
  const t1 = recentTs(0);
  const t2 = recentTs(5);
  await writeFile(
    join(projectDir, `${session}.jsonl`),
    [
      assistantToolCallLine({
        sessionId: session,
        ts: t1,
        id: "t1",
        toolName: "Bash",
        input: { command: "ls" },
      }),
      assistantToolCallLine({
        sessionId: session,
        ts: t2,
        id: "t2",
        toolName: "Bash",
        input: { command: "ls" },
      }),
    ].join("\n") + "\n",
  );

  const result = await ingestClaudeCodeTranscripts({ home, projectsDir: projects, since: 7 });
  const signals = await readSignalsSince(paths(home).signals, 7);
  const retries = signals.filter((s) => s.type === "retry");
  assert.equal(retries.length, 1, "exactly one retry");
  assert.equal(result.count, 1);
});

test("ingest skips transcripts outside the --since window", async () => {
  const home = await tmpHome();
  const projects = await tmpProjectsDir();
  const projectDir = join(projects, "-Users-x-code-foo");
  await mkdir(projectDir, { recursive: true });

  const oldSession = "sess-old";
  await writeFile(
    join(projectDir, `${oldSession}.jsonl`),
    userPromptLine({
      sessionId: oldSession,
      ts: "2025-01-01T00:00:00.000Z",
      content: "no, wrong",
    }) + "\n",
  );

  const result = await ingestClaudeCodeTranscripts({ home, projectsDir: projects, since: 7 });
  assert.equal(result.count, 0);
});

test("ingest skips synthetic prompts (skill loads, task notifications, command caveats)", async () => {
  const home = await tmpHome();
  const projects = await tmpProjectsDir();
  const projectDir = join(projects, "-Users-x-code-foo");
  await mkdir(projectDir, { recursive: true });

  const session = "sess-synth";
  const ts = "2026-05-29T13:00:00.000Z";
  const synthetic = [
    // Skill manifest load injected by superpowers
    "Base directory for this skill: /Users/x/.claude/plugins/cache/.../using-superpowers\n\nname: using-superpowers\ndescription: don't skip this",
    // Task-notification from the agent harness
    "<task-notification>\n<task-id>abc</task-id>\nDON'T DO THIS\n</task-notification>",
    // Local-command caveat injected by the CLI
    "<local-command-caveat>\nCaveat: the messages below were generated by the user while running local commands. DO NOT respond...\n</local-command-caveat>",
    // Long security review preamble (paste of a slash command — the trigger word 'wrong' appears incidentally)
    "You are a senior security engineer conducting a focused security review of the changes on this branch.\nGIT STATUS:\n```\nOn branch foo\n```\nGoal: find what's wrong",
  ];

  const lines = synthetic.map((content, i) =>
    userPromptLine({
      sessionId: session,
      ts: new Date(Date.parse(ts) + i * 1000).toISOString(),
      content,
    }),
  );
  await writeFile(join(projectDir, `${session}.jsonl`), lines.join("\n") + "\n");

  const result = await ingestClaudeCodeTranscripts({ home, projectsDir: projects, since: 7 });
  assert.equal(result.count, 0, "synthetic prompts should be skipped");
});

test("ingest is a no-op when projectsDir does not exist", async () => {
  const home = await tmpHome();
  const result = await ingestClaudeCodeTranscripts({
    home,
    projectsDir: "/nope/nonexistent",
    since: 7,
  });
  assert.equal(result.count, 0);
});
