/**
 * The lifecycle authority contract, draft 1 (SDA §6.2, §7, M4; ADR 0018 option A).
 *
 * Lifecycle authority answers what a Story, Initiative, ad hoc session or Goal is doing and what its
 * current governed state is. Under ADR 0018 it stays the subject's own branch. M4 puts that branch
 * behind this contract: every lifecycle transition and every observation of the authority's exact
 * revision goes through one adapter (src/sda/story-branch-authority.mjs), so another authority
 * (ADR 0018 options B or C) would implement this contract instead of changing its callers.
 *
 *   descriptor  { id, contract, qualification, capabilities }
 *   observe({ branch, remote }, { signal, allowPrefetched })
 *       -> { branch, state: 'present' | 'absent' | 'unreachable' | 'malformed', revision, ... }
 *   publish(transition, { signal })
 *       -> { sha, pushed, replayed, pending?, event, ledger, candidate, ... }
 *     transition: one lifecycle change, bound to the revision it extends
 *       (`publication.expectedRemoteSha`, or a stated `unleased` reason; SDA-AC-025).
 *   pending(subject, { signal }) -> the transition retained for recovery, or null
 *
 * A refusal reads through `lifecycleAuthorityOutcome`: REVISION_CONFLICT (the authority no longer
 * holds the bound revision), OUTCOME_UNKNOWN (the authority may have accepted it), `pending-recovery`
 * (an earlier transition awaits recovery), `retained-locally` (made here and refused by the authority
 * for another reason; recovery publishes it), `cancelled`, `unsupported`, or `failed`.
 *
 * Only a `production` adapter may be selected as authority; a `test-only` one exists for the
 * conformance suite (test/helpers/sda-lifecycle-conformance.mjs) and is refused here, whatever asks.
 */
import { adapterDescriptor, selectAdapterAuthority } from './shared-state-contract.mjs';

export const LIFECYCLE_AUTHORITY_CONTRACT = 'sda-lifecycle-authority/draft-1';
export const LIFECYCLE_AUTHORITY_CAPABILITIES = Object.freeze([
  'exact-observation', 'conditional-transition', 'pending-recovery', 'cancellation'
]);

const OUTCOME_BY_CODE = Object.freeze({
  SDA_OPERATION_CANCELLED: 'cancelled',
  SDA_ADAPTER_CAPABILITY_UNSUPPORTED: 'unsupported',
  PUBLICATION_PENDING: 'pending-recovery'
});

/** The contract outcome of a lifecycle authority refusal. */
export function lifecycleAuthorityOutcome(error) {
  if (error?.outcomeClass) return error.outcomeClass;
  // Committed here, and the authority refused it for a reason that is neither a moved revision nor
  // a lost response: the retained transition waits for the subject's sync.
  if (error?.publicationRefAdvanced === true) return 'retained-locally';
  return OUTCOME_BY_CODE[error?.code] ?? 'failed';
}

export function lifecycleAuthorityDescriptor({ id, qualification, capabilities }) {
  return adapterDescriptor({
    id, qualification, capabilities, contract: LIFECYCLE_AUTHORITY_CONTRACT, known: LIFECYCLE_AUTHORITY_CAPABILITIES
  });
}

/** The adapter, if it may serve as lifecycle authority. */
export function selectLifecycleAuthority(adapter, { require = LIFECYCLE_AUTHORITY_CAPABILITIES } = {}) {
  return selectAdapterAuthority(adapter, { contract: LIFECYCLE_AUTHORITY_CONTRACT, role: 'lifecycle', require });
}

/** The authority's state in one exact observation of a branch. */
export function observationState(observed) {
  if (!observed?.reachable) return 'unreachable';
  if (observed.malformed) return 'malformed';
  return observed.sha ? 'present' : 'absent';
}
