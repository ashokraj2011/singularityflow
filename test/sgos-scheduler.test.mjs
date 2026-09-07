import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalSgosResourceEntries,
  sgosResourceEntriesConflict,
  sgosResourceKeysOverlap
} from '../src/sgos/resource-contracts.mjs';
import { deterministicSgosDispatchPlan, sgosTaskReadiness } from '../src/sgos/scheduler.mjs';
import {
  canonicalSgosJoins, canonicalSgosReducerInputs, reduceSgosJoinOutputs,
  sgosJoinReadiness
} from '../src/sgos/joins.mjs';
import { normalizeSgosFanout } from '../src/sgos/fanout.mjs';
import {
  createFanoutExpansionReceipt, createJoinReceipt, createQuorumJoinReceipt,
  createReducerJoinReceipt, createResourceLease, recordSelfSha256,
  validateFanoutExpansionReceipt, validateJoinReceipt, validateQuorumJoinReceipt,
  validateReducerJoinReceipt,
  validateResourceLease
} from '../src/sgos/contracts.mjs';

function template(taskTemplateId, dependsOn = [], resources = {}) {
  return {
    taskTemplateId,
    opcode: 'NOOP',
    dependsOn,
    resources: {
      reads: resources.reads ?? [], writes: resources.writes ?? [],
      devices: resources.devices ?? [], externalEffects: resources.externalEffects ?? []
    },
    metadata: {}
  };
}

function instance(taskTemplateId, state, predecessorTaskInstanceIds = []) {
  return {
    taskInstanceId: `instance:${taskTemplateId}`,
    taskTemplateId,
    state,
    predecessorTaskInstanceIds,
    attemptIds: []
  };
}

test('runtime resource compatibility matches hierarchical read/write and exclusive domains', () => {
  assert.equal(sgosResourceKeysOverlap('repo/src/**', 'repo/src/a.mjs'), true);
  assert.equal(sgosResourceKeysOverlap('repo/src', 'repo/test'), false);
  const read = canonicalSgosResourceEntries({ reads: ['repo/src'], writes: [] });
  const readChild = canonicalSgosResourceEntries({ reads: ['repo/src/a.mjs'], writes: [] });
  const writeChild = canonicalSgosResourceEntries({ reads: [], writes: ['repo/src/a.mjs'] });
  assert.equal(sgosResourceEntriesConflict(read, readChild), false);
  assert.equal(sgosResourceEntriesConflict(read, writeChild), true);
  assert.equal(sgosResourceEntriesConflict(
    canonicalSgosResourceEntries({ devices: ['browser'] }),
    canonicalSgosResourceEntries({ devices: ['browser/page'] })
  ), true);
  for (const alias of ['workspace:/safe/../target', 'workspace:/safe/%2e%2e/target']) {
    assert.throws(() => canonicalSgosResourceEntries({ writes: [alias] }),
      (error) => error.code === 'SGOS_RESOURCE_INVALID');
  }
});

test('scheduler selects a canonical compatible set independent of task insertion order', () => {
  const program = {
    taskTemplates: [
      template('alpha', [], { reads: ['repo/a'] }),
      template('beta', [], { writes: ['repo/b'] }),
      template('gamma', [], { reads: ['repo/b/file'] })
    ],
    joins: []
  };
  const tasks = [
    instance('gamma', 'ready'), instance('alpha', 'ready'), instance('beta', 'ready')
  ];
  const process = {
    status: 'running', activeExecutions: [],
    taskInstances: Object.fromEntries(tasks.map((entry) => [entry.taskInstanceId, entry]))
  };
  assert.deepEqual(deterministicSgosDispatchPlan(program, process, { maximumParallel: 3 })
    .map((entry) => entry.taskTemplateId), ['alpha', 'beta']);
  process.taskInstances = Object.fromEntries([...tasks].reverse()
    .map((entry) => [entry.taskInstanceId, entry]));
  assert.deepEqual(deterministicSgosDispatchPlan(program, process, { maximumParallel: 3 })
    .map((entry) => entry.taskTemplateId), ['alpha', 'beta']);
});

