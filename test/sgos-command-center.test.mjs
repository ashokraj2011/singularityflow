import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectSgosCommandCenter, SGOS_RUNTIME_CAPABILITIES
} from '../src/sgos/command-center.mjs';
import {
  projectSgosViewCatalog, SGOS_PROJECTED_VIEW_TYPES
} from '../src/sgos/projection.mjs';
import { validateWorkObject } from '../src/sgos/contracts.mjs';

const hash = (digit) => `sha256:${digit.repeat(64)}`;

function process(processId, status = 'waiting-human') {
  return {
    schemaVersion: 1,
    kind: 'gvm-process',
    processId,
    processRevision: 7,
    processSha256: hash(processId.endsWith('A') ? 'a' : 'b'),
    programSha256: hash('c'),
    policySnapshotSha256: hash('d'),
    processBindingSha256: hash('e'),
    taskContractSha256: hash('f'),
    status,
    taskInstances: {
      [`${processId}-TASK`]: {
        taskInstanceId: `${processId}-TASK`, taskTemplateId: 'approve', state: 'waiting-human',
        predecessorTaskInstanceIds: [], inputRefs: [], outputRefs: [], attemptIds: [],
        receiptSha256: null, invalidatedBy: null, revision: 2
      }
    },
    activeExecutions: [], activeLeases: [], openHumanRequests: [hash('1')],
    currentCheckpointSha256: hash('2'), controlEventSha256: hash('3'), recordIndexSha256: hash('4'),
    authorityBinding: {
      kind: 'story', subjectId: 'WRK-42', branch: 'WRK-42', baselineRevision: '1'.repeat(40)
    },
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:01:00.000Z'
  };
}

function request(processId) {
  return {
    requestId: `${processId}-REQUEST`, requestSha256: hash('1'), taskInstanceId: `${processId}-TASK`,
    requestType: 'approval', prompt: { title: 'Approve exact output', detail: 'Review the receipt.' },
    authorityRequired: { kind: 'role', id: 'reviewer' },
    options: [{ id: 'approved', label: 'Approve', consequence: 'The exact task may continue.' }],
    inputSchema: null, checkpointSha256: hash('2'), subjectSha256: hash('5'),
    policySnapshotSha256: hash('d'), sensitiveMode: 'none', expiresAt: null
  };
}

test('Command Center is a deterministic exact-bound projection with no executable callbacks', () => {
  const right = process('PROC-B');
  const left = process('PROC-A');
  const board = projectSgosCommandCenter([right, left], {
    humanRequestsByProcess: { 'PROC-A': [request('PROC-A')], 'PROC-B': [request('PROC-B')] }
  });
  const repeated = projectSgosCommandCenter([right, left], {
    humanRequestsByProcess: { 'PROC-A': [request('PROC-A')], 'PROC-B': [request('PROC-B')] }
  });
  assert.equal(board.contentSha256, repeated.contentSha256);
  assert.deepEqual(board.processes.map((entry) => entry.processId), ['PROC-A', 'PROC-B']);
  assert.equal(board.needsYou.length, 2);
  assert.equal(board.views.length, 2 * SGOS_PROJECTED_VIEW_TYPES.length);
  assert.ok(Object.isFrozen(board));
  assert.ok(Object.isFrozen(board.processes[0].actions[0].source));
  for (const card of board.processes) {
    for (const action of card.actions) {
      assert.equal(action.source.processSha256, card.processSha256);
      assert.equal(action.source.processRevision, card.processRevision);
      assert.equal(typeof action.operation, 'string');
      assert.equal(Object.values(action).some((value) => typeof value === 'function'), false);
      assert.equal(Object.hasOwn(action, 'command'), false);
    }
  }
});

