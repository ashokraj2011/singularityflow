import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordSha256 } from '../src/records.mjs';
import { createRevisionLoopStore } from '../src/revision/loop-store.mjs';
import { computeRevisionPrecheck } from '../src/revision/precheck.mjs';
import { verifyRevisionPublicationSelection } from '../src/revision/publication-selection.mjs';
import {
  sgosRevisionCandidateReference, verifySgosRevisionCandidateReference
} from '../src/revision/candidate-adapter.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';

const hash = (value) => `sha256:${recordSha256(value)}`;
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const requiredChecks = [
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
];
const summary = (reference) => ({
  candidateId: reference.candidateId,
  candidateSha256: reference.candidateSha256,
  candidateRefSha256: hash(reference),
  candidateTree: reference.repository.candidateTree
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-publish-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await writeFile(path.join(root, 'app.txt'), 'baseline\n');
  git('add', 'app.txt');
  git('commit', '-m', 'baseline');
  const headCommit = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'app.txt'), 'initial candidate\n');
  const initial = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation', createdBy: { kind: 'human', id: 'revision@example.com' }
  });
  const initialReference = await sgosRevisionCandidateReference(root, initial.candidate.candidateId);
  await writeFile(path.join(root, 'app.txt'), 'selected result\n');
  const result = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation', createdBy: { kind: 'human', id: 'revision@example.com' }
  });
  const candidateReference = await sgosRevisionCandidateReference(root, result.candidate.candidateId);
  const scope = { workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 };
  const context = {
    repositorySha256: digest('a'), headCommit, sourceTreeSha256: digest('b'),
    configSha256: digest('c'), workflowSha256: digest('d'),
    approvedIntentSha256: digest('e'), routeContractSha256: digest('f'),
    proofProfileSha256: digest('1'), editorDiskIndexBaselineSha256: digest('2')
  };
  let liveContext = context;
  let currentPrecheckInput = null;
  const loopStore = createRevisionLoopStore({
    root, ...scope, assertCurrentContext: async ({ scope: selected, context: latest }) =>
      hash(selected) === hash(scope) && hash(latest) === hash(liveContext),
    verifyRetainedCandidate: async (candidate, { scope: selected }) => {
      const reference = [initialReference, candidateReference]
        .find((item) => item.candidateId === candidate.candidateId);
      return reference != null && hash(selected) === hash(scope)
        && hash(summary(reference)) === hash(candidate)
        && await verifySgosRevisionCandidateReference(root, reference, {
          subjectId: 'PAY-142:implementation'
        });
    },
    verifyCurrentPrecheck: async (receipt, { scope: selected, context: latest, headSnapshot }) =>
      currentPrecheckInput != null && hash(selected) === hash(scope)
      && hash(latest) === hash(liveContext)
      && computeRevisionPrecheck(currentPrecheckInput).precheckSha256 === receipt.precheckSha256
      && headSnapshot.headSnapshotSha256 === receipt.headSnapshotSha256
  });
  await loopStore.append({
    expectedRevision: -1, expectedHeadCandidateRefSha256: null,
    context, idempotencyKey: 'open-loop',
    transition: { type: 'open-loop', loopId: 'LOOP-PAY-142', initialCandidate: summary(initialReference) }
  });
  const opened = await loopStore.read();
  const nextCandidate = summary(candidateReference);
  const transitionCore = {
    schemaVersion: 1, kind: 'revision-head-transition',
    expectedLoopRevision: opened.revision,
    expectedHeadTransitionSha256: opened.headTransitionSha256,
    fromCandidateRefSha256: opened.head.candidateRefSha256,
    toCandidateRefSha256: nextCandidate.candidateRefSha256,
    worktreeIndexEditorPreimageSha256: context.editorDiskIndexBaselineSha256,
    materializedPostimageSha256: context.editorDiskIndexBaselineSha256,
    reason: 'admitted-result'
  };
  const headTransition = { ...transitionCore, transitionSha256: hash(transitionCore) };
  const hunkClaimSet = {
    schemaVersion: 1, kind: 'revision-hunk-claim-set',
    parentCandidateId: initialReference.candidateId,
    resultCandidateId: candidateReference.candidateId,
    claims: [{ hunkId: 'HUNK-001', cause: { kind: 'criterion', id: 'PAY-142:AC-001' }, status: 'claimed' }],
    unexplained: []
  };
  hunkClaimSet.claimSetSha256 = hash(hunkClaimSet);
  const precheckInput = {
    candidateReference,
    head: {
      ...nextCandidate,
      headRevision: opened.revision + 1,
      headTransitionSha256: headTransition.transitionSha256,
      phaseGeneration: scope.phaseGeneration,
      workflowSha256: context.workflowSha256,
      configSha256: context.configSha256,
      proofProfileSha256: context.proofProfileSha256,
      editorDiskIndexBaselineSha256: context.editorDiskIndexBaselineSha256
    },
    bindings: {
      criteriaBindingSha256: digest('4'),
      specificationDispositionSha256: digest('5'),
      hunkClaimSetSha256: hunkClaimSet.claimSetSha256
    },
    hunkClaimSet,
    worktree: {
      savedTree: nextCandidate.candidateTree,
      editorDiskIndexBaselineSha256: context.editorDiskIndexBaselineSha256,
      changedPaths: []
    },
    validations: Object.fromEntries(requiredChecks.map((name) => [name, {
      status: 'pass', evidenceSha256: hash(name)
    }])),
    criteria: [{
      clauseId: 'PAY-142:AC-001', applicable: true, claimedChange: true,
      witnessReady: false, availability: 'available', contradicted: false,
      testBodySha256: null, environmentSha256: null, witnesses: []
    }],
    refusalSummary: { count: 0, corrected: 0, unresolved: 0 },
    proofProfile: 'standard'
  };
  const precheckReceipt = computeRevisionPrecheck(precheckInput);
  currentPrecheckInput = precheckInput;
  const snapshotCore = {
    candidateId: nextCandidate.candidateId,
    candidateSha256: nextCandidate.candidateSha256,
    candidateRefSha256: nextCandidate.candidateRefSha256,
    candidateTree: nextCandidate.candidateTree,
    phaseGeneration: scope.phaseGeneration,
    headRevision: opened.revision + 1,
    headTransitionSha256: headTransition.transitionSha256,
    workflowSha256: context.workflowSha256,
    configSha256: context.configSha256,
    proofProfileSha256: context.proofProfileSha256,
    editorDiskIndexBaselineSha256: context.editorDiskIndexBaselineSha256
  };
  const headSnapshot = { ...snapshotCore, headSnapshotSha256: hash(snapshotCore) };
  assert.equal(headSnapshot.headSnapshotSha256, precheckReceipt.headSnapshotSha256);
  const intervalCore = {
    schemaVersion: 1, kind: 'revision-interval',
    intervalId: 'REV-PAY-142-IMPLEMENTATION-001', sequence: 1,
    subject: scope, trigger: { kind: 'developer-feedback', feedbackSha256: digest('6') },
    parentCandidate: summary(initialReference), resultCandidate: nextCandidate,
    packetSha256: digest('7'), precheckSha256: precheckReceipt.precheckSha256,
    status: 'prechecked'
  };
  const interval = { ...intervalCore, intervalSha256: hash(intervalCore) };
  await loopStore.append({
    expectedRevision: opened.revision,
    expectedHeadCandidateRefSha256: opened.head.candidateRefSha256,
    context, idempotencyKey: 'commit-interval',
    transition: {
      type: 'commit-interval', loopId: opened.loopId,
      interval, headTransition, headSnapshot, precheck: precheckReceipt
    }
  });
  git('add', 'app.txt');
  const prospectiveTree = git('write-tree');
  const config = {};
  const workflow = { workItem: { id: 'PAY-142' }, currentPhase: 'implementation' };
  const request = {
    root, loopStore, candidateReference, precheckReceipt, prospectiveTree,
    config, workflow,
    readCurrentContext: async () => liveContext,
    readCurrentPrecheckInput: async () => precheckInput
  };
  return {
    ...request, git, context, precheckInput, initialReference,
    setLiveContext(next) { liveContext = next; }
  };
}

