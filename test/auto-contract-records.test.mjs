import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  AUTO_CONTRACT_RECORD_FAMILIES, AUTO_EXECUTION_EVENT_TYPES,
  buildAutoAgentTaskContract, buildAutoContextManifest, buildAutoExecutionEvent,
  buildAutoExecutionSelection, listAutoContractRecords, persistAutoExecutionEvent,
  persistAutoExecutionTransitions, persistAutoPhaseContractRecords,
  readAutoContractRecord, restoreAutoContractRecords,
  validateAutoPhaseContractSnapshot, validateAutoPhaseContractSnapshots
} from '../src/auto/auto-contract-records.mjs';
import { absoluteAutoReadScope } from '../src/auto/auto-phase-contract.mjs';
import {
  AUTO_HUMAN_REQUEST_TYPES, buildAutoHumanRequest
} from '../src/auto/auto-p1-records.mjs';
import {
  currentSchemaVersion, familyForStoredPath, readRecord
} from '../src/schema-migrations.mjs';
import { recordSha256 } from '../src/records.mjs';

const FLIGHT_ID = `AFL-${'A'.repeat(26)}`;
const ATTEMPT_ID = `AAT-${'B'.repeat(26)}`;
const HASH = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;
const NOW = () => '2026-09-02T00:00:00.000Z';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function repository(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-auto-contract-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  return root;
}

function records() {
  const contextManifest = buildAutoContextManifest({
    flightId: FLIGHT_ID, attemptId: ATTEMPT_ID, phase: 'implementation',
    sections: [{
      id: 'acceptance-clauses', sourceRef: 'sfref:auto-plan/APL-1/acceptance',
      contentSha256: HASH('1'), representation: 'full', estimatedTokens: 12,
      mandatory: true
    }],
    omitted: [{ id: 'world-model', reason: 'not-required' }],
    expansionPolicySha256: HASH('2'), budgetSha256: HASH('3')
  }, { now: NOW });
  const taskContract = buildAutoAgentTaskContract({
    flightId: FLIGHT_ID, attemptId: ATTEMPT_ID, phase: 'implementation',
    objective: 'Implement the ratified acceptance clauses.', acceptanceClauses: ['AC-001'],
    readScope: ['src/report/**', 'test/report/**'],
    writeScope: ['src/report/**', 'test/report/**'],
    protectedScope: ['src/security/**'], forbiddenScope: ['singularity/**'],
    allowedTools: ['read', 'edit', 'search'],
    requiredOutputs: ['source changes', 'tests'], requiredEvidence: ['affected tests'],
    budgets: {
      maximumTouchedPaths: 20, maximumTouchedChanges: 40, maximumModelInvocations: 2,
      maximumTotalTokens: 30000, tokenAssurance: 'best-available'
    },
    stopConditions: ['protected-path', 'scope-expansion']
  }, { now: NOW });
  const executionSelection = buildAutoExecutionSelection({
    flightId: FLIGHT_ID, attemptId: ATTEMPT_ID, phase: 'implementation',
    executionUnitId: 'copilot-cli', manifestSha256: HASH('4'),
    reason: 'approved-default-for-implementation'
  }, { now: NOW });
  const event = buildAutoExecutionEvent({
    flightId: FLIGHT_ID, attemptId: ATTEMPT_ID, phase: 'implementation', sequence: 1,
    eventType: 'execution.started',
    executionSelectionSha256: executionSelection.selectionSha256,
    taskContractSha256: taskContract.contractSha256,
    observation: { status: 'started' },
    rawEvidence: { status: 'unavailable', reason: 'adapter exposes no raw provider events' }
  }, { now: NOW });
  return { contextManifest, taskContract, executionSelection, event };
}

