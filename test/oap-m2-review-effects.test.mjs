/**
 * Decisions never make a submission stale by accident [docs/SPEC-OAP-ONE-APPROVAL-PATH-v1.md, M2].
 *
 * REVIEW_EFFECTS (src/state.mjs) says what each lifecycle commit does to a step awaiting approval:
 * review-safe, returns the step, refused while the step awaits approval, or stales the submission.
 * These tests pin that every event type and every decision kind a command records has exactly one
 * entry, that the review-history check reads the registry rather than a list of its own, and that an
 * undecided proposal holds the approval only when its commit is exactly a proposal. The rejected
 * pair's own cases are in test/oap-m1-approval-check.test.mjs.
 */
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { REVIEW_EFFECTS, loadConfig, reviewHistoryCommits } from '../src/state.mjs';
import { LIFECYCLE_EVENT_TYPES } from '../src/lifecycle-event.mjs';
import { specification, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const EFFECTS = ['review-safe', 'returns-step', 'refused-during-review', 'stales-submission'];
const WORK = 'HEX-2018';
const SOURCE = new URL('../src/', import.meta.url);
const effectOf = (entry) => (typeof entry === 'string' ? entry : entry?.effect);

async function sourceFiles(directory = SOURCE) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory()
    ? sourceFiles(new URL(`${entry.name}/`, directory))
    : entry.name.endsWith('.mjs') ? [new URL(entry.name, directory)] : [])));
  return nested.flat();
}

/** The decision kinds every `decision-made` event a command records names, or 'workflow' for a workflow decision's own. */
async function recordedDecisionKinds() {
  const kinds = new Map();
  for (const file of await sourceFiles()) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/type: LIFECYCLE_EVENT\.DECISION_MADE/gu)) {
      const window = text.slice(match.index, match.index + 900).split('\n').slice(0, 12).join('\n');
      const named = [...window.matchAll(/decision: (?:'([a-z-]+)'|(pending\.decision))/gu)].map((found) => found[1] ?? 'workflow');
      const where = `${path.basename(file.pathname)}:${text.slice(0, match.index).split('\n').length}`;
      assert.ok(named.length, `${where} records a decision whose kind this guard cannot read; name it literally`);
      for (const kind of named) kinds.set(kind, [...(kinds.get(kind) ?? []), where]);
    }
  }
  return kinds;
}

test('the registry gives every lifecycle event type and every recorded decision kind exactly one effect', async () => {
  const keys = Object.keys(REVIEW_EFFECTS);
  assert.deepEqual(keys.filter((key) => !EFFECTS.includes(effectOf(REVIEW_EFFECTS[key]))), [], 'an entry with no known effect');
  assert.deepEqual(LIFECYCLE_EVENT_TYPES.filter((type) => type !== 'decision-made' && !REVIEW_EFFECTS[type]), [],
    'a lifecycle event type has no review effect in REVIEW_EFFECTS (src/state.mjs)');
  const kinds = await recordedDecisionKinds();
  assert.ok(kinds.size >= 15, [...kinds.keys()].join(', '));
  assert.deepEqual([...kinds.keys()].filter((kind) => !REVIEW_EFFECTS[`decision-made:${kind}`]), [],
    'a recorded decision kind has no review effect in REVIEW_EFFECTS (src/state.mjs)');
  assert.deepEqual(keys.filter((key) => key.startsWith('decision-made:') && !kinds.has(key.slice('decision-made:'.length))), [],
    'an entry names a decision kind no command records');
  assert.deepEqual(keys.filter((key) => !key.startsWith('decision-made:') && !LIFECYCLE_EVENT_TYPES.includes(key)), [],
    'an entry names no lifecycle event type');
});

test('intent amendments: proposing, rejecting and acknowledging are review-safe; the installing approval returns the step', () => {
  assert.deepEqual(['intent-amendment-proposed', 'intent-amendment-rejected', 'intent-amendment-acknowledged', 'intent-amendment-approved']
    .map((type) => REVIEW_EFFECTS[type]), ['review-safe', 'review-safe', 'review-safe', 'returns-step']);
  assert.equal(REVIEW_EFFECTS['phase-rejected'], 'returns-step');
  assert.equal(effectOf(REVIEW_EFFECTS['decision-made:test-command']), 'refused-during-review', 'SPEC-OAP D3');
});

test('a review-safe decision names its lists, and the history check reads them from the registry', async () => {
  for (const [key, entry] of Object.entries(REVIEW_EFFECTS)) {
    if (!key.startsWith('decision-made:') || effectOf(entry) !== 'review-safe') continue;
    assert.ok(Object.keys(entry.lists ?? {}).length, `${key} names no list`);
    for (const [list, event] of Object.entries(entry.lists)) assert.match(`${list} ${event}`, /^[a-zA-Z]+ [a-z_]+$/u, key);
  }
  const state = await readFile(new URL('state.mjs', SOURCE), 'utf8');
  const classifier = state.slice(state.indexOf('function applicabilityDecisionCommit('), state.indexOf('export async function onlyHumanDecisionCommits('));
  assert.ok(classifier.includes('REVIEW_SAFE_DECISION_LISTS'), 'applicabilityDecisionCommit reads the registry');
  assert.doesNotMatch(classifier, /scopeDispositions|testRunRisks|'risk_decided'/u, 'and keeps no list of its own');
});

async function classify(item, evidenceCommit) {
  const root = path.resolve(item, '../../..');
  const config = await loadConfig(root);
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const history = await reviewHistoryCommits(root, config, workflow, workflow.phases.planning, { evidenceCommit });
  return { blocking: history.blocking, pending: history.pendingIntentAmendmentProposals.map((entry) => entry.id) };
}

test('an undecided proposal holds the approval only when its commit is exactly a proposal', async (t) => {
  const { git, cli, item, submitted, candidate } = await submittedPlanningStory(t, WORK);
  await writeFile(candidate, specification(WORK, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
  assert.deepEqual(await classify(item, submitted), { blocking: [], pending: ['AMD-001'] });

  // The same proposal with a file of its own beside it makes the submission stale, as before M2.
  await writeFile(path.join(item, 'context/intent-amendments/AMD-001-notes.md'), 'Why the value changes.\n');
  git('add', '-A');
  git('commit', '-q', '--amend', '--no-edit', '--no-verify');
  assert.deepEqual(await classify(item, submitted), { blocking: [git('rev-parse', 'HEAD')], pending: [] });
});
