import test from 'node:test';
import assert from 'node:assert/strict';
import { maximumActions, questionPrecedesMutation } from '../src/harness-conformance.mjs';

function observedEvent() {
  return {
    invocationId: 'invocation-1', startedAt: '2026-08-07T00:00:00.000Z',
    questions: [{
      questionId: 'confirm', answered: true, answerReceipt: 'receipt-1',
      actionPlanId: 'plan-1', actionId: 'action-1', expiresAt: '2026-08-07T00:10:00.000Z',
      consumedByInvocationId: 'invocation-1'
    }],
    actionsExecuted: [{
      planId: 'plan-1', actionId: 'action-1', questionId: 'confirm',
      answerReceipt: 'receipt-1', authorizationId: 'authorization-1', result: 'succeeded'
    }]
  };
}

test('question checker joins exact identifiers rather than transcript order', () => {
  assert.equal(questionPrecedesMutation(observedEvent()).verdict, 'pass');
  const mismatch = observedEvent(); mismatch.actionsExecuted[0].actionId = 'another-action';
  assert.equal(questionPrecedesMutation(mismatch).verdict, 'fail');
});

test('expired and reused receipts fail while missing observations stay explicit', () => {
  const expired = observedEvent(); expired.questions[0].expiresAt = '2026-08-06T23:59:59.000Z';
  assert.equal(questionPrecedesMutation(expired).verdict, 'fail');
  assert.equal(questionPrecedesMutation({ questions: [], actionsExecuted: [] }).verdict, 'not-observed');
});

test('maximum actions counts successful engine actions, not prose', () => {
  assert.equal(maximumActions({ actionsExecuted: [] }).verdict, 'not-observed');
  assert.equal(maximumActions({ actionsExecuted: [{ result: 'succeeded' }, { result: 'failed' }] }, 1).verdict, 'pass');
  assert.equal(maximumActions({ actionsExecuted: [{ result: 'succeeded' }, { result: 'succeeded' }] }, 1).verdict, 'fail');
});

