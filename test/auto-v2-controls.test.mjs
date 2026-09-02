import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';

import { buildAutoPlanPacket } from '../src/auto/auto-plan-packet.mjs';
import { createAutoPlan } from '../src/auto/auto-plan.mjs';
import { startAutoFlight } from '../src/auto/auto-flight.mjs';
import {
  absoluteAutoWriteScope, autoPhaseContractKey, buildAutoPhaseContract,
  renderAutoAuthoringPrompt
} from '../src/auto/auto-phase-contract.mjs';
import {
  assertAutoCheckpointAcceptedBinding, readGovernedAutoCheckpoint, rebuildAutoFlightState,
  validateAutoBoundaryCheckpoint
} from '../src/auto/auto-checkpoint.mjs';
import {
  buildAutoFlightReport, createAutoFlightState, discardAutoFlight, haltAutoFlight,
  mutateAutoFlightState, pauseAutoFlight, readAutoFlightReport, readAutoFlightState,
  renderAutoFlightReport, resumeAutoFlight, takeoverAutoFlight
} from '../src/auto/auto-flight-store.mjs';
import { recordSha256 } from '../src/records.mjs';
import { withSubjectLock } from '../src/subject-lock.mjs';

const PLAN_SHA256 = `sha256:${'a'.repeat(64)}`;
const cli = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, suffix) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-v2-controls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const flightId = `AFL-${suffix.repeat(26)}`;
  const state = await createAutoFlightState(root, {
    flightId,
    planId: `APL-${suffix.repeat(26)}`,
    planSha256: PLAN_SHA256,
    status: 'running',
    story: { workId: `WORK-${suffix}`, branch: `work-${suffix}`, phase: 'implementation' },
    worktree: root,
    execution: {
      until: { kind: 'first-human-boundary', phase: null },
      ceilings: {
        maximumAuthoringAttemptsPerPhase: 1,
        maximumModelInvocations: 1
      }
    }
  });
  return { root, flightId, state };
}

