/**
 * Packaged, deterministic TKR v1 owner-contract set for the current World-Model prompt sections.
 *
 * This module is intentionally pure. It declares an opt-in preview contract; it does not read
 * repository state, select inputs, render bytes, invoke a model, or publish workflow authority.
 */
import {
  createTkrComposerContract,
  createTkrDeduplicationRules,
  createTkrNormalizationRules,
  createTkrOrderingRules,
  createTkrProtectedTextRules,
  createTkrRepresentationRules,
  TKR_COMPOSER_LIMITS,
  tkrContractReference,
  tkrLogicalComposerContract
} from './contracts.mjs';
import {
  TKR_GENERATED_RENDERER_CONTRACT,
  TKR_GENERATED_RENDERER_REF,
  validateTkrGeneratedRendererContract
} from './generated-renderer.mjs';
import {
  createTkrRuntimeRendererRegistration
} from './renderer-contracts.mjs';

const OWNER = 'sflow-core';
const CONTRACT_ID = 'worldmodel-prompt.default';

// SHA-256 of the reviewed renderer identity preimage:
// worldmodel-prompt-sections.exact-v1\0section-bytes-unchanged\0lf-lf-separator\0declared-section-order
const SOURCE_RENDERER_REF = 'sflow-core/tkr/renderer/worldmodel-prompt-sections.exact-v1@1#sha256:98657de72ac6449849a788ed0a740e1cb8c1333284dce873b16784b12b066237';

export const TKR_SOURCE_RENDERER_REGISTRATION = createTkrRuntimeRendererRegistration({
  owner: OWNER,
  rendererId: 'worldmodel-prompt-sections.exact-v1',
  rendererRef: SOURCE_RENDERER_REF,
  mode: 'source-pass-through',
  format: 'literal-utf8',
  implementationSha256: 'sha256:98657de72ac6449849a788ed0a740e1cb8c1333284dce873b16784b12b066237'
});

export const TKR_GENERATED_RENDERER_REGISTRATION = createTkrRuntimeRendererRegistration({
  owner: TKR_GENERATED_RENDERER_CONTRACT.owner,
  rendererId: TKR_GENERATED_RENDERER_CONTRACT.rendererId,
  rendererRef: TKR_GENERATED_RENDERER_REF,
  mode: 'generated-framing',
  format: 'canonical-json-utf8',
  implementationSha256: TKR_GENERATED_RENDERER_CONTRACT.contractSha256
});

export const TKR_DEFAULT_RENDERER_CONTRACTS = Object.freeze([
  TKR_SOURCE_RENDERER_REGISTRATION,
  TKR_GENERATED_RENDERER_REGISTRATION
]);

function section(id, {
  slot, role, stability = 'dynamic', dependencies = [],
  generator = null, rendererRef = null
}) {
  return {
    id,
    slot,
    orderGroup: 'worldmodel-prompt',
    stability,
    permittedRoles: [role],
    dependencies,
    generator,
    rendererRef
  };
}

/**
 * Build the frozen packaged TKR v1 owner closure.
 *
 * A fresh value is returned so callers cannot share mutable container identity. Every durable
 * contract and its logical projection are deeply frozen by the registered contract builders.
 */