function completedEventStream(built) {
  const authority = {
    flightId: FLIGHT_ID,
    attemptId: ATTEMPT_ID,
    phase: 'implementation',
    executionSelectionSha256: built.executionSelection.selectionSha256,
    taskContractSha256: built.taskContract.contractSha256
  };
  return [built.event, buildAutoExecutionEvent({
    ...authority,
    sequence: 2,
    eventType: 'execution.completed',
    observation: { status: 'completed' },
    rawEvidence: { status: 'unavailable', reason: 'adapter exposes no raw provider events' }
  }, { now: NOW }), buildAutoExecutionEvent({
    ...authority,
    sequence: 3,
    eventType: 'execution.quiesced',
    observation: { status: 'quiesced' },
    rawEvidence: { status: 'unavailable', reason: 'adapter exposes no raw provider events' }
  }, { now: NOW })];
}

function composite(built, changes = {}) {
  const contract = {
    attemptId: built.taskContract.attemptId,
    generation: 1,
    generationIntentId: 'GEN-1',
    contextContractSha256: built.contextManifest.manifestSha256,
    taskContractSha256: built.taskContract.contractSha256,
    executionUnitContractSha256: HASH('9'),
    executionSelectionSha256: built.executionSelection.selectionSha256,
    contextManifest: built.contextManifest,
    taskContract: built.taskContract,
    executionSelection: built.executionSelection,
    allowedTools: built.taskContract.allowedTools,
    ...structuredClone(changes),
    contractSha256: null
  };
  contract.contractSha256 = `sha256:${recordSha256((() => {
    const core = structuredClone(contract);
    delete core.contractSha256;
    return core;
  })())}`;
  return contract;
}

function contractMap(contract, key = 'implementation@1@GEN-1@initial') {
  return { [key]: contract };
}

test('AUT context, task, selection, and execution records are registry-stamped and durable', async (t) => {
  const root = await repository(t, 'durable');
  const built = records();
  assert.deepEqual(AUTO_CONTRACT_RECORD_FAMILIES, [
    'auto-context-manifest', 'auto-agent-task-contract',
    'auto-execution-selection', 'auto-execution-event'
  ]);
  for (const record of Object.values(built)) {
    assert.equal(record.schemaVersion, currentSchemaVersion(record.kind));
    assert.ok(Object.isFrozen(record));
  }

  const persisted = await persistAutoPhaseContractRecords(root, built);
  assert.deepEqual(persisted, {
    contextManifest: built.contextManifest,
    taskContract: built.taskContract,
    executionSelection: built.executionSelection
  });
  const event = await persistAutoExecutionEvent(root, built.event);
  assert.deepEqual(event, built.event);
  assert.deepEqual(
    await readAutoContractRecord(
      root, 'auto-agent-task-contract', FLIGHT_ID, built.taskContract.taskContractId
    ),
    built.taskContract
  );
  assert.deepEqual(
    await listAutoContractRecords(root, 'auto-execution-event', FLIGHT_ID), [built.event]
  );

  await assert.rejects(
    () => persistAutoExecutionEvent(root, {
      ...built.event, observation: { ...built.event.observation, code: 'CHANGED' }
    }),
    (error) => error.code === 'AUTO_CONTRACT_RECORD_CONFLICT'
  );
  await assert.rejects(
    () => persistAutoExecutionEvent(root, {
      ...built.event, observation: { ...built.event.observation, status: 'changed' }
    }),
    (error) => error.code === 'AUTO_CONTRACT_RECORD_CORRUPT'
  );
});

test('governed checkpoint records restore disposable Auto contract sidecars exactly', async (t) => {
  const root = await repository(t, 'restore');
  const built = records();
  await restoreAutoContractRecords(
    root, contractMap(composite(built)), completedEventStream(built)
  );
  for (const [family, id] of [
    ['auto-context-manifest', built.contextManifest.contextManifestId],
    ['auto-agent-task-contract', built.taskContract.taskContractId],
    ['auto-execution-selection', built.executionSelection.selectionId],
    ['auto-execution-event', built.event.eventId]
  ]) {
    const restored = await readAutoContractRecord(root, family, FLIGHT_ID, id);
    assert.equal(restored.kind, family);
  }
});

