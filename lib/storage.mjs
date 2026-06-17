import { mkdir, readdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseLesson, serializeLesson } from "./lesson.mjs";
import { resolveHome, paths } from "./paths.mjs";

export { resolveHome, paths };

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeId(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error(`Invalid id: ${JSON.stringify(id)} (ids must match ${SAFE_ID})`);
  }
}

export async function ensureLayout(home) {
  const p = paths(home);
  const dirs = [
    p.lessonsBehavioral,
    p.lessonsCode,
    p.lessonsWorkflow,
    p.candidates,
    p.signals,
    p.archive,
    p.reflections,
    p.knowledge,
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

async function readLessonsFromDir(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const full = join(dir, f);
    const lesson = parseLesson(await readFile(full, "utf8"));
    lesson.path = full;
    out.push(lesson);
  }
  return out;
}

export async function listLessons(home) {
  const p = paths(home);
  const all = [];
  for (const dir of [p.lessonsBehavioral, p.lessonsCode, p.lessonsWorkflow]) {
    all.push(...(await readLessonsFromDir(dir)));
  }
  return all;
}

export async function listCandidates(home) {
  return readLessonsFromDir(paths(home).candidates);
}

export async function writeCandidate(home, lesson) {
  assertSafeId(lesson?.meta?.id);
  const p = paths(home);
  await mkdir(p.candidates, { recursive: true });
  const file = join(p.candidates, `${lesson.meta.id}.md`);
  await writeFile(file, serializeLesson(lesson));
  return file;
}

function categoryDir(home, category) {
  const p = paths(home);
  if (category === "code") return p.lessonsCode;
  if (category === "workflow") return p.lessonsWorkflow;
  return p.lessonsBehavioral;
}

export async function promoteCandidate(home, id) {
  assertSafeId(id);
  const src = join(paths(home).candidates, `${id}.md`);
  let text;
  try {
    text = await readFile(src, "utf8");
  } catch {
    throw new Error(`Candidate not found: ${id}`);
  }
  const lesson = parseLesson(text);
  const destDir = categoryDir(home, lesson.meta.category);
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, `${id}.md`);
  await rename(src, dest);
  return dest;
}

export async function rejectCandidate(home, id) {
  assertSafeId(id);
  try {
    await unlink(join(paths(home).candidates, `${id}.md`));
  } catch {
    throw new Error(`Candidate not found: ${id}`);
  }
}

export async function retireLesson(home, id) {
  assertSafeId(id);
  const lesson = (await listLessons(home)).find((l) => l.meta.id === id);
  if (!lesson) throw new Error(`Lesson not found: ${id}`);
  const p = paths(home);
  await mkdir(p.archive, { recursive: true });
  let dest = join(p.archive, `${id}.md`);
  try {
    await stat(dest);
    dest = join(p.archive, `${id}-${Date.now()}.md`);
  } catch {
    // no existing archive for this id — use the base name
  }
  await rename(lesson.path, dest);
  return dest;
}

export async function loadConfig(home) {
  return JSON.parse(await readFile(paths(home).config, "utf8"));
}

export async function resolveObsidianConfig(home) {
  let config;
  try {
    config = await loadConfig(home);
  } catch {
    return null;
  }
  const block = config?.obsidian;
  if (!block || block.enabled !== true) return null;
  if (!block.vault_path || typeof block.vault_path !== "string") {
    throw new Error(
      "config.obsidian.enabled is true but vault_path is missing or not a string",
    );
  }
  const projectDir =
    typeof block.project_dir === "string" && block.project_dir.length > 0
      ? block.project_dir
      : "Projects/agentmem";
  return { vaultPath: block.vault_path, projectDir };
}
