import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';

import { createAutoPlan, ratifyAutoPlan, readAutoPlan } from '../src/auto/auto-plan.mjs';
import { buildAutoPlanPacket } from '../src/auto/auto-plan-packet.mjs';
import { rebuildAutoFlightState } from '../src/auto/auto-checkpoint.mjs';
import {
  readAutoCandidateBinding, readAutoCandidateVerification
} from '../src/auto/auto-candidate.mjs';
import { startAutoFlight } from '../src/auto/auto-flight.mjs';
import { executeAutoFlightStep, mutateAutoExecutorState } from '../src/auto/auto-executor.mjs';
import { authorizeAutoRepair, planAutoRepair } from '../src/auto/auto-p1-control.mjs';
import {
  authorizeAutoAuthoringAttempt, discardAutoFlight, haltAutoFlight, mutateAutoFlightState, pauseAutoFlight,
  readAutoFlightReport, readAutoFlightState, resumeAutoFlight
} from '../src/auto/auto-flight-store.mjs';
import { loadDefinition } from '../src/config.mjs';
import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';
import { autoFlightRead } from '../src/gateway/planners/auto-flight.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { recordSha256 } from '../src/records.mjs';
import { withSubjectLock } from '../src/subject-lock.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function confirmation(plan) { return buildAutoPlanPacket(plan).packetSha256; }

function run(command, args, cwd, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Auto Tester', ...env
    }
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
    type: 'copilot-cli', executable: process.execPath, promptTransport: 'acp-stdio', arguments: []
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

async function publishedStartRepository() {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.git.publish = 'required';
  await writeFile(workflowPath, YAML.stringify(workflow));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'require Story publication for Auto start crash tests'], root);
  run('git', ['push', 'origin', 'main'], root);
  return root;
}

function crashAutoStart(root, plan, boundary, exitCode) {
  const moduleUrl = new URL('../src/auto/auto-flight.mjs', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', [
    `import { startAutoFlight } from ${JSON.stringify(moduleUrl)};`,
    `await startAutoFlight(${JSON.stringify(root)}, ${JSON.stringify(plan.planId)}, `
      + `${JSON.stringify(confirmation(plan))}, {`,
    `  ${JSON.stringify(boundary)}: async () => process.exit(${exitCode})`,
    `});`
  ].join('\n')], {
    cwd: root, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Auto Tester'
    }
  });
}

async function executableRepository({ authorDelayMs = 0 } = {}) {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  const fakeAcp = path.join(root, 'fake-auto-acp.mjs');
  await writeFile(fakeAcp, `
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let cwd = null; let promptId = null; let sessionId = null; let pending = 0;
let targets = [];
function request(index) {
  const target = targets[index]; const absolute = path.join(cwd, target.path);
  const toolCall = { toolCallId: 'auto-edit-' + index, title: 'edit ' + target.path,
    name: target.name, kind: 'edit', status: 'in_progress',
    rawInput: { path: absolute }, locations: [{ path: absolute }] };
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
    update: { sessionUpdate: 'tool_call', ...toolCall } } });
  send({ jsonrpc: '2.0', id: 900 + index, method: 'session/request_permission', params: {
    sessionId, toolCall, options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject once', kind: 'reject_once' }
    ] } });
}
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: message.params.protocolVersion, agentCapabilities: {},
    agentInfo: { name: 'fake-auto-acp', version: '1' } } });
  else if (message.method === 'session/new') { cwd = message.params.cwd; sessionId = 'auto-fixture';
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } }); }
  else if (message.method === 'session/prompt') {
    promptId = message.id; pending = 0;
    const current = await readFile(path.join(cwd, 'app.mjs'), 'utf8').catch(() => '');
    const value = /value\\s*=\\s*2/.test(current) ? 3 : 2;
    targets = [
      { name: 'edit', path: 'app.mjs', text: 'export const value = ' + value + ';\\n' },
      { name: 'edit', path: 'test/app.test.mjs', text: "import assert from 'node:assert/strict';\\nimport { value } from '../app.mjs';\\nassert.equal(value, " + value + ");\\n" }
    ];
    request(0);
  }
  else if (message.id === 900 + pending) {
    const target = targets[pending]; const absolute = path.join(cwd, target.path);
    ${authorDelayMs > 0 ? `await new Promise((resolve) => setTimeout(resolve, ${authorDelayMs}));` : ''}
    await mkdir(path.dirname(absolute), { recursive: true }); await writeFile(absolute, target.text);
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'auto-edit-' + pending,
        name: 'edit', kind: 'edit', status: 'completed', rawInput: { path: absolute },
        locations: [{ path: absolute }], rawOutput: { bytes: Buffer.byteLength(target.text) } } } });
    pending += 1;
    if (pending < targets.length) request(pending);
    else { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'authored' } } } });
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn',
        usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4 } } }); }
  }
}
`);
  workflow.models.providers['copilot-cli'] = {
    type: 'copilot-cli', executable: process.execPath,
    promptTransport: 'acp-stdio', arguments: [fakeAcp]
  };
  workflow.auto.ceilings = { tokenBudget: { maximum: 30000, assurance: 'best-available' } };
  workflow.workTypes['quick-fix'].auto = {
    eligibility: 'bounded', allowedPaces: ['phase'], defaultUntil: 'phase-complete:implement'
  };
  workflow.workTypes['quick-fix'].intelligence = { worldModel: 'off', ast: 'off', agentBriefs: 'off' };
  await writeFile(workflowPath, YAML.stringify(workflow));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: { test: 'node --test test/app.test.mjs' }
  }, null, 2));
  run('git', ['add', 'singularity/workflow.yml', 'fake-auto-acp.mjs', 'package.json'], root);
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

