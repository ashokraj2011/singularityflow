import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { compilePromptSections } from '../src/prompt-budget.mjs';

function policy(mode, maximumEstimatedPromptTokens = 1024, policyOnBudgetBreach = 'refuse') {
  return {
    enabled: true, mode, profile: 'test',
    profiles: { test: { maximumEstimatedPromptTokens, reservedOutputTokens: 128, maxExpansionTokens: 128, observationCapsuleTokens: 128, policyOnBudgetBreach } }
  };
}

const exactAdmission = {
  tokenCounter: (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
  tokenAdmission: {
    systemAndToolReserveTokens: { value: 0, assurance: 'conservative-upper-bound' },
    historyTokens: { value: 0, assurance: 'conservative-upper-bound' },
    policyApprovedConservativeUpperBound: true
  }
};

test('off and observe preserve identical prompt bytes while still returning honest receipts', () => {
  const sections = [
    { id: 'required', text: '# Required\n\nKeep me.', mandatory: true },
    { id: 'optional', text: '# Optional\n\nKeep me too.' }
  ];
  const off = compilePromptSections(sections, { enabled: false });
  const observe = compilePromptSections(sections, { enabled: true, mode: 'observe' });
  assert.equal(off.text, observe.text);
  assert.equal(off.originalBytes, off.finalBytes);
  assert.equal(observe.originalBytes, observe.finalBytes);
  assert.equal(off.omitted.length, 0);
  assert.equal(observe.admission.logicalPromptTokens.assurance, 'estimated');
});

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
  assert.match(result.text, /# Context omitted under approved policy/);
  assert.match(result.text, /Expand: sfref_example/);
  assert.deepEqual(result.omitted.map((entry) => entry.id), ['expensive']);
  assert.match(result.omitted[0].sha256, /^[a-f0-9]{64}$/);
});

test('enforce refuses when mandatory governed context alone cannot fit', () => {
  assert.throws(
    () => compilePromptSections([
      { id: 'contract', text: 'x'.repeat(5000), mandatory: true }
    ], policy('enforce'), exactAdmission),
    (error) => error.code === 'TKN_MANDATORY_CONTEXT_OVERFLOW'
      && error.details.bySection.contract === 5000
  );
});

test('enforce refuses estimated-only admission even when prompt text appears small', () => {
  assert.throws(
    () => compilePromptSections([{ id: 'contract', text: 'small', mandatory: true }], policy('enforce')),
    (error) => error.code === 'TKN_ADMISSION_ASSURANCE_INSUFFICIENT'
      && error.details.admission.safeToEnforce === false
  );
});

test('partial breach policy preserves mandatory bytes and marks them non-compliant', () => {
  const result = compilePromptSections([
    { id: 'contract', text: 'x'.repeat(5000), mandatory: true },
    { id: 'optional', text: 'optional context' }
  ], policy('enforce', 1024, 'partial'), exactAdmission);
  assert.equal(result.compliance, 'partial-non-compliant');
  assert.match(result.text, /x{100}/);
  assert.match(result.text, /Context omitted under approved policy/);
});

test('assist honors refuse and partial when mandatory prompt text exceeds its estimated budget', () => {
  const sections = [{ id: 'contract', text: 'x'.repeat(5000), mandatory: true }];
  assert.throws(() => compilePromptSections(sections, policy('assist')), (error) => (
    error.code === 'TKN_MANDATORY_CONTEXT_OVERFLOW'
  ));
  const partial = compilePromptSections(sections, policy('assist', 1024, 'partial'));
  assert.equal(partial.compliance, 'partial-non-compliant');
  assert.equal(partial.finalBytes, 5001);
});

test('section identity hashes the exact canonical bytes that are rendered', () => {
  const result = compilePromptSections([{ id: 'canonical', text: '  exact text  \n' }], policy('observe'));
  assert.equal(result.text, 'exact text\n');
  assert.equal(result.sections[0].bytes, Buffer.byteLength('exact text'));
  assert.equal(result.sections[0].sha256, createHash('sha256').update('exact text').digest('hex'));
});

test('section IDs are closed, unique, and reserve kernel-owned names', () => {
  assert.throws(() => compilePromptSections([{ id: '', text: 'x' }], policy('observe')),
    (error) => error.code === 'TKN_SECTION_ID_INVALID');
  assert.throws(() => compilePromptSections([{ id: 'Same', text: 'x' }], policy('observe')),
    (error) => error.code === 'TKN_SECTION_ID_INVALID');
  assert.throws(() => compilePromptSections([
    { id: 'same', text: 'one' }, { id: 'same', text: 'two' }
  ], policy('observe')), (error) => error.code === 'TKN_SECTION_ID_DUPLICATE');
  assert.throws(() => compilePromptSections([{ id: 'kernel-law', text: 'x' }], policy('observe')),
    (error) => error.code === 'TKN_SECTION_ID_RESERVED');
});