test('real local loop selects only the exact fresh head and application tree', async (t) => {
  const value = await fixture(t);
  const selection = await verifyRevisionPublicationSelection(value);
  const selected = await value.loopStore.read();
  assert.equal(selection.loopRevision, selected.revision);
  assert.equal(selection.journalEntrySha256, selected.entrySha256);
  assert.equal(selection.headSnapshotSha256, selected.headSnapshotSha256);
  assert.equal(selection.precheckSha256, value.precheckReceipt.precheckSha256);
  assert.equal(selection.candidateRefSha256, hash(value.candidateReference));
  assert.equal(selection.selectionSha256, hash(Object.fromEntries(
    Object.entries(selection).filter(([key]) => key !== 'selectionSha256')
  )));
});

test('prior candidate, prior receipt, and changed context cannot authorize publication', async (t) => {
  const value = await fixture(t);
  await assert.rejects(verifyRevisionPublicationSelection({
    ...value, candidateReference: value.initialReference
  }), { code: 'REV_PUBLISH_CANDIDATE_MISMATCH' });
  await assert.rejects(verifyRevisionPublicationSelection({
    ...value, precheckReceipt: { ...value.precheckReceipt, headRevision: 0 }
  }), { code: 'REV_PRECHECK_STALE' });
  await assert.rejects(verifyRevisionPublicationSelection({
    ...value, readCurrentContext: async () => ({ ...value.context, configSha256: digest('0') })
  }), { code: 'REV_PUBLICATION_CONTEXT_STALE' });
});

