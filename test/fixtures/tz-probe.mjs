// Reports which calendar day runDigest and markDelivered actually use, under
// whatever TZ this process was started with. Spawned by test/digest.test.mjs.
//
// A fixture rather than an inline `node -e` string: the probe nests template
// literals and module URLs, and quoting that through a shell is how you get a
// test that fails for reasons unrelated to the thing under test.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, writeCandidate } from "../../lib/storage.mjs";
import { runDigest, markDelivered, readDeliveredDate, localDay } from "../../lib/digest.mjs";

const home = await mkdtemp(join(tmpdir(), "agentmem-tz-"));
await ensureLayout(home);
await writeCandidate(home, {
  meta: {
    id: "2026-08-01-tz",
    title: "timezone probe",
    category: "workflow",
    confidence: 0.35,
    created: "2026-08-01",
    source: "reflection",
    scope: { repos: ["*"] },
  },
  body: "**Rule:** x.",
});

const { file } = await runDigest(home);
await markDelivered(home);

process.stdout.write(
  JSON.stringify({
    file,
    local: localDay(),
    utc: new Date().toISOString().slice(0, 10),
    stamp: await readDeliveredDate(home),
  }),
);
