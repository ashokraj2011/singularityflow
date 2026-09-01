import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  assertAutoRequirementSourceCurrent, autoContinuationProjection,
  buildAdhocAutoHandoff, resolveAutoGoalSeed
} from '../src/auto/auto-entry-modes.mjs';
import { createGoal, linkGoal } from '../src/goals.mjs';
import { resolveOperation } from '../src/command-registry.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Auto Entry Tester',
      SINGULARITY_FLOW_NO_NETWORK: '1'
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(root, ...args) { return execute('git', args, root).stdout.trim(); }
function sflow(root, ...args) { return execute(process.execPath, [cli, ...args], root).stdout; }

async function repository(t, name = 'entry') {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-auto-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Auto Entry Tester');
  git(root, 'config', 'user.email', 'auto-entry@example.com');
  return root;
}

test('Goal seeding binds exact personal Goal content and fails closed after the Goal changes', async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-goal-workspace-'));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const root = path.join(workspacePath, 'repos', 'app');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Auto Entry Tester');
  git(root, 'config', 'user.email', 'auto-entry@example.com');
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  const context = {
    workspace: {
      id: 'auto-goal-workspace', name: 'Auto goal workspace', path: workspacePath,
      leadRepository: 'app', repositories: { app: { path: 'repos/app' } }
    },
    leadRepositoryPath: root, repositoryPath: root,
    selected: { repositoryId: 'app', storyId: null },
    actor: { name: 'Auto Entry Tester', email: 'auto-entry@example.com' }
  };
  const created = await createGoal(context, {
    statement: 'Make checkout resilient',
    successCriteria: ['Checkout succeeds after one transient timeout']
  }, { now: () => new Date('2026-09-01T00:00:00.000Z') });

  const seed = await resolveAutoGoalSeed(root, created.goal.id, { context });
  assert.equal(seed.requirement, 'Make checkout resilient');
  assert.deepEqual(seed.acceptanceCriteria, ['Checkout succeeds after one transient timeout']);
  assert.equal(seed.source.kind, 'goal');
  assert.equal(seed.source.authority, 'personal-advisory');
  assert.match(seed.source.goalSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await assertAutoRequirementSourceCurrent(root, seed.source, { context }), {
    valid: true, goalSha256: seed.source.goalSha256
  });

  await linkGoal(context, created.goal.id, {
    kind: 'story', id: 'CHK-101', repositoryId: 'app'
  }, { now: () => new Date('2026-09-01T00:01:00.000Z') });
  await assert.rejects(
    () => assertAutoRequirementSourceCurrent(root, seed.source, { context }),
    (error) => error.code === 'AUTO_GOAL_SOURCE_STALE'
  );
});

test('existing-Story continuation is an exact read proposal and generic continue never resumes or approves', () => {
  const workflow = {
    workItem: { id: 'STORY-142' }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['specification', 'implementation'], phases: {},
    executionOrigin: {
      mode: 'auto', flightId: 'AFL-AAAAAAAAAAAAAAAAAAAAAAAAAA',
      planId: 'APL-BBBBBBBBBBBBBBBBBBBBBBBBBB', planSha256: `sha256:${'b'.repeat(64)}`
    }
  };
  const flight = {
    flightId: workflow.executionOrigin.flightId, status: 'paused',
    checkpointSha256: `sha256:${'c'.repeat(64)}`,
    planId: workflow.executionOrigin.planId, planSha256: workflow.executionOrigin.planSha256
  };
  const first = autoContinuationProjection(workflow, flight);
  const replay = autoContinuationProjection(workflow, flight);
  assert.equal(first.proposalSha256, replay.proposalSha256);
  assert.equal(first.proposal.status, 'ready-for-explicit-resume');
  assert.equal(first.proposal.command,
    `singularity-flow auto resume ${flight.flightId} --confirm ${flight.checkpointSha256}`);
  assert.deepEqual(first.effects, { approvals: 0, resumes: 0, mutations: 0 });

  const manual = autoContinuationProjection({
    ...workflow, executionOrigin: null, workItem: { id: 'MANUAL-1' }
  });
  assert.equal(manual.proposal.status, 'new-plan-required');
  assert.equal(manual.proposal.command, null);
});

test('Ad Hoc adoption verifies exact confirmed effects and renders a non-startable provenance-preserving handoff', async (t) => {
  const root = await repository(t, 'adhoc');
  sflow(root, 'init');
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  git(root, 'switch', '-c', 'feature/adhoc');
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 2;\n');
  const landing = JSON.parse(sflow(root, 'land', '--json'));
  sflow(root, 'adhoc', 'intent', 'confirm', landing.sessionId,
    '--objective', 'Change the exported value',
    '--success', 'The module exports value 2',
    '--confirm', landing.changeSetSha256, '--json');
  const before = git(root, 'status', '--porcelain');

  const result = await buildAdhocAutoHandoff(root, landing.sessionId);
  assert.equal(result.handoff.source.origin, 'pre-auto-adhoc');
  assert.equal(result.handoff.source.intentProvenance, 'discovered-at-landing');
  assert.equal(result.handoff.source.changeSetSha256, landing.changeSetSha256);
  assert.equal(result.handoff.safety.startable, false);
  assert.deepEqual(result.handoff.effects, {
    approvals: 0, stories: 0, flights: 0, repositoryWrites: 0
  });
  assert.match(result.handoff.proposalSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(git(root, 'status', '--porcelain'), before);
  const cliResult = JSON.parse(sflow(
    root, 'auto', 'adopt', '--from-adhoc', landing.sessionId, '--json'
  ));
  assert.equal(cliResult.operation.id, 'auto.adopt');
  assert.equal(cliResult.operation.classification, 'read');
  assert.equal(cliResult.effects.stateChanged, false);
  assert.equal(cliResult.data.value.handoff.proposalSha256, result.handoff.proposalSha256);
  assert.equal(git(root, 'status', '--porcelain'), before);

  await writeFile(path.join(root, 'app.mjs'), 'export const value = 3;\n');
  await assert.rejects(
    () => buildAdhocAutoHandoff(root, landing.sessionId),
    (error) => error.code === 'AUTO_ADHOC_CHANGE_SET_STALE'
  );
  assert.match(await readFile(path.join(root, 'app.mjs'), 'utf8'), /value = 3/);
});

test('entry modes have closed read/model policy classification', () => {
  const operation = (positionals, options = {}) => resolveOperation({
    requestedCommand: 'auto', positionals, options
  });
  assert.equal(operation(['auto'], { goal: 'GOL-20260901-001' }).id, 'auto.plan');
  assert.equal(operation(['auto'], { goal: 'GOL-20260901-001' }).modelPolicy, 'required');
  assert.equal(operation(['auto', 'continue', 'STORY-142']).classification, 'read');
  assert.equal(operation(['auto', 'adopt'], { 'from-adhoc': 'AHS-EXACT1234' }).id, 'auto.adopt');
  assert.equal(operation(['auto', 'adopt'], { 'from-adhoc': 'AHS-EXACT1234' }).classification, 'read');
});
