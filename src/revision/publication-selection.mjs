/**
 * Read-only selected-head gate for a prospective Story publication. This does not publish, reserve
 * a writer lease, or make the eventual Story commit atomic: that commit must compare the returned
 * loop revision/entry and prospective tree again at its own mutation boundary.
 */
import path from 'node:path';
import { recordSha256 } from '../records.mjs';
import { currentSubjectLockOwner } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';
import { assertCurrentRevisionPrecheck } from './precheck.mjs';
import { verifyRevisionCandidateApplicationTree } from './publication-projection.mjs';

function refuse(code, message) {
  throw new SingularityFlowError(message, { code });
}
function hash(value) { return `sha256:${recordSha256(value)}`; }
function same(left, right) { return hash(left) === hash(right); }
const PREPARED = new WeakMap();
function candidateFromReference(reference) {
  return {
    candidateId: reference.candidateId,
    candidateSha256: reference.candidateSha256,
    candidateRefSha256: hash(reference),
    candidateTree: reference.repository?.candidateTree
  };
}
function assertScope(store, workflow) {
  const scope = store.scope;
  if (!scope || typeof scope.workId !== 'string' || typeof scope.phaseId !== 'string'
      || !Number.isSafeInteger(scope.phaseGeneration)
      || workflow?.workItem?.id !== scope.workId
      || workflow?.currentPhase !== scope.phaseId) {
    refuse('REV_PUBLICATION_SCOPE', 'Story publication does not name the local loop work and phase.');
  }
  return scope;
}
function assertSelectedHead(state, candidate, scope) {
  if (!state || state.status !== 'open' || !state.head || !state.headTransitionSha256
      || !state.headSnapshotSha256 || !Number.isSafeInteger(state.revision)) {
    refuse('REV_PUBLICATION_HEAD_UNAVAILABLE', 'An open, snapshotted selected loop head is required.');
  }
  if (!same(state.head, candidate)) {
    refuse('REV_PUBLISH_CANDIDATE_MISMATCH', 'Publication Candidate is not the selected local loop head.');
  }
  if (state.context?.workflowSha256 == null || state.context?.configSha256 == null
      || state.context?.proofProfileSha256 == null
      || state.context?.editorDiskIndexBaselineSha256 == null
      || scope.phaseGeneration < 0) {
    refuse('REV_PUBLICATION_CONTEXT_STALE', 'Selected loop head lacks its bound phase context.');
  }
}
function assertContext(current, state, reference) {
  if (!current || !same(current, state.context)
      || current.headCommit !== reference.repository?.baselineCommit) {
    refuse('REV_PUBLICATION_CONTEXT_STALE', 'Current Story, repository, or editor context changed after precheck.');
  }
}
function assertPrecheckInput(input, state, candidate, scope, reference) {
  if (!input || !same(input.candidateReference, reference)
      || input.head?.candidateId !== candidate.candidateId
      || input.head?.candidateSha256 !== candidate.candidateSha256
      || input.head?.candidateRefSha256 !== candidate.candidateRefSha256
      || input.head?.candidateTree !== candidate.candidateTree
      || input.head?.phaseGeneration !== scope.phaseGeneration
      || input.head?.headRevision !== state.revision
      || input.head?.headTransitionSha256 !== state.headTransitionSha256
      || input.head?.workflowSha256 !== state.context.workflowSha256
      || input.head?.configSha256 !== state.context.configSha256
      || input.head?.proofProfileSha256 !== state.context.proofProfileSha256
      || input.head?.editorDiskIndexBaselineSha256 !== state.context.editorDiskIndexBaselineSha256) {
    refuse('REV_PRECHECK_STALE', 'Current precheck inputs do not describe the selected head and phase context.');
  }
}
function assertReceipt(receipt, input, state) {
  const recomputed = assertCurrentRevisionPrecheck(receipt, input);
  if (recomputed.headSnapshotSha256 !== state.headSnapshotSha256
      || (state.precheckSha256 != null && state.precheckSha256 !== recomputed.precheckSha256)) {
    refuse('REV_PRECHECK_STALE', 'Precheck does not bind the selected head snapshot.');
  }
  if (recomputed.publicationEligible !== true || recomputed.precheckPassed !== true) {
    refuse('REV_PUBLICATION_NOT_READY', 'The selected head has unresolved publication obligations.');
  }
  return recomputed;
}

/**
 * Validate a proposed Story publication against the exact selected local REV head.
 * `readCurrentContext` and `readCurrentPrecheckInput` must obtain fresh independently checked
 * snapshots, not replay data from a saved card. A standalone receipt is accepted after a
 * select-head transition only when its recomputation binds the new head snapshot exactly.
 */
