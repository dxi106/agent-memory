import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listLessons, listCandidates, paths } from "./storage.mjs";
import { readSignalsSince } from "./signals.mjs";
import { withLock } from "./sync.mjs";

export async function statusSummary(home) {
  const lessons = await listLessons(home);
  const candidates = await listCandidates(home);
  const signals = await readSignalsSince(paths(home).signals, 7);
  return { lessons: lessons.length, candidates: candidates.length, signals7d: signals.length };
}

export async function findEntry(home, id) {
  const all = [...(await listLessons(home)), ...(await listCandidates(home))];
  return all.find((l) => l.meta.id === id) || null;
}

function matchesScope(lesson, cwd) {
  const repos = lesson.meta?.scope?.repos || ["*"];
  if (repos.includes("*")) return true;
  const segments = cwd.split("/").filter(Boolean);
  return repos.some((r) => segments.includes(r));
}

export async function selectForInjection(home, cwd, limit) {
  const lessons = await listLessons(home);
  return lessons
    .filter((l) => matchesScope(l, cwd))
    .sort((a, b) => (b.meta.confidence ?? 0) - (a.meta.confidence ?? 0))
    .slice(0, limit);
}

const BEGIN = "<!-- BEGIN agentmem lessons -->";
const END = "<!-- END agentmem lessons -->";
const BLOCK_RE = /\n*<!-- BEGIN agentmem lessons -->[\s\S]*?<!-- END agentmem lessons -->\n*/;

function formatLessonsBlock(lessons) {
  const lines = [BEGIN, "## Learned lessons (managed by agentmem — do not edit between markers)", ""];
  for (const l of lessons) {
    const conf = (l.meta.confidence ?? 0).toFixed(2);
    lines.push(`### ${l.meta.title} (${l.meta.category}, confidence ${conf})`);
    lines.push("");
    lines.push(l.body.trim());
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n");
}

// Rebuild INDEX.md from active lessons. Extracted from bin/agentmem.mjs so
// every promote/reject/retire path (CLI and MCP) can keep the index in sync
// without copy-pasting the formatter.
export async function reindex(home) {
  const lessons = await listLessons(home);
  const lines = ["# agentmem index", "", `_${lessons.length} active lessons_`, ""];
  for (const l of lessons) {
    const conf = (l.meta.confidence ?? 0).toFixed(2);
    lines.push(`- **${l.meta.title}** (${l.meta.category}, ${conf}) — \`${l.meta.id}\``);
  }
  await writeFile(join(home, "INDEX.md"), lines.join("\n") + "\n");
}

export async function exportAgents(home) {
  // Wrap the read-modify-write of AGENTS.md in the store-wide lockfile
  // (`<home>/.lock`) so two concurrent promote/reject/retire calls can't
  // race and silently drop one pass's lessons (SOU-26). withLock retries
  // briefly on a held lock — exportAgents callers want the write to
  // complete, not to skip.
  return withLock(home, async () => {
    const agentsPath = join(home, "AGENTS.md");
    let base = "";
    try {
      base = await readFile(agentsPath, "utf8");
    } catch {
      base = "";
    }
    base = base.replace(BLOCK_RE, "\n").trimEnd();
    const block = formatLessonsBlock(await listLessons(home));
    const out = `${base}\n\n${block}\n`;
    await writeFile(agentsPath, out);
    return out;
  });
}
