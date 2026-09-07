import { SingularityFlowError } from '../util.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';

export const SGOS_INSTALLED_JOIN_POLICIES = Object.freeze([
  'all-success', 'all-terminal', 'deterministic-reduce', 'manual-reconcile', 'quorum'
]);

export const SGOS_INSTALLED_JOIN_REDUCERS = Object.freeze([
  'canonical-output-ref-set-v1'
]);

const TERMINAL = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'skipped']);

function fail(message, code = 'SGOS_JOIN_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

export function canonicalSgosJoins(joins = []) {
  const values = Array.isArray(joins)
    ? joins
    : Object.entries(joins ?? {}).map(([joinId, value]) => ({ joinId, ...value }));
  if (values.length > SGOS_INSTALLED_LIMITS.maximumTasks) {
    fail('Join count exceeds the installed task ceiling.', 'SGOS_JOIN_LIMIT');
  }
  const normalized = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Join contracts must be objects.');
    const joinId = String(value.joinId ?? value.taskTemplateId ?? '');
    const taskTemplateId = String(value.taskTemplateId ?? joinId);
    const policy = String(value.policy ?? value.mode ?? '');
    const predecessorTaskTemplateIds = [...new Set(
      (value.predecessorTaskTemplateIds ?? value.dependsOn ?? []).map(String)
    )].sort(compareSgosCodePoints);
    if (!joinId || !taskTemplateId) fail('A join requires joinId and taskTemplateId.');
    if (!SGOS_INSTALLED_JOIN_POLICIES.includes(policy)) {
      fail(`Join '${joinId}' policy '${policy}' is not installed.`,
        'SGOS_JOIN_POLICY_UNSUPPORTED', {
          joinId, policy, installed: SGOS_INSTALLED_JOIN_POLICIES
        });
    }
    if (!predecessorTaskTemplateIds.length
        || predecessorTaskTemplateIds.length > SGOS_INSTALLED_LIMITS.maximumJoinInputs) {
      fail(`Join '${joinId}' has an invalid predecessor count.`, 'SGOS_JOIN_LIMIT', {
        joinId, actual: predecessorTaskTemplateIds.length,
        maximum: SGOS_INSTALLED_LIMITS.maximumJoinInputs
      });
    }
    const suppliedRequiredSuccesses = value.requiredSuccesses ?? value.threshold ?? null;
    const suppliedReducerId = value.reducerId ?? value.reducer ?? null;
    if (policy === 'quorum') {
      if (!Number.isSafeInteger(suppliedRequiredSuccesses)
          || suppliedRequiredSuccesses < 1
          || suppliedRequiredSuccesses > predecessorTaskTemplateIds.length) {
        fail(`Join '${joinId}' quorum must require 1..${predecessorTaskTemplateIds.length} successes.`,
          'SGOS_JOIN_QUORUM_INVALID', {
            joinId, requiredSuccesses: suppliedRequiredSuccesses,
            predecessorCount: predecessorTaskTemplateIds.length
          });
      }
    } else if (suppliedRequiredSuccesses !== null) {
      fail(`Join '${joinId}' may set requiredSuccesses only for policy 'quorum'.`,
        'SGOS_JOIN_QUORUM_INVALID', { joinId, policy });
    }
    if (policy === 'deterministic-reduce') {
      if (!SGOS_INSTALLED_JOIN_REDUCERS.includes(suppliedReducerId)) {
        fail(`Join '${joinId}' reducer '${suppliedReducerId ?? ''}' is not installed.`,
          'SGOS_JOIN_REDUCER_UNSUPPORTED', {
            joinId, reducerId: suppliedReducerId,
            installed: SGOS_INSTALLED_JOIN_REDUCERS
          });
      }
    } else if (suppliedReducerId !== null) {
      fail(`Join '${joinId}' may set reducerId only for policy 'deterministic-reduce'.`,
        'SGOS_JOIN_REDUCER_INVALID', { joinId, policy });
    }
    return Object.freeze({
      joinId, taskTemplateId, policy,
      ...(policy === 'quorum' ? { requiredSuccesses: suppliedRequiredSuccesses } : {}),
      ...(policy === 'deterministic-reduce' ? { reducerId: suppliedReducerId } : {}),
      predecessorTaskTemplateIds
    });
  }).sort((left, right) => compareSgosCodePoints(left.joinId, right.joinId));
  if (new Set(normalized.map((value) => value.joinId)).size !== normalized.length
      || new Set(normalized.map((value) => value.taskTemplateId)).size !== normalized.length) {
    fail('Join IDs and taskTemplateIds must be unique.');
  }
  return Object.freeze(normalized);
}

export function sgosJoinForTask(program, taskTemplateId) {
  return canonicalSgosJoins(program?.joins ?? [])
    .find((join) => join.taskTemplateId === taskTemplateId) ?? null;
}

