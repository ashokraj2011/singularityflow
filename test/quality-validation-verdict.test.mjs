import assert from 'node:assert/strict';
import test from 'node:test';

import { qualityValidationVerdict } from '../src/state.mjs';

test('required unavailable quality evidence is partial and blocks the gate', () => {
  const result = qualityValidationVerdict([
    { id: 'lint', status: 'skipped-warning', requirement: 'required' }
  ]);
  assert.equal(result.verdict, 'partial');
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
});
