// Shared runtime helpers for hook adapter scripts.
// Adapters MUST be fail-safe: never throw, never block the host session.

export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let received = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
      received = true;
    });
    process.stdin.on("end", () => resolve(data));
    // If no stdin is ever attached, don't hang the host. Only fire when nothing
    // has arrived yet — never truncate a payload that is mid-stream.
    setTimeout(() => {
      if (!received) resolve(data);
    }, 200);
  });
}

export function parseEvent(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Run an adapter body with a guaranteed safe response + exit 0 on any failure.
 *
 * `onDelivered` is optional and runs ONLY after the payload has actually
 * flushed to stdout, and only when the body succeeded. Two failures make that
 * ordering load-bearing:
 *
 * 1. This runtime is fail-safe by design — it swallows every throw and writes a
 *    bare fallback. So a side effect performed inside `fn` (marking a digest
 *    delivered, say) survives a later failure that means the user saw nothing.
 *    Passing it here instead ties it to the emit.
 * 2. `write()` returning is not delivery. Measured on this machine: writing to
 *    a pipe and then calling process.exit(0) truncates at exactly 65536 bytes —
 *    the pipe buffer — losing everything after it, silently. Gating on the
 *    write callback and deferring the exit behind it makes a 500 KB payload
 *    arrive whole. All four adapters share this runtime, so the lesson
 *    injection itself was on the same cliff.
 *
 * The callback is wrapped so it can never break the fail-safe contract: a
 * throwing stamp must not take down the host session.
 */
export async function runAdapter(fn, fallback = { continue: true }, onDelivered) {
  let payload;
  let delivered = false;
  try {
    payload = JSON.stringify((await fn()) ?? fallback);
    delivered = true;
  } catch {
    payload = JSON.stringify(fallback);
  }

  await new Promise((resolve) => process.stdout.write(payload, resolve));

  if (delivered) {
    try {
      await onDelivered?.();
    } catch {}
  }
  process.exit(0);
}
