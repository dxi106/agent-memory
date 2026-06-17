import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  shouldNotify,
  fireNotification,
  loadNotifiedSet,
  saveNotifiedSet,
  notifiedPath,
  notifyHighSeverityRecs,
  recommendationFileURL,
} from "../lib/notify.mjs";

async function tmpHome() {
  return mkdtemp(join(tmpdir(), "agentmem-notify-"));
}

// Read the value following a flag in a terminal-notifier argv array
// (e.g. flag(args, "-title") -> "agentmem coach").
function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// ------ shouldNotify ------

test("shouldNotify is true for a HIGH-severity rec not in the notified set", () => {
  const rec = { id: "r1", severity: "high", title: "T" };
  assert.equal(shouldNotify(rec, new Set()), true);
});

test("shouldNotify is false for MEDIUM/LOW severity", () => {
  assert.equal(shouldNotify({ id: "r1", severity: "medium", title: "T" }, new Set()), false);
  assert.equal(shouldNotify({ id: "r1", severity: "low", title: "T" }, new Set()), false);
});

test("shouldNotify is false when the rec id is already in the notified set", () => {
  const rec = { id: "r1", severity: "high", title: "T" };
  const notified = new Set(["r1"]);
  assert.equal(shouldNotify(rec, notified), false);
});

test("shouldNotify tolerates malformed input (returns false, never throws)", () => {
  assert.equal(shouldNotify(null, new Set()), false);
  assert.equal(shouldNotify({}, new Set()), false);
  assert.equal(shouldNotify({ severity: "high" }, new Set()), false); // no id
  assert.equal(shouldNotify({ id: "r1" }, new Set()), false); // no severity
});

// ------ recommendationFileURL ------

test("recommendationFileURL points at recommendations/<id>.md as a file:// URL", () => {
  const home = "/tmp/agentmem-home";
  const url = recommendationFileURL(home, "2026-05-31-use-plan-mode");
  assert.equal(url, pathToFileURL(join(home, "recommendations", "2026-05-31-use-plan-mode.md")).href);
  assert.ok(url.startsWith("file://"));
});

test("recommendationFileURL returns null for an unsafe id (no path traversal)", () => {
  // ids that don't match SAFE_ID must not be turned into a click target —
  // fail-safe to "no click action" rather than build a path outside home.
  assert.equal(recommendationFileURL("/tmp/h", "../../etc/passwd"), null);
  assert.equal(recommendationFileURL("/tmp/h", "a/b"), null);
  assert.equal(recommendationFileURL("/tmp/h", ""), null);
  assert.equal(recommendationFileURL("/tmp/h", null), null);
});

// ------ fireNotification ------

test("fireNotification calls runNotifier with banner content (argv array) + returns true", async () => {
  const calls = [];
  const runNotifier = async (args) => {
    calls.push(args);
    return { ok: true };
  };
  const rec = { id: "r1", severity: "high", title: "Use plan mode", next_step: "Try /plan first" };
  const ok = await fireNotification(rec, runNotifier);
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.ok(Array.isArray(args), "runNotifier receives an argv array");
  // agentmem identifier as the notification title.
  assert.equal(flag(args, "-title"), "agentmem coach");
  // Severity-tagged tip title as the subtitle.
  assert.match(flag(args, "-subtitle"), /\[HIGH\] Use plan mode/);
  // The actionable next step as the message body.
  assert.match(flag(args, "-message"), /Try \/plan first/);
});

test("fireNotification adds -open click target when openTarget is provided", async () => {
  const calls = [];
  const runNotifier = async (args) => {
    calls.push(args);
    return { ok: true };
  };
  const rec = { id: "r1", severity: "high", title: "T", next_step: "n" };
  const openTarget = "file:///tmp/agentmem-home/recommendations/r1.md";
  await fireNotification(rec, runNotifier, { openTarget });
  // Clicking the banner must open the tip file, NOT launch the posting app
  // (the old osascript path launched Script Editor at an empty iCloud folder).
  assert.equal(flag(calls[0], "-open"), openTarget);
});

test("fireNotification omits -open entirely when no openTarget is given", async () => {
  const calls = [];
  const runNotifier = async (args) => {
    calls.push(args);
    return { ok: true };
  };
  await fireNotification({ id: "r1", severity: "high", title: "T", next_step: "n" }, runNotifier);
  assert.equal(calls[0].includes("-open"), false);
});

test("fireNotification returns false (without throwing) when runNotifier throws", async () => {
  const runNotifier = async () => {
    throw new Error("terminal-notifier: command not found");
  };
  const rec = { id: "r1", severity: "high", title: "T", next_step: "n" };
  const ok = await fireNotification(rec, runNotifier);
  assert.equal(ok, false);
});

test("fireNotification collapses newlines + control chars in subtitle/message (single-line banner)", async () => {
  const calls = [];
  const runNotifier = async (args) => {
    calls.push(args);
    return { ok: true };
  };
  const rec = {
    id: "r1",
    severity: "high",
    title: "Line one\nLine two\tafter tab",
    next_step: "Step 1.\r\nStep 2.",
  };
  await fireNotification(rec, runNotifier);
  const args = calls[0];
  // No raw control chars survive in any banner field.
  for (const a of args) {
    assert.equal(a.includes("\n"), false);
    assert.equal(a.includes("\r"), false);
    assert.equal(a.includes("\t"), false);
  }
  assert.match(flag(args, "-subtitle"), /Line one Line two after tab/);
  assert.match(flag(args, "-message"), /Step 1\. Step 2\./);
});

