#!/usr/bin/env node
import { join } from "node:path";
import {
  resolveHome,
  ensureLayout,
  listLessons,
  listCandidates,
  paths,
  promoteCandidate,
  rejectCandidate,
  retireLesson,
} from "../lib/storage.mjs";
import { appendSignal } from "../lib/signals.mjs";
import { statusSummary, findEntry, selectForInjection, exportAgents, reindex as reindexLessons } from "../lib/commands.mjs";
import { serializeLesson } from "../lib/lesson.mjs";
import { runReflection, defaultClient } from "../lib/reflect.mjs";
import { ingestClaudeCodeTranscripts } from "../lib/ingest.mjs";
import {
  ingestGitHubRepos,
  resolveProductionFetcher,
} from "../lib/ingest-github.mjs";
import { loadConfig } from "../lib/storage.mjs";
import {
  runCoachingPass,
  listRecommendations,
  getRecommendation,
  setRecommendationStatus,
  weeklyDigest,
  defaultClient as coachDefaultClient,
} from "../lib/coach.mjs";
import { syncToObsidian } from "../lib/obsidian.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const home = resolveHome();

const COMMANDS = {
  init,
  status,
  list,
  show,
  signal,
  promote,
  reject,
  retire,
  inject,
  export: exportCmd,
  reindex,
  reflect,
  ingest,
  coach,
  obsidian,
  help: usage,
};

(async () => {
  try {
    await (COMMANDS[cmd] || usage)(args.slice(1));
  } catch (e) {
    console.error(`agentmem: ${e.message}`);
    process.exit(1);
  }
})();

function usage() {
  console.log(`agentmem — cross-tool agent memory + coaching

Usage: agentmem <command> [args]

Commands:
  init                      Create the store layout
  status                    Counts of lessons / candidates / signals
  list [--candidates]       List active lessons (or candidates)
  show <id>                 Print a lesson or candidate
  signal <type> <summary>   Append a signal
  promote <id|all>          Promote a candidate to an active lesson (or every pending candidate)
  reject <id>               Discard a candidate
  retire <id>               Archive an active lesson
  inject [--scope <cwd>]    Print top lessons for a cwd (for hooks)
  export                    Regenerate the AGENTS.md lessons block
  reindex                   Rebuild INDEX.md
  reflect [--dry-run]       Run a reflection pass (needs AGENTMEM_API_KEY env or a keychain entry — see README)
  ingest [--since Nd]       Scrape Claude Code transcripts for signals
         [--host claude-code]
         [--source github]  Scrape GitHub repos in config.watch_repos for
                            PR review comments, reverts, hot files, and
                            convention changes (default since 30d)
  coach [list]              List pending recommendations
  coach run [--since 7d] [--dry-run]
                            Run a coaching pass (same key source as reflect)
  coach show <id|all>       Print a full recommendation (or every pending one)
  coach accept <id|all>     Mark a recommendation accepted (or every pending one)
  coach dismiss <id>        Dismiss a recommendation (sticky — never resurfaces)
  coach snooze <id> <days>  Snooze a recommendation for N days
  coach weekly              Write a weekly digest of recommendations
  obsidian sync             Sync pending tips + candidates + counts to the Obsidian vault

Store: ${home}`);
}

async function init() {
  await ensureLayout(home);
  await reindex();
  console.log(`Initialized agentmem at ${home}`);
}

async function status() {
  const s = await statusSummary(home);
  console.log(`agentmem — ${home}`);
  console.log(`  Active lessons:     ${s.lessons}`);
  console.log(`  Pending candidates: ${s.candidates}`);
  console.log(`  Signals (7d):       ${s.signals7d}`);
}

async function list(rest) {
  const wantCandidates = rest.includes("--candidates");
  const items = wantCandidates ? await listCandidates(home) : await listLessons(home);
  if (items.length === 0) {
    console.log(wantCandidates ? "No candidates." : "No active lessons.");
    return;
  }
  for (const l of items) {
    const conf = (l.meta.confidence ?? 0).toFixed(2);
    console.log(`  ${l.meta.id}  [${l.meta.category}] ${conf}  ${l.meta.title}`);
  }
}

async function show(rest) {
  const id = rest[0];
  if (!id) throw new Error("usage: agentmem show <id>");
  const entry = await findEntry(home, id);
  if (!entry) throw new Error(`Not found: ${id}`);
  console.log(serializeLesson(entry));
}

async function signal(rest) {
  const type = rest[0];
  const summary = rest.slice(1).join(" ");
  if (!type || !summary) throw new Error("usage: agentmem signal <type> <summary>");
  const written = await appendSignal(paths(home).signals, {
    host: process.env.AGENTMEM_HOST || "cli",
    type,
    cwd: process.cwd(),
    summary,
  });
  console.log(`signal recorded: ${written.type} @ ${written.ts}`);
}

