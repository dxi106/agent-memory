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
 *
 * The `\s+` collapse is a WHITESPACE normaliser and was mistaken for a
 * sanitiser. It does not touch ESC, NUL, BEL, backspace, DEL, or the zero-width
 * and bidi formatters, so those reached the digest verbatim — and the digest is
 * read by BOTH a model and a terminal. `ESC[2K ESC[1G` repaints the current
 * line, letting a hostile string erase what was printed above it and forge a
 * clean one; `OSC 52` writes the user's clipboard; U+202E reverses display
 * order. Stripped here rather than at each render site so every consumer of a
 * model- or GitHub-authored field gets it, including the CLI's stdout.
 */
const CONTROL_AND_INVISIBLE =
  // C0 (keeping \t \n \r for the whitespace collapse below to fold), DEL, C1,
  // NEL/LS/PS, zero-width + directional formatters, and the BOM.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

export function flattenField(value, max = MAX_TITLE_LENGTH) {
  const s = String(value ?? "")
    .replace(CONTROL_AND_INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  // Slice by code point, not UTF-16 unit: cutting mid-surrogate leaves a lone
  // half, which the UTF-8 write then substitutes with U+FFFD.
  return `${[...s].slice(0, max - 1).join("")}…`;
}
