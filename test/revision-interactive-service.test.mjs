import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  buildRevisionAttempt, buildRevisionCriteriaBinding, buildRevisionFeedback,
  buildRevisionHunkClaimSet, buildRevisionInterval,
  buildRevisionSpecificationDisposition, validateRevisionRecord
} from '../src/revision/contracts.mjs';
import {
  confirmInteractiveCapture, confirmInteractiveRevision, previewInteractiveCapture,
  previewInteractiveRevision, renderRevisionCard, resolveIntervalRecordChain,
  replayInteractiveRevisionConfirmation, resumeInteractiveRevision
} from '../src/revision/interactive-service.mjs';
import {
  readRevisionInteractiveState, writeRevisionInteractivePayload,
  writeRevisionInteractiveState
} from '../src/revision/interactive-state.mjs';
import {
  confirmRevisionLoopOpen, previewManualRevision, previewRevisionLoopOpen
} from '../src/revision/core-orchestrator.mjs';
import { createRevisionLoopStore } from '../src/revision/loop-store.mjs';
import { computeRevisionPrecheck } from '../src/revision/precheck.mjs';
import {
  loadActiveRevisionStory, producerIdentity, readRevisionContext, revisionLoopStore
} from '../src/revision/product-context.mjs';
import {
  previewFeedbackAttachments, registerFeedbackAttachments
} from '../src/revision/feedback-attachments.mjs';
import { createFeedbackAttachmentStore } from '../src/revision/feedback-attachment-store.mjs';
import { writeRevisionRecord } from '../src/revision/store.mjs';
import { setAgentSession } from '../src/session.mjs';
import { buildSpecIndex } from '../src/specifications.mjs';
import { createWorkflow, loadConfig, saveWorkflow } from '../src/state.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';
import { currentInteractiveRevisionPublication } from '../src/revision/publication-adapter.mjs';

const hash = (value) => `sha256:${recordSha256(value)}`;
const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const bytesHash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const H = (letter) => `sha256:${letter.repeat(64)}`;
const subject = Object.freeze({ workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 });
const producer = Object.freeze({
  id: 'revision-test', version: '1', implementationSha256: H('f')
});
const checks = [
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
];

const candidate = {
  candidateId: 'CAN-PAY-142-000001', candidateSha256: `sha256:${'1'.repeat(64)}`,
  candidateTree: 'a'.repeat(40), criteria: [], unexplainedHunks: [],
  refusalSummary: { count: 0, corrected: 0, unresolved: 0 },
  remainingObligations: [], publicationEligible: true
};