async function promote(rest) {
  const id = rest[0];
  if (!id) throw new Error("usage: agentmem promote <id|all>");
  if (id === "all") {
    const candidates = await listCandidates(home);
    if (candidates.length === 0) {
      console.log("No candidates to promote.");
      return;
    }
    const promoted = [];
    const failed = [];
    for (const c of candidates) {
      try {
        await promoteCandidate(home, c.meta.id);
        promoted.push(c.meta.id);
      } catch (e) {
        failed.push({ id: c.meta.id, message: e.message });
      }
    }
    if (promoted.length > 0) {
      await exportAgents(home);
      await reindex();
      console.log(`promoted ${promoted.length} candidate(s):`);
      for (const pid of promoted) console.log(`  - ${pid}`);
    }
    if (failed.length > 0) {
      console.error(`failed ${failed.length}:`);
      for (const f of failed) console.error(`  - ${f.id}: ${f.message}`);
      process.exit(1);
    }
    return;
  }
  await promoteCandidate(home, id);
  await exportAgents(home);
  await reindex();
  console.log(`promoted: ${id}`);
}

async function reject(rest) {
  const id = rest[0];
  if (!id) throw new Error("usage: agentmem reject <id>");
  await rejectCandidate(home, id);
  console.log(`rejected: ${id}`);
}

async function retire(rest) {
  const id = rest[0];
  if (!id) throw new Error("usage: agentmem retire <id>");
  await retireLesson(home, id);
  await exportAgents(home);
  await reindex();
  console.log(`retired: ${id}`);
}

async function inject(rest) {
  const scopeIdx = rest.indexOf("--scope");
  let cwd = process.cwd();
  if (scopeIdx !== -1) {
    cwd = rest[scopeIdx + 1];
    if (!cwd) throw new Error("--scope requires a path argument");
  }
  const lessons = await selectForInjection(home, cwd, 12);
  for (const l of lessons) {
    console.log(`- ${l.meta.title}: ${l.body.replace(/\s+/g, " ").trim()}`);
  }
}

async function exportCmd() {
  await exportAgents(home);
  console.log(`exported lessons to ${join(home, "AGENTS.md")}`);
}

// Delegate to lib/commands.mjs::reindex so MCP and CLI stay in sync.
async function reindex() {
  await reindexLessons(home);
}

async function reflect(rest) {
  const dryRun = rest.includes("--dry-run");
  const client = await defaultClient();
  const result = await runReflection({ home, client, dryRun });

  if (result.skipped) {
    console.log(`reflect: skipped (${result.reason})`);
    return;
  }

  if (dryRun) {
    if (result.candidates.length === 0) {
      console.log("reflect (dry-run): no candidates proposed");
      return;
    }
    console.log(`reflect (dry-run): ${result.candidates.length} candidate(s) proposed:`);
    for (const c of result.candidates) {
      console.log(`\n--- ${c.meta.id} (${c.meta.category}) ---`);
      console.log(c.meta.title);
      console.log(c.body);
    }
    return;
  }

  console.log(`reflect: wrote ${result.candidates.length} candidate(s), rescored ${result.rescored.length} lesson(s)`);
  if (result.logPath) console.log(`         log: ${result.logPath}`);
  if (result.usage) {
    const u = result.usage;
    const cached = u.cache_read_input_tokens ?? 0;
    const written = u.cache_creation_input_tokens ?? 0;
    console.log(`         tokens: in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_read=${cached} cache_write=${written}`);
  }
}

function parseSinceFlag(rest) {
  const idx = rest.indexOf("--since");
  if (idx === -1) return null;
  const raw = rest[idx + 1];
  if (!raw) throw new Error("--since requires a value (e.g. 7d)");
  // Accept "7d" or bare "7".
  const m = String(raw).match(/^(\d+)d?$/);
  if (!m) throw new Error(`--since value must be like "7d", got ${JSON.stringify(raw)}`);
  return Number(m[1]);
}

