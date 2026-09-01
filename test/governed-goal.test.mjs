import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  approveGovernedGoalPlan, compileGovernedGoalPlan, createGovernedGoal,
  createGovernedGoalId, loadGovernedGoal, runGovernedGoalNext, syncGovernedGoal,
  verifyGovernedGoal
} from '../src/governed-goals.mjs';
import {
  readPendingPublication, verifyPendingPublicationCommit
} from '../src/publication-pending.mjs';

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
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

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

test('governed Goal preparation invokes neither post-checkout hooks nor smudge filters', async () => {
  const { base, repository, context, personal } = await fixture();
  const hookSentinel = path.join(base, 'goal-post-checkout-executed');
  const filterSentinel = path.join(base, 'goal-smudge-filter-executed');
  const filter = path.join(base, 'goal-malicious-smudge.sh');
  await writeFile(path.join(repository, '.gitattributes'), '*.payload filter=goal-malicious\n');
  await writeFile(path.join(repository, 'tracked.payload'), 'base payload\n');
  git(repository, 'add', '.gitattributes', 'tracked.payload');
  git(repository, 'commit', '-m', 'malicious checkout fixture');
  git(repository, 'push', 'origin', 'main');
  await writeFile(path.join(repository, '.git', 'hooks', 'post-checkout'),
    `#!/bin/sh\ntouch ${JSON.stringify(hookSentinel)}\n`);
  await chmod(path.join(repository, '.git', 'hooks', 'post-checkout'), 0o755);
  await writeFile(filter, `#!/bin/sh\ntouch ${JSON.stringify(filterSentinel)}\ncat\n`);
  await chmod(filter, 0o755);
  git(repository, 'config', 'filter.goal-malicious.smudge', filter);

  const id = createGovernedGoalId({ now: fixedNow, random: () => Buffer.alloc(10, 21) });
  await createGovernedGoal(context, personal, { id, config: policy, now: fixedNow });

  await assert.rejects(access(hookSentinel), (error) => error?.code === 'ENOENT');
  await assert.rejects(access(filterSentinel), (error) => error?.code === 'ENOENT');
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

test('a governed Goal interruption retains and syncs only its exact Candidate commit', async () => {
  const { remote, repository, context, personal } = await fixture();
  const id = createGovernedGoalId({ now: fixedNow, random: () => Buffer.alloc(10, 13) });
  await assert.rejects(
    () => createGovernedGoal(context, personal, {
      id, config: policy, now: fixedNow,
      fault: async (point) => {
        if (point === 'after-commit') throw new Error('simulated process interruption after Goal commit');
      }
    }),
    /simulated process interruption/
  );

  const localCommit = git(repository, 'rev-parse', `refs/heads/${id}`);
  assert.equal(git(repository, 'ls-remote', '--heads', 'origin', id), '');
  const pending = await readPendingPublication(repository, { kind: 'goal', id });
  assert.ok(pending, 'Goal interruption lost its exact pending-publication receipt');
  assert.equal(pending.record.commit, localCommit);
  const verification = verifyPendingPublicationCommit(repository, pending.record, {
    subject: { kind: 'goal', id }, branch: id, remote: 'origin'
  });
  assert.equal(verification.valid, true, verification.failures.join('; '));
  assert.equal(verification.candidateVerified, true);
  assert.equal(pending.record.candidate.candidateTree, pending.record.tree);

  const recovered = await syncGovernedGoal(context, id, { config: policy });
  assert.equal(recovered.commit, localCommit);
  assert.equal(recovered.pushed, true);
  assert.equal(git(remote, 'rev-parse', `refs/heads/${id}`), localCommit);
  assert.equal(await readPendingPublication(repository, { kind: 'goal', id }), null);
});

test('killed Goal writers recover before commit, after ref advance, and after push', async (t) => {
  const cases = [
    { point: 'after-state-write', entropy: 14, outcome: 'prepared' },
    { point: 'after-commit', entropy: 15, outcome: 'pending' },
    { point: 'after-push', entropy: 16, outcome: 'published' }
  ];
  for (const item of cases) await t.test(item.point, async () => {
    const { base, repository, context, personal } = await fixture();
    const id = createGovernedGoalId({
      now: fixedNow, random: () => Buffer.alloc(10, item.entropy)
    });
    const control = path.join(base, `${item.point}.json`);
    await writeFile(control, `${JSON.stringify({
      context, personal, id, config: policy,
      now: '2026-08-20T00:00:00.000Z', faultPoint: item.point
    })}\n`);
    const child = spawnSync(process.execPath, [
      path.join(testDirectory, 'fixtures/governed-goal-crash-child.mjs'), control
    ], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);
    assert.equal(git(repository, 'branch', '--show-current'), 'main');
    assert.equal(git(repository, 'status', '--porcelain'), '');

    const recovered = await syncGovernedGoal(context, id, { config: policy });
    const localResult = spawnSync('git', [
      'rev-parse', '--verify', '--quiet', `refs/heads/${id}`
    ], { cwd: repository, encoding: 'utf8' });
    const local = localResult.status === 0 ? localResult.stdout.trim() : null;
    const advertised = git(repository, 'ls-remote', '--heads', 'origin', id);
    if (item.outcome === 'prepared') {
      assert.equal(recovered.recoveredPrepared, true);
      assert.equal(local, null);
      assert.equal(advertised, '');
    } else {
      assert.match(local, /^[0-9a-f]{40,64}$/);
      assert.equal(advertised.split(/\s+/)[0], local);
      if (item.outcome === 'pending') assert.equal(recovered.pushed, true);
      else assert.equal(recovered.noOp, true);
    }
    assert.doesNotMatch(git(repository, 'worktree', 'list', '--porcelain'), new RegExp(id));
    assert.equal(await readPendingPublication(repository, { kind: 'goal', id }), null);
  });
});

test('local-only Goal sync restores a killed pre-commit transaction', async () => {
  const { base, repository, context, personal } = await fixture();
  const id = createGovernedGoalId({
    now: fixedNow, random: () => Buffer.alloc(10, 17)
  });
  const localPolicy = { git: { remote: 'origin', publish: 'off' } };
  const control = path.join(base, 'local-only-after-state-write.json');
  await writeFile(control, `${JSON.stringify({
    context, personal, id, config: localPolicy,
    now: '2026-08-20T00:00:00.000Z', faultPoint: 'after-state-write'
  })}\n`);
  const child = spawnSync(process.execPath, [
    path.join(testDirectory, 'fixtures/governed-goal-crash-child.mjs'), control
  ], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);

  const recovered = await syncGovernedGoal(context, id, { config: localPolicy });
  assert.equal(recovered.recoveredPrepared, true);
  assert.equal(recovered.pushed, false);
  assert.equal(spawnSync('git', [
    'rev-parse', '--verify', '--quiet', `refs/heads/${id}`
  ], { cwd: repository }).status, 1);
  assert.doesNotMatch(git(repository, 'worktree', 'list', '--porcelain'), new RegExp(id));
  assert.equal(await readPendingPublication(repository, { kind: 'goal', id }), null);
});

test('Goal sync never removes a user-created linked worktree', async () => {
  const { base, repository, context, personal } = await fixture();
  const id = createGovernedGoalId({ now: fixedNow, random: () => Buffer.alloc(10, 18) });
  await createGovernedGoal(context, personal, { id, config: policy, now: fixedNow });
  // Prefix resemblance is not ownership: only an exact authenticated SFlow owner receipt permits
  // automatic cleanup of a temporary Goal lifecycle worktree.
  const userWorktree = path.join(base, 'sflow-gex-user-owned');
  git(repository, 'worktree', 'add', userWorktree, id);
  const administrative = git(userWorktree, 'rev-parse', '--absolute-git-dir');
  await writeFile(path.join(administrative, 'singularity-flow-goal-owner.json'), `${JSON.stringify({
    format: 'sflow-goal-lifecycle-worktree-owner-v1',
    id,
    branch: id,
    path: await realpath(userWorktree),
    gitDir: await realpath(administrative),
    nonce: 'a'.repeat(64),
    createdAt: fixedNow().toISOString()
  })}\n`);

  const result = await syncGovernedGoal(context, id, { config: policy });
  assert.equal(result.noOp, true);
  assert.match(git(repository, 'worktree', 'list', '--porcelain'), new RegExp(id));
  assert.equal(git(userWorktree, 'status', '--porcelain'), '');
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