async function interactiveRevisionRepository(t, id) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-interactive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/app.js'), 'export const value = 1;\n');
  await initializeDefinition(root);
  git('add', '.');
  git('commit', '-m', 'repository setup');
  git('switch', '-c', id);

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const workflow = await createWorkflow(root, config, {
    id, title: 'Interactive revision',
    source: {
      type: 'manual', key: id, title: 'Interactive revision',
      description: 'Exercise the guarded public revision path.',
      acceptanceCriteria: ['The implementation exports value 2.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'product-owner',
    resolved: resolveWorkType(config, 'feature')
  });
  const requirementsRelative = `singularity/work-items/${id}/artifacts/requirements/requirements.md`;
  await mkdir(path.dirname(path.join(root, requirementsRelative)), { recursive: true });
  await writeFile(path.join(root, requirementsRelative),
    `# Requirements\n\n[${id}:AC-001] The implementation exports value 2.\n`);
  workflow.phases.requirements.status = 'approved';
  workflow.phases.requirements.generation = 1;
  await buildSpecIndex(root, requirementsRelative, {
    workId: id, phase: 'requirements', generation: 1,
    outputPath: `singularity/work-items/${id}/context/spec-indexes/requirements-gen1.json`,
    policy: { mode: 'enforce', namespace: id }
  });
  workflow.currentPhase = 'implementation';
  workflow.phases.implementation.status = 'in_progress';
  workflow.phases.implementation.generation = 1;
  await saveWorkflow(root, config, workflow);
  await setAgentSession(root, config, {
    name: 'Revision Test', email: 'revision@example.com', login: null
  }, 'product-owner', id, { phaseId: 'implementation', source: 'test' });
  return { root, git, config, workflow };
}

async function completeInteractiveRevision(root, id) {
  const startOptions = {
    feedbackText: `Fix ${id}:AC-001 because the implementation misses the required value.`,
    criteria: [], disposition: null, attachmentSetSha256: null,
    savedBuffersConfirmed: true
  };
  const startPlan = await previewInteractiveRevision(root, startOptions);
  const started = await confirmInteractiveRevision(root, {
    plan: startPlan, confirmation: startPlan.planSha256, ...startOptions
  });
  await writeFile(path.join(root, 'src/app.js'), 'export const value = 2;\n');
  const captureOptions = {
    note: `Implement the exact ${id}:AC-001 correction`, savedBuffersConfirmed: true
  };
  const capturePlan = await previewInteractiveCapture(root, captureOptions);
  const completed = await confirmInteractiveCapture(root, {
    plan: capturePlan, confirmation: capturePlan.planSha256, ...captureOptions
  });
  return { startOptions, startPlan, started, captureOptions, capturePlan, completed };
}

test('guarded REV cards expose publication only for an eligible exact current precheck', () => {
  const current = renderRevisionCard({
    status: { scope: { phaseId: 'implementation' }, intervalSequence: 1 },
    precheck: candidate, state: { status: 'prechecked' }
  });
  assert.equal(current.publicationEligible, true);
  assert.deepEqual(current.remainingObligations, []);
  assert.equal(current.next, 'phase.publish-code');

  const historical = renderRevisionCard({
    status: { scope: { phaseId: 'implementation' }, intervalSequence: 1 },
    precheck: candidate, historical: true
  });
  assert.equal(historical.publicationEligible, false);
  assert.match(historical.headline, /^Historical revision interval/u);
  assert.ok(historical.remainingObligations.includes(
    'historical-interval-is-not-current-authority'));
});

test('ordinary Code publication sees no binding before REV and refuses an ineligible selected head', async (t) => {
  const id = 'REV-PUBLICATION-ADAPTER-1';
  const { root, config, workflow } = await interactiveRevisionRepository(t, id);
  const accepted = { definition: config, workflow };
  assert.equal(await currentInteractiveRevisionPublication(root, accepted), null);

  const completed = await completeInteractiveRevision(root, id);
  assert.equal(completed.completed.state.status, 'prechecked');
  assert.equal(completed.completed.precheck.publicationEligible, false);
  await assert.rejects(currentInteractiveRevisionPublication(root, accepted), {
    code: 'REV_PUBLICATION_NOT_READY'
  });
});

test('guarded REV state cards route every incomplete effect through the exact recovery action', () => {
  for (const status of ['opening', 'capturing', 'candidate-frozen', 'abandoning']) {
    const card = renderRevisionCard({ status: null, precheck: null, state: { status } });
    assert.equal(card.publicationEligible, false, status);
    assert.equal(card.next, 'revision.resume', status);
  }
  const recoveryRequired = renderRevisionCard({
    status: null,
    precheck: null,
    state: { status: 'recovery-required', recoveryCode: 'REV_CAPTURE_OUTCOME_UNCERTAIN' }
  });
  assert.equal(recoveryRequired.publicationEligible, false);
  assert.equal(recoveryRequired.next, 'revision.status');
  assert.ok(recoveryRequired.remainingObligations.includes('REV_CAPTURE_OUTCOME_UNCERTAIN'));
  assert.match(recoveryRequired.recoveryGuidance, /will not repeat an uncertain attempt/u);
  assert.equal(renderRevisionCard({
    status: null, precheck: null, state: { status: 'awaiting-edit' }
  }).next, 'revision.capture');
  const abandoned = renderRevisionCard({
    status: null, precheck: null, state: { status: 'abandoned' }
  });
  assert.equal(abandoned.publicationEligible, false);
  assert.equal(abandoned.next, 'revision.status');
});

test('interval show resolves and validates the complete private durable record chain', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-show-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);

  const feedbackText = 'Fix PAY-142:AC-001 without changing its accepted meaning.';
  const feedback = buildRevisionFeedback({
    feedbackId: 'REVFB-ABCDEF123456', subject,
    author: { kind: 'configured-local', id: 'developer@example.com', name: 'Developer' },
    text: feedbackText, bytes: Buffer.byteLength(feedbackText),
    feedbackSha256: bytesHash(feedbackText), capturedAt: '2026-09-20T00:00:00.000Z',
    producer
  });
  const binding = buildRevisionCriteriaBinding({
    subject, feedbackSha256: feedback.feedbackSha256, mode: 'explicit',
    criteria: [{ clauseId: 'PAY-142:AC-001', clauseSha256: H('1') }],
    binder: { id: 'revision-criteria-binder', version: 1, implementationSha256: H('2') },
    producer
  });
  const disposition = buildRevisionSpecificationDisposition({
    subject, feedbackSha256: feedback.feedbackSha256,
    bindingSha256: binding.bindingSha256, result: 'implementation-change',
    predicateResults: [{ predicateId: 'implementation-correction-language', result: 'pass' }],
    humanResolution: null, producer
  });
  const parent = {
    candidateId: 'CAN-PARENT-100', candidateSha256: H('3'),
    candidateRefSha256: H('4'), candidateTree: 'a'.repeat(40)
  };
  const resultReference = {
    family: 'sgos-candidate', namespace: 'refs/singularity-flow/candidates/CAN-RESULT-101',
    candidateId: 'CAN-RESULT-101', retainedRecordSha256: H('5'), candidateSha256: H('6'),
    repository: { baselineCommit: 'b'.repeat(40), candidateTree: 'c'.repeat(40), objectFormat: 'sha1' },
    sourceManifestSha256: H('7'), effectSetSha256: H('8'),
    createdBy: { kind: 'human', id: 'developer@example.com' }
  };
  const result = {
    candidateId: resultReference.candidateId, candidateSha256: resultReference.candidateSha256,
    candidateRefSha256: hash(resultReference), candidateTree: resultReference.repository.candidateTree
  };
  const rules = { task: 'code', writeScope: 'source-and-artifact', protectedPaths: [] };
  const effectPolicy = {
    writeScope: 'source-and-artifact', maximumChangedFiles: 32,
    protectedPaths: [], protectedPathsSha256: hash([]),
    applicationPathPolicySha256: H('9'), externalEffectsAllowed: false
  };
  const packetCore = {
    schemaVersion: 1, kind: 'revision-packet', subject, routePlanSha256: H('a'),
    parentCandidate: {
      candidateId: parent.candidateId, candidateSha256: parent.candidateSha256,
      candidateRefSha256: parent.candidateRefSha256
    },
    feedback: {
      feedbackId: feedback.feedbackId, feedbackRecordSha256: feedback.recordSha256,
      feedbackSha256: feedback.feedbackSha256, text: feedback.text
    },
    attachments: [], criteria: { items: [{ id: 'PAY-142:AC-001', text: 'Keep the retry bound.' }] },
    criteriaBindingSha256: binding.bindingSha256,
    specificationDispositionSha256: disposition.dispositionSha256,
    rules, rulesSha256: hash(rules), diff: '', diffSha256: bytesHash(''), skeletons: [],
    skeletonSetSha256: hash([]), effectPolicy, effectPolicySha256: hash(effectPolicy),
    expansions: [], budgets: {
      maximumInputBytes: 131072, maximumOutputBytes: 1048576,
      maximumToolCalls: 50, maximumSubattempts: 3
    }, producer
  };
  const packet = validateRevisionRecord('revision-packet', {
    ...packetCore, packetSha256: hash(packetCore)
  });
  const claims = buildRevisionHunkClaimSet({
    subject, parentCandidateId: parent.candidateId, resultCandidateId: result.candidateId,
    claims: [{
      hunkId: 'HUNK-001', cause: { kind: 'criterion', id: 'PAY-142:AC-001' }, status: 'claimed'
    }], unexplained: [], producer
  });
  const attempt = buildRevisionAttempt({
    attemptId: 'REVATT-PAY-142-001-01', intervalId: 'REV-PAY-142-001', sequence: 1,
    subject, parentCandidate: {
      candidateId: parent.candidateId, candidateSha256: parent.candidateSha256
    },
    provider: producer, status: 'candidate-frozen', reasonCode: null,
    effectSetSha256: resultReference.effectSetSha256,
    resultCandidate: {
      candidateId: result.candidateId, candidateSha256: result.candidateSha256,
      candidateTree: result.candidateTree,
      sourceManifestSha256: resultReference.sourceManifestSha256
    },
    restorationReceiptSha256: null, startedAt: '2026-09-20T00:01:00.000Z',
    endedAt: '2026-09-20T00:02:00.000Z', producer
  });
  const precheckInput = {
    subject, producer, candidateReference: resultReference,
    head: {
      ...result, headRevision: 1, headTransitionSha256: H('b'), phaseGeneration: 1,
      workflowSha256: H('c'), configSha256: H('d'), proofProfileSha256: H('e'),
      editorDiskIndexBaselineSha256: H('0')
    },
    bindings: {
      criteriaBindingSha256: binding.bindingSha256,
      specificationDispositionSha256: disposition.dispositionSha256,
      hunkClaimSetSha256: claims.claimSetSha256
    },
    hunkClaimSet: claims,
    worktree: {
      savedTree: result.candidateTree, editorDiskIndexBaselineSha256: H('0'), changedPaths: []
    },
    validations: Object.fromEntries(checks.map((name) => [name, {
      status: 'pass', evidenceSha256: hash(name)
    }])),
    criteria: [{
      clauseId: 'PAY-142:AC-001', applicable: true, claimedChange: true,
      witnessReady: false, availability: 'available', contradicted: false,
      testBodySha256: null, environmentSha256: null, witnesses: []
    }],
    refusalSummary: { count: 0, corrected: 0, unresolved: 0 }, proofProfile: 'standard'
  };
  const precheck = computeRevisionPrecheck(precheckInput);
  const interval = buildRevisionInterval({
    intervalId: attempt.intervalId, sequence: 1, subject,
    trigger: {
      kind: 'developer-feedback', feedbackId: feedback.feedbackId,
      author: feedback.author, feedbackSha256: feedback.feedbackSha256,
      feedbackRecordSha256: feedback.recordSha256,
      criteriaBindingSha256: binding.bindingSha256,
      specificationDispositionSha256: disposition.dispositionSha256,
      startPinSha256: H('1'), noteSha256: H('2')
    },
    parentCandidate: parent, resultCandidate: result, packetSha256: packet.packetSha256,
    criteriaBindingSha256: binding.bindingSha256,
    specificationDispositionSha256: disposition.dispositionSha256,
    executionAttempts: [attempt.attemptSha256], hunkClaimSetSha256: claims.claimSetSha256,
    startedAt: attempt.startedAt, endedAt: attempt.endedAt,
    producer, precheckSha256: precheck.precheckSha256, status: 'prechecked'
  });
  for (const record of [feedback, binding, disposition, packet, claims, attempt, precheck, interval]) {
    await writeRevisionRecord(root, record);
  }
  assert.equal(await writeRevisionInteractivePayload(root, subject, precheckInput),
    precheck.precheckInputsSha256);
  const entry = { transition: { interval, precheck } };
  const resolved = await resolveIntervalRecordChain(root, { subject }, entry);
  assert.equal(resolved.feedback.recordSha256, feedback.recordSha256);
  assert.equal(resolved.packet.packetSha256, packet.packetSha256);
  assert.equal(resolved.attempts[0].attemptSha256, attempt.attemptSha256);
  assert.equal(resolved.precheckInput.bindings.hunkClaimSetSha256, claims.claimSetSha256);

  const mismatched = buildRevisionInterval({
    ...Object.fromEntries(Object.entries(interval).filter(([key]) =>
      !['schemaVersion', 'kind', 'intervalSha256'].includes(key))),
    intervalId: 'REV-PAY-142-002'
  });
  await writeRevisionRecord(root, mismatched);
  await assert.rejects(resolveIntervalRecordChain(root, { subject }, {
    transition: { interval: mismatched, precheck }
  }), { code: 'REV_RECORD_CHAIN_STALE' });
});

