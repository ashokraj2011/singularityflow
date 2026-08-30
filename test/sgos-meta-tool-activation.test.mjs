import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAcceptedTrace,
  createMetaToolCandidate,
  createMetaToolEvaluation,
  createMetaToolService,
  createMetaToolTarget,
  openFilesystemAuthorityStore,
  platformPrincipalId,
  platformSha256,
  signPlatformRecord
} from '../src/sgos/platform/index.mjs';

const timestamp = '2026-08-30T10:00:00.000Z';
const digest = (label) => platformSha256(`meta-tool-fixture:${label}`);

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-meta-activation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function repository(root) {
  const proposerEmail = 'meta.proposer@example.test';
  const reviewerEmail = 'meta.reviewer@example.test';
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Meta Proposer');
  git(root, 'config', 'user.email', proposerEmail);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  const members = [proposerEmail, reviewerEmail]
    .map((email) => `      - { email: ${email} }`).join('\n');
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), [
    'version: 2',
    'approvalAuthorities:',
    '  architecture-reviewers:',
    '    members:', members,
    '  engineering-reviewers:',
    '    members:', members,
    '  quality-reviewers:',
    '    members:', members,
    ''
  ].join('\n'));
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '-m', 'approved platform authority');
  git(root, 'branch', 'sflow/config');
  return {
    proposerEmail,
    reviewerEmail,
    proposerId: platformPrincipalId({ email: proposerEmail }),
    reviewerId: platformPrincipalId({ email: reviewerEmail })
  };
}

async function cas(store) {
  const state = await store.read();
  return { expectedRevision: state.revision, expectedStateSha256: state.recordSha256 };
}

function targetAuthority(version) {
  const request = {
    kind: 'pack-operation',
    operationId: 'operation-format-result',
    version,
    manifestSha256: digest(`manifest-${version}`),
    authoritySha256: digest(`pack-${version}`)
  };
  const resolved = {
    ...request,
    approvalSha256: digest(`pack-review-${version}`),
    status: 'approved'
  };
  return {
    request,
    resolved,
    target: createMetaToolTarget({
      ...request,
      approvalSha256: resolved.approvalSha256
    })
  };
}

async function approvedCandidate({
  root, identities, store, service, traceSigner, evaluationSigner, label
}) {
  git(root, 'config', 'user.email', identities.proposerEmail);
  const traces = [1, 2].map((number) => createAcceptedTrace({
    traceSha256: digest(`${label}-trace-${number}`),
    evidenceSha256: digest(`${label}-evidence-${number}`),
    verificationReceiptSha256: digest(`${label}-verification-${number}`),
    outcomeAcceptanceSha256: digest(`${label}-outcome-${number}`),
    containsSecrets: false,
    unresolvedGaps: 0,
    issuerKeyId: 'trace-issuer',
    acceptedAt: timestamp
  }));
  const signedTraces = traces.map((trace) => signPlatformRecord(trace, {
    privateKeyPem: traceSigner.privateKeyPem,
    keyId: 'trace-issuer'
  }));
  const candidate = createMetaToolCandidate({
    candidateId: `candidate-${label}`,
    operationId: 'operation-format-result',
    traceRefs: traces.map((trace) => trace.traceSha256).sort(),
    proposerId: identities.proposerId,
    createdAt: timestamp
  });
  await service.propose(candidate, signedTraces, await cas(store));
  const evaluation = createMetaToolEvaluation({
    candidateSha256: candidate.recordSha256,
    securityGate: 'passed',
    qualityGate: 'passed',
    costGate: 'passed',
    holdoutSha256: digest(`${label}-holdout`),
    evaluatorKeyId: 'evaluator-independent',
    evaluatedAt: timestamp
  });
  await service.recordEvaluation(signPlatformRecord(evaluation, {
    privateKeyPem: evaluationSigner.privateKeyPem,
    keyId: 'evaluator-independent'
  }), await cas(store));
  git(root, 'config', 'user.email', identities.reviewerEmail);
  const promotion = await service.promote({
    candidateSha256: candidate.recordSha256,
    evaluationSha256: evaluation.recordSha256,
    confirmCandidateSha256: candidate.recordSha256,
    confirmEvaluationSha256: evaluation.recordSha256,
    decision: 'approved',
    reason: 'independent fixture review',
    ...await cas(store)
  });
  return { candidate, evaluation, promotion };
}