export function defaultTokenReductionContractSet() {
  const common = { owner: OWNER, contractId: CONTRACT_ID };
  const contracts = Object.freeze([
    createTkrRepresentationRules({
      ...common,
      representations: [
        { id: 'full', completeness: 'complete', expansion: 'not-required' },
        { id: 'exact-excerpt', completeness: 'selected', expansion: 'required' },
        { id: 'deterministic-brief', completeness: 'selected', expansion: 'required' },
        { id: 'reference-only', completeness: 'selected', expansion: 'required' }
      ],
      undeclaredInputBehavior: 'preserve-existing-required-representation',
      emptyContentBehavior: 'refuse',
      unknownRequiredApplicabilityBehavior: 'refuse'
    }),
    createTkrDeduplicationRules({
      ...common,
      identity: 'owner-qualified-subject-revision-role',
      textEqualitySufficient: false,
      coverageProofRequired: true,
      revalidateAfterBudgeting: true,
      carrierRemoval: 'refuse-when-required-claims-depend'
    }),
    createTkrProtectedTextRules({
      ...common,
      sourceModes: ['verbatim', 'lossless-encoded'],
      normalizationScope: 'generated-framing-only',
      continuityProofRequired: true,
      verifyAfterComposition: true
    }),
    createTkrOrderingRules({
      ...common,
      stableOrder: 'declared-section-order',
      dynamicOrder: 'purpose-rule-qualified-subject',
      dependencyPolicy: 'preserve',
      rolePolicy: 'preserve',
      setOrdering: 'unicode-code-point'
    }),
    createTkrNormalizationRules({
      ...common,
      scope: 'generated-framing-only',
      sourceBytes: 'unchanged',
      authorityBytes: 'unchanged',
      generatedLineEndings: 'lf',
      generatedWhitespace: 'preserve'
    })
  ]);
  const byKind = new Map(contracts.map((contract) => [contract.kind, contract]));
  const composer = createTkrComposerContract({
    ...common,
    sectionRules: [
      section('phase-contract', {
        slot: 'governance', role: 'policy', stability: 'invariant'
      }),
      section('work-source', {
        slot: 'source', role: 'source', stability: 'invariant'
      }),
      section('active-clause-capsule', {
        slot: 'requirements', role: 'requirement', dependencies: ['phase-contract']
      }),
      section('clarification-protocol', {
        slot: 'interaction', role: 'interaction-policy', dependencies: ['phase-contract']
      }),
      section('governed-agent-policy', {
        slot: 'governance', role: 'instructions', stability: 'invariant',
        dependencies: ['phase-contract']
      }),
      section('mcp-policy', {
        slot: 'tools', role: 'tool-policy', stability: 'invariant',
        dependencies: ['governed-agent-policy']
      }),
      section('design-sources', {
        slot: 'references', role: 'design-reference'
      }),
      section('world-model-status', {
        slot: 'repository-intelligence', role: 'status'
      }),
      section('world-model-grounding', {
        slot: 'repository-intelligence', role: 'grounding'
      }),
      section('reference-repository-grounding', {
        slot: 'repository-intelligence', role: 'reference-grounding'
      }),
      section('capability-world-model', {
        slot: 'repository-intelligence', role: 'capability-grounding'
      }),
      section('optional-ast-context', {
        slot: 'repository-intelligence', role: 'structural-context'
      }),
      section('agent-skills', {
        slot: 'governance', role: 'skill-instructions', stability: 'invariant',
        dependencies: ['governed-agent-policy']
      }),
      section('active-story-evidence', {
        slot: 'evidence', role: 'story-evidence', dependencies: ['phase-contract']
      }),
      section('approved-reference-previews', {
        slot: 'references', role: 'approved-reference'
      }),
      section('stakeholder-change-requests', {
        slot: 'requirements', role: 'change-request', dependencies: ['phase-contract']
      }),
      section('approved-phase-inputs', {
        slot: 'evidence', role: 'phase-input', dependencies: ['phase-contract']
      }),
      section('alias-table', {
        slot: 'generated-metadata', role: 'alias-table',
        generator: 'alias-table', rendererRef: TKR_GENERATED_RENDERER_REF
      }),
      section('omission-notices', {
        slot: 'generated-metadata', role: 'omission-notice',
        generator: 'omission-notices', rendererRef: TKR_GENERATED_RENDERER_REF
      })
    ],
    representationRulesRef: tkrContractReference(byKind.get('tkr/representation-rules')),
    deduplicationRulesRef: tkrContractReference(byKind.get('tkr/deduplication-rules')),
    renderers: [SOURCE_RENDERER_REF, TKR_GENERATED_RENDERER_REF],
    protectedTextRulesRef: tkrContractReference(byKind.get('tkr/protected-text-rules')),
    orderingRulesRef: tkrContractReference(byKind.get('tkr/ordering-rules')),
    normalizationRulesRef: tkrContractReference(byKind.get('tkr/normalization-rules')),
    limits: { ...TKR_COMPOSER_LIMITS }
  }, { contracts, rendererContracts: TKR_DEFAULT_RENDERER_CONTRACTS });
  const logicalComposer = tkrLogicalComposerContract(composer, {
    contracts,
    rendererContracts: TKR_DEFAULT_RENDERER_CONTRACTS
  });
  validateTkrGeneratedRendererContract(TKR_GENERATED_RENDERER_CONTRACT);
  return Object.freeze({
    composer,
    contracts,
    rendererContracts: TKR_DEFAULT_RENDERER_CONTRACTS,
    logicalComposer,
    rendererRef: SOURCE_RENDERER_REF,
    generatedRendererRef: TKR_GENERATED_RENDERER_REF,
    generatedRendererContract: TKR_GENERATED_RENDERER_CONTRACT
  });
}
