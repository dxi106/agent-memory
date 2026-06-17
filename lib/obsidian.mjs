import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listCandidates, listLessons, paths, resolveObsidianConfig } from "./storage.mjs";
import { withLock } from "./sync.mjs";

function severityTag(s) {
  if (typeof s !== "string") return "?";
  return s.toUpperCase();
}

function bullet(label, value) {
  return `- ${label}: ${value}`;
}

function renderCoachingTip(tip) {
  const head = `### [${severityTag(tip.severity)}] ${tip.id} — ${tip.title}`;
  const parts = [head];
  if (tip.body && tip.body.trim().length > 0) {
    parts.push("", tip.body.trim());
  }
  if (tip.nextStep && tip.nextStep.trim().length > 0) {
    parts.push("", `**Next step:** ${tip.nextStep.trim()}`);
  }
  return parts.join("\n");
}

function renderCandidate(c) {
  const head = `### ${c.id} — ${c.title}`;
  const meta = `_${c.category} • confidence ${Number(c.confidence ?? 0).toFixed(2)}_`;
  const parts = [head, "", meta];
  if (c.body && c.body.trim().length > 0) {
    parts.push("", c.body.trim());
  }
  return parts.join("\n");
}

function renderCounts(counts) {
  const total = counts?.signals7d?.total ?? 0;
  const c = counts?.signals7d?.correction ?? 0;
  const p = counts?.signals7d?.praise ?? 0;
  const r = counts?.signals7d?.retry ?? 0;
  return [
    "## Store at a glance",
    "",
    bullet("Active lessons", counts?.activeLessons ?? 0),
    bullet(
      "Signals (last 7d)",
      `${total} (corrections ${c} · praise ${p} · retries ${r})`,
    ),
  ].join("\n");
}

export function renderPending(state) {
  const lines = [
    "# Pending — agentmem",
    "",
    `Last updated: ${state.updatedAt} (triggered by ${state.triggeredBy})`,
    "",
    `## Coaching tips (${state.coachingTips.length})`,
    "",
  ];
  if (state.coachingTips.length === 0) {
    lines.push("_No pending coaching tips._");
  } else {
    lines.push(state.coachingTips.map(renderCoachingTip).join("\n\n"));
  }
  lines.push("", `## Candidate lessons (${state.candidates.length})`, "");
  if (state.candidates.length === 0) {
    lines.push("_No pending candidates._");
  } else {
    lines.push(state.candidates.map(renderCandidate).join("\n\n"));
  }
  lines.push("", renderCounts(state.counts));
  return lines.join("\n") + "\n";
}

function fmtBreakdown(b) {
  const c = b?.correction ?? 0;
  const p = b?.praise ?? 0;
  const r = b?.retry ?? 0;
  return `corrections ${c} · praise ${p} · retries ${r}`;
}

function renderReflectSection(p) {
  const lines = [
    `## reflect — ${p.timestamp}`,
    "",
    bullet("Signals considered", `${p.signalsConsidered} (${fmtBreakdown(p.signalBreakdown)})`),
  ];
  if (Array.isArray(p.newCandidates) && p.newCandidates.length > 0) {
    lines.push(`- New candidates (${p.newCandidates.length}):`);
    for (const c of p.newCandidates) {
      lines.push(`  - ${c.id} — ${c.title}`);
    }
  } else {
    lines.push("- New candidates: none");
  }
  lines.push(bullet("Rescored lessons", p.rescoredCount ?? 0));
  return lines.join("\n");
}

function renderCoachSection(p) {
  const lines = [
    `## coach — ${p.timestamp}`,
    "",
    bullet("Signals considered", p.signalsConsidered ?? 0),
  ];
  if (Array.isArray(p.newRecommendations) && p.newRecommendations.length > 0) {
    lines.push(`- New recommendations (${p.newRecommendations.length}):`);
    for (const r of p.newRecommendations) {
      lines.push(`  - [${severityTag(r.severity)}] ${r.id} — ${r.title}`);
    }
  } else {
    lines.push("- New recommendations: none");
  }
  const sk = p.skipped || {};
  lines.push(
    bullet(
      "Skipped",
      `${sk.dismissed ?? 0} dismissed · ${sk.snoozed ?? 0} snoozed · ${sk.existing ?? 0} already on file`,
    ),
  );
  return lines.join("\n");
}

