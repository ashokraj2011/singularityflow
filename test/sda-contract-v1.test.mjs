/**
 * The SDA contracts at version 1 (SDA §7, M6).
 *
 * The shared-state contract and the lifecycle authority contract moved from `draft-1` to `v1` in
 * M6, after publication cancellation (B4) and the consistency block (B5) landed and the M6
 * qualification passed (benchmarks/sda/m6-qualification-rollout.md). A version names one meaning:
 * changing a name, capability, qualification or outcome below is a new version (`v2`) with its own
 * review, never an edit of `v1`. Each adapter's own conformance suite (test/sda-conformance.test.mjs,
 * test/sda-lifecycle-conformance.test.mjs) checks that the production adapter declares the version.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_CAPABILITIES, ADAPTER_QUALIFICATIONS, SHARED_STATE_CONTRACT, sharedStateOutcome
} from '../src/sda/shared-state-contract.mjs';
import {
  LIFECYCLE_AUTHORITY_CAPABILITIES, LIFECYCLE_AUTHORITY_CONTRACT, lifecycleAuthorityOutcome
} from '../src/sda/lifecycle-authority-contract.mjs';

const NEW_VERSION = 'changing the v1 contract is a new version with its own review, not an edit of v1';

test('the shared-state contract v1: its name, qualifications, capabilities and outcomes', () => {
  assert.equal(SHARED_STATE_CONTRACT, 'sda-shared-state/v1', NEW_VERSION);
  assert.deepEqual(ADAPTER_QUALIFICATIONS, ['production', 'test-only'], NEW_VERSION);
  assert.deepEqual(ADAPTER_CAPABILITIES, [
    'conditional-append', 'idempotent-append', 'snapshot-pages', 'integrity-verification', 'bounded-pages', 'cancellation'
  ], NEW_VERSION);
  assert.deepEqual(Object.fromEntries([
    'SDA_OPERATION_CANCELLED', 'LEDGER_CHAIN_INVALID', 'LEDGER_CONTINUATION_INVALID', 'LEDGER_CONTINUATION_UNAVAILABLE',
    'LEDGER_PAGE_LIMIT_INVALID', 'SDA_ADAPTER_CAPABILITY_UNSUPPORTED', 'ANYTHING_ELSE'
  ].map((code) => [code, sharedStateOutcome({ code })])), {
    SDA_OPERATION_CANCELLED: 'cancelled', LEDGER_CHAIN_INVALID: 'corrupt', LEDGER_CONTINUATION_INVALID: 'continuation-invalid',
    LEDGER_CONTINUATION_UNAVAILABLE: 'continuation-expired', LEDGER_PAGE_LIMIT_INVALID: 'limit-invalid',
    SDA_ADAPTER_CAPABILITY_UNSUPPORTED: 'unsupported', ANYTHING_ELSE: 'failed'
  }, NEW_VERSION);
  for (const outcomeClass of ['REVISION_CONFLICT', 'OPERATION_ID_REUSE', 'OUTCOME_UNKNOWN']) {
    assert.equal(sharedStateOutcome({ code: 'LEDGER_CHAIN_INVALID', outcomeClass }), outcomeClass, 'a write class wins over the code');
  }
});

test('the lifecycle authority contract v1: its name, capabilities and outcomes', () => {
  assert.equal(LIFECYCLE_AUTHORITY_CONTRACT, 'sda-lifecycle-authority/v1', NEW_VERSION);
  assert.deepEqual(LIFECYCLE_AUTHORITY_CAPABILITIES, ['exact-observation', 'conditional-transition', 'pending-recovery', 'cancellation'], NEW_VERSION);
  assert.deepEqual(Object.fromEntries(['SDA_OPERATION_CANCELLED', 'SDA_ADAPTER_CAPABILITY_UNSUPPORTED', 'PUBLICATION_PENDING', 'ANYTHING_ELSE']
    .map((code) => [code, lifecycleAuthorityOutcome({ code })])), {
    SDA_OPERATION_CANCELLED: 'cancelled', SDA_ADAPTER_CAPABILITY_UNSUPPORTED: 'unsupported',
    PUBLICATION_PENDING: 'pending-recovery', ANYTHING_ELSE: 'failed'
  }, NEW_VERSION);
  // Committed here and refused for another reason: retained for the subject's sync (B4's
  // PUBLICATION_CANCELLED_BEFORE_PUSH reads the same way).
  assert.equal(lifecycleAuthorityOutcome({ code: 'PUBLICATION_CANCELLED_BEFORE_PUSH', publicationRefAdvanced: true }), 'retained-locally');
  assert.equal(lifecycleAuthorityOutcome({ code: 'PUBLICATION_PENDING', publicationRefAdvanced: true, outcomeClass: 'OUTCOME_UNKNOWN' }),
    'OUTCOME_UNKNOWN', 'a write class wins over everything else');
});
