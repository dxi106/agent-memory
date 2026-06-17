// macOS notifications for HIGH-severity coaching recommendations (SOU-19, Part A).
//
// Design principles:
//
//   * One-shot at GENERATION time only. NEVER scheduled, NEVER a daily drumbeat.
//     The notification fires the moment a new HIGH rec lands in the store and
//     not again. If you find yourself adding a launchd plist that calls into
//     this module on a timer — STOP. Coaching is reactive, not nagging.
//
//   * Anti-spam: every fired notification's rec id is persisted to
//     <home>/.notified.json (gitignored, ephemeral, per-machine). Re-running
//     `coach run` against the same signals must not re-fire.
//
//   * Clickable: each banner carries an `-open file://…/recommendations/<id>.md`
//     click target so opening it shows the tip's full text. We deliberately use
//     `terminal-notifier` rather than AppleScript `display notification`:
//     osascript notifications are attributed to Script Editor and clicking one
//     launches Script Editor at an empty iCloud folder — there is no way to set
//     a click action or sender from `display notification`. terminal-notifier
//     gives us both.
//
//   * Fail-safe: if terminal-notifier is missing (non-macOS, not installed,
//     sandboxed CI, etc.) we swallow the error and continue. Coaching must
//     never crash because a notification couldn't be displayed.
//
//   * DI'd subprocess: callers pass `runNotifier` so tests don't actually
//     spawn terminal-notifier. The default implementation uses
//     node:child_process and passes an argv array (no shell) — banner content
//     cannot inject because it never touches a shell or an AppleScript literal.

import { readFile, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_FILE = ".notified.json";
// Notifications are written to <home>/recommendations/<id>.md by the coach
// pass; clicking a banner opens that file. ids are validated against SAFE_ID
// before being turned into a path, so the click target can never escape home.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const NOTIFIER_BIN = "terminal-notifier";
// Default per-call timeout. terminal-notifier returns promptly, but a
// first-run "… wants to send notifications" permission dialog could otherwise
// block a cron-driven coach run indefinitely. 5 seconds is plenty.
const NOTIFIER_TIMEOUT_MS = 5000;

export function notifiedPath(home) {
  return join(home, STATE_FILE);
}

export async function loadNotifiedSet(home) {
  try {
    const text = await readFile(notifiedPath(home), "utf8");
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.notified)) return new Set(parsed.notified);
    return new Set();
  } catch {
    return new Set();
  }
}

export async function saveNotifiedSet(home, set) {
  // Atomic write: write to a temp file then rename. A kill -9 mid-write to
  // <home>/.notified.json could otherwise truncate the file, and the next
  // load would silently return an empty set — re-firing every HIGH-severity
  // notification (the anti-spam guard's whole reason for existing).
  const payload = { notified: [...set] };
  const dest = notifiedPath(home);
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2));
  await rename(tmp, dest);
}

/**
 * Build the file:// URL that a notification should open when clicked: the
 * tip's <home>/recommendations/<id>.md. Returns null (no click target) when
 * the id is unsafe, so a malformed id degrades to a still-clickable-less
 * banner rather than building a path outside home.
 */
export function recommendationFileURL(home, id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) return null;
  return pathToFileURL(join(home, "recommendations", `${id}.md`)).href;
}

/**
 * Decide whether a rec warrants a macOS notification. Returns true iff:
 *   - rec is a well-formed object with id + severity
 *   - severity === "high"
 *   - the id is NOT already in the notified set
 *
 * Never throws on malformed input — we'd rather miss a notification than
 * crash the coach pass.
 */
export function shouldNotify(rec, notifiedSet) {
  if (!rec || typeof rec !== "object") return false;
  if (typeof rec.id !== "string" || !rec.id) return false;
  if (rec.severity !== "high") return false;
  if (notifiedSet && notifiedSet.has(rec.id)) return false;
  return true;
}

// Default runNotifier: spawn `terminal-notifier <args>`. Rejects on non-zero
// exit so fireNotification's try/catch can record failure. Hardened with a
// timeout so a first-run permission dialog cannot hang a cron-driven pass.
function defaultRunNotifier(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(NOTIFIER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      settle(() => reject(new Error(`${NOTIFIER_BIN} timed out after ${NOTIFIER_TIMEOUT_MS}ms`)));
    }, NOTIFIER_TIMEOUT_MS);
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      if (code === 0) settle(() => resolve({ ok: true }));
      else settle(() => reject(new Error(`${NOTIFIER_BIN} exited ${code}: ${stderr.trim()}`)));
    });
  });
}

// Collapse a string to a single clean line for a notification banner. Banners
// are single-line in Notification Center anyway, so we collapse \r\n\t runs to
// one space and strip remaining ASCII control chars. No quote/backslash
// escaping is needed: argv values go straight to execvp, never a shell or an
// AppleScript string literal.
function sanitizeBanner(s) {
  return String(s)
    .replace(/[\r\n\t]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

/**
 * Fire one macOS notification for a single recommendation. Returns true on
 * success, false on any failure (subprocess missing, exit code != 0, etc.).
 *
 * This is a one-shot — caller is responsible for the "did we already fire
 * for this id" check via shouldNotify().
 *
 * Options:
 *   - openTarget: a file:// URL (or any URL) opened when the banner is clicked.
 *     Omit for a banner with no click action.
 */
export async function fireNotification(rec, runNotifier = defaultRunNotifier, { openTarget } = {}) {
  try {
    const subtitle = sanitizeBanner(`[HIGH] ${rec.title || rec.id}`);
    const message = sanitizeBanner(rec.next_step || rec.title || rec.id);
    // terminal-notifier requires a non-empty -message; fall back to a space
    // so a rec with no usable text still produces a (clickable) banner.
    const args = [
      "-title", "agentmem coach",
      "-subtitle", subtitle,
      "-message", message || " ",
    ];
    if (openTarget) args.push("-open", openTarget);
    await runNotifier(args);
    return true;
  } catch (err) {
    // Fail-safe: log to stderr so the user can investigate if curious,
    // but never propagate.
    try {
      process.stderr.write(`agentmem notify: ${err?.message || err}\n`);
    } catch {
      // stderr write itself can fail in weird sandboxes — swallow.
    }
    return false;
  }
}

/**
 * Fire notifications for every HIGH-severity rec in `recs` that hasn't
 * already been notified. Persists newly-notified ids to <home>/.notified.json.
 *
 * Returns the list of ids that were successfully notified this call.
 *
 * Options:
 *   - enabled (default true): when false, returns [] without touching the
 *     state file. Lets the caller honour config.json.nudge.macos_notifications_on_high_only.
 *   - runNotifier: DI hook for tests / non-macOS.
 */
export async function notifyHighSeverityRecs(home, recs, { enabled = true, runNotifier } = {}) {
  if (!enabled) return [];
  if (!Array.isArray(recs) || recs.length === 0) return [];

  const notified = await loadNotifiedSet(home);
  const fired = [];
  let dirty = false;
  for (const rec of recs) {
    if (!shouldNotify(rec, notified)) continue;
    const openTarget = recommendationFileURL(home, rec.id);
    const ok = await fireNotification(rec, runNotifier, { openTarget });
    if (ok) {
      notified.add(rec.id);
      fired.push(rec.id);
      dirty = true;
    }
  }
  if (dirty) await saveNotifiedSet(home, notified);
  return fired;
}
