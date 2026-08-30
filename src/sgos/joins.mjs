import { SingularityFlowError } from '../util.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';

export const SGOS_INSTALLED_JOIN_POLICIES = Object.freeze([
  'all-success', 'all-terminal'
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
    return Object.freeze({ joinId, taskTemplateId, policy, predecessorTaskTemplateIds });
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
  if (join.policy === 'all-success') {
    return Object.freeze({
      ready: states.every((state) => state === 'succeeded'),
      impossible: states.some((state) => TERMINAL.has(state) && state !== 'succeeded')
    });
  }
  return Object.freeze({
    ready: states.every((state) => TERMINAL.has(state)),
    impossible: false
  });
}

export function isSgosTerminalTaskState(value) {
  return TERMINAL.has(value);
}
