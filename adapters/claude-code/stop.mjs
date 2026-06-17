#!/usr/bin/env node
import { runAdapter } from "../../lib/adapters/runtime.mjs";

// Stop currently performs no capture — present as a wired, fail-safe no-op
// so future session-finalization logic has a home without re-touching settings.json.
await runAdapter(async () => ({ continue: true }));
