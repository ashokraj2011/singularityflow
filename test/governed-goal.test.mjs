import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  approveGovernedGoalPlan, compileGovernedGoalPlan, createGovernedGoal,
  createGovernedGoalId, loadGovernedGoal, runGovernedGoalNext, verifyGovernedGoal
} from '../src/governed-goals.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-gex-test-'));
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  const repository = path.join(base, 'workspace', 'repos', 'app');
  git(base, 'init', '--bare', remote);
  git(base, 'init', '-b', 'main', seed);
  git(seed, 'config', 'user.name', 'Goal Executor');
  git(seed, 'config', 'user.email', 'goal-executor@example.com');
  await writeFile(path.join(seed, 'README.md'), '# governed Goal fixture\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-m', 'fixture');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(base, 'clone', remote, repository);
  git(repository, 'config', 'user.name', 'Goal Executor');
  git(repository, 'config', 'user.email', 'goal-executor@example.com');
  const workspacePath = path.dirname(path.dirname(repository));
  const context = {
    workspace: {
      id: 'goal-execution', name: 'Goal execution', path: workspacePath,
      leadRepository: 'app', repositories: { app: { path: 'repos/app' } }
    },
    selected: { repositoryId: 'app', storyId: null },
    leadRepositoryPath: repository,
    repositoryPath: repository
  };
  const personal = {
    id: 'GOL-20260820-001', statement: 'Ship checkout reliability',
    successCriteria: ['PAY-101 is complete', 'PAY-102 is complete'],
    links: [
      { kind: 'story', id: 'PAY-101', repositoryId: 'app', branch: 'PAY-101', title: 'Retry checkout' },
      { kind: 'story', id: 'PAY-102', repositoryId: 'app', branch: 'PAY-102', title: 'Verify checkout' }
    ]
  };
  return { base, remote, repository, context, personal };
}

const policy = { git: { remote: 'origin', publish: 'required' } };
const fixedNow = () => new Date('2026-08-20T00:00:00.000Z');

test('governed Goals publish on their own branch without switching the Story checkout', async () => {
  const { remote, repository, context, personal } = await fixture();
  const id = createGovernedGoalId({ now: fixedNow, random: () => Buffer.alloc(10, 7) });
  const originalBranch = git(repository, 'branch', '--show-current');
  const created = await createGovernedGoal(context, personal, { id, config: policy, now: fixedNow });

  assert.equal(created.contract.id, id);
  assert.equal(created.contract.source.personalGoalId, personal.id);
  assert.equal(created.contract.criteria.every((criterion) => criterion.oracle.type === 'governed-work'), true);
  assert.equal(git(repository, 'branch', '--show-current'), originalBranch);
  assert.equal(git(repository, 'status', '--porcelain'), '');
  assert.equal(git(remote, 'rev-parse', `refs/heads/${id}`), created.publication.commit);

  const planned = await compileGovernedGoalPlan(context, id, { config: policy, now: fixedNow });
  assert.equal(planned.plan.steps.length, 2);
  assert.equal(planned.state.status, 'awaiting-plan-approval');
  await assert.rejects(
    () => approveGovernedGoalPlan(context, id, {
      config: policy, generation: planned.plan.generation, confirmation: 'wrong', now: fixedNow
    }),
    (error) => error.code === 'GOVERNED_GOAL_PLAN_CONFIRMATION_REQUIRED'
  );
  const afterRefusal = loadGovernedGoal(context, id, { config: policy });
  assert.equal(afterRefusal.state.revision, planned.state.revision);

  const approved = await approveGovernedGoalPlan(context, id, {
    config: policy, generation: planned.plan.generation,
    confirmation: planned.plan.planSha256, now: fixedNow
  });
  assert.equal(approved.state.status, 'ready');
  assert.equal(approved.state.approvedPlan.planSha256, planned.plan.planSha256);

  const first = await runGovernedGoalNext(context, id, [
    { kind: 'story', id: 'PAY-101', repositoryId: 'app', availability: 'available', status: 'in_progress', terminal: false },
    { kind: 'story', id: 'PAY-102', repositoryId: 'app', availability: 'available', status: 'in_progress', terminal: false }
  ], { config: policy, now: fixedNow });
  assert.equal(first.value.step.subject.id, 'PAY-101');
  assert.equal(first.state.status, 'waiting');

  const second = await runGovernedGoalNext(context, id, [
    { kind: 'story', id: 'PAY-101', repositoryId: 'app', availability: 'available', status: 'complete', terminal: true },
    { kind: 'story', id: 'PAY-102', repositoryId: 'app', availability: 'available', status: 'in_progress', terminal: false }
  ], { config: policy, now: fixedNow });
  assert.deepEqual(second.state.completedStepIds, ['step-001']);
  assert.equal(second.value.step.subject.id, 'PAY-102');

  const verified = await verifyGovernedGoal(context, id, [
    { kind: 'story', id: 'PAY-101', repositoryId: 'app', availability: 'available', status: 'complete', terminal: true },
    { kind: 'story', id: 'PAY-102', repositoryId: 'app', availability: 'available', status: 'complete', terminal: true }
  ], { config: policy, now: fixedNow });
  assert.equal(verified.state.status, 'achieved');
  assert.equal(verified.state.assurance, 'verified');
});

test('a fresh clone reconstructs a governed Goal from the lifecycle branch', async () => {
  const { base, remote, context, personal } = await fixture();
  const id = createGovernedGoalId({ now: fixedNow, random: () => Buffer.alloc(10, 9) });
  const created = await createGovernedGoal(context, personal, { id, config: policy, now: fixedNow });
  const fresh = path.join(base, 'fresh', 'repos', 'app');
  git(base, 'clone', remote, fresh);
  const freshContext = {
    ...context,
    workspace: { ...context.workspace, path: path.join(base, 'fresh') },
    leadRepositoryPath: fresh,
    repositoryPath: fresh
  };
  const loaded = loadGovernedGoal(freshContext, id, { config: policy });
  assert.equal(loaded.contract.contractSha256, created.contract.contractSha256);
  assert.equal(loaded.revision.commit, created.publication.commit);
  assert.equal(git(fresh, 'branch', '--show-current'), 'main');
});

test('editing an approved plan invalidates its exact-hash authority before execution', async () => {
  const { base, repository, context, personal } = await fixture();
  const id = createGovernedGoalId({ now: fixedNow, random: () => Buffer.alloc(10, 11) });
  await createGovernedGoal(context, personal, { id, config: policy, now: fixedNow });
  const planned = await compileGovernedGoalPlan(context, id, { config: policy, now: fixedNow });
  await approveGovernedGoalPlan(context, id, {
    config: policy, generation: planned.plan.generation,
    confirmation: planned.plan.planSha256, now: fixedNow
  });
  const edit = path.join(base, 'edit-plan');
  git(repository, 'worktree', 'add', edit, id);
  const planFile = path.join(edit, 'singularity', 'goals', id, 'plans', 'generation-1.json');
  const bytes = JSON.parse(await readFile(planFile, 'utf8'));
  bytes.steps[0].stoppingPoint = 'silently-expanded';
  await writeFile(planFile, `${JSON.stringify(bytes, null, 2)}\n`);
  git(edit, 'add', planFile);
  git(edit, 'commit', '-m', 'tamper with approved plan');
  git(edit, 'push', 'origin', id);
  git(repository, 'worktree', 'remove', '--force', edit);

  await assert.rejects(
    () => runGovernedGoalNext(context, id, [], { config: policy, now: fixedNow }),
    (error) => error.code === 'GOVERNED_GOAL_PLAN_DRIFT'
  );
});
