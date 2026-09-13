import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { composeTokenReductionContext } from '../src/token-reduction-composer.mjs';
import { defaultTokenReductionContractSet } from '../src/token-reduction/default-contract.mjs';
import {
  tkrContractReference, tkrLogicalComposerContract, validateTkrContractSet
} from '../src/token-reduction/contracts.mjs';
import {
  TKR_GENERATED_RENDERER_CONTRACT,
  TKR_GENERATED_RENDERER_REF,
  validateTkrGeneratedRendererContract
} from '../src/token-reduction/generated-renderer.mjs';

const SECTION_RULES = Object.freeze([
  ['phase-contract', 'governance', 'policy', 'invariant', []],
  ['work-source', 'source', 'source', 'invariant', []],
  ['active-clause-capsule', 'requirements', 'requirement', 'dynamic', ['phase-contract']],
  ['clarification-protocol', 'interaction', 'interaction-policy', 'dynamic', ['phase-contract']],
  ['governed-agent-policy', 'governance', 'instructions', 'invariant', ['phase-contract']],
  ['mcp-policy', 'tools', 'tool-policy', 'invariant', ['governed-agent-policy']],
  ['design-sources', 'references', 'design-reference', 'dynamic', []],
  ['world-model-status', 'repository-intelligence', 'status', 'dynamic', []],
  ['world-model-grounding', 'repository-intelligence', 'grounding', 'dynamic', []],
  ['reference-repository-grounding', 'repository-intelligence', 'reference-grounding', 'dynamic', []],
  ['capability-world-model', 'repository-intelligence', 'capability-grounding', 'dynamic', []],
  ['optional-ast-context', 'repository-intelligence', 'structural-context', 'dynamic', []],
  ['agent-skills', 'governance', 'skill-instructions', 'invariant', ['governed-agent-policy']],
  ['active-story-evidence', 'evidence', 'story-evidence', 'dynamic', ['phase-contract']],
  ['approved-reference-previews', 'references', 'approved-reference', 'dynamic', []],
  ['stakeholder-change-requests', 'requirements', 'change-request', 'dynamic', ['phase-contract']],
  ['approved-phase-inputs', 'evidence', 'phase-input', 'dynamic', ['phase-contract']]
]);

const SECTION_IDS = Object.freeze(SECTION_RULES.map(([id]) => id));

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function offer(rule, rendererRef, {
  content = `section:${rule.id}`, applicability = 'required', expansionRefs = [], aliasUses = []
} = {}) {
  const claim = `claim:${rule.id}`;
  return {
    sectionId: rule.id,
    subjectRef: {
      owner: 'sflow-core', domain: 'repository:fixture@revision-1', kind: 'prompt-section',
      id: rule.id, revision: 'revision-1', sourceRef: `git:revision-1:${rule.id}`
    },
    evidenceRole: rule.permittedRoles[0],
    assuranceRef: 'assurance:verified-input@1',
    requirementRef: `requirement:${rule.id}@1`,
    applicability,
    permittedRepresentations: ['full'],
    coverage: [claim],
    representations: [{
      representation: 'full', rendererRef, content,
      renderedRef: { sha256: sha256(content), bytes: Buffer.byteLength(content) },
      coverage: [claim], expansionRefs, limitations: [], protectedSpans: [], aliasUses
    }],
    priority: 0,
    limitations: []
  };
}

test('packaged TKR default covers its 17 declared prompt sections in exact order', () => {
  const set = defaultTokenReductionContractSet();
  assert.deepEqual(set.logicalComposer.sectionRules
    .filter((rule) => rule.generator === null).map((rule) => rule.id), SECTION_IDS);
});

