import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordSha256 } from '../src/records.mjs';
import {
  confirmManualRevision,
  confirmRevisionLoopOpen,
  confirmRevisionPacket,
  confirmRevisionPrecheck,
  confirmRevisionRestore,
  previewManualRevision,
  previewRevisionLoopOpen,
  previewRevisionPacket,
  previewRevisionPrecheck,
  previewRevisionRestore,
  readRevisionLoopStatus
} from '../src/revision/core-orchestrator.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';
import { createRevisionLoopStore } from '../src/revision/loop-store.mjs';
import { assertCurrentRevisionPrecheck } from '../src/revision/precheck.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';

const hash = (value) => `sha256:${recordSha256(value)}`;
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const requiredChecks = [
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
];
const producer = Object.freeze({
  id: 'revision-test', version: '1', implementationSha256: digest('a')
});

function candidate(letter) {
  return Object.freeze({
    family: 'sgos-candidate',
    namespace: `refs/singularity-flow/candidates/CAN-${letter.repeat(12)}`,
    candidateId: `CAN-${letter.repeat(12)}`,
    retainedRecordSha256: digest(letter), candidateSha256: digest(letter),
    repository: {
      baselineCommit: '1'.repeat(40), candidateTree: letter.repeat(40), objectFormat: 'sha1'
    },
    sourceManifestSha256: digest(letter), effectSetSha256: digest(letter),
    createdBy: { kind: 'human', id: 'developer' }
  });
}
function summary(reference) {
  return {
    candidateId: reference.candidateId, candidateSha256: reference.candidateSha256,
    candidateRefSha256: hash(reference), candidateTree: reference.repository.candidateTree
  };
}
function context(editor = '3') {
  return {
    repositorySha256: digest('a'), headCommit: '1'.repeat(40), sourceTreeSha256: digest('b'),
    configSha256: digest('c'), workflowSha256: digest('d'),
    approvedIntentSha256: digest('e'), routeContractSha256: digest('f'),
    proofProfileSha256: digest('2'), editorDiskIndexBaselineSha256: digest(editor)
  };
}
function routeInput(parent) {
  return {
    context: {
      workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1,
      phaseTask: 'code', phaseStatus: 'in_progress', specificationDisposition: 'implementation-change',
      target: { kind: 'implementation', id: 'PAY-142:implementation', status: 'draft' },
      parentCandidate: parent, headCommit: '1'.repeat(40), sourceTreeSha256: digest('b'),
      configSha256: digest('c'), workflowSha256: digest('d'),
      repositorySha256: digest('a'), approvedIntentSha256: digest('e'),
      routeContractSha256: digest('f'), identity: { kind: 'configured-local', id: 'developer' },
      installedOperations: ['revision.code']
    },
    feedbackText: 'Correct the bounded retry path without changing accepted intent.'
  };
}

async function loopFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const initial = candidate('a');
  const result = candidate('b');
  const known = new Map([[initial.candidateId, initial], [result.candidateId, result]]);
  let liveContext = context();
  let currentPrecheckInput = null;
  const scope = { workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 };
  const verifyCandidateReference = async (reference) =>
    hash(reference) === hash(known.get(reference.candidateId));
  const loopStore = createRevisionLoopStore({
    root, ...scope, producer,
    assertCurrentContext: async ({ scope: selected, context: supplied }) =>
      hash(selected) === hash(scope) && hash(supplied) === hash(liveContext),
    verifyRetainedCandidate: async (selected) => {
      const reference = known.get(selected.candidateId);
      return reference != null && hash(summary(reference)) === hash(selected);
    },
    verifyCurrentPrecheck: async (receipt) => {
      if (!currentPrecheckInput) return false;
      try { return assertCurrentRevisionPrecheck(receipt, currentPrecheckInput) === receipt
        || receipt.precheckSha256 === assertCurrentRevisionPrecheck(receipt, currentPrecheckInput).precheckSha256; }
      catch { return false; }
    }
  });
  return {
    root, loopStore, initial, result, verifyCandidateReference,
    readCurrentContext: async () => liveContext,
    setContext(value) { liveContext = value; },
    setPrecheckInput(value) { currentPrecheckInput = value; }
  };
}

