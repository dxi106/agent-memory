import matter from "gray-matter";

export function parseLesson(text) {
  const { data, content } = matter(text);
  return { meta: data, body: content };
}

export function serializeLesson(lesson) {
  return matter.stringify(lesson.body, lesson.meta);
}
