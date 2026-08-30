import { canonicalJson } from '../../records.mjs';
import { SingularityFlowError } from '../../util.mjs';
import {
  clonePlatformJson, createMetaToolPromotion, platformSha256, validatePlatformRecord
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
  repositoryRoot
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

  return Object.freeze({
    profile: 'review-packet-only-v1',

    async propose(candidate, signedTraces, {
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'meta-tool.propose'
      );
      const validated = validatePlatformRecord(candidate, 'platform-meta-tool-candidate');
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
      const candidate = state.entries[candidateKey(evaluation.candidateSha256)];
      if (!candidate) fail('Meta-tool evaluation references an unknown candidate.', 'SGOS_META_TOOL_CANDIDATE_NOT_FOUND');
      validatePlatformRecord(candidate, 'platform-meta-tool-candidate');
      if (candidate.traceRefs.includes(evaluation.holdoutSha256)) {
        fail('Meta-tool evaluation holdout overlaps its source trace set.', 'SGOS_META_TOOL_HOLDOUT_LEAKAGE');
      }
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
      const candidate = state.entries[candidateKey(candidateSha256)];
      if (!candidate) fail('Meta-tool candidate is unavailable.', 'SGOS_META_TOOL_CANDIDATE_NOT_FOUND');
      validatePlatformRecord(candidate, 'platform-meta-tool-candidate');
      const signedEvaluation = state.entries[evaluationKey(evaluationSha256)];
      if (!signedEvaluation) fail('Meta-tool evaluation is unavailable.', 'SGOS_META_TOOL_EVALUATION_NOT_FOUND');
      const evaluation = verifyEvaluation(signedEvaluation);
      if (evaluation.recordSha256 !== evaluationSha256 || evaluation.candidateSha256 !== candidateSha256) {
        fail('Meta-tool evaluation is not bound to the exact candidate.', 'SGOS_META_TOOL_EVALUATION_INVALID');
      }
      if ([evaluation.securityGate, evaluation.qualityGate, evaluation.costGate].some((gate) => gate !== 'passed')) {
        fail('Meta-tool promotion requires passing security, quality, and cost gates.', 'SGOS_META_TOOL_EVALUATION_BLOCKED');
      }
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
    }
  });
}
