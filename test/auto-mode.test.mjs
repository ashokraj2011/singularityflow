import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';

import { createAutoPlan, ratifyAutoPlan, readAutoPlan } from '../src/auto/auto-plan.mjs';
import { startAutoFlight } from '../src/auto/auto-flight.mjs';
import { executeAutoFlightStep, mutateAutoExecutorState } from '../src/auto/auto-executor.mjs';
import {
  authorizeAutoAuthoringAttempt, discardAutoFlight, haltAutoFlight, mutateAutoFlightState, pauseAutoFlight,
  readAutoFlightReport, readAutoFlightState, resumeAutoFlight
} from '../src/auto/auto-flight-store.mjs';
import { loadDefinition } from '../src/config.mjs';
import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { withSubjectLock } from '../src/subject-lock.mjs';

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
  // Auto planning now probes the concrete execution driver. Keep the fixture hermetic: CI does
  // not install Copilot, while Node itself is the harmless executable used by the later pilot
  // fixture as well. Tests that actually author replace the arguments in executableRepository.
  workflow.models.providers['copilot-cli'] = {
    type: 'copilot-cli', executable: process.execPath, promptTransport: 'attachment', arguments: []
  };
  workflow.auto.ceilings = { tokenBudget: { maximum: 30000, assurance: 'best-available' } };
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

async function executableRepository({ authorDelayMs = 0 } = {}) {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  const authorBody = [
    'const fs=require("node:fs"),p=require("node:path"),r=process.cwd();',
    'fs.writeFileSync(p.join(r,"app.mjs"),"export const value = 2;\\n");',
    'fs.mkdirSync(p.join(r,"test"),{recursive:true});',
    'fs.writeFileSync(p.join(r,"test/app.test.mjs"),"import assert from \'node:assert/strict\';\\nimport { value } from \'../app.mjs\';\\nassert.equal(value, 2);\\n");',
    'process.stdout.write("authored")'
  ].join('');
  const authorScript = authorDelayMs > 0
    ? `setTimeout(()=>{${authorBody}},${authorDelayMs})`
    : authorBody;
  workflow.models.providers['copilot-cli'] = {
    type: 'copilot-cli', executable: process.execPath, promptTransport: 'attachment', arguments: ['-e', authorScript, '--']
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

async function configurationFreeExecutableRepository() {
  const root = await executableRepository();
  const remote = run('git', ['remote', 'get-url', 'origin'], root).stdout.trim();
  await ensureConfigurationBranch(remote);
  run('git', ['rm', '-qr', '--', 'singularity', '.github/agents'], root);
  run('git', ['commit', '-m', 'keep application main configuration-free'], root);
  run('git', ['push', 'origin', 'main'], root);
  return root;
}

function refs(root) { return run('git', ['for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads'], root).stdout; }
function worktrees(root) { return run('git', ['worktree', 'list', '--porcelain'], root).stdout; }

function runFlightStep(root, flight, runtime = {}) {
  return withOperationContext({
    operation: { id: 'auto.flight-step', command: 'auto', classification: 'mutation', modelPolicy: 'required' },
    modelMode: { enabled: true }, root: flight.worktree, command: 'auto'
  }, () => executeAutoFlightStep(root, flight.flightId, flight.checkpointSha256, runtime));
}

test('post-authorization Auto state writes cannot bypass the stop-aware executor CAS', async () => {
  const source = await readFile(path.resolve('src/auto/auto-executor.mjs'), 'utf8');
  const authorizationBoundary = source.indexOf('authorizeAutoAuthoringAttempt(');
  assert.notEqual(authorizationBoundary, -1, 'authoring authorization boundary disappeared');
  assert.doesNotMatch(
    source.slice(authorizationBoundary),
    /\bmutateAutoFlightState\s*\(/,
    'executor state writes after authoring authorization must use mutateAutoExecutorState'
  );
});

test('Auto uses model-routing tasks for authoring but never creates Story-specific world-model guides', async () => {
  const source = await readFile(path.resolve('src/auto/auto-executor.mjs'), 'utf8');
  const composition = source.match(/composePhasePrompt\(worktree,\s*\{([\s\S]*?)\}\);/);
  assert.ok(composition, 'Auto phase prompt composition call disappeared');
  assert.doesNotMatch(
    composition[1],
    /\btask\s*:/,
    'a model-routing task must not be converted into a reusable world-model task guide'
  );
  assert.match(
    source,
    /runModel\(\{[\s\S]*?\btask,/,
    'the phase model-routing task must still select the authoring model'
  );
});

async function withRetriedSubjectLock(root, subject, callback, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await withSubjectLock(root, subject, callback); }
    catch (error) {
      if (error?.code !== 'SUBJECT_LOCK_BUSY' || Date.now() >= deadline) throw error;
      await delay(20);
    }
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForFlight(root, id, predicate, message) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const state = await readAutoFlightState(root, id);
    if (predicate(state)) return state;
    await delay(20);
  }
  assert.fail(message);
}

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

test('a dead authorization claimant is recovered without waiting for lease expiry', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Recover a claim abandoned before Story creation.', proposal, {
    workId: 'AUT-CLAIM-RECOVERY', workType: 'feature', fromBranch: 'main'
  });
  const abandonedFlightId = `AFL-${'C'.repeat(26)}`;
  const moduleUrl = new URL('../src/auto/auto-plan.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', [
    `import { ratifyAutoPlan, claimAutoAuthorization } from ${JSON.stringify(moduleUrl)};`,
    `const root = ${JSON.stringify(root)};`,
    `const { plan, authorization } = await ratifyAutoPlan(root, ${JSON.stringify(plan.planId)}, ${JSON.stringify(plan.planSha256)});`,
    `await claimAutoAuthorization(root, plan, authorization, ${JSON.stringify(abandonedFlightId)});`
  ].join('\n')], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);

  const recovered = await startAutoFlight(root, plan.planId, plan.planSha256);
  assert.notEqual(recovered.flight.flightId, abandonedFlightId,
    'an effect-free dead claim must be released rather than reconstructed');
  assert.ok(await readAutoFlightState(root, recovered.flight.flightId));
});

