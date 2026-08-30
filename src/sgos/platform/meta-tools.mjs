import { canonicalJson } from '../../records.mjs';
import { SingularityFlowError } from '../../util.mjs';
import {
  clonePlatformJson, createMetaToolActivation, createMetaToolObservation,
  createMetaToolObservationPolicy, createMetaToolPromotion, createMetaToolRevocation,
  createMetaToolRollback, createMetaToolTarget, platformSha256, validatePlatformRecord
} from './contracts.mjs';
import { assertAuthorityStoreAdapter } from './authority-store.mjs';
import { loadApprovedPlatformMutationAuthority } from './authority.mjs';
import { verifySignedPlatformRecord } from './signatures.mjs';

function fail(message, code = 'SGOS_META_TOOL_INVALID') {
  throw new SingularityFlowError(message, { code });
}

const keyDigest = (value) => platformSha256(value).slice(7);
const traceKey = (sha256) => `meta-trace:${keyDigest(sha256)}`;
const candidateKey = (sha256) => `meta-candidate:${keyDigest(sha256)}`;
const evaluationKey = (sha256) => `meta-evaluation:${keyDigest(sha256)}`;
const promotionKey = (sha256) => `meta-promotion:${keyDigest(sha256)}`;
const activationKey = (sha256) => `meta-activation:${keyDigest(sha256)}`;
const activeKey = (operationId) => `meta-active:${keyDigest(operationId)}`;
const revocationKey = (sha256) => `meta-revocation:${keyDigest(sha256)}`;
const observationKey = (sha256, sequence) =>
  `meta-observation:${keyDigest(platformSha256({ sha256, sequence }))}`;
const rollbackKey = (sha256) => `meta-rollback:${keyDigest(sha256)}`;