async function ingest(rest) {
  const sourceIdx = rest.indexOf("--source");
  let source = null;
  if (sourceIdx !== -1) {
    source = rest[sourceIdx + 1];
    if (!source) throw new Error("--source requires a value (e.g. github)");
  }

  // --source github routes to the GitHub ingester; otherwise --host
  // selects the transcript host (claude-code is the only one for now).
  if (source === "github") {
    return ingestGitHub(rest);
  }
  if (source && source !== "claude-code") {
    throw new Error(`unsupported --source ${source} (use claude-code or github)`);
  }

  const hostIdx = rest.indexOf("--host");
  let host = "claude-code";
  if (hostIdx !== -1) {
    host = rest[hostIdx + 1];
    if (!host) throw new Error("--host requires a value (e.g. claude-code)");
  }
  if (host !== "claude-code") {
    throw new Error(`unsupported --host ${host} (only claude-code in SOU-14)`);
  }

  const sinceOverride = parseSinceFlag(rest);
  const config = await loadConfig(home).catch(() => ({}));
  const since = sinceOverride ?? config.reflection?.lookback_days ?? 7;
  const projectsDir =
    config.sources?.claude_code_projects_dir ||
    join(process.env.HOME || "", ".claude", "projects");

  const result = await ingestClaudeCodeTranscripts({ home, projectsDir, since });
  console.log(`ingest (claude-code): wrote ${result.count} signal(s) from ${result.scannedFiles} file(s) in the last ${since}d`);
}

async function ingestGitHub(rest) {
  const sinceOverride = parseSinceFlag(rest);
  const config = await loadConfig(home).catch(() => ({}));
  const since = sinceOverride ?? config.github?.lookback_days ?? 30;
  const repos = Array.isArray(config.watch_repos) ? config.watch_repos : [];

  if (repos.length === 0) {
    console.log(`ingest (github): watch_repos is empty in config.json — no-op`);
    return;
  }

  const ghFetch = await resolveProductionFetcher();
  if (!ghFetch) {
    throw new Error(
      "no GitHub auth available: install + authenticate `gh` (recommended) or set GITHUB_TOKEN",
    );
  }

  const result = await ingestGitHubRepos({
    home,
    repos,
    since,
    ghFetch,
    maxPrsPerRepo: config.github?.max_prs_per_repo ?? 50,
    maxCommitsPerRepo: config.github?.max_commits_per_repo ?? 50,
    hotFileThreshold: config.github?.hot_file_threshold ?? 5,
    hotFileWindowDays: config.github?.hot_file_window_days ?? 14,
  });

  console.log(
    `ingest (github): wrote ${result.signalsWritten} signal(s) across ${result.reposProcessed} repo(s) in the last ${since}d`,
  );
  if (result.errors.length > 0) {
    console.error(`ingest (github): ${result.errors.length} error(s):`);
    for (const e of result.errors) console.error(`  - ${e.message}`);
  }
}

async function obsidian(rest) {
  const sub = rest[0];
  if (sub !== "sync") {
    throw new Error(`usage: agentmem obsidian sync`);
  }
  const result = await syncToObsidian({ home, triggeredBy: "manual" });
  if (result.skipped) {
    console.log(`obsidian: skipped (${result.reason})`);
    return;
  }
  console.log(`pending: ${result.pendingPath}`);
  if (result.digestPath) console.log(`digest:  ${result.digestPath}`);
}

function ageDays(isoDate) {
  if (!isoDate || typeof isoDate !== "string") return "?";
  const then = new Date(isoDate + "T00:00:00Z").getTime();
  if (Number.isNaN(then)) return "?";
  const days = Math.floor((Date.now() - then) / 86400000);
  return `${days}d`;
}

