import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import { createAutoPlan, ratifyAutoPlan, readAutoPlan } from '../src/auto/auto-plan.mjs';
import { startAutoFlight } from '../src/auto/auto-flight.mjs';
import { executeAutoFlightStep } from '../src/auto/auto-executor.mjs';
import {
  authorizeAutoAuthoringAttempt, pauseAutoFlight, readAutoFlightReport,
  readAutoFlightState, resumeAutoFlight
} from '../src/auto/auto-flight-store.mjs';
import { loadDefinition } from '../src/config.mjs';
import { withOperationContext } from '../src/operation-context.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Auto Tester' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Auto Tester'], root);
  run('git', ['config', 'user.email', 'auto@example.com'], root);
  run(process.execPath, [cli, 'init'], root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.git.publish = 'off';
  workflow.auto.enabled = true;
  workflow.workTypes.feature.auto = {
    eligibility: 'bounded', allowedPaces: ['phase'], defaultUntil: 'first-human-boundary'
  };
  await writeFile(workflowPath, YAML.stringify(workflow));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'enable bounded auto fixture'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

async function executableRepository() {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  const authorScript = [
    'const fs=require("node:fs"),p=require("node:path"),r=process.cwd();',
    'fs.writeFileSync(p.join(r,"app.mjs"),"export const value = 2;\\n");',
    'fs.mkdirSync(p.join(r,"test"),{recursive:true});',
    'fs.writeFileSync(p.join(r,"test/app.test.mjs"),"import assert from \'node:assert/strict\';\\nimport { value } from \'../app.mjs\';\\nassert.equal(value, 2);\\n");',
    'process.stdout.write("authored")'
  ].join('');
  workflow.models.providers['copilot-cli'] = {
    type: 'copilot-cli', executable: process.execPath, arguments: ['-e', authorScript, '--']
  };
  workflow.auto.ceilings = { tokenBudget: { maximum: 30000, assurance: 'best-available' } };
  workflow.workTypes['quick-fix'].auto = {
    eligibility: 'bounded', allowedPaces: ['phase'], defaultUntil: 'phase-complete:implement'
  };
  workflow.workTypes['quick-fix'].intelligence = { worldModel: 'off', ast: 'off', agentBriefs: 'off' };
  await writeFile(workflowPath, YAML.stringify(workflow));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'configure executable auto pilot'], root);
  run('git', ['push', 'origin', 'main'], root);
  return root;
}

function refs(root) { return run('git', ['for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads'], root).stdout; }
function worktrees(root) { return run('git', ['worktree', 'list', '--porcelain'], root).stdout; }

const proposal = {
  title: 'Change the application value', workType: 'feature',
  assumptions: ['The exported value is the intended integration point.'],
  unresolvedDecisions: [], predictedPaths: ['app.mjs'],
  acceptanceCriteria: ['The exported value reflects the requested behavior.'],
  suggestedUntil: 'first-human-boundary'
};

test('Auto planning creates no lifecycle state, ref, or worktree before exact hash ratification', async () => {
  const root = await repository();
  const definition = await loadDefinition(root);
  const before = { refs: refs(root), worktrees: worktrees(root), status: run('git', ['status', '--porcelain'], root).stdout };
  const plan = await createAutoPlan(root, 'Change the exported application value.', proposal, {
    definition, workId: 'AUT-PLAN-1', workType: 'feature', fromBranch: 'main'
  });
  assert.match(plan.planId, /^APL-[A-F0-9]{26}$/);
  assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(plan.safety.startable, true);
  assert.deepEqual(plan.executionHost.availableTools, ['read_file', 'search', 'edit_file', 'create_file']);
  assert.equal(plan.executionHost.availableTools.some((tool) => /shell|command|terminal|git/i.test(tool)), false);
  assert.deepEqual({ refs: refs(root), worktrees: worktrees(root), status: run('git', ['status', '--porcelain'], root).stdout }, before);
  assert.deepEqual(await readAutoPlan(root, plan.planId), plan);
  const shown = JSON.parse(run(process.execPath, [cli, 'auto', 'show-plan', plan.planId, '--json'], root).stdout);
  assert.equal(shown.resultType, 'command-result');
  assert.equal(shown.operation.id, 'auto.show-plan');
  assert.equal(shown.data.value.planSha256, plan.planSha256);
  await assert.rejects(() => ratifyAutoPlan(root, plan.planId, `sha256:${'0'.repeat(64)}`), (error) => error.code === 'AUTO_PLAN_CONFIRMATION_REQUIRED');
  assert.deepEqual({ refs: refs(root), worktrees: worktrees(root), status: run('git', ['status', '--porcelain'], root).stdout }, before);
});

