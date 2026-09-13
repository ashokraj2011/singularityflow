import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { compilePromptSections } from '../src/prompt-budget.mjs';
import {
  validateTokenReductionCompositionReceipt
} from '../src/token-reduction/composition-contract.mjs';
import {
  evaluateTokenReductionShadow, tokenReductionShadowFailure, verifyTokenReductionShadow
} from '../src/token-reduction/shadow-evaluation.mjs';

const shadowRuntime = { evaluateTokenReductionShadow, tokenReductionShadowFailure };

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
  assert.equal(Object.hasOwn(off.policy, 'composer'), false);
  assert.equal(Object.hasOwn(observe.policy, 'composer'), false);
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

test('enforce rejects partial breach policy before any non-compliant prompt can be transported', () => {
  assert.throws(() => compilePromptSections([
    { id: 'contract', text: 'x'.repeat(5000), mandatory: true },
    { id: 'optional', text: 'optional context' }
  ], policy('enforce', 1024, 'partial'), exactAdmission), (error) => (
    error.code === 'TKN_ENFORCE_PARTIAL_UNSAFE'
  ));
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

test('production compilation refuses tkr-v1 before inspecting or producing prompt bytes', () => {
  for (const mode of ['observe', 'assist', 'enforce']) {
    assert.throws(() => compilePromptSections([
      // Deliberately malformed: the M2 release gate must run before section normalization/rendering.
      { id: '', text: { must: 'never be coerced or rendered' }, mandatory: true }
    ], { ...policy(mode), composer: 'tkr-v1' }), (error) => (
      error.code === 'TKR_CONTRACT_UNSUPPORTED'
        && error.details.composer === 'tkr-v1'
        && error.details.mode === mode
        && error.details.milestone === 'M2'
        && /legacy-v1/.test(error.details.nextAction)
    ));
  }
});

test('disabled token economy with a configured candidate composer keeps legacy bytes and shape', () => {
  const result = compilePromptSections([
    { id: 'canonical', text: '  exact text  \n' }
  ], { enabled: false, composer: 'tkr-v1' });
  assert.equal(result.text, 'exact text\n');
  assert.equal(Object.hasOwn(result.policy, 'composer'), false);
  assert.equal(Object.hasOwn(result.policy, 'configuredComposer'), false);
  assert.equal(Object.hasOwn(result, 'tokenReduction'), false);
});

test('observe can record a deterministic TKR shadow without changing delivered legacy bytes', () => {
  const sections = [
    { id: 'phase-contract', text: '  # Phase\n\nKeep the contract.  ', mandatory: true, priority: 0 },
    { id: 'work-source', text: '# Source\n\nExact source.', mandatory: true, priority: 0 }
  ];
  const options = {
    ...shadowRuntime,
    tokenReductionShadow: true,
    tokenReductionScope: {
      workId: 'WRK-SHADOW', phase: 'specification', generation: 1,
      sourceRevision: 'git:abc123', configurationSha256: `sha256:${'1'.repeat(64)}`,
      executionMode: 'workflow-snapshot'
    },
    tokenReductionReceiptContext: {
      subject: {
        repositoryDomainSha256: `sha256:${'2'.repeat(64)}`,
        workId: 'WRK-SHADOW',
        workflowInstanceId: `sha256:${'3'.repeat(64)}`,
        phase: 'specification',
        generation: 1
      },
      authority: {
        tokenEconomyPolicySha256: `sha256:${'4'.repeat(64)}`,
        phaseContextPolicySha256: `sha256:${'5'.repeat(64)}`,
        workflowSnapshotSha256: `sha256:${'3'.repeat(64)}`,
        sourceSnapshotSha256: `sha256:${'6'.repeat(64)}`
      }
    }
  };
  const first = compilePromptSections(sections, policy('observe'), options);
  const second = compilePromptSections(sections, policy('observe'), options);

  assert.equal(first.text, '# Phase\n\nKeep the contract.\n\n# Source\n\nExact source.\n');
  assert.equal(first.text, second.text);
  assert.equal(first.tokenReduction.mode, 'shadow');
  assert.equal(first.tokenReduction.record.status, 'observed');
  assert.equal(first.tokenReduction.record.byteEquivalent, false);
  assert.equal(first.tokenReduction.record.delivery.state, 'shadow-not-delivered');
  assert.equal(first.tokenReduction.record.delivery.candidateDelivered, false);
  assert.equal(verifyTokenReductionShadow(first.tokenReduction.record), true);
  assert.equal(first.tokenReduction.record.receiptSha256,
    first.tokenReduction.record.receipt.receiptSha256);
  validateTokenReductionCompositionReceipt(first.tokenReduction.record.receipt, {
    selectedPrompt: first.text
  });
  assert.equal(first.tokenReduction.record.shadowSha256,
    second.tokenReduction.record.shadowSha256);
  assert.equal(first.economics.prompt.tkrCandidatePromptBytes, first.finalBytes - 1);
  assert.equal(first.economics.prompt.tkrCandidateByteDelta, 1);
});

test('a TKR shadow failure never blocks or mutates a legacy Story prompt', () => {
  const result = compilePromptSections([
    { id: 'custom-extension', text: 'Existing extension content.', mandatory: true }
  ], policy('observe'), {
    ...shadowRuntime,
    tokenReductionShadow: true,
    tokenReductionScope: { workId: 'WRK-LEGACY', phase: 'custom' }
  });

  assert.equal(result.text, 'Existing extension content.\n');
  assert.equal(result.tokenReduction.record.status, 'unavailable');
  assert.equal(result.tokenReduction.record.delivery.state, 'shadow-not-delivered');
  assert.equal(result.tokenReduction.record.delivery.candidateDelivered, false);
  assert.equal(result.economics.prompt.tkrCandidatePromptBytes, null);
});

test('a broken shadow evaluator and fallback cannot block or alter legacy prompt bytes', () => {
  const sections = [
    { id: 'phase-contract', text: '# Contract\n\nExact legacy context.', mandatory: true }
  ];
  const baseline = compilePromptSections(sections, policy('observe'));
  const degraded = compilePromptSections(sections, policy('observe'), {
    tokenReductionShadow: true,
    evaluateTokenReductionShadow() { throw new Error('optional evaluator unavailable'); },
    tokenReductionShadowFailure() { throw new Error('optional fallback unavailable'); }
  });

  assert.equal(degraded.text, baseline.text);
  assert.equal(degraded.finalBytes, baseline.finalBytes);
  assert.equal(Object.hasOwn(degraded, 'tokenReduction'), false);
});