function lifecycleWithSubmitFailures(count) {
  let remaining = count;
  return async (cwd, args, options = {}) => {
    if (args[0] === 'submit' && remaining > 0) {
      remaining -= 1;
      const error = new Error('Injected deterministic submission refusal.');
      error.code = 'AUTO_TEST_SUBMISSION_REFUSAL';
      throw error;
    }
    const result = run(process.execPath, [cli, ...args], cwd, {
      env: options.env ?? {}
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, signal: null };
  };
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
  const gateway = await autoFlightRead({
    operation: { id: 'auto.show-plan' }, arguments: { planId: plan.planId }, root
  });
  const card = gateway.data.auto.cards[0];
  assert.equal(gateway.effects.stateChanged, false);
  assert.equal(card.planSha256, plan.planSha256);
  assert.deepEqual(card.phaseRail, plan.story.phaseRail);
  assert.deepEqual(card.scope, {
    status: plan.scope.status,
    predictedRead: plan.proposal.predictedPaths,
    predictedWrite: plan.proposal.predictedPaths,
    protected: plan.scope.protectedPaths,
    forbidden: ['governance-policy', 'approval', 'waiver', 'unplanned-external-effect']
  });
  assert.deepEqual(card.evidenceReadiness, {
    status: plan.executionHost.verification.status,
    commandIds: plan.executionHost.verification.commandIds,
    acceptanceCriteria: plan.proposal.acceptanceCriteria
  });
  assert.deepEqual(card.ceilings, plan.execution.ceilings);
  assert.deepEqual(card.humanStops, plan.humanBoundaries.stopPoints);
  assert.deepEqual(card.capability, plan.capability);
  assert.deepEqual(card.repositories, plan.repositories);
  await assert.rejects(() => ratifyAutoPlan(root, plan.planId, `sha256:${'0'.repeat(64)}`), (error) => error.code === 'AUTO_PLAN_CONFIRMATION_REQUIRED');
  assert.deepEqual({ refs: refs(root), worktrees: worktrees(root), status: run('git', ['status', '--porcelain'], root).stdout }, before);
});

test('Auto start reuses the governed Story transaction in a managed worktree and stops at the human boundary', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Change the exported application value.', proposal, {
    workId: 'AUT-START-1', workType: 'feature', fromBranch: 'main'
  });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
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
  assert.equal(ratification.confirmationProtocol, 'packet-v1');
  assert.equal(ratification.confirmedSha256, confirmation(plan));
  assert.equal(ratification.packetSha256, confirmation(plan));
  assert.equal(ratification.authorizationSha256.startsWith('sha256:'), true);
  const localAuthorization = JSON.parse(await readFile(path.join(
    root, '.git/singularity-flow/auto-authorizations', `${plan.planId}.json`
  ), 'utf8'));
  assert.equal(localAuthorization.authorizationSha256, ratification.authorizationSha256);
  assert.notEqual(localAuthorization.recordSha256, ratification.recordSha256);
  assert.equal((await readAutoFlightState(root, started.flight.flightId)).recordSha256, started.flight.recordSha256);
  await assert.rejects(() => startAutoFlight(root, plan.planId, confirmation(plan)), (error) => error.code === 'AUTO_AUTHORIZATION_CONSUMED');
});

test('resume trusts the governed accepted Plan rather than reapplying mutable start-time remote checks', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Keep a started flight valid when main advances.', {
    ...proposal, unresolvedDecisions: ['Pause before authoring.']
  }, { workId: 'AUT-ACTIVE-BINDING', workType: 'feature', fromBranch: 'main' });
  const { flight } = await startAutoFlight(root, plan.planId, confirmation(plan));
  await writeFile(path.join(root, 'main-advanced.txt'), 'advanced after Story start\n');
  run('git', ['add', 'main-advanced.txt'], root);
  run('git', ['commit', '-m', 'advance main after Auto start'], root);
  run('git', ['push', 'origin', 'main'], root);
  const resumed = await resumeAutoFlight(root, flight.flightId, flight.checkpointSha256);
  assert.equal(resumed.status, 'running');
});

test('resume refuses a managed worktree whose configured repository authority changed', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Keep the accepted repository authority exact.', {
    ...proposal, unresolvedDecisions: ['Pause before authoring.']
  }, { workId: 'AUT-REMOTE-BINDING', workType: 'feature', fromBranch: 'main' });
  const { flight, story } = await startAutoFlight(root, plan.planId, confirmation(plan));
  const other = `${root}-other.git`;
  run('git', ['init', '--bare', '-b', 'main', other], root);
  run('git', ['remote', 'set-url', 'origin', other], story.worktree);
  await assert.rejects(
    () => resumeAutoFlight(root, flight.flightId, flight.checkpointSha256),
    (error) => error.code === 'AUTO_FLIGHT_BINDING_MISMATCH'
  );
  await rm(other, { recursive: true, force: true });
});