export function sgosJoinReadiness(join, predecessorStates) {
  if (!join) return Object.freeze({ ready: false, impossible: false });
  const states = [...predecessorStates];
  if (states.length !== join.predecessorTaskTemplateIds.length) {
    fail(`Join '${join.joinId}' predecessor state count does not match its contract.`);
  }
  if (join.policy === 'all-success' || join.policy === 'deterministic-reduce') {
    return Object.freeze({
      ready: states.every((state) => state === 'succeeded'),
      impossible: states.some((state) => TERMINAL.has(state) && state !== 'succeeded')
    });
  }
  if (join.policy === 'quorum') {
    const succeeded = states.filter((state) => state === 'succeeded').length;
    const possible = succeeded + states.filter((state) => !TERMINAL.has(state)).length;
    return Object.freeze({
      ready: succeeded >= join.requiredSuccesses,
      impossible: possible < join.requiredSuccesses
    });
  }
  return Object.freeze({
    ready: states.every((state) => TERMINAL.has(state)),
    impossible: false
  });
}

export function canonicalSgosReducerInputs(inputs = []) {
  if (!Array.isArray(inputs) || !inputs.length
      || inputs.length > SGOS_INSTALLED_LIMITS.maximumJoinInputs) {
    fail('Deterministic reducer inputs have an invalid size.', 'SGOS_JOIN_REDUCER_INVALID');
  }
  const canonical = inputs.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => !['taskInstanceId', 'outputRefs'].includes(key))) {
      fail('Deterministic reducer inputs must contain only taskInstanceId and outputRefs.',
        'SGOS_JOIN_REDUCER_INVALID');
    }
    const taskInstanceId = String(value.taskInstanceId ?? '');
    if (!taskInstanceId || !Array.isArray(value.outputRefs)
        || value.outputRefs.some((entry) => typeof entry !== 'string')) {
      fail('Deterministic reducer inputs require a taskInstanceId and string outputRefs.',
        'SGOS_JOIN_REDUCER_INVALID');
    }
    return Object.freeze({
      taskInstanceId,
      outputRefs: Object.freeze([...new Set(value.outputRefs)].sort(compareSgosCodePoints))
    });
  }).sort((left, right) => compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId));
  if (canonical.some((value, index) =>
    index > 0 && canonical[index - 1].taskInstanceId === value.taskInstanceId)) {
    fail('Deterministic reducer task inputs must be unique.', 'SGOS_JOIN_REDUCER_INVALID');
  }
  return Object.freeze(canonical);
}

export function reduceSgosJoinOutputs(reducerId, inputs) {
  if (!SGOS_INSTALLED_JOIN_REDUCERS.includes(reducerId)) {
    fail(`Join reducer '${reducerId ?? ''}' is not installed.`,
      'SGOS_JOIN_REDUCER_UNSUPPORTED', {
        reducerId: reducerId ?? null, installed: SGOS_INSTALLED_JOIN_REDUCERS
      });
  }
  const canonical = canonicalSgosReducerInputs(inputs);
  if (reducerId === 'canonical-output-ref-set-v1') {
    return Object.freeze([...new Set(canonical.flatMap((entry) => entry.outputRefs))]
      .sort(compareSgosCodePoints));
  }
  fail(`Join reducer '${reducerId}' is not implemented.`, 'SGOS_JOIN_REDUCER_UNSUPPORTED');
}

export function sgosManualReconcileOptions(predecessors = []) {
  if (!Array.isArray(predecessors) || !predecessors.length
      || predecessors.length > SGOS_INSTALLED_LIMITS.maximumJoinInputs) {
    fail('Manual reconciliation predecessors have an invalid size.',
      'SGOS_JOIN_MANUAL_RECONCILE_INVALID');
  }
  const options = predecessors.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.taskInstanceId !== 'string' || !entry.taskInstanceId
        || !TERMINAL.has(entry.state)
        || (entry.receiptSha256 !== null && typeof entry.receiptSha256 !== 'string')
        || (entry.attemptId !== null && typeof entry.attemptId !== 'string')) {
      fail('Manual reconciliation requires exact terminal predecessor identities.',
        'SGOS_JOIN_MANUAL_RECONCILE_INVALID');
    }
    return Object.freeze({
      id: entry.taskInstanceId,
      label: `Use outputs from ${entry.taskInstanceId} (${entry.state})`,
      consequence: `Select only this predecessor's current outputs; receipt=${entry.receiptSha256 ?? 'none'}; attempt=${entry.attemptId ?? 'none'}.`
    });
  }).sort((left, right) => compareSgosCodePoints(left.id, right.id));
  if (options.some((entry, index) => index > 0 && options[index - 1].id === entry.id)) {
    fail('Manual reconciliation predecessors must be unique.',
      'SGOS_JOIN_MANUAL_RECONCILE_INVALID');
  }
  return Object.freeze(options);
}

export function isSgosTerminalTaskState(value) {
  return TERMINAL.has(value);
}