test('governed checkpoint restore refuses a same-ID sidecar with different exact bytes', async (t) => {
  const root = await repository(t, 'restore-conflict');
  const built = records();
  await persistAutoPhaseContractRecords(root, built);
  const checkpointContext = buildAutoContextManifest({
    ...built.contextManifest,
    createdAt: '2026-09-02T00:00:01.000Z'
  });
  assert.equal(checkpointContext.contextManifestId, built.contextManifest.contextManifestId);
  assert.notEqual(checkpointContext.manifestSha256, built.contextManifest.manifestSha256);
  const checkpointContract = composite({
    ...built, contextManifest: checkpointContext
  });
  await assert.rejects(
    () => restoreAutoContractRecords(root, contractMap(checkpointContract)),
    (error) => error.code === 'AUTO_CONTRACT_RECORD_CONFLICT'
      && error.details.expected === checkpointContext.manifestSha256
      && error.details.actual === built.contextManifest.manifestSha256
  );
});

test('composite phase contracts reject tampered hashes, map keys, and event references', () => {
  const built = records();
  const contract = composite(built);
  assert.deepEqual(validateAutoPhaseContractSnapshot(contract), contract);

  assert.throws(
    () => validateAutoPhaseContractSnapshot({
      ...contract, contractSha256: HASH('e')
    }),
    (error) => error.code === 'AUTO_PHASE_CONTRACT_CORRUPT'
  );
  const badPointer = composite(built, { taskContractSha256: HASH('e') });
  assert.throws(
    () => validateAutoPhaseContractSnapshot(badPointer),
    (error) => error.code === 'AUTO_PHASE_CONTRACT_CORRUPT'
  );
  assert.throws(
    () => validateAutoPhaseContractSnapshots(
      contractMap(contract, 'planning@1@GEN-1@initial'), []
    ),
    (error) => error.code === 'AUTO_PHASE_CONTRACT_CORRUPT'
  );
  const wrongReference = buildAutoExecutionEvent({
    ...built.event, executionSelectionSha256: HASH('e')
  }, { now: NOW });
  assert.throws(
    () => validateAutoPhaseContractSnapshots(contractMap(contract), [wrongReference]),
    (error) => error.code === 'AUTO_EXECUTION_EVENT_AUTHORITY_CONFLICT'
  );
});

test('contract builders match schema timestamp and raw-evidence scalar constraints', () => {
  const built = records();
  assert.throws(
    () => buildAutoExecutionEvent({
      ...built.event, eventId: undefined, createdAt: undefined
    }, { now: () => '2026-02-30T00:00:00Z' }),
    (error) => error.code === 'AUTO_CONTRACT_RECORD_CORRUPT'
  );
  assert.throws(
    () => buildAutoExecutionEvent({
      ...built.event, eventId: undefined,
      rawEvidence: { status: 'hash-linked', sha256: HASH('5'), reason: {} }
    }, { now: NOW }),
    (error) => error.code === 'AUTO_CONTRACT_RECORD_CORRUPT'
  );
});

