import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLayout,
  paths,
  listLessons,
  listCandidates,
  writeCandidate,
  promoteCandidate,
  rejectCandidate,
  retireLesson,
  resolveObsidianConfig,
} from "../lib/storage.mjs";

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "agentmem-home-"));
  await ensureLayout(home);
  return home;
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function candidate(id, category, extra = {}) {
  return {
    meta: { id, title: `Lesson ${id}`, category, confidence: 0.35, ...extra },
    body: `**Rule:** test rule for ${id}.`,
  };
}

test("ensureLayout creates the expected subdirectories", async () => {
  const home = await tmpHome();
  const p = paths(home);
  assert.ok(await isDir(p.lessonsBehavioral));
  assert.ok(await isDir(p.lessonsCode));
  assert.ok(await isDir(p.lessonsWorkflow));
  assert.ok(await isDir(p.candidates));
  assert.ok(await isDir(p.signals));
  assert.ok(await isDir(p.archive));
});

test("listLessons returns empty array for a fresh store", async () => {
  const home = await tmpHome();
  assert.deepEqual(await listLessons(home), []);
});

test("writeCandidate then listCandidates round-trips", async () => {
  const home = await tmpHome();
  await writeCandidate(home, candidate("c1", "code"));
  const cands = await listCandidates(home);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].meta.id, "c1");
  assert.equal(cands[0].meta.category, "code");
});

test("promoteCandidate moves a candidate into its category and out of candidates", async () => {
  const home = await tmpHome();
  await writeCandidate(home, candidate("c2", "behavioral"));
  await promoteCandidate(home, "c2");

  const lessons = await listLessons(home);
  const cands = await listCandidates(home);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].meta.id, "c2");
  assert.equal(lessons[0].meta.category, "behavioral");
  assert.equal(cands.length, 0);
});

test("rejectCandidate removes the candidate without creating a lesson", async () => {
  const home = await tmpHome();
  await writeCandidate(home, candidate("c3", "workflow"));
  await rejectCandidate(home, "c3");
  assert.equal((await listCandidates(home)).length, 0);
  assert.equal((await listLessons(home)).length, 0);
});

test("retireLesson moves a promoted lesson to the archive", async () => {
  const home = await tmpHome();
  await writeCandidate(home, candidate("c4", "code"));
  await promoteCandidate(home, "c4");
  await retireLesson(home, "c4");
  assert.equal((await listLessons(home)).length, 0);
});

test("promoteCandidate throws for an unknown id", async () => {
  const home = await tmpHome();
  await assert.rejects(() => promoteCandidate(home, "nope"), /not found/i);
});

test("rejectCandidate refuses a path-traversal id", async () => {
  const home = await tmpHome();
  await assert.rejects(() => rejectCandidate(home, "../../etc/passwd"), /invalid id/i);
});

test("promoteCandidate refuses a path-traversal id", async () => {
  const home = await tmpHome();
  await assert.rejects(() => promoteCandidate(home, "../lessons/x"), /invalid id/i);
});

test("writeCandidate refuses a path-traversal id", async () => {
  const home = await tmpHome();
  await assert.rejects(
    () => writeCandidate(home, { meta: { id: "../escape", category: "code" }, body: "x" }),
    /invalid id/i,
  );
});

test("retireLesson re-archiving the same id does not overwrite the prior archive", async () => {
  const home = await tmpHome();
  await writeCandidate(home, candidate("dup", "code"));
  await promoteCandidate(home, "dup");
  await retireLesson(home, "dup");
  await writeCandidate(home, candidate("dup", "code"));
  await promoteCandidate(home, "dup");
  await retireLesson(home, "dup");
  const { readdir } = await import("node:fs/promises");
  const archived = (await readdir(join(home, "archive"))).filter((f) => f.startsWith("dup"));
  assert.equal(archived.length, 2);
});

test("resolveObsidianConfig returns null when no obsidian block exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-cfg-"));
  await ensureLayout(home);
  await writeFile(join(home, "config.json"), JSON.stringify({}, null, 2));
  assert.equal(await resolveObsidianConfig(home), null);
});

test("resolveObsidianConfig returns null when obsidian.enabled is false", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-cfg-"));
  await ensureLayout(home);
  await writeFile(join(home, "config.json"), JSON.stringify({
    obsidian: { enabled: false, vault_path: "/v", project_dir: "p" },
  }, null, 2));
  assert.equal(await resolveObsidianConfig(home), null);
});

test("resolveObsidianConfig returns the normalized shape when enabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-cfg-"));
  await ensureLayout(home);
  await writeFile(join(home, "config.json"), JSON.stringify({
    obsidian: { enabled: true, vault_path: "/Users/x/Vault", project_dir: "Projects/agentmem" },
  }, null, 2));
  const cfg = await resolveObsidianConfig(home);
  assert.deepEqual(cfg, {
    vaultPath: "/Users/x/Vault",
    projectDir: "Projects/agentmem",
  });
});

test("resolveObsidianConfig throws when enabled but vault_path is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-cfg-"));
  await ensureLayout(home);
  await writeFile(join(home, "config.json"), JSON.stringify({
    obsidian: { enabled: true, project_dir: "p" },
  }, null, 2));
  await assert.rejects(
    () => resolveObsidianConfig(home),
    /vault_path/i,
  );
});

test("resolveObsidianConfig falls back to default project_dir when missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-cfg-"));
  await ensureLayout(home);
  await writeFile(join(home, "config.json"), JSON.stringify({
    obsidian: { enabled: true, vault_path: "/Users/x/Vault" },
  }, null, 2));
  const cfg = await resolveObsidianConfig(home);
  assert.deepEqual(cfg, {
    vaultPath: "/Users/x/Vault",
    projectDir: "Projects/agentmem",
  });
});
