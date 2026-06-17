import { join } from "node:path";
import { homedir } from "node:os";

// Lightweight path resolution with no heavy dependencies (no gray-matter),
// so per-tool-call hot paths (e.g. PostToolUse adapters) stay fast.

export function resolveHome() {
  return process.env.AGENTMEM_HOME || join(homedir(), "Documents", "code", "agent-memory");
}

export function paths(home) {
  return {
    home,
    config: join(home, "config.json"),
    lessons: join(home, "lessons"),
    lessonsBehavioral: join(home, "lessons", "behavioral"),
    lessonsCode: join(home, "lessons", "code"),
    lessonsWorkflow: join(home, "lessons", "workflow"),
    candidates: join(home, "candidates"),
    signals: join(home, "signals"),
    archive: join(home, "archive"),
    reflections: join(home, "reflections"),
    knowledge: join(home, "knowledge"),
  };
}