test('public revision preview and confirmation capture one guarded manual interval', async (t) => {
  const id = 'REV-PUBLIC-1';
  const { root } = await interactiveRevisionRepository(t, id);
  const result = await completeInteractiveRevision(root, id);

  assert.equal(result.startPlan.status, 'ready');
  assert.equal(result.startPlan.expectedHeadCandidateId, null);
  assert.equal(result.startPlan.executionUnit, 'safe-built-in-manual-capture');
  assert.equal(result.startPlan.effects.codeChanged, false);
  assert.equal(result.started.replayed, false);
  assert.equal(result.started.state.status, 'awaiting-edit');
  assert.equal(result.started.state.loopRevision, 0);
  assert.equal(result.started.next, 'revision.capture');

  assert.deepEqual(result.capturePlan.allowedPaths, ['src/app.js']);
  assert.equal(result.capturePlan.expectedLoopRevision, 0);
  assert.equal(result.capturePlan.effects.retainedCandidateCreatedOnConfirmation, true);
  assert.equal(result.completed.replayed, false);
  assert.equal(result.completed.state.status, 'prechecked');
  assert.equal(result.completed.state.loopRevision, 1);
  assert.equal(result.completed.state.resultCandidateId,
    result.completed.resultCandidate.candidateId);
  assert.equal(result.completed.precheck.candidateId,
    result.completed.resultCandidate.candidateId);
  assert.equal(result.completed.precheck.publicationEligible, false);
  assert.equal(result.completed.card.publicationEligible, false);
  assert.ok(result.completed.card.remainingObligations.length > 0);

  const active = await loadActiveRevisionStory(root);
  const journal = await revisionLoopStore(active).list();
  const historicalIntervalId = journal.at(-1).transition.interval.intervalId;
  const shown = spawnSync(process.execPath, [
    CLI, 'revision', 'show', historicalIntervalId, '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.doesNotMatch(shown.stdout, new RegExp(
    result.startOptions.feedbackText.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'
  ));
  const publicResult = JSON.parse(shown.stdout);
  assert.equal(Object.hasOwn(publicResult.data.recordChain.feedback, 'text'), false);
  assert.equal(Object.hasOwn(publicResult.data.recordChain.packet.feedback, 'text'), false);
  assert.equal(publicResult.data.recordChain.feedback.feedbackSha256,
    publicResult.data.recordChain.packet.feedback.feedbackSha256);

  const directReplay = await confirmInteractiveRevision(root, {
    plan: result.startPlan, confirmation: result.startPlan.planSha256,
    ...result.startOptions
  });
  assert.equal(directReplay.replayed, true);
  assert.equal(directReplay.recoveredConfirmationResult, false);
  assert.deepEqual(directReplay.state, result.started.state,
    'direct exact replay returns the immutable original confirmation result');
});