export async function verifyRevisionPublicationSelection({
  root, loopStore, candidateReference, precheckReceipt, prospectiveTree,
  config, workflow, readCurrentContext, readCurrentPrecheckInput
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
      || !loopStore || typeof loopStore.read !== 'function' || typeof loopStore.list !== 'function'
      || typeof readCurrentContext !== 'function'
      || typeof readCurrentPrecheckInput !== 'function'
      || !candidateReference || typeof candidateReference !== 'object'
      || !precheckReceipt || typeof precheckReceipt !== 'object') {
    refuse('REV_PUBLICATION_BINDING_INVALID', 'Selected loop, Candidate, precheck, and live readers are required.');
  }
  const scope = assertScope(loopStore, workflow);
  const state = await loopStore.read();
  const candidate = candidateFromReference(candidateReference);
  assertSelectedHead(state, candidate, scope);
  const journal = await loopStore.list();
  const latest = journal.at(-1);
  if (!latest || latest.entrySha256 !== state.entrySha256 || latest.revision !== state.revision) {
    refuse('REV_LOOP_ADVANCED', 'Selected local loop head changed during publication selection.');
  }
  if (state.precheckSha256 !== null
      && (latest.transition?.type !== 'commit-interval'
        || latest.transition.precheck?.precheckSha256 !== state.precheckSha256)) {
    refuse('REV_PRECHECK_STALE', 'The selected head does not retain its latest committed precheck.');
  }
  const context = await readCurrentContext({ scope });
  assertContext(context, state, candidateReference);
  const input = await readCurrentPrecheckInput({ scope, selectedHead: state,
    candidateReference, context });
  assertPrecheckInput(input, state, candidate, scope, candidateReference);
  const receipt = assertReceipt(precheckReceipt, input, state);
  const projection = await verifyRevisionCandidateApplicationTree(root, {
    candidateReference, prospectiveTree, config, workflow
  });
  const after = await loopStore.read();
  if (after?.entrySha256 !== state.entrySha256 || after?.revision !== state.revision
      || after?.headSnapshotSha256 !== state.headSnapshotSha256
      || after?.precheckSha256 !== state.precheckSha256) {
    refuse('REV_LOOP_ADVANCED', 'Selected loop head changed during application-tree validation.');
  }
  assertContext(await readCurrentContext({ scope }), after, candidateReference);
  const currentInput = await readCurrentPrecheckInput({ scope, selectedHead: after,
    candidateReference, context: after.context });
  assertPrecheckInput(currentInput, after, candidate, scope, candidateReference);
  assertReceipt(precheckReceipt, currentInput, after);
  const core = {
    schemaVersion: 1, kind: 'revision-publication-selection',
    workId: scope.workId, phaseId: scope.phaseId, phaseGeneration: scope.phaseGeneration,
    loopId: state.loopId, loopRevision: state.revision,
    journalEntrySha256: state.entrySha256,
    candidateId: candidate.candidateId,
    candidateSha256: candidate.candidateSha256,
    candidateRefSha256: candidate.candidateRefSha256,
    candidateTree: candidate.candidateTree,
    headTransitionSha256: state.headTransitionSha256,
    headSnapshotSha256: state.headSnapshotSha256,
    precheckSha256: receipt.precheckSha256,
    contextSha256: hash(context),
    applicationProjectionSha256: projection.projectionSha256,
    prospectiveTree
  };
  return Object.freeze({ ...core, selectionSha256: hash(core) });
}

/**
 * First half of a Story publication selection. This runs under the Story subject lock before
 * transaction-owned workflow/document writes. The opaque token is same-process only; it cannot
 * be serialized into an authority receipt or replayed by another publication transaction.
 */