test('resume refuses a tampered governed accepted Plan before model execution', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Bind resume to the accepted governed Plan.', {
    ...proposal, unresolvedDecisions: ['Pause before authoring.']
  }, { workId: 'AUT-TAMPERED-BINDING', workType: 'feature', fromBranch: 'main' });
  const { flight } = await startAutoFlight(root, plan.planId, confirmation(plan));
  const acceptedPath = path.join(
    flight.worktree, 'singularity/work-items/AUT-TAMPERED-BINDING/context/auto/accepted-plan.json'
  );
  const accepted = JSON.parse(await readFile(acceptedPath, 'utf8'));
  accepted.proposal.title = 'Tampered after ratification';
  await writeFile(acceptedPath, JSON.stringify(accepted));
  await assert.rejects(
    () => resumeAutoFlight(root, flight.flightId, flight.checkpointSha256),
    (error) => error.code === 'AUTO_FLIGHT_BINDING_MISMATCH'
  );
  assert.equal((await readAutoFlightState(root, flight.flightId)).status, 'waiting-human');
});

test('resume refuses a self-consistent ratification whose authorization identity was altered', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Bind resume to the exact ratifying identity.', {
    ...proposal, unresolvedDecisions: ['Pause before authoring.']
  }, { workId: 'AUT-TAMPERED-RATIFICATION', workType: 'feature', fromBranch: 'main' });
  const { flight } = await startAutoFlight(root, plan.planId, confirmation(plan));
  const ratificationPath = path.join(
    flight.worktree,
    'singularity/work-items/AUT-TAMPERED-RATIFICATION/context/auto/ratification.json'
  );
  const ratification = JSON.parse(await readFile(ratificationPath, 'utf8'));
  ratification.actor.name = 'Altered Reviewer';
  delete ratification.recordSha256;
  ratification.recordSha256 = recordSha256(ratification);
  await writeFile(ratificationPath, JSON.stringify(ratification));
  await assert.rejects(
    () => resumeAutoFlight(root, flight.flightId, flight.checkpointSha256),
    (error) => error.code === 'AUTO_FLIGHT_BINDING_MISMATCH'
  );
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
    `const { plan, authorization } = await ratifyAutoPlan(root, ${JSON.stringify(plan.planId)}, ${JSON.stringify(confirmation(plan))});`,
    `await claimAutoAuthorization(root, plan, authorization, ${JSON.stringify(abandonedFlightId)});`
  ].join('\n')], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);

  const recovered = await startAutoFlight(root, plan.planId, confirmation(plan));
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
    `const { plan, authorization } = await ratifyAutoPlan(root, ${JSON.stringify(plan.planId)}, ${JSON.stringify(confirmation(plan))});`,
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

  const recovered = await startAutoFlight(root, plan.planId, confirmation(plan));
  assert.equal(recovered.flight.flightId, abandonedFlightId);
  assert.equal(recovered.story.idempotent, true);
  const workflow = JSON.parse(await readFile(path.join(
    recovered.story.worktree, 'singularity/work-items/AUT-STORY-RECOVERY/workflow.json'
  ), 'utf8'));
  assert.equal(workflow.executionOrigin.flightId, abandonedFlightId);
});

for (const [boundary, exitCode] of [
  ['afterWorktreeCreated', 71],
  ['afterStoryStarted', 72],
  ['beforeStartReceipt', 73]
]) {
  test(`hard crash ${boundary} reconstructs the same exact Auto flight`, async (t) => {
    const root = await publishedStartRepository();
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
    const workId = `AUT-START-CRASH-${exitCode}`;
    const plan = await createAutoPlan(root, `Recover exact Auto start boundary ${boundary}.`, proposal, {
      workId, workType: 'feature', fromBranch: 'main'
    });
    const crashed = crashAutoStart(root, plan, boundary, exitCode);
    assert.equal(crashed.status, exitCode, crashed.stderr || crashed.stdout);
    const authorizationPath = path.join(
      root, '.git/singularity-flow/auto-authorizations', `${plan.planId}.json`
    );
    const claimed = JSON.parse(await readFile(authorizationPath, 'utf8'));
    assert.match(claimed.flightId, /^AFL-[A-F0-9]{26}$/);
    assert.equal(claimed.consumedAt, null);

    const recovered = await startAutoFlight(root, plan.planId, confirmation(plan));
    assert.equal(recovered.flight.flightId, claimed.flightId,
      'recovery must retain the flight identity claimed before the first Git effect');
    assert.equal(recovered.story.workId, workId);
    assert.equal(recovered.flight.story.workId, workId);
    const workflow = JSON.parse(await readFile(path.join(
      recovered.story.worktree, 'singularity/work-items', workId, 'workflow.json'
    ), 'utf8'));
    assert.deepEqual(workflow.executionOrigin, {
      schemaVersion: 1, mode: 'auto', flightId: claimed.flightId,
      planId: plan.planId, planSha256: plan.planSha256
    });
    const receipt = JSON.parse(await readFile(path.join(
      root, '.git/singularity-flow/change-flight-plans/starts',
      `${plan.bindings.flightPlanId}.json`
    ), 'utf8'));
    assert.equal(receipt.workId, workId);
    assert.equal(receipt.worktree, recovered.story.worktree);
    assert.equal(receipt.branch, workId);
    const consumed = JSON.parse(await readFile(authorizationPath, 'utf8'));
    assert.equal(consumed.flightId, claimed.flightId);
    assert.match(consumed.consumedAt, /^\d{4}-\d{2}-\d{2}T/);
    const remoteHead = run('git', [
      'ls-remote', '--heads', 'origin', `refs/heads/${workId}`
    ], root).stdout.trim().split(/\s+/u)[0];
    assert.equal(remoteHead, run('git', ['rev-parse', 'HEAD'], recovered.story.worktree).stdout.trim());
  });
}

