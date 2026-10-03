import assert from 'node:assert/strict';
import test from 'node:test';

import { bindingsDigest, clauseTagExplanation, reviewBindings } from '../src/implementation-bindings.mjs';

test('the explanation is the text after a clause tag on its comment line', () => {
  assert.equal(clauseTagExplanation('// @clause:W-1:AC-001 — returns 2 instead of 1', 'W-1:AC-001'), 'returns 2 instead of 1');
  assert.equal(clauseTagExplanation('# @clause:W-1:REQ-002: validates input before saving', 'W-1:REQ-002'), 'validates input before saving');
  assert.equal(clauseTagExplanation('/* @clause:W-1:AC-003 keeps the old guard */', 'W-1:AC-003'), 'keeps the old guard');
  assert.equal(clauseTagExplanation('<!-- @clause:W-1:AC-004 shows the banner -->', 'W-1:AC-004'), 'shows the banner');
  assert.equal(clauseTagExplanation('// @clause:W-1:AC-001', 'W-1:AC-001'), null, 'a bare tag explains nothing');
});

test('approving a step accepts each binding as a batch over its digest, or records an exception with its reason', () => {
  const bindings = [{ clauseId: 'W-1:AC-001', explanation: { text: 'returns the approved value', path: 'src/a.mjs', line: 1 }, regions: [] },
    { clauseId: 'W-1:AC-002', explanation: { text: 'keeps the guard in place', path: 'src/b.mjs', line: 4 }, regions: [] }];
  const submitted = { bindings, bindingsSha256: bindingsDigest(bindings) };
  assert.deepEqual(reviewBindings(submitted), {
    bindingsSha256: submitted.bindingsSha256,
    decisions: [{ clauseId: 'W-1:AC-001', decision: 'accepted' }, { clauseId: 'W-1:AC-002', decision: 'accepted' }]
  });
  assert.deepEqual(reviewBindings(submitted, [{ clauseId: 'w-1:ac-002', decision: 'exception', reason: 'The guard is covered by the platform team this sprint.' }]).decisions[1],
    { clauseId: 'W-1:AC-002', decision: 'accepted-with-exception', reason: 'The guard is covered by the platform team this sprint.' });
  assert.throws(() => reviewBindings(submitted, [{ clauseId: 'W-1:AC-009', decision: 'accept' }]), (error) => error.code === 'IMPLEMENTATION_BINDING_UNKNOWN');
  assert.throws(() => reviewBindings(submitted, [{ clauseId: 'W-1:AC-001', decision: 'reject' }]), /reject the step instead/);
  assert.throws(() => reviewBindings(submitted, [{ clauseId: 'W-1:AC-001', decision: 'exception', reason: 'later' }]),
    (error) => error.code === 'IMPLEMENTATION_BINDING_REASON_REQUIRED');
  assert.equal(reviewBindings(null), null, 'a step without bindings has nothing to decide');
  assert.throws(() => reviewBindings(null, [{ clauseId: 'W-1:AC-001', decision: 'accept' }]), (error) => error.code === 'IMPLEMENTATION_BINDING_UNKNOWN');
});