const TARGET_FIELDS = Object.freeze([
  'kind', 'operationId', 'version', 'manifestSha256', 'authoritySha256'
]);

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label} must contain exactly: ${expected.join(', ')}.`, 'SGOS_META_TOOL_TARGET_INVALID');
  }
}

function exactTargetRequest(value) {
  exactObject(value, TARGET_FIELDS, 'Meta-tool target request');
  return clonePlatformJson(value);
}

function exactObservationPolicy(value) {
  exactObject(value, ['maximumObservations', 'maximumEvidenceRefs', 'acceptedOutcomes'],
    'Meta-tool observation policy');
  return createMetaToolObservationPolicy(value);
}

function requireCas(expectedRevision, expectedStateSha256) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !/^sha256:[a-f0-9]{64}$/.test(String(expectedStateSha256 ?? ''))) {
    fail('Meta-tool mutation requires an exact Authority Store revision and state digest.', 'SGOS_META_TOOL_CAS_REQUIRED');
  }
}

function trustMap(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    fail(`${label} requires explicit trust anchors.`, 'SGOS_META_TOOL_UNTRUSTED');
  }
  return new Map(Object.entries(value));
}

export function createMetaToolService({
  authorityStore,
  trustedTraceIssuers,
  trustedEvaluators,
  repositoryRoot,
  resolveTargetAuthority = null
}) {
  const store = assertAuthorityStoreAdapter(authorityStore);
  const traceIssuers = trustMap(trustedTraceIssuers, 'Meta-tool trace verification');
  const evaluators = trustMap(trustedEvaluators, 'Meta-tool evaluation');

  function verifyTrace(signedTrace) {
    const claimed = validatePlatformRecord(signedTrace?.record, 'platform-accepted-trace');
    const trustedPublicKeyPem = traceIssuers.get(claimed.issuerKeyId);
    if (!trustedPublicKeyPem) fail(`Trace issuer '${claimed.issuerKeyId}' is not trusted.`, 'SGOS_META_TOOL_TRACE_UNTRUSTED');
    return verifySignedPlatformRecord(signedTrace, {
      trustedPublicKeyPem,
      expectedKeyId: claimed.issuerKeyId,
      expectedKind: 'platform-accepted-trace'
    });
  }

  function verifyEvaluation(signedEvaluation) {
    const claimed = validatePlatformRecord(signedEvaluation?.record, 'platform-meta-tool-evaluation');
    const trustedPublicKeyPem = evaluators.get(claimed.evaluatorKeyId);
    if (!trustedPublicKeyPem) fail(`Evaluator '${claimed.evaluatorKeyId}' is not trusted.`, 'SGOS_META_TOOL_EVALUATION_UNTRUSTED');
    return verifySignedPlatformRecord(signedEvaluation, {
      trustedPublicKeyPem,
      expectedKeyId: claimed.evaluatorKeyId,
      expectedKind: 'platform-meta-tool-evaluation'
    });
  }

  async function resolveApprovedTarget(request) {
    if (typeof resolveTargetAuthority !== 'function') {
      fail('Meta-tool activation requires an installed trusted Pack/Device authority resolver.',
        'SGOS_META_TOOL_TARGET_AUTHORITY_REQUIRED');
    }
    const expected = exactTargetRequest(request);
    let resolved;
    try {
      resolved = await resolveTargetAuthority(Object.freeze(clonePlatformJson(expected)));
    } catch (error) {
      if (error instanceof SingularityFlowError) throw error;
      fail('Meta-tool target authority could not be resolved.',
        'SGOS_META_TOOL_TARGET_AUTHORITY_UNAVAILABLE');
    }
    exactObject(resolved, [
      ...TARGET_FIELDS, 'approvalSha256', 'status'
    ], 'Resolved meta-tool target authority');
    if (resolved.status !== 'approved') {
      fail('Meta-tool target Pack/Device authority is revoked, superseded, or stale.',
        'SGOS_META_TOOL_TARGET_NOT_ACTIVE');
    }
    for (const field of TARGET_FIELDS) {
      if (resolved[field] !== expected[field]) {
        fail(`Resolved meta-tool target does not match requested ${field}.`,
          'SGOS_META_TOOL_TARGET_AUTHORITY_MISMATCH');
      }
    }
    return createMetaToolTarget({
      kind: resolved.kind,
      operationId: resolved.operationId,
      version: resolved.version,
      manifestSha256: resolved.manifestSha256,
      authoritySha256: resolved.authoritySha256,
      approvalSha256: resolved.approvalSha256
    });
  }

  function readCandidate(entries, candidateSha256) {
    const candidate = entries[candidateKey(candidateSha256)];
    if (!candidate) fail('Meta-tool candidate is unavailable.', 'SGOS_META_TOOL_CANDIDATE_NOT_FOUND');
    const validated = validatePlatformRecord(candidate, 'platform-meta-tool-candidate');
    if (validated.recordSha256 !== candidateSha256) {
      fail('Meta-tool candidate authority key does not match its exact record.',
        'SGOS_META_TOOL_CANDIDATE_TAMPERED');
    }
    return validated;
  }

  function readEvaluation(entries, evaluationSha256, candidateSha256) {
    const signed = entries[evaluationKey(evaluationSha256)];
    if (!signed) fail('Meta-tool evaluation is unavailable.', 'SGOS_META_TOOL_EVALUATION_NOT_FOUND');
    const evaluation = verifyEvaluation(signed);
    if (evaluation.recordSha256 !== evaluationSha256
        || evaluation.candidateSha256 !== candidateSha256) {
      fail('Meta-tool evaluation is not bound to the exact candidate.',
        'SGOS_META_TOOL_EVALUATION_INVALID');
    }
    if ([evaluation.securityGate, evaluation.qualityGate, evaluation.costGate]
      .some((gate) => gate !== 'passed')) {
      fail('Meta-tool authority requires passing security, quality, and cost gates.',
        'SGOS_META_TOOL_EVALUATION_BLOCKED');
    }
    return evaluation;
  }

  function assertEvaluationIndependent(entries, candidate, evaluation) {
    const traceIssuersForCandidate = new Set(candidate.traceRefs.map((traceSha256) => {
      const signedTrace = entries[traceKey(traceSha256)];
      if (!signedTrace) {
        fail('Meta-tool evaluation candidate is missing an accepted source trace.',
          'SGOS_META_TOOL_TRACE_SET_INVALID');
      }
      return verifyTrace(signedTrace).issuerKeyId;
    }));
    if (traceIssuersForCandidate.has(evaluation.evaluatorKeyId)) {
      fail('Meta-tool evaluation authority must be independent from every candidate trace issuer.',
        'SGOS_META_TOOL_EVALUATOR_SOURCE_OVERLAP');
    }
  }

  function readPromotion(entries, promotionSha256, candidate, evaluation) {
    const promotion = entries[promotionKey(candidate.recordSha256)];
    if (!promotion) fail('Meta-tool promotion is unavailable.', 'SGOS_META_TOOL_PROMOTION_NOT_FOUND');
    const validated = validatePlatformRecord(promotion, 'platform-meta-tool-promotion');
    if (validated.recordSha256 !== promotionSha256
        || validated.candidateSha256 !== candidate.recordSha256
        || validated.evaluationSha256 !== evaluation.recordSha256
        || validated.decision !== 'approved'
        || validated.reviewerId === candidate.proposerId) {
      fail('Meta-tool activation requires the exact independent approving promotion.',
        'SGOS_META_TOOL_PROMOTION_INVALID');
    }
    return validated;
  }

  async function validateActivationLineage(entries, activationSha256, {
    requireCurrentTarget = true
  } = {}) {
    const raw = entries[activationKey(activationSha256)];
    if (!raw) fail('Meta-tool activation is unavailable.', 'SGOS_META_TOOL_ACTIVATION_NOT_FOUND');
    const activation = validatePlatformRecord(raw, 'platform-meta-tool-activation');
    if (activation.recordSha256 !== activationSha256) {
      fail('Meta-tool activation authority key does not match its exact record.',
        'SGOS_META_TOOL_ACTIVATION_TAMPERED');
    }
    const candidate = readCandidate(entries, activation.candidateSha256);
    const evaluation = readEvaluation(entries, activation.evaluationSha256, candidate.recordSha256);
    assertEvaluationIndependent(entries, candidate, evaluation);
    const promotion = readPromotion(entries, activation.promotionSha256, candidate, evaluation);
    if (candidate.operationId !== activation.target.operationId) {
      fail('Meta-tool activation operation differs from its approved candidate.',
        'SGOS_META_TOOL_ACTIVATION_STALE');
    }
    if (entries[revocationKey(activationSha256)]) {
      const revocation = validatePlatformRecord(entries[revocationKey(activationSha256)],
        'platform-meta-tool-revocation');
      if (revocation.activationSha256 !== activationSha256) {
        fail('Meta-tool revocation is not bound to the selected activation.',
          'SGOS_META_TOOL_ACTIVATION_TAMPERED');
      }
      fail('Meta-tool activation is revoked.', 'SGOS_META_TOOL_ACTIVATION_REVOKED');
    }
    if (requireCurrentTarget) {
      const requested = Object.fromEntries(TARGET_FIELDS.map((field) => [field, activation.target[field]]));
      const currentTarget = await resolveApprovedTarget(requested);
      if (currentTarget.targetSha256 !== activation.target.targetSha256
          || currentTarget.approvalSha256 !== activation.target.approvalSha256) {
        fail('Meta-tool target authority changed after activation.',
          'SGOS_META_TOOL_ACTIVATION_STALE');
      }
    }
    return { activation, candidate, evaluation, promotion };
  }

  function readObservations(entries, activationSha256) {
    const observations = [];
    for (const [key, entry] of Object.entries(entries)) {
      if (entry?.kind !== 'platform-meta-tool-observation'
          || entry.activationSha256 !== activationSha256) continue;
      const observation = validatePlatformRecord(entry, 'platform-meta-tool-observation');
      if (key !== observationKey(activationSha256, observation.sequence)) {
        fail('Meta-tool observation authority key does not match its sequence.',
          'SGOS_META_TOOL_OBSERVATION_TAMPERED');
      }
      observations.push(observation);
    }
    observations.sort((left, right) => left.sequence - right.sequence);
    observations.forEach((observation, index) => {
      if (observation.sequence !== index + 1) {
        fail('Meta-tool observation sequence is incomplete or duplicated.',
          'SGOS_META_TOOL_OBSERVATION_TAMPERED');
      }
    });
    return observations;
  }

  return Object.freeze({
    profile: 'governed-activation-local-v1',

    async propose(candidate, signedTraces, {
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'meta-tool.propose'
      );
      const validated = validatePlatformRecord(candidate, 'platform-meta-tool-candidate');
      if (validated.proposerId !== authorization.actorId) {
        fail('Meta-tool candidate proposer identity must come from approved configuration authority.',
          'SGOS_META_TOOL_PROPOSER_MISMATCH');
      }
      if (!Array.isArray(signedTraces) || signedTraces.length !== validated.traceRefs.length) {
        fail('Meta-tool candidate must carry every exact accepted trace.', 'SGOS_META_TOOL_TRACE_SET_INVALID');
      }
      const traces = signedTraces.map(verifyTrace).sort((left, right) =>
        left.traceSha256 < right.traceSha256 ? -1 : left.traceSha256 > right.traceSha256 ? 1 : 0);
      if (new Set(traces.map((trace) => trace.traceSha256)).size !== traces.length
          || canonicalJson(traces.map((trace) => trace.traceSha256)) !== canonicalJson(validated.traceRefs)) {
        fail('Meta-tool candidate trace set does not match its verified signed traces.', 'SGOS_META_TOOL_TRACE_SET_INVALID');
      }
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Meta-tool candidate lost its compare-and-swap race.', 'SGOS_META_TOOL_CAS_MISMATCH');
      }
      if (state.entries[candidateKey(validated.recordSha256)]) fail('Meta-tool candidate already exists.', 'SGOS_META_TOOL_IMMUTABLE');
      const changes = [];
      for (let index = 0; index < traces.length; index += 1) {
        const key = traceKey(traces[index].traceSha256);
        const signed = clonePlatformJson(signedTraces.find((entry) => entry.record.traceSha256 === traces[index].traceSha256));
        const existing = state.entries[key];
        if (existing && canonicalJson(existing) !== canonicalJson(signed)) {
          fail('Accepted trace identity collides with different signed bytes.', 'SGOS_META_TOOL_TRACE_TAMPERED');
        }
        if (!existing) changes.push({ op: 'put', key, value: signed });
      }
      changes.push({ op: 'put', key: candidateKey(validated.recordSha256), value: validated });
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes
      });
      return validated;
    },

    async recordEvaluation(signedEvaluation, {
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'meta-tool.evaluation'
      );
      const evaluation = verifyEvaluation(signedEvaluation);
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Meta-tool evaluation lost its compare-and-swap race.', 'SGOS_META_TOOL_CAS_MISMATCH');
      }
      const candidate = readCandidate(state.entries, evaluation.candidateSha256);
      if (candidate.traceRefs.includes(evaluation.holdoutSha256)) {
        fail('Meta-tool evaluation holdout overlaps its source trace set.', 'SGOS_META_TOOL_HOLDOUT_LEAKAGE');
      }
      assertEvaluationIndependent(state.entries, candidate, evaluation);
      if (state.entries[evaluationKey(evaluation.recordSha256)]) fail('Meta-tool evaluation already exists.', 'SGOS_META_TOOL_IMMUTABLE');
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [{
          op: 'put', key: evaluationKey(evaluation.recordSha256), value: clonePlatformJson(signedEvaluation)
        }]
      });
      return evaluation;
    },

    async promote({
      candidateSha256,
      evaluationSha256,
      confirmCandidateSha256,
      confirmEvaluationSha256,
      decision,
      reason,
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'meta-tool.promote'
      );
      if (confirmCandidateSha256 !== candidateSha256 || confirmEvaluationSha256 !== evaluationSha256) {
        fail('Meta-tool promotion confirmation is stale.', 'SGOS_META_TOOL_CONFIRMATION_MISMATCH');
      }
      if (decision !== 'approved') fail('Meta-tool promotion requires explicit human approval.', 'SGOS_META_TOOL_HUMAN_APPROVAL_REQUIRED');
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Meta-tool promotion lost its compare-and-swap race.', 'SGOS_META_TOOL_CAS_MISMATCH');
      }
      const candidate = readCandidate(state.entries, candidateSha256);
      const evaluation = readEvaluation(state.entries, evaluationSha256, candidateSha256);
      if (authorization.actorId === candidate.proposerId) {
        fail('Meta-tool promotion requires an independent human reviewer.', 'SGOS_META_TOOL_HUMAN_APPROVAL_REQUIRED');
      }
      if (state.entries[promotionKey(candidateSha256)]) fail('Meta-tool candidate already has a promotion decision.', 'SGOS_META_TOOL_IMMUTABLE');
      const promotion = createMetaToolPromotion({
        candidateSha256,
        evaluationSha256,
        reviewerId: authorization.actorId,
        decision,
        reason,
        status: 'pack-review-required',
        promotedAt: new Date().toISOString()
      });
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [{ op: 'put', key: promotionKey(candidateSha256), value: promotion }]
      });
      return promotion;
    },

    async activate({
      candidateSha256,
      evaluationSha256,
      promotionSha256,
      target,
      observationPolicy,
      confirmPromotionSha256,
      confirmTargetSha256,
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'meta-tool.activate'
      );
      if (confirmPromotionSha256 !== promotionSha256) {
        fail('Meta-tool activation promotion confirmation is stale.',
          'SGOS_META_TOOL_CONFIRMATION_MISMATCH');
      }
      const resolvedTarget = await resolveApprovedTarget(target);
      if (confirmTargetSha256 !== resolvedTarget.targetSha256) {
        fail('Meta-tool target confirmation is stale.', 'SGOS_META_TOOL_CONFIRMATION_MISMATCH');
      }
      const policy = exactObservationPolicy(observationPolicy);
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Meta-tool activation lost its compare-and-swap race.', 'SGOS_META_TOOL_CAS_MISMATCH');
      }
      const candidate = readCandidate(state.entries, candidateSha256);
      const evaluation = readEvaluation(state.entries, evaluationSha256, candidateSha256);
      readPromotion(state.entries, promotionSha256, candidate, evaluation);
      if (candidate.operationId !== resolvedTarget.operationId) {
        fail('Meta-tool target operation differs from its approved candidate.',
          'SGOS_META_TOOL_TARGET_OPERATION_MISMATCH');
      }
      if (authorization.actorId === candidate.proposerId) {
        fail('A meta-tool candidate cannot activate or deploy itself.',
          'SGOS_META_TOOL_SELF_ACTIVATION_REFUSED');
      }
      const priorSelection = state.entries[activeKey(resolvedTarget.operationId)] ?? null;
      if (priorSelection != null) {
        exactObject(priorSelection, ['operationId', 'activationSha256'],
          'Active meta-tool selection');
        await validateActivationLineage(state.entries, priorSelection.activationSha256);
      }
      const activation = createMetaToolActivation({
        candidateSha256,
        evaluationSha256,
        promotionSha256,
        target: resolvedTarget,
        observationPolicy: policy,
        supersedesActivationSha256: priorSelection?.activationSha256 ?? null,
        activatedRevision: expectedRevision + 1,
        activatedBy: authorization.actorId,
        activatedAt: new Date().toISOString()
      });
      if (state.entries[activationKey(activation.recordSha256)]) {
        fail('Meta-tool activation already exists.', 'SGOS_META_TOOL_IMMUTABLE');
      }
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [
          { op: 'put', key: activationKey(activation.recordSha256), value: activation },
          {
            op: 'put', key: activeKey(resolvedTarget.operationId),
            value: {
              operationId: resolvedTarget.operationId,
              activationSha256: activation.recordSha256
            }
          }
        ]
      });
      return activation;
    },

    async recordObservation({
      activationSha256,
      outcome,
      evidenceRefs,
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'meta-tool.observe'
      );
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Meta-tool observation lost its compare-and-swap race.', 'SGOS_META_TOOL_CAS_MISMATCH');
      }
      const { activation } = await validateActivationLineage(state.entries, activationSha256);
      const selected = state.entries[activeKey(activation.target.operationId)];
      if (selected?.activationSha256 !== activationSha256) {
        fail('Observations may be appended only to the current active meta-tool version.',
          'SGOS_META_TOOL_ACTIVATION_SUPERSEDED');
      }
      const prior = readObservations(state.entries, activationSha256);
      const sequence = prior.length + 1;
      if (sequence > activation.observationPolicy.maximumObservations) {
        fail('Meta-tool observation policy capacity is exhausted.',
          'SGOS_META_TOOL_OBSERVATION_LIMIT');
      }
      if (!activation.observationPolicy.acceptedOutcomes.includes(outcome)) {
        fail('Meta-tool observation outcome is not allowed by the activation policy.',
          'SGOS_META_TOOL_OBSERVATION_OUTCOME_REFUSED');
      }
      if (!Array.isArray(evidenceRefs)
          || evidenceRefs.length > activation.observationPolicy.maximumEvidenceRefs) {
        fail('Meta-tool observation evidence exceeds the activation policy.',
          'SGOS_META_TOOL_OBSERVATION_LIMIT');
      }
      const observation = createMetaToolObservation({
        activationSha256,
        sequence,
        outcome,
        evidenceRefs: [...evidenceRefs].sort(),
        observedBy: authorization.actorId,
        observedAt: new Date().toISOString()
      });
      const key = observationKey(activationSha256, sequence);
      if (state.entries[key]) fail('Meta-tool observation sequence already exists.', 'SGOS_META_TOOL_IMMUTABLE');
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [{ op: 'put', key, value: observation }]
      });
      return observation;
    },

    async revoke({
      activationSha256,
      reason,
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'meta-tool.revoke'
      );
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Meta-tool revocation lost its compare-and-swap race.', 'SGOS_META_TOOL_CAS_MISMATCH');
      }
      const { activation } = await validateActivationLineage(state.entries, activationSha256,
        { requireCurrentTarget: false });
      const revocation = createMetaToolRevocation({
        activationSha256,
        revokedBy: authorization.actorId,
        reason,
        revokedAt: new Date().toISOString()
      });
      const changes = [{
        op: 'put', key: revocationKey(activationSha256), value: revocation
      }];
      const selectionKey = activeKey(activation.target.operationId);
      if (state.entries[selectionKey]?.activationSha256 === activationSha256) {
        changes.push({ op: 'delete', key: selectionKey });
      }
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes
      });
      return revocation;
    },

    async rollback({
      operationId,
      targetActivationSha256,
      confirmActiveActivationSha256,
      confirmTargetActivationSha256,
      reason,
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'meta-tool.rollback'
      );
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Meta-tool rollback lost its compare-and-swap race.', 'SGOS_META_TOOL_CAS_MISMATCH');
      }
      const selected = state.entries[activeKey(operationId)];
      if (!selected || selected.activationSha256 !== confirmActiveActivationSha256
          || targetActivationSha256 !== confirmTargetActivationSha256) {
        fail('Meta-tool rollback confirmation is stale.', 'SGOS_META_TOOL_CONFIRMATION_MISMATCH');
      }
      exactObject(selected, ['operationId', 'activationSha256'], 'Active meta-tool selection');
      if (selected.operationId !== operationId) {
        fail('Active meta-tool selection operation is invalid.', 'SGOS_META_TOOL_ACTIVATION_TAMPERED');
      }
      const current = await validateActivationLineage(state.entries, selected.activationSha256);
      const targetLineage = await validateActivationLineage(state.entries, targetActivationSha256);
      if (current.activation.target.operationId !== operationId
          || targetLineage.activation.target.operationId !== operationId) {
        fail('Meta-tool rollback target belongs to another operation.',
          'SGOS_META_TOOL_ROLLBACK_TARGET_INVALID');
      }
      if (targetActivationSha256 === selected.activationSha256) {
        fail('Meta-tool rollback target is already active.', 'SGOS_META_TOOL_ROLLBACK_TARGET_INVALID');
      }
      const rollback = createMetaToolRollback({
        operationId,
        fromActivationSha256: selected.activationSha256,
        toActivationSha256: targetActivationSha256,
        rolledBackBy: authorization.actorId,
        reason,
        rolledBackAt: new Date().toISOString()
      });
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [
          { op: 'put', key: rollbackKey(rollback.recordSha256), value: rollback },
          {
            op: 'put', key: activeKey(operationId),
            value: { operationId, activationSha256: targetActivationSha256 }
          }
        ]
      });
      return rollback;
    },

    async resolveActive(operationId, expectedActivationSha256, {
      expectedAuthorityStateSha256 = null
    } = {}) {
      const state = await store.read();
      if (expectedAuthorityStateSha256 != null
          && state.recordSha256 !== expectedAuthorityStateSha256) {
        fail('Meta-tool runtime authority state changed after admission.',
          'SGOS_META_TOOL_AUTHORITY_STATE_STALE');
      }
      const selected = state.entries[activeKey(operationId)];
      if (!selected) fail('Meta-tool operation has no active version.', 'SGOS_META_TOOL_NOT_ACTIVE');
      exactObject(selected, ['operationId', 'activationSha256'], 'Active meta-tool selection');
      if (selected.operationId !== operationId
          || selected.activationSha256 !== expectedActivationSha256) {
        fail('Meta-tool activation was superseded.', 'SGOS_META_TOOL_ACTIVATION_SUPERSEDED');
      }
      const lineage = await validateActivationLineage(state.entries, expectedActivationSha256);
      return Object.freeze({
        authorityStoreId: store.storeId,
        authorityStateSha256: state.recordSha256,
        activation: clonePlatformJson(lineage.activation),
        candidate: clonePlatformJson(lineage.candidate),
        evaluation: clonePlatformJson(lineage.evaluation),
        promotion: clonePlatformJson(lineage.promotion)
      });
    }
  });
}
