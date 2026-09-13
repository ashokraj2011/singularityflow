/**
 * Deterministic, model-free TKR shadow evaluation.
 *
 * Shadow mode deliberately has no authority: it compares an owner-qualified candidate with the
 * exact legacy prompt that will still be persisted and delivered. A failed shadow is diagnostic
 * only and callers must never convert it into a Story lifecycle refusal.
 */
import { composePromptSectionsWithTokenReduction } from '../token-reduction-prompt-adapter.mjs';
import { createTokenReductionCompositionReceipt } from './composition-contract.mjs';
import { defaultTokenReductionContractSet } from './default-contract.mjs';
import { tkrContractReference } from './contracts.mjs';
import { deepFreeze, recordSha256 } from '../world-model/canonicalize.mjs';
import {
  TOKEN_REDUCTION_SHADOW_FORMAT_VERSION,
  TOKEN_REDUCTION_SHADOW_KIND,
  boundedTokenReductionShadowScope,
  tokenReductionShadowDigest,
  tokenReductionShadowFailure,
  verifyTokenReductionShadow
} from './shadow-record.mjs';

export { tokenReductionShadowFailure, verifyTokenReductionShadow } from './shadow-record.mjs';

function candidateSections(sections) {
  return sections.filter((section) => section.canonicalText).map((section) => ({
    id: section.id,
    text: section.canonicalText,
    mandatory: section.mandatory === true,
    priority: Number.isFinite(section.priority) ? section.priority : 100,
    expansionRefs: [...(section.expandHandles ?? [])]
  }));
}

/** Compare a TKR candidate with exact legacy bytes without dispatching or persisting content. */
export function evaluateTokenReductionShadow({
  sections, legacyText, maximumBytes, scope = {}, receiptContext = null
}) {
  if (receiptContext == null) {
    // A candidate without Story/repository/source authority is not evidence. Keep the selected
    // legacy prompt usable, but expose only a content-free unavailable projection rather than
    // reporting unbound byte savings as an observed result.
    return tokenReductionShadowFailure({
      code: 'TKR_SHADOW_AUTHORITY_UNAVAILABLE',
      message: 'Token-reduction shadow authority is unavailable.'
    }, scope);
  }
  const normalized = candidateSections(sections);
  const legacyBytes = Buffer.byteLength(legacyText, 'utf8');
  const contractSet = defaultTokenReductionContractSet();
  const normalizedScope = boundedTokenReductionShadowScope(scope);
  const sourceSetSha256 = recordSha256({
    kind: 'tkr/shadow-source-set',
    version: 1,
    scope: normalizedScope,
    sections: normalized.map((section) => ({
      id: section.id,
      mandatory: section.mandatory,
      priority: section.priority,
      sourceSha256: tokenReductionShadowDigest(section.text),
      sourceByteLength: Buffer.byteLength(section.text, 'utf8'),
      expansionRefs: section.expansionRefs
    }))
  });
  const byId = new Map(normalized.map((section) => [section.id, section]));
  const result = composePromptSectionsWithTokenReduction({
    sections: normalized.map(({ id, text }) => ({ id, text })),
    // Observe the complete candidate even when the configured profile is already over budget.
    // This does not authorize delivery; the configured ceiling remains visible in the receipt.
    maximumBytes: Math.max(maximumBytes, legacyBytes),
    contractSet,
    resolveOwnerBinding(request) {
      const section = byId.get(request.sectionId);
      const rule = contractSet.logicalComposer.sectionRules
        .find((entry) => entry.id === request.sectionId);
      const sourceSha256 = tokenReductionShadowDigest(section.text);
      const sourceByteLength = Buffer.byteLength(section.text, 'utf8');
      const subjectRef = {
        owner: 'sflow-core',
        domain: `tkr-shadow:${sourceSetSha256}`,
        kind: 'prompt-section',
        id: section.id,
        revision: normalizedScope.sourceRevision ?? sourceSetSha256,
        sourceRef: `tkr-shadow:${sourceSetSha256}#${section.id}:${sourceSha256}`
      };
      const evidenceRole = rule.permittedRoles[0];
      const requirementRef = `tkr-composer:${contractSet.composer.contractSha256}#${section.id}`;
      const core = {
        kind: 'tkr/prompt-section-owner-binding',
        version: 1,
        sectionId: section.id,
        subjectRef,
        applicability: section.mandatory ? 'required' : 'optional',
        applicabilityDecisionRef: null,
        evidenceRole,
        assuranceRef: 'assurance:tkr-shadow-owner-boundary-unverified@1',
        requirementRef,
        coverage: [{
          claimRef: `claim:${sourceSha256}`,
          subjectRef,
          evidenceRole,
          requirementRef
        }],
        sourceRef: subjectRef.sourceRef,
        sourceBytes: section.text,
        sourceSha256,
        sourceByteLength,
        expansionRefs: section.expansionRefs,
        limitations: ['shadow candidate only; not delivery or lifecycle authority'],
        rendererRef: contractSet.rendererRef,
        priority: section.priority
      };
      return { ...core, bindingSha256: recordSha256(core) };
    }
  });
  // The frozen TKR composer owns LF-LF separators between sections, but it does not own the
  // legacy transport's final LF. Keep that byte difference visible. Treating transport framing as
  // candidate content would falsely report equality and make a future active adapter ambiguous.
  const candidateText = result.composition.content;
  const candidateRef = {
    sha256: tokenReductionShadowDigest(candidateText),
    bytes: Buffer.byteLength(candidateText, 'utf8')
  };
  const legacyRef = { sha256: tokenReductionShadowDigest(legacyText), bytes: legacyBytes };
  const receipt = createTokenReductionCompositionReceipt({
    activation: 'shadow',
    subject: receiptContext.subject,
    authority: {
      ...receiptContext.authority,
      composerRef: tkrContractReference(contractSet.composer),
      composerSha256: contractSet.composer.contractSha256,
      contractSetSha256: recordSha256({
        composer: contractSet.composer,
        contracts: contractSet.contracts,
        rendererContracts: contractSet.rendererContracts
      })
    },
    selectedPrompt: legacyText,
    composition: result.composition,
    sectionReport: result.sectionReport
  });
  const core = {
    kind: TOKEN_REDUCTION_SHADOW_KIND,
    version: TOKEN_REDUCTION_SHADOW_FORMAT_VERSION,
    status: 'observed',
    scope: normalizedScope,
    sourceSetSha256,
    composerRef: {
      kind: contractSet.composer.kind,
      version: contractSet.composer.version,
      owner: contractSet.composer.owner,
      contractSha256: contractSet.composer.contractSha256
    },
    configuredMaximumBytes: maximumBytes,
    candidateOverflow: candidateRef.bytes > maximumBytes,
    legacyRef,
    candidateRef,
    byteEquivalent: candidateText === legacyText,
    byteDelta: legacyRef.bytes - candidateRef.bytes,
    delivery: {
      state: 'shadow-not-delivered',
      deliveredRef: legacyRef,
      candidateDelivered: false
    },
    receiptSha256: receipt?.receiptSha256 ?? null,
    sectionReport: result.sectionReport
  };
  // The summary hash binds the receipt identity, not a duplicate receipt body. Callers may retain
  // the full immutable receipt under its registered durable owner and keep only this summary in
  // prompt-budget/audit projections.
  return deepFreeze({ ...core, shadowSha256: recordSha256(core), receipt });
}
