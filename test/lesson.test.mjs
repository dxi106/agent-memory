import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLesson, serializeLesson } from "../lib/lesson.mjs";

const SAMPLE = `---
id: 2026-05-24-no-mock-db
title: Don't mock the database in integration tests
category: code
scope:
  repos:
    - another-app
    - example-app
confidence: 0.72
created: 2026-04-15
last_evidence: 2026-05-22
evidence_count: 4
---

**Rule:** Integration tests must hit a real database, not mocks.

**Why:** A mocked DB test passed but the prod migration failed.
`;

test("parseLesson extracts frontmatter fields", () => {
  const lesson = parseLesson(SAMPLE);
  assert.equal(lesson.meta.id, "2026-05-24-no-mock-db");
  assert.equal(lesson.meta.title, "Don't mock the database in integration tests");
  assert.equal(lesson.meta.category, "code");
  assert.equal(lesson.meta.confidence, 0.72);
  assert.equal(lesson.meta.evidence_count, 4);
  assert.deepEqual(lesson.meta.scope.repos, ["another-app", "example-app"]);
});

test("parseLesson extracts the markdown body", () => {
  const lesson = parseLesson(SAMPLE);
  assert.match(lesson.body, /Integration tests must hit a real database/);
  assert.doesNotMatch(lesson.body, /^---/);
});

test("serializeLesson round-trips through parseLesson", () => {
  const lesson = parseLesson(SAMPLE);
  const text = serializeLesson(lesson);
  const reparsed = parseLesson(text);
  assert.deepEqual(reparsed.meta, lesson.meta);
  assert.equal(reparsed.body.trim(), lesson.body.trim());
});

test("serializeLesson produces frontmatter delimited by ---", () => {
  const lesson = parseLesson(SAMPLE);
  const text = serializeLesson(lesson);
  assert.ok(text.startsWith("---\n"));
  assert.ok(text.includes("\n---\n"));
});
