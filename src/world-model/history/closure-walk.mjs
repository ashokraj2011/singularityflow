import { performance } from 'node:perf_hooks';

import { SingularityFlowError } from '../../util.mjs';

export const WMP_HISTORY_CLOSURE_LIMIT = 'WMP_HISTORY_CLOSURE_LIMIT';

export const WORLD_MODEL_HISTORY_CLOSURE_LIMITS = Object.freeze({
  maximumDepth: 4_096,
  maximumSteps: 1_000_000,
  maximumMilliseconds: 30_000
});

function invalidLimit(label, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SingularityFlowError(`World-model history ${label} must be a positive integer.`, {
      code: WMP_HISTORY_CLOSURE_LIMIT,
      details: { limit: 'configuration', label, received: value ?? null }
    });
  }
  return value;
}

function exceeded(operation, limit, details) {
  throw new SingularityFlowError(
    `World-model retained closure '${operation}' exceeded its ${limit} budget.`,
    {
      code: WMP_HISTORY_CLOSURE_LIMIT,
      details: { operation, limit, ...details }
    }
  );
}

/**
 * One aggregate budget for retained-object discovery and graph validation.
 *
 * The clock is injectable only so the deadline contract can be tested without sleeping. Product
 * callers use the monotonic process clock. A single budget must be shared across reference
 * discovery, object loading, and cycle validation so no phase can reset the work deadline.
 */
export function createWorldModelHistoryClosureBudget({
  operation = 'closure-validation',
  maximumDepth = WORLD_MODEL_HISTORY_CLOSURE_LIMITS.maximumDepth,
  maximumSteps = WORLD_MODEL_HISTORY_CLOSURE_LIMITS.maximumSteps,
  maximumMilliseconds = WORLD_MODEL_HISTORY_CLOSURE_LIMITS.maximumMilliseconds,
  clock = () => performance.now()
} = {}) {
  const depthLimit = invalidLimit('maximumDepth', maximumDepth);
  const stepLimit = invalidLimit('maximumSteps', maximumSteps);
  const timeLimit = invalidLimit('maximumMilliseconds', maximumMilliseconds);
  const startedAt = Number(clock());
  if (!Number.isFinite(startedAt)) {
    exceeded(operation, 'time', { maximumMilliseconds: timeLimit, elapsedMilliseconds: null });
  }
  let steps = 0;

  return Object.freeze({
    checkpoint({ depth = 0, work = 1 } = {}) {
      if (!Number.isSafeInteger(depth) || depth < 0
          || !Number.isSafeInteger(work) || work < 1) {
        exceeded(operation, 'configuration', { depth, work });
      }
      if (depth > depthLimit) {
        exceeded(operation, 'depth', { maximumDepth: depthLimit, observedDepth: depth });
      }
      steps += work;
      if (!Number.isSafeInteger(steps) || steps > stepLimit) {
        exceeded(operation, 'size', { maximumSteps: stepLimit, observedSteps: steps });
      }
      const elapsed = Number(clock()) - startedAt;
      if (!Number.isFinite(elapsed) || elapsed > timeLimit) {
        exceeded(operation, 'time', {
          maximumMilliseconds: timeLimit,
          elapsedMilliseconds: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null
        });
      }
    },
    snapshot() {
      return Object.freeze({
        operation,
        steps,
        maximumDepth: depthLimit,
        maximumSteps: stepLimit,
        maximumMilliseconds: timeLimit
      });
    }
  });
}

/** Iteratively discover exact retained-object references without recursing through hostile JSON. */
export function collectWorldModelHistoryObjectRefs(value, {
  exactObjectRef,
  validateObjectRef,
  isObjectContainer = (candidate) => Boolean(candidate) && typeof candidate === 'object',
  budget = createWorldModelHistoryClosureBudget({ operation: 'reference-discovery' }),
  baseDepth = 0
} = {}) {
  if (typeof exactObjectRef !== 'function' || typeof validateObjectRef !== 'function'
      || typeof isObjectContainer !== 'function') {
    throw new TypeError('World-model retained reference discovery requires reference functions.');
  }
  const refs = [];
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    budget.checkpoint({ depth: baseDepth + current.depth });
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isObjectContainer(current.value)) continue;
    if (exactObjectRef(current.value)) {
      refs.push(validateObjectRef(current.value));
      continue;
    }
    const values = Object.values(current.value);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      stack.push({ value: values[index], depth: current.depth + 1 });
    }
  }
  return refs;
}

/**
 * Iteratively prove a retained-object graph acyclic. Child iteration remains insertion-ordered,
 * matching the former recursive DFS, while active-path indexes avoid copying every ancestor list.
 */
export function assertAcyclicWorldModelHistoryClosure({
  roots,
  childrenOf,
  budget = createWorldModelHistoryClosureBudget({ operation: 'cycle-validation' })
} = {}) {
  if (!roots || typeof roots[Symbol.iterator] !== 'function'
      || typeof childrenOf !== 'function') {
    throw new TypeError('World-model cycle validation requires roots and childrenOf.');
  }
  const completed = new Set();
  const active = [];
  const activeAt = new Map();

  for (const root of roots) {
    if (completed.has(root)) continue;
    const stack = [{ digest: root, entered: false, children: null, index: 0 }];
    while (stack.length) {
      const frame = stack.at(-1);
      budget.checkpoint({ depth: stack.length });
      if (!frame.entered) {
        if (completed.has(frame.digest)) {
          stack.pop();
          continue;
        }
        const cycleStart = activeAt.get(frame.digest);
        if (cycleStart !== undefined) {
          throw new SingularityFlowError(
            `World-model retained-object closure contains a cycle at '${frame.digest}'.`,
            {
              code: 'WMP_INTEGRITY_FAILED',
              details: {
                sha256: frame.digest,
                cycle: [...active.slice(cycleStart), frame.digest]
              }
            }
          );
        }
        frame.entered = true;
        frame.children = [...(childrenOf(frame.digest) ?? [])];
        activeAt.set(frame.digest, active.length);
        active.push(frame.digest);
      }
      if (frame.index < frame.children.length) {
        const child = frame.children[frame.index];
        frame.index += 1;
        if (!completed.has(child)) {
          stack.push({ digest: child, entered: false, children: null, index: 0 });
        }
        continue;
      }
      stack.pop();
      const removed = active.pop();
      activeAt.delete(removed);
      completed.add(frame.digest);
    }
  }
}
