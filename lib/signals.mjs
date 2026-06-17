import { appendFile, readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

export async function appendSignal(signalsDir, signal) {
  await mkdir(signalsDir, { recursive: true });
  const enriched = { ts: new Date().toISOString(), ...signal };
  const file = join(signalsDir, `${todayStamp()}.jsonl`);
  await appendFile(file, JSON.stringify(enriched) + "\n");
  return enriched;
}

export async function readSignalsSince(signalsDir, days) {
  let files;
  try {
    files = await readdir(signalsDir);
  } catch {
    return [];
  }
  // Boundary is inclusive: readSignalsSince(dir, 7) includes the file dated
  // exactly 7 UTC days ago. Comparison is lexicographic on YYYY-MM-DD stamps.
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffStamp = cutoff.toISOString().slice(0, 10);

  const dated = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => f.slice(0, 10) >= cutoffStamp)
    .sort();

  const signals = [];
  for (const f of dated) {
    const content = await readFile(join(signalsDir, f), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim()) signals.push(JSON.parse(line));
    }
  }
  return signals;
}