test('all canonical Work Object views are deterministic, inert, bounded, and contract-valid', () => {
  const source = process('PROC-AAAAAA');
  const before = structuredClone(source);
  const sensitive = {
    ...request('PROC-AAAAAA'),
    sensitiveMode: 'secret-broker',
    secretBroker: 'vault://raw-secret-handle',
    externalUrl: 'https://should-never-be-projected.invalid/token'
  };
  const projected = projectSgosViewCatalog(source, { humanRequests: [sensitive] });
  const repeated = projectSgosViewCatalog(source, { humanRequests: [sensitive] });
  assert.deepEqual(projected.map((entry) => entry.view.type), SGOS_PROJECTED_VIEW_TYPES);
  assert.deepEqual(projected, repeated);
  assert.deepEqual(source, before, 'read projections must not mutate Process state');
  for (const object of projected) {
    assert.deepEqual(validateWorkObject(object), object);
    assert.ok(Object.isFrozen(object));
    const descriptor = object.view.schema['x-sgos-render'];
    assert.equal(descriptor.viewType, object.view.type);
    assert.ok(descriptor.rows.length <= 200);
    assert.match(descriptor.accessibility.label, /PROC-AAAAAA/);
    assert.equal(descriptor.delivery.slice, 'sgos');
    assert.equal(descriptor.delivery.release, 'panel-dispose');
    assert.equal(JSON.stringify(object).includes('function'), false);
    assert.equal(JSON.stringify(object).includes('callback'), false);
    assert.equal(Object.hasOwn(descriptor, 'html'), false);
    assert.equal(Object.hasOwn(descriptor, 'command'), false);
  }
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /vault:\/\/raw-secret-handle|should-never-be-projected/);
  const approval = projected.find((entry) => entry.view.type === 'approval');
  const binding = approval.view.actions[0].inputSchema.properties;
  assert.equal(binding.processSha256.const, source.processSha256);
  assert.equal(binding.expectedRevision.const, source.processRevision);
  assert.equal(binding.requestSha256.const, sensitive.requestSha256);
  const board = projected.find((entry) => entry.view.type === 'board');
  assert.throws(() => { board.view.schema['x-sgos-render'].rows[0].cells[1] = 'failed'; }, TypeError);
  assert.deepEqual(source, before);
});

test('Needs You projection contains the complete decision context without secret transport handles', () => {
  const source = process('PROC-A');
  source.activeExecutions = ['ATT-ACTIVE'];
  source.taskInstances['PROC-A-TASK'].receiptSha256 = hash('8');
  const secretRequest = {
    ...request('PROC-A'), sensitiveMode: 'external-url',
    externalUrl: 'https://secret.example.invalid/session'
  };
  const board = projectSgosCommandCenter([source], {
    humanRequestsByProcess: { 'PROC-A': [secretRequest] }
  });
  const [workObject] = board.needsYou;
  assert.equal(workObject.view.type, 'approval');
  const semantics = workObject.view.schema['x-sgos'];
  assert.equal(semantics.requestType, 'approval');
  assert.equal(semantics.why, 'Review the receipt.');
  assert.equal(semantics.exactSubject.processSha256, source.processSha256);
  assert.equal(semantics.exactSubject.requestSha256, secretRequest.requestSha256);
  assert.deepEqual(semantics.exactSubject.evidenceRefs, [hash('8')]);
  assert.deepEqual(semantics.authorityRequired, { kind: 'role', id: 'reviewer' });
  assert.equal(semantics.choices[0].consequence, 'The exact task may continue.');
  assert.match(semantics.whatRemainsRunning, /1 active execution/);
  assert.match(semantics.resumeBehavior, /rechecks the exact Process revision/);
  assert.equal(semantics.expiresAt, null);
  assert.doesNotMatch(JSON.stringify(workObject), /secret\.example\.invalid/);
});

test('Command Center preserves unreadable Processes without claiming success or resumability', () => {
  const board = projectSgosCommandCenter([{
    kind: 'sgos-process-unavailable', processId: 'PROC-BROKEN', available: false,
    error: { code: 'SGOS_PROCESS_CORRUPT', message: 'Stored bytes failed validation.' }
  }]);
  assert.equal(board.processes.length, 0);
  assert.equal(board.unavailable.length, 1);
  assert.equal(board.unavailable[0].successClaimed, false);
  assert.equal(board.unavailable[0].resumable, false);
  assert.equal(board.unavailable[0].error.code, 'SGOS_PROCESS_CORRUPT');
});