test('every default section has its explicit slot, role, stability, and prior-only dependencies', () => {
  const { logicalComposer } = defaultTokenReductionContractSet();
  const inputRules = logicalComposer.sectionRules.filter((rule) => rule.generator === null);
  assert.deepEqual(inputRules.map((rule) => [
    rule.id, rule.slot, rule.permittedRoles[0], rule.stability, rule.dependencies
  ]), SECTION_RULES);
  const prior = new Set();
  for (const rule of inputRules) {
    assert.equal(rule.orderGroup, 'worldmodel-prompt');
    assert.equal(rule.permittedRoles.length, 1);
    assert.equal(rule.generator, null);
    assert.equal(rule.rendererRef, null);
    assert.equal(rule.dependencies.every((dependency) => prior.has(dependency)), true, rule.id);
    prior.add(rule.id);
  }
  assert.deepEqual(logicalComposer.sectionRules.slice(SECTION_IDS.length), [
    {
      id: 'alias-table', slot: 'generated-metadata', orderGroup: 'worldmodel-prompt',
      stability: 'dynamic', permittedRoles: ['alias-table'], dependencies: [],
      generator: 'alias-table', rendererRef: TKR_GENERATED_RENDERER_REF
    },
    {
      id: 'omission-notices', slot: 'generated-metadata', orderGroup: 'worldmodel-prompt',
      stability: 'dynamic', permittedRoles: ['omission-notice'], dependencies: [],
      generator: 'omission-notices', rendererRef: TKR_GENERATED_RENDERER_REF
    }
  ]);
});

test('default rule closure and renderer reference are exact, deterministic, and deeply frozen', () => {
  const first = defaultTokenReductionContractSet();
  const second = defaultTokenReductionContractSet();
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.equal(first.contracts.length, 5);
  assert.deepEqual(validateTkrContractSet(first), {
    composer: first.composer, contracts: first.contracts,
    rendererContracts: first.rendererContracts
  });
  assert.deepEqual(first.logicalComposer,
    tkrLogicalComposerContract(first.composer, {
      contracts: first.contracts, rendererContracts: first.rendererContracts
    }));

  const byKind = new Map(first.contracts.map((contract) => [contract.kind, contract]));
  assert.equal(first.composer.representationRulesRef,
    tkrContractReference(byKind.get('tkr/representation-rules')));
  assert.equal(first.composer.deduplicationRulesRef,
    tkrContractReference(byKind.get('tkr/deduplication-rules')));
  assert.equal(first.composer.protectedTextRulesRef,
    tkrContractReference(byKind.get('tkr/protected-text-rules')));
  assert.equal(first.composer.orderingRulesRef,
    tkrContractReference(byKind.get('tkr/ordering-rules')));
  assert.equal(first.composer.normalizationRulesRef,
    tkrContractReference(byKind.get('tkr/normalization-rules')));
  const rendererPreimage = [
    'worldmodel-prompt-sections.exact-v1', 'section-bytes-unchanged',
    'lf-lf-separator', 'declared-section-order'
  ].join('\0');
  assert.equal(first.rendererRef,
    `sflow-core/tkr/renderer/worldmodel-prompt-sections.exact-v1@1#${sha256(rendererPreimage)}`);
  assert.equal(first.generatedRendererRef, TKR_GENERATED_RENDERER_REF);
  assert.equal(first.generatedRendererContract, TKR_GENERATED_RENDERER_CONTRACT);
  assert.equal(validateTkrGeneratedRendererContract(first.generatedRendererContract),
    TKR_GENERATED_RENDERER_CONTRACT);
  assert.deepEqual(first.composer.renderers, [first.rendererRef, first.generatedRendererRef]);

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.contracts), true);
  assert.equal(Object.isFrozen(first.composer), true);
  assert.equal(Object.isFrozen(first.composer.sectionRules), true);
  assert.equal(Object.isFrozen(first.composer.sectionRules[0]), true);
  assert.equal(Object.isFrozen(first.logicalComposer), true);
  assert.throws(() => { first.composer.sectionRules[0].id = 'changed'; }, TypeError);
});

test('default contract composes all current sections in declared order with the pinned renderer', () => {
  const set = defaultTokenReductionContractSet();
  const result = composeTokenReductionContext({
    contract: set.composer,
    contracts: set.contracts,
    rendererContracts: set.rendererContracts,
    offers: set.logicalComposer.sectionRules.filter((rule) => rule.generator === null)
      .map((rule) => offer(rule, set.rendererRef)).reverse(),
    maximumBytes: 64 * 1024
  });
  assert.deepEqual(result.segments.map((segment) => segment.id), SECTION_IDS);
  assert.deepEqual(result.segments.map((segment) => segment.slot),
    SECTION_RULES.map(([, slot]) => slot));
  assert.deepEqual(result.segments.map((segment) => segment.role),
    SECTION_RULES.map(([, , role]) => role));
  assert.equal(result.segments.every((segment) => segment.rendererRef === set.rendererRef), true);
  assert.equal(result.content, SECTION_IDS.map((id) => `section:${id}`).join('\n\n'));
});

