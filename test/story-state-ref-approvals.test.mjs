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
import { loadDefinition } from '../src/config.mjs';
import { loadWorkflow } from '../src/story-workflow-read.mjs';
import { phaseLessons, readAllLessons } from '../src/story-lessons.mjs';
import { forgetStoryLayouts } from '../src/story-paths.mjs';
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

test('a code commit after a submission never stops a document step\'s approval: the code step ahead takes it up (A4, WCB:REQ-006)', async (t) => {
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
  // A document step's approval never answers for the code base when a code step comes after it (owner, 2026-11-27): that
  // step's first interval starts where code was last governed, so it takes the commit up [WCB:REQ-006, REQ-008]. Before
  // WCB this stopped the approval (STORY_REVIEW_INTERVENING_COMMIT).
  const approved = cliIn(root, ['approve', 'specification', '--yes', '--json'], { allowFailure: true });
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.equal(await status(item, 'specification'), 'approved');
  assert.equal(git('log', '-1', '--format=%s', '--', 'value.mjs').trim(), 'A change a person made after the submission', 'the code commit stays for the code step');
});

test('a lesson noticed at approval is committed on the state ref, not the branch, and recalled from it [WMR:REQ-022]', async (t) => {
  const work = 'SSB-L1';
  const story = await stateRefStory(t, work);
  const { root, item, git, remoteGit } = story;
  const cli = (...args) => cliIn(root, args);
  const base = git('rev-parse', 'HEAD');
  const lesson = 'Keep the value module free of side effects.';
  const dropping = 'Name the value in one place only.';
  await writeFile(path.join(item, 'artifacts/specification/spec.md'),
    `${specification(work, 1)}\n\n## Learnings to carry forward\n\n- ${lesson}\n- ${dropping}\n`);
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  await decideScope(cli);
  if (await status(item, 'specification') === 'awaiting_approval') cli('approve', 'specification', '--yes');
  assert.equal(await status(item, 'specification'), 'approved');
  // On the state ref with the approval; nothing on the Story branch or in the code checkout.
  assertPublishedOnStateRef(story, work, base, 'approve with a lesson');
  const kept = git('ls-tree', '-r', '--name-only', REF(work)).split('\n').filter((file) => file.startsWith('singularity/knowledge/records/'));
  assert.equal(kept.length, 2, 'the lessons are records on the state ref');
  assert.ok(kept.some((file) => /free of side effects/u.test(git('show', `${REF(work)}:${file}`))));
  assert.equal(git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'singularity/knowledge'), '', 'the branch holds no lesson');
  assert.equal(remoteGit('rev-parse', `refs/heads/${work}`), base);
  forgetStoryLayouts();
  assert.ok((await readAllLessons(root)).entries.some((entry) => entry.record.text === lesson), 'recalled from the state checkout');

  // A person's change to it is kept in the state checkout and committed on the state ref, never on the branch; sync
  // publishes it.
  const listed = JSON.parse(cli('lessons', '--json').stdout).lessons.find((entry) => entry.text === dropping);
  assert.ok(listed, 'the lesson is listed');
  const beforeRule = git('rev-parse', REF(work));
  const ruled = JSON.parse(cli('lessons', 'rule', listed.id, '--json').stdout);
  assert.equal(ruled.committed, true);
  assert.notEqual(git('rev-parse', REF(work)), beforeRule, 'the team rule is a state commit');
  const dropped = JSON.parse(cli('lessons', 'drop', ruled.now, '--json').stdout);
  assert.equal(dropped.committed, true);
  assert.equal(git('rev-parse', 'HEAD'), base, 'the branch holds neither');
  assert.equal(git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'singularity/knowledge'), '');
  assert.equal(git('-C', item, 'status', '--porcelain', '--untracked-files=all'), '');
  const now = JSON.parse(cli('lessons', '--json').stdout).lessons;
  assert.equal(now.filter((entry) => entry.text === dropping).length, 0, 'dropped for good');
  assert.equal(now.filter((entry) => entry.text === lesson).length, 1, 'the other is still given');
  cli('sync', work);
  assert.equal(remoteGit('rev-parse', REF(work)), git('rev-parse', REF(work)), 'sync publishes the lesson changes');

  // Another Story in the same clone recalls it from the first Story's state ref.
  cli('start', 'SSB-L2', '--from-branch', 'main', '--work-type', 'spec-driven-standard', '--title', 'Another value',
    '--description', 'Return another value.');
  forgetStoryLayouts();
  const definition = await loadDefinition(root);
  const other = await loadWorkflow(root, definition, 'SSB-L2');
  assert.equal(other.workItem.id, 'SSB-L2');
  const given = await phaseLessons(root, { workflow: other, phase: 'specification' });
  assert.ok(given.chosen.some((entry) => entry.record.text === lesson), `the next Story's step is given it: ${given.text}`);
});