async function governedFixture(t, suffix) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-v2-governed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Auto Control Tester'], root);
  run('git', ['config', 'user.email', 'auto-controls@example.com'], root);
  run(process.execPath, [cli, 'init'], root);
  const capabilitiesPath = path.join(root, 'singularity/capabilities.yml');
  const capabilities = YAML.parse(await readFile(capabilitiesPath, 'utf8'));
  capabilities.capabilities['auto-fixture'] = {
    kind: 'delivery', parent: 'product', repository: 'auto-fixture'
  };
  await writeFile(capabilitiesPath, YAML.stringify(capabilities));
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.git.publish = 'off';
  workflow.auto.enabled = true;
  workflow.models.providers['copilot-cli'] = {
    type: 'copilot-cli', executable: process.execPath,
    promptTransport: 'acp-stdio', arguments: []
  };
  workflow.auto.ceilings = { tokenBudget: { maximum: 30000, assurance: 'best-available' } };
  workflow.workTypes.feature.auto = {
    eligibility: 'bounded', allowedPaces: ['phase'], defaultUntil: 'first-human-boundary'
  };
  await writeFile(workflowPath, YAML.stringify(workflow));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'configure governed Auto controls'], root);
  const remote = `${root}.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const proposal = {
    title: 'Exercise governed Auto controls', workType: 'feature',
    assumptions: ['The existing application source is the bounded target.'],
    unresolvedDecisions: [], predictedPaths: ['app.mjs'],
    acceptanceCriteria: ['The governed control boundary remains recoverable.'],
    suggestedUntil: 'first-human-boundary'
  };
  const workId = `AUT-CONTROL-${suffix}`;
  const plan = await createAutoPlan(root, 'Exercise a governed Auto control.', proposal, {
    workId, workType: 'feature', fromBranch: 'main'
  });
  const started = await startAutoFlight(root, plan.planId, buildAutoPlanPacket(plan).packetSha256);
  return { root, remote, workId, plan, ...started };
}

async function holdStepLease(root, flightId) {
  const entered = deferred();
  const release = deferred();
  const lease = withSubjectLock(root, { kind: 'auto-flight-step', id: flightId }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { release: release.resolve, lease };
}

const controls = [
  ['pause', 'A', (root, id, options) => pauseAutoFlight(root, id, options)],
  ['halt', 'B', (root, id, options) => haltAutoFlight(root, id, 'human-halted', options)],
  ['takeover', 'C', (root, id, options) => takeoverAutoFlight(root, id, options)]
];

test('human control prefill is fenced by the rendered flight checkpoint', async (t) => {
  const { root, flightId, state } = await fixture(t, 'E');
  await assert.rejects(
    () => pauseAutoFlight(root, flightId, {
      expectedCheckpoint: `sha256:${'0'.repeat(64)}`,
      quiescenceTimeoutMs: 50
    }),
    (error) => error.code === 'AUTO_CHECKPOINT_STALE'
  );
  assert.deepEqual(await readAutoFlightState(root, flightId), state,
    'a stale card cannot record a stop request or change the flight');
});

test('predicted glob paths become concrete task-scope roots', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-v2-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(absoluteAutoWriteScope(root, ['src/**']), [path.join(root, 'src')]);
  assert.deepEqual(
    absoluteAutoWriteScope(root, ['src/**/*.mjs', 'src/exact.mjs', 'test/*.test.mjs']),
    [path.join(root, 'src'), path.join(root, 'src/exact.mjs'), path.join(root, 'test')]
  );
  for (const absolute of [
    'C:\\workspace\\src\\app.mjs',
    'C:/workspace/src/app.mjs',
    '\\\\office-server\\share\\src\\app.mjs',
    './C:/workspace/src/app.mjs',
    '././C:/workspace/src/app.mjs',
    '.\\C:\\workspace\\src\\app.mjs',
    'C:workspace\\src\\app.mjs',
    '.',
    './'
  ]) {
    assert.throws(
      () => absoluteAutoWriteScope(root, [absolute]),
      (error) => error.code === 'AUTO_TASK_SCOPE_INVALID',
      absolute
    );
  }
});

test('phase rollover pins the generation intent and keeps each authorization slot distinct', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-v2-phase-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Auto Contract Tester'], root);
  run('git', ['config', 'user.email', 'auto-contract@example.com'], root);
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  run('git', ['add', 'app.mjs'], root);
  run('git', ['commit', '-m', 'seed application'], root);

  const phase = {
    id: 'implementation', generation: 1,
    generationIntent: { id: 'GEN-2', generation: 2 }
  };
  const state = {
      flightId: `AFL-${'F'.repeat(26)}`,
      planSha256: PLAN_SHA256,
      story: { workId: 'WORK-F' },
      counters: { authoringAttempts: {} },
      activeRepair: null,
      worldModelReference: null,
      comprehensionReference: null,
      createdAt: '2026-09-01T00:00:00.000Z'
  };
  const plan = {
      planId: `APL-${'A'.repeat(26)}`,
      proposal: { predictedPaths: ['src/**'], acceptanceCriteria: ['AC-001'] },
      requirement: { text: 'Change only the ratified source scope.', sha256: `sha256:${'b'.repeat(64)}` },
      bindings: { workflowSha256: 'workflow-sha' },
      execution: {
        ceilings: {
          maximumTouchedPaths: 10, maximumTouchedChanges: 20,
          maximumModelInvocations: 1,
          tokenBudget: { maximum: 30000, assurance: 'best-available' }
        }
      }
  };
  const modelPrompt = renderAutoAuthoringPrompt({
    composed: 'bounded prompt', flightId: state.flightId,
    attemptId: `AAT-${'1'.repeat(26)}`, plan, state
  });
  const contract = await buildAutoPhaseContract(root, {
    state,
    plan,
    definition: {},
    workflow: { resolution: { configSha256: 'config-sha' } },
    phase,
    task: 'implementation-authoring',
    composed: 'bounded prompt',
    modelPrompt,
    provider: { provider: 'copilot-cli', model: null }
  });

  assert.equal(contract.generation, 2,
    'the consumed generation-intent authority wins over a stale phase generation projection');
  assert.equal(contract.generationIntentId, 'GEN-2');
  const modelPromptSha256 = `sha256:${createHash('sha256')
    .update(modelPrompt, 'utf8').digest('hex')}`;
  assert.equal(
    contract.contextManifest.sections.find((section) => section.id === 'phase-prompt')
      .contentSha256,
    modelPromptSha256
  );
  assert.equal(contract.contextManifest.sections.find((section) => (
    section.id === 'phase-authority'
  )) != null, true);
  assert.notEqual(
    contract.contextManifest.sections.find((section) => section.id === 'phase-prompt')
      .contentSha256,
    `sha256:${createHash('sha256').update('bounded prompt', 'utf8').digest('hex')}`,
    'the Context Manifest must bind the complete text sent to the model'
  );
  const initial = autoPhaseContractKey(phase.id, contract);
  const repair = autoPhaseContractKey(phase.id, contract, { repairPlanId: 'ARP-EXACT' });
  assert.equal(initial, 'implementation@2@GEN-2@initial');
  assert.equal(repair, 'implementation@2@GEN-2@repair:ARP-EXACT');
  assert.notEqual(initial, repair);
  assert.notEqual(initial, autoPhaseContractKey(phase.id, {
    ...contract, generation: 3, generationIntentId: 'GEN-3'
  }));
});

test('the runtime reader migrates and reseals a genuine v1 flight with current checkpoint fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-v1-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const goldens = JSON.parse(await readFile(path.resolve(
    'test/fixtures/schema-migrations/goldens.json'
  ), 'utf8'));
  const legacy = goldens['auto-flight-state'][0];
  const directory = path.join(
    root, '.git', 'singularity-flow', 'auto-flights', legacy.flightId
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'state.json'), `${JSON.stringify(legacy)}\n`);

  const migrated = await readAutoFlightState(root, legacy.flightId);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.candidate, null);
  assert.equal(migrated.worldModelReference, null);
  assert.equal(migrated.comprehensionReference, null);
  assert.deepEqual(migrated.phaseContracts, {});
  assert.deepEqual(migrated.boundaryCheckpoints, []);
  assert.match(migrated.checkpointSha256, /^sha256:[a-f0-9]{64}$/);
});

test('a frozen v2 report reads and renders with explicit unavailable v3 projections', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-v2-report-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const goldens = JSON.parse(await readFile(path.resolve(
    'test/fixtures/schema-migrations/goldens.json'
  ), 'utf8'));
  const legacy = goldens['auto-flight-report'].find((record) => record.schemaVersion === 2);
  assert.ok(legacy, 'the migration corpus must retain a frozen v2 report');
  const directory = path.join(
    root, '.git', 'singularity-flow', 'auto-flights', legacy.flightId
  );
  const reportPath = path.join(directory, 'report.json');
  await mkdir(directory, { recursive: true });
  const originalBytes = `${JSON.stringify(legacy)}\n`;
  await writeFile(reportPath, originalBytes);

  const migrated = await readAutoFlightReport(root, legacy.flightId);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.sourceSchemaVersion, 2);
  assert.equal(migrated.reportSha256, legacy.reportSha256,
    'migration preserves the historical v2 report identity');
  assert.deepEqual(migrated.story,
    { workId: null, branch: null, phase: null, workType: null, phaseRail: [] });
  assert.equal(migrated.intent.source, 'unavailable');
  assert.equal(migrated.intent.requirement.text, null);
  assert.deepEqual(migrated.executionUnits,
    { planned: null, current: null, currentManifestSha256: null, switches: [] });
  assert.deepEqual(migrated.qualityFloor, {
    status: 'unavailable', basis: 'observed-task-outcomes',
    tokenSavingComparison: 'not-evaluated', reasons: ['no-economics-receipts'],
    firstPassVerified: 0, verifiedAfterRepair: 0, reviewReturns: 0,
    missingContextIncidents: 0
  });
  assert.equal(migrated.outcomeMetrics.verifiedOutcomes, 0);
  assert.equal(migrated.outcomeMetrics.latencyToFirstVerifiedOutcomeMilliseconds, null);
  assert.equal(migrated.accounting.observations.toolOutput.assurance, 'unavailable');
  assert.equal(await readFile(reportPath, 'utf8'), originalBytes,
    'reading a legacy report never rewrites its frozen bytes');

  const rendered = renderAutoFlightReport({
    flightId: legacy.flightId, planId: legacy.planId, planSha256: legacy.planSha256,
    status: legacy.status, stopReason: legacy.stopReason, nextAction: legacy.nextAction,
    story: { workId: null, branch: null, phase: null },
    counters: { modelInvocations: 0 }, checkpointSha256: legacy.checkpointSha256
  }, migrated);
  assert.match(rendered, /Requirement \(unavailable\): unavailable/);
  assert.match(rendered, /Execution Unit: unavailable/);
  assert.match(rendered, /Quality floor: unavailable/);
  assert.match(rendered, new RegExp(legacy.reportSha256.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

for (const [kind, suffix, control] of controls) {
  test(`${kind} records recovery-required when execution quiescence cannot be proven`, async (t) => {
    const { root, flightId } = await fixture(t, suffix);
    const held = await holdStepLease(root, flightId);
    try {
      await assert.rejects(
        () => control(root, flightId, { quiescenceTimeoutMs: 10 }),
        (error) => error.code === 'AUTO_STOP_TIMEOUT'
          && error.details?.status === 'recovery-required'
          && error.details?.stopRequested?.kind === kind
      );

      const recovery = await readAutoFlightState(root, flightId);
      assert.equal(recovery.status, 'recovery-required');
      assert.equal(recovery.stopReason, `${kind}-quiescence-unproven`);
      assert.equal(recovery.stopRequested.kind, kind);
      assert.match(recovery.stopRequested.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(recovery.lastError.code, 'AUTO_STOP_TIMEOUT');
      const report = buildAutoFlightReport(recovery);
      assert.equal(report.humanIntervention.required, true);
      await assert.rejects(
        () => resumeAutoFlight(root, flightId, recovery.checkpointSha256),
        (error) => error.code === 'AUTO_RECOVERY_REQUIRED'
      );
      await assert.rejects(
        () => discardAutoFlight(root, flightId, flightId),
        (error) => error.code === 'AUTO_RECOVERY_REQUIRED'
      );
    } finally {
      held.release();
      await held.lease;
    }
  });
}

test('manual takeover without governed Story authority fails closed after quiescence', async (t) => {
  const { root, flightId } = await fixture(t, 'D');
  const prepared = await mutateAutoFlightState(root, flightId, (state) => {
    state.position = 'authored';
    state.observedPaths = ['src/app.mjs', 'test/app.test.mjs'];
    state.evidence = { changeSetDigest: `sha256:${'b'.repeat(64)}` };
    state.operations = [{ operation: 'author', outcome: 'succeeded' }];
    state.commits = { generation: '1234567890abcdef' };
  });
  const held = await holdStepLease(root, flightId);
  let failure;
  try {
    const takingOver = takeoverAutoFlight(root, flightId, { quiescenceTimeoutMs: 2_000 });
    let requested = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      requested = await readAutoFlightState(root, flightId);
      if (requested.status === 'manual-takeover') break;
      await delay(10);
    }
    assert.equal(requested.status, 'manual-takeover');
    assert.equal(requested.stopRequested.kind, 'takeover');
    assert.notEqual(requested.checkpointSha256, prepared.checkpointSha256);
    await assert.rejects(
      () => resumeAutoFlight(root, flightId, requested.checkpointSha256),
      (error) => error.code === 'AUTO_STOP_IN_PROGRESS'
    );

    held.release();
    await held.lease;
    failure = await takingOver.then(() => null, (error) => error);
  } finally {
    held.release();
    await held.lease;
  }
  assert.equal(failure?.code, 'AUTO_CHECKPOINT_PUBLICATION_FAILED');
  const recovery = await readAutoFlightState(root, flightId);
  assert.equal(recovery.status, 'recovery-required');
  assert.equal(recovery.stopReason, 'takeover-checkpoint-publication-failed');
  assert.deepEqual(recovery.observedPaths, ['src/app.mjs', 'test/app.test.mjs']);
  assert.deepEqual(recovery.evidence, { changeSetDigest: `sha256:${'b'.repeat(64)}` });
  assert.deepEqual(recovery.operations, [{ operation: 'author', outcome: 'succeeded' }]);
  assert.deepEqual(recovery.commits, { generation: '1234567890abcdef' });
  assert.match(recovery.stopRequested.quiescedAt, /^\d{4}-\d{2}-\d{2}T/);
  const report = buildAutoFlightReport(recovery);
  assert.deepEqual(report.retainedUnpublishedPaths, recovery.observedPaths);
  assert.equal(report.humanIntervention.required, true);
});

for (const [kind, suffix, control, expectedStatus] of [
  ['pause', 'PAUSE', (root, id) => pauseAutoFlight(root, id), 'paused'],
  ['halt', 'HALT', (root, id) => haltAutoFlight(root, id), 'halted'],
  ['takeover', 'TAKEOVER', (root, id) => takeoverAutoFlight(root, id), 'manual-takeover']
]) {
  test(`${kind} publishes a governed post-quiescence checkpoint`, async (t) => {
    const { root, remote, workId, flight, story } = await governedFixture(t, suffix);
    const result = await control(root, flight.flightId);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.stopRequested.kind, kind);
    assert.match(result.stopRequested.quiescedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.boundaryCheckpoint.checkpointClass, 'human-boundary');
    assert.equal(result.boundaryCheckpoint.commit,
      run('git', ['rev-parse', 'HEAD'], story.worktree).stdout.trim());
    const workflow = JSON.parse(await readFile(path.join(
      story.worktree, 'singularity/work-items', result.story.workId, 'workflow.json'
    ), 'utf8'));
    const projection = workflow.publicationProjections.at(-1);
    assert.equal(projection.event.type, 'evidence-recorded');
    assert.equal(projection.event.payload.kind, 'auto-boundary-checkpoint');
    assert.equal(projection.event.payload.flightId, flight.flightId);
    assert.equal(projection.event.payload.checkpointClass, 'human-boundary');
    assert.equal(projection.event.payload.checkpointSha256,
      result.boundaryCheckpoint.checkpointSha256);
    const committed = JSON.parse(run('git', [
      'show', `${result.boundaryCheckpoint.commit}:${result.boundaryCheckpoint.path}`
    ], story.worktree).stdout);
    assert.equal(committed.status, expectedStatus);
    assert.equal(committed.checkpointSha256, result.boundaryCheckpoint.checkpointSha256);

    if (kind === 'pause') {
      const unknown = structuredClone(committed);
      unknown.unreviewed = true;
      delete unknown.checkpointSha256;
      unknown.checkpointSha256 = `sha256:${recordSha256(unknown)}`;
      assert.throws(
        () => validateAutoBoundaryCheckpoint(unknown),
        (error) => error.code === 'AUTO_CHECKPOINT_INVALID'
      );
      await writeFile(path.join(story.worktree, result.boundaryCheckpoint.path), JSON.stringify(unknown));
      run('git', ['add', result.boundaryCheckpoint.path], story.worktree);
      run('git', ['commit', '-m', 'tamper checkpoint fixture'], story.worktree);
      await assert.rejects(
        () => readGovernedAutoCheckpoint(story.worktree, workflow, projection),
        (error) => error.code === 'AUTO_CHECKPOINT_INVALID'
      );
    }

    if (kind === 'takeover') {
      run('git', ['push', 'origin', result.story.branch], story.worktree);
      const recoveryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-v2-recovery-'));
      t.after(() => rm(recoveryRoot, { recursive: true, force: true }));
      run('git', ['clone', '--branch', 'main', '--', remote, recoveryRoot], root);
      run('git', ['config', 'user.name', 'Auto Recovery Tester'], recoveryRoot);
      run('git', ['config', 'user.email', 'auto-recovery@example.com'], recoveryRoot);
      const rebuilt = await rebuildAutoFlightState(recoveryRoot, {
        storyRoot: story.worktree, workId, flightId: flight.flightId
      });
      assert.equal(rebuilt.status, 'manual-takeover');
      assert.equal(rebuilt.story.workId, workId);
      assert.equal(rebuilt.boundaryCheckpoint.checkpointSha256,
        result.boundaryCheckpoint.checkpointSha256);
      assert.notEqual(path.resolve(rebuilt.worktree), path.resolve(story.worktree));
      assert.equal(run('git', ['branch', '--show-current'], rebuilt.worktree).stdout.trim(),
        result.story.branch);
    }
  });
}

test('a resealed checkpoint cannot fabricate its embedded report projections', async (t) => {
  const { root, flight, story } = await governedFixture(t, 'REPORT-PROJECTION');
  const halted = await haltAutoFlight(root, flight.flightId);
  const checkpoint = JSON.parse(run('git', [
    'show', `${halted.boundaryCheckpoint.commit}:${halted.boundaryCheckpoint.path}`
  ], story.worktree).stdout);
  assert.equal(checkpoint.finalReport?.qualityFloor?.status, 'unavailable');

  for (const mutate of [
    (report) => {
      report.qualityFloor.status = 'passed';
      report.qualityFloor.reasons = [];
    },
    (report) => { report.outcomeMetrics.verifiedOutcomes = 999; }
  ]) {
    const forged = structuredClone(checkpoint);
    mutate(forged.finalReport);
    delete forged.finalReport.reportSha256;
    delete forged.finalReport.projectionSha256;
    forged.finalReport.reportSha256 = `sha256:${recordSha256(forged.finalReport)}`;
    const reportProjection = structuredClone(forged.finalReport);
    forged.finalReport.projectionSha256 = `sha256:${recordSha256(reportProjection)}`;
    forged.finalReportSha256 = forged.finalReport.reportSha256;
    delete forged.checkpointSha256;
    forged.checkpointSha256 = `sha256:${recordSha256(forged)}`;

    assert.throws(
      () => validateAutoBoundaryCheckpoint(forged),
      (error) => error.code === 'AUTO_CHECKPOINT_INVALID'
    );
  }
});

test('checkpoint repository authority refuses traversal and credential-bearing remotes', async (t) => {
  const { root, flight, story } = await governedFixture(t, 'REPOSITORY-AUTHORITY');
  const halted = await haltAutoFlight(root, flight.flightId);
  const checkpoint = JSON.parse(run('git', [
    'show', `${halted.boundaryCheckpoint.commit}:${halted.boundaryCheckpoint.path}`
  ], story.worktree).stdout);

  for (const mutate of [
    (record) => { record.repositories[0].id = '../outside-auto-root'; },
    (record) => {
      record.repositories[0].remoteUrl = 'https://token@example.test/repository.git';
      record.repositories[0].remoteFingerprint = createHash('sha256')
        .update(record.repositories[0].remoteUrl).digest('hex');
    }
  ]) {
    const forged = structuredClone(checkpoint);
    mutate(forged);
    delete forged.checkpointSha256;
    forged.checkpointSha256 = `sha256:${recordSha256(forged)}`;
    assert.throws(
      () => validateAutoBoundaryCheckpoint(forged),
      (error) => error.code === 'AUTO_CHECKPOINT_INVALID'
    );
  }
});

test('recovery checkpoint authority must equal the accepted Story Plan', async (t) => {
  const { root, plan, flight, story } = await governedFixture(t, 'ACCEPTED-BINDING');
  const halted = await haltAutoFlight(root, flight.flightId);
  const checkpoint = JSON.parse(run('git', [
    'show', `${halted.boundaryCheckpoint.commit}:${halted.boundaryCheckpoint.path}`
  ], story.worktree).stdout);
  assert.doesNotThrow(() => assertAutoCheckpointAcceptedBinding(checkpoint, plan));

  for (const mutate of [
    (record) => { record.story.branch = 'substituted-story'; },
    (record) => { record.repositories[0].baseCommit = 'f'.repeat(40); },
    (record) => { record.capabilityId = 'substituted-capability'; },
    (record) => { record.scopePrediction = ['outside/**']; },
    (record) => { record.execution.ceilings.maximumModelInvocations += 1; }
  ]) {
    const substituted = structuredClone(checkpoint);
    mutate(substituted);
    assert.throws(
      () => assertAutoCheckpointAcceptedBinding(substituted, plan),
      (error) => error.code === 'AUTO_FLIGHT_BINDING_MISMATCH'
    );
  }
});

test('self-consistent wrong-family state and report records fail closed', async (t) => {
  const { root, flightId } = await fixture(t, 'E');
  const directory = path.join(root, '.git/singularity-flow/auto-flights', flightId);
  const statePath = path.join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.kind = 'auto-plan';
  delete state.recordSha256;
  state.recordSha256 = recordSha256(state);
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(
    () => readAutoFlightState(root, flightId),
    (error) => error.code === 'AUTO_FLIGHT_CORRUPT'
  );

  state.kind = 'auto-flight-state';
  delete state.recordSha256;
  state.recordSha256 = recordSha256(state);
  await writeFile(statePath, JSON.stringify(state));
  const report = buildAutoFlightReport(state);
  report.kind = 'auto-plan';
  delete report.reportSha256;
  report.reportSha256 = `sha256:${recordSha256(report)}`;
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
  await assert.rejects(
    () => readAutoFlightReport(root, flightId),
    (error) => error.code === 'AUTO_FLIGHT_CORRUPT'
  );
});