test('Auto start recovery refuses a coincidentally named ungoverned branch', async (t) => {
  const root = await publishedStartRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
  const workId = 'AUT-START-FOREIGN';
  const plan = await createAutoPlan(root, 'Do not adopt an arbitrary branch during recovery.', proposal, {
    workId, workType: 'feature', fromBranch: 'main'
  });
  const crashed = crashAutoStart(root, plan, 'afterWorktreeCreated', 74);
  assert.equal(crashed.status, 74, crashed.stderr || crashed.stdout);
  const authorizationPath = path.join(
    root, '.git/singularity-flow/auto-authorizations', `${plan.planId}.json`
  );
  const claimed = JSON.parse(await readFile(authorizationPath, 'utf8'));
  const worktree = path.join(
    root, '.git/singularity-flow/auto-worktrees', claimed.flightId, plan.repositories[0].id
  );
  run('git', ['switch', '-c', workId], worktree);

  await assert.rejects(
    () => startAutoFlight(root, plan.planId, confirmation(plan)),
    (error) => error.code === 'CFP_RECOVERY_REQUIRED'
  );
  const retained = JSON.parse(await readFile(authorizationPath, 'utf8'));
  assert.equal(retained.flightId, claimed.flightId,
    'a refused recovery must not release the exact claimed flight identity');
  assert.equal(retained.consumedAt, null);
  await assert.rejects(() => readAutoFlightState(root, claimed.flightId),
    (error) => error.code === 'AUTO_FLIGHT_NOT_FOUND');
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
    () => startAutoFlight(root, blockedPlan.planId, confirmation(blockedPlan)),
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
    startAutoFlight(root, first.planId, confirmation(first)),
    startAutoFlight(root, second.planId, confirmation(second))
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('discard removes only an unpublished managed worktree and local Story branch', async () => {
  const root = await repository();
  const plan = await createAutoPlan(root, 'Discard unpublished isolated work safely.', proposal, {
    workId: 'AUT-DISCARD-1', workType: 'feature', fromBranch: 'main'
  });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
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
  const { flight } = await startAutoFlight(root, plan.planId, confirmation(plan));
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
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
  assert.equal(started.flight.status, 'running');
  const final = await runFlightStep(root, { ...started.flight, worktree: started.story.worktree });
  if (final.status === 'halted') assert.fail(`${final.stopReason}: ${final.lastError?.message ?? final.nextAction}`);
  assert.equal(final.counters.authoringAttempts.implement, 1);
  assert.equal(final.counters.modelInvocations, 1);
  assert.notEqual(final.status, 'running');
  assert.notEqual(final.stopReason, 'authoring-failed');
  const source = await readFile(path.join(started.story.worktree, 'app.mjs'), 'utf8');
  assert.match(source, /value = 2/);
  assert.equal(final.position, 'submitted', `${final.status}/${final.stopReason}: ${final.lastError?.message ?? final.nextAction}`);
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
  assert.deepEqual(report.operations.map((entry) => entry.operation), [
    'author', 'candidate-freeze', 'candidate-verify', 'publish', 'submit'
  ]);
  assert.equal(report.evidence.changeSetDigest, deliveryReceipt.changeSet.digest);
  assert.equal(report.evidence.reviewPacketSha256, completedWorkflow.lineage.submissions.at(-1).packetSha256);
  assert.equal(report.lastSuccessfulStoryRevision, final.commits.submission);
});

test('a model failure after writing seals a remotely reachable Candidate before refusal', async (t) => {
  const root = await executableRepository();
  const plan = await createAutoPlan(root, 'Preserve any partial model write before refusing.', {
    ...proposal,
    workType: 'quick-fix', predictedPaths: ['app.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId: 'AUT-PARTIAL-CANDIDATE', workType: 'quick-fix', fromBranch: 'main' });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
  const failed = await runFlightStep(root, started.flight, {
    invokeModel: async ({ cwd }) => {
      await writeFile(path.join(cwd, 'app.mjs'), 'export const value = 2;\n');
      const error = new Error('Injected provider failure after one approved write.');
      error.code = 'MODEL_PROVIDER_FAILED';
      throw error;
    }
  });
  assert.equal(failed.status, 'waiting-human');
  assert.equal(failed.stopReason, 'repair-review-required');
  assert.ok(failed.candidate?.candidateId);
  assert.match(await readFile(path.join(failed.worktree, 'app.mjs'), 'utf8'), /value = 2/);
  const candidate = await readAutoCandidateBinding(failed.worktree, {
    flightId: failed.flightId, candidateId: failed.candidate.candidateId
  });
  const published = run('git', [
    'ls-remote', 'origin', candidate.repository.retainedRef
  ], failed.worktree).stdout.trim();
  assert.match(published, new RegExp(`^${candidate.repository.candidateCommit}\\s`));
  const checkpoint = JSON.parse(await readFile(path.join(
    failed.worktree, failed.boundaryCheckpoint.path
  ), 'utf8'));
  assert.equal(checkpoint.candidateBinding.bindingSha256, candidate.bindingSha256);
  assert.equal(checkpoint.candidate.candidateSha256, candidate.candidateSha256);
  assert.equal(checkpoint.lineage['auto-refusal'].at(-1).subject.candidateSha256,
    candidate.candidateSha256);

  run('git', ['push', 'origin', failed.story.branch], failed.worktree);
  const recoveryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-partial-recovery-'));
  t.after(() => rm(recoveryRoot, { recursive: true, force: true }));
  const remote = run('git', ['remote', 'get-url', 'origin'], root).stdout.trim();
  run('git', ['clone', '--branch', 'main', '--', remote, recoveryRoot], root);
  run('git', ['config', 'user.name', 'Auto Recovery Tester'], recoveryRoot);
  run('git', ['config', 'user.email', 'auto-recovery@example.com'], recoveryRoot);
  const rebuilt = await rebuildAutoFlightState(recoveryRoot, {
    storyRoot: recoveryRoot,
    workId: failed.story.workId,
    flightId: failed.flightId
  });
  assert.equal(rebuilt.status, 'waiting-human');
  assert.equal(rebuilt.candidate.bindingSha256, candidate.bindingSha256);
  assert.match(await readFile(path.join(rebuilt.worktree, 'app.mjs'), 'utf8'), /value = 2/);
});

test('failed Candidate verification is bound into flight, refusal, and governed checkpoint', async () => {
  const root = await executableRepository();
  const plan = await createAutoPlan(root, 'Retain the exact failed verification authority.', {
    ...proposal,
    workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId: 'AUT-VERIFY-REFUSAL', workType: 'quick-fix', fromBranch: 'main' });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
  const failed = await runFlightStep(root, started.flight, {
    invokeModel: async ({ cwd }) => {
      await writeFile(path.join(cwd, 'app.mjs'), 'export const value = 2;\n');
      await mkdir(path.join(cwd, 'test'), { recursive: true });
      await writeFile(path.join(cwd, 'test/app.test.mjs'), [
        "import assert from 'node:assert/strict';",
        "import { value } from '../app.mjs';",
        'assert.equal(value, 99);', ''
      ].join('\n'));
      return {
        invocationId: 'INV-AUTO-VERIFY-FAILURE',
        usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4 }
      };
    }
  });
  assert.equal(failed.status, 'waiting-human');
  assert.equal(failed.stopReason, 'repair-review-required');
  assert.match(failed.candidate?.verificationReceiptSha256 ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(failed.evidence.candidateVerificationSha256,
    failed.candidate.verificationReceiptSha256);
  const receipt = await readAutoCandidateVerification(failed.worktree, {
    flightId: failed.flightId,
    candidateId: failed.candidate.candidateId,
    verificationReceiptSha256: failed.candidate.verificationReceiptSha256
  });
  assert.equal(receipt.status, 'failed');
  const checkpoint = JSON.parse(await readFile(path.join(
    failed.worktree, failed.boundaryCheckpoint.path
  ), 'utf8'));
  assert.equal(checkpoint.candidateVerification.verificationReceiptSha256,
    receipt.verificationReceiptSha256);
  const refusal = checkpoint.lineage['auto-refusal'].at(-1);
  assert.equal(refusal.subject.verificationReceiptSha256, receipt.verificationReceiptSha256);
  assert.equal(refusal.preserved.verificationReceiptSha256, receipt.verificationReceiptSha256);
});

test('one confirmed repair opens a new generation and succeeds without reusing consumed intent', async () => {
  const root = await executableRepository();
  const plan = await createAutoPlan(root, 'Change the value and repair one refused submission.', {
    ...proposal,
    workType: 'quick-fix',
    predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'submitted:implement'
  }, {
    workId: 'AUT-REPAIR-SUCCEEDS', workType: 'quick-fix', fromBranch: 'main',
    until: 'submitted:implement'
  });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
  const lifecycle = lifecycleWithSubmitFailures(1);
  const refused = await runFlightStep(root, started.flight, { childLifecycle: lifecycle });
  assert.equal(refused.status, 'waiting-human');
  assert.equal(refused.stopReason, 'repair-review-required');
  assert.ok(refused.activeRefusalId);
  assert.equal(refused.counters.modelInvocations, 1);

  const proposed = await planAutoRepair(root, refused.flightId, refused.activeRefusalId);
  const authorized = await authorizeAutoRepair(
    root, refused.flightId, proposed.repairPlan.repairPlanId,
    proposed.repairPlan.repairPlanSha256
  );
  const repaired = await runFlightStep(root, authorized.flight, { childLifecycle: lifecycle });
  assert.equal(repaired.status, 'completed',
    `${repaired.status}/${repaired.stopReason}: ${repaired.lastError?.message ?? repaired.nextAction}`);
  assert.equal(repaired.position, 'submitted');
  assert.equal(repaired.counters.authoringAttempts.implement, 2);
  assert.equal(repaired.counters.modelInvocations, 2);
  assert.match(await readFile(path.join(repaired.worktree, 'app.mjs'), 'utf8'), /value = 3/);
  const workflow = JSON.parse(await readFile(path.join(
    repaired.worktree, 'singularity/work-items/AUT-REPAIR-SUCCEEDS/workflow.json'
  ), 'utf8'));
  assert.equal(workflow.phases.implement.generation, 2);
  assert.equal(workflow.phases.implement.generationIntent.status, 'consumed');
  const attempts = Object.values(repaired.phaseContracts);
  assert.equal(attempts.some((contract) => contract.generation === 1), true);
  assert.equal(attempts.some((contract) => contract.generation === 2), true);
});

test('a failed confirmed repair halts permanently and cannot consume a third model invocation', async () => {
  const root = await executableRepository();
  const plan = await createAutoPlan(root, 'Refuse both the first delivery and its only repair.', {
    ...proposal,
    workType: 'quick-fix',
    predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'submitted:implement'
  }, {
    workId: 'AUT-REPAIR-HALTS', workType: 'quick-fix', fromBranch: 'main',
    until: 'submitted:implement'
  });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
  const lifecycle = lifecycleWithSubmitFailures(2);
  const refused = await runFlightStep(root, started.flight, { childLifecycle: lifecycle });
  const proposed = await planAutoRepair(root, refused.flightId, refused.activeRefusalId);
  const authorized = await authorizeAutoRepair(
    root, refused.flightId, proposed.repairPlan.repairPlanId,
    proposed.repairPlan.repairPlanSha256
  );
  const halted = await runFlightStep(root, authorized.flight, { childLifecycle: lifecycle });
  assert.equal(halted.status, 'halted');
  assert.equal(halted.stopReason, 'repair-attempt-exhausted');
  assert.equal(halted.counters.modelInvocations, 2);
  assert.equal(halted.counters.authoringAttempts.implement, 2);
  await assert.rejects(
    () => runFlightStep(root, halted, { childLifecycle: lifecycle }),
    (error) => error.code === 'AUTO_FLIGHT_NOT_RUNNING'
  );
  assert.equal((await readAutoFlightState(root, halted.flightId)).counters.modelInvocations, 2);
});

test('phase pacing accepts only one governed transition and external approval resumes completion', async () => {
  const root = await executableRepository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const configured = YAML.parse(await readFile(workflowPath, 'utf8'));
  configured.approvalAuthorities['quality-reviewers'].members = [{
    name: 'Auto Tester', email: 'auto.tester@example.com'
  }];
  await writeFile(workflowPath, YAML.stringify(configured));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'authorize deterministic verification reviewer'], root);
  run('git', ['push', 'origin', 'main'], root);
  const workId = 'AUT-PHASE-ROLLOVER';
  const plan = await createAutoPlan(root, 'Complete the reviewed quick-fix rail.', {
    ...proposal,
    workType: 'quick-fix',
    predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'story-complete'
  }, {
    workId, workType: 'quick-fix', fromBranch: 'main', until: 'story-complete', pace: 'phase'
  });
  assert.equal(plan.safety.startable, true, plan.safety.reasons.join('; '));
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
  const phaseBoundary = await runFlightStep(root, started.flight);
  assert.equal(phaseBoundary.status, 'paused');
  assert.equal(phaseBoundary.story.phase, 'verify');
  assert.equal(phaseBoundary.stopReason, 'phase-boundary-reached');
  assert.equal(phaseBoundary.counters.phasesCompleted, 1);
  assert.equal(phaseBoundary.counters.modelInvocations, 1);
  let running = await resumeAutoFlight(root, phaseBoundary.flightId, phaseBoundary.checkpointSha256);
  const waiting = await runFlightStep(root, running);
  assert.equal(waiting.status, 'waiting-human',
    `${waiting.status}/${waiting.stopReason}: ${waiting.lastError?.message ?? waiting.nextAction}`);
  assert.equal(waiting.position, 'submitted',
    `${waiting.status}/${waiting.stopReason}: ${waiting.lastError?.message ?? waiting.nextAction}`);
  assert.equal(waiting.story.phase, 'verify');

  const workflowFile = path.join(
    waiting.worktree, 'singularity/work-items/AUT-PHASE-ROLLOVER/workflow.json'
  );
  const committedBytes = await readFile(workflowFile, 'utf8');
  const uncommittedAdvance = JSON.parse(committedBytes);
  uncommittedAdvance.phases.verify.status = 'approved';
  uncommittedAdvance.currentPhase = null;
  uncommittedAdvance.status = 'complete';
  await writeFile(workflowFile, JSON.stringify(uncommittedAdvance));
  await assert.rejects(
    () => resumeAutoFlight(root, waiting.flightId, waiting.checkpointSha256),
    (error) => error.code === 'AUTO_CHECKPOINT_STALE',
    'mutable workflow bytes at the same HEAD must not authorize a phase advance'
  );
  await writeFile(workflowFile, committedBytes);

  run(process.execPath, [
    cli, 'approve', 'verify', '--work-id', workId, '--yes',
    '--acknowledge-self-approval'
  ], waiting.worktree);
  const advanced = await resumeAutoFlight(root, waiting.flightId, waiting.checkpointSha256);
  assert.equal(advanced.status, 'completed',
    `${advanced.status}/${advanced.stopReason}: ${advanced.lastError?.message ?? advanced.nextAction}`);
  assert.equal(advanced.story.phase, 'verify');
  assert.equal(advanced.stopReason, 'story-complete');
  assert.equal(advanced.counters.phasesCompleted, 2);
  assert.equal(advanced.counters.modelInvocations, 1,
    'the deterministic verification phase must not consume another model invocation');
  assert.equal(advanced.boundaryCheckpoint.checkpointClass, 'completion');
});

test('step pacing checkpoints authored and published boundaries without repeating the model attempt', async () => {
  const root = await executableRepository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.workTypes['quick-fix'].auto.allowedPaces = ['phase', 'step'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'allow inspected step pacing'], root);
  run('git', ['push', 'origin', 'main'], root);
  const plan = await createAutoPlan(root, 'Change the value with an inspection after each operation.', {
    ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId: 'AUT-STEP-1', workType: 'quick-fix', fromBranch: 'main', pace: 'step' });
  let { flight } = await startAutoFlight(root, plan.planId, confirmation(plan));

  flight = await runFlightStep(root, flight);
  assert.equal(flight.status, 'paused');
  assert.equal(flight.position, 'authored');
  assert.equal(flight.stopReason, 'step-boundary-reached');
  assert.equal(flight.counters.modelInvocations, 1);

  flight = await resumeAutoFlight(root, flight.flightId, flight.checkpointSha256);
  flight = await runFlightStep(root, flight);
  assert.equal(flight.status, 'paused');
  assert.equal(flight.position, 'published');
  assert.equal(flight.counters.modelInvocations, 1);

  flight = await resumeAutoFlight(root, flight.flightId, flight.checkpointSha256);
  flight = await runFlightStep(root, flight);
  assert.equal(flight.status, 'completed');
  assert.equal(flight.position, 'submitted');
  assert.equal(flight.counters.modelInvocations, 1);
});

test('fresh-clone recovery after Candidate freeze restores authority without another model call', async (t) => {
  const root = await executableRepository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.workTypes['quick-fix'].auto.allowedPaces = ['phase', 'step'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'allow Candidate crash recovery pacing'], root);
  run('git', ['push', 'origin', 'main'], root);
  const workId = 'AUT-CANDIDATE-RECOVERY';
  const plan = await createAutoPlan(root, 'Change the value and recover after Candidate freeze.', {
    ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId, workType: 'quick-fix', fromBranch: 'main', pace: 'step' });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
  const frozen = await runFlightStep(root, started.flight);
  assert.equal(frozen.status, 'paused');
  assert.equal(frozen.position, 'authored');
  assert.ok(frozen.candidate?.candidateId);
  run('git', ['push', 'origin', frozen.story.branch], frozen.worktree);

  const recoveryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-candidate-recovery-'));
  t.after(() => rm(recoveryRoot, { recursive: true, force: true }));
  const remote = run('git', ['remote', 'get-url', 'origin'], root).stdout.trim();
  run('git', ['clone', '--branch', 'main', '--', remote, recoveryRoot], root);
  run('git', ['config', 'user.name', 'Auto Recovery Tester'], recoveryRoot);
  run('git', ['config', 'user.email', 'auto-recovery@example.com'], recoveryRoot);
  let rebuilt = await rebuildAutoFlightState(recoveryRoot, {
    storyRoot: recoveryRoot, workId, flightId: frozen.flightId
  });
  assert.equal(rebuilt.status, 'paused');
  assert.equal(rebuilt.position, 'authored');
  assert.equal(rebuilt.counters.modelInvocations, 1);
  assert.match(await readFile(path.join(rebuilt.worktree, 'app.mjs'), 'utf8'), /value = 2/);
  const candidate = await readAutoCandidateBinding(rebuilt.worktree, {
    flightId: rebuilt.flightId, candidateId: rebuilt.candidate.candidateId
  });
  assert.equal(candidate.bindingSha256, rebuilt.candidate.bindingSha256);

  rebuilt = await resumeAutoFlight(recoveryRoot, rebuilt.flightId, rebuilt.checkpointSha256);
  const published = await runFlightStep(recoveryRoot, rebuilt);
  assert.equal(published.status, 'paused',
    `${published.status}/${published.stopReason}: ${published.lastError?.message ?? published.nextAction}`);
  assert.equal(published.position, 'published');
  assert.equal(published.counters.modelInvocations, 1);
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
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
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
    const started = await startAutoFlight(root, plan.planId, confirmation(plan));
    const final = await runFlightStep(root, { ...started.flight, worktree: started.story.worktree });
    assert.equal(final.status, 'completed');
    assert.equal(final.stopReason, 'requested-boundary-reached');
    assert.equal(final.position, boundary);
    assert.deepEqual(final.operations.map((entry) => entry.operation),
      boundary === 'published'
        ? ['author', 'candidate-freeze', 'candidate-verify', 'publish']
        : ['author', 'candidate-freeze', 'candidate-verify', 'publish', 'submit']);
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
    const started = await startAutoFlight(root, plan.planId, confirmation(plan));
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

test('pause after a model write seals the cancelled attempt before quiescence is reported', async () => {
  const root = await executableRepository();
  const plan = await createAutoPlan(root, 'Preserve the exact write made before cancellation.', {
    ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId: 'AUT-PAUSE-AFTER-WRITE', workType: 'quick-fix', fromBranch: 'main' });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
  const wrote = deferred();
  const execution = runFlightStep(root, started.flight, {
    invokeModel: async ({ cwd, signal }) => {
      await writeFile(path.join(cwd, 'app.mjs'), 'export const value = 2;\n');
      wrote.resolve();
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          const error = new Error('Cancelled after writing.');
          error.code = 'MODEL_CANCELLED';
          reject(error);
          return;
        }
        signal.addEventListener('abort', () => {
          const error = new Error('Cancelled after writing.');
          error.code = 'MODEL_CANCELLED';
          reject(error);
        }, { once: true });
      });
    }
  });
  await wrote.promise;
  const [paused, final] = await Promise.all([
    pauseAutoFlight(root, started.flight.flightId), execution
  ]);
  assert.equal(final.status, 'paused');
  assert.equal(paused.status, 'paused');
  assert.ok(final.candidate?.candidateId,
    'the write made before cancellation must be sealed into Candidate authority');
  assert.equal(final.candidate.candidateSha256, paused.candidate.candidateSha256);
  assert.match(await readFile(path.join(final.worktree, 'app.mjs'), 'utf8'), /value = 2/);
  const candidate = await readAutoCandidateBinding(final.worktree, {
    flightId: final.flightId, candidateId: final.candidate.candidateId
  });
  assert.match(run('git', [
    'ls-remote', 'origin', candidate.repository.retainedRef
  ], final.worktree).stdout, new RegExp(candidate.repository.candidateCommit));
});