test("fireNotification passes double-quotes through literally (argv array = no shell/AppleScript injection)", async () => {
  // terminal-notifier args go straight to execvp — there is no shell and no
  // AppleScript string literal, so quotes need no escaping and cannot inject.
  const calls = [];
  const runNotifier = async (args) => {
    calls.push(args);
    return { ok: true };
  };
  const rec = {
    id: "r1",
    severity: "high",
    title: 'Use "plan" mode',
    next_step: 'Run "agentmem coach show"',
  };
  await fireNotification(rec, runNotifier);
  const args = calls[0];
  assert.match(flag(args, "-subtitle"), /Use "plan" mode/);
  assert.match(flag(args, "-message"), /Run "agentmem coach show"/);
  // No backslash-escaping artifacts leaked in.
  assert.equal(flag(args, "-subtitle").includes('\\"'), false);
});

// ------ loadNotifiedSet / saveNotifiedSet ------

test("loadNotifiedSet returns empty set when state file is absent", async () => {
  const home = await tmpHome();
  const set = await loadNotifiedSet(home);
  assert.ok(set instanceof Set);
  assert.equal(set.size, 0);
});

test("saveNotifiedSet then loadNotifiedSet roundtrips ids", async () => {
  const home = await tmpHome();
  await saveNotifiedSet(home, new Set(["r1", "r2"]));
  const loaded = await loadNotifiedSet(home);
  assert.equal(loaded.size, 2);
  assert.equal(loaded.has("r1"), true);
  assert.equal(loaded.has("r2"), true);
});

test("loadNotifiedSet tolerates a corrupt state file (returns empty set)", async () => {
  const home = await tmpHome();
  await writeFile(notifiedPath(home), "not-json{{{");
  const loaded = await loadNotifiedSet(home);
  assert.equal(loaded.size, 0);
});

test("saveNotifiedSet writes atomically (no partial file visible at the final path)", async () => {
  const home = await tmpHome();
  await saveNotifiedSet(home, new Set(["a", "b"]));
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(home);
  assert.equal(files.includes(".notified.json"), true);
  assert.equal(files.some((f) => f.endsWith(".tmp")), false);
});

test("notifiedPath places .notified.json at the home root (gitignored ephemeral)", async () => {
  const home = await tmpHome();
  assert.equal(notifiedPath(home), join(home, ".notified.json"));
});

// ------ notifyHighSeverityRecs (integration) ------

test("notifyHighSeverityRecs fires once per HIGH rec with the tip's file as click target, never refires", async () => {
  const home = await tmpHome();
  const calls = [];
  const runNotifier = async (args) => {
    calls.push(args);
    return { ok: true };
  };
  const recs = [
    { id: "r1", severity: "high", title: "T1", next_step: "n1" },
    { id: "r2", severity: "medium", title: "T2", next_step: "n2" },
    { id: "r3", severity: "high", title: "T3", next_step: "n3" },
  ];
  const fired = await notifyHighSeverityRecs(home, recs, { runNotifier });
  assert.deepEqual(fired.sort(), ["r1", "r3"]);
  assert.equal(calls.length, 2);

  // Each fired notification opens that rec's recommendations/<id>.md on click.
  const openTargets = calls.map((args) => flag(args, "-open"));
  assert.ok(openTargets.includes(recommendationFileURL(home, "r1")));
  assert.ok(openTargets.includes(recommendationFileURL(home, "r3")));

  // Persisted set reflects what fired.
  const loaded = await loadNotifiedSet(home);
  assert.equal(loaded.has("r1"), true);
  assert.equal(loaded.has("r3"), true);
  assert.equal(loaded.has("r2"), false);

  // Re-running with the same recs must NOT re-fire.
  calls.length = 0;
  const refired = await notifyHighSeverityRecs(home, recs, { runNotifier });
  assert.deepEqual(refired, []);
  assert.equal(calls.length, 0);
});

test("notifyHighSeverityRecs honours enabled=false and fires nothing", async () => {
  const home = await tmpHome();
  const calls = [];
  const runNotifier = async (args) => {
    calls.push(args);
    return { ok: true };
  };
  const recs = [{ id: "r1", severity: "high", title: "T1", next_step: "n1" }];
  const fired = await notifyHighSeverityRecs(home, recs, { runNotifier, enabled: false });
  assert.deepEqual(fired, []);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(notifiedPath(home)), false);
});

test("notifyHighSeverityRecs swallows notifier failures and still records other successes", async () => {
  const home = await tmpHome();
  let n = 0;
  const runNotifier = async () => {
    n += 1;
    if (n === 1) throw new Error("fail once");
    return { ok: true };
  };
  const recs = [
    { id: "r1", severity: "high", title: "T1", next_step: "n1" },
    { id: "r2", severity: "high", title: "T2", next_step: "n2" },
  ];
  const fired = await notifyHighSeverityRecs(home, recs, { runNotifier });
  // r1 failed; r2 succeeded. We record only successes so r1 can re-fire next time.
  assert.deepEqual(fired, ["r2"]);
  const loaded = await loadNotifiedSet(home);
  assert.equal(loaded.has("r1"), false);
  assert.equal(loaded.has("r2"), true);
});
