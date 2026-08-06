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
export const FLUSH_DEADLINE_MS = 2000;

export async function runAdapter(fn, fallback = { continue: true }, onDelivered) {
  let payload;
  let bodyOk = false;
  try {
    payload = JSON.stringify((await fn()) ?? fallback);
    bodyOk = true;
  } catch {
    payload = JSON.stringify(fallback);
  }

  // Waiting for the flush is what fixes the truncation — but waiting is also
  // how this runtime could start doing the two things it promises never to do.
  // Holding the process open long enough to see the callback also holds it open
  // long enough to see an 'error' event (an unhandled EPIPE crash, exit 1 with a
  // stack trace) or to wait forever when nothing drains the pipe. A SessionStart
  // hook that hangs is strictly worse than one that truncates, so the wait is
  // bounded and every exit is a clean one.
  //
  // Note `readStdin` above is NOT bounded the same way, despite appearances:
  // its 200ms timer fires only when nothing has arrived, so a writer that sends
  // a partial payload and never closes still hangs the hook indefinitely.
  // Pre-existing and not attacker-reachable — the host writes and closes — but
  // do not read it as precedent for this being a solved pattern here.
  // Attached for the rest of the process, never removed: an EPIPE can surface
  // after the write settles but before exit, and an 'error' with no listener is
  // a hard crash. Detaching on settle leaves exactly that window open.
  let writeFailed = false;
  process.stdout.on("error", () => {
    writeFailed = true;
  });

  const flushed = await new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok && !writeFailed);
    };
    const timer = setTimeout(() => finish(false), FLUSH_DEADLINE_MS);
    process.stdout.write(payload, (err) => finish(!err));
  });

  // `flushed` matters as much as `bodyOk`: a timed-out or errored write means
  // the user never received the payload, so treating it as delivered would burn
  // the day on a write that did not land — R9's failure, one layer down.
  if (bodyOk && flushed) {
    try {
      await onDelivered?.();
    } catch {}
  }
  process.exit(0);
}