test('a stop observed while its flight-state lock is still held remains recoverable', async () => {
  const root = await executableRepository({ authorDelayMs: 10_000 });
  const workId = 'AUT-STOP-RACE-1';
  const plan = await createAutoPlan(root, 'Change the exported application value from one to two.', {
    ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
    suggestedUntil: 'phase-complete:implement'
  }, { workId, workType: 'quick-fix', fromBranch: 'main' });
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
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
    test(`${request} during ${window} quiesces with only its governed control checkpoint`, async () => {
      const root = await executableRepository();
      const workId = `AUT-${request.toUpperCase()}-${window.toUpperCase()}-RACE`;
      const plan = await createAutoPlan(root, 'Change the exported application value from one to two.', {
        ...proposal, workType: 'quick-fix', predictedPaths: ['app.mjs', 'test/app.test.mjs'],
        suggestedUntil: 'phase-complete:implement'
      }, { workId, workType: 'quick-fix', fromBranch: 'main' });
      const started = await startAutoFlight(root, plan.planId, confirmation(plan));
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
      const stoppedHead = run('git', ['rev-parse', 'HEAD'], started.story.worktree).stdout.trim();
      assert.notEqual(stoppedHead, storyHead, 'the durable stop must publish its governed checkpoint');
      assert.equal(stopped.boundaryCheckpoint?.commit, stoppedHead);
      assert.equal(stopped.commits?.controlCheckpoint, stoppedHead);
      assert.equal(run('git', ['rev-list', '--count', `${storyHead}..${stoppedHead}`],
        started.story.worktree).stdout.trim(), '1', 'the stop must create exactly one checkpoint commit');
      const checkpointChanges = run('git', [
        'diff', '--name-only', storyHead, stoppedHead
      ], started.story.worktree).stdout.trim().split('\n').filter(Boolean);
      assert.ok(checkpointChanges.includes(stopped.boundaryCheckpoint.path));
      assert.ok(checkpointChanges.every((candidate) => (
        candidate.startsWith(`singularity/work-items/${workId}/`)
      )), `control checkpoint touched non-Story paths: ${checkpointChanges.join(', ')}`);
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
  const started = await startAutoFlight(root, plan.planId, confirmation(plan));
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
