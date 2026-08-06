import matter from "gray-matter";

export function parseLesson(text) {
  const { data, content } = matter(text);
  return { meta: data, body: content };
}

export function serializeLesson(lesson) {
  return matter.stringify(lesson.body, lesson.meta);
}

export const MAX_TITLE_LENGTH = 200;

/**
 * Collapse a single-line field to one line and bound its length.
 *
 * Candidate titles are model-authored, and the model's input is GitHub PR
 * review comments and Claude Code transcripts — text this repo does not
 * control. `id` is validated against SAFE_ID and `category` against an
 * allowlist; `title` had no structural guard at all, so a newline in it could
 * break out of the markdown list item it is rendered into and impersonate a
 * heading, a fenced block, or an instruction. The digest is bound for a model's
 * context, which makes that a live injection surface rather than a cosmetic bug.
 *
 * Truncates rather than rejects: dropping a candidate because its title ran
 * long would silently lose a real lesson.
 */
export function flattenField(value, max = MAX_TITLE_LENGTH) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