test('a dead start after Story creation reconstructs the exact Auto flight', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Recover the flight after governed Story creation.', proposal, {
    workId: 'AUT-STORY-RECOVERY', workType: 'feature', fromBranch: 'main'
  });
  const abandonedFlightId = `AFL-${'D'.repeat(26)}`;
  const planUrl = new URL('../src/auto/auto-plan.mjs', import.meta.url).href;
  const originUrl = new URL('../src/auto/auto-origin.mjs', import.meta.url).href;
  const changeUrl = new URL('../src/change-flight-plan.mjs', import.meta.url).href;
  const gitUrl = new URL('../src/git.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', [
    `import path from 'node:path';`,
    `import { ratifyAutoPlan, claimAutoAuthorization } from ${JSON.stringify(planUrl)};`,
    `import { autoExecutionOrigin } from ${JSON.stringify(originUrl)};`,
    `import { startChangeFlightPlan } from ${JSON.stringify(changeUrl)};`,
    `import { gitCommonDir } from ${JSON.stringify(gitUrl)};`,
    `const root = ${JSON.stringify(root)};`,
    `const { plan, authorization } = await ratifyAutoPlan(root, ${JSON.stringify(plan.planId)}, ${JSON.stringify(plan.planSha256)});`,
    `const flightId = ${JSON.stringify(abandonedFlightId)};`,
    `const claimed = await claimAutoAuthorization(root, plan, authorization, flightId);`,
    `const repository = plan.repositories[0];`,
    `const worktree = path.join(gitCommonDir(root), 'singularity-flow', 'auto-worktrees', flightId, repository.id);`,
    `await startChangeFlightPlan(root, plan.bindings.flightPlanId, {`,
    `  confirm: plan.bindings.flightPlanId, acceptPartial: plan.scope.status === 'partial',`,
    `  workId: plan.story.workId, workType: plan.story.workType, baseBranch: repository.baseBranch, worktree,`,
    `  auto: { plan, ratification: claimed, flightId, executionOrigin: autoExecutionOrigin({ flightId, planId: plan.planId, planSha256: plan.planSha256 }) }`,
    `});`
  ].join('\n')], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);

  const recovered = await startAutoFlight(root, plan.planId, plan.planSha256);
  assert.equal(recovered.flight.flightId, abandonedFlightId);
  assert.equal(recovered.story.idempotent, true);
  const workflow = JSON.parse(await readFile(path.join(
    recovered.story.worktree, 'singularity/work-items/AUT-STORY-RECOVERY/workflow.json'
  ), 'utf8'));
  assert.equal(workflow.executionOrigin.flightId, abandonedFlightId);
});

