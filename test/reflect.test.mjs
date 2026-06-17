import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, paths, writeCandidate, listCandidates, listLessons } from "../lib/storage.mjs";
import { appendSignal } from "../lib/signals.mjs";
import { runReflection, buildReflectionRequest } from "../lib/reflect.mjs";
import { serializeLesson } from "../lib/lesson.mjs";

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-reflect-"));
  await ensureLayout(home);
  await writeFile(join(home, "config.json"), JSON.stringify({
    reflection: { lookback_days: 7, model: "claude-sonnet-4-6", min_signals_to_reflect: 1 },
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

function jsonContent(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    stop_reason: "end_turn",
  };
}

test("runReflection skips when signal count is below min_signals_to_reflect", async () => {
  const home = await tmpHome();
  await writeFile(join(home, "config.json"), JSON.stringify({
    reflection: { lookback_days: 7, min_signals_to_reflect: 5 },
  }));
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "x" });

  let called = false;
  const client = fakeClient(async () => { called = true; return jsonContent({ candidates: [], rescore: [] }); });
  const result = await runReflection({ home, client });

  assert.equal(called, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /min_signals/i);
});

test("runReflection writes a candidate with confidence 0.35 when the model proposes one", async () => {
  const home = await tmpHome();
  await appendSignal(paths(home).signals, {
    host: "claude-code", type: "correction", summary: "no, don't mock the DB",
  });

  const client = fakeClient(async () => jsonContent({
    candidates: [
      {
        id: "2026-05-29-no-mock-db",
        title: "Don't mock the DB in integration tests",
        category: "code",
        rule: "Use the test-DB fixture.",
        why: "Mocks miss constraint failures.",
        scope: ["*"],
      },
    ],
    rescore: [],
  }));

  const result = await runReflection({ home, client });
  assert.equal(result.skipped, false);
  assert.equal(result.candidates.length, 1);

  const cands = await listCandidates(home);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].meta.id, "2026-05-29-no-mock-db");
  assert.equal(cands[0].meta.confidence, 0.35);
  assert.equal(cands[0].meta.category, "code");
  assert.match(cands[0].body, /test-DB fixture/);
});

test("runReflection --dry-run does not write candidates", async () => {
  const home = await tmpHome();
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "no" });

  const client = fakeClient(async () => jsonContent({
    candidates: [{ id: "2026-05-29-test", title: "T", category: "behavioral", rule: "R" }],
    rescore: [],
  }));

  await runReflection({ home, client, dryRun: true });

  const cands = await listCandidates(home);
  assert.equal(cands.length, 0);
});

test("runReflection rejects candidate ids that look unsafe", async () => {
  const home = await tmpHome();
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "no" });

  const client = fakeClient(async () => jsonContent({
    candidates: [{ id: "../../etc/passwd", title: "T", category: "code", rule: "R" }],
    rescore: [],
  }));

  const result = await runReflection({ home, client });
  // Sanitization should drop the bad candidate, not blow up
  assert.equal(result.candidates.length, 0);
  const cands = await listCandidates(home);
  assert.equal(cands.length, 0);
});

test("runReflection collapses duplicate candidate ids within a single pass", async () => {
  const home = await tmpHome();
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "x" });

  // Model returns two candidates with the same id (flaky model output).
  const client = fakeClient(async () => jsonContent({
    candidates: [
      { id: "2026-05-29-dup", title: "First", category: "code", rule: "**Rule:** A" },
      { id: "2026-05-29-dup", title: "Second", category: "code", rule: "**Rule:** B" },
    ],
    rescore: [],
  }));

  await runReflection({ home, client });

  const cands = await listCandidates(home);
  const matching = cands.filter((c) => c.meta.id === "2026-05-29-dup");
  assert.equal(matching.length, 1, "exactly one candidate written for the duplicate id");
});

test("runReflection writes a reflection log to reflections/", async () => {
  const home = await tmpHome();
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "no" });

  const client = fakeClient(async () => jsonContent({ candidates: [], rescore: [] }));
  await runReflection({ home, client });

  const logs = await readdir(paths(home).reflections);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
});

