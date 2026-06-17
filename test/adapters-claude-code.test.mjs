import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPrompt,
  signalFromUserPromptSubmit,
  detectRetry,
} from "../lib/adapters/claude-code.mjs";

test("classifyPrompt flags corrections", () => {
  assert.equal(classifyPrompt("no, use the Grep tool instead"), "correction");
  assert.equal(classifyPrompt("don't do that"), "correction");
  assert.equal(classifyPrompt("Actually, let's revert that"), "correction");
  assert.equal(classifyPrompt("that's not what I asked for"), "correction");
  assert.equal(classifyPrompt("stop"), "correction");
});

test("classifyPrompt flags praise", () => {
  assert.equal(classifyPrompt("perfect, thanks!"), "praise");
  assert.equal(classifyPrompt("that works great"), "praise");
  assert.equal(classifyPrompt("exactly what I wanted"), "praise");
});

test("classifyPrompt returns null for neutral requests", () => {
  assert.equal(classifyPrompt("add a login button to the header"), null);
  assert.equal(classifyPrompt(""), null);
  assert.equal(classifyPrompt("can you refactor the auth module"), null);
});

test("classifyPrompt does not false-positive on incidental negation/affirmation words", () => {
  assert.equal(classifyPrompt("there are no files yet, create one"), null);
  assert.equal(classifyPrompt("this approach works in node"), null);
  assert.equal(classifyPrompt("wait for the API response before rendering"), null);
});

test("signalFromUserPromptSubmit builds a correction signal", () => {
  const sig = signalFromUserPromptSubmit({
    session_id: "s1",
    cwd: "/Users/x/code/example-app",
    prompt: "no, don't mock the database",
  });
  assert.equal(sig.host, "claude-code");
  assert.equal(sig.type, "correction");
  assert.equal(sig.session_id, "s1");
  assert.equal(sig.cwd, "/Users/x/code/example-app");
  assert.match(sig.summary, /mock the database/);
});

test("signalFromUserPromptSubmit returns null for neutral prompts", () => {
  const sig = signalFromUserPromptSubmit({ session_id: "s1", cwd: "/tmp", prompt: "add a button" });
  assert.equal(sig, null);
});

test("signalFromUserPromptSubmit truncates very long prompts", () => {
  const sig = signalFromUserPromptSubmit({ session_id: "s1", cwd: "/tmp", prompt: "no " + "x".repeat(1000) });
  assert.ok(sig.summary.length <= 200);
});

test("detectRetry emits nothing on the first tool call", () => {
  const { signal, state } = detectRetry({ tool_name: "Bash", tool_input: { command: "ls" } }, {});
  assert.equal(signal, null);
  assert.ok(state.lastKey);
});

test("detectRetry emits a retry signal when the same tool+input repeats", () => {
  const payload = { session_id: "s1", cwd: "/tmp", tool_name: "Bash", tool_input: { command: "npm test" } };
  const first = detectRetry(payload, {});
  const second = detectRetry(payload, first.state);
  assert.equal(second.signal.type, "retry");
  assert.equal(second.signal.host, "claude-code");
  assert.match(second.signal.summary, /Bash/);
});

test("detectRetry does not emit when a different tool call follows", () => {
  const a = { tool_name: "Bash", tool_input: { command: "ls" } };
  const b = { tool_name: "Read", tool_input: { file_path: "/x" } };
  const first = detectRetry(a, {});
  const second = detectRetry(b, first.state);
  assert.equal(second.signal, null);
});