export function renderDigestSection(payload) {
  if (payload.kind === "reflect") return renderReflectSection(payload);
  if (payload.kind === "coach") return renderCoachSection(payload);
  throw new Error(`Unknown digest kind: ${payload.kind}`);
}

async function countSignals7d(home) {
  const dir = paths(home).signals;
  const cutoffMs = Date.now() - 7 * 86400 * 1000;
  const counts = { total: 0, correction: 0, praise: 0, retry: 0 };
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return counts;
  }
  const cutoffStamp = new Date(cutoffMs).toISOString().slice(0, 10);
  const toRead = entries
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => f.slice(0, 10) >= cutoffStamp);
  for (const f of toRead) {
    let text;
    try {
      text = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = evt.ts ? Date.parse(evt.ts) : NaN;
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      counts.total += 1;
      if (evt.type === "correction") counts.correction += 1;
      else if (evt.type === "praise") counts.praise += 1;
      else if (evt.type === "retry") counts.retry += 1;
    }
  }
  return counts;
}

export async function collectPendingState(home, opts = {}) {
  // Lazy-import to break the obsidian↔coach cycle (see review on PR #14).
  const { listRecommendations } = await import("./coach.mjs");
  const [lessons, candidatesRaw, recsRaw, signals7d] = await Promise.all([
    listLessons(home),
    listCandidates(home),
    listRecommendations(home),
    countSignals7d(home),
  ]);
  const order = { high: 0, medium: 1, low: 2 };
  const pendingRecs = recsRaw
    .filter((r) => (r.meta.status || "pending") === "pending")
    .sort((a, b) => (order[a.meta.severity] ?? 9) - (order[b.meta.severity] ?? 9));
  const coachingTips = pendingRecs.map((r) => ({
    id: r.meta.id,
    severity: r.meta.severity || "?",
    title: (r.body.match(/^#\s+(.+)$/m) || [])[1] || r.meta.id,
    body: stripFirstHeading(r.body),
    nextStep: r.meta.next_step || "",
  }));
  const candidates = candidatesRaw.map((c) => ({
    id: c.meta.id,
    title: c.meta.title || c.meta.id,
    category: c.meta.category || "behavioral",
    confidence: c.meta.confidence ?? 0,
    body: c.body,
  }));
  return {
    updatedAt: new Date().toISOString(),
    triggeredBy: opts.triggeredBy || "manual",
    coachingTips,
    candidates,
    counts: {
      activeLessons: lessons.length,
      signals7d,
    },
  };
}

function stripFirstHeading(body) {
  return body.replace(/^#\s+.+\n+/, "").trim();
}

export async function writePending(cfg, markdown) {
  const dir = join(cfg.vaultPath, cfg.projectDir);
  await mkdir(dir, { recursive: true });
  const target = join(dir, "pending.md");
  await writeFile(target, markdown);
  return target;
}

export async function appendDigest(home, cfg, dateStr, sectionMarkdown) {
  return withLock(home, async () => {
    const dir = join(cfg.vaultPath, cfg.projectDir, "digests");
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${dateStr}.md`);
    let exists = false;
    try {
      await stat(target);
      exists = true;
    } catch {
      exists = false;
    }
    let toWrite;
    if (!exists) {
      toWrite = `# ${dateStr}\n\n${sectionMarkdown.trimEnd()}\n`;
    } else {
      const existing = await readFile(target, "utf8");
      const sep = existing.endsWith("\n") ? "" : "\n";
      toWrite = `${existing}${sep}\n---\n\n${sectionMarkdown.trimEnd()}\n`;
    }
    await writeFile(target, toWrite);
    return target;
  });
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

export async function syncToObsidian({ home, triggeredBy, pass } = {}) {
  const cfg = await resolveObsidianConfig(home);
  if (!cfg) {
    return { skipped: true, reason: "obsidian config not enabled" };
  }
  const state = await collectPendingState(home, { triggeredBy: triggeredBy || "manual" });
  const pendingMd = renderPending(state);
  const pendingPath = await writePending(cfg, pendingMd);
  let digestPath = null;
  if (pass && (pass.kind === "reflect" || pass.kind === "coach")) {
    const sectionMd = renderDigestSection(pass);
    digestPath = await appendDigest(home, cfg, todayDateStr(), sectionMd);
  }
  return { skipped: false, pendingPath, digestPath };
}
