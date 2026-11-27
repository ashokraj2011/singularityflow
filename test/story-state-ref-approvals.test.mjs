// SSB M3 [SSB:REQ-004, REQ-005, A2, A4]: a state-ref Story is walked on the real CLI through its steps' publication,
// submission and approval, a decision and a clarification answer, on real clones with a bare remote. Every record lands
// on its state ref through the atomic push; the Story branch gets no SFlow commit, and the remote's branch does not move
// for an approval. A second clone resumes the Story and approves. A code commit after a submission stops its approval,
// as today. docs/plans/SSB-M3-PLAN.md §3 (b).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { startedSpecificationStory, specification, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { STORY_STATE_REF_PREVIEW } from '../src/work-item-location.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const REF = (work) => `refs/singularity/state/${work}`;

function preview(t) {
  const was = process.env[STORY_STATE_REF_PREVIEW];
  process.env[STORY_STATE_REF_PREVIEW] = '1';
  t.after(() => { if (was === undefined) delete process.env[STORY_STATE_REF_PREVIEW]; else process.env[STORY_STATE_REF_PREVIEW] = was; });
}

async function stateRefStory(t, work) {
  preview(t);
  // The second statement is one of the Story's scope, for its approvers to decide.
  const story = await startedSpecificationStory(t, work, { description: 'Return an approved value. The value must not be shown to guests.', configure: (configuration) => {
    configuration.story = { storage: 'state-ref' };
    configuration.git = { ...(configuration.git ?? {}), publish: 'required' };
  } });
  const item = path.join(story.root, '.sflow-state');
  const remoteGit = (...args) => story.run('git', ['--git-dir', story.remote, ...args]).stdout.trim();
  return { ...story, item, remoteGit };
}