test('packet preview/confirm is deterministic, exact, and execution-free', async () => {
  const parent = candidate('a');
  const selectedRouteInput = routeInput(parent);
  let candidateChecks = 0;
  const packetInput = {
    parentCandidate: parent,
    producer,
    verifyCandidate: async (reference) => {
      candidateChecks += 1;
      return hash(reference) === hash(parent);
    },
    feedbackId: 'REVFB-ABCDEF123456', feedbackRecordSha256: digest('4'),
    criteria: { items: [{ id: 'AC-1', text: 'Retries stop at the configured bound.' }] },
    criteriaBindingSha256: digest('5'), specificationDispositionSha256: digest('6'),
    rules: { task: 'code', writeScope: 'source-and-artifact', protectedPaths: [] },
    diff: 'diff --git a/src/retry.js b/src/retry.js\n',
    skeletons: [{ path: 'src/retry.js', operation: 'modify', type: 'source' }],
    effectPolicy: {
      writeScope: 'source-and-artifact', maximumChangedFiles: 32,
      protectedPaths: [], protectedPathsSha256: hash([]),
      applicationPathPolicySha256: digest('7'), externalEffectsAllowed: false
    }
  };
  const first = await previewRevisionPacket({ routeInput: selectedRouteInput, packetInput });
  const second = await previewRevisionPacket({ routeInput: selectedRouteInput, packetInput });
  assert.equal(first.planSha256, second.planSha256);
  const packet = await confirmRevisionPacket({
    plan: first, confirmation: first.planSha256,
    routeInput: selectedRouteInput, packetInput
  });
  assert.equal(packet.packetSha256, first.packet.packetSha256);
  assert.ok(candidateChecks >= 3);
  await assert.rejects(confirmRevisionPacket({
    plan: first, confirmation: digest('9'),
    routeInput: selectedRouteInput, packetInput
  }), { code: 'REV_ORCHESTRATION_CONFIRMATION_REQUIRED' });
  await assert.rejects(confirmRevisionPacket({
    plan: first, confirmation: first.planSha256,
    routeInput: { ...selectedRouteInput, feedbackText: 'Changed after preview.' }, packetInput
  }), { code: 'REV_ROUTE_PLAN_STALE' });
});

