import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { buildRevisionPrecheck } from '../src/revision/contracts.mjs';
import { createRevisionLoopStore } from '../src/revision/loop-store.mjs';

const sha = (value) => `sha256:${recordSha256(value)}`;
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const producer = Object.freeze({
  id: 'revision-test', version: '1', implementationSha256: digest('f')
});
const requiredChecks = [
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
];
const candidate = (letter) => ({
  candidateId: `CAN-${letter.repeat(12)}`,
  candidateSha256: digest(letter), candidateRefSha256: digest(letter),
  candidateTree: letter.repeat(40)
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const scope = { workId: 'STORY-1', phaseId: 'implement', phaseGeneration: 1 };
  let context = {
    repositorySha256: digest('a'), headCommit: 'b'.repeat(40), sourceTreeSha256: digest('c'),
    configSha256: digest('d'), workflowSha256: digest('e'), approvedIntentSha256: digest('f'),
    routeContractSha256: digest('1'), proofProfileSha256: digest('2'),
    editorDiskIndexBaselineSha256: digest('3')
  };
  let current = true;
  let verifier = () => true;
  let precheckVerifier = () => true;
  const store = createRevisionLoopStore({
    root, ...scope, producer,
    assertCurrentContext: async (request) => current
      && JSON.stringify(request) === JSON.stringify({ scope, context }),
    verifyRetainedCandidate: async (item) => verifier(item),
    verifyCurrentPrecheck: async (receipt, binding) => precheckVerifier(receipt, binding)
  });
  const journal = path.join(root, '.git', 'singularity-flow', 'revisions', recordSha256(scope), 'journal');
  return { root, scope, get context() { return context; }, store, journal,
    setCurrent(value) { current = value; }, setContext(value) { context = value; },
    setVerifier(value) { verifier = value; },
    setPrecheckVerifier(value) { precheckVerifier = value; } };
}

function openRequest(value, idempotencyKey = 'open-1') {
  return {
    expectedRevision: -1, expectedHeadCandidateRefSha256: null,
    context: value.context, idempotencyKey,
    transition: { type: 'open-loop', loopId: 'LOOP-1', initialCandidate: candidate('a') }
  };
}

function legacyEntry(value, request, {
  revision = request.expectedRevision + 1, previousEntrySha256 = null,
  committedAt = '2026-09-16T00:00:00.000Z'
} = {}) {
  const requestSha256 = sha({
    scope: value.scope,
    expectedRevision: request.expectedRevision,
    expectedHeadCandidateRefSha256: request.expectedHeadCandidateRefSha256,
    context: request.context,
    idempotencyKey: request.idempotencyKey,
    transition: request.transition
  });
  const core = {
    schemaVersion: 1, kind: 'revision-loop-journal-entry', scope: value.scope, revision,
    expectedRevision: request.expectedRevision,
    expectedHeadCandidateRefSha256: request.expectedHeadCandidateRefSha256,
    previousEntrySha256,
    idempotencyKeySha256: `sha256:${createHash('sha256').update(request.idempotencyKey).digest('hex')}`,
    requestSha256, context: request.context, transition: request.transition, committedAt
  };
  return { ...core, entrySha256: sha(core) };
}

function commitRequest(value, head, idempotencyKey = 'interval-1') {
  if (value.context.editorDiskIndexBaselineSha256 === head.context.editorDiskIndexBaselineSha256) {
    value.setContext({ ...value.context, editorDiskIndexBaselineSha256: digest('4') });
  }
  const result = candidate('b');
  const transitionCore = {
    schemaVersion: 1, kind: 'revision-head-transition',
    expectedLoopRevision: head.revision, expectedHeadTransitionSha256: head.headTransitionSha256,
    fromCandidateRefSha256: head.head.candidateRefSha256,
    toCandidateRefSha256: result.candidateRefSha256,
    worktreeIndexEditorPreimageSha256: head.context.editorDiskIndexBaselineSha256,
    materializedPostimageSha256: value.context.editorDiskIndexBaselineSha256,
    reason: 'admitted-result', producer
  };
  const headTransition = { ...transitionCore, transitionSha256: sha(transitionCore) };
  const snapshotCore = {
    candidateId: result.candidateId, candidateSha256: result.candidateSha256,
    candidateRefSha256: result.candidateRefSha256, candidateTree: result.candidateTree,
    phaseGeneration: value.scope.phaseGeneration, headRevision: head.revision + 1,
    headTransitionSha256: headTransition.transitionSha256,
    workflowSha256: value.context.workflowSha256, configSha256: value.context.configSha256,
    proofProfileSha256: value.context.proofProfileSha256,
    editorDiskIndexBaselineSha256: value.context.editorDiskIndexBaselineSha256
  };
  const headSnapshot = { ...snapshotCore, headSnapshotSha256: sha(snapshotCore) };
  const precheck = buildRevisionPrecheck({
    subject: value.scope,
    candidateId: result.candidateId, candidateSha256: result.candidateSha256,
    candidateRefSha256: result.candidateRefSha256, candidateTree: result.candidateTree,
    phaseGeneration: value.scope.phaseGeneration, headRevision: head.revision + 1,
    headTransitionSha256: headTransition.transitionSha256,
    headSnapshotSha256: headSnapshot.headSnapshotSha256,
    workflowSha256: value.context.workflowSha256, configSha256: value.context.configSha256,
    proofProfile: 'standard', proofProfileSha256: value.context.proofProfileSha256,
    editorDiskIndexBaselineSha256: value.context.editorDiskIndexBaselineSha256,
    criteriaBindingSha256: digest('6'), specificationDispositionSha256: digest('a'),
    hunkClaimSetSha256: digest('7'), precheckInputsSha256: digest('5'),
    criteria: [], owed: [], unexplainedHunks: [],
    refusalSummary: { count: 0, corrected: 0, unresolved: 0 },
    deterministicChecks: Object.fromEntries(requiredChecks.map((name) => [name, {
      status: 'pass', evidenceSha256: sha(name)
    }])),
    remainingObligations: [], precheckPassed: true, publicationEligible: true,
    producer
  });
  const intervalCore = {
    schemaVersion: 1, kind: 'revision-interval', intervalId: 'REV-STORY-1-IMPLEMENT-001',
    sequence: head.intervalSequence + 1, subject: value.scope,
    trigger: {
      kind: 'developer-feedback', feedbackId: 'REVFB-ABCDEF123456',
      author: { kind: 'configured-local', id: 'developer', name: 'Developer' },
      feedbackSha256: digest('8'), feedbackRecordSha256: digest('9'),
      criteriaBindingSha256: digest('6'), specificationDispositionSha256: digest('a'),
      startPinSha256: digest('b'), noteSha256: digest('c')
    },
    parentCandidate: {
      candidateId: head.head.candidateId, candidateSha256: head.head.candidateSha256,
      candidateRefSha256: head.head.candidateRefSha256, candidateTree: head.head.candidateTree
    },
    resultCandidate: result, packetSha256: digest('d'),
    criteriaBindingSha256: digest('6'), specificationDispositionSha256: digest('a'),
    executionAttempts: [digest('e')], hunkClaimSetSha256: digest('7'),
    startedAt: '2026-09-17T00:00:00.000Z', endedAt: '2026-09-17T00:00:00.000Z',
    producer,
    precheckSha256: precheck.precheckSha256, status: 'prechecked'
  };
  const interval = { ...intervalCore, intervalSha256: sha(intervalCore) };
  return {
    expectedRevision: head.revision,
    expectedHeadCandidateRefSha256: head.head.candidateRefSha256,
    context: value.context, idempotencyKey,
    transition: {
      type: 'commit-interval', loopId: head.loopId,
      interval, headTransition, headSnapshot, precheck
    }
  };
}

function legacyCommitRequest(value, head, idempotencyKey = 'legacy-interval-1') {
  if (value.context.editorDiskIndexBaselineSha256 === head.context.editorDiskIndexBaselineSha256) {
    value.setContext({ ...value.context, editorDiskIndexBaselineSha256: digest('4') });
  }
  const result = candidate('b');
  const transitionCore = {
    schemaVersion: 1, kind: 'revision-head-transition',
    expectedLoopRevision: head.revision, expectedHeadTransitionSha256: head.headTransitionSha256,
    fromCandidateRefSha256: head.head.candidateRefSha256,
    toCandidateRefSha256: result.candidateRefSha256,
    worktreeIndexEditorPreimageSha256: head.context.editorDiskIndexBaselineSha256,
    materializedPostimageSha256: value.context.editorDiskIndexBaselineSha256,
    reason: 'admitted-result'
  };
  const headTransition = { ...transitionCore, transitionSha256: sha(transitionCore) };
  const snapshotCore = {
    ...result, phaseGeneration: value.scope.phaseGeneration, headRevision: head.revision + 1,
    headTransitionSha256: headTransition.transitionSha256,
    workflowSha256: value.context.workflowSha256, configSha256: value.context.configSha256,
    proofProfileSha256: value.context.proofProfileSha256,
    editorDiskIndexBaselineSha256: value.context.editorDiskIndexBaselineSha256
  };
  const headSnapshot = { ...snapshotCore, headSnapshotSha256: sha(snapshotCore) };
  const precheckCore = {
    schemaVersion: 1, kind: 'revision-precheck',
    ...result, phaseGeneration: value.scope.phaseGeneration, headRevision: head.revision + 1,
    headTransitionSha256: headTransition.transitionSha256,
    headSnapshotSha256: headSnapshot.headSnapshotSha256,
    workflowSha256: value.context.workflowSha256, configSha256: value.context.configSha256,
    workflowConfigurationSha256: digest('5'), proofProfileSha256: value.context.proofProfileSha256,
    editorDiskIndexBaselineSha256: value.context.editorDiskIndexBaselineSha256,
    criteriaBindingSha256: digest('6'), hunkClaimSetSha256: digest('7'),
    criteria: [], owed: [], unexplainedHunks: [],
    refusalSummary: { count: 0, corrected: 0, unresolved: 0 }, publicationEligible: true
  };
  const precheck = { ...precheckCore, precheckSha256: sha(precheckCore) };
  const intervalCore = {
    schemaVersion: 1, kind: 'revision-interval', intervalId: 'REV-STORY-1-IMPLEMENT-LEGACY',
    sequence: head.intervalSequence + 1, subject: value.scope,
    trigger: { kind: 'developer-feedback', feedbackSha256: digest('8') },
    parentCandidate: {
      candidateId: head.head.candidateId, candidateSha256: head.head.candidateSha256,
      candidateRefSha256: head.head.candidateRefSha256
    },
    resultCandidate: result, packetSha256: digest('9'),
    precheckSha256: precheck.precheckSha256, status: 'prechecked'
  };
  const interval = { ...intervalCore, intervalSha256: sha(intervalCore) };
  return {
    expectedRevision: head.revision,
    expectedHeadCandidateRefSha256: head.head.candidateRefSha256,
    context: value.context, idempotencyKey,
    transition: {
      type: 'commit-interval', loopId: head.loopId,
      interval, headTransition, headSnapshot, precheck
    }
  };
}

function selectRequest(value, head, idempotencyKey = 'restore-1') {
  if (value.context.editorDiskIndexBaselineSha256 === head.context.editorDiskIndexBaselineSha256) {
    value.setContext({ ...value.context, editorDiskIndexBaselineSha256: digest('5') });
  }
  const selectedCandidate = candidate('a');
  const transitionCore = {
    schemaVersion: 1, kind: 'revision-head-transition',
    expectedLoopRevision: head.revision, expectedHeadTransitionSha256: head.headTransitionSha256,
    fromCandidateRefSha256: head.head.candidateRefSha256,
    toCandidateRefSha256: selectedCandidate.candidateRefSha256,
    worktreeIndexEditorPreimageSha256: head.context.editorDiskIndexBaselineSha256,
    materializedPostimageSha256: value.context.editorDiskIndexBaselineSha256,
    reason: 'restore', producer
  };
  const headTransition = { ...transitionCore, transitionSha256: sha(transitionCore) };
  const snapshotCore = {
    ...selectedCandidate, phaseGeneration: value.scope.phaseGeneration,
    headRevision: head.revision + 1, headTransitionSha256: headTransition.transitionSha256,
    workflowSha256: value.context.workflowSha256, configSha256: value.context.configSha256,
    proofProfileSha256: value.context.proofProfileSha256,
    editorDiskIndexBaselineSha256: value.context.editorDiskIndexBaselineSha256
  };
  const headSnapshot = { ...snapshotCore, headSnapshotSha256: sha(snapshotCore) };
  return {
    expectedRevision: head.revision,
    expectedHeadCandidateRefSha256: head.head.candidateRefSha256,
    context: value.context, idempotencyKey,
    transition: { type: 'select-head', loopId: head.loopId,
      selectedCandidate, headTransition, headSnapshot }
  };
}

test('local loop head is an append-only hash chain with exact bundled precheck', async (t) => {
  const value = await fixture(t);
  assert.equal(await value.store.read(), null);
  const opened = await value.store.append(openRequest(value));
  assert.equal(opened.revision, 0);
  const head = await value.store.read();
  assert.equal(head.head.candidateId, candidate('a').candidateId);
  const committed = await value.store.append(commitRequest(value, head));
  assert.equal(committed.revision, 1);
  assert.equal(committed.previousEntrySha256, opened.entrySha256);
  assert.equal(committed.transition.interval.precheckSha256, committed.transition.precheck.precheckSha256);
  assert.equal(committed.transition.precheck.headSnapshotSha256,
    committed.transition.headSnapshot.headSnapshotSha256);
  const selected = await value.store.read();
  assert.equal(selected.head.candidateRefSha256, candidate('b').candidateRefSha256);
  assert.equal(selected.headTransitionSha256, committed.transition.headTransition.transitionSha256);
  assert.equal(selected.precheckSha256, committed.transition.precheck.precheckSha256);
  assert.equal(selected.headSnapshotSha256, committed.transition.headSnapshot.headSnapshotSha256);
  assert.equal(selected.headIntervalId, 'REV-STORY-1-IMPLEMENT-001');
  assert.equal((await value.store.list()).length, 2);
  const files = (await readdir(value.journal)).sort();
  assert.deepEqual(files, ['0000000000.json', '0000000001.json']);
  assert.equal(JSON.parse(await readFile(path.join(value.journal, files[1]), 'utf8')).entrySha256,
    committed.entrySha256);
});

test('idempotent replay is stable; stale CAS and reused key cannot change the head', async (t) => {
  const value = await fixture(t);
  const open = openRequest(value);
  const first = await value.store.append(open);
  assert.deepEqual(await value.store.append(open), first);
  await assert.rejects(value.store.append({ ...open, transition: {
    ...open.transition, loopId: 'LOOP-2'
  } }), { code: 'REV_LOOP_IDEMPOTENCY_CONFLICT' });
  const head = await value.store.read();
  const request = commitRequest(value, head);
  const one = await value.store.append(request);
  assert.deepEqual(await value.store.append(request), one);
  value.setCurrent(false);
  assert.deepEqual(await value.store.append(request), one,
    'an exact committed request remains replayable after live context drift');
  value.setCurrent(true);
  await assert.rejects(value.store.append(commitRequest(value, head, 'loser')),
    { code: 'REV_LOOP_ADVANCED' });
  assert.equal((await value.store.list()).length, 2);
});

test('producerless v1 journals remain readable and replayable but cannot grant new authority', async (t) => {
  const value = await fixture(t);
  const request = openRequest(value);
  const historical = legacyEntry(value, request);
  await mkdir(value.journal, { recursive: true, mode: 0o700 });
  await writeFile(path.join(value.journal, '0000000000.json'), canonicalJson(historical), {
    mode: 0o600
  });

  const head = await value.store.read();
  assert.equal(head.revision, 0);
  assert.equal(head.head.candidateRefSha256, candidate('a').candidateRefSha256);
  assert.deepEqual(await value.store.list(), [historical]);
  value.setCurrent(false);
  assert.deepEqual(await value.store.append(request), historical,
    'an exact historical request stays replayable without consulting new authority');

  value.setCurrent(true);
  const commitRequest = legacyCommitRequest(value, head);
  const historicalCommit = legacyEntry(value, commitRequest, {
    previousEntrySha256: historical.entrySha256,
    committedAt: '2026-09-16T00:01:00.000Z'
  });
  await writeFile(path.join(value.journal, '0000000001.json'), canonicalJson(historicalCommit), {
    mode: 0o600
  });
  const committedHead = await value.store.read();
  assert.equal(committedHead.revision, 1);
  assert.equal(committedHead.head.candidateRefSha256, candidate('b').candidateRefSha256);
  assert.equal(committedHead.precheckSha256,
    historicalCommit.transition.precheck.precheckSha256);
  value.setCurrent(false);
  assert.deepEqual(await value.store.append(commitRequest), historicalCommit,
    'a historical commit with the original v1 nested records remains exactly replayable');

  value.setCurrent(true);
  await assert.rejects(value.store.append({
    expectedRevision: committedHead.revision,
    expectedHeadCandidateRefSha256: committedHead.head.candidateRefSha256,
    context: value.context,
    idempotencyKey: 'legacy-new-authority',
    transition: { type: 'abandon-loop', loopId: committedHead.loopId }
  }), { code: 'REV_LOOP_PRODUCER_UNSUPPORTED' });
  assert.deepEqual((await readdir(value.journal)).sort(),
    ['0000000000.json', '0000000001.json']);
});

test('a kernel upgrade reads self-bound historical entries and appends only as the installed producer', async (t) => {
  const value = await fixture(t);
  await value.store.append(openRequest(value));
  const upgradedProducer = { ...producer, implementationSha256: digest('e') };
  const upgraded = createRevisionLoopStore({
    root: value.root, ...value.scope, producer: upgradedProducer,
    assertCurrentContext: async ({ scope, context }) =>
      JSON.stringify({ scope, context }) === JSON.stringify({ scope: value.scope, context: value.context }),
    verifyRetainedCandidate: async () => true,
    verifyCurrentPrecheck: async () => true
  });
  assert.equal((await upgraded.read()).revision, 0);
  await upgraded.append({
    expectedRevision: 0,
    expectedHeadCandidateRefSha256: candidate('a').candidateRefSha256,
    context: value.context, idempotencyKey: 'abandon-after-upgrade',
    transition: { type: 'abandon-loop', loopId: 'LOOP-1' }
  });
  const journal = await upgraded.list();
  assert.deepEqual(journal.map((entry) => entry.producer.implementationSha256),
    [producer.implementationSha256, upgradedProducer.implementationSha256]);
  assert.equal((await upgraded.read()).status, 'abandoned');
});

test('a future producer journal is preserved but blocked by an older reader', async (t) => {
  const value = await fixture(t);
  const futureProducer = { ...producer, version: '2', implementationSha256: digest('e') };
  const future = createRevisionLoopStore({
    root: value.root, ...value.scope, producer: futureProducer,
    assertCurrentContext: async () => true,
    verifyRetainedCandidate: async () => true
  });
  await future.append(openRequest(value));
  await assert.rejects(value.store.read(), { code: 'REV_LOOP_PRODUCER_UNSUPPORTED' });
  assert.deepEqual((await readdir(value.journal)).sort(), ['0000000000.json']);
});

test('head cannot advance without the exact proposed snapshot and self-hashed precheck', async (t) => {
  const value = await fixture(t);
  await value.store.append(openRequest(value));
  const head = await value.store.read();
  const valid = commitRequest(value, head);
  for (const altered of [
    { ...valid.transition, precheck: null },
    { ...valid.transition, precheck: { ...valid.transition.precheck, headRevision: 99 } },
    { ...valid.transition, headSnapshot: { ...valid.transition.headSnapshot, candidateTree: 'f'.repeat(40) } },
    { ...valid.transition, interval: { ...valid.transition.interval, precheckSha256: digest('0') } }
  ]) {
    await assert.rejects(value.store.append({ ...valid, transition: altered }),
      { code: 'REV_LOOP_INVALID' });
  }
  assert.equal((await value.store.read()).revision, 0);
});

test('live context guard and phase binding fail closed before a write', async (t) => {
  const value = await fixture(t);
  value.setCurrent(false);
  await assert.rejects(value.store.append(openRequest(value)), { code: 'REV_LOOP_STALE' });
  assert.equal(await value.store.read(), null);
  value.setCurrent(true);
  const request = openRequest(value);
  await assert.rejects(value.store.append({ ...request, context: {
    ...request.context, workflowSha256: digest('0')
  } }), { code: 'REV_LOOP_STALE' });
  assert.equal(await value.store.read(), null);
});

test('a crash orphan temp is ignored, while a tampered committed entry is rejected', async (t) => {
  const value = await fixture(t);
  await value.store.append(openRequest(value));
  await writeFile(path.join(value.journal,
    '.0000000001.json.tmp-123-00000000-0000-0000-0000-000000000000'), 'partial');
  assert.equal((await value.store.read()).revision, 0);
  const file = path.join(value.journal, '0000000000.json');
  await rm(file);
  await symlink(path.join(value.root, 'outside'), file);
  await assert.rejects(value.store.read(), { code: 'REV_LOOP_CORRUPT' });
});

test('restore selects an earlier retained head without an interval and stales the old card', async (t) => {
  const value = await fixture(t);
  await value.store.append(openRequest(value));
  await value.store.append(commitRequest(value, await value.store.read()));
  const before = await value.store.read();
  const comparison = await value.store.compare({
    fromCandidateRefSha256: candidate('b').candidateRefSha256,
    toCandidateRefSha256: candidate('a').candidateRefSha256
  });
  assert.equal(comparison.kind, 'revision-candidate-reference-comparison');
  assert.equal(comparison.sameTree, false);
  assert.equal(comparison.from.intervalId, 'REV-STORY-1-IMPLEMENT-001');
  assert.equal(comparison.to.intervalId, null);
  const request = selectRequest(value, before);
  const restored = await value.store.append(request);
  assert.deepEqual(await value.store.append(request), restored);
  const after = await value.store.read();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.intervalSequence, before.intervalSequence);
  assert.equal(after.head.candidateRefSha256, candidate('a').candidateRefSha256);
  assert.equal(after.headIntervalId, null);
  assert.equal(after.precheckSha256, null);
  assert.match(after.headSnapshotSha256, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(after.headSnapshotSha256, before.headSnapshotSha256);
  assert.notEqual(after.headTransitionSha256, before.headTransitionSha256);
  assert.equal((await value.store.list()).length, 3);
  await assert.rejects(value.store.append(commitRequest(value, before, 'old-head')),
    { code: 'REV_LOOP_ADVANCED' });
});

test('two concurrent local restore CAS attempts cannot both select the head', async (t) => {
  const value = await fixture(t);
  await value.store.append(openRequest(value));
  await value.store.append(commitRequest(value, await value.store.read()));
  const head = await value.store.read();
  const results = await Promise.allSettled([
    value.store.append(selectRequest(value, head, 'restore-a')),
    value.store.append(selectRequest(value, head, 'restore-b'))
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  assert.ok(['REV_LOOP_ADVANCED', 'SUBJECT_LOCK_BUSY'].includes(
    results.find((item) => item.status === 'rejected').reason.code
  ));
  assert.equal((await value.store.read()).revision, head.revision + 1);
  assert.equal((await value.store.list()).length, 3);
});

test('restore refuses unknown destinations and mismatched materialization proof', async (t) => {
  const value = await fixture(t);
  await value.store.append(openRequest(value));
  await value.store.append(commitRequest(value, await value.store.read()));
  const head = await value.store.read();
  const request = selectRequest(value, head);
  const unknown = candidate('c');
  await assert.rejects(value.store.append({ ...request, transition: {
    ...request.transition, selectedCandidate: unknown
  } }), { code: 'REV_LOOP_INVALID' });
  const badCore = {
    ...request.transition.headTransition,
    worktreeIndexEditorPreimageSha256: digest('f')
  };
  delete badCore.transitionSha256;
  const badTransition = { ...badCore, transitionSha256: sha(badCore) };
  const badSnapshotCore = {
    ...request.transition.headSnapshot,
    headTransitionSha256: badTransition.transitionSha256
  };
  delete badSnapshotCore.headSnapshotSha256;
  await assert.rejects(value.store.append({ ...request, transition: {
    ...request.transition, headTransition: badTransition,
    headSnapshot: { ...badSnapshotCore, headSnapshotSha256: sha(badSnapshotCore) }
  } }), { code: 'REV_LOOP_STALE' });
  assert.equal((await value.store.read()).revision, head.revision);
});

test('a shaped but unverified candidate cannot open or advance the local head', async (t) => {
  const value = await fixture(t);
  const withoutVerifier = createRevisionLoopStore({
    root: value.root, ...value.scope, producer,
    assertCurrentContext: async () => true
  });
  await assert.rejects(withoutVerifier.append(openRequest(value)),
    { code: 'REV_LOOP_CANDIDATE_UNVERIFIED' });
  value.setVerifier(() => false);
  await assert.rejects(value.store.append(openRequest(value)),
    { code: 'REV_LOOP_CANDIDATE_UNVERIFIED' });
  assert.equal(await value.store.read(), null);
  value.setVerifier((item) => item.candidateId === candidate('a').candidateId);
  await value.store.append(openRequest(value));
  const request = commitRequest(value, await value.store.read());
  await assert.rejects(value.store.append(request),
    { code: 'REV_LOOP_CANDIDATE_UNVERIFIED' });
  assert.equal((await value.store.read()).revision, 0);
});

test('self-hashed but unverified precheck cannot CAS-advance the head', async (t) => {
  const value = await fixture(t);
  await value.store.append(openRequest(value));
  const request = commitRequest(value, await value.store.read());
  const withoutVerifier = createRevisionLoopStore({
    root: value.root, ...value.scope, producer,
    assertCurrentContext: async () => true,
    verifyRetainedCandidate: async () => true
  });
  await assert.rejects(withoutVerifier.append(request),
    { code: 'REV_LOOP_PRECHECK_UNVERIFIED' });
  value.setPrecheckVerifier(() => false);
  await assert.rejects(value.store.append(request),
    { code: 'REV_LOOP_PRECHECK_UNVERIFIED' });
  assert.equal((await value.store.read()).revision, 0);
});

test('a changed workflow binding cannot be recorded in the same phase-generation loop', async (t) => {
  const value = await fixture(t);
  await value.store.append(openRequest(value));
  const head = await value.store.read();
  value.setContext({ ...value.context, workflowSha256: digest('0') });
  await assert.rejects(value.store.append({
    expectedRevision: head.revision,
    expectedHeadCandidateRefSha256: head.head.candidateRefSha256,
    context: value.context, idempotencyKey: 'abandon-changed-workflow',
    transition: { type: 'abandon-loop', loopId: head.loopId }
  }), { code: 'REV_LOOP_STALE' });
  assert.equal((await value.store.read()).revision, 0);
});

test('authority callbacks cannot mutate the snapshotted request being committed', async (t) => {
  const value = await fixture(t);
  value.setVerifier((item) => {
    item.candidateId = 'CAN-MUTATED';
    return true;
  });
  const request = openRequest(value);
  const opened = await value.store.append(request);
  assert.equal(opened.transition.initialCandidate.candidateId, candidate('a').candidateId);
  assert.equal((await value.store.read()).head.candidateId, candidate('a').candidateId);
});
