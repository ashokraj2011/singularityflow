import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  TOKEN_REDUCTION_COMPOSITION_FAMILY,
  createTokenReductionCompositionReceipt,
  validateTokenReductionCompositionReceipt
} from '../src/token-reduction/composition-contract.mjs';
import {
  composePromptSectionsWithTokenReduction
} from '../src/token-reduction-prompt-adapter.mjs';
import { defaultTokenReductionContractSet } from '../src/token-reduction/default-contract.mjs';
import { tkrContractReference } from '../src/token-reduction/contracts.mjs';
import { readRecord, schemaFamily } from '../src/schema-migrations.mjs';
import {
  canonicalJson, recordSha256, sealRecord, sha256
} from '../src/world-model/canonicalize.mjs';

const set = defaultTokenReductionContractSet();
const HASH = (character) => `sha256:${character.repeat(64)}`;

function byteDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function ownerBinding(sectionId, sourceText, {
  applicability = 'required', priority = 0, expansionRefs = []
} = {}) {
  const rule = set.logicalComposer.sectionRules.find((entry) => entry.id === sectionId);
  assert.ok(rule);
  const subjectRef = {
    owner: 'sflow-core',
    domain: 'repository:fixture@1111111111111111111111111111111111111111',
    kind: 'prompt-section',
    id: sectionId,
    revision: '1111111111111111111111111111111111111111',
    sourceRef: `git:1111111111111111111111111111111111111111:${sectionId}.md`
  };
  const evidenceRole = rule.permittedRoles[0];
  const requirementRef = `requirement:${sectionId}@1`;
  const bytes = Buffer.from(sourceText, 'utf8');
  const core = {
    kind: 'tkr/prompt-section-owner-binding',
    version: 1,
    sectionId,
    subjectRef,
    applicability,
    applicabilityDecisionRef: null,
    evidenceRole,
    assuranceRef: `assurance:${sectionId}@1`,
    requirementRef,
    coverage: [{
      claimRef: `claim:${sectionId}@1`, subjectRef, evidenceRole, requirementRef
    }],
    sourceRef: subjectRef.sourceRef,
    sourceBytes: sourceText,
    sourceSha256: byteDigest(bytes),
    sourceByteLength: bytes.length,
    expansionRefs,
    limitations: [],
    rendererRef: set.rendererRef,
    priority
  };
  return { ...core, bindingSha256: recordSha256(core) };
}

function candidate() {
  const sections = [
    { id: 'phase-contract', text: '# Phase contract\n\nKeep every requirement.' },
    { id: 'work-source', text: '# Work source\n\nBuild the approved behavior.' }
  ];
  const bindings = new Map(sections.map((entry) => [
    entry.id, ownerBinding(entry.id, entry.text)
  ]));
  return composePromptSectionsWithTokenReduction({
    sections,
    maximumBytes: 4096,
    resolveOwnerBinding: ({ sectionId }) => bindings.get(sectionId)
  });
}

function authority(overrides = {}) {
  return {
    tokenEconomyPolicySha256: HASH('1'),
    phaseContextPolicySha256: HASH('2'),
    workflowSnapshotSha256: HASH('3'),
    sourceSnapshotSha256: HASH('4'),
    composerRef: tkrContractReference(set.composer),
    composerSha256: set.composer.contractSha256,
    contractSetSha256: sha256({
      composer: set.composer,
      contracts: set.contracts,
      rendererContracts: set.rendererContracts
    }),
    ...overrides
  };
}

function subject() {
  return {
    repositoryDomainSha256: HASH('5'),
    workId: 'TKR-101',
    workflowInstanceId: 'workflow-snapshot-101',
    phase: 'implementation',
    generation: 2
  };
}

function reseal(value) {
  return sealRecord(value, 'receiptSha256');
}

test('shadow receipt binds owner inputs, exact segments, and selected prompt without copying text', () => {
  const result = candidate();
  const receipt = createTokenReductionCompositionReceipt({
    activation: 'shadow',
    subject: subject(),
    authority: authority(),
    selectedPrompt: result.composition.content,
    composition: result.composition,
    sectionReport: result.sectionReport
  });

  assert.equal(receipt.activation, 'shadow');
  assert.equal(receipt.relationship, 'identical');
  assert.deepEqual(receipt.selectedPrompt, receipt.candidatePrompt);
  assert.equal(receipt.composition.sha256, receipt.candidatePrompt.sha256);
  assert.equal(receipt.composition.bytes, receipt.candidatePrompt.bytes);
  assert.deepEqual(receipt.composition.segments.map((entry) => entry.sectionId), [
    'phase-contract', 'work-source'
  ]);
  assert.equal(receipt.composition.separators.length, 1);
  assert.equal(receipt.inputs.length, 2);
  assert.equal(receipt.inputs.every((entry) => entry.outcome === 'included'), true);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.composition.segments[0]), true);
  assert.doesNotMatch(canonicalJson(receipt), /Keep every requirement|Build the approved behavior/u);
  assert.deepEqual(validateTokenReductionCompositionReceipt(receipt, {
    selectedPrompt: result.composition.content,
    candidatePrompt: result.composition.content
  }), receipt);
});

