/** Lightweight unavailable lifecycle projection embedded in test-execution v4 receipts. */
import { canonicalJson } from './records.mjs';
import { WEL_EXTERNAL_ENFORCEMENT_GAPS } from './wel-readiness-foundation.mjs';

function exactKeys(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...fields].sort());
}

export function unavailableWelTestLifecycle({ observed = false } = {}) {
  return Object.freeze({
    schemaVersion: 1, // schema-transient: embedded in registered test-execution v4.
    status: 'unavailable',
    candidate: null,
    program: null,
    attempt: null,
    retryLineage: Object.freeze([]),
    taskReceipt: null,
    authenticatedExecution: null,
    approval: null,
    publication: null,
    enforcementEligible: false,
    gaps: Object.freeze([
      'WEL_TEST_CANDIDATE_NOT_YET_FROZEN',
      'WEL_SGOS_PROGRAM_NOT_MATERIALIZED',
      'WEL_SGOS_ATTEMPT_NOT_DISPATCHED',
      ...(observed ? [] : ['WEL_EXACT_TEST_OBSERVATION_UNAVAILABLE']),
      ...WEL_EXTERNAL_ENFORCEMENT_GAPS
    ])
  });
}

export function validateWelTestLifecycle(value) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'candidate', 'program', 'attempt', 'retryLineage',
    'taskReceipt', 'authenticatedExecution', 'approval', 'publication',
    'enforcementEligible', 'gaps'
  ])) return false;
  const expectedBase = unavailableWelTestLifecycle({
    observed: !value?.gaps?.includes('WEL_EXACT_TEST_OBSERVATION_UNAVAILABLE')
  });
  return value?.schemaVersion === 1 // schema-transient: nested in migrated test-execution v4.
    && value?.status === 'unavailable'
    && value?.enforcementEligible === false
    && value?.candidate === null && value?.program === null && value?.attempt === null
    && value?.taskReceipt === null && value?.authenticatedExecution === null
    && value?.approval === null && value?.publication === null
    && canonicalJson(value?.retryLineage) === canonicalJson([])
    && canonicalJson(value?.gaps) === canonicalJson(expectedBase.gaps);
}