test('public abandon accepts the loop ID before the first interval exists', async (t) => {
  const id = 'REV-ABANDON-OPEN-1';
  const { root } = await interactiveRevisionRepository(t, id);
  const feedback = `Fix ${id}:AC-001 because the implementation misses the required value.`;
  const startPreview = spawnSync(process.execPath, [
    CLI, 'revise', '--dry-run', '--feedback-stdin', '--saved-buffers-confirmed', '--json'
  ], { cwd: root, encoding: 'utf8', input: feedback });
  assert.equal(startPreview.status, 0, startPreview.stderr);
  const startPlanSha256 = JSON.parse(startPreview.stdout).data.plan.planSha256;
  const startConfirmation = spawnSync(process.execPath, [
    CLI, 'revise', '--feedback-stdin', '--saved-buffers-confirmed',
    '--confirm', startPlanSha256, '--json'
  ], { cwd: root, encoding: 'utf8', input: feedback });
  assert.equal(startConfirmation.status, 0, startConfirmation.stderr);
  const started = JSON.parse(startConfirmation.stdout);
  const active = await loadActiveRevisionStory(root);
  const store = revisionLoopStore(active);
  const opened = await store.read();
  assert.equal(started.data.state.status, 'awaiting-edit');
  assert.equal(opened.loopId, started.data.state.loopId);
  assert.equal(opened.headIntervalId, null);

  const preview = spawnSync(process.execPath, [
    CLI, 'revision', 'abandon', opened.loopId, '--preview', '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  const previewed = JSON.parse(preview.stdout);
  assert.equal(previewed.data.plan.loopId, opened.loopId);
  assert.deepEqual(previewed.outcome.slots, {
    targetId: opened.loopId, targetKind: 'loop',
    planSha256: previewed.data.plan.planSha256
  });
  assert.equal(Object.hasOwn(previewed.outcome.slots, 'intervalId'), false);

  const planSha256 = previewed.data.plan.planSha256;
  const confirmation = spawnSync(process.execPath, [
    CLI, 'revision', 'abandon', opened.loopId,
    '--plan', planSha256, '--confirm', planSha256, '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(confirmation.status, 0, confirmation.stderr);
  const abandoned = JSON.parse(confirmation.stdout);
  assert.deepEqual(abandoned.outcome.slots, {
    targetId: opened.loopId, targetKind: 'loop', loopId: opened.loopId
  });
  assert.equal(Object.hasOwn(abandoned.outcome.slots, 'intervalId'), false);
  assert.equal(abandoned.data.result.state.status, 'abandoned');
  assert.equal(abandoned.data.result.state.loopId, opened.loopId);
  assert.equal((await store.read()).status, 'abandoned');
});

test('an exact retry repairs a confirmation receipt lost after the pointer mutation', async (t) => {
  const id = 'REV-CONFIRMATION-RECOVERY-1';
  const { root } = await interactiveRevisionRepository(t, id);
  const options = {
    feedbackText: `Fix ${id}:AC-001 because the implementation misses the required value.`,
    criteria: [], disposition: null, attachmentSetSha256: null,
    savedBuffersConfirmed: true
  };
  const plan = await previewInteractiveRevision(root, options);
  const started = await confirmInteractiveRevision(root, {
    plan, confirmation: plan.planSha256, ...options
  });
  const commonDir = path.resolve(root, spawnSync('git', [
    'rev-parse', '--git-common-dir'
  ], { cwd: root, encoding: 'utf8' }).stdout.trim());
  const privateRoot = path.join(commonDir, 'singularity-flow', 'revisions');
  const receiptName = `${plan.planSha256.slice(7)}.json`;
  const relativeReceipt = (await readdir(privateRoot, { recursive: true }))
    .find((entry) => path.basename(entry) === receiptName
      && entry.split(path.sep).includes('confirmation-results'));
  assert.ok(relativeReceipt, 'successful confirmation retained its immutable result receipt');
  await rm(path.join(privateRoot, relativeReceipt));

  const active = await loadActiveRevisionStory(root);
  const pointerBefore = await readRevisionInteractiveState(root, active.subject);
  const journalBefore = await revisionLoopStore(active).list();
  const replay = await replayInteractiveRevisionConfirmation(root, {
    confirmation: plan.planSha256, ...options
  });

  assert.equal(replay.replayed, true);
  assert.equal(replay.recoveredConfirmationResult, true);
  assert.deepEqual(replay.state, started.state);
  assert.deepEqual(await readRevisionInteractiveState(root, active.subject), pointerBefore);
  assert.deepEqual(await revisionLoopStore(active).list(), journalBefore);
  assert.equal((await readdir(privateRoot, { recursive: true }))
    .filter((entry) => path.basename(entry) === receiptName
      && entry.split(path.sep).includes('confirmation-results')).length, 1);
});

test('capture retains a missing start result before a later interval replaces its pointer', async (t) => {
  const id = 'REV-CONFIRMATION-PRECAPTURE-1';
  const { root } = await interactiveRevisionRepository(t, id);
  const firstOptions = {
    feedbackText: `Fix ${id}:AC-001 because the implementation misses the required value.`,
    criteria: [], disposition: null, attachmentSetSha256: null,
    savedBuffersConfirmed: true
  };
  const firstPlan = await previewInteractiveRevision(root, firstOptions);
  const firstStarted = await confirmInteractiveRevision(root, {
    plan: firstPlan, confirmation: firstPlan.planSha256, ...firstOptions
  });

  // Model a process death after the awaiting-edit pointer became durable but before either
  // independently addressed confirmation-result copy was retained.
  const commonDir = path.resolve(root, spawnSync('git', [
    'rev-parse', '--git-common-dir'
  ], { cwd: root, encoding: 'utf8' }).stdout.trim());
  const privateRoot = path.join(commonDir, 'singularity-flow', 'revisions');
  const receiptName = `${firstPlan.planSha256.slice(7)}.json`;
  const receipts = (await readdir(privateRoot, { recursive: true }))
    .filter((entry) => path.basename(entry) === receiptName
      && ['confirmation-results', 'confirmation-recovery']
        .some((family) => entry.split(path.sep).includes(family)));
  assert.equal(receipts.length, 2);
  await Promise.all(receipts.map((entry) => rm(path.join(privateRoot, entry))));

  await writeFile(path.join(root, 'src/app.js'), 'export const value = 2;\n');
  const captureOptions = {
    note: `Implement the exact ${id}:AC-001 correction`, savedBuffersConfirmed: true
  };
  const capturePlan = await previewInteractiveCapture(root, captureOptions);
  await confirmInteractiveCapture(root, {
    plan: capturePlan, confirmation: capturePlan.planSha256, ...captureOptions
  });
  const repairedReceipts = (await readdir(privateRoot, { recursive: true }))
    .filter((entry) => path.basename(entry) === receiptName
      && ['confirmation-results', 'confirmation-recovery']
        .some((family) => entry.split(path.sep).includes(family)));
  assert.equal(repairedReceipts.length, 2,
    'capture repairs both exact start receipts before advancing the pointer');

  const secondOptions = {
    feedbackText: `Fix ${id}:AC-001 while retaining the corrected value.`,
    criteria: [], disposition: null, attachmentSetSha256: null,
    savedBuffersConfirmed: true
  };
  const secondPlan = await previewInteractiveRevision(root, secondOptions);
  await confirmInteractiveRevision(root, {
    plan: secondPlan, confirmation: secondPlan.planSha256, ...secondOptions
  });
  const replay = await replayInteractiveRevisionConfirmation(root, {
    confirmation: firstPlan.planSha256, ...firstOptions
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.state, firstStarted.state,
    'the old exact result survives after a later interval replaces the mutable pointer');
});

test('an exact old start confirmation replays its original result after a later interval replaces the current pointer', async (t) => {
  const id = 'REV-HISTORICAL-REPLAY-1';
  const { root } = await interactiveRevisionRepository(t, id);
  const first = await completeInteractiveRevision(root, id);
  assert.equal(first.completed.state.loopRevision, 1);

  const secondOptions = {
    feedbackText: `Fix ${id}:AC-001 by keeping the shared implementation path.`,
    criteria: [], disposition: null, attachmentSetSha256: null,
    savedBuffersConfirmed: true
  };
  const secondPlan = await previewInteractiveRevision(root, secondOptions);
  const second = await confirmInteractiveRevision(root, {
    plan: secondPlan, confirmation: secondPlan.planSha256, ...secondOptions
  });
  assert.equal(second.state.status, 'awaiting-edit');
  assert.equal(second.state.loopRevision, 1);
  assert.notEqual(second.state.startPlanSha256, first.startPlan.planSha256);

  const active = await loadActiveRevisionStory(root);
  const pointerBefore = await readRevisionInteractiveState(root, active.subject);
  const journalBefore = await revisionLoopStore(active).list();
  const sourceBefore = await readFile(path.join(root, 'src/app.js'), 'utf8');
  const commonDir = path.resolve(root, spawnSync('git', [
    'rev-parse', '--git-common-dir'
  ], { cwd: root, encoding: 'utf8' }).stdout.trim());
  const primaryName = `${first.startPlan.planSha256.slice(7)}.json`;
  const primary = (await readdir(path.join(commonDir, 'singularity-flow', 'revisions'), {
    recursive: true
  })).find((entry) => path.basename(entry) === primaryName
    && entry.split(path.sep).includes('confirmation-results'));
  assert.ok(primary, 'the first interval has a primary confirmation result');
  await rm(path.join(commonDir, 'singularity-flow', 'revisions', primary));

  const replay = await replayInteractiveRevisionConfirmation(root, {
    confirmation: first.startPlan.planSha256, ...first.startOptions
  });

  assert.equal(replay.replayed, true);
  assert.equal(replay.recoveredConfirmationResult, true,
    'historical replay repairs its primary from the immutable recovery copy');
  assert.equal(replay.plan.planSha256, first.startPlan.planSha256);
  assert.deepEqual(replay.state, first.started.state);
  assert.equal(replay.packet.packetSha256, first.started.packet.packetSha256);
  assert.deepEqual(replay.records, first.started.records);
  assert.equal(replay.next, first.started.next);
  assert.deepEqual(await readRevisionInteractiveState(root, active.subject), pointerBefore,
    'historical replay must not replace the current interval pointer');
  assert.deepEqual(await revisionLoopStore(active).list(), journalBefore,
    'historical replay must not append or rewrite the loop journal');
  assert.equal(await readFile(path.join(root, 'src/app.js'), 'utf8'), sourceBefore,
    'historical replay must not change application bytes');

  await assert.rejects(replayInteractiveRevisionConfirmation(root, {
    confirmation: first.startPlan.planSha256,
    ...first.startOptions,
    feedbackText: `${first.startOptions.feedbackText} changed`
  }), { code: 'REV_PLAN_STALE' });
  assert.deepEqual(await readRevisionInteractiveState(root, active.subject), pointerBefore,
    'mismatched historical reuse must not change the current pointer');
  assert.deepEqual(await revisionLoopStore(active).list(), journalBefore,
    'mismatched historical reuse must not change the loop journal');
});

test('resume preserves an exact retained Candidate but refuses head advancement after worktree drift', async (t) => {
  const id = 'REV-CAPTURE-RECOVERY-1';
  const { root } = await interactiveRevisionRepository(t, id);
  const startOptions = {
    feedbackText: `Fix ${id}:AC-001 because the implementation misses the required value.`,
    criteria: [], disposition: null, attachmentSetSha256: null,
    savedBuffersConfirmed: true
  };
  const startPlan = await previewInteractiveRevision(root, startOptions);
  const started = await confirmInteractiveRevision(root, {
    plan: startPlan, confirmation: startPlan.planSha256, ...startOptions
  });
  assert.equal(started.state.status, 'awaiting-edit');

  const applicationPath = path.join(root, 'src/app.js');
  await writeFile(applicationPath, 'export const value = 2;\n');
  const captureOptions = {
    note: `Implement the exact ${id}:AC-001 correction`, savedBuffersConfirmed: true
  };
  const capturePlan = await previewInteractiveCapture(root, captureOptions);
  const active = await loadActiveRevisionStory(root);
  const state = await readRevisionInteractiveState(root, active.subject);
  const loop = await revisionLoopStore(active).read();
  const parentCandidate = await sgosRevisionCandidateReference(root, loop.head.candidateId);
  const observed = await readRevisionContext(active);
  const verifySavedEditorBuffers = async ({ changedPaths }) => ({
    status: 'all-saved',
    snapshotSha256: hash({ source: 'explicit-cli-assertion', changedPaths }),
    assurance: 'user-asserted'
  });
  const manual = await previewManualRevision({
    root, subjectId: `${active.subject.workId}:${active.subject.phaseId}`,
    parentCandidate, allowedPaths: capturePlan.allowedPaths,
    note: captureOptions.note,
    ignoredPaths: observed.saved.transactionOwnedPaths,
    stagedDisposition: null, untrackedDisposition: null,
    config: active.config, workflow: active.workflow, verifySavedEditorBuffers
  });
  assert.equal(manual.planSha256, capturePlan.manualPlanSha256);
  assert.equal(manual.status, 'ready-for-explicit-freeze');

  const capturePayload = {
    schemaVersion: 1, kind: 'revision-interactive-capture-authority',
    plan: capturePlan, note: captureOptions.note, manual,
    parentCandidateId: parentCandidate.candidateId,
    editorDiskIndexBaselineSha256: observed.context.editorDiskIndexBaselineSha256
  };
  const capturePayloadSha256 = await writeRevisionInteractivePayload(
    root, active.subject, capturePayload
  );
  const captureStartedAt = '2026-09-20T01:00:00.000Z';
  const capturing = await writeRevisionInteractiveState(root, {
    ...state, status: 'capturing', capturePlanSha256: capturePlan.planSha256,
    capturePayloadSha256, captureEffectSetSha256: null, recoveryCode: null,
    captureStartedAt, captureEndedAt: null, updatedAt: captureStartedAt
  }, { expectedStateSha256: state.stateSha256 });
  assert.equal(capturing.status, 'capturing');

  const retained = await freezeSgosCandidate(root, {
    subjectId: `${active.subject.workId}:${active.subject.phaseId}`,
    createdBy: { kind: 'human', id: 'revision@example.com' },
    createdAt: captureStartedAt,
    expectedBaseline: parentCandidate.repository.baselineCommit,
    baselineCommit: parentCandidate.repository.baselineCommit,
    paths: manual.allowedPaths
  });
  const retainedReference = await sgosRevisionCandidateReference(
    root, retained.candidate.candidateId
  );

  const laterWorkspaceBytes = 'export const value = 999;\n';
  await writeFile(applicationPath, laterWorkspaceBytes);
  await assert.rejects(resumeInteractiveRevision(root), {
    code: 'REV_CAPTURE_WORKTREE_DRIFT'
  });
  const preserved = await readRevisionInteractiveState(root, active.subject);
  assert.equal(preserved.status, 'candidate-frozen');
  assert.equal(preserved.loopRevision, 0);
  assert.equal(preserved.resultCandidateId, retainedReference.candidateId);
  assert.equal((await revisionLoopStore(active).read()).revision, 0,
    'worktree drift must not advance the local loop head');
  assert.equal(await readFile(applicationPath, 'utf8'), laterWorkspaceBytes,
    'resume must not materialize or recapture later workspace bytes');
});

test('capture recovery never adopts the same paths with different saved bytes', async (t) => {
  const id = 'REV-CAPTURE-BYTES-1';
  const { root } = await interactiveRevisionRepository(t, id);
  const startOptions = {
    feedbackText: `Fix ${id}:AC-001 because the implementation misses the required value.`,
    criteria: [], disposition: null, attachmentSetSha256: null,
    savedBuffersConfirmed: true
  };
  const startPlan = await previewInteractiveRevision(root, startOptions);
  await confirmInteractiveRevision(root, {
    plan: startPlan, confirmation: startPlan.planSha256, ...startOptions
  });

  const applicationPath = path.join(root, 'src/app.js');
  await writeFile(applicationPath, 'export const value = 2;\n');
  const captureOptions = {
    note: `Implement the exact ${id}:AC-001 correction`, savedBuffersConfirmed: true
  };
  const capturePlan = await previewInteractiveCapture(root, captureOptions);
  const active = await loadActiveRevisionStory(root);
  const state = await readRevisionInteractiveState(root, active.subject);
  const loop = await revisionLoopStore(active).read();
  const parentCandidate = await sgosRevisionCandidateReference(root, loop.head.candidateId);
  const observed = await readRevisionContext(active);
  const manual = await previewManualRevision({
    root, subjectId: `${active.subject.workId}:${active.subject.phaseId}`,
    parentCandidate, allowedPaths: capturePlan.allowedPaths,
    note: captureOptions.note,
    ignoredPaths: observed.saved.transactionOwnedPaths,
    stagedDisposition: null, untrackedDisposition: null,
    config: active.config, workflow: active.workflow,
    verifySavedEditorBuffers: async ({ changedPaths }) => ({
      status: 'all-saved',
      snapshotSha256: hash({ source: 'explicit-cli-assertion', changedPaths }),
      assurance: 'user-asserted'
    })
  });
  assert.equal(manual.planSha256, capturePlan.manualPlanSha256);
  const capturePayloadSha256 = await writeRevisionInteractivePayload(root, active.subject, {
    schemaVersion: 1, kind: 'revision-interactive-capture-authority',
    plan: capturePlan, note: captureOptions.note, manual,
    parentCandidateId: parentCandidate.candidateId,
    editorDiskIndexBaselineSha256: observed.context.editorDiskIndexBaselineSha256
  });
  const captureStartedAt = '2026-09-20T01:30:00.000Z';
  await writeRevisionInteractiveState(root, {
    ...state, status: 'capturing', capturePlanSha256: capturePlan.planSha256,
    capturePayloadSha256, captureEffectSetSha256: null, recoveryCode: null,
    captureStartedAt, captureEndedAt: null, updatedAt: captureStartedAt
  }, { expectedStateSha256: state.stateSha256 });

  // Simulate a crash after another process retained the same path set from different bytes.
  await writeFile(applicationPath, 'export const value = 3;\n');
  await freezeSgosCandidate(root, {
    subjectId: `${active.subject.workId}:${active.subject.phaseId}`,
    createdBy: { kind: 'human', id: 'revision@example.com' },
    createdAt: captureStartedAt,
    expectedBaseline: parentCandidate.repository.baselineCommit,
    baselineCommit: parentCandidate.repository.baselineCommit,
    paths: manual.allowedPaths
  });

  const resumed = await resumeInteractiveRevision(root);
  assert.equal(resumed.recovered, false);
  assert.equal(resumed.recovery.kind, 'capture-outcome-uncertain');
  assert.equal(resumed.state.status, 'recovery-required');
  assert.equal(resumed.state.recoveryCode, 'REV_CAPTURE_OUTCOME_UNCERTAIN');
  assert.equal((await revisionLoopStore(active).read()).revision, 0);
});

test('interval-two public preview binds an attachment to the current retained loop head', async (t) => {
  const id = 'REV-PUBLIC-2';
  const { root } = await interactiveRevisionRepository(t, id);
  const first = await completeInteractiveRevision(root, id);
  assert.equal(first.completed.state.loopRevision, 1);

  const active = await loadActiveRevisionStory(root);
  const observed = await readRevisionContext(active);
  const feedbackText = `Fix ${id}:AC-001 using the exact attached review evidence.`;
  const attachmentSentinel = 'REV_ATTACHMENT_PRIVATE_SENTINEL_7F3A9C';
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-interval-two-note-'));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const source = path.join(sourceRoot, 'review.md');
  await writeFile(source, `# Review\n${attachmentSentinel}\n`);
  const context = {
    repositoryRoot: root,
    workId: active.subject.workId,
    phaseId: active.subject.phaseId,
    phaseGeneration: active.subject.phaseGeneration,
    loopId: first.completed.state.loopId,
    loopRevision: first.completed.state.loopRevision,
    active: true,
    feedbackText,
    headCommit: observed.context.headCommit,
    sourceTreeSha256: observed.context.sourceTreeSha256,
    configSha256: observed.context.configSha256,
    workflowSha256: observed.context.workflowSha256
  };
  const store = createFeedbackAttachmentStore(root, {
    workId: active.subject.workId,
    phaseId: active.subject.phaseId,
    phaseGeneration: active.subject.phaseGeneration,
    assertCurrentContext: async () => true
  });
  const sources = [{ source: 'local-file', path: source }];
  const authorizeRead = async () => true;
  const proposed = await previewFeedbackAttachments({
    context, sources, selection: [0], authorizeRead
  });
  await store.savePlan(proposed.plan);
  const receipt = await registerFeedbackAttachments({
    plan: proposed.plan, context, sources, selection: [0],
    confirm: proposed.plan.planSha256, idempotencyKey: proposed.plan.planSha256,
    authorizeRead, assertCurrentContext: async () => true, store
  });

  const startOptions = {
    feedbackText, criteria: [`${id}:AC-001`], disposition: null,
    attachmentSetSha256: receipt.attachmentSetSha256,
    savedBuffersConfirmed: true
  };
  const plan = await previewInteractiveRevision(root, startOptions);
  assert.equal(plan.expectedLoopRevision, 1);
  assert.equal(plan.expectedHeadCandidateId, first.completed.resultCandidate.candidateId);
  assert.equal(plan.attachmentSetSha256, receipt.attachmentSetSha256);
  assert.equal(plan.disposition.result, 'implementation-change');

  const started = await confirmInteractiveRevision(root, {
    plan, confirmation: plan.planSha256, ...startOptions
  });
  assert.equal(started.packet.feedback.attachmentSetSha256, receipt.attachmentSetSha256);
  assert.match(started.packet.attachments[0].text, new RegExp(attachmentSentinel, 'u'));
  await writeFile(path.join(root, 'src/app.js'), 'export const value = 3;\n');
  const captureOptions = {
    note: `Implement the second ${id}:AC-001 correction`, savedBuffersConfirmed: true
  };
  const capturePlan = await previewInteractiveCapture(root, captureOptions);
  await confirmInteractiveCapture(root, {
    plan: capturePlan, confirmation: capturePlan.planSha256, ...captureOptions
  });

  const journal = await revisionLoopStore(await loadActiveRevisionStory(root)).list();
  const intervalId = journal.at(-1).transition.interval.intervalId;
  const shown = spawnSync(process.execPath, [CLI, 'revision', 'show', intervalId, '--json'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.doesNotMatch(shown.stdout, new RegExp(attachmentSentinel, 'u'));
  const projection = JSON.parse(shown.stdout);
  const publicAttachment = projection.data.recordChain.packet.attachments[0];
  assert.equal(Object.hasOwn(publicAttachment, 'text'), false);
  assert.equal(publicAttachment.renditionSha256, receipt.attachments[0].renditionSha256);
});

test('existing-loop preview rejects a saved application symlink before secret scanning', async (t) => {
  const id = 'REV-SYMLINK-1';
  const { root } = await interactiveRevisionRepository(t, id);
  const first = await completeInteractiveRevision(root, id);
  assert.equal(first.completed.state.status, 'prechecked');
  assert.equal(first.completed.state.loopRevision, 1);

  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-symlink-target-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'credential.js');
  await writeFile(target, `export const token = "ghp_${'a'.repeat(36)}";\n`);
  const applicationPath = path.join(root, 'src/app.js');
  await unlink(applicationPath);
  await symlink(target, applicationPath);

  await assert.rejects(previewInteractiveRevision(root, {
    feedbackText: `Fix ${id}:AC-001 without changing its accepted meaning.`,
    criteria: [], disposition: null, attachmentSetSha256: null,
    savedBuffersConfirmed: true
  }), (error) => {
    assert.equal(error.code, 'REV_SYMLINK_UNSUPPORTED');
    assert.doesNotMatch(error.message, /ghp_/u);
    return true;
  });
});

test('resume reconciles an opening pointer after the matching loop-open CAS already committed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-opening-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await writeFile(path.join(root, 'app.txt'), 'clean parent application\n');
  await initializeDefinition(root);
  git('add', '.');
  git('commit', '-m', 'repository setup');
  git('switch', '-c', 'REV-OPEN-1');
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const actor = { name: 'Revision Test', email: 'revision@example.com', login: null };
  const workflow = await createWorkflow(root, config, {
    id: 'REV-OPEN-1', title: 'Opening replay',
    source: {
      type: 'manual', key: 'REV-OPEN-1', title: 'Opening replay',
      description: 'Recover an exact committed loop opening.',
      acceptanceCriteria: ['The matching committed opening is replayable.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'product-owner',
    resolved: resolveWorkType(config, 'feature')
  });
  workflow.currentPhase = 'implementation';
  workflow.phases.implementation.status = 'in_progress';
  workflow.phases.implementation.generation = 1;
  await saveWorkflow(root, config, workflow);
  await setAgentSession(root, config, actor, 'product-owner', workflow.workItem.id, {
    phaseId: 'implementation', source: 'test'
  });
  const active = await loadActiveRevisionStory(root);
  const retained = await freezeSgosCandidate(root, {
    subjectId: `${active.subject.workId}:${active.subject.phaseId}`,
    createdBy: { kind: 'human', id: actor.email },
    createdAt: '2026-09-20T00:00:00.000Z'
  });
  const reference = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  const context = {
    repositorySha256: H('1'), headCommit: git('rev-parse', 'HEAD'),
    sourceTreeSha256: H('2'), configSha256: H('3'), workflowSha256: H('4'),
    approvedIntentSha256: H('5'), routeContractSha256: H('6'),
    proofProfileSha256: H('7'), editorDiskIndexBaselineSha256: H('8')
  };
  const loopId = 'REVLOOP-OPENING-REPLAY';
  const store = createRevisionLoopStore({
    root, ...active.subject, producer: producerIdentity(),
    assertCurrentContext: async () => true,
    verifyRetainedCandidate: async () => true
  });
  const opening = await previewRevisionLoopOpen({
    loopStore: store, context, initialCandidate: reference, loopId,
    idempotencyKey: 'opening-replay', verifyCandidateReference: async () => true
  });
  await confirmRevisionLoopOpen({
    loopStore: store, plan: opening, confirmation: opening.planSha256,
    readCurrentContext: async () => context, verifyCandidateReference: async () => true
  });
  const openingState = await writeRevisionInteractiveState(root, {
    subject: active.subject, status: 'opening', loopId, loopRevision: -1,
    startPlanSha256: H('9'), startPlanPayloadSha256: H('a'),
    contextSha256: hash(context), feedbackRecordSha256: H('b'),
    criteriaBindingSha256: H('c'), dispositionSha256: H('d'), packetSha256: H('e'),
    routePlanSha256: H('f'), parentCandidateId: reference.candidateId,
    resultCandidateId: null, startPinSha256: H('0'), precheckSha256: null,
    precheckInputSha256: null
  }, { expectedStateSha256: null });
  assert.equal(openingState.status, 'opening');

  const resumed = await resumeInteractiveRevision(root);
  assert.equal(resumed.recovered, true);
  assert.equal(resumed.recovery.kind, 'loop-opening');
  assert.equal(resumed.state.status, 'awaiting-edit');
  assert.equal(resumed.state.loopRevision, 0);
  assert.equal((await readRevisionInteractiveState(root, active.subject)).status, 'awaiting-edit');
});
