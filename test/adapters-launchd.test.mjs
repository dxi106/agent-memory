import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LAUNCHD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "launchd");

async function readTemplate(name) {
  return readFile(join(LAUNCHD_DIR, `com.example.agentmem.${name}.plist`), "utf8");
}

/**
 * Pull the StartCalendarInterval block out of a plist and return its integer
 * keys. Deliberately a narrow parser rather than a plist library: the only
 * thing under test is the schedule block, and a dependency here would need a
 * justification it cannot earn.
 *
 * Returns e.g. { Hour: 3, Minute: 0 }. Absent keys are absent, not zero —
 * launchd treats a missing key as "every value", so Weekday-absent means
 * nightly and Weekday-present means weekly. Conflating the two with a 0
 * default would make the nightly/weekly assertions below vacuous.
 */
function scheduleOf(plist) {
  const block = plist.match(
    /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
  );
  assert.ok(block, "plist has no StartCalendarInterval block");
  const out = {};
  const pair = /<key>(\w+)<\/key>\s*<integer>(-?\d+)<\/integer>/g;
  let m;
  while ((m = pair.exec(block[1])) !== null) out[m[1]] = Number(m[2]);
  return out;
}

const minutesOfDay = (s) => s.Hour * 60 + s.Minute;

test("the ingest template runs `ingest --source github`", async () => {
  const plist = await readTemplate("ingest");
  const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const i = args.indexOf("ingest");
  assert.ok(i !== -1, "ingest template does not invoke the ingest command");
  assert.deepEqual(
    args.slice(i, i + 3),
    ["ingest", "--source", "github"],
    "ingest must be sourced from github — a bare `ingest` scrapes transcripts instead",
  );
});

test("ingest is scheduled nightly, not weekly", async () => {
  const s = scheduleOf(await readTemplate("ingest"));
  assert.equal(s.Hour, 3);
  assert.equal(s.Minute, 0);
  assert.equal(
    "Weekday" in s,
    false,
    "a Weekday key would silently make ingest weekly",
  );
});

test("coach stays weekly on Sunday — coaching.lookback_days is 7", async () => {
  const s = scheduleOf(await readTemplate("coach"));
  assert.equal(s.Weekday, 0, "coach must keep Weekday=0; nightly runs re-derive from overlapping 7-day windows");
  assert.equal(s.Hour, 4);
});

test("ingest runs strictly before reflect, so a night's signals reach that night's reflection", async () => {
  const ingest = scheduleOf(await readTemplate("ingest"));
  const reflect = scheduleOf(await readTemplate("reflect"));
  assert.ok(
    minutesOfDay(ingest) < minutesOfDay(reflect),
    `ingest (${ingest.Hour}:${ingest.Minute}) must precede reflect (${reflect.Hour}:${reflect.Minute})`,
  );
});

test("the ingest template does not point at the Intel-only node path", async () => {
  const plist = await readTemplate("ingest");
  assert.ok(
    !plist.includes("<string>/usr/local/bin/node</string>"),
    "/usr/local/bin/node does not exist on Apple Silicon and launchd fails silently",
  );
});
