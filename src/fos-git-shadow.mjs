import { compareFosSemanticProjections } from './fos-semantic-projection.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { SingularityFlowError } from './util.mjs';

export const FOS_GIT_SHADOW_OPERATIONS = Object.freeze([
  'workspace.repository-status'
]);

function safeErrorCode(error) {
  const code = String(error?.code ?? 'UNCLASSIFIED');
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : 'UNCLASSIFIED';
}

function observation(operation, outcome, errorCode = null) {
  return Object.freeze({
    schemaVersion: currentSchemaVersion('fos-git-shadow-observation'),
    kind: 'fos-git-shadow-observation',
    operation,
    outcome,
    errorCode,
    authoritativePath: 'reference',
    candidateAuthoritative: false,
    valuesRecorded: false
  });
}

async function emit(record, value) {
  if (typeof record !== 'function') return;
  try { await record(value); }
  catch { incrementCommandCounter('git.shadow-record-failures'); }
}

/**
 * Execute a typed Git candidate behind the unchanged reference result.
 *
 * The comparison never returns either projection, path, branch, remote, OID or error text. A
 * candidate or recorder failure cannot change the reference verdict. This is deliberately not an
 * optimized/on switch: promotion requires separately reviewed evidence and a later code change.
 */
export async function runFosGitShadowRead({
  operation, mode = 'reference', reference, candidate, record = null
} = {}) {
  if (!FOS_GIT_SHADOW_OPERATIONS.includes(operation)) {
    throw new SingularityFlowError(`Unknown FOS Git shadow operation '${operation}'.`, {
      code: 'FOS_GIT_SHADOW_OPERATION_INVALID'
    });
  }
  if (!['reference', 'shadow'].includes(mode)) {
    throw new SingularityFlowError(`Unsupported FOS Git read mode '${mode}'.`, {
      code: 'FOS_GIT_SHADOW_MODE_INVALID'
    });
  }
  if (typeof reference !== 'function' || typeof candidate !== 'function') {
    throw new SingularityFlowError('FOS Git shadow reads require reference and candidate readers.', {
      code: 'FOS_GIT_SHADOW_READER_INVALID'
    });
  }
  const expected = await reference();
  if (mode === 'reference') return Object.freeze({ value: expected, observation: null });

  incrementCommandCounter('git.shadow-comparisons');
  let observed;
  try {
    const actual = await candidate();
    const comparison = compareFosSemanticProjections(expected, actual);
    observed = observation(operation, comparison.equivalent ? 'equivalent' : 'semantic-mismatch');
    incrementCommandCounter(comparison.equivalent
      ? 'git.shadow-equivalent' : 'git.shadow-mismatches');
  } catch (error) {
    observed = observation(operation, 'candidate-error', safeErrorCode(error));
    incrementCommandCounter('git.shadow-candidate-errors');
  }
  await emit(record, observed);
  return Object.freeze({ value: expected, observation: observed });
}

export function summarizeFosGitShadowObservations(values = []) {
  const observations = values.filter((value) => value?.kind === 'fos-git-shadow-observation');
  const counts = { equivalent: 0, semanticMismatch: 0, candidateError: 0 };
  for (const value of observations) {
    if (value.outcome === 'equivalent') counts.equivalent += 1;
    else if (value.outcome === 'semantic-mismatch') counts.semanticMismatch += 1;
    else if (value.outcome === 'candidate-error') counts.candidateError += 1;
  }
  return Object.freeze({
    mode: 'shadow',
    authoritativePath: 'reference',
    comparisons: observations.length,
    ...counts,
    valuesRecorded: false
  });
}
