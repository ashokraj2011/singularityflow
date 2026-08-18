import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  abandonGoal, completeGoal, createGoal, findGoal, linkGoal, listGoals, readGoalState, selectGoal
} from '../src/goals.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture() {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'sflow-goal-'));
  const repositoryPath = path.join(workspacePath, 'repos', 'app');
  await mkdir(repositoryPath, { recursive: true });
  git(repositoryPath, 'init', '-b', 'main');
  git(repositoryPath, 'config', 'user.name', 'Goal Tester');
  git(repositoryPath, 'config', 'user.email', 'goal@example.com');
  await writeFile(path.join(repositoryPath, 'README.md'), '# fixture\n');
  git(repositoryPath, 'add', 'README.md');
  git(repositoryPath, 'commit', '-m', 'fixture');
  const workspace = {
    id: 'goal-workspace', name: 'Goal workspace', path: workspacePath,
    leadRepository: 'app', repositories: { app: { path: 'repos/app' } }
  };
  return {
    workspace,
    leadRepositoryPath: repositoryPath,
    repositoryPath,
    selected: { repositoryId: 'app', storyId: null },
    actor: { name: 'Goal Tester', email: 'goal@example.com' }
  };
}

const firstDay = () => new Date('2026-08-18T00:00:00.000Z');
const secondDay = () => new Date('2026-08-19T00:00:00.000Z');

test('Reading an empty Goal store does not mutate the workspace', async () => {
  const context = await fixture();
  const loaded = await readGoalState(context);
  assert.deepEqual(loaded.state.goals, []);
  assert.equal(
    await access(path.join(context.workspace.path, '.singularity-flow')).then(() => true).catch(() => false),
    false
  );
});

test('Goals require observable success and select deterministic workspace-local IDs', async () => {
  const context = await fixture();
  await assert.rejects(
    () => createGoal(context, { statement: 'Make checkout reliable', successCriteria: [] }, { now: firstDay }),
    (error) => error.code === 'GOAL_SUCCESS_CRITERION_REQUIRED'
  );

  const first = await createGoal(context, {
    statement: 'Make checkout reliable',
    successCriteria: ['Checkout completes after one timeout retry']
  }, { now: firstDay });
  assert.equal(first.goal.id, 'GOL-20260818-001');
  assert.equal(first.state.activeGoalId, first.goal.id);
  assert.equal(first.goal.authority, 'personal-advisory');

  const second = await createGoal(context, {
    statement: 'Reduce payment regressions',
    successCriteria: ['The pinned payment regression suite passes']
  }, { now: firstDay });
  assert.equal(second.goal.id, 'GOL-20260818-002');
  assert.equal(second.state.activeGoalId, second.goal.id);

  const selected = await selectGoal(context, first.goal.id, { now: secondDay });
  assert.equal(selected.changed, true);
  assert.equal(selected.state.activeGoalId, first.goal.id);
  assert.deepEqual(listGoals(selected.state).map((goal) => goal.id), [first.goal.id, second.goal.id]);

  const stored = JSON.parse(await readFile(path.join(context.workspace.path, '.singularity-flow', 'goals.json'), 'utf8'));
  assert.equal(stored.revision, 3);
  assert.equal(stored.authority, 'personal-advisory');
});

test('Goal links are idempotent and open governed work blocks completion', async () => {
  const context = await fixture();
  const created = await createGoal(context, {
    statement: 'Ship reliable retry behavior',
    successCriteria: ['PAY-1187 is complete and its regression test passes']
  }, { now: firstDay });
  const link = {
    kind: 'story', id: 'PAY-1187', repositoryId: 'app', branch: 'PAY-1187',
    title: 'Retry checkout', linkedAt: firstDay().toISOString()
  };
  const linked = await linkGoal(context, created.goal.id, link, { now: firstDay });
  assert.equal(linked.changed, true);
  const duplicate = await linkGoal(context, created.goal.id, link, { now: firstDay });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.goal.links.length, 1);

  await assert.rejects(
    () => completeGoal(context, created.goal.id, {
      confirmation: created.goal.id,
      linkStates: [{ ...link, availability: 'available', status: 'in_progress', terminal: false }]
    }, { now: secondDay }),
    (error) => error.code === 'GOAL_LINKS_OPEN'
  );
  await assert.rejects(
    () => completeGoal(context, created.goal.id, {
      confirmation: 'wrong',
      linkStates: [{ ...link, availability: 'available', status: 'complete', terminal: true }]
    }, { now: secondDay }),
    (error) => error.code === 'GOAL_CONFIRMATION_REQUIRED'
  );

  const completed = await completeGoal(context, created.goal.id, {
    confirmation: created.goal.id,
    completionNote: 'Confirmed against the approved Story result.',
    linkStates: [{ ...link, availability: 'available', status: 'complete', terminal: true, commit: 'abc123' }]
  }, { now: secondDay });
  assert.equal(completed.goal.status, 'achieved');
  assert.equal(completed.state.activeGoalId, null);
  assert.equal(completed.goal.completion.linkedWork[0].commit, 'abc123');
});

test('Abandon preserves Goal history and never changes linked work', async () => {
  const context = await fixture();
  const created = await createGoal(context, {
    statement: 'Explore a replacement checkout',
    successCriteria: ['A reviewed decision records whether replacement is worthwhile']
  }, { now: firstDay });
  const abandoned = await abandonGoal(context, created.goal.id, {
    confirmation: created.goal.id,
    reason: 'The upstream platform will replace this component.'
  }, { now: secondDay });
  assert.equal(abandoned.goal.status, 'abandoned');
  assert.match(abandoned.goal.abandonReason, /upstream platform/);
  assert.equal(abandoned.goal.abandonedBy.email, 'goal@example.com');
  assert.equal(findGoal(abandoned.state, created.goal.id).status, 'abandoned');
});

test('Goal state refuses a symbolic-link state directory', async () => {
  const context = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-goal-outside-'));
  await symlink(outside, path.join(context.workspace.path, '.singularity-flow'));
  await assert.rejects(
    () => readGoalState(context),
    (error) => error.code === 'GOAL_STATE_PATH_UNSAFE'
  );
});