/** The CLI with the full stack on a failure, so a site that still refuses names itself. */
function cliIn(root, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(120_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester', SINGULARITY_FLOW_DEBUG: '1' } });
  if (!allowFailure) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** Decide each statement of the Story's scope as its approvers would: out of scope. Returns the first one's ID. */
async function decideScope(cli) {
  const scope = JSON.parse(cli('evidence', 'scope', '--json').stdout).data.scope;
  const open = (scope?.items ?? []).filter((entry) => entry.disposition === 'unresolved');
  assert.ok(open.length, `the Story has a statement to decide: ${JSON.stringify(scope)}`);
  for (const entry of open) cli('decision', 'scope', '--item', entry.id, '--as', 'excluded', '--reason', 'Out of scope for this Story.');
  return open[0].id;
}

const readState = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
const status = async (item, phase) => (await readState(item)).phases?.[phase]?.status;

/** Each transition is published: the remote's state ref is this clone's, and its Story branch is the base (A2). */
function assertPublishedOnStateRef(story, work, base, label) {
  assert.equal(story.git('rev-parse', 'HEAD'), base, `${label}: the Story branch has no SFlow commit`);
  assert.equal(story.remoteGit('rev-parse', `refs/heads/${work}`), base, `${label}: the remote's Story branch did not move`);
  assert.equal(story.git('status', '--porcelain', '--untracked-files=all'), '', `${label}: the code checkout is clean`);
  assert.equal(story.remoteGit('rev-parse', REF(work)), story.git('rev-parse', REF(work)), `${label}: the state ref was published`);
  assert.equal(story.git('-C', story.item, 'status', '--porcelain', '--untracked-files=all'), '', `${label}: every record is committed`);
}

test('a state-ref Story is published, submitted, decided, clarified and approved on its state ref; a second clone approves (A2)', async (t) => {
  const work = 'SSB-A1';
  const story = await stateRefStory(t, work);
  const { root, item, git, remoteGit } = story;
  const cli = (...args) => cliIn(root, args);
  const base = git('rev-parse', 'HEAD');
  assert.equal(remoteGit('rev-parse', `refs/heads/${work}`), base);

  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(work, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  assertPublishedOnStateRef(story, work, base, 'publish');
  cli('submit', 'specification', '--skip-checks');
  assertPublishedOnStateRef(story, work, base, 'submit');
  // A decision: the scope's one statement, decided by its approvers before the step is approved; published on the
  // state ref, and a decision may come between a submission and its approval, as today.
  const before = git('rev-parse', REF(work));
  const decided = await decideScope(cli);
  assert.notEqual(git('rev-parse', REF(work)), before, 'the decision is a state commit');
  assert.equal((await readState(item)).scopeDispositions?.find((entry) => entry.item === decided)?.disposition, 'excluded');
  assertPublishedOnStateRef(story, work, base, 'decision');
  if (await status(item, 'specification') === 'awaiting_approval') cli('approve', 'specification', '--yes');
  assert.equal(await status(item, 'specification'), 'approved');
  assertPublishedOnStateRef(story, work, base, 'approve');
  const records = git('ls-tree', '-r', '--name-only', REF(work)).split('\n');
  assert.ok(records.some((file) => file.startsWith('approvals/')), records.join('\n'));
  // The approval names the code commit it is about [REQ-004], and the ledger pins it.
  assert.match(git('log', '-1', '--format=%B', REF(work)), new RegExp(`Story-Code-Commit: ${base}`, 'u'));
  const pins = remoteGit('for-each-ref', '--format=%(objectname)', 'refs/singularity/pins/').split('\n').filter(Boolean);
  assert.ok(pins.length && pins.every((pin) => pin === base), `the pins keep the code commit: ${pins.join(' ')}`);

  // A clarification answer, recorded for the plan and bound into its publication.
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(work));
  const question = 'Is the exported value fixed at 1?';
  cli('wm', 'compose', '--phase', 'planning');
  cli('clarification', 'record', 'planning', '--question', question, '--answer', 'Yes, it is fixed at 1.');
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  const clarified = (await readState(item)).phases.planning;
  assert.ok(clarified.clarifications?.length || clarified.clarification || JSON.stringify(clarified).includes('clarification'),
    'the publication binds the answer');
  assert.ok(git('ls-tree', '-r', '--name-only', REF(work)).split('\n').some((file) => /^context\/clarifications-planning/u.test(file)),
    'the answer is a record on the state ref');
  cli('submit', 'planning', '--skip-checks');
  assertPublishedOnStateRef(story, work, base, 'submit planning');

  // A second clone resumes the Story from its records and approves the plan there.
  const second = path.join(story.directory, 'second');
  story.run('git', ['clone', '-q', story.remote, second], { cwd: story.directory });
  story.run('git', ['config', 'user.name', 'Second Laptop'], { cwd: second });
  story.run('git', ['config', 'user.email', 'second@example.test'], { cwd: second });
  cliIn(second, ['resume', work, '--fetch', '--json']);
  assert.equal(await status(path.join(second, '.sflow-state'), 'planning'), 'awaiting_approval');
  cliIn(second, ['approve', 'planning', '--yes']);
  const approved = story.run('git', ['rev-parse', REF(work)], { cwd: second }).stdout.trim();
  assert.equal(remoteGit('rev-parse', REF(work)), approved, 'the second clone\'s approval is published');
  assert.equal(remoteGit('rev-parse', `refs/heads/${work}`), base, 'and the Story branch did not move');
  // The first clone brings it in.
  cli('resume', work, '--fetch', '--json');
  assert.equal(git('rev-parse', REF(work)), approved);
  assert.equal(await status(item, 'planning'), 'approved');
});

test('a code commit after a submission stops its approval, as a change after publication does today (A4)', async (t) => {
  const work = 'SSB-A4';
  const story = await stateRefStory(t, work);
  const { root, item, git } = story;
  const cli = (...args) => cliIn(root, args);
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(work, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  if (await status(item, 'specification') !== 'awaiting_approval') return t.skip('the step was approved automatically');
  await decideScope(cli);
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 2;\n');
  git('add', 'value.mjs');
  git('commit', '-qm', 'A change a person made after the submission');
  const refused = cliIn(root, ['approve', 'specification', '--yes', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  // Today's refusal for a change after the submission: the code commit the submission names is behind the branch.
  assert.match(refused.stdout + refused.stderr, /STORY_REVIEW_SOURCE_CHANGED|STORY_REVIEW_INTERVENING_COMMIT/u);
  assert.match(refused.stdout + refused.stderr, /changed after generation 1 was submitted|A change a person made after the submission/u);
  assert.equal(await status(item, 'specification'), 'awaiting_approval');
});