test('installed joins distinguish all-success impossibility from all-terminal readiness', () => {
  const [success] = canonicalSgosJoins([{
    joinId: 'success', taskTemplateId: 'success', policy: 'all-success',
    predecessorTaskTemplateIds: ['a', 'b']
  }]);
  const [terminal] = canonicalSgosJoins([{
    joinId: 'terminal', taskTemplateId: 'terminal', policy: 'all-terminal',
    predecessorTaskTemplateIds: ['a', 'b']
  }]);
  assert.deepEqual(sgosJoinReadiness(success, ['succeeded', 'failed']), {
    ready: false, impossible: true
  });
  assert.deepEqual(sgosJoinReadiness(terminal, ['succeeded', 'failed']), {
    ready: true, impossible: false
  });
  const program = {
    taskTemplates: [
      template('a'), template('b'), { ...template('terminal', ['a', 'b']), opcode: 'JOIN' }
    ],
    joins: [terminal]
  };
  const a = instance('a', 'succeeded');
  const b = instance('b', 'failed');
  const join = instance('terminal', 'waiting', [a.taskInstanceId, b.taskInstanceId]);
  const process = { taskInstances: {
    [a.taskInstanceId]: a, [b.taskInstanceId]: b, [join.taskInstanceId]: join
  } };
  assert.deepEqual(sgosTaskReadiness(program, process, join), {
    ready: true, impossible: false
  });
});

test('quorum joins become ready at the installed threshold and fail only when it is unreachable', () => {
  const [quorum] = canonicalSgosJoins([{
    joinId: 'quorum', taskTemplateId: 'quorum', policy: 'quorum', requiredSuccesses: 2,
    predecessorTaskTemplateIds: ['a', 'b', 'c']
  }]);
  assert.deepEqual(quorum, {
    joinId: 'quorum', taskTemplateId: 'quorum', policy: 'quorum', requiredSuccesses: 2,
    predecessorTaskTemplateIds: ['a', 'b', 'c']
  });
  assert.deepEqual(sgosJoinReadiness(quorum, ['succeeded', 'succeeded', 'running']), {
    ready: true, impossible: false
  });
  assert.deepEqual(sgosJoinReadiness(quorum, ['succeeded', 'failed', 'running']), {
    ready: false, impossible: false
  });
  assert.deepEqual(sgosJoinReadiness(quorum, ['succeeded', 'failed', 'cancelled']), {
    ready: false, impossible: true
  });
  for (const requiredSuccesses of [undefined, 0, 4]) {
    assert.throws(() => canonicalSgosJoins([{
      joinId: 'invalid', taskTemplateId: 'invalid', policy: 'quorum', requiredSuccesses,
      predecessorTaskTemplateIds: ['a', 'b', 'c']
    }]), (error) => error.code === 'SGOS_JOIN_QUORUM_INVALID');
  }
  assert.throws(() => canonicalSgosJoins([{
    joinId: 'invalid', taskTemplateId: 'invalid', policy: 'all-success', requiredSuccesses: 1,
    predecessorTaskTemplateIds: ['a']
  }]), (error) => error.code === 'SGOS_JOIN_QUORUM_INVALID');
});

test('deterministic reducer joins require every successful input and bind a canonical reduction', () => {
  const [join] = canonicalSgosJoins([{
    joinId: 'reduce', taskTemplateId: 'reduce', policy: 'deterministic-reduce',
    reducerId: 'canonical-output-ref-set-v1',
    predecessorTaskTemplateIds: ['b', 'a']
  }]);
  assert.deepEqual(join, {
    joinId: 'reduce', taskTemplateId: 'reduce', policy: 'deterministic-reduce',
    reducerId: 'canonical-output-ref-set-v1',
    predecessorTaskTemplateIds: ['a', 'b']
  });
  assert.deepEqual(sgosJoinReadiness(join, ['succeeded', 'running']), {
    ready: false, impossible: false
  });
  assert.deepEqual(sgosJoinReadiness(join, ['succeeded', 'failed']), {
    ready: false, impossible: true
  });
  assert.deepEqual(sgosJoinReadiness(join, ['succeeded', 'succeeded']), {
    ready: true, impossible: false
  });
  const inputs = canonicalSgosReducerInputs([
    { taskInstanceId: 'task:b', outputRefs: ['z', 'shared'] },
    { taskInstanceId: 'task:a', outputRefs: ['shared', 'a'] }
  ]);
  assert.deepEqual(inputs, [
    { taskInstanceId: 'task:a', outputRefs: ['a', 'shared'] },
    { taskInstanceId: 'task:b', outputRefs: ['shared', 'z'] }
  ]);
  assert.deepEqual(reduceSgosJoinOutputs('canonical-output-ref-set-v1', inputs),
    ['a', 'shared', 'z']);
  assert.throws(() => canonicalSgosJoins([{
    joinId: 'bad', taskTemplateId: 'bad', policy: 'deterministic-reduce',
    reducerId: 'unreviewed', predecessorTaskTemplateIds: ['a']
  }]), (error) => error.code === 'SGOS_JOIN_REDUCER_UNSUPPORTED');
  assert.throws(() => canonicalSgosJoins([{
    joinId: 'bad', taskTemplateId: 'bad', policy: 'all-success',
    reducerId: 'canonical-output-ref-set-v1', predecessorTaskTemplateIds: ['a']
  }]), (error) => error.code === 'SGOS_JOIN_REDUCER_INVALID');
});