test('a stop-requested Process is not projected as resumable until execution is quiescent', () => {
  const stopping = process('PROC-A', 'paused');
  stopping.activeExecutions = ['ATT-ACTIVE'];
  stopping.activeLeases = ['LEASE-ACTIVE'];
  const [card] = projectSgosCommandCenter([stopping]).processes;
  assert.equal(card.status, 'paused');
  assert.equal(card.resumable, false);
  assert.equal(card.actions.find((action) => action.operation === 'process.stop')?.enabled, true);

  stopping.activeExecutions = [];
  stopping.activeLeases = [];
  assert.equal(projectSgosCommandCenter([stopping]).processes[0].resumable, true);
});

test('Command Center projects lifecycle, dispatch, and lineage actions from exact Process bytes', () => {
  const running = process('PROC-A', 'running');
  running.openHumanRequests = [];
  running.taskInstances['PROC-A-TASK'].state = 'ready';
  const runningCard = projectSgosCommandCenter([running]).processes[0];
  for (const operation of [
    'process.pause', 'process.stop', 'process.step', 'process.run',
    'process.recover.plan', 'process.replay.plan', 'process.fork.plan'
  ]) {
    const action = runningCard.actions.find((entry) => entry.operation === operation);
    assert.equal(action?.enabled, true, operation);
    assert.deepEqual(action?.source, {
      processId: runningCard.processId,
      processRevision: runningCard.processRevision,
      processSha256: runningCard.processSha256
    });
  }
  assert.equal(runningCard.actions.find((entry) => entry.operation === 'process.resume')?.enabled, false);

  const paused = process('PROC-A', 'paused');
  paused.openHumanRequests = [];
  const pausedCard = projectSgosCommandCenter([paused]).processes[0];
  assert.equal(pausedCard.actions.find((entry) => entry.operation === 'process.resume')?.enabled, true);
  for (const operation of ['process.pause', 'process.step', 'process.run']) {
    assert.equal(pausedCard.actions.find((entry) => entry.operation === operation)?.enabled, false, operation);
  }

  paused.activeExecutions = ['ATT-ACTIVE'];
  paused.activeLeases = ['LEASE-ACTIVE'];
  const stopping = projectSgosCommandCenter([paused]).processes[0];
  assert.equal(stopping.actions.find((entry) => entry.operation === 'process.resume')?.enabled, false);
  assert.equal(stopping.actions.find((entry) => entry.operation === 'process.replay.plan')?.enabled, false);
  assert.equal(stopping.actions.find((entry) => entry.operation === 'process.fork.plan')?.enabled, false);
});

test('runtime capability projection exposes bounded parallel, lineage, stop, and exact adapters', () => {
  assert.equal(SGOS_RUNTIME_CAPABILITIES.commandCenter.status, 'available');
  assert.equal(SGOS_RUNTIME_CAPABILITIES.processGraph.status, 'available');
  assert.equal(SGOS_RUNTIME_CAPABILITIES.parallelExecution.status, 'available');
  assert.match(SGOS_RUNTIME_CAPABILITIES.parallelExecution.reason, /one deterministic.*bounded.*wave/i);
  assert.equal(SGOS_RUNTIME_CAPABILITIES.replay.status, 'available');
  assert.match(SGOS_RUNTIME_CAPABILITIES.replay.reason, /pure suffix.*ancestor checkpoint/i);
  assert.equal(SGOS_RUNTIME_CAPABILITIES.fork.status, 'available');
  assert.match(SGOS_RUNTIME_CAPABILITIES.fork.reason, /genesis-only/i);
  assert.equal(SGOS_RUNTIME_CAPABILITIES.stopQuiescence.status, 'available');
  assert.equal(SGOS_RUNTIME_CAPABILITIES.agentExecution.status, 'available');
  assert.match(SGOS_RUNTIME_CAPABILITIES.agentExecution.reason, /deterministic-translator/i);
  assert.equal(SGOS_RUNTIME_CAPABILITIES.deviceExecution.status, 'available');
  assert.match(SGOS_RUNTIME_CAPABILITIES.deviceExecution.reason, /read-only filesystem/i);
  for (const id of ['agentExecution', 'deviceExecution', 'taskRetry']) {
    assert.equal(SGOS_RUNTIME_CAPABILITIES[id].status, 'available');
    assert.equal(Object.hasOwn(SGOS_RUNTIME_CAPABILITIES[id], 'operation'), false);
  }
});
