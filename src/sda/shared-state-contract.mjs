/**
 * The shared-state adapter contract, draft 1 (SDA §7, SDA-AC-017).
 *
 * An event-log adapter appends events under an operation key and reads them back in pages. Every
 * adapter is checked by the same conformance suite (test/helpers/sda-conformance.mjs) for
 * conditional acceptance, idempotency, snapshot pagination, integrity, bounded pages and
 * cancellation. Names and schemas here are a draft for the versioned contract review M1 calls for.
 *
 *   descriptor  { id, contract, qualification, capabilities, limits: { maxPage } }
 *   append(event, { signal })   -> { status: 'accepted' | 'duplicate', id, sequence, comparison? }
 *     event: { eventType, capabilityId?, subject: { workId, phase, generation }, sourceRevision,
 *              actor, payload }
 *   page({ limit, continuation }, { signal }) -> { snapshot, entries, complete, continuation }
 *   verify({ signal })          -> { valid, errors }
 *
 * A refusal is an error whose outcome `sharedStateOutcome` reads: one of the three write classes
 * (outcome-classes.mjs), or `cancelled`, `corrupt`, `continuation-invalid`, `continuation-expired`,
 * `limit-invalid` or `unsupported`. Anything else is `failed`.
 *
 * Only a `production` adapter may be selected as authority. A `test-only` adapter exists for the
 * conformance suite and is refused here, whatever asks.
 */
import { SingularityFlowError } from '../util.mjs';

export const SHARED_STATE_CONTRACT = 'sda-shared-state/draft-1';
export const ADAPTER_QUALIFICATIONS = Object.freeze(['production', 'test-only']);
export const ADAPTER_CAPABILITIES = Object.freeze([
  'conditional-append', 'idempotent-append', 'snapshot-pages', 'integrity-verification', 'bounded-pages', 'cancellation'
]);

const OUTCOME_BY_CODE = Object.freeze({
  SDA_OPERATION_CANCELLED: 'cancelled',
  LEDGER_CHAIN_INVALID: 'corrupt',
  LEDGER_CONTINUATION_INVALID: 'continuation-invalid',
  LEDGER_CONTINUATION_UNAVAILABLE: 'continuation-expired',
  LEDGER_PAGE_LIMIT_INVALID: 'limit-invalid',
  SDA_ADAPTER_CAPABILITY_UNSUPPORTED: 'unsupported'
});

/** The contract outcome of an adapter refusal. */
export function sharedStateOutcome(error) {
  return error?.outcomeClass ?? OUTCOME_BY_CODE[error?.code] ?? 'failed';
}

/** Refuse before any effect when the caller has already cancelled. */
export function assertNotCancelled(signal, operation) {
  if (signal?.aborted) {
    throw new SingularityFlowError(`The ${operation} was cancelled before it changed anything.`, {
      code: 'SDA_OPERATION_CANCELLED', details: { operation }
    });
  }
}

export function adapterDescriptor({ id, qualification, capabilities, limits }) {
  if (!ADAPTER_QUALIFICATIONS.includes(qualification)) throw new TypeError(`Unknown adapter qualification '${qualification}'.`);
  const unknown = capabilities.filter((capability) => !ADAPTER_CAPABILITIES.includes(capability));
  if (unknown.length) throw new TypeError(`Unknown adapter capabilities: ${unknown.join(', ')}.`);
  return Object.freeze({
    id, contract: SHARED_STATE_CONTRACT, qualification,
    capabilities: Object.freeze([...capabilities]), limits: Object.freeze({ ...limits })
  });
}

/**
 * The adapter, if it may serve as shared-state authority. A test-only adapter never may; a missing
 * required capability is refused rather than simulated (§7.3).
 */
export function selectSharedStateAuthority(adapter, { require = [] } = {}) {
  const descriptor = adapter?.descriptor;
  if (descriptor?.contract !== SHARED_STATE_CONTRACT) {
    throw new SingularityFlowError('This adapter does not implement the shared-state contract.', {
      code: 'SDA_ADAPTER_CONTRACT_MISMATCH', details: { contract: descriptor?.contract ?? null }
    });
  }
  if (descriptor.qualification !== 'production') {
    throw new SingularityFlowError(`Adapter '${descriptor.id}' is qualified for tests only and can never be shared-state authority.`, {
      code: 'SDA_ADAPTER_NOT_PRODUCTION', details: { adapter: descriptor.id, qualification: descriptor.qualification }
    });
  }
  const missing = require.filter((capability) => !descriptor.capabilities.includes(capability));
  if (missing.length) {
    throw new SingularityFlowError(`Adapter '${descriptor.id}' does not support ${missing.join(', ')}.`, {
      code: 'SDA_ADAPTER_CAPABILITY_UNSUPPORTED', details: { adapter: descriptor.id, missing }
    });
  }
  return adapter;
}