test("runReflection rescores an existing lesson: confidence bumps on confirm", async () => {
  const home = await tmpHome();
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "no" });

  // Seed a promoted lesson
  await writeCandidate(home, {
    meta: { id: "existing", title: "Existing", category: "code", confidence: 0.5, scope: { repos: ["*"] } },
    body: "**Rule:** old.",
  });
  const { promoteCandidate } = await import("../lib/storage.mjs");
  await promoteCandidate(home, "existing");

  const client = fakeClient(async () => jsonContent({
    candidates: [],
    rescore: [{ id: "existing", delta: "confirm" }],
  }));

  await runReflection({ home, client });

  const lessons = await listLessons(home);
  const existing = lessons.find((l) => l.meta.id === "existing");
  assert.ok(existing);
  assert.ok(existing.meta.confidence > 0.5, `expected confidence > 0.5, got ${existing.meta.confidence}`);
});

test("runReflection calls syncToObsidian with a reflect pass on success (non-dry-run)", async () => {
  // Set up a tmp home + enabled obsidian config, seed a few signals + a
  // stub client that returns one candidate, run reflection, and assert
  // pending.md was written.
  const home = await mkdtemp(join(tmpdir(), "reflect-obs-"));
  await ensureLayout(home);
  const vault = await mkdtemp(join(tmpdir(), "reflect-vault-"));
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      obsidian: { enabled: true, vault_path: vault, project_dir: "p" },
      reflection: { min_signals_to_reflect: 1 },
    }, null, 2),
  );
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "use grep tool" });
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify({ candidates: [], rescored: [] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  };
  const result = await runReflection({ home, client: stubClient, dryRun: false });
  assert.equal(result.skipped, false);
  const { readFile: readFileFs } = await import("node:fs/promises");
  const pending = await readFileFs(join(vault, "p", "pending.md"), "utf8");
  assert.match(pending, /# Pending — agentmem/);
  const digestPath = join(vault, "p", "digests", new Date().toISOString().slice(0, 10) + ".md");
  const digest = await readFileFs(digestPath, "utf8");
  assert.match(digest, /## reflect — /);
});

test("runReflection does NOT write to Obsidian on dry-run", async () => {
  const home = await mkdtemp(join(tmpdir(), "reflect-obs-dry-"));
  await ensureLayout(home);
  const vault = await mkdtemp(join(tmpdir(), "reflect-vault-dry-"));
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      obsidian: { enabled: true, vault_path: vault, project_dir: "p" },
      reflection: { min_signals_to_reflect: 1 },
    }, null, 2),
  );
  await appendSignal(paths(home).signals, { host: "claude-code", type: "correction", summary: "x" });
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify({ candidates: [], rescored: [] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  };
  await runReflection({ home, client: stubClient, dryRun: true });
  const { readdir: readdirFs } = await import("node:fs/promises");
  await assert.rejects(() => readdirFs(join(vault, "p")), /ENOENT/);
});

test("buildReflectionRequest places stable context first and adds cache breakpoint", async () => {
  const home = await tmpHome();
  await writeCandidate(home, {
    meta: { id: "a", title: "Lesson A", category: "code", confidence: 0.6, scope: { repos: ["*"] } },
    body: "**Rule:** a.",
  });
  const { promoteCandidate } = await import("../lib/storage.mjs");
  await promoteCandidate(home, "a");

  const req = await buildReflectionRequest({
    home,
    signals: [{ ts: "2026-05-29T10:00:00Z", type: "correction", summary: "no" }],
    model: "claude-sonnet-4-6",
  });

  assert.equal(req.model, "claude-sonnet-4-6");
  assert.ok(Array.isArray(req.system), "system must be a block array (so cache_control can attach)");
  // Last system block should carry an ephemeral cache_control marker.
  const last = req.system[req.system.length - 1];
  assert.equal(last.cache_control?.type, "ephemeral");
});