test('workspace concurrency is atomic and corrupt flight state fails closed', async () => {
  const root = await repository();
  const corruptId = `AFL-${'E'.repeat(26)}`;
  const corruptDirectory = path.join(root, '.git/singularity-flow/auto-flights', corruptId);
  await mkdir(corruptDirectory, { recursive: true });
  await writeFile(path.join(corruptDirectory, 'state.json'), '{not-json\n');
  const blockedPlan = await createAutoPlan(root, 'Do not start while concurrency state is unreadable.', proposal, {
    workId: 'AUT-CORRUPT-BLOCK', workType: 'feature', fromBranch: 'main'
  });
  await assert.rejects(
    () => startAutoFlight(root, blockedPlan.planId, blockedPlan.planSha256),
    (error) => error.code === 'AUTO_FLIGHT_CORRUPT'
  );
  await rm(corruptDirectory, { recursive: true, force: true });

  const first = await createAutoPlan(root, 'Start only one workspace flight.', proposal, {
    workId: 'AUT-CONCURRENT-1', workType: 'feature', fromBranch: 'main'
  });
  const second = await createAutoPlan(root, 'The workspace ceiling must refuse this competing flight.', proposal, {
    workId: 'AUT-CONCURRENT-2', workType: 'feature', fromBranch: 'main'
  });
  const results = await Promise.allSettled([
    startAutoFlight(root, first.planId, first.planSha256),
    startAutoFlight(root, second.planId, second.planSha256)
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('discard removes only an unpublished managed worktree and local Story branch', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Discard unpublished isolated work safely.', proposal, {
    workId: 'AUT-DISCARD-1', workType: 'feature', fromBranch: 'main'
  });
  const started = await startAutoFlight(root, plan.planId, plan.planSha256);
  const discarded = await discardAutoFlight(root, started.flight.flightId, started.flight.flightId);
  assert.equal(discarded.status, 'discarded');
  await assert.rejects(() => access(started.story.worktree), (error) => error.code === 'ENOENT');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/AUT-DISCARD-1'], root, {
    allowFailure: true
  }).status, 1);
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
  const final = await runFlightStep(root, { ...started.flight, worktree: started.story.worktree });
  if (final.status === 'halted') assert.fail(`${final.stopReason}: ${final.lastError?.message ?? final.nextAction}`);
  assert.equal(final.counters.authoringAttempts.implement, 1);
  assert.equal(final.counters.modelInvocations, 1);
  assert.notEqual(final.status, 'running');
  assert.notEqual(final.stopReason, 'authoring-failed');
  const source = await readFile(path.join(started.story.worktree, 'app.mjs'), 'utf8');
  assert.match(source, /value = 2/);
  assert.equal(final.position, 'submitted');
  const completedWorkflow = JSON.parse(await readFile(path.join(
    started.story.worktree, 'singularity/work-items/AUT-EXEC-1/workflow.json'
  ), 'utf8'));
  const implementation = completedWorkflow.phases.implement;
  assert.equal(implementation.generationIntent.status, 'consumed');
  const deliveryReceipt = JSON.parse(await readFile(path.join(
    started.story.worktree, implementation.deliveryEvidence.receiptPath
  ), 'utf8'));
  assert.equal(deliveryReceipt.generationIntentId, implementation.generationIntent.id);
  assert.equal(implementation.authorship.at(-1).kernelModel.invocationIds.includes(final.lastInvocationId), true);
  const report = await readAutoFlightReport(root, final.flightId);
  assert.equal(final.finalReportSha256, report.reportSha256);
  assert.deepEqual(report.scope.predicted.paths, ['app.mjs', 'test/app.test.mjs']);
  assert.deepEqual(report.scope.observed.paths, ['app.mjs', 'test/app.test.mjs']);
  assert.equal(report.configuration.workflowSha256, plan.bindings.workflowSha256);
  assert.equal(report.repositories[0].baseCommit, plan.repositories[0].baseCommit);
  assert.deepEqual(report.operations.map((entry) => entry.operation), ['author', 'publish', 'submit']);
  assert.equal(report.evidence.changeSetDigest, deliveryReceipt.changeSet.digest);
  assert.equal(report.evidence.reviewPacketSha256, completedWorkflow.lineage.submissions.at(-1).packetSha256);
  assert.equal(report.lastSuccessfulStoryRevision, final.commits.submission);
});