test('shadow receipt retains a different selected prompt without granting active authority', () => {
  const result = candidate();
  const selectedPrompt = `${result.composition.content}\n`;
  const receipt = createTokenReductionCompositionReceipt({
    activation: 'shadow',
    subject: subject(),
    authority: authority({
      phaseContextPolicySha256: null,
      workflowSnapshotSha256: null,
      sourceSnapshotSha256: null
    }),
    selectedPrompt,
    composition: result.composition,
    sectionReport: result.sectionReport
  });

  assert.equal(receipt.relationship, 'different');
  assert.notEqual(receipt.selectedPrompt.sha256, receipt.candidatePrompt.sha256);
  assert.doesNotThrow(() => validateTokenReductionCompositionReceipt(receipt, {
    selectedPrompt, candidatePrompt: result.composition.content
  }));
  assert.throws(() => createTokenReductionCompositionReceipt({
    activation: 'active',
    subject: subject(),
    authority: authority(),
    selectedPrompt,
    composition: result.composition,
    sectionReport: result.sectionReport
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED');
});

test('receipt validation refuses changed bytes, structure, authority, and self hashes', () => {
  const result = candidate();
  const receipt = createTokenReductionCompositionReceipt({
    activation: 'shadow', subject: subject(), authority: authority(),
    selectedPrompt: result.composition.content,
    composition: result.composition,
    sectionReport: result.sectionReport
  });
  assert.throws(() => validateTokenReductionCompositionReceipt(receipt, {
    selectedPrompt: `${result.composition.content}!`
  }), (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED');

  const moved = structuredClone(receipt);
  moved.composition.segments[1].start += 1;
  moved.compositionManifestSha256 = sha256(moved.composition);
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(moved)),
    (error) => error.code === 'TKR_RENDER_CONFLICT');

  const wrongComposer = structuredClone(receipt);
  wrongComposer.authority.composerSha256 = HASH('a');
  wrongComposer.authority.composerRef = wrongComposer.authority.composerRef.replace(
    /#sha256:[a-f0-9]{64}$/u, `#${HASH('a')}`
  );
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(wrongComposer)),
    (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED');

  const changed = structuredClone(receipt);
  changed.inputs[0].sourceRef = 'git:changed:phase-contract.md';
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(changed)),
    (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED');

  const forgedSegment = structuredClone(receipt);
  forgedSegment.composition.segments[0].sha256 = HASH('f');
  forgedSegment.inputs[0].finalRenderedRef.sha256 = HASH('f');
  forgedSegment.compositionManifestSha256 = sha256(forgedSegment.composition);
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(forgedSegment), {
    selectedPrompt: result.composition.content,
    candidatePrompt: result.composition.content
  }), (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED');

  const forgedSemantics = structuredClone(receipt);
  forgedSemantics.composition.segments[0].slot = 'source';
  forgedSemantics.compositionManifestSha256 = sha256(forgedSemantics.composition);
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(forgedSemantics)),
    (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED');

  const unregisteredClosure = structuredClone(receipt);
  unregisteredClosure.authority.contractSetSha256 = HASH('e');
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(unregisteredClosure)),
    (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED');

  const unsealed = structuredClone(receipt);
  unsealed.subject.workId = 'TKR-102';
  assert.throws(() => validateTokenReductionCompositionReceipt(unsealed),
    (error) => error.code === 'TKR_RENDER_CONFLICT');
});

test('composition validation requires an exact disjoint input, segment, and omission set', () => {
  const result = candidate();
  const receipt = createTokenReductionCompositionReceipt({
    activation: 'shadow', subject: subject(), authority: authority(),
    selectedPrompt: result.composition.content,
    composition: result.composition,
    sectionReport: result.sectionReport
  });

  const phantomOmission = structuredClone(receipt);
  phantomOmission.composition.omissions.push({
    sectionId: 'phantom-section',
    reason: 'unavailable',
    originalRenderedRef: null,
    expansionRefs: [],
    limitations: [],
    carrierSectionId: null,
    coverageProofSha256: null
  });
  phantomOmission.compositionManifestSha256 = sha256(phantomOmission.composition);
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(phantomOmission)),
    (error) => error.code === 'TKR_RENDER_CONFLICT');

  const liveNotApplicable = structuredClone(receipt);
  Object.assign(liveNotApplicable.inputs[0], {
    applicability: 'not-applicable',
    applicabilityDecisionRef: 'decision:not-applicable@1',
    coverage: [],
    sourceSha256: null,
    sourceByteLength: 0
  });
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(liveNotApplicable)),
    (error) => error.code === 'TKR_COVERAGE_UNPROVEN');
});

