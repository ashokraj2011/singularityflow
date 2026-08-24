import assert from 'node:assert/strict';
import test from 'node:test';

import { qualityValidationVerdict } from '../src/state.mjs';

test('required unavailable quality evidence is unavailable and blocks the gate', () => {
  const result = qualityValidationVerdict([
    { id: 'lint', status: 'skipped-warning', requirement: 'required' }
  ]);
  assert.equal(result.verdict, 'unavailable');
  assert.equal(result.unavailableRequired.length, 1);
});

test('advisory unavailable quality evidence is partial without becoming a required failure', () => {
  const result = qualityValidationVerdict([
    { id: 'compile', status: 'passed', requirement: 'required' },
    { id: 'advice', status: 'skipped-warning', requirement: 'advisory' }
  ]);
  assert.equal(result.verdict, 'partial');
  assert.equal(result.unavailableRequired.length, 0);
});

test('only complete executed quality evidence is passed', () => {
  assert.equal(qualityValidationVerdict([{ id: 'lint', status: 'passed' }]).verdict, 'passed');
  assert.equal(qualityValidationVerdict([{ id: 'lint', status: 'blocked' }]).verdict, 'failed');
  assert.equal(qualityValidationVerdict([]).verdict, 'not-required');
  assert.equal(qualityValidationVerdict([], { required: true }).verdict, 'invalid');
  assert.equal(qualityValidationVerdict([{ id: 'lint', status: 'mispelled' }]).verdict, 'invalid');
});

test('empty evidence and every status outside the closed vocabulary fail explicitly', () => {
  assert.equal(qualityValidationVerdict([]).verdict, 'not-required');
  assert.equal(qualityValidationVerdict([], { required: true }).verdict, 'invalid');
  for (const status of ['cancelled', 'inconclusive', 'future-status', 'passted', '', null]) {
    const result = qualityValidationVerdict([{ id: 'unknown', status }]);
    assert.equal(result.verdict, 'invalid', String(status));
    assert.equal(result.invalid.length, 1, String(status));
    assert.equal(result.failed.length, 1, String(status));
  }
});
