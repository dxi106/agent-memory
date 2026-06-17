// MCP server for agentmem (SOU-23).
//
// Exposes the agentmem store as MCP tools so any MCP-capable host
// (Claude Code, Cowork, Codex, Gemini CLI, …) can call into the same
// signal/lesson/coaching lifecycle without needing per-host hooks.
//
// Design notes:
//   - createMcpServer({ home }) returns a fully-configured McpServer; the
//     transport (stdio for the CLI entry point, InMemoryTransport for tests)
//     is the caller's responsibility.
//   - Tool handlers MUST NOT throw out of the SDK boundary: any throw will
//     close the transport and kill the server. Every handler funnels through
//     `safe()` which catches and returns a clean tool-error result.
//   - `home` defaults to resolveHome() so the binary picks up AGENTMEM_HOME
//     the same way the CLI does.

import { existsSync } from "node:fs";
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { resolveHome, paths } from "./paths.mjs";
import {
  listLessons,
  listCandidates,
  promoteCandidate,
  rejectCandidate,
} from "./storage.mjs";
import { appendSignal } from "./signals.mjs";
import { selectForInjection, exportAgents, reindex } from "./commands.mjs";
import { listRecommendations, isSnoozed } from "./coach.mjs";

const SERVER_NAME = "agentmem";
const SERVER_VERSION = "0.1.0";

const MCP_HOST = "mcp";

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function jsonResult(obj) {
  return textResult(JSON.stringify(obj));
}

function errorResult(message) {
  return { content: [{ type: "text", text: `agentmem: ${message}` }], isError: true };
}

// Wraps a tool handler so any throw becomes a clean isError tool result.
// Tool handlers must never let an exception escape the SDK boundary — doing
// so closes the transport and kills the server process.
function safe(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err?.message || String(err));
    }
  };
}

// Lowercase keyword match against a lesson's title + body.
// Empty / missing query → match everything.
function matchesQuery(lesson, query) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  if (!q) return true;
  const haystack = `${lesson.meta?.title || ""} ${lesson.body || ""}`.toLowerCase();
  return haystack.includes(q);
}

function lessonSummary(lesson) {
  const m = lesson.meta || {};
  return {
    id: m.id,
    title: m.title,
    category: m.category,
    confidence: m.confidence ?? 0,
    body: (lesson.body || "").trim(),
  };
}

function candidateSummary(c) {
  const m = c.meta || {};
  return {
    id: m.id,
    title: m.title,
    category: m.category,
    confidence: m.confidence ?? 0,
  };
}