async function coach(rest) {
  const sub = rest[0];

  // Bare `coach` and `coach list` → list pending recommendations.
  if (!sub || sub === "list") {
    const recs = await listRecommendations(home);
    const pending = recs.filter((r) => (r.meta.status || "pending") === "pending");
    if (pending.length === 0) {
      console.log("No pending recommendations.");
      return;
    }
    // Severity order — high first.
    const order = { high: 0, medium: 1, low: 2 };
    pending.sort((a, b) => (order[a.meta.severity] ?? 9) - (order[b.meta.severity] ?? 9));
    for (const r of pending) {
      const title = (r.body.match(/^#\s+(.+)$/m) || [])[1] || r.meta.id;
      const sev = (r.meta.severity || "?").padEnd(6);
      const age = ageDays(r.meta.created);
      console.log(`  ${r.meta.id}  [${sev}] ${title}  (${age})`);
    }
    return;
  }

  if (sub === "run") {
    const sinceIdx = rest.indexOf("--since");
    let sinceDays = null;
    if (sinceIdx !== -1) {
      const raw = rest[sinceIdx + 1];
      if (!raw) throw new Error("--since requires a value (e.g. 7d)");
      const m = String(raw).match(/^(\d+)d?$/);
      if (!m) throw new Error(`--since value must be like "7d", got ${JSON.stringify(raw)}`);
      sinceDays = Number(m[1]);
    }
    const dryRun = rest.includes("--dry-run");
    const client = await coachDefaultClient();
    const result = await runCoachingPass({ home, client, sinceDays, dryRun });
    if (result.skipped) {
      console.log(`coach: skipped (${result.reason})`);
      return;
    }
    if (dryRun) {
      if (result.recommendations.length === 0) {
        console.log("coach (dry-run): no recommendations proposed");
        return;
      }
      console.log(`coach (dry-run): ${result.recommendations.length} recommendation(s) proposed:`);
      for (const r of result.recommendations) {
        console.log(`\n--- ${r.id} (${r.severity}, ${r.category}) ---`);
        console.log(r.title);
        console.log(r.body);
      }
      return;
    }
    console.log(
      `coach: wrote ${result.recommendations.length} recommendation(s)` +
      ` (skipped ${result.skippedDismissed} dismissed, ${result.skippedSnoozed} snoozed,` +
      ` ${result.skippedExisting ?? 0} already on file)`,
    );
    if (result.notified && result.notified.length > 0) {
      console.log(`       notified: ${result.notified.length} HIGH-severity tip(s) via macOS notification`);
    }
    if (result.logPath) console.log(`       log: ${result.logPath}`);
    if (result.usage) {
      const u = result.usage;
      const cached = u.cache_read_input_tokens ?? 0;
      const written = u.cache_creation_input_tokens ?? 0;
      console.log(`       tokens: in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_read=${cached} cache_write=${written}`);
    }
    return;
  }

  if (sub === "show") {
    const id = rest[1];
    if (!id) throw new Error("usage: agentmem coach show <id|all>");
    const { readFile } = await import("node:fs/promises");
    if (id === "all") {
      const recs = await listRecommendations(home);
      const pending = recs.filter((r) => (r.meta.status || "pending") === "pending");
      if (pending.length === 0) {
        console.log("No pending recommendations.");
        return;
      }
      const order = { high: 0, medium: 1, low: 2 };
      pending.sort((a, b) => (order[a.meta.severity] ?? 9) - (order[b.meta.severity] ?? 9));
      for (let i = 0; i < pending.length; i++) {
        if (i > 0) console.log("---\n");
        const text = await readFile(pending[i].path, "utf8");
        console.log(text.trimEnd());
      }
      return;
    }
    const rec = await getRecommendation(home, id);
    if (!rec) throw new Error(`Recommendation not found: ${id}`);
    const text = await readFile(rec.path, "utf8");
    console.log(text);
    return;
  }

  if (sub === "accept") {
    const id = rest[1];
    if (!id) throw new Error("usage: agentmem coach accept <id|all>");
    if (id === "all") {
      const recs = await listRecommendations(home);
      const pending = recs.filter((r) => (r.meta.status || "pending") === "pending");
      if (pending.length === 0) {
        console.log("No pending recommendations.");
        return;
      }
      const accepted = [];
      const failed = [];
      for (const r of pending) {
        try {
          await setRecommendationStatus(home, r.meta.id, "accepted");
          accepted.push(r.meta.id);
        } catch (e) {
          failed.push({ id: r.meta.id, message: e.message });
        }
      }
      if (accepted.length > 0) {
        console.log(`accepted ${accepted.length} recommendation(s):`);
        for (const aid of accepted) console.log(`  - ${aid}`);
      }
      if (failed.length > 0) {
        console.error(`failed ${failed.length}:`);
        for (const f of failed) console.error(`  - ${f.id}: ${f.message}`);
        process.exit(1);
      }
      return;
    }
    await setRecommendationStatus(home, id, "accepted");
    console.log(`accepted: ${id}`);
    return;
  }

  if (sub === "dismiss") {
    const id = rest[1];
    if (!id) throw new Error("usage: agentmem coach dismiss <id>");
    await setRecommendationStatus(home, id, "dismissed");
    console.log(`dismissed: ${id}`);
    return;
  }

  if (sub === "snooze") {
    const id = rest[1];
    const daysRaw = rest[2];
    if (!id || !daysRaw) throw new Error("usage: agentmem coach snooze <id> <days>");
    const days = Number(daysRaw);
    if (!Number.isFinite(days)) throw new Error("snooze <days> must be a number");
    await setRecommendationStatus(home, id, "snoozed", { days });
    console.log(`snoozed: ${id} for ${days} day(s)`);
    return;
  }

  if (sub === "weekly") {
    const file = await weeklyDigest(home);
    console.log(`weekly digest written: ${file}`);
    return;
  }

  throw new Error(
    `unknown coach subcommand: ${JSON.stringify(sub)} (try one of: list, run, show, accept, dismiss, snooze, weekly)`,
  );
}
