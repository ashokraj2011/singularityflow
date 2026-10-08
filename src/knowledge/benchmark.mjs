/**
 * Score a knowledge build against hand-written expectations for a repository.
 *
 * "Is the model useful" has to be a number that a release can be held to, or every version will
 * claim progress. An expectations file lists what a careful reader would say the repository
 * contains (its rules, limits, entities, entry points, journeys, tests, gaps, drift, error paths,
 * commands); the scorer reports how many of them the build found, per category and per level,
 * and names every miss. It never edits the build.
 *
 *   rules:       [{ path, line, contains }]            line within ±2; contains in condition/outcome
 *   limits:      [{ name, value }]
 *   entities:    [{ name, fields: [..] }]
 *   entryPoints: [{ label }]                            substring of the entry label
 *   journeys:    [{ trigger, reaches }]                 substrings of trigger and an effect
 *   tests:       [{ title, exercises }]
 *   untested:    [{ symbol }]
 *   drift:       [{ test }]
 *   errorPaths:  [{ message, status }]
 *   commands:    [{ command }]
 *   messages:    [{ text }]                             what users are told
 *   external:    [{ call }]                             outbound call, e.g. "POST /orders"
 */
import YAML from 'yaml';

import { SingularityFlowError } from '../util.mjs';

const CATEGORY_LEVEL = Object.freeze({
  commands: 'L0', entities: 'L1', entryPoints: 'L1', rules: 'L3', limits: 'L3', journeys: 'L3', tests: 'L3',
  untested: 'L3', drift: 'L3', errorPaths: 'L2', external: 'L4', messages: 'L3'
});

const has = (haystack, needle) => String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());

const MATCHERS = Object.freeze({
  rules: (expected, items) => items.some((item) => item.kind === 'rule' && item.citations.some((entry) => entry.path === expected.path
    && Math.abs(entry.lines[0] - Number(expected.line)) <= 2)
    && (!expected.contains || has(JSON.stringify([item.statement.when, item.statement.then]), expected.contains))),
  limits: (expected, items) => items.some((item) => item.kind === 'limit' && item.statement.name === expected.name
    && (expected.value == null || String(item.statement.value) === String(expected.value))),
  entities: (expected, items) => items.some((item) => item.kind === 'entity' && item.statement.name === expected.name
    && (expected.fields ?? []).every((field) => (item.statement.fields ?? []).some((entry) => entry.name === field))
    && (expected.values ?? []).every((value) => (item.statement.values ?? []).includes(value))),
  entryPoints: (expected, items) => items.some((item) => item.kind === 'entry-point' && has(item.statement.label, expected.label)),
  journeys: (expected, items) => items.some((item) => item.kind === 'journey' && has(item.statement.trigger, expected.trigger)
    && (!expected.reaches || item.statement.effects.some((effect) => has(effect, expected.reaches)) || item.statement.steps.some((step) => has(step, expected.reaches)))),
  tests: (expected, items) => items.some((item) => item.kind === 'test-case' && has(item.statement.title, expected.title)
    && (!expected.exercises || item.statement.exercises.some((name) => has(name, expected.exercises)))),
  untested: (expected, items) => items.some((item) => item.kind === 'untested-rule' && has(item.subject.symbol, expected.symbol)),
  drift: (expected, items) => items.some((item) => item.kind === 'drift' && has(item.statement.testTitle, expected.test)),
  errorPaths: (expected, items) => items.some((item) => item.kind === 'error-path' && (!expected.message || has(item.statement.message, expected.message))
    && (!expected.status || item.statement.status === expected.status)),
  messages: (expected, items) => items.some((item) => (item.kind === 'message' && has(item.statement.text, expected.text))
    || (item.kind === 'rule' && item.statement.then?.kind === 'shows' && has(item.statement.then.text, expected.text))),
  commands: (expected, items) => items.some((item) => item.kind === 'command' && has(item.statement.command, expected.command)),
  external: (expected, items) => items.some((item) => item.kind === 'external-dependency' && has(`${item.statement.method} ${item.statement.target}`, expected.call))
});

export function parseKnowledgeExpectations(text) {
  let parsed;
  try { parsed = YAML.parse(text); } catch (error) {
    throw new SingularityFlowError(`The expectations file is not valid YAML: ${error.message}`, { code: 'KNOWLEDGE_EXPECTATIONS_INVALID' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SingularityFlowError('The expectations file must be a mapping of categories to lists.', { code: 'KNOWLEDGE_EXPECTATIONS_INVALID' });
  }
  for (const [category, list] of Object.entries(parsed)) {
    if (category === 'name') continue;
    if (!MATCHERS[category]) throw new SingularityFlowError(`Unknown expectation category '${category}'. Use: ${Object.keys(MATCHERS).join(', ')}.`, { code: 'KNOWLEDGE_EXPECTATIONS_INVALID' });
    if (!Array.isArray(list)) throw new SingularityFlowError(`Expectation category '${category}' must be a list.`, { code: 'KNOWLEDGE_EXPECTATIONS_INVALID' });
  }
  return parsed;
}

/** Recall per category and per level, with every miss named. */
export function scoreKnowledge(knowledge, expectations) {
  const categories = {};
  const levels = {};
  for (const [category, list] of Object.entries(expectations)) {
    if (category === 'name') continue;
    const missed = list.filter((expected) => !MATCHERS[category](expected, knowledge.items));
    categories[category] = { expected: list.length, found: list.length - missed.length, recall: list.length ? (list.length - missed.length) / list.length : 1, missed };
    const level = CATEGORY_LEVEL[category];
    levels[level] ??= { expected: 0, found: 0 };
    levels[level].expected += list.length;
    levels[level].found += list.length - missed.length;
  }
  for (const value of Object.values(levels)) value.recall = value.expected ? value.found / value.expected : 1;
  const expected = Object.values(categories).reduce((sum, value) => sum + value.expected, 0);
  const found = Object.values(categories).reduce((sum, value) => sum + value.found, 0);
  return {
    name: expectations.name ?? null,
    recall: expected ? found / expected : 1,
    expected, found,
    citationValidity: knowledge.metrics.citations ? 1 - knowledge.metrics.invalidCitations / knowledge.metrics.citations : 1,
    categories,
    levels: Object.fromEntries(Object.entries(levels).sort(([a], [b]) => a.localeCompare(b)))
  };
}