test('END waits for non-contributing quorum predecessors to become terminal', () => {
  const templates = [
    template('a'), template('b'), template('c'),
    { ...template('join', ['a', 'b', 'c']), opcode: 'JOIN' },
    { ...template('end', ['join']), opcode: 'END' }
  ];
  const joinContract = canonicalSgosJoins([{
    joinId: 'join', taskTemplateId: 'join', policy: 'quorum', requiredSuccesses: 2,
    predecessorTaskTemplateIds: ['a', 'b', 'c']
  }])[0];
  const a = instance('a', 'succeeded');
  const b = instance('b', 'succeeded');
  const c = instance('c', 'waiting');
  const join = instance('join', 'succeeded', [a.taskInstanceId, b.taskInstanceId, c.taskInstanceId]);
  const end = instance('end', 'waiting', [join.taskInstanceId]);
  const process = { taskInstances: Object.fromEntries([a, b, c, join, end]
    .map((entry) => [entry.taskInstanceId, entry])) };
  const program = { taskTemplates: templates, joins: [joinContract] };
  assert.deepEqual(sgosTaskReadiness(program, process, end), {
    ready: false, impossible: false
  });
  c.state = 'failed';
  assert.deepEqual(sgosTaskReadiness(program, process, end), {
    ready: true, impossible: false
  });
});

test('nested fan-out parallelism counts distinct outer items instead of leaf tasks', () => {
  const nested = (taskTemplateId, outerItem, innerParent, innerItem) => ({
    ...template(taskTemplateId),
    metadata: {
      fanout: {
        parentTaskId: innerParent, itemKey: innerItem, maximumParallel: 2
      },
      fanoutLineage: [{
        parentTaskId: 'outer', itemKey: outerItem, maximumParallel: 1
      }]
    }
  });
  const taskTemplates = [
    nested('a-one', 'a', 'inner-a', 'one'),
    nested('a-two', 'a', 'inner-a', 'two'),
    nested('b-one', 'b', 'inner-b', 'one'),
    nested('b-two', 'b', 'inner-b', 'two')
  ];
  const process = {
    status: 'running', activeExecutions: [],
    taskInstances: Object.fromEntries(taskTemplates.map((entry) => {
      const value = instance(entry.taskTemplateId, 'ready');
      return [value.taskInstanceId, value];
    }))
  };
  assert.deepEqual(deterministicSgosDispatchPlan({ taskTemplates, joins: [] }, process, {
    maximumParallel: 4
  }).map((entry) => entry.taskTemplateId), ['a-one', 'a-two']);
});

test('fan-out normalization is finite, key-stable, and bounded', () => {
  const normalized = normalizeSgosFanout({
    taskId: 'items', maximumItems: 2, maximumParallel: 2,
    items: [{ key: 'z', value: 2 }, { key: 'a', value: 1 }]
  });
  assert.deepEqual(normalized.items.map((entry) => entry.itemKey), ['a', 'z']);
  assert.match(normalized.collectionSha256, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => normalizeSgosFanout({
    taskId: 'items', maximumItems: 1, maximumParallel: 1,
    items: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }]
  }), (error) => error.code === 'SGOS_FANOUT_LIMIT');
});

