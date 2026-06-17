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

// Run an adapter body with a guaranteed safe response + exit 0 on any failure.
export async function runAdapter(fn, fallback = { continue: true }) {
  try {
    const out = await fn();
    process.stdout.write(JSON.stringify(out ?? fallback));
  } catch {
    process.stdout.write(JSON.stringify(fallback));
  }
  process.exit(0);
}
