import test from 'node:test';
import assert from 'node:assert/strict';

import { compilePromptSections } from '../src/prompt-budget.mjs';

function policy(mode, maxInputTokens = 1024) {
  return {
    enabled: true, mode, profile: 'test',
    profiles: { test: { maxInputTokens, reservedOutputTokens: 128, maxExpansionTokens: 128, observationCapsuleTokens: 128, policyOnBudgetBreach: 'refuse' } }
  };
}

test('observe reports a prompt budget overflow without changing transport bytes', () => {
  const source = 'x'.repeat(5000);
  const result = compilePromptSections([{ id: 'optional', text: source }], policy('observe'));
  assert.equal(result.text, `${source}\n`);
  assert.equal(result.overflow, true);
  assert.equal(result.warnings.length, 1);
});

test('assist evicts lowest-priority optional sections and records their exact hashes', () => {
  const result = compilePromptSections([
    { id: 'contract', text: 'contract', mandatory: true, priority: 0 },
    { id: 'valuable', text: `valuable-${'v'.repeat(1900)}`, priority: 10 },
    { id: 'expensive', text: `expensive-${'e'.repeat(3000)}`, priority: 100, expandHandle: 'sfref_example' }
  ], policy('assist'));
  assert.ok(result.finalBytes <= result.policy.maximumBytes);
  assert.match(result.text, /contract/);
  assert.match(result.text, /valuable/);
  assert.doesNotMatch(result.text, /expensive-eee/);
  assert.deepEqual(result.omitted.map((entry) => entry.id), ['expensive']);
  assert.match(result.omitted[0].sha256, /^[a-f0-9]{64}$/);
});

test('enforce refuses when mandatory governed context alone cannot fit', () => {
  assert.throws(
    () => compilePromptSections([
      { id: 'contract', text: 'x'.repeat(5000), mandatory: true }
    ], policy('enforce')),
    (error) => error.code === 'TKN_MANDATORY_CONTEXT_OVERFLOW'
      && error.details.bySection.contract === 5000
  );
});