test('Auto treats approved configuration projected into a config-free Story as input, not model output', async () => {
  const root = await configurationFreeExecutableRepository();
  assert.equal(run('git', ['cat-file', '-e', 'HEAD:singularity/workflow.yml'], root, {
    allowFailure: true
  }).status, 128);
  const plan = await createAutoPlan(root, 'Change the exported application value from one to two.', {
    ...proposal,
    workType: 'quick-fix',
    predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId: 'AUT-CONFIG-FREE', workType: 'quick-fix', fromBranch: 'main' });
  assert.match(plan.bindings.workflowSha256, /^[0-9a-f]{64}$/,
    'the plan binds the approved configuration overlay even though main is code-only');
  const started = await startAutoFlight(root, plan.planId, plan.planSha256);
  const final = await runFlightStep(root, { ...started.flight, worktree: started.story.worktree });
  if (final.status === 'halted') assert.fail(`${final.stopReason}: ${final.lastError?.message ?? final.nextAction}`);
  assert.deepEqual(final.observedPaths, ['app.mjs', 'test/app.test.mjs']);
  assert.notEqual(final.stopReason, 'protected-path-contact');
  assert.notEqual(final.stopReason, 'scope-expansion');
});

for (const boundary of ['published', 'submitted']) {
  test(`thin pilot stops exactly at the ratified ${boundary} boundary`, async () => {
    const root = await executableRepository();
    const workId = `AUT-${boundary.toUpperCase()}-1`;
    const plan = await createAutoPlan(root, 'Change the exported application value from one to two.', {
      ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
      suggestedUntil: `${boundary}:implement`
    }, { workId, workType: 'quick-fix', fromBranch: 'main' });
    const started = await startAutoFlight(root, plan.planId, plan.planSha256);
    const final = await runFlightStep(root, { ...started.flight, worktree: started.story.worktree });
    assert.equal(final.status, 'completed');
    assert.equal(final.stopReason, 'requested-boundary-reached');
    assert.equal(final.position, boundary);
    assert.deepEqual(final.operations.map((entry) => entry.operation),
      boundary === 'published' ? ['author', 'publish'] : ['author', 'publish', 'submit']);
  });
}

for (const request of ['pause', 'halt']) {
  test(`${request} cancels an active model process and waits for execution quiescence`, async () => {
    const root = await executableRepository({ authorDelayMs: 10_000 });
    const workId = `AUT-${request.toUpperCase()}-1`;
    const plan = await createAutoPlan(root, 'Change the exported application value from one to two.', {
      ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
      suggestedUntil: 'phase-complete:implement'
    }, { workId, workType: 'quick-fix', fromBranch: 'main' });
    const started = await startAutoFlight(root, plan.planId, plan.planSha256);
    const execution = runFlightStep(root, { ...started.flight, worktree: started.story.worktree });
    let active;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      active = await readAutoFlightState(root, started.flight.flightId);
      if (active.counters.modelInvocations === 1) break;
      await delay(20);
    }
    assert.equal(active.counters.modelInvocations, 1, 'model process never became active');
    if (request === 'pause') {
      await assert.rejects(
        () => runFlightStep(root, { ...started.flight, worktree: started.story.worktree }),
        /auto-flight-step.*locked|locked by/i,
        'a second executor must not pass the complete-step lease'
      );
    }
    const stopped = request === 'pause'
      ? await pauseAutoFlight(root, started.flight.flightId)
      : await haltAutoFlight(root, started.flight.flightId);
    const final = await execution;
    assert.equal(final.status, request === 'pause' ? 'paused' : 'halted');
    assert.equal(stopped.status, final.status);
    assert.equal(final.position, 'story-created');
    assert.equal(final.commits?.generation, undefined, 'stop request must prevent publication');
    assert.ok(final.counters.activeMilliseconds > 0,
      'cancelled execution time remains charged to the cumulative flight budget');
    assert.equal(stopped.counters.activeMilliseconds, final.counters.activeMilliseconds,
      'the stop command waits until the executor has durably accounted its active time');
  });
}

