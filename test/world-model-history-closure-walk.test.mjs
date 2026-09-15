import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WMP_HISTORY_CLOSURE_LIMIT,
  WORLD_MODEL_HISTORY_CLOSURE_LIMITS,
  assertAcyclicWorldModelHistoryClosure,
  collectWorldModelHistoryObjectRefs,
  createWorldModelHistoryClosureBudget
} from '../src/world-model/history/closure-walk.mjs';

function digest(index) {
  return `sha256:${index.toString(16).padStart(64, '0')}`;
}

test('deep retained-object chains refuse at a stable depth budget without recursion', () => {
  const length = WORLD_MODEL_HISTORY_CLOSURE_LIMITS.maximumDepth + 2_000;
  const edges = new Map();
  for (let index = 0; index < length - 1; index += 1) {
    edges.set(digest(index), [digest(index + 1)]);
  }
  assert.throws(
    () => assertAcyclicWorldModelHistoryClosure({
      roots: [digest(0)],
      childrenOf: (value) => edges.get(value) ?? []
    }),
    (error) => error?.code === WMP_HISTORY_CLOSURE_LIMIT
      && error?.details?.limit === 'depth'
      && error?.details?.maximumDepth === WORLD_MODEL_HISTORY_CLOSURE_LIMITS.maximumDepth
      && error?.name !== 'RangeError'
  );
});

test('iterative retained-object cycle detection preserves the exact active cycle', () => {
  const first = digest(1);
  const second = digest(2);
  const third = digest(3);
  const edges = new Map([
    [first, [second]],
    [second, [third]],
    [third, [second]]
  ]);
  assert.throws(
    () => assertAcyclicWorldModelHistoryClosure({
      roots: [first],
      childrenOf: (value) => edges.get(value) ?? []
    }),
    (error) => error?.code === 'WMP_INTEGRITY_FAILED'
      && error?.details?.sha256 === second
      && JSON.stringify(error?.details?.cycle) === JSON.stringify([second, third, second])
  );
});

test('adversarial graph breadth is stopped by one aggregate work budget', () => {
  const root = digest(0);
  const children = Array.from({ length: 1_000 }, (_, index) => digest(index + 1));
  const budget = createWorldModelHistoryClosureBudget({
    operation: 'adversarial-breadth', maximumSteps: 100
  });
  assert.throws(
    () => assertAcyclicWorldModelHistoryClosure({
      roots: [root],
      childrenOf: (value) => value === root ? children : [],
      budget
    }),
    (error) => error?.code === WMP_HISTORY_CLOSURE_LIMIT
      && error?.details?.limit === 'size'
      && error?.details?.maximumSteps === 100
  );
});

test('aggregate closure deadlines fail with a stable typed refusal', () => {
  let tick = 0;
  const budget = createWorldModelHistoryClosureBudget({
    operation: 'deadline-fixture',
    maximumMilliseconds: 2,
    clock: () => tick++
  });
  budget.checkpoint();
  budget.checkpoint();
  assert.throws(
    () => budget.checkpoint(),
    (error) => error?.code === WMP_HISTORY_CLOSURE_LIMIT
      && error?.details?.limit === 'time'
      && error?.details?.maximumMilliseconds === 2
  );
});

test('reference discovery is iterative, ordered, and shares the depth budget', () => {
  const first = { exact: true, id: 'first' };
  const second = { exact: true, id: 'second' };
  const refs = collectWorldModelHistoryObjectRefs({ a: [first], b: { value: second } }, {
    exactObjectRef: (value) => value?.exact === true,
    validateObjectRef: (value) => value
  });
  assert.deepEqual(refs.map((ref) => ref.id), ['first', 'second']);

  let nested = first;
  for (let depth = 0;
    depth < WORLD_MODEL_HISTORY_CLOSURE_LIMITS.maximumDepth + 1;
    depth += 1) {
    nested = [nested];
  }
  assert.throws(
    () => collectWorldModelHistoryObjectRefs(nested, {
      exactObjectRef: (value) => value?.exact === true,
      validateObjectRef: (value) => value
    }),
    (error) => error?.code === WMP_HISTORY_CLOSURE_LIMIT
      && error?.details?.limit === 'depth'
      && error?.name !== 'RangeError'
  );
});
