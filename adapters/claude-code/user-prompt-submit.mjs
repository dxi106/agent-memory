#!/usr/bin/env node
import { readStdin, parseEvent, runAdapter } from "../../lib/adapters/runtime.mjs";
import { resolveHome, paths } from "../../lib/paths.mjs";
import { appendSignal } from "../../lib/signals.mjs";
import { signalFromUserPromptSubmit } from "../../lib/adapters/claude-code.mjs";

await runAdapter(async () => {
  const event = parseEvent(await readStdin());
  const signal = signalFromUserPromptSubmit(event);
  if (signal) {
    await appendSignal(paths(resolveHome()).signals, signal);
  }
  return { continue: true };
});