test('a stop observed while its flight-state lock is still held remains recoverable', async () => {
  const root = await executableRepository({ authorDelayMs: 10_000 });
  const workId = 'AUT-STOP-RACE-1';
  const plan = await createAutoPlan(root, 'Change the exported application value from one to two.', {
    ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId, workType: 'quick-fix', fromBranch: 'main' });
  const started = await startAutoFlight(root, plan.planId, plan.planSha256);
  const execution = runFlightStep(root, { ...started.flight, worktree: started.story.worktree });
  let active;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    active = await readAutoFlightState(root, started.flight.flightId);
    if (active.counters.modelInvocations === 1) break;
    await delay(20);
  }
  assert.equal(active.counters.modelInvocations, 1, 'model process never became active');

  await withRetriedSubjectLock(root, { kind: 'auto-flight', id: started.flight.flightId }, async () => {
    await mutateAutoFlightState(root, started.flight.flightId, (draft) => {
      draft.status = 'paused'; draft.stopReason = 'human-paused';
      draft.stopRequested = { kind: 'pause', requestedAt: new Date().toISOString() };
      draft.nextAction = 'Resume with the exact checkpoint hash when ready.';
    });
    // Keep the mutation lease beyond the cancellation monitor interval. The executor must retry
    // its terminal accounting instead of converting this expected overlap into a lock failure.
    await delay(300);
  });

  const final = await execution;
  assert.equal(final.status, 'paused');
  assert.equal(final.stopReason, 'human-paused');
  assert.ok(final.counters.activeMilliseconds > 0);
});