export async function prepareRevisionPublicationSelection({
  root, loopStore, candidateReference, precheckReceipt, workflow,
  readCurrentContext, readCurrentPrecheckInput
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
      || !loopStore || typeof loopStore.read !== 'function' || typeof loopStore.list !== 'function'
      || typeof readCurrentContext !== 'function'
      || typeof readCurrentPrecheckInput !== 'function'
      || !candidateReference || !precheckReceipt) {
    refuse('REV_PUBLICATION_BINDING_INVALID', 'Locked publication preflight needs exact live readers and proof inputs.');
  }
  const scope = assertScope(loopStore, workflow);
  if (!currentSubjectLockOwner(root, { kind: 'story', id: scope.workId })) {
    refuse('REV_PUBLICATION_LOCK_REQUIRED', 'REV publication preflight needs the Story subject lock.');
  }
  const state = await loopStore.read();
  const candidate = candidateFromReference(candidateReference);
  assertSelectedHead(state, candidate, scope);
  const latest = (await loopStore.list()).at(-1);
  if (!latest || latest.entrySha256 !== state.entrySha256 || latest.revision !== state.revision) {
    refuse('REV_LOOP_ADVANCED', 'Selected local loop head changed before publication preflight.');
  }
  if (state.precheckSha256 !== null
      && (latest.transition?.type !== 'commit-interval'
        || latest.transition.precheck?.precheckSha256 !== state.precheckSha256)) {
    refuse('REV_PRECHECK_STALE', 'Selected head does not retain its exact precheck.');
  }
  const context = await readCurrentContext({ scope });
  assertContext(context, state, candidateReference);
  const input = await readCurrentPrecheckInput({ scope, selectedHead: state,
    candidateReference, context });
  assertPrecheckInput(input, state, candidate, scope, candidateReference);
  const receipt = assertReceipt(precheckReceipt, input, state);
  const token = Object.freeze({ kind: 'revision-publication-preflight-token' });
  PREPARED.set(token, {
    root, loopStore, scope: structuredClone(scope), state: structuredClone(state),
    candidate: structuredClone(candidate), candidateReference: structuredClone(candidateReference),
    receipt: structuredClone(receipt), contextSha256: hash(context),
    readCurrentContext
  });
  return token;
}

/**
 * Second half of the locked publication selection. Story-owned metadata has now changed, so a
 * full workflow-hash reread would reject this transaction's own writes. The same subject lock
 * prevents REV head CAS; exact candidate/app blobs and HEAD are independently rechecked against
 * the admitted immutable prospective tree. Commit admission repeats the prospective-tree check.
 */
export async function verifyPreparedRevisionPublicationSelection({
  token, root, prospectiveTree, config, workflow
} = {}) {
  const prepared = token && PREPARED.get(token);
  if (!prepared || prepared.root !== root || !config || !workflow
      || workflow.workItem?.id !== prepared.scope.workId
      || workflow.currentPhase !== prepared.scope.phaseId
      || !currentSubjectLockOwner(root, { kind: 'story', id: prepared.scope.workId })) {
    refuse('REV_PUBLICATION_PREFLIGHT_STALE', 'Locked REV preflight is missing or belongs to another Story phase.');
  }
  PREPARED.delete(token);
  const projection = await verifyRevisionCandidateApplicationTree(root, {
    candidateReference: prepared.candidateReference, prospectiveTree, config, workflow
  });
  const after = await prepared.loopStore.read();
  if (after?.entrySha256 !== prepared.state.entrySha256
      || after?.revision !== prepared.state.revision
      || after?.headSnapshotSha256 !== prepared.state.headSnapshotSha256
      || after?.precheckSha256 !== prepared.state.precheckSha256) {
    refuse('REV_LOOP_ADVANCED', 'Selected local loop head changed during Story publication.');
  }
  const latestContext = await prepared.readCurrentContext({ scope: prepared.scope });
  for (const key of [
    'repositorySha256', 'headCommit', 'sourceTreeSha256', 'configSha256',
    'approvedIntentSha256', 'routeContractSha256', 'proofProfileSha256'
  ]) {
    if (latestContext?.[key] !== prepared.state.context[key]) {
      refuse('REV_PUBLICATION_CONTEXT_STALE',
        `REV publication context '${key}' changed after the pre-state-write check.`);
    }
  }
  const core = {
    schemaVersion: 1, kind: 'revision-publication-selection',
    workId: prepared.scope.workId, phaseId: prepared.scope.phaseId,
    phaseGeneration: prepared.scope.phaseGeneration,
    loopId: prepared.state.loopId, loopRevision: prepared.state.revision,
    journalEntrySha256: prepared.state.entrySha256,
    candidateId: prepared.candidate.candidateId,
    candidateSha256: prepared.candidate.candidateSha256,
    candidateRefSha256: prepared.candidate.candidateRefSha256,
    candidateTree: prepared.candidate.candidateTree,
    headTransitionSha256: prepared.state.headTransitionSha256,
    headSnapshotSha256: prepared.state.headSnapshotSha256,
    precheckSha256: prepared.receipt.precheckSha256,
    contextSha256: prepared.contextSha256,
    applicationProjectionSha256: projection.projectionSha256,
    prospectiveTree
  };
  return Object.freeze({ ...core, selectionSha256: hash(core) });
}
