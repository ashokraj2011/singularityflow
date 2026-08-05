import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertActionConfirmation,
  assertActionPlanFresh,
  createActionPlan,
  loadActionPlan,
  readActionResult,
  recordActionResult,
  selectPlannedAction
} from '../src/action-plans.mjs';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-action-plan-'));
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Action Plan'], root);
  git(['config', 'user.email', 'action@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# action plan\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'initial'], root);
  return root;
}

function lifecycle(actions = null) {
  return {
    schemaVersion: 1,
    state: 'active',
    workId: 'STORY-1',
    currentPhase: 'intake',
    actions: actions ?? [{
      timing: 'now', skill: '/sflow-phase', command: 'singularity-flow prepare intake', reason: 'Prepare intake.'
    }]
  };
}

test('action plans are content-addressed, private, and bound to repository/lifecycle revision', async () => {
  const root = await repository();
  const snapshot = lifecycle();
  const plan = await createActionPlan(root, snapshot);
  assert.equal(plan.actions[0].executable, true);
  assert.equal(plan.actions[0].argv.join(' '), 'prepare intake');
  assert.equal(plan.actions[0].effect.class, 'generation');
  assert.equal(plan.actions[0].confirmation.required, true);
  assert.equal(plan.actions[0].confirmation.valueFromKernel, plan.actions[0].actionId);
  assert.equal(plan.basedOn.subject.id, 'STORY-1');
  assert.equal(plan.basedOn.head, plan.revision.head);
  assert.equal(plan.basedOn.stateHash, plan.revision.lifecycleSha256);
  assert.match(plan.actions[0].idempotencyKey, /^[a-f0-9]{64}$/);
  assert.deepEqual((await loadActionPlan(root, plan.planId)).revision, plan.revision);
  assert.doesNotThrow(() => assertActionPlanFresh(root, plan, snapshot));

  await writeFile(path.join(root, 'README.md'), '# changed after planning\n');
  assert.throws(() => assertActionPlanFresh(root, plan, snapshot), /worktreeHash changed/);
});

test('only current, placeholder-free actions can execute', async () => {
  const root = await repository();
  const plan = await createActionPlan(root, lifecycle([
    { timing: 'now', skill: null, command: 'singularity-flow assign intake <assignee>', reason: 'Choose owner.' },
    { timing: 'then', skill: null, command: 'singularity-flow submit --phase intake', reason: 'Submit later.' }
  ]));
  assert.equal(plan.actions[0].executable, false);
  assert.equal(plan.actions[1].executable, false);
  assert.throws(() => selectPlannedAction(plan), /0 executable actions/);
});

test('mutating actions require exact kernel confirmation and fabricated action IDs are refused', async () => {
  const root = await repository();
  const plan = await createActionPlan(root, lifecycle());
  const action = selectPlannedAction(plan, plan.actions[0].actionId);
  assert.throws(() => assertActionConfirmation(action, null), /changes governed state/);
  assert.throws(() => assertActionConfirmation(action, 'guessed'), /changes governed state/);
  assert.doesNotThrow(() => assertActionConfirmation(action, action.actionId));
  assert.throws(() => selectPlannedAction(plan, 'f'.repeat(24)), /is not part of plan/);
});

test('successful action result is idempotently discoverable', async () => {
  const root = await repository();
  const plan = await createActionPlan(root, lifecycle());
  const action = selectPlannedAction(plan);
  assert.equal(await readActionResult(root, plan, action), null);
  const record = await recordActionResult(root, plan, action, { status: 'completed' });
  assert.equal((await readActionResult(root, plan, action)).key, record.key);
});

test('action plans reject shell composition rather than evaluating it', async () => {
  const root = await repository();
  await assert.rejects(() => createActionPlan(root, lifecycle([{
    timing: 'now', skill: null, command: 'singularity-flow status; touch escaped', reason: 'unsafe'
  }])), /unsupported shell syntax/);
});
