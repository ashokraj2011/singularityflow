import assert from 'node:assert/strict';
import test from 'node:test';

import { SingularityFlowError } from '../src/util.mjs';
import { SingularityFlowError as FoundationError } from '../src/foundation/failures.mjs';
import * as foundationOutcomes from '../src/foundation/failures.mjs';
import {
  OUTCOME_CLASSES, OUTCOME_CLASS_BY_CODE, OUTCOME_CLASS_BY_STATUS, outcomeClassOf
} from '../src/outcome-classes.mjs';

// These are the existing public meanings, captured before extracting the implementation.
const CODE_CLASSES = {
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
};

test('compatibility imports expose the same constructor, mappings and classifier', () => {
  assert.equal(SingularityFlowError, FoundationError);
  assert.equal(OUTCOME_CLASSES, foundationOutcomes.OUTCOME_CLASSES);
  assert.equal(OUTCOME_CLASS_BY_CODE, foundationOutcomes.OUTCOME_CLASS_BY_CODE);
  assert.equal(OUTCOME_CLASS_BY_STATUS, foundationOutcomes.OUTCOME_CLASS_BY_STATUS);
  assert.equal(outcomeClassOf, foundationOutcomes.outcomeClassOf);
  assert.ok(new SingularityFlowError('legacy') instanceof FoundationError);
  assert.ok(new FoundationError('foundation') instanceof SingularityFlowError);
});

test('the shared error keeps the existing defaults and exact JSON field order', () => {
  const error = new SingularityFlowError('retained failure');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'SingularityFlowError');
  assert.equal(error.message, 'retained failure');
  assert.equal(error.exitCode, 1);
  for (const optional of ['code', 'details', 'cause', 'outcomeClass']) {
    assert.equal(Object.hasOwn(error, optional), false, optional);
  }
  assert.equal(JSON.stringify(error),
    '{"name":"SingularityFlowError","message":"retained failure","exitCode":1}');
});

test('structured details and the original cause survive without serializing the cause', () => {
  const cause = new Error('native failure');
  const details = { operationId: 'operation-1', retained: true };
  const error = new SingularityFlowError('publication pending', {
    code: 'PUBLICATION_REF_OUTCOME_UNKNOWN', exitCode: 7, details, cause
  });
  assert.equal(error.cause, cause);
  assert.equal(error.details, details);
  assert.equal(JSON.stringify(error),
    '{"name":"SingularityFlowError","message":"publication pending","exitCode":7,'
      + '"code":"PUBLICATION_REF_OUTCOME_UNKNOWN","outcomeClass":"OUTCOME_UNKNOWN",'
      + '"details":{"operationId":"operation-1","retained":true}}');
});

test('every existing refusal code retains its write-outcome meaning', () => {
  assert.deepEqual(OUTCOME_CLASSES, ['REVISION_CONFLICT', 'OPERATION_ID_REUSE', 'OUTCOME_UNKNOWN']);
  assert.deepEqual(OUTCOME_CLASS_BY_CODE, CODE_CLASSES);
  for (const [code, expected] of Object.entries(CODE_CLASSES)) {
    assert.equal(outcomeClassOf({ code }), expected, code);
    const error = new SingularityFlowError('refused', { code });
    assert.equal(error.outcomeClass, expected, code);
    assert.equal(error.toJSON().outcomeClass, expected, code);
  }
});

test('saved statuses classify an unknown code, and a known code takes precedence', () => {
  assert.deepEqual(OUTCOME_CLASS_BY_STATUS, {
    'remote-diverged': 'REVISION_CONFLICT',
    'transport-indeterminate': 'OUTCOME_UNKNOWN',
    'outcome-unknown': 'OUTCOME_UNKNOWN'
  });
  for (const [status, expected] of Object.entries(OUTCOME_CLASS_BY_STATUS)) {
    assert.equal(outcomeClassOf({ code: 'UNKNOWN', status }), expected);
    assert.equal(outcomeClassOf({ code: 'IDEMPOTENCY_CONFLICT', status }), 'OPERATION_ID_REUSE');
  }
});

test('unknown codes and prototype names acquire no invented classification', () => {
  for (const code of [null, '', 'UNKNOWN', '__proto__', 'constructor', 'toString']) {
    assert.equal(outcomeClassOf({ code }), null);
    assert.equal(Object.hasOwn(new SingularityFlowError('refused', { code }), 'outcomeClass'), false);
  }
  assert.equal(outcomeClassOf(), null);
  assert.equal(outcomeClassOf({ status: 'constructor' }), null);
});

test('explicit outcome overrides and nullable optional fields keep their original behavior', () => {
  const error = new SingularityFlowError('retained', {
    code: 'IDEMPOTENCY_CONFLICT', outcomeClass: 'OUTCOME_UNKNOWN', exitCode: 0, details: false, cause: null
  });
  assert.equal(error.outcomeClass, 'OUTCOME_UNKNOWN');
  assert.equal(error.exitCode, 0);
  assert.equal(error.details, false);
  assert.equal(error.cause, null);
  assert.equal(new SingularityFlowError('retained', {
    code: 'IDEMPOTENCY_CONFLICT', outcomeClass: null
  }).outcomeClass, 'OPERATION_ID_REUSE');
  assert.equal(Object.hasOwn(new SingularityFlowError('retained', {
    code: 'IDEMPOTENCY_CONFLICT', outcomeClass: ''
  }), 'outcomeClass'), false);
});

test('the public outcome vocabulary remains immutable', () => {
  for (const value of [OUTCOME_CLASSES, OUTCOME_CLASS_BY_CODE, OUTCOME_CLASS_BY_STATUS]) {
    assert.equal(Object.isFrozen(value), true);
  }
});