test('application-byte mismatch and current-precheck drift refuse before publication', async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.root, 'app.txt'), 'unselected bytes\n');
  value.git('add', 'app.txt');
  await assert.rejects(verifyRevisionPublicationSelection({
    ...value, prospectiveTree: value.git('write-tree')
  }), { code: 'REV_PUBLICATION_CANDIDATE_MISMATCH' });
  await assert.rejects(verifyRevisionPublicationSelection({
    ...value,
    readCurrentPrecheckInput: async () => ({
      ...value.precheckInput,
      worktree: { ...value.precheckInput.worktree,
        savedTree: 'f'.repeat(40), changedPaths: ['app.txt'] }
    })
  }), { code: 'REV_MANUAL_DRIFT' });
});

test('restore clears old precheck authority; a fresh head-bound receipt can be selected', async (t) => {
  const value = await fixture(t);
  const current = await value.loopStore.read();
  const selectedCandidate = summary(value.initialReference);
  const restoredContext = {
    ...value.context, editorDiskIndexBaselineSha256: digest('9')
  };
  value.setLiveContext(restoredContext);
  const transitionCore = {
    schemaVersion: 1, kind: 'revision-head-transition',
    expectedLoopRevision: current.revision,
    expectedHeadTransitionSha256: current.headTransitionSha256,
    fromCandidateRefSha256: current.head.candidateRefSha256,
    toCandidateRefSha256: selectedCandidate.candidateRefSha256,
    worktreeIndexEditorPreimageSha256: current.context.editorDiskIndexBaselineSha256,
    materializedPostimageSha256: restoredContext.editorDiskIndexBaselineSha256,
    reason: 'restore'
  };
  const headTransition = { ...transitionCore, transitionSha256: hash(transitionCore) };
  const snapshotCore = {
    ...selectedCandidate,
    phaseGeneration: value.loopStore.scope.phaseGeneration,
    headRevision: current.revision + 1,
    headTransitionSha256: headTransition.transitionSha256,
    workflowSha256: restoredContext.workflowSha256,
    configSha256: restoredContext.configSha256,
    proofProfileSha256: restoredContext.proofProfileSha256,
    editorDiskIndexBaselineSha256: restoredContext.editorDiskIndexBaselineSha256
  };
  const headSnapshot = { ...snapshotCore, headSnapshotSha256: hash(snapshotCore) };
  await value.loopStore.append({
    expectedRevision: current.revision,
    expectedHeadCandidateRefSha256: current.head.candidateRefSha256,
    context: restoredContext, idempotencyKey: 'restore-initial',
    transition: {
      type: 'select-head', loopId: current.loopId,
      selectedCandidate, headTransition, headSnapshot
    }
  });
  const selected = await value.loopStore.read();
  assert.equal(selected.precheckSha256, null);
  assert.equal(selected.headSnapshotSha256, headSnapshot.headSnapshotSha256);
  await assert.rejects(verifyRevisionPublicationSelection({
    ...value, candidateReference: value.initialReference,
    readCurrentContext: async () => restoredContext
  }), { code: 'REV_PRECHECK_STALE' });

  await writeFile(path.join(value.root, 'app.txt'), 'initial candidate\n');
  value.git('add', 'app.txt');
  const freshInput = structuredClone(value.precheckInput);
  freshInput.candidateReference = value.initialReference;
  freshInput.head = { ...snapshotCore };
  freshInput.worktree = {
    savedTree: selectedCandidate.candidateTree,
    editorDiskIndexBaselineSha256: restoredContext.editorDiskIndexBaselineSha256,
    changedPaths: []
  };
  freshInput.hunkClaimSet = {
    schemaVersion: 1, kind: 'revision-hunk-claim-set',
    parentCandidateId: value.candidateReference.candidateId,
    resultCandidateId: value.initialReference.candidateId,
    claims: [], unexplained: []
  };
  freshInput.hunkClaimSet.claimSetSha256 = hash(freshInput.hunkClaimSet);
  freshInput.bindings.hunkClaimSetSha256 = freshInput.hunkClaimSet.claimSetSha256;
  const freshReceipt = computeRevisionPrecheck(freshInput);
  const selection = await verifyRevisionPublicationSelection({
    ...value, candidateReference: value.initialReference,
    precheckReceipt: freshReceipt,
    prospectiveTree: value.git('write-tree'),
    readCurrentContext: async () => restoredContext,
    readCurrentPrecheckInput: async () => freshInput
  });
  assert.equal(selection.headSnapshotSha256, headSnapshot.headSnapshotSha256);
  assert.equal(selection.precheckSha256, freshReceipt.precheckSha256);
});
