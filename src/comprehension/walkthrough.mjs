/** Deterministic, observe-only CMP walkthrough draft validation. */
import { createHash } from 'node:crypto';

import { recordSha256 } from '../records.mjs';
import { validateChangeRegionManifest } from './contracts.mjs';

export const CMP_WALKTHROUGH_CLAIM_CLASSES = Object.freeze([
  'structural-fact', 'diff-fact', 'evidence-supported', 'human-judgment', 'model-advisory'
]);

export const CMP_WALKTHROUGH_ASSERTION_TYPES = Object.freeze([
  'symbol-exists', 'symbol-changed', 'file-changed', 'call-edge', 'reference-edge',
  'implements-interface', 'dependency-added', 'dependency-removed', 'test-symbol-reference',
  'region-cause-binding', 'evidence-reference-exists', 'evidence-subject-match',
  'candidate-subject-match'
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const CLAIM_ID = /^WCL-[A-Z0-9][A-Z0-9._:-]{0,63}$/u;
const MAXIMUM_CLAIMS = 500;
const MAXIMUM_DRAFT_BYTES = 1024 * 1024;
const MAXIMUM_NARRATIVE_BYTES = 128 * 1024;
const MAXIMUM_TEXT_BYTES = 4096;
const MAXIMUM_REFS = 64;
const MAXIMUM_RESULT_SOURCES = 256;
const MAXIMUM_VALIDATION_BYTES = 4 * 1024 * 1024;
const DEPENDENCY_KEYS = Object.freeze([
  'causeGraphSha256', 'changeRegionManifestSha256', 'structuralViewManifestSha256',
  'evidenceManifestSha256', 'policySha256', 'extractorVersionsSha256'
]);
const ASSERTIONS_BY_CLASS = Object.freeze({
  'structural-fact': new Set([
    'symbol-exists', 'symbol-changed', 'call-edge', 'reference-edge',
    'implements-interface', 'dependency-added', 'dependency-removed', 'test-symbol-reference'
  ]),
  'diff-fact': new Set(['file-changed', 'dependency-added', 'dependency-removed']),
  'evidence-supported': new Set([
    'evidence-reference-exists', 'evidence-subject-match', 'test-symbol-reference'
  ]),
  'human-judgment': new Set(['region-cause-binding', 'candidate-subject-match']),
  'model-advisory': new Set(CMP_WALKTHROUGH_ASSERTION_TYPES)
});

function plain(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeDeep(value) {
  if (value == null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function hash(value) {
  return `sha256:${recordSha256(value)}`;
}

function textHash(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function without(value, ...keys) {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function exactKeys(value, keys) {
  return plain(value)
    && Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000');
}

function diagnostic(code, claimId, message) {
  return { code, claimId, message };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueStrings(values, { prefix = null } = {}) {
  if (!Array.isArray(values) || values.length > MAXIMUM_REFS) return null;
  const normalized = values.map((value) => String(value ?? ''));
  if (normalized.some((value) => !value || value.length > 4096 || value.includes('\0')
      || (prefix != null && !value.startsWith(prefix)))) return null;
  const sorted = [...new Set(normalized)].sort();
  return sorted.length === normalized.length
    && sorted.every((value, index) => value === normalized[index]) ? sorted : null;
}

function validateGraph(graph, manifest) {
  if (!plain(graph) || graph.kind !== 'comprehension-intent-graph'
      || graph.candidateSha256 !== manifest.compatibilityCandidateSha256
      || graph.manifestSha256 !== manifest.manifestSha256
      || !SHA256.test(String(graph.graphSha256 ?? ''))
      || hash(without(graph, 'graphSha256')) !== graph.graphSha256) return false;
  return true;
}

function validateDependencyManifest(value, manifest, graph) {
  if (!exactKeys(value, DEPENDENCY_KEYS)
      || value.changeRegionManifestSha256 !== manifest.manifestSha256
      || value.causeGraphSha256 !== graph.graphSha256) return false;
  return DEPENDENCY_KEYS.every((key) => value[key] === null || SHA256.test(String(value[key])));
}

function normalizedDependencies(value) {
  return Object.fromEntries(DEPENDENCY_KEYS.map((key) => [
    key, SHA256.test(String(value?.[key] ?? '')) ? value[key] : null
  ]));
}

function claimDependencyKeys(claim, { regions, causes, evidence }) {
  const keys = new Set();
  if (regions.length || claim.claimClass === 'diff-fact') {
    keys.add('changeRegionManifestSha256');
  }
  if (causes.length || claim.claimClass === 'human-judgment') {
    keys.add('causeGraphSha256');
  }
  if (evidence.length || claim.claimClass === 'evidence-supported') {
    keys.add('evidenceManifestSha256');
  }
  if (claim.claimClass === 'structural-fact') {
    keys.add('structuralViewManifestSha256');
    keys.add('extractorVersionsSha256');
  }
  if (claim.claimClass === 'human-judgment') keys.add('policySha256');
  return [...keys].sort(compareText);
}

function regionSources(manifest, refs) {
  return refs.map((reference) => manifest.regions.find((region) =>
    region.regionId === reference || region.regionSha256 === reference)).filter(Boolean);
}

function sourceForRegion(region) {
  return {
    kind: 'change-region',
    regionId: region.regionId,
    regionSha256: region.regionSha256,
    pathBefore: region.location.pathBefore,
    pathAfter: region.location.pathAfter
  };
}

function evaluateClaim(claim, manifest, dependencyManifest, sourceBudget) {
  const diagnostics = [];
  const claimId = typeof claim?.claimId === 'string' ? claim.claimId : null;
  const fail = (code, message) => diagnostics.push(diagnostic(code, claimId, message));
  const shape = [
    'schemaVersion', 'kind', 'claimId', 'text', 'textSha256', 'claimClass',
    'assertionType', 'subjectRefs', 'regionRefs', 'causeRefs', 'evidenceRefs',
    'verification', 'assurance', 'claimSha256'
  ];
  if (!exactKeys(claim, shape) || claim.schemaVersion !== 1 // schema-transient: untrusted draft input, never persisted or authorized
      || claim.kind !== 'walkthrough-claim') {
    fail('CMP_WALKTHROUGH_SCHEMA_INVALID', 'Walkthrough claim shape or transport schema is invalid.');
    return { claimId, claimSha256: claim?.claimSha256 ?? null,
      status: 'invalid', assurance: 'contradicted', dependencyKeys: [], sources: [], diagnostics };
  }
  if (!CLAIM_ID.test(claim.claimId)
      || typeof claim.text !== 'string' || !claim.text.trim()
      || Buffer.byteLength(claim.text, 'utf8') > MAXIMUM_TEXT_BYTES
      || claim.textSha256 !== textHash(claim.text)) {
    fail('CMP_WALKTHROUGH_SCHEMA_INVALID', 'Claim identity, text, or text digest is invalid.');
  }
  if (!CMP_WALKTHROUGH_CLAIM_CLASSES.includes(claim.claimClass)
      || !CMP_WALKTHROUGH_ASSERTION_TYPES.includes(claim.assertionType)) {
    fail('CMP_WALKTHROUGH_CLAIM_CLASS_INVALID', 'Claim class or assertion type is not registered.');
  } else if (!ASSERTIONS_BY_CLASS[claim.claimClass].has(claim.assertionType)) {
    fail('CMP_WALKTHROUGH_CLAIM_CLASS_INVALID',
      'The assertion type is incompatible with its declared claim class.');
  }
  if (!exactKeys(claim.verification, ['status', 'verifier', 'resultSha256'])
      || !['proposed', 'unavailable'].includes(claim.verification.status)
      || claim.verification.verifier !== null || claim.verification.resultSha256 !== null
      || (claim.claimClass === 'model-advisory'
        ? claim.assurance !== 'model-advisory' : claim.assurance !== 'unavailable')) {
    fail('CMP_WALKTHROUGH_ASSURANCE_INVALID', 'A draft cannot self-claim verification or governing assurance.');
  }
  if (claim.claimSha256 !== hash(without(claim, 'claimSha256'))) {
    fail('CMP_WALKTHROUGH_INTEGRITY_INVALID', 'Claim content hash is invalid.');
  }
  const subjects = sortedUniqueStrings(claim.subjectRefs);
  const regions = sortedUniqueStrings(claim.regionRefs);
  const causes = sortedUniqueStrings(claim.causeRefs);
  const evidence = sortedUniqueStrings(claim.evidenceRefs);
  if ([subjects, regions, causes, evidence].some((value) => value === null)) {
    fail('CMP_WALKTHROUGH_REFERENCE_INVALID', 'Claim references must be bounded, sorted, unique strings.');
  }
  if (diagnostics.length) {
    return { claimId, claimSha256: claim.claimSha256,
      claimClass: claim.claimClass, assertionType: claim.assertionType,
      status: 'invalid', assurance: 'contradicted', dependencyKeys: [], sources: [], diagnostics };
  }

  const dependencyKeys = claimDependencyKeys(claim, { regions, causes, evidence });
  const candidateSource = {
    kind: 'compatibility-candidate', sha256: manifest.compatibilityCandidateSha256
  };
  const matchedRegions = regionSources(manifest, regions);
  if (matchedRegions.length !== regions.length) {
    fail('CMP_WALKTHROUGH_REFERENCE_INVALID', 'One or more region references do not exist in the exact manifest.');
  }
  if (claim.claimClass === 'diff-fact' && claim.assertionType === 'file-changed') {
    if (!regions.length || matchedRegions.length !== regions.length) {
      return { claimId, claimSha256: claim.claimSha256,
        claimClass: claim.claimClass, assertionType: claim.assertionType,
        status: 'contradicted', assurance: 'contradicted', dependencyKeys, sources: [], diagnostics };
    }
    const paths = new Set(matchedRegions.flatMap((region) => [
      region.location.pathBefore, region.location.pathAfter
    ]).filter(Boolean).map((value) => `file:${value}`));
    if (!subjects.length || subjects.some((subject) => !paths.has(subject))) {
      fail('CMP_WALKTHROUGH_REFERENCE_INVALID', 'A file-changed claim must cite exact files from its regions.');
      return { claimId, claimSha256: claim.claimSha256,
        claimClass: claim.claimClass, assertionType: claim.assertionType,
        status: 'contradicted', assurance: 'contradicted', dependencyKeys, sources: [], diagnostics };
    }
    if (matchedRegions.length > sourceBudget.remaining) {
      fail('CMP_WALKTHROUGH_LIMIT',
        `Walkthrough validation exceeds the ${MAXIMUM_RESULT_SOURCES}-source result boundary.`);
      return { claimId, claimSha256: claim.claimSha256,
        claimClass: claim.claimClass, assertionType: claim.assertionType,
        status: 'invalid', assurance: 'contradicted', dependencyKeys, sources: [], diagnostics };
    }
    sourceBudget.remaining -= matchedRegions.length;
    const sources = matchedRegions.map(sourceForRegion);
    const resultSha256 = hash({
      verifier: 'cmp-exact-region-file-change-v1', candidateSha256: manifest.candidateSha256,
      claimSha256: claim.claimSha256, sources
    });
    return { claimId, claimSha256: claim.claimSha256,
      claimClass: claim.claimClass, assertionType: claim.assertionType,
      status: 'passed', assurance: 'diff-verified',
      verification: { verifier: 'cmp-exact-region-file-change-v1', resultSha256 },
      dependencyKeys, sources, diagnostics };
  }
  if (claim.claimClass === 'model-advisory') {
    if (sourceBudget.remaining < 1) {
      fail('CMP_WALKTHROUGH_LIMIT',
        `Walkthrough validation exceeds the ${MAXIMUM_RESULT_SOURCES}-source result boundary.`);
      return { claimId, claimSha256: claim.claimSha256,
        claimClass: claim.claimClass, assertionType: claim.assertionType,
        status: 'invalid', assurance: 'contradicted', dependencyKeys, sources: [], diagnostics };
    }
    sourceBudget.remaining -= 1;
    return { claimId, claimSha256: claim.claimSha256,
      claimClass: claim.claimClass, assertionType: claim.assertionType,
      status: 'advisory', assurance: 'model-advisory', dependencyKeys,
      sources: [candidateSource], diagnostics };
  }
  if (claim.claimClass === 'structural-fact') {
    diagnostics.push(diagnostic('CMP_STRUCTURE_UNAVAILABLE', claimId,
      dependencyManifest.structuralViewManifestSha256 == null
        ? 'No structural view is available; the claim was not treated as false or verified.'
        : 'This structural assertion type has no installed deterministic validator.'));
  } else if (claim.claimClass === 'evidence-supported') {
    diagnostics.push(diagnostic('CMP_WALKTHROUGH_EVIDENCE_UNAVAILABLE', claimId,
      'No P2-authoritative evidence resolver is installed; the claim remains unavailable.'));
  } else if (claim.claimClass === 'human-judgment') {
    diagnostics.push(diagnostic('CMP_WALKTHROUGH_DECISION_UNAVAILABLE', claimId,
      'No P2-authoritative human decision resolver is installed; the judgment remains unavailable.'));
  } else {
    diagnostics.push(diagnostic('CMP_WALKTHROUGH_VALIDATOR_UNAVAILABLE', claimId,
      'No deterministic validator is installed for this claim class and assertion type.'));
  }
  if (matchedRegions.length + 1 > sourceBudget.remaining) {
    diagnostics.push(diagnostic('CMP_WALKTHROUGH_LIMIT', claimId,
      `Walkthrough validation exceeds the ${MAXIMUM_RESULT_SOURCES}-source result boundary.`));
    return { claimId, claimSha256: claim.claimSha256,
      claimClass: claim.claimClass, assertionType: claim.assertionType,
      status: 'invalid', assurance: 'contradicted', dependencyKeys, sources: [], diagnostics };
  }
  sourceBudget.remaining -= matchedRegions.length + 1;
  return { claimId, claimSha256: claim.claimSha256,
    claimClass: claim.claimClass, assertionType: claim.assertionType,
    status: 'unavailable', assurance: 'unavailable',
    dependencyKeys, sources: [candidateSource, ...matchedRegions.map(sourceForRegion)], diagnostics };
}

/**
 * Validate an untrusted walkthrough draft without writing or granting authority.
 * Only exact resource-level file-change claims can pass in the current pilot.
 */
export function validateComprehensionWalkthroughDraft(draft, { manifest, graph } = {}) {
  const diagnostics = [];
  const fail = (code, message) => diagnostics.push(diagnostic(code, null, message));
  const shape = [
    'schemaVersion', 'kind', 'walkthroughId', 'subject', 'audience', 'mode', 'narrative',
    'claims', 'dependencyManifest', 'dependencyManifestSha256', 'draftSha256'
  ];
  const manifestValidation = validateChangeRegionManifest(manifest);
  if (!manifestValidation.valid) fail('CMP_WALKTHROUGH_REFERENCE_INVALID',
    'The walkthrough requires one exact valid change-region manifest.');
  if (!validateGraph(graph, manifest ?? {})) fail('CMP_WALKTHROUGH_REFERENCE_INVALID',
    'The walkthrough requires one exact graph derived from the selected manifest.');
  if (!exactKeys(draft, shape) || draft.schemaVersion !== 1 // schema-transient: untrusted draft input, never persisted or authorized
      || draft.kind !== 'comprehension-walkthrough-draft') {
    fail('CMP_WALKTHROUGH_SCHEMA_INVALID', 'Walkthrough draft shape or transport schema is invalid.');
  }
  if (Buffer.byteLength(JSON.stringify(draft ?? null), 'utf8') > MAXIMUM_DRAFT_BYTES) {
    fail('CMP_WALKTHROUGH_LIMIT',
      `Walkthrough draft exceeds the ${MAXIMUM_DRAFT_BYTES}-byte validation boundary.`);
  }
  if (!plain(draft?.subject)
      || !exactKeys(draft.subject, ['candidateSha256', 'sourceTreeSha256'])
      || draft.subject.candidateSha256 !== manifest?.compatibilityCandidateSha256
      || (draft.subject.sourceTreeSha256 !== null
        && !SHA256.test(String(draft.subject.sourceTreeSha256)))) {
    fail('CMP_WALKTHROUGH_CANDIDATE_INVALID', 'Walkthrough subject does not bind the exact selected Candidate.');
  }
  if (typeof draft?.walkthroughId !== 'string' || !/^WLK-[A-Z0-9][A-Z0-9._:-]{0,63}$/u.test(draft.walkthroughId)
      || typeof draft.audience !== 'string' || !draft.audience.trim() || draft.audience.length > 128
      || draft.mode !== 'change-walkthrough') {
    fail('CMP_WALKTHROUGH_SCHEMA_INVALID', 'Walkthrough identity, audience, or mode is invalid.');
  }
  const narrative = draft?.narrative;
  if (!exactKeys(narrative, ['content', 'contentSha256'])
      || typeof narrative.content !== 'string'
      || !narrative.content.trim()
      || Buffer.byteLength(narrative.content, 'utf8') > MAXIMUM_NARRATIVE_BYTES
      || narrative.contentSha256 !== textHash(narrative.content)) {
    fail('CMP_WALKTHROUGH_INTEGRITY_INVALID', 'Narrative bytes are missing, oversized, or hash-mismatched.');
  }
  const dependencyValid = validateDependencyManifest(draft?.dependencyManifest, manifest ?? {}, graph ?? {});
  if (!dependencyValid
      || draft?.dependencyManifestSha256 !== hash(draft?.dependencyManifest ?? null)) {
    fail('CMP_WALKTHROUGH_DEPENDENCY_INVALID', 'Dependency manifest is stale, malformed, or hash-mismatched.');
  }
  if (!Array.isArray(draft?.claims) || draft.claims.length === 0
      || draft.claims.length > MAXIMUM_CLAIMS) {
    fail('CMP_WALKTHROUGH_LIMIT', `Walkthroughs require 1-${MAXIMUM_CLAIMS} typed claims.`);
  }
  if (plain(draft) && draft.draftSha256 !== hash(without(draft, 'draftSha256'))) {
    fail('CMP_WALKTHROUGH_INTEGRITY_INVALID', 'Walkthrough draft content hash is invalid.');
  }

  const sourceBudget = { remaining: MAXIMUM_RESULT_SOURCES };
  const evaluatedClaims = Array.isArray(draft?.claims)
    ? draft.claims.map((claim) => evaluateClaim(
      claim, manifest ?? { regions: [] }, draft.dependencyManifest ?? {}, sourceBudget
    )) : [];
  const identities = evaluatedClaims.map((claim) => claim.claimId);
  if (identities.some((value) => value == null)
      || new Set(identities).size !== identities.length
      || identities.some((value, index) => index > 0 && identities[index - 1] >= value)) {
    fail('CMP_WALKTHROUGH_REFERENCE_INVALID', 'Claim IDs must be sorted and unique.');
  }
  diagnostics.push(...evaluatedClaims.flatMap((claim) => claim.diagnostics));
  const uniqueDiagnostics = [...new Map(diagnostics.map((entry) => [
    `${entry.code}\0${entry.claimId ?? ''}\0${entry.message}`, entry
  ])).values()].sort((left, right) => compareText(left.code, right.code)
    || compareText(String(left.claimId ?? ''), String(right.claimId ?? ''))
    || compareText(left.message, right.message));
  const counts = {
    claims: evaluatedClaims.length,
    passed: evaluatedClaims.filter((claim) => claim.status === 'passed').length,
    advisory: evaluatedClaims.filter((claim) => claim.status === 'advisory').length,
    unavailable: evaluatedClaims.filter((claim) => claim.status === 'unavailable').length,
    contradicted: evaluatedClaims.filter((claim) => ['contradicted', 'invalid'].includes(claim.status)).length
  };
  const hardFailure = uniqueDiagnostics.some((entry) => ![
    'CMP_STRUCTURE_UNAVAILABLE', 'CMP_WALKTHROUGH_EVIDENCE_UNAVAILABLE',
    'CMP_WALKTHROUGH_DECISION_UNAVAILABLE', 'CMP_WALKTHROUGH_VALIDATOR_UNAVAILABLE'
  ].includes(entry.code));
  const status = hardFailure || counts.contradicted ? 'failed'
    : counts.unavailable ? 'incomplete' : 'validated';
  const core = {
    schemaVersion: 1, // schema-transient: read-only validation report; never persisted or authorized
    kind: 'comprehension-walkthrough-validation',
    status,
    authoritative: false,
    lifecycleGate: false,
    modelInvoked: false,
    walkthroughId: draft?.walkthroughId ?? null,
    candidateSha256: manifest?.compatibilityCandidateSha256 ?? null,
    draftSha256: draft?.draftSha256 ?? null,
    walkthroughContentSha256: narrative?.contentSha256 ?? null,
    dependencyManifestSha256: draft?.dependencyManifestSha256 ?? null,
    dependencies: normalizedDependencies(draft?.dependencyManifest),
    walkthroughSha256: hash({
      candidateSha256: manifest?.compatibilityCandidateSha256 ?? null,
      walkthroughContentSha256: narrative?.contentSha256 ?? null,
      dependencyManifestSha256: draft?.dependencyManifestSha256 ?? null,
      claimSha256s: Array.isArray(draft?.claims) ? draft.claims.map((claim) => claim?.claimSha256 ?? null) : []
    }),
    claims: evaluatedClaims.map(({ diagnostics: _diagnostics, ...claim }) => claim),
    counts,
    diagnostics: uniqueDiagnostics
  };
  return freezeDeep({ ...core, resultSha256: hash(core) });
}

function validationIntegrity(value) {
  const shape = [
    'schemaVersion', 'kind', 'status', 'authoritative', 'lifecycleGate', 'modelInvoked',
    'walkthroughId', 'candidateSha256', 'draftSha256', 'walkthroughContentSha256',
    'dependencyManifestSha256', 'dependencies', 'walkthroughSha256', 'claims', 'counts',
    'diagnostics', 'resultSha256'
  ];
  return exactKeys(value, shape)
    && value.schemaVersion === 1 // schema-transient: read-only validation report, never persisted or authorized
    && value.kind === 'comprehension-walkthrough-validation'
    && value.authoritative === false && value.lifecycleGate === false && value.modelInvoked === false
    && Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAXIMUM_VALIDATION_BYTES
    && ['validated', 'incomplete', 'failed'].includes(value.status)
    && exactKeys(value.dependencies, DEPENDENCY_KEYS)
    && DEPENDENCY_KEYS.every((key) => value.dependencies[key] === null
      || SHA256.test(String(value.dependencies[key])))
    && Array.isArray(value.claims) && value.claims.length <= MAXIMUM_CLAIMS
    && value.claims.every((claim, index) => plain(claim)
      && typeof claim.claimId === 'string'
      && (index === 0 || value.claims[index - 1].claimId < claim.claimId)
      && SHA256.test(String(claim.claimSha256 ?? ''))
      && ['passed', 'advisory', 'unavailable', 'contradicted', 'invalid'].includes(claim.status)
      && Array.isArray(claim.dependencyKeys)
      && claim.dependencyKeys.every((key, keyIndex) => DEPENDENCY_KEYS.includes(key)
        && (keyIndex === 0 || claim.dependencyKeys[keyIndex - 1] < key)))
    && value.resultSha256 === hash(without(value, 'resultSha256'));
}

function dependencyChanges(previous, current) {
  return DEPENDENCY_KEYS.filter((key) => previous[key] !== current[key]);
}

/**
 * Revalidate a prior observe-only report against current exact inputs. The projection does not
 * preserve a prior pass: current validators always run again, and changed dependencies are shown.
 */
export function revalidateComprehensionWalkthroughDraft(previous, draft, context = {}) {
  const current = validateComprehensionWalkthroughDraft(draft, context);
  const validPrevious = validationIntegrity(previous);
  const changedDependencies = validPrevious
    ? dependencyChanges(previous.dependencies, current.dependencies) : [];
  const candidateChanged = validPrevious
    ? previous.candidateSha256 !== current.candidateSha256 : null;
  const presentationChanged = validPrevious
    ? previous.walkthroughContentSha256 !== current.walkthroughContentSha256 : null;
  const previousClaims = validPrevious
    ? new Map(previous.claims.map((claim) => [claim.claimId, claim])) : new Map();
  const claims = current.claims.map((claim) => {
    const prior = previousClaims.get(claim.claimId) ?? null;
    const reasons = [];
    if (prior == null) reasons.push('claim-added');
    else {
      if (candidateChanged) reasons.push('candidate-changed');
      if (prior.claimSha256 !== claim.claimSha256) reasons.push('claim-content-changed');
      for (const key of changedDependencies) {
        if (claim.dependencyKeys.includes(key) || prior.dependencyKeys?.includes(key)) {
          reasons.push(`dependency-changed:${key}`);
        }
      }
    }
    const invalidated = prior != null && reasons.length > 0;
    const outcome = prior == null ? 'new'
      : !invalidated ? 'unchanged'
        : ['passed', 'advisory'].includes(claim.status) ? 'revalidated' : 'invalidated';
    return {
      claimId: claim.claimId,
      previousClaimSha256: prior?.claimSha256 ?? null,
      currentClaimSha256: claim.claimSha256,
      previousStatus: prior?.status ?? null,
      currentStatus: claim.status,
      invalidated,
      outcome,
      reasons
    };
  });
  const currentIds = new Set(current.claims.map((claim) => claim.claimId));
  const removedClaimIds = validPrevious
    ? previous.claims.map((claim) => claim.claimId).filter((id) => !currentIds.has(id)).sort(compareText)
    : [];
  const invalidated = claims.filter((claim) => claim.invalidated).length + removedClaimIds.length;
  const revalidated = claims.filter((claim) => claim.outcome === 'revalidated').length;
  const unchanged = claims.filter((claim) => claim.outcome === 'unchanged').length;
  const diagnostics = validPrevious ? [] : [diagnostic(
    'CMP_WALKTHROUGH_REVALIDATION_INVALID', null,
    'The previous walkthrough validation report is malformed or hash-mismatched.'
  )];
  const status = !validPrevious || current.status === 'failed' ? 'failed'
    : invalidated > revalidated ? 'incomplete'
      : invalidated || presentationChanged || changedDependencies.length ? 'revalidated' : 'unchanged';
  const core = {
    schemaVersion: 1, // schema-transient: read-only revalidation projection; never persisted or authorized
    kind: 'comprehension-walkthrough-revalidation',
    status,
    authoritative: false,
    lifecycleGate: false,
    modelInvoked: false,
    previousResultSha256: validPrevious ? previous.resultSha256 : null,
    currentResultSha256: current.resultSha256,
    candidateChanged,
    presentationChanged,
    changedDependencies,
    claims,
    removedClaimIds,
    counts: {
      claims: claims.length,
      invalidated,
      revalidated,
      unchanged,
      added: claims.filter((claim) => claim.outcome === 'new').length,
      removed: removedClaimIds.length
    },
    diagnostics
  };
  return freezeDeep({ ...core, resultSha256: hash(core), current });
}

export const CMP_WALKTHROUGH_LIMITS = Object.freeze({
  maximumClaims: MAXIMUM_CLAIMS,
  maximumDraftBytes: MAXIMUM_DRAFT_BYTES,
  maximumNarrativeBytes: MAXIMUM_NARRATIVE_BYTES,
  maximumClaimTextBytes: MAXIMUM_TEXT_BYTES,
  maximumReferencesPerField: MAXIMUM_REFS,
  maximumResultSources: MAXIMUM_RESULT_SOURCES,
  maximumValidationBytes: MAXIMUM_VALIDATION_BYTES
});
