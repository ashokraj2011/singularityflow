import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectSgosCommandCenter, SGOS_RUNTIME_CAPABILITIES
} from '../src/sgos/command-center.mjs';

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
    options: [{ id: 'approved', label: 'Approve' }], inputSchema: null,
    sensitiveMode: 'none', expiresAt: null
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
    assert.equal(SGOS_RUNTIME_CAPABILITIES[id].status,
      id === 'taskRetry' ? 'staged' : 'available');
    assert.equal(Object.hasOwn(SGOS_RUNTIME_CAPABILITIES[id], 'operation'), false);
  }
});