test('parallel durable receipts are strict, self-hashed, and tamper evident', () => {
  const processId = `PROC-${'A'.repeat(32)}`;
  const attemptId = `ATT-${'B'.repeat(32)}`;
  const resource = createResourceLease({
    processId, taskInstanceId: 'task:alpha', attemptId,
    resources: [{ key: 'repo/z', mode: 'write' }, { key: 'repo/a', mode: 'read' }],
    acquiredAt: '2026-08-30T00:00:00.000Z', expiresAt: '2026-08-30T00:01:00.000Z'
  });
  assert.equal(validateResourceLease(resource).leaseSha256, resource.leaseSha256);
  assert.deepEqual(resource.resources.map((entry) => entry.key), ['repo/a', 'repo/z']);
  assert.throws(() => validateResourceLease({ ...resource, expiresAt: resource.acquiredAt }));

  const join = createJoinReceipt({
    processId, taskInstanceId: 'task:join', attemptId,
    joinId: 'main', policy: 'all-terminal',
    predecessors: [{
      taskInstanceId: 'task:alpha', state: 'failed', receiptSha256: null, attemptId
    }],
    outputRefs: [], completedAt: '2026-08-30T00:01:00.000Z'
  });
  assert.equal(validateJoinReceipt(join).joinReceiptSha256, join.joinReceiptSha256);
  assert.throws(() => validateJoinReceipt({ ...join, policy: 'first-finished' }));

  const quorumJoin = createQuorumJoinReceipt({
    processId, taskInstanceId: 'task:quorum', attemptId,
    joinId: 'quorum-main', policy: 'quorum', requiredSuccesses: 1,
    predecessorTaskInstanceIds: ['task:alpha', 'task:beta'],
    predecessors: [{
      taskInstanceId: 'task:alpha', state: 'succeeded',
      receiptSha256: `sha256:${'3'.repeat(64)}`, attemptId
    }],
    outputRefs: [`sha256:${'3'.repeat(64)}`], completedAt: '2026-08-30T00:01:00.000Z'
  });
  assert.equal(validateQuorumJoinReceipt(quorumJoin).quorumJoinReceiptSha256,
    quorumJoin.quorumJoinReceiptSha256);
  assert.throws(() => validateQuorumJoinReceipt({
    ...quorumJoin, requiredSuccesses: 2
  }));

  const reducerJoin = createReducerJoinReceipt({
    processId, taskInstanceId: 'task:reduce', attemptId,
    joinId: 'reduce-main', policy: 'deterministic-reduce',
    reducerId: 'canonical-output-ref-set-v1',
    predecessors: [{
      taskInstanceId: 'task:alpha', state: 'succeeded',
      receiptSha256: `sha256:${'3'.repeat(64)}`, attemptId
    }],
    inputs: [{ taskInstanceId: 'task:alpha', outputRefs: ['z', 'a'] }],
    outputRefs: ['a', 'z'], completedAt: '2026-08-30T00:01:00.000Z'
  });
  assert.equal(validateReducerJoinReceipt(reducerJoin).reducerJoinReceiptSha256,
    reducerJoin.reducerJoinReceiptSha256);
  const forgedReducerJoin = { ...reducerJoin, outputRefs: ['z'] };
  forgedReducerJoin.reducerJoinReceiptSha256 = recordSelfSha256(
    forgedReducerJoin, 'reducerJoinReceiptSha256'
  );
  assert.throws(() => validateReducerJoinReceipt(forgedReducerJoin),
    /outputs do not match/);

  const itemSha256 = `sha256:${'1'.repeat(64)}`;
  const expansion = createFanoutExpansionReceipt({
    processId, parentTaskTemplateId: 'items',
    collectionSha256: `sha256:${'2'.repeat(64)}`,
    maximumItems: 1, maximumParallel: 1,
    items: [{ itemKey: 'one', itemSha256, taskTemplateId: 'items:one', taskInstanceId: 'task:one' }],
    createdAt: '2026-08-30T00:00:00.000Z'
  });
  assert.equal(validateFanoutExpansionReceipt(expansion).expansionSha256,
    expansion.expansionSha256);
  assert.throws(() => validateFanoutExpansionReceipt({ ...expansion, maximumItems: 0 }));
});