test('contract restore rejects missing/future schemas and incomplete terminal streams before writes', async (t) => {
  for (const [label, mutate, code] of [
    ['missing', (task) => { delete task.schemaVersion; }, 'SCHEMA_VERSION_MISSING'],
    ['future', (task) => { task.schemaVersion = 2; }, 'SCHEMA_VERSION_FUTURE']
  ]) {
    const root = await repository(t, `schema-${label}`);
    const built = records();
    const taskContract = structuredClone(built.taskContract);
    mutate(taskContract);
    const contract = composite({ ...built, taskContract }, {
      taskContractSha256: taskContract.contractSha256
    });
    await assert.rejects(
      () => restoreAutoContractRecords(root, contractMap(contract), [built.event]),
      (error) => error.code === code
    );
    assert.deepEqual(
      await listAutoContractRecords(root, 'auto-context-manifest', FLIGHT_ID), [],
      `${label} nested schema wrote a partial sidecar`
    );
  }

  const root = await repository(t, 'missing-quiescence');
  const built = records();
  await assert.rejects(
    () => restoreAutoContractRecords(
      root, contractMap(composite(built)), [built.event]
    ),
    (error) => error.code === 'AUTO_EXECUTION_EVENT_QUIESCENCE_UNPROVEN'
  );
  assert.deepEqual(
    await listAutoContractRecords(root, 'auto-execution-event', FLIGHT_ID), []
  );
  const failed = buildAutoExecutionEvent({
    flightId: FLIGHT_ID, attemptId: ATTEMPT_ID, phase: 'implementation', sequence: 2,
    eventType: 'execution.failed',
    executionSelectionSha256: built.executionSelection.selectionSha256,
    taskContractSha256: built.taskContract.contractSha256,
    observation: { status: 'failed', code: 'MODEL_PROVIDER_FAILED' },
    rawEvidence: { status: 'unavailable', reason: 'provider failed' }
  }, { now: NOW });
  await assert.rejects(
    () => restoreAutoContractRecords(
      root, contractMap(composite(built)), [built.event, failed]
    ),
    (error) => error.code === 'AUTO_EXECUTION_EVENT_QUIESCENCE_UNPROVEN'
  );
  assert.deepEqual(
    await listAutoContractRecords(root, 'auto-execution-event', FLIGHT_ID), []
  );
});

test('portable contract scope derives different absolute roots without changing durable bytes', async (t) => {
  const first = await repository(t, 'cross-root-a');
  const second = await repository(t, 'cross-root-b');
  const built = records();
  const contract = composite(built);
  const bytes = JSON.stringify(contract);
  assert.equal(bytes.includes(first), false);
  assert.equal(bytes.includes(second), false);
  assert.equal(Object.hasOwn(contract, 'readRoots'), false);
  assert.deepEqual(absoluteAutoReadScope(first, contract.taskContract.readScope), [
    path.join(first, 'src/report'), path.join(first, 'test/report')
  ]);
  assert.deepEqual(absoluteAutoReadScope(second, contract.taskContract.readScope), [
    path.join(second, 'src/report'), path.join(second, 'test/report')
  ]);
  await restoreAutoContractRecords(first, contractMap(contract), completedEventStream(built));
  await restoreAutoContractRecords(second, contractMap(contract), completedEventStream(built));
  assert.deepEqual(
    await listAutoContractRecords(first, 'auto-agent-task-contract', FLIGHT_ID),
    await listAutoContractRecords(second, 'auto-agent-task-contract', FLIGHT_ID)
  );
});

