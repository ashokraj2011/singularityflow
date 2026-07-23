import YAML from 'yaml';

export function extractCopilotQuestions(text, { limit = 8 } = {}) {
  const questions = [];
  const seen = new Set();
  for (const candidate of String(text ?? '').match(/(?:^|\n|[.!]\s+)([^?\n]{5,}\?)/g) ?? []) {
    const question = candidate
      .replace(/^[\s.!*-]+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .trim();
    const key = question.toLowerCase();
    if (!question || seen.has(key) || /https?:\/\/\S+\?$/.test(question)) continue;
    seen.add(key);
    questions.push(question);
    if (questions.length >= limit) break;
  }
  return questions;
}

export function planningLogEntry(event, at = new Date().toISOString()) {
  const type = event?.type ?? 'event';
  const detail = event?.title
    ?? event?.message
    ?? event?.detail
    ?? event?.text
    ?? event?.stopReason
    ?? event?.status
    ?? '';
  const level = type === 'error' || type === 'permission-denied'
    ? 'error'
    : type.includes('warning') || type === 'diagnostic'
      ? 'warning'
      : 'info';
  return {
    id: `${at}:${type}:${String(detail).slice(0, 80)}`,
    at,
    type,
    level,
    detail: String(detail).trim() || type.replaceAll('-', ' ')
  };
}

export function parseStoryPlan(content) {
  if (!String(content ?? '').trim()) return { valid: false, error: 'No story plan has been generated.', epics: [], stories: [], repositories: [] };
  let document;
  try {
    document = YAML.parse(content);
  } catch (error) {
    return { valid: false, error: `Story plan YAML is not valid: ${error.message}`, epics: [], stories: [], repositories: [] };
  }
  if (!document || document.version !== 1 || !Array.isArray(document.epics)) {
    return { valid: false, error: 'Story plan must contain version: 1 and an epics array.', epics: [], stories: [], repositories: [] };
  }
  const epics = [];
  const stories = [];
  const ids = new Set();
  for (const epic of document.epics) {
    if (!epic?.id || !Array.isArray(epic.stories)) continue;
    const normalized = {
      id: String(epic.id),
      title: epic.title ?? String(epic.id),
      description: epic.description ?? '',
      acceptanceCriteria: Array.isArray(epic.acceptanceCriteria) ? epic.acceptanceCriteria : [],
      jiraKey: epic.jiraKey ?? null,
      stories: []
    };
    for (const story of epic.stories) {
      if (!story?.id || !story?.repository) continue;
      const id = String(story.id);
      const normalizedStory = {
        ...story,
        id,
        workId: id,
        epicId: normalized.id,
        title: story.title ?? id,
        description: story.description ?? '',
        acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
        jiraKey: story.jiraKey ?? null,
        blocking: story.blocking !== false,
        dependsOn: Array.isArray(story.dependsOn) ? story.dependsOn : []
      };
      normalized.stories.push(normalizedStory);
      stories.push(normalizedStory);
      ids.add(id);
    }
    epics.push(normalized);
  }
  const dependencyErrors = stories.flatMap((story) => story.dependsOn
    .map((dependency) => typeof dependency === 'string' ? dependency : dependency?.story)
    .filter((dependency) => dependency && !ids.has(dependency))
    .map((dependency) => `${story.id} depends on unknown story ${dependency}`));
  const repositories = [...new Set(stories.map((story) => story.repository))].sort();
  return {
    valid: epics.length > 0 && stories.length > 0 && dependencyErrors.length === 0,
    error: !epics.length
      ? 'Story plan has no usable epics.'
      : !stories.length
        ? 'Story plan has no usable repository stories.'
        : dependencyErrors[0] ?? null,
    initiativeId: document.initiativeId ?? null,
    epics,
    stories,
    repositories,
    blocking: stories.filter((story) => story.blocking).length,
    dependencies: stories.reduce((sum, story) => sum + story.dependsOn.length, 0)
  };
}