test('receipt validation accepts a registered generated omission notice and rebinds its bytes', () => {
  const sections = [
    { id: 'phase-contract', text: '# Phase contract\n\nKeep the required phase boundary.' },
    { id: 'design-sources', text: `# Optional design detail\n\n${'detail '.repeat(1000)}` }
  ];
  const bindings = new Map([
    ['phase-contract', ownerBinding('phase-contract', sections[0].text)],
    ['design-sources', ownerBinding('design-sources', sections[1].text, {
      applicability: 'optional', priority: 100,
      expansionRefs: ['document:design-sources']
    })]
  ]);
  const result = composePromptSectionsWithTokenReduction({
    sections,
    maximumBytes: 2048,
    resolveOwnerBinding: ({ sectionId }) => bindings.get(sectionId)
  });
  assert.ok(result.composition.omissions.some((entry) => (
    entry.sectionId === 'design-sources' && entry.reason === 'budget'
  )));
  assert.ok(result.composition.segments.some((entry) => entry.id === 'omission-notices'));
  const receipt = createTokenReductionCompositionReceipt({
    activation: 'shadow', subject: subject(), authority: authority(),
    selectedPrompt: result.composition.content,
    composition: result.composition,
    sectionReport: result.sectionReport
  });
  assert.doesNotThrow(() => validateTokenReductionCompositionReceipt(receipt, {
    selectedPrompt: result.composition.content
  }));

  const forged = structuredClone(receipt);
  const generated = forged.composition.segments.find((entry) => (
    entry.sectionId === 'omission-notices'
  ));
  generated.sha256 = HASH('d');
  forged.compositionManifestSha256 = sha256(forged.composition);
  assert.throws(() => validateTokenReductionCompositionReceipt(reseal(forged)),
    (error) => error.code === 'TKR_RENDER_CONFLICT');
});

test('composition family and schema are frozen, closed, and pinned to v1', async () => {
  const family = schemaFamily(TOKEN_REDUCTION_COMPOSITION_FAMILY);
  assert.equal(family.currentVersion, 1);
  assert.equal(family.immutable, true);
  assert.equal(family.migrationPolicy, 'frozen-identity');
  const schema = JSON.parse(await readFile(new URL(
    '../schemas/token-reduction-composition.schema.json', import.meta.url
  ), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, family.currentVersion);
  assert.equal(schema.properties.kind.const, 'tkr/composition-receipt');
});

test('prompt-injection v6 migration keeps legacy bytes historical and marks TKR absent', () => {
  const legacy = {
    schemaVersion: 5,
    renderedSha256: HASH('1'),
    executionContext: { mode: 'historical-unproven' },
    sourceComparison: { status: 'historical-unproven', reasonCode: null }
  };
  const migrated = readRecord('prompt-injection', legacy);
  assert.equal(migrated.storedVersion, 5);
  assert.deepEqual(migrated.migratedThrough, [{ from: 5, to: 6 }]);
  assert.equal(migrated.record.schemaVersion, 6);
  assert.equal(migrated.record.renderedSha256, legacy.renderedSha256);
  assert.equal(migrated.record.tokenReduction, null);
  assert.equal(Object.hasOwn(legacy, 'tokenReduction'), false);

  const crafted = {
    ...legacy,
    tokenReduction: { activation: 'active', receiptSha256: HASH('f') },
    promptBudget: {
      tokenReduction: { mode: 'shadow', record: { receiptSha256: HASH('e') } },
      economics: { prompt: {
        tkrCandidatePromptBytes: 1,
        tkrCandidateByteDelta: 999,
        tkrCandidateAssurance: 'forged'
      } }
    }
  };
  const rejectedAuthority = readRecord('prompt-injection', crafted).record;
  assert.equal(rejectedAuthority.tokenReduction, null);
  assert.equal(rejectedAuthority.promptBudget.tokenReduction, undefined);
  assert.deepEqual(rejectedAuthority.promptBudget.economics.prompt, {});
  assert.equal(crafted.tokenReduction.activation, 'active', 'migration does not mutate history');
});