test('open, precheck, status, and restore share one exact idempotent CAS workflow', async (t) => {
  const value = await loopFixture(t);
  assert.equal((await readRevisionLoopStatus({ loopStore: value.loopStore })).state, 'absent');
  const open = await previewRevisionLoopOpen({
    loopStore: value.loopStore, context: context(), initialCandidate: value.initial,
    loopId: 'LOOP-PAY-142', idempotencyKey: 'open-loop',
    verifyCandidateReference: value.verifyCandidateReference
  });
  await assert.rejects(confirmRevisionLoopOpen({
    loopStore: value.loopStore, plan: open, confirmation: digest('9'),
    readCurrentContext: value.readCurrentContext,
    verifyCandidateReference: value.verifyCandidateReference
  }), { code: 'REV_ORCHESTRATION_CONFIRMATION_REQUIRED' });
  const opened = await confirmRevisionLoopOpen({
    loopStore: value.loopStore, plan: open, confirmation: open.planSha256,
    readCurrentContext: value.readCurrentContext,
    verifyCandidateReference: value.verifyCandidateReference
  });
  assert.equal(opened.status.revision, 0);
  const replayedOpen = await confirmRevisionLoopOpen({
    loopStore: value.loopStore, plan: open, confirmation: open.planSha256,
    readCurrentContext: value.readCurrentContext,
    verifyCandidateReference: value.verifyCandidateReference
  });
  assert.equal(replayedOpen.entry.entrySha256, opened.entry.entrySha256);

  const selectedRouteInput = routeInput(value.initial);
  const packetPlan = await previewRevisionPacket({
    routeInput: selectedRouteInput,
    packetInput: {
      parentCandidate: value.initial, verifyCandidate: value.verifyCandidateReference,
      producer,
      feedbackId: 'REVFB-ABCDEF123456', feedbackRecordSha256: digest('4'),
      criteria: { items: [{ id: 'PAY-142:AC-001', text: 'Retry path remains bounded.' }] },
      criteriaBindingSha256: digest('5'), specificationDispositionSha256: digest('6'),
      rules: { task: 'code', writeScope: 'source-and-artifact', protectedPaths: [] },
      diff: 'diff --git a/app.js b/app.js\n',
      skeletons: [{ path: 'app.js', operation: 'modify', type: 'source' }],
      effectPolicy: {
        writeScope: 'source-and-artifact', maximumChangedFiles: 32,
        protectedPaths: [], protectedPathsSha256: hash([]),
        applicationPathPolicySha256: digest('7'), externalEffectsAllowed: false
      }
    }
  });
  const claimCore = {
    schemaVersion: 1, kind: 'revision-hunk-claim-set',
    subject: { workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 },
    parentCandidateId: value.initial.candidateId,
    resultCandidateId: value.result.candidateId,
    claims: [{ hunkId: 'HUNK-001', cause: { kind: 'criterion', id: 'PAY-142:AC-001' }, status: 'claimed' }],
    unexplained: [], producer
  };
  const hunkClaimSet = { ...claimCore, claimSetSha256: hash(claimCore) };
  const nextContext = context('4');
  const precheck = await previewRevisionPrecheck({
    loopStore: value.loopStore, context: nextContext, resultCandidate: value.result,
    routeInput: selectedRouteInput, routePlan: packetPlan.routePlan, packet: packetPlan.packet,
    precheckEvidence: {
      bindings: {
        criteriaBindingSha256: digest('5'), specificationDispositionSha256: digest('6'),
        hunkClaimSetSha256: hunkClaimSet.claimSetSha256
      },
      hunkClaimSet,
      worktree: {
        savedTree: value.result.repository.candidateTree,
        editorDiskIndexBaselineSha256: nextContext.editorDiskIndexBaselineSha256,
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
    },
    trigger: {
      kind: 'developer-feedback', feedbackId: 'REVFB-ABCDEF123456',
      author: { kind: 'configured-local', id: 'developer', name: 'Developer' },
      feedbackSha256: packetPlan.packet.feedback.feedbackSha256,
      feedbackRecordSha256: digest('4'), criteriaBindingSha256: digest('5'),
      specificationDispositionSha256: digest('6'), startPinSha256: digest('7'),
      noteSha256: digest('8')
    },
    executionAttempts: [digest('9')],
    producer,
    startedAt: '2026-09-17T00:00:00.000Z',
    endedAt: '2026-09-17T00:00:00.000Z',
    intervalId: 'REV-PAY-142-IMPLEMENTATION-001', idempotencyKey: 'interval-1',
    verifyCandidateReference: value.verifyCandidateReference
  });
  value.setContext(nextContext);
  value.setPrecheckInput(precheck.precheckInput);
  const admitted = await confirmRevisionPrecheck({
    loopStore: value.loopStore, plan: precheck, confirmation: precheck.planSha256,
    readCurrentContext: value.readCurrentContext,
    verifyCandidateReference: value.verifyCandidateReference
  });
  assert.equal(admitted.status.revision, 1);
  assert.equal(admitted.status.prechecked, true);
  assert.equal(admitted.status.publicationReady, false);
  assert.equal(admitted.status.head.candidateId, value.result.candidateId);
  const replayed = await confirmRevisionPrecheck({
    loopStore: value.loopStore, plan: precheck, confirmation: precheck.planSha256,
    readCurrentContext: value.readCurrentContext,
    verifyCandidateReference: value.verifyCandidateReference
  });
  assert.equal(replayed.entry.entrySha256, admitted.entry.entrySha256);

  const restoredContext = context('7');
  const restore = await previewRevisionRestore({
    loopStore: value.loopStore, context: restoredContext,
    producer,
    selectedCandidate: value.initial, reason: 'developer-rejected-result',
    idempotencyKey: 'restore-1', verifyCandidateReference: value.verifyCandidateReference
  });
  value.setContext(restoredContext);
  const restored = await confirmRevisionRestore({
    loopStore: value.loopStore, plan: restore, confirmation: restore.planSha256,
    readCurrentContext: value.readCurrentContext,
    verifyCandidateReference: value.verifyCandidateReference
  });
  assert.equal(restored.status.revision, 2);
  assert.equal(restored.status.head.candidateId, value.initial.candidateId);
  assert.equal(restored.status.precheckSha256, null);
  assert.equal(restored.status.publicationReady, false);

  const staleContext = context('8');
  const stale = await previewRevisionRestore({
    loopStore: value.loopStore, context: staleContext,
    producer,
    selectedCandidate: value.result, idempotencyKey: 'restore-stale',
    verifyCandidateReference: value.verifyCandidateReference
  });
  value.setContext(context('9'));
  await assert.rejects(confirmRevisionRestore({
    loopStore: value.loopStore, plan: stale, confirmation: stale.planSha256,
    readCurrentContext: value.readCurrentContext,
    verifyCandidateReference: value.verifyCandidateReference
  }), { code: 'REV_ORCHESTRATION_STALE' });
  assert.equal((await readRevisionLoopStatus({ loopStore: value.loopStore })).revision, 2);
});

test('manual capture uses the same exact confirmation boundary without advancing the loop', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-core-manual-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 1;\n');
  git('add', 'src/app.js');
  git('commit', '-m', 'baseline');
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 2;\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation',
    createdBy: { kind: 'human', id: 'developer' },
    createdAt: '2026-09-20T00:00:00.000Z'
  });
  const parentCandidate = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  const options = {
    root, subjectId: 'PAY-142:implementation', parentCandidate,
    note: 'Use the saved value three', allowedPaths: ['src/app.js'],
    config: {}, workflow: {}, verifySavedEditorBuffers: async () => ({
      status: 'all-saved', snapshotSha256: digest('a')
    })
  };
  const selected = await previewManualRevision(options);
  assert.equal(selected.status, 'ready-for-explicit-freeze');
  await assert.rejects(confirmManualRevision({
    ...options, plan: selected, confirmation: digest('9'),
    verifyAdmission: async () => true,
    createdBy: { kind: 'human', id: 'developer' }
  }), { code: 'REV_ORCHESTRATION_CONFIRMATION_REQUIRED' });
  const frozen = await confirmManualRevision({
    ...options, plan: selected, confirmation: selected.planSha256,
    verifyAdmission: async ({ attemptResult }) => attemptResult.cleanup.verified === true,
    createdBy: { kind: 'human', id: 'developer' },
    createdAt: '2026-09-20T00:01:00.000Z'
  });
  assert.equal(frozen.loopHeadAdvanced, false);
  assert.equal(frozen.precheckRecorded, false);
  assert.equal(frozen.storyPublished, false);
  assert.equal(git('show', `${frozen.frozen.childCommit}:src/app.js`), 'export const value = 3;');
});
