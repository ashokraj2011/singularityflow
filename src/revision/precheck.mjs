/**
 * Pure REV readiness precheck. Callers must supply independently verified frozen-candidate,
 * selected-head, worktree, and deterministic-check snapshots. This module has no filesystem,
 * process, model, or persistence capability; a receipt is never a verification result.
 */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VALIDATIONS = Object.freeze([
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
]);
const READINESS = Object.freeze(new Set([
  'addressed', 'witness-ready', 'witness-passed-current', 'owed',
  'unavailable', 'contradicted', 'not-applicable'
]));

function fail(code, message, details = null) {
  throw new SingularityFlowError(message, { code, details });
}
function digest(value) { return `sha256:${recordSha256(value)}`; }
function plain(value, label, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('REV_PRECHECK_INPUT', `${label} must be a plain object.`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail('REV_PRECHECK_INPUT', `${label}.${key} is not registered.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('REV_PRECHECK_INPUT', `${label}.${key} is required.`);
  }
  return value;
}
function sha(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail('REV_PRECHECK_INPUT', `${label} needs an exact SHA-256 digest.`);
  }
  return value;
}
function oid(value, label) {
  if (typeof value !== 'string' || !OBJECT.test(value)) {
    fail('REV_PRECHECK_INPUT', `${label} needs an exact Git object ID.`);
  }
  return value;
}
function id(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail('REV_PRECHECK_INPUT', `${label} needs a portable identifier.`);
  }
  return value;
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('REV_PRECHECK_INPUT', `${label} must be a non-negative safe integer.`);
  }
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') fail('REV_PRECHECK_INPUT', `${label} must be boolean.`);
  return value;
}
function list(value, label, maximum = 512) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail('REV_PRECHECK_INPUT', `${label} must be an array of at most ${maximum} items.`);
  }
  return value;
}
function uniqueSorted(values, label) {
  if (new Set(values).size !== values.length) fail('REV_PRECHECK_INPUT', `${label} contains duplicates.`);
  return [...values].sort();
}
function reference(value) {
  plain(value, 'candidateReference', [
    'family', 'namespace', 'candidateId', 'retainedRecordSha256', 'candidateSha256',
    'repository', 'sourceManifestSha256', 'effectSetSha256', 'createdBy'
  ]);
  if (!['sgos-candidate', 'auto-candidate'].includes(value.family)
      || typeof value.namespace !== 'string'
      || !/^refs\/singularity-flow\/[A-Za-z0-9._/-]{1,512}$/.test(value.namespace)
      || value.namespace.split('/').some((part) => part === '.' || part === '..')) {
    fail('REV_PRECHECK_INPUT', 'A qualified retained candidate reference is required.');
  }
  id(value.candidateId, 'candidateReference.candidateId');
  if (!value.candidateId.startsWith('CAN-')) {
    fail('REV_PRECHECK_INPUT', 'Candidate ID must identify a frozen REV candidate.');
  }
  for (const key of ['retainedRecordSha256', 'candidateSha256', 'sourceManifestSha256', 'effectSetSha256']) {
    sha(value[key], `candidateReference.${key}`);
  }
  plain(value.repository, 'candidateReference.repository', ['baselineCommit', 'candidateTree', 'objectFormat']);
  oid(value.repository.baselineCommit, 'candidateReference.repository.baselineCommit');
  oid(value.repository.candidateTree, 'candidateReference.repository.candidateTree');
  if (!['sha1', 'sha256'].includes(value.repository.objectFormat)
      || value.repository.candidateTree.length !== (value.repository.objectFormat === 'sha1' ? 40 : 64)
      || value.repository.baselineCommit.length !== value.repository.candidateTree.length) {
    fail('REV_PRECHECK_INPUT', 'Candidate Git object format is inconsistent.');
  }
  plain(value.createdBy, 'candidateReference.createdBy', ['kind', 'id']);
  if (!['human', 'agent', 'service'].includes(value.createdBy.kind)) {
    fail('REV_PRECHECK_INPUT', 'Candidate creator kind is invalid.');
  }
  if (typeof value.createdBy.id !== 'string' || !value.createdBy.id.trim()
      || Buffer.byteLength(value.createdBy.id) > 256
      || /[\u0000-\u001f\u007f]/.test(value.createdBy.id)) {
    fail('REV_PRECHECK_INPUT', 'Candidate creator ID must be a bounded nonempty identity.');
  }
  return structuredClone(value);
}
function head(value, ref, refSha) {
  plain(value, 'head', [
    'candidateId', 'candidateSha256', 'candidateRefSha256', 'candidateTree', 'headRevision',
    'headTransitionSha256', 'phaseGeneration', 'workflowSha256',
    'configSha256', 'proofProfileSha256',
    'editorDiskIndexBaselineSha256'
  ]);
  id(value.candidateId, 'head.candidateId');
  sha(value.candidateSha256, 'head.candidateSha256');
  sha(value.candidateRefSha256, 'head.candidateRefSha256');
  oid(value.candidateTree, 'head.candidateTree');
  integer(value.headRevision, 'head.headRevision');
  integer(value.phaseGeneration, 'head.phaseGeneration');
  for (const key of [
    'headTransitionSha256', 'workflowSha256', 'configSha256',
    'proofProfileSha256', 'editorDiskIndexBaselineSha256'
  ]) sha(value[key], `head.${key}`);
  if (value.candidateId !== ref.candidateId || value.candidateSha256 !== ref.candidateSha256
      || value.candidateRefSha256 !== refSha
      || value.candidateTree !== ref.repository.candidateTree) {
    fail('REV_PRECHECK_STALE', 'Selected head does not match the exact retained candidate reference.');
  }
  return structuredClone(value);
}
function bindings(value) {
  plain(value, 'bindings', [
    'criteriaBindingSha256', 'specificationDispositionSha256', 'hunkClaimSetSha256'
  ]);
  for (const key of Object.keys(value)) sha(value[key], `bindings.${key}`);
  return structuredClone(value);
}
function claimSet(value, binding, candidateId) {
  value = readRecord('revision-hunk-claim-set', value).record;
  plain(value, 'hunkClaimSet', [
    'schemaVersion', 'kind', 'parentCandidateId', 'resultCandidateId',
    'claims', 'unexplained', 'claimSetSha256'
  ]);
  if (value.kind !== 'revision-hunk-claim-set' || value.resultCandidateId !== candidateId) {
    fail('REV_PRECHECK_INPUT', 'Hunk claim set is not for the selected candidate.');
  }
  id(value.parentCandidateId, 'hunkClaimSet.parentCandidateId');
  const claims = list(value.claims, 'hunkClaimSet.claims').map((claim) => {
    plain(claim, 'hunkClaimSet.claim', ['hunkId', 'cause', 'status']);
    id(claim.hunkId, 'hunkClaimSet.claim.hunkId');
    plain(claim.cause, 'hunkClaimSet.claim.cause', ['kind', 'id']);
    if (!['feedback', 'criterion', 'registered-tool-effect', 'manual-note', 'approved-existing-drift'].includes(claim.cause.kind)) {
      fail('REV_PRECHECK_INPUT', 'Hunk claim cause is not registered.');
    }
    id(claim.cause.id, 'hunkClaimSet.claim.cause.id');
    if (claim.status !== 'claimed') fail('REV_PRECHECK_INPUT', 'Hunk claim status is invalid.');
    return structuredClone(claim);
  });
  uniqueSorted(claims.map((claim) => claim.hunkId), 'hunk claim IDs');
  const unexplained = uniqueSorted(list(value.unexplained, 'hunkClaimSet.unexplained').map((hunkId) => id(hunkId, 'unexplained hunk')), 'unexplained hunk IDs');
  if (unexplained.some((hunkId) => claims.some((claim) => claim.hunkId === hunkId))) {
    fail('REV_PRECHECK_INPUT', 'A hunk cannot be both claimed and unexplained.');
  }
  const body = {
    schemaVersion: currentSchemaVersion('revision-hunk-claim-set'), kind: 'revision-hunk-claim-set',
    parentCandidateId: value.parentCandidateId, resultCandidateId: value.resultCandidateId,
    claims, unexplained
  };
  const actual = digest(body);
  if (value.claimSetSha256 !== actual || binding !== actual) {
    fail('REV_PRECHECK_STALE', 'Hunk claim set bytes differ from the bound digest.');
  }
  return { ...body, claimSetSha256: actual };
}
function worktree(value, selectedHead, candidateTree) {
  plain(value, 'worktree', ['savedTree', 'editorDiskIndexBaselineSha256', 'changedPaths']);
  oid(value.savedTree, 'worktree.savedTree');
  sha(value.editorDiskIndexBaselineSha256, 'worktree.editorDiskIndexBaselineSha256');
  const changedPaths = uniqueSorted(list(value.changedPaths, 'worktree.changedPaths').map((path) => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')
        || path.split('/').some((part) => !part || part === '.' || part === '..')
        || /[\u0000-\u001f\u007f]/.test(path)) {
      fail('REV_PRECHECK_INPUT', 'Changed paths must be repository-relative and normalized.');
    }
    return path;
  }), 'changed paths');
  if (value.editorDiskIndexBaselineSha256 !== selectedHead.editorDiskIndexBaselineSha256) {
    fail('REV_PRECHECK_STALE', 'Editor/disk/index baseline changed after the selected head snapshot.');
  }
  if (value.savedTree !== candidateTree && !changedPaths.length) {
    fail('REV_PRECHECK_INPUT', 'Worktree tree drift requires an exact changed-path inventory.');
  }
  if (value.savedTree !== candidateTree || changedPaths.length) {
    fail('REV_MANUAL_DRIFT', 'Saved worktree differs from the selected frozen candidate.', { changedPaths });
  }
  return { savedTree: value.savedTree, editorDiskIndexBaselineSha256: value.editorDiskIndexBaselineSha256, changedPaths };
}
function validations(value) {
  plain(value, 'validations', VALIDATIONS);
  return Object.fromEntries(VALIDATIONS.map((key) => {
    const entry = plain(value[key], `validations.${key}`, ['status', 'evidenceSha256']);
    if (!['pass', 'fail', 'unavailable'].includes(entry.status)) {
      fail('REV_PRECHECK_INPUT', `validations.${key}.status is invalid.`);
    }
    sha(entry.evidenceSha256, `validations.${key}.evidenceSha256`);
    return [key, { status: entry.status, evidenceSha256: entry.evidenceSha256 }];
  }));
}
function witness(value, label) {
  plain(value, label, [
    'receiptSha256', 'candidateId', 'candidateRefSha256', 'candidateTree',
    'proofProfileSha256', 'criteriaBindingSha256', 'testBodySha256',
    'environmentSha256', 'status', 'registeredAdapter', 'policyPermitsReuse',
    'independent', 'signed'
  ]);
  for (const key of [
    'receiptSha256', 'candidateRefSha256', 'proofProfileSha256',
    'criteriaBindingSha256', 'testBodySha256', 'environmentSha256'
  ]) sha(value[key], `${label}.${key}`);
  id(value.candidateId, `${label}.candidateId`);
  oid(value.candidateTree, `${label}.candidateTree`);
  if (!['passed', 'failed'].includes(value.status)) fail('REV_PRECHECK_INPUT', `${label}.status is invalid.`);
  for (const key of ['registeredAdapter', 'policyPermitsReuse', 'independent', 'signed']) {
    boolean(value[key], `${label}.${key}`);
  }
  return structuredClone(value);
}
function criteria(value, ref, refSha, selectedHead, binding, profile) {
  const selected = list(value, 'criteria', 128);
  if (!selected.length) fail('REV_PRECHECK_INPUT', 'At least one exact criterion is required.');
  const rows = selected.map((item) => {
    plain(item, 'criterion', [
      'clauseId', 'applicable', 'claimedChange', 'witnessReady',
      'availability', 'contradicted', 'testBodySha256', 'environmentSha256', 'witnesses'
    ]);
    id(item.clauseId, 'criterion.clauseId');
    for (const key of ['applicable', 'claimedChange', 'witnessReady', 'contradicted']) {
      boolean(item[key], `criterion.${key}`);
    }
    if (!['available', 'unavailable'].includes(item.availability)) {
      fail('REV_PRECHECK_INPUT', 'Criterion availability is invalid.');
    }
    for (const key of ['testBodySha256', 'environmentSha256']) {
      if (item[key] !== null) sha(item[key], `criterion.${key}`);
    }
    const witnesses = list(item.witnesses, 'criterion.witnesses', 64).map((entry) => witness(entry, 'criterion.witness'));
    if ((item.witnessReady || witnesses.length)
        && (item.testBodySha256 === null || item.environmentSha256 === null)) {
      fail('REV_PRECHECK_INPUT', 'A ready or recorded witness requires its current test body and environment digests.');
    }
    uniqueSorted(witnesses.map((entry) => entry.receiptSha256), 'criterion witness receipt digests');
    const current = witnesses.filter((entry) => entry.status === 'passed'
      && entry.registeredAdapter && entry.policyPermitsReuse
      && entry.candidateId === ref.candidateId
      && entry.candidateRefSha256 === refSha
      && entry.candidateTree === ref.repository.candidateTree
      && entry.proofProfileSha256 === selectedHead.proofProfileSha256
      && entry.criteriaBindingSha256 === binding
      && entry.testBodySha256 === item.testBodySha256
      && entry.environmentSha256 === item.environmentSha256
      && (profile !== 'regulated' || (entry.independent && entry.signed)));
    let readiness;
    let reason;
    if (!item.applicable) { readiness = 'not-applicable'; reason = 'criterion-not-applicable'; }
    else if (item.contradicted) { readiness = 'contradicted'; reason = 'contradicting-evidence'; }
    else if (current.length) { readiness = 'witness-passed-current'; reason = 'exact-candidate-bound-witness'; }
    else if (item.claimedChange) { readiness = 'addressed'; reason = 'claimed-implementation-change'; }
    else if (item.witnessReady) { readiness = 'witness-ready'; reason = 'registered-witness-not-yet-executed'; }
    else if (item.availability === 'unavailable') { readiness = 'unavailable'; reason = 'registered-witness-unavailable'; }
    else { readiness = 'owed'; reason = 'no-current-bound-witness'; }
    if (!READINESS.has(readiness)) fail('REV_PRECHECK_INPUT', 'Criterion readiness is invalid.');
    return {
      clauseId: item.clauseId, readiness, reason,
      witnessCount: current.length,
      executedAgainstCandidate: current.length > 0,
      staleWitnessCount: witnesses.length - current.length
    };
  });
  uniqueSorted(rows.map((row) => row.clauseId), 'criterion clause IDs');
  return rows.sort((a, b) => a.clauseId.localeCompare(b.clauseId));
}
function refusalSummary(value) {
  plain(value, 'refusalSummary', ['count', 'corrected', 'unresolved']);
  for (const key of ['count', 'corrected', 'unresolved']) integer(value[key], `refusalSummary.${key}`);
  if (value.corrected + value.unresolved !== value.count) {
    fail('REV_PRECHECK_INPUT', 'Refusal summary totals are inconsistent.');
  }
  return structuredClone(value);
}

function snapshotBody(ref, refSha, selected) {
  return {
    candidateId: ref.candidateId,
    candidateSha256: ref.candidateSha256,
    candidateRefSha256: refSha,
    candidateTree: ref.repository.candidateTree,
    phaseGeneration: selected.phaseGeneration,
    headRevision: selected.headRevision,
    headTransitionSha256: selected.headTransitionSha256,
    workflowSha256: selected.workflowSha256,
    configSha256: selected.configSha256,
    proofProfileSha256: selected.proofProfileSha256,
    editorDiskIndexBaselineSha256: selected.editorDiskIndexBaselineSha256
  };
}

/** Canonical digest of the proposed or committed selected head, excluding interval/loop/precheck hashes. */
export function revisionHeadSnapshotSha256(candidateReference, selectedHead) {
  const ref = reference(candidateReference);
  const refSha = digest(ref);
  const selected = head(selectedHead, ref, refSha);
  return digest(snapshotBody(ref, refSha, selected));
}

/** Deterministic, side-effect-free readiness receipt for one exact frozen selected head. */
export function computeRevisionPrecheck(input) {
  plain(input, 'precheck input', [
    'candidateReference', 'head', 'bindings', 'hunkClaimSet', 'worktree',
    'validations', 'criteria', 'refusalSummary', 'proofProfile'
  ]);
  const ref = reference(input.candidateReference);
  const candidateRefSha256 = digest(ref);
  const selected = head(input.head, ref, candidateRefSha256);
  const bound = bindings(input.bindings);
  const claims = claimSet(input.hunkClaimSet, bound.hunkClaimSetSha256, ref.candidateId);
  const saved = worktree(input.worktree, selected, ref.repository.candidateTree);
  const checks = validations(input.validations);
  if (!['standard', 'high-assurance', 'regulated'].includes(input.proofProfile)) {
    fail('REV_PRECHECK_INPUT', 'Proof profile is not installed.');
  }
  const rows = criteria(input.criteria, ref, candidateRefSha256, selected,
    bound.criteriaBindingSha256, input.proofProfile);
  const refusals = refusalSummary(input.refusalSummary);
  if (Buffer.byteLength(canonicalJson(input)) > 256 * 1024) {
    fail('REV_PRECHECK_INPUT', 'Precheck input exceeds its bounded byte budget.');
  }
  const headSnapshotSha256 = digest(snapshotBody(ref, candidateRefSha256, selected));
  const failedChecks = VALIDATIONS.filter((key) => checks[key].status !== 'pass');
  const precheckBlockingHunks = claims.unexplained.length && input.proofProfile !== 'standard';
  const obligations = [
    ...failedChecks.map((key) => `deterministic-check:${key}`),
    ...(refusals.unresolved ? ['unresolved-refusals'] : []),
    ...(claims.unexplained.length ? [precheckBlockingHunks
      ? 'precheck:unexplained-hunks' : 'publication:unexplained-hunks'] : []),
    ...(rows.some((row) => row.readiness === 'contradicted') ? ['contradicted-criteria'] : [])
  ];
  const receipt = {
    schemaVersion: currentSchemaVersion('revision-precheck'), kind: 'revision-precheck',
    candidateId: ref.candidateId,
    candidateSha256: ref.candidateSha256,
    candidateRefSha256,
    candidateTree: ref.repository.candidateTree,
    headSnapshotSha256,
    headRevision: selected.headRevision,
    headTransitionSha256: selected.headTransitionSha256,
    phaseGeneration: selected.phaseGeneration,
    workflowSha256: selected.workflowSha256,
    configSha256: selected.configSha256,
    proofProfile: input.proofProfile,
    proofProfileSha256: selected.proofProfileSha256,
    editorDiskIndexBaselineSha256: saved.editorDiskIndexBaselineSha256,
    criteriaBindingSha256: bound.criteriaBindingSha256,
    specificationDispositionSha256: bound.specificationDispositionSha256,
    hunkClaimSetSha256: claims.claimSetSha256,
    precheckInputsSha256: digest(input),
    criteria: rows,
    owed: rows.filter((row) => ['owed', 'unavailable'].includes(row.readiness)).map((row) => row.clauseId),
    unexplainedHunks: claims.unexplained,
    refusalSummary: refusals,
    deterministicChecks: checks,
    remainingObligations: obligations,
    precheckPassed: failedChecks.length === 0 && !refusals.unresolved
      && !precheckBlockingHunks && !rows.some((row) => row.readiness === 'contradicted'),
    publicationEligible: obligations.length === 0
  };
  return Object.freeze({ ...receipt, precheckSha256: digest(receipt) });
}

/** Reject an old card when any selected-head, candidate, worktree, policy, or claim input moved. */
export function assertCurrentRevisionPrecheck(receipt, input) {
  const current = computeRevisionPrecheck(input);
  if (!receipt || receipt.kind !== 'revision-precheck'
      || receipt.precheckSha256 !== digest(Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== 'precheckSha256')
      ))
      || receipt.precheckSha256 !== current.precheckSha256) {
    fail('REV_PRECHECK_STALE', 'Precheck receipt does not bind the current selected head and inputs.');
  }
  return current;
}
