import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertActionPlanFresh,
  createActionPlan,
  loadActionPlan,
  readActionResult,
  recordActionResult,
  selectPlannedAction
} from '../src/action-plans.mjs';
import { consumeActionAuthorization, issueActionAuthorization } from '../src/action-authorization.mjs';

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
      timing: 'now', skill: '/sf-phase', command: 'singularity-flow prepare intake', reason: 'Prepare intake.'
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
  assert.equal(plan.actions[0].confirmation.mode, 'one-time-authorization');
  assert.match(plan.revision.workingTree.workingTree, /^[a-f0-9]{40,64}$/);
  assert.equal(plan.basedOn.subject.id, 'STORY-1');
  assert.equal(plan.basedOn.head, plan.revision.head);
  assert.equal(plan.basedOn.stateHash, plan.revision.lifecycleSha256);
  assert.match(plan.actions[0].idempotencyKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.actions[0].expectedOutcome.references, []);
  assert.deepEqual((await loadActionPlan(root, plan.planId)).revision, plan.revision);
  assert.doesNotThrow(() => assertActionPlanFresh(root, plan, snapshot));

  await writeFile(path.join(root, 'README.md'), '# changed after planning\n');
  assert.throws(() => assertActionPlanFresh(root, plan, snapshot), /worktreeHash changed/);
});

test('governed references are part of the expected outcome and action identity', async () => {
  const root = await repository();
  const withoutReference = await createActionPlan(root, lifecycle());
  const handle = `sfref:v1:story:STORY-1:${'a'.repeat(64)}`;
  const withReference = await createActionPlan(root, lifecycle([{
    timing: 'now',
    skill: '/sf-phase',
    command: 'singularity-flow prepare intake',
    reason: 'Prepare intake.',
    references: [{ handle, purpose: 'approved-design', required: true }]
  }]));
  assert.deepEqual(withReference.actions[0].expectedOutcome.references, [{
    handle, purpose: 'approved-design', required: true
  }]);
  assert.notEqual(withReference.actions[0].actionId, withoutReference.actions[0].actionId);
  assert.notEqual(withReference.planHash, withoutReference.planHash);
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
  await assert.rejects(() => issueActionAuthorization(root, plan, action, { confirmation: null }), /exact action ID/);
  await assert.rejects(() => issueActionAuthorization(root, plan, action, { confirmation: 'guessed' }), /exact action ID/);
  const authorization = await issueActionAuthorization(root, plan, action, {
    confirmation: action.actionId,
    channel: 'test'
  });
  assert.match(authorization.authorizationId, /^[0-9a-f-]{36}$/);
  assert.match(authorization.questionId, /^[a-f0-9]{24}$/);
  assert.match(authorization.answerReceipt, /^[a-f0-9]{64}$/);
  const consumed = await consumeActionAuthorization(root, authorization.token, plan, action);
  assert.equal(consumed.actionId, action.actionId);
  assert.equal(consumed.answerReceipt, authorization.answerReceipt);
  await assert.rejects(
    () => consumeActionAuthorization(root, authorization.token, plan, action),
    /already consumed/
  );
  assert.throws(() => selectPlannedAction(plan, 'f'.repeat(24)), /is not part of plan/);
});

test('action freshness hashes bytes inside paths that were already dirty or untracked', async () => {
  const root = await repository();
  const tracked = path.join(root, 'README.md');
  const untracked = path.join(root, 'notes.md');
  await writeFile(tracked, '# dirty version one\n');
  await writeFile(untracked, 'untracked version one\n');
  const plan = await createActionPlan(root, lifecycle());

  await writeFile(tracked, '# dirty version two with the same status shape\n');
  assert.throws(() => assertActionPlanFresh(root, plan, lifecycle()), /worktreeHash changed/);

  await writeFile(tracked, '# dirty version one\n');
  const second = await createActionPlan(root, lifecycle());
  await writeFile(untracked, 'untracked version two with the same status shape\n');
  assert.throws(() => assertActionPlanFresh(root, second, lifecycle()), /worktreeHash changed/);
});

test('one-time action authorization cannot be transferred to a different local Git identity', async () => {
  const root = await repository();
  const plan = await createActionPlan(root, lifecycle());
  const action = selectPlannedAction(plan, plan.actions[0].actionId);
  const authorization = await issueActionAuthorization(root, plan, action, {
    confirmation: action.actionId,
    channel: 'test'
  });
  git(['config', 'user.email', 'another.reviewer@example.com'], root);
  await assert.rejects(
    () => consumeActionAuthorization(root, authorization.token, plan, action),
    /different local Git identity/
  );
  await assert.rejects(
    () => consumeActionAuthorization(root, authorization.token, plan, action),
    /already consumed/
  );
});

test('action freshness binds staged bytes separately from visible working-tree bytes', async () => {
  const root = await repository();
  const target = path.join(root, 'README.md');
  await writeFile(target, '# staged version one\n');
  git(['add', 'README.md'], root);
  const plan = await createActionPlan(root, lifecycle());

  await writeFile(target, '# staged version two\n');
  git(['add', 'README.md'], root);
  await writeFile(target, '# staged version one\n');
  assert.throws(() => assertActionPlanFresh(root, plan, lifecycle()), /worktreeHash changed/);
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