test('meta-tool activation is exact, versioned, observable, revocable, and rollback-safe', async (t) => {
  const root = await temporaryDirectory(t);
  const identities = await repository(root);
  const store = await openFilesystemAuthorityStore({
    root: path.join(root, '.authority'), storeId: 'meta-activation-authority'
  });
  const traceSigner = keyPair();
  const evaluationSigner = keyPair();
  const firstTarget = targetAuthority('1.0.0');
  const secondTarget = targetAuthority('2.0.0');
  const targets = new Map([
    [firstTarget.request.authoritySha256, firstTarget.resolved],
    [secondTarget.request.authoritySha256, secondTarget.resolved]
  ]);
  const service = createMetaToolService({
    authorityStore: store,
    repositoryRoot: root,
    trustedTraceIssuers: { 'trace-issuer': traceSigner.publicKeyPem },
    trustedEvaluators: { 'evaluator-independent': evaluationSigner.publicKeyPem },
    resolveTargetAuthority: async (request) => targets.get(request.authoritySha256)
  });
  const first = await approvedCandidate({
    root, identities, store, service, traceSigner, evaluationSigner, label: 'version-one'
  });

  git(root, 'config', 'user.email', identities.proposerEmail);
  const selfActivationCas = await cas(store);
  await assert.rejects(() => service.activate({
    candidateSha256: first.candidate.recordSha256,
    evaluationSha256: first.evaluation.recordSha256,
    promotionSha256: first.promotion.recordSha256,
    target: firstTarget.request,
    observationPolicy: {
      maximumObservations: 3,
      maximumEvidenceRefs: 2,
      acceptedOutcomes: ['failed', 'succeeded']
    },
    confirmPromotionSha256: first.promotion.recordSha256,
    confirmTargetSha256: firstTarget.target.targetSha256,
    ...selfActivationCas
  }), (error) => error.code === 'SGOS_META_TOOL_SELF_ACTIVATION_REFUSED');

  git(root, 'config', 'user.email', identities.reviewerEmail);
  const counterfeitTargetCas = await cas(store);
  await assert.rejects(() => service.activate({
    candidateSha256: first.candidate.recordSha256,
    evaluationSha256: first.evaluation.recordSha256,
    promotionSha256: first.promotion.recordSha256,
    target: { ...firstTarget.request, version: '9.9.9' },
    observationPolicy: {
      maximumObservations: 3,
      maximumEvidenceRefs: 2,
      acceptedOutcomes: ['failed', 'succeeded']
    },
    confirmPromotionSha256: first.promotion.recordSha256,
    confirmTargetSha256: firstTarget.target.targetSha256,
    ...counterfeitTargetCas
  }), (error) => error.code === 'SGOS_META_TOOL_TARGET_AUTHORITY_MISMATCH');
  const firstActivation = await service.activate({
    candidateSha256: first.candidate.recordSha256,
    evaluationSha256: first.evaluation.recordSha256,
    promotionSha256: first.promotion.recordSha256,
    target: firstTarget.request,
    observationPolicy: {
      maximumObservations: 3,
      maximumEvidenceRefs: 2,
      acceptedOutcomes: ['failed', 'succeeded']
    },
    confirmPromotionSha256: first.promotion.recordSha256,
    confirmTargetSha256: firstTarget.target.targetSha256,
    ...await cas(store)
  });
  assert.equal(firstActivation.target.version, '1.0.0');
  assert.equal(firstActivation.activatedBy, identities.reviewerId);
  assert.equal((await service.resolveActive(
    first.candidate.operationId, firstActivation.recordSha256
  )).activation.recordSha256, firstActivation.recordSha256);

  const second = await approvedCandidate({
    root, identities, store, service, traceSigner, evaluationSigner, label: 'version-two'
  });
  const secondActivation = await service.activate({
    candidateSha256: second.candidate.recordSha256,
    evaluationSha256: second.evaluation.recordSha256,
    promotionSha256: second.promotion.recordSha256,
    target: secondTarget.request,
    observationPolicy: {
      maximumObservations: 3,
      maximumEvidenceRefs: 2,
      acceptedOutcomes: ['failed', 'succeeded']
    },
    confirmPromotionSha256: second.promotion.recordSha256,
    confirmTargetSha256: secondTarget.target.targetSha256,
    ...await cas(store)
  });
  assert.equal(secondActivation.supersedesActivationSha256, firstActivation.recordSha256);
  await assert.rejects(
    () => service.resolveActive(first.candidate.operationId, firstActivation.recordSha256),
    (error) => error.code === 'SGOS_META_TOOL_ACTIVATION_SUPERSEDED'
  );

  const admittedState = await store.read();
  const competingCas = await cas(store);
  const observations = await Promise.allSettled([1, 2].map((number) => service.recordObservation({
    activationSha256: secondActivation.recordSha256,
    outcome: 'succeeded',
    evidenceRefs: [digest(`runtime-evidence-${number}`)],
    ...competingCas
  })));
  assert.equal(observations.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(observations.filter((result) => result.status === 'rejected').length, 1);
  assert.ok(['SGOS_AUTHORITY_CAS_MISMATCH', 'SGOS_AUTHORITY_STORE_BUSY'].includes(
    observations.find((result) => result.status === 'rejected').reason.code
  ));
  await assert.rejects(() => service.resolveActive(
    second.candidate.operationId,
    secondActivation.recordSha256,
    { expectedAuthorityStateSha256: admittedState.recordSha256 }
  ), (error) => error.code === 'SGOS_META_TOOL_AUTHORITY_STATE_STALE');

  const staleRollbackCas = await cas(store);
  await assert.rejects(() => service.rollback({
    operationId: first.candidate.operationId,
    targetActivationSha256: firstActivation.recordSha256,
    confirmActiveActivationSha256: secondActivation.recordSha256,
    confirmTargetActivationSha256: digest('counterfeit-activation'),
    reason: 'stale confirmation must not mutate authority',
    ...staleRollbackCas
  }), (error) => error.code === 'SGOS_META_TOOL_CONFIRMATION_MISMATCH');
  const rollback = await service.rollback({
    operationId: first.candidate.operationId,
    targetActivationSha256: firstActivation.recordSha256,
    confirmActiveActivationSha256: secondActivation.recordSha256,
    confirmTargetActivationSha256: firstActivation.recordSha256,
    reason: 'regression observed after version two',
    ...await cas(store)
  });
  assert.equal(rollback.fromActivationSha256, secondActivation.recordSha256);
  assert.equal(rollback.toActivationSha256, firstActivation.recordSha256);
  assert.equal((await service.resolveActive(
    first.candidate.operationId, firstActivation.recordSha256
  )).activation.target.version, '1.0.0');
  targets.set(firstTarget.request.authoritySha256, {
    ...firstTarget.resolved,
    status: 'stale'
  });
  await assert.rejects(() => service.resolveActive(
    first.candidate.operationId, firstActivation.recordSha256
  ), (error) => error.code === 'SGOS_META_TOOL_TARGET_NOT_ACTIVE');
  targets.set(firstTarget.request.authoritySha256, firstTarget.resolved);
  const afterRollback = await store.read();
  assert.equal(Object.values(afterRollback.entries).filter((entry) =>
    entry?.kind === 'platform-meta-tool-observation'
    && entry.activationSha256 === secondActivation.recordSha256).length, 1);

  const revocation = await service.revoke({
    activationSha256: firstActivation.recordSha256,
    reason: 'rollback target subsequently withdrawn',
    ...await cas(store)
  });
  assert.equal(revocation.revokedBy, identities.reviewerId);
  await assert.rejects(() => service.resolveActive(
    first.candidate.operationId, firstActivation.recordSha256
  ), (error) => error.code === 'SGOS_META_TOOL_NOT_ACTIVE');

  const savedState = path.join(store.root, 'state.saved.json');
  await rename(path.join(store.root, 'state.json'), savedState);
  await symlink(savedState, path.join(store.root, 'state.json'));
  await assert.rejects(() => service.resolveActive(
    first.candidate.operationId, firstActivation.recordSha256
  ), (error) => error.code === 'SGOS_AUTHORITY_PATH_UNSAFE');
});

test('meta-tool evaluation refuses a signer that issued the candidate source traces', async (t) => {
  const root = await temporaryDirectory(t);
  const identities = await repository(root);
  const store = await openFilesystemAuthorityStore({
    root: path.join(root, '.authority'), storeId: 'meta-overlap-authority'
  });
  const sharedSigner = keyPair();
  const service = createMetaToolService({
    authorityStore: store,
    repositoryRoot: root,
    trustedTraceIssuers: { 'shared-signer': sharedSigner.publicKeyPem },
    trustedEvaluators: { 'shared-signer': sharedSigner.publicKeyPem }
  });
  const traces = [1, 2].map((number) => createAcceptedTrace({
    traceSha256: digest(`overlap-trace-${number}`),
    evidenceSha256: digest(`overlap-evidence-${number}`),
    verificationReceiptSha256: digest(`overlap-verification-${number}`),
    outcomeAcceptanceSha256: digest(`overlap-outcome-${number}`),
    containsSecrets: false,
    unresolvedGaps: 0,
    issuerKeyId: 'shared-signer',
    acceptedAt: timestamp
  }));
  const candidate = createMetaToolCandidate({
    candidateId: 'candidate-overlap',
    operationId: 'operation-format-result',
    traceRefs: traces.map((trace) => trace.traceSha256).sort(),
    proposerId: identities.proposerId,
    createdAt: timestamp
  });
  const signedTraces = traces.map((trace) => signPlatformRecord(trace, {
    privateKeyPem: sharedSigner.privateKeyPem,
    keyId: 'shared-signer'
  }));
  const spoofed = createMetaToolCandidate({
    candidateId: 'candidate-spoofed-proposer',
    operationId: 'operation-format-result',
    traceRefs: traces.map((trace) => trace.traceSha256).sort(),
    proposerId: identities.reviewerId,
    createdAt: timestamp
  });
  const spoofedCas = await cas(store);
  await assert.rejects(() => service.propose(spoofed, signedTraces, spoofedCas),
    (error) => error.code === 'SGOS_META_TOOL_PROPOSER_MISMATCH');
  await service.propose(candidate, signedTraces, await cas(store));
  const evaluation = createMetaToolEvaluation({
    candidateSha256: candidate.recordSha256,
    securityGate: 'passed',
    qualityGate: 'passed',
    costGate: 'passed',
    holdoutSha256: digest('overlap-holdout'),
    evaluatorKeyId: 'shared-signer',
    evaluatedAt: timestamp
  });
  const overlapCas = await cas(store);
  await assert.rejects(() => service.recordEvaluation(signPlatformRecord(evaluation, {
    privateKeyPem: sharedSigner.privateKeyPem,
    keyId: 'shared-signer'
  }), overlapCas), (error) => error.code === 'SGOS_META_TOOL_EVALUATOR_SOURCE_OVERLAP');
});