function recommendationSummary(r) {
  const m = r.meta || {};
  const title = (r.body.match(/^#\s+(.+)$/m) || [])[1] || m.id;
  return {
    id: m.id,
    title,
    severity: m.severity,
    category: m.category,
    next_step: m.next_step || null,
    status: m.status || "pending",
  };
}

// Coaching-tip filter:
//   - status must be pending (default)
//   - must not be snoozed (snooze_until in the future)
//   - must be relevant to the caller's scope:
//       * if a directory path is provided that exists on disk, the rec's
//         evidence/body must mention it (substring), OR
//       * if scope is provided but doesn't exist on disk, we fall back to
//         substring match alone (useful for unit tests with synthetic scopes).
function recommendationMatchesScope(rec, scope) {
  if (!scope) return true;
  const hay = `${rec.body || ""} ${(rec.meta?.evidence || []).join(" ")} ${rec.meta?.next_step || ""}`;
  return hay.includes(scope);
}

export function createMcpServer({ home = resolveHome() } = {}) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // ----- remember_correction --------------------------------------------------
  server.registerTool(
    "remember_correction",
    {
      description:
        "Record a correction signal — the user (or agent on the user's behalf) telling agentmem to stop doing something or do it differently. Appears in the shared signals log; future reflection passes may turn it into a candidate lesson.",
      inputSchema: {
        summary: z.string().describe("Short description of what to correct"),
        scope: z
          .string()
          .optional()
          .describe("Repo name or path the correction applies to (optional — defaults to global)"),
      },
    },
    safe(async ({ summary, scope }) => {
      const text = (summary || "").trim();
      if (!text) throw new Error("summary is required");
      const written = await appendSignal(paths(home).signals, {
        host: MCP_HOST,
        type: "correction",
        cwd: process.cwd(),
        summary: text,
        ...(scope ? { scope } : {}),
      });
      return jsonResult({ ok: true, signal: { type: written.type, ts: written.ts } });
    }),
  );

  // ----- remember_praise ------------------------------------------------------
  server.registerTool(
    "remember_praise",
    {
      description:
        "Record a praise signal — explicit positive feedback. Helps the reflection pass identify behaviors worth reinforcing.",
      inputSchema: {
        summary: z.string().describe("What worked / what to keep doing"),
        scope: z.string().optional().describe("Repo name or path (optional)"),
      },
    },
    safe(async ({ summary, scope }) => {
      const text = (summary || "").trim();
      if (!text) throw new Error("summary is required");
      const written = await appendSignal(paths(home).signals, {
        host: MCP_HOST,
        type: "praise",
        cwd: process.cwd(),
        summary: text,
        ...(scope ? { scope } : {}),
      });
      return jsonResult({ ok: true, signal: { type: written.type, ts: written.ts } });
    }),
  );

  // ----- remember_decision ----------------------------------------------------
  server.registerTool(
    "remember_decision",
    {
      description:
        "Record a deliberate decision and its reasoning (e.g. 'use Railway because cron is free'). Stored as a manual signal so it surfaces in future reflection / coaching passes.",
      inputSchema: {
        decision: z.string().describe("The decision (what was chosen)"),
        reason: z.string().describe("Why this choice — context the model should remember"),
        scope: z.string().optional().describe("Repo name or path (optional)"),
      },
    },
    safe(async ({ decision, reason, scope }) => {
      const d = (decision || "").trim();
      const r = (reason || "").trim();
      if (!d) throw new Error("decision is required");
      if (!r) throw new Error("reason is required");
      const summary = `decision: ${d} — because: ${r}`;
      const written = await appendSignal(paths(home).signals, {
        host: MCP_HOST,
        type: "manual",
        subtype: "decision",
        cwd: process.cwd(),
        summary,
        ...(scope ? { scope } : {}),
      });
      return jsonResult({ ok: true, signal: { type: written.type, ts: written.ts } });
    }),
  );

  // ----- recall ---------------------------------------------------------------
  server.registerTool(
    "recall",
    {
      description:
        "Search active agentmem lessons by keyword + scope. Returns the top matches ranked by confidence. Use this when you want to look up what you've learned about a topic before answering.",
      inputSchema: {
        query: z.string().optional().describe("Keyword (case-insensitive) — match against title + body"),
        scope: z.string().describe("Working directory or repo path — filters by lesson scope"),
        limit: z.number().int().positive().optional().describe("Max lessons to return (default 8)"),
      },
    },
    safe(async ({ query, scope, limit }) => {
      const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
      // selectForInjection already filters by scope + sorts by confidence.
      // Pull a larger window so keyword filtering still has room to find hits.
      const window = Math.max(max * 4, 32);
      const inScope = await selectForInjection(home, scope || "", window);
      const matches = inScope.filter((l) => matchesQuery(l, query)).slice(0, max);
      return jsonResult({ lessons: matches.map(lessonSummary) });
    }),
  );

  // ----- inject ---------------------------------------------------------------
  server.registerTool(
    "inject",
    {
      description:
        "Return the top in-scope lessons formatted as bullet lines, ready for the agent to include in its working context. Same selection logic as `agentmem inject`.",
      inputSchema: {
        scope: z.string().describe("Working directory or repo path"),
        limit: z.number().int().positive().optional().describe("Max lessons to return (default 12)"),
      },
    },
    safe(async ({ scope, limit }) => {
      const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;
      const lessons = await selectForInjection(home, scope || "", max);
      const lines = lessons.map(
        (l) => `- ${l.meta?.title || l.meta?.id}: ${(l.body || "").replace(/\s+/g, " ").trim()}`,
      );
      return textResult(lines.join("\n"));
    }),
  );

  // ----- list_pending ---------------------------------------------------------
  server.registerTool(
    "list_pending",
    {
      description:
        "List candidate lessons awaiting promote/reject AND pending coaching recommendations awaiting accept/dismiss/snooze.",
      inputSchema: {},
    },
    safe(async () => {
      const candidates = (await listCandidates(home)).map(candidateSummary);
      const allRecs = await listRecommendations(home);
      const pendingRecs = allRecs
        .filter((r) => (r.meta?.status || "pending") === "pending")
        .map(recommendationSummary);
      return jsonResult({ candidates, recommendations: pendingRecs });
    }),
  );

  // ----- promote --------------------------------------------------------------
  server.registerTool(
    "promote",
    {
      description: "Promote a candidate lesson to active. Same as `agentmem promote <id>`.",
      inputSchema: { id: z.string().describe("Candidate id") },
    },
    safe(async ({ id }) => {
      await promoteCandidate(home, id);
      // Mirror the CLI: regenerate AGENTS.md (so the new lesson is exported)
      // AND INDEX.md (so the index doesn't drift after MCP-driven promotes).
      await exportAgents(home);
      await reindex(home);
      return jsonResult({ ok: true, promoted: id });
    }),
  );

  // ----- reject ---------------------------------------------------------------
  server.registerTool(
    "reject",
    {
      description: "Reject (discard) a candidate lesson. Same as `agentmem reject <id>`.",
      inputSchema: { id: z.string().describe("Candidate id") },
    },
    safe(async ({ id }) => {
      await rejectCandidate(home, id);
      return jsonResult({ ok: true, rejected: id });
    }),
  );

  // ----- coach_accept ---------------------------------------------------------
  server.registerTool(
    "coach_accept",
    {
      description:
        "Mark a pending coaching recommendation as accepted. Same as `agentmem coach accept <id>`. Use after the user agrees to apply a tip from `list_pending()` or `get_coaching_tips()`.",
      inputSchema: { id: z.string().describe("Recommendation id") },
    },
    safe(async ({ id }) => {
      const { setRecommendationStatus } = await import("./coach.mjs");
      await setRecommendationStatus(home, id, "accepted");
      return jsonResult({ ok: true, accepted: id });
    }),
  );

  // ----- coach_dismiss --------------------------------------------------------
  server.registerTool(
    "coach_dismiss",
    {
      description:
        "Dismiss a coaching recommendation. Sticky — a dismissed id never resurfaces in a future coaching pass. Same as `agentmem coach dismiss <id>`.",
      inputSchema: { id: z.string().describe("Recommendation id") },
    },
    safe(async ({ id }) => {
      const { setRecommendationStatus } = await import("./coach.mjs");
      await setRecommendationStatus(home, id, "dismissed");
      return jsonResult({ ok: true, dismissed: id });
    }),
  );

  // ----- coach_snooze ---------------------------------------------------------
  server.registerTool(
    "coach_snooze",
    {
      description:
        "Snooze a coaching recommendation for N days. After snooze_until, the rec is no longer filtered out of `get_coaching_tips` and can resurface in a future coaching pass — but the stored `status` field stays \"snoozed\" until you call `coach_accept` or `coach_dismiss` to finalize. Same as `agentmem coach snooze <id> <days>`.",
      inputSchema: {
        id: z.string().describe("Recommendation id"),
        days: z.number().int().positive().describe("Days to snooze"),
      },
    },
    safe(async ({ id, days }) => {
      const { setRecommendationStatus } = await import("./coach.mjs");
      await setRecommendationStatus(home, id, "snoozed", { days });
      return jsonResult({ ok: true, snoozed: id, days });
    }),
  );

  // ----- get_coaching_tips ----------------------------------------------------
  server.registerTool(
    "get_coaching_tips",
    {
      description:
        "Return pending coaching recommendations relevant to the caller's working directory. Filters out dismissed/snoozed and (if `scope` is a real directory) only returns recs whose evidence references that path.",
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe("Working directory (optional — defaults to no scope filter)"),
        limit: z.number().int().positive().optional().describe("Max recs (default 8)"),
      },
    },
    safe(async ({ scope, limit }) => {
      const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
      const all = await listRecommendations(home);
      // Filter (status, snooze, scope) → sort by severity → slice. The sort
      // MUST come before the limit, otherwise a store whose directory-read
      // order puts low-severity recs first would silently drop the
      // high-severity ones we most want to surface.
      const pending = all.filter((r) => (r.meta?.status || "pending") === "pending");
      const matches = [];
      // If the caller passed a path that exists on disk, require it to appear
      // in the rec's evidence/body — that's our cheap relevance signal.
      // If the path doesn't exist (tests, weird inputs), still substring-match
      // so synthetic scopes work.
      const useExistence = scope && existsSync(scope);
      for (const rec of pending) {
        if (await isSnoozed(home, rec.meta.id)) continue;
        if (scope && !recommendationMatchesScope(rec, scope)) continue;
        // useExistence is currently advisory — substring match is the real
        // filter. Keeping the existsSync check around so we can tighten the
        // filter later (e.g. require an actual file path inside `scope`).
        void useExistence;
        matches.push(recommendationSummary(rec));
      }
      const order = { high: 0, medium: 1, low: 2 };
      matches.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
      return jsonResult({ recommendations: matches.slice(0, max) });
    }),
  );

  return server;
}