test('Auto start reuses the governed Story transaction in a managed worktree and stops at the human boundary', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Change the exported application value.', proposal, {
    workId: 'AUT-START-1', workType: 'feature', fromBranch: 'main'
  });
  const started = await startAutoFlight(root, plan.planId, plan.planSha256);
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.equal(started.flight.status, 'waiting-human');
  assert.equal(started.flight.stopReason, 'first-human-boundary');
  assert.match(started.story.worktree, /singularity-flow\/auto-worktrees\/AFL-/);
  assert.equal(run('git', ['branch', '--show-current'], started.story.worktree).stdout.trim(), 'AUT-START-1');
  const storyWorkflow = JSON.parse(await readFile(path.join(
    started.story.worktree, 'singularity/work-items/AUT-START-1/workflow.json'
  ), 'utf8'));
  assert.deepEqual(storyWorkflow.executionOrigin, {
    schemaVersion: 1, mode: 'auto', flightId: started.flight.flightId,
    planId: plan.planId, planSha256: plan.planSha256
  });
  assert.equal(storyWorkflow.lineage.executionOrigin.planSha256, plan.planSha256);
  assert.match(await readFile(path.join(
    started.story.worktree, 'singularity/work-items/AUT-START-1/USER-STORY.md'
  ), 'utf8'), /The exported value reflects the requested behavior/);
  const ratification = JSON.parse(await readFile(path.join(
    started.story.worktree, 'singularity/work-items/AUT-START-1/context/auto/ratification.json'
  ), 'utf8'));
  assert.equal(ratification.identityAssurance, 'configured-local');
  assert.equal(ratification.actor.name, 'Auto Tester');
  assert.equal(ratification.authorizationSha256.startsWith('sha256:'), true);
  const localAuthorization = JSON.parse(await readFile(path.join(
    root, '.git/singularity-flow/auto-authorizations', `${plan.planId}.json`
  ), 'utf8'));
  assert.equal(localAuthorization.authorizationSha256, ratification.authorizationSha256);
  assert.notEqual(localAuthorization.recordSha256, ratification.recordSha256);
  assert.equal((await readAutoFlightState(root, started.flight.flightId)).recordSha256, started.flight.recordSha256);
  await assert.rejects(() => startAutoFlight(root, plan.planId, plan.planSha256), (error) => error.code === 'AUTO_AUTHORIZATION_CONSUMED');
});

test('checkpoint resume is exact and authoring attempt counters are consumed before invocation', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Change the exported application value.', {
    ...proposal, unresolvedDecisions: ['A human must choose the public contract.']
  }, { workId: 'AUT-CHECK-1', workType: 'feature', fromBranch: 'main' });
  const { flight } = await startAutoFlight(root, plan.planId, plan.planSha256);
  await assert.rejects(() => resumeAutoFlight(root, flight.flightId, `sha256:${'0'.repeat(64)}`), (error) => error.code === 'AUTO_CHECKPOINT_STALE');
  const running = await resumeAutoFlight(root, flight.flightId, flight.checkpointSha256);
  assert.equal(running.status, 'running');
  const authorized = await authorizeAutoAuthoringAttempt(root, flight.flightId, running.story.phase);
  assert.equal(authorized.counters.authoringAttempts[running.story.phase], 1);
  assert.equal(authorized.counters.modelInvocations, 1);
  const paused = await pauseAutoFlight(root, flight.flightId);
  assert.equal(paused.status, 'paused');
  await assert.rejects(() => resumeAutoFlight(root, flight.flightId, running.checkpointSha256), (error) => error.code === 'AUTO_CHECKPOINT_STALE');
});

test('thin pilot performs one governed authoring attempt and stops after normal publish and submit', async () => {
  const root = await executableRepository();
  const plan = await createAutoPlan(root, 'Change the exported application value from one to two.', {
    ...proposal,
    workType: 'quick-fix',
    predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId: 'AUT-EXEC-1', workType: 'quick-fix', fromBranch: 'main' });
  const started = await startAutoFlight(root, plan.planId, plan.planSha256);
  assert.equal(started.flight.status, 'running');
  const final = await withOperationContext({
    operation: { id: 'auto.flight-step', command: 'auto', classification: 'mutation', modelPolicy: 'required' },
    modelMode: { enabled: true }, root: started.story.worktree, command: 'auto'
  }, () => executeAutoFlightStep(root, started.flight.flightId, started.flight.checkpointSha256));
  if (final.status === 'halted') assert.fail(`${final.stopReason}: ${final.lastError?.message ?? final.nextAction}`);
  assert.equal(final.counters.authoringAttempts.implement, 1);
  assert.equal(final.counters.modelInvocations, 1);
  assert.notEqual(final.status, 'running');
  assert.notEqual(final.stopReason, 'authoring-failed');
  const source = await readFile(path.join(started.story.worktree, 'app.mjs'), 'utf8');
  assert.match(source, /value = 2/);
  assert.equal(final.position, 'submitted');
  const report = await readAutoFlightReport(root, final.flightId);
  assert.equal(final.finalReportSha256, report.reportSha256);
  assert.deepEqual(report.scope.predicted.paths, ['app.mjs', 'test/app.test.mjs']);
  assert.deepEqual(report.scope.observed.paths, ['app.mjs', 'test/app.test.mjs']);
});