test('concurrent stop observers serialize one exact stop and terminal event chain', async (t) => {
  const root = await repository(t, 'event-race');
  const built = records();
  await persistAutoExecutionEvent(root, built.event);
  const authority = {
    flightId: FLIGHT_ID, attemptId: ATTEMPT_ID, phase: 'implementation',
    executionSelectionSha256: built.executionSelection.selectionSha256,
    taskContractSha256: built.taskContract.contractSha256
  };
  const stopEvidence = { status: 'hash-linked', sha256: HASH('5'), reason: null };
  const stop = {
    eventType: 'execution.stop-requested',
    observation: {
      status: 'stop-requested', invocationId: null,
      code: 'AUTO_STOP_REQUESTED', usageSha256: null
    },
    rawEvidence: stopEvidence
  };
  await Promise.all([
    persistAutoExecutionTransitions(root, authority, [stop]),
    persistAutoExecutionTransitions(root, authority, [stop, {
      eventType: 'execution.stopped',
      observation: {
        status: 'stopped', invocationId: null,
        code: 'AUTO_STOP_REQUESTED', usageSha256: null
      },
      rawEvidence: stopEvidence
    }, {
      eventType: 'execution.quiesced',
      observation: {
        status: 'quiesced', invocationId: null, code: null, usageSha256: null
      },
      rawEvidence: stopEvidence
    }])
  ]);
  const events = await listAutoContractRecords(root, 'auto-execution-event', FLIGHT_ID);
  assert.deepEqual(events.map((event) => event.eventType), [
    'execution.started', 'execution.stop-requested',
    'execution.stopped', 'execution.quiesced'
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(events.filter((event) => (
    event.eventType === 'execution.stop-requested'
  )).length, 1);
  assert.deepEqual(events.slice(1).map((event) => event.rawEvidence.sha256), [
    HASH('5'), HASH('5'), HASH('5')
  ]);
});

test('Auto model read roots are concrete Plan scope and can never silently become the repository root', async (t) => {
  const root = await repository(t, 'scope');
  assert.deepEqual(
    absoluteAutoReadScope(root, ['src/report/**', 'test/report/exact.test.mjs']),
    [path.join(root, 'src/report'), path.join(root, 'test/report/exact.test.mjs')]
  );
  assert.throws(
    () => absoluteAutoReadScope(root, ['**/*.mjs']),
    (error) => error.code === 'AUTO_TASK_SCOPE_TOO_BROAD'
  );
  assert.throws(
    () => absoluteAutoReadScope(root, ['../outside']),
    (error) => error.code === 'AUTO_TASK_SCOPE_INVALID'
  );
});

test('the migration registry covers every new durable family and rejects future records', () => {
  const locations = {
    'auto-context-manifest': 'context-manifests/ACM-AAAAAAAAAAAAAAAAAAAAAAAAAA.json',
    'auto-agent-task-contract': 'task-contracts/ATC-AAAAAAAAAAAAAAAAAAAAAAAAAA.json',
    'auto-execution-selection': 'execution-selections/AES-AAAAAAAAAAAAAAAAAAAAAAAAAA.json',
    'auto-execution-event': 'execution-events/AEV-AAAAAAAAAAAAAAAAAAAAAAAAAA.json'
  };
  for (const [family, suffix] of Object.entries(locations)) {
    const storedPath = `$git/auto-flights/${FLIGHT_ID}/${suffix}`;
    assert.equal(familyForStoredPath(storedPath)?.id, family);
    assert.throws(
      () => readRecord(family, { schemaVersion: 2 }),
      (error) => error.code === 'SCHEMA_VERSION_FUTURE'
    );
  }
  assert.deepEqual(AUTO_EXECUTION_EVENT_TYPES, [
    'execution.started', 'execution.progress', 'execution.message',
    'execution.file-observed', 'execution.tool-intent', 'execution.tool-result',
    'execution.subagent', 'execution.budget', 'execution.stop-requested',
    'execution.stopped', 'execution.quiesced', 'execution.failed',
    'execution.completed', 'provider.unknown'
  ]);
});

test('Human Requests expose the complete closed AUT v2 judgment vocabulary at schema v3', () => {
  assert.deepEqual(AUTO_HUMAN_REQUEST_TYPES, [
    'clarification', 'approval', 'architecture-choice', 'scope-choice', 'credential',
    'exception', 'risk-acceptance', 'policy-choice', 'conflict-resolution',
    'evidence-review', 'production-authority', 'legal-judgment', 'scientific-judgment'
  ]);
  for (const requestType of AUTO_HUMAN_REQUEST_TYPES.filter(
    (type) => !['clarification', 'credential'].includes(type)
  )) {
    const request = buildAutoHumanRequest({
      flightId: FLIGHT_ID, phase: 'implementation', attemptId: ATTEMPT_ID,
      requestType, title: `Resolve ${requestType}`, detail: { reason: 'Human judgment is required.' },
      options: ['accept', 'reject'], subjectSha256: HASH('5'), policySha256: HASH('6'),
      checkpointSha256: HASH('7'), status: 'open', response: null, expiresAt: null
    }, { now: NOW });
    assert.equal(request.schemaVersion, 3);
    assert.equal(request.requestType, requestType);
  }
});
