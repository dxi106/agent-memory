#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readStdin, parseEvent, runAdapter } from "../../lib/adapters/runtime.mjs";
import { resolveHome, paths } from "../../lib/paths.mjs";
import { appendSignal } from "../../lib/signals.mjs";
import { detectRetry } from "../../lib/adapters/claude-code.mjs";

await runAdapter(async () => {
  const event = parseEvent(await readStdin());
  const home = resolveHome();
  const statePath = join(home, ".hook-state.json");

  let prior = {};
  try {
    prior = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    prior = {};
  }

  const { signal, state } = detectRetry(event, prior);
  // Write the signal first; only advance the state once the signal is durably
  // recorded, so a failed append can't silently consume the retry key.
  if (signal) {
    await appendSignal(paths(home).signals, signal);
  }
  await writeFile(statePath, JSON.stringify(state));
  return { continue: true };
});
