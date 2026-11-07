/**
 * Shared failure contract for engine rules, storage contracts and host adapters. No host I/O.
 * Keep this small error/outcome unit together: every host loads it, and splitting it adds a file
 * to each cold closure. Legacy import paths re-export the same constructor and frozen values.
 *
 * - REVISION_CONFLICT: the expected revision no longer holds. Never overwrite it.
 * - OPERATION_ID_REUSE: the operation ID returned with different bytes. Refuse the new payload.
 * - OUTCOME_UNKNOWN: the write may have been accepted. Reconcile its exact operation and digest.
 */
export const OUTCOME_CLASSES = Object.freeze(['REVISION_CONFLICT', 'OPERATION_ID_REUSE', 'OUTCOME_UNKNOWN']);

/** Existing refusal codes keep their public names and meanings (SDA §7.1). */
export const OUTCOME_CLASS_BY_CODE = Object.freeze({
  SGOS_OPERATIONAL_CAS_MISMATCH: 'REVISION_CONFLICT',
  SGOS_AUTHORITY_CAS_MISMATCH: 'REVISION_CONFLICT',
  WCA_DRAFT_CONFLICT: 'REVISION_CONFLICT',
  PUBLICATION_JOURNAL_CONFLICT: 'REVISION_CONFLICT',
  CONFIGURATION_DRAFTS_CHANGED: 'REVISION_CONFLICT',
  PUBLICATION_LOCAL_PARENT_CHANGED: 'REVISION_CONFLICT',
  PUBLICATION_REMOTE_LEASE_PARENT_MISMATCH: 'REVISION_CONFLICT',
  STORY_PUBLICATION_REMOTE_DIVERGED: 'REVISION_CONFLICT',
  WCA_OPERATION_ID_REUSED: 'OPERATION_ID_REUSE',
  CONFIGURATION_DRAFT_OPERATION_REUSED: 'OPERATION_ID_REUSE',
  IDEMPOTENCY_CONFLICT: 'OPERATION_ID_REUSE',
  LEDGER_EVENT_PAYLOAD_CONFLICT: 'OPERATION_ID_REUSE',
  TRANSPORT_OPERATION_ID_REUSED: 'OPERATION_ID_REUSE',
  PUBLICATION_REF_OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  PUBLICATION_OUTCOME_UNVERIFIED: 'OUTCOME_UNKNOWN',
  WCA_DRAFT_WRITE_UNACKNOWLEDGED: 'OUTCOME_UNKNOWN'
});

/** Statuses saved in push and journal records. */
export const OUTCOME_CLASS_BY_STATUS = Object.freeze({
  'remote-diverged': 'REVISION_CONFLICT',
  'transport-indeterminate': 'OUTCOME_UNKNOWN',
  'outcome-unknown': 'OUTCOME_UNKNOWN'
});

export function outcomeClassOf({ code = null, status = null } = {}) {
  return (code != null && Object.hasOwn(OUTCOME_CLASS_BY_CODE, code) ? OUTCOME_CLASS_BY_CODE[code] : null)
    ?? (status != null && Object.hasOwn(OUTCOME_CLASS_BY_STATUS, status) ? OUTCOME_CLASS_BY_STATUS[status] : null);
}

export class SingularityFlowError extends Error {
  constructor(message, { exitCode = 1, code = null, details = null, cause = undefined, outcomeClass = null } = {}) {
    super(message);
    this.name = 'SingularityFlowError';
    this.exitCode = exitCode;
    if (code) this.code = code;
    if (details != null) this.details = details;
    if (cause !== undefined) this.cause = cause;
    // The shared class over existing codes (SDA §7.1); new code may name it directly.
    const classified = outcomeClass ?? outcomeClassOf({ code });
    if (classified) this.outcomeClass = classified;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      exitCode: this.exitCode,
      ...(this.code ? { code: this.code } : {}),
      ...(this.outcomeClass ? { outcomeClass: this.outcomeClass } : {}),
      ...(this.details != null ? { details: this.details } : {})
    };
  }
}
