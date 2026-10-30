/**
 * One vocabulary over the existing write outcomes (SDA §7.1).
 *
 * The codes and statuses below keep their names, because scripts, tests and older clients read
 * them. Each maps to one of three classes, which new code reads instead of the per-module code.
 * A SingularityFlowError with a mapped code carries its class as `outcomeClass`.
 *
 * - REVISION_CONFLICT: the expected revision no longer holds. Return the current revision; never
 *   overwrite.
 * - OPERATION_ID_REUSE: an operation ID or idempotency key came back with different bytes. The same
 *   ID with the same bytes returns the first outcome; different bytes are refused.
 * - OUTCOME_UNKNOWN: the remote may have accepted the write. Retain it, and reconcile by the exact
 *   operation and digest before any retry or new approval.
 *
 * No imports: util.mjs loads this on every command.
 */
export const OUTCOME_CLASSES = Object.freeze(['REVISION_CONFLICT', 'OPERATION_ID_REUSE', 'OUTCOME_UNKNOWN']);

/** Refusal codes, as thrown or recorded in a result's `failure.code`. */
export const OUTCOME_CLASS_BY_CODE = Object.freeze({
  SGOS_OPERATIONAL_CAS_MISMATCH: 'REVISION_CONFLICT',
  SGOS_AUTHORITY_CAS_MISMATCH: 'REVISION_CONFLICT',
  WCA_DRAFT_CONFLICT: 'REVISION_CONFLICT',
  PUBLICATION_JOURNAL_CONFLICT: 'REVISION_CONFLICT',
  CONFIGURATION_DRAFTS_CHANGED: 'REVISION_CONFLICT',
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
  // A transport intent whose leased push was rejected because the target moved.
  'remote-diverged': 'REVISION_CONFLICT',
  // publicationPushOutcome: the push may have landed before its response was lost.
  'transport-indeterminate': 'OUTCOME_UNKNOWN',
  // Transport intents and the configuration journal.
  'outcome-unknown': 'OUTCOME_UNKNOWN'
});

/** The class of a refusal code or a saved status, or null when it has none. */
export function outcomeClassOf({ code = null, status = null } = {}) {
  return (code != null && Object.hasOwn(OUTCOME_CLASS_BY_CODE, code) ? OUTCOME_CLASS_BY_CODE[code] : null)
    ?? (status != null && Object.hasOwn(OUTCOME_CLASS_BY_STATUS, status) ? OUTCOME_CLASS_BY_STATUS[status] : null);
}