test('default contract renders its pinned alias table and visible optional omission notices', () => {
  const set = defaultTokenReductionContractSet();
  const byId = new Map(set.logicalComposer.sectionRules.map((rule) => [rule.id, rule]));
  const targetRef = {
    owner: 'sflow-core', domain: 'repository:fixture@revision-1', kind: 'prompt-section',
    id: 'phase-contract', revision: 'revision-1', sourceRef: 'git:revision-1:phase-contract'
  };
  const withAlias = composeTokenReductionContext({
    contract: set.composer,
    contracts: set.contracts,
    rendererContracts: set.rendererContracts,
    offers: [offer(byId.get('phase-contract'), set.rendererRef, {
      content: 'section:phase-contract uses S1',
      aliasUses: [{ id: 'S1', scopeRef: 'packet:fixture@1', targetRef }]
    })],
    aliases: [{ id: 'S1', namespace: 'S', scopeRef: 'packet:fixture@1', targetRef }],
    compositionScopeRef: 'packet:fixture@1',
    maximumBytes: 4096
  });
  assert.deepEqual(withAlias.segments.map((segment) => segment.id), [
    'phase-contract', 'alias-table'
  ]);
  const aliasSegment = withAlias.segments[1];
  assert.equal(aliasSegment.role, 'alias-table');
  assert.equal(aliasSegment.rendererRef, set.generatedRendererRef);
  assert.deepEqual(JSON.parse(Buffer.from(withAlias.content).subarray(
    aliasSegment.start, aliasSegment.end
  ).toString('utf8')), {
    entries: [{ id: 'S1', namespace: 'S', scopeRef: 'packet:fixture@1', targetRef }],
    kind: 'tkr/alias-table', scopeRef: 'packet:fixture@1', version: 1
  });

  const expansionRef = 'source:ast-context@revision-1#bytes=0-4096';
  const omitted = composeTokenReductionContext({
    contract: set.composer,
    contracts: set.contracts,
    rendererContracts: set.rendererContracts,
    offers: [
      offer(byId.get('phase-contract'), set.rendererRef),
      offer(byId.get('optional-ast-context'), set.rendererRef, {
        content: `optional AST ${'x'.repeat(4096)}`,
        applicability: 'optional', expansionRefs: [expansionRef]
      })
    ],
    maximumBytes: 2048
  });
  assert.deepEqual(omitted.segments.map((segment) => segment.id), [
    'phase-contract', 'omission-notices'
  ]);
  assert.equal(omitted.omissions[0].sectionId, 'optional-ast-context');
  assert.equal(omitted.omissions[0].reason, 'budget');
  const noticeSegment = omitted.segments[1];
  assert.equal(noticeSegment.role, 'omission-notice');
  assert.equal(noticeSegment.rendererRef, set.generatedRendererRef);
  const notice = JSON.parse(Buffer.from(omitted.content).subarray(
    noticeSegment.start, noticeSegment.end
  ).toString('utf8'));
  assert.equal(notice.kind, 'tkr/omission-notices');
  assert.deepEqual(notice.omissions.map((entry) => ({
    sectionId: entry.sectionId, reason: entry.reason, expansionRefs: entry.expansionRefs
  })), [{ sectionId: 'optional-ast-context', reason: 'budget', expansionRefs: [expansionRef] }]);
});

test('packaged default module has no I/O, environment, clock, or model dependency', async () => {
  const source = await readFile(new URL(
    '../src/token-reduction/default-contract.mjs', import.meta.url
  ), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, [
    './contracts.mjs', './generated-renderer.mjs', './renderer-contracts.mjs'
  ]);
  assert.doesNotMatch(source, /\b(?:readFile|writeFile|fetch|Date|process|invokeModel|model-runner)\b/);
});