for (const request of ['pause', 'halt']) {
  for (const window of ['prepare', 'model-start', 'model-execution', 'model-complete']) {
    test(`${request} during ${window} quiesces without a stale Auto checkpoint or governed commit`, async () => {
      const root = await executableRepository();
      const workId = `AUT-${request.toUpperCase()}-${window.toUpperCase()}-RACE`;
      const plan = await createAutoPlan(root, 'Change the exported application value from one to two.', {
        ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
        suggestedUntil: 'phase-complete:implement'
      }, { workId, workType: 'quick-fix', fromBranch: 'main' });
      const started = await startAutoFlight(root, plan.planId, plan.planSha256);
      const entered = deferred();
      const release = deferred();
      let modelCalls = 0;
      const invocation = () => ({
        invocationId: `INV-${request}-${window}`,
        usage: { totalTokens: 1 },
        stdout: '', stderr: ''
      });
      const runtime = window === 'prepare'
        ? {
            childLifecycle: async (_worktree, args) => {
              assert.equal(args[0], 'prepare');
              entered.resolve();
              await release.promise;
              return { status: 0, stdout: '', stderr: '', signal: null };
            }
          }
        : window === 'model-start'
          ? {
              boundary: async (name) => {
                if (name !== 'model-start') return;
                entered.resolve();
                await release.promise;
              },
              invokeModel: async () => { modelCalls += 1; return invocation(); }
            }
          : window === 'model-execution'
            ? {
                invokeModel: async () => {
                  modelCalls += 1;
                  entered.resolve();
                  await release.promise;
                  return invocation();
                }
              }
            : {
                invokeModel: async () => { modelCalls += 1; return invocation(); },
                boundary: async (name) => {
                  if (name !== 'model-complete') return;
                  entered.resolve();
                  await release.promise;
                }
              };
      const storyHead = run('git', ['rev-parse', 'HEAD'], started.story.worktree).stdout.trim();
      const execution = runFlightStep(root, { ...started.flight, worktree: started.story.worktree }, runtime);
      await entered.promise;
      await delay(5);
      const stopping = request === 'pause'
        ? pauseAutoFlight(root, started.flight.flightId)
        : haltAutoFlight(root, started.flight.flightId);
      await waitForFlight(
        root,
        started.flight.flightId,
        (state) => state.status === (request === 'pause' ? 'paused' : 'halted'),
        `${request} did not become durable during ${window}`
      );
      release.resolve();
      const [final, stopped] = await Promise.all([execution, stopping]);

      assert.equal(final.status, request === 'pause' ? 'paused' : 'halted');
      assert.equal(stopped.status, final.status);
      assert.equal(final.stopRequested.kind, request);
      assert.equal(final.position, 'story-created');
      assert.equal(final.commits?.generation, undefined);
      assert.equal(final.commits?.submission, undefined);
      assert.equal(run('git', ['rev-parse', 'HEAD'], started.story.worktree).stdout.trim(), storyHead);
      assert.ok(final.counters.activeMilliseconds > 0, 'active execution time was not charged');
      if (window === 'model-start') assert.equal(modelCalls, 0, 'model started after a durable stop');
      if (['model-execution', 'model-complete'].includes(window)) assert.equal(modelCalls, 1);

      const quiescent = await readAutoFlightState(root, started.flight.flightId);
      await delay(50);
      const stable = await readAutoFlightState(root, started.flight.flightId);
      assert.deepEqual({
        status: stable.status,
        checkpointSha256: stable.checkpointSha256,
        recordSha256: stable.recordSha256,
        activeMilliseconds: stable.counters.activeMilliseconds
      }, {
        status: quiescent.status,
        checkpointSha256: quiescent.checkpointSha256,
        recordSha256: quiescent.recordSha256,
        activeMilliseconds: quiescent.counters.activeMilliseconds
      }, 'executor wrote stale state after the stop command observed quiescence');
    });
  }
}

test('executor state CAS converts 128 portable pause/halt lock races into a durable stop', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Exercise the Auto state lock.', proposal, {
    workId: 'AUT-LOCK-STRESS', workType: 'feature', fromBranch: 'main'
  });
  const started = await startAutoFlight(root, plan.planId, plan.planSha256);
  const id = started.flight.flightId;

  for (let index = 0; index < 128; index += 1) {
    const kind = index % 2 === 0 ? 'pause' : 'halt';
    const reset = await mutateAutoFlightState(root, id, (draft) => {
      draft.status = 'running';
      draft.stopRequested = null;
      draft.stopReason = 'stress-reset';
      draft.position = 'story-created';
    });
    const acquired = deferred();
    const writer = withRetriedSubjectLock(root, { kind: 'auto-flight', id }, async () => {
      acquired.resolve();
      await delay(index % 3);
      await mutateAutoFlightState(root, id, (draft) => {
        draft.status = kind === 'pause' ? 'paused' : 'halted';
        draft.stopReason = `human-${kind}`;
        draft.stopRequested = { kind, requestedAt: new Date().toISOString() };
      });
      await delay(2);
    });
    await acquired.promise;
    const executor = withSubjectLock(root, { kind: 'auto-flight-step', id }, () =>
      mutateAutoExecutorState(root, id, (draft) => {
        draft.position = 'authored';
      }, { expectedCheckpoint: reset.checkpointSha256 }));
    const [executorResult, writerResult] = await Promise.allSettled([executor, writer]);
    assert.equal(writerResult.status, 'fulfilled');
    assert.equal(executorResult.status, 'rejected');
    assert.equal(executorResult.reason.code, 'AUTO_STOP_REQUESTED');
    const final = await readAutoFlightState(root, id);
    assert.equal(final.status, kind === 'pause' ? 'paused' : 'halted');
    assert.equal(final.stopRequested.kind, kind);
    assert.equal(final.position, 'story-created', `iteration ${index} accepted a stale executor write`);
  }
});
