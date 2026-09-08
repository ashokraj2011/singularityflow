import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptFosApprovalRequest, buildFosInterpretationCard, createFosApprovalRequest,
  createFosReusableDefault, evaluateFosPrCheckAdoption, FOS_FEATURE_DEFAULTS,
  FOS_FAILURE_GUIDANCE, fosFailureGuidance, fosMilestoneReadiness, prefillFosTemplate,
  requestFosPreauthorization, resolveFosFeatures, resolveFosReusableDefault
} from '../src/fos-features.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

test('FOS:AC-050 all B features are independent and disabled by default', () => {
  assert.ok(Object.values(FOS_FEATURE_DEFAULTS).every((value) => value === false));
  assert.equal(resolveFosFeatures({ 'template-prefill': true })['approval-routing'], false);
  assert.throws(() => resolveFosFeatures({ unknown: true }), (error) => error.code === 'FOS_FEATURE_CONFIGURATION_INVALID');
  const readiness = fosMilestoneReadiness();
  assert.equal(readiness.M5.enabled, false);
  assert.equal(readiness.M5.status, 'external-adapters-required');
});

test('FOS:AC-038 reusable defaults expire and invalidate on every relevant identity', () => {
  const features = { 'reusable-defaults': true };
  const input = {
    repositoryId: 'repository-1', authoritySha256: sha('a'),
    question: { id: 'delivery-workflow', version: '2' }, contextSha256: sha('b'),
    policySha256: sha('c'), sourceSha256: sha('d'), value: 'feature',
    expiresAt: '2030-01-01T00:00:00.000Z'
  };
  const record = createFosReusableDefault(input, { features });
  assert.equal(resolveFosReusableDefault(record, input, { now: new Date('2029-01-01') }).status, 'suggested-default');
  assert.equal(resolveFosReusableDefault(record, { ...input, policySha256: sha('e') }, { now: new Date('2029-01-01') }).status, 'needs_input');
  assert.equal(resolveFosReusableDefault(record, input, { now: new Date('2031-01-01') }).status, 'needs_input');
  assert.equal(record.grantsAuthority, false);
});

test('FOS:AC-039 interpretation cards never invent missing evidence or ask more than three questions', () => {
  const blocked = buildFosInterpretationCard({
    interpretation: 'Use feature workflow', mandatoryEvidence: [{ id: 'policy', sha256: null }],
    relatedQuestions: ['one', 'two', 'three', 'four']
  });
  assert.equal(blocked.status, 'needs_input');
  assert.equal(blocked.questions.length, 3);
  const ready = buildFosInterpretationCard({
    interpretation: 'Use feature workflow', mandatoryEvidence: [{ id: 'policy', sha256: sha('a') }],
    defaults: [{ id: 'workflow', value: 'feature' }]
  });
  assert.equal(ready.defaults[0].authority, 'suggestion-only');
  assert.equal(ready.grantsApproval, false);
});

test('FOS:AC-042 template prefill preserves provenance and missing required input', () => {
  const features = { 'template-prefill': true };
  const result = prefillFosTemplate([
    { id: 'repository', required: true }, { id: 'risk', required: true }
  ], {
    repository: { value: 'payments', classification: 'observed', provenance: { source: 'authority', version: '1', sha256: sha('a') } }
  }, { features });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.fields.repository.classification, 'observed');
  assert.equal(result.fields.risk.classification, 'needs_input');
  assert.throws(() => prefillFosTemplate([{ id: 'x', required: true }], {
    x: { value: 'invented', classification: 'historical', provenance: null }
  }, { features }), (error) => error.code === 'FOS_TEMPLATE_PROVENANCE_INVALID');
});

test('FOS:AC-040 documentation preauthorization is bounded and only a bound kernel result grants it', async () => {
  const features = { 'policy-preauthorization': true };
  const policy = { id: 'docs-v1', approved: true, policySha256: sha('a'), epoch: 4, paths: ['docs/'], actors: ['user:1'] };
  const candidate = { baseSha256: sha('b'), candidateSha256: sha('c'), changes: [{ oldPath: 'docs/a.md', newPath: 'docs/a.md', mode: '100644' }] };
  const accepted = await requestFosPreauthorization({
    candidate, policy, actor: { principalId: 'user:1' }, features,
    kernelAuthorize: async (request) => ({
      disposition: 'pre-authorized', policySha256: request.policySha256,
      candidateSha256: request.candidateSha256, actorPrincipalId: request.actorPrincipalId
    })
  });
  assert.equal(accepted.disposition, 'pre-authorized');
  assert.equal(accepted.humanReviewer, null);
  const unsafe = await requestFosPreauthorization({
    candidate: { ...candidate, changes: [{ newPath: 'src/app.js', mode: '100644' }] },
    policy, actor: { principalId: 'user:1' }, features,
    kernelAuthorize: async () => assert.fail('kernel must not be called')
  });
  assert.equal(unsafe.disposition, 'ordinary-review');
});

test('FOS:AC-041 approval requests reject replay, staleness and aliases before kernel acceptance', async () => {
  const request = createFosApprovalRequest({
    operationId: 'phase-approve', generation: 2, actorPrincipalId: 'user:author',
    targetAuthoritySha256: sha('a'), baseSha256: sha('b'), candidateSha256: sha('c'),
    evidenceSha256: sha('d'), policySha256: sha('e'), policyEpoch: 9,
    recipients: ['group:reviewers'], expiresAt: '2030-01-01T00:00:00.000Z'
  }, { features: { 'approval-routing': true }, now: new Date('2029-01-01') });
  assert.equal(request.grantsAuthority, false);
  await assert.rejects(() => acceptFosApprovalRequest(request, {
    challenge: request.challenge, principalId: 'display name'
  }, { candidateSha256: sha('c'), policySha256: sha('e'), policyEpoch: 9 }, async () => ({}), {
    now: new Date('2029-01-01')
  }), (error) => error.code === 'NOT_AUTHORIZED');
  await assert.rejects(() => acceptFosApprovalRequest(request, {
    challenge: request.challenge, principalId: 'group:reviewers'
  }, { candidateSha256: sha('c'), policySha256: sha('e'), policyEpoch: 9 }, async () => ({}), {
    now: new Date('2029-01-01'), replayed: true
  }), (error) => error.code === 'FOS_APPROVAL_REPLAYED');
});

test('FOS:AC-043 PR checks separate advisory evidence from unavailable enforced authority', () => {
  const features = { 'pr-check-adoption': true };
  const advisory = evaluateFosPrCheckAdoption({ mode: 'advisory', repositoryAuthorized: true, scope: ['tests'], gaps: ['identity'] }, { features });
  assert.equal(advisory.authoritative, false);
  assert.equal(advisory.mayMerge, false);
  const enforced = evaluateFosPrCheckAdoption({ mode: 'enforced', repositoryAuthorized: true }, { features });
  assert.equal(enforced.status, 'unavailable');
  assert.equal(enforced.code, 'TRUST_REQUIRED');
});

test('FOS:AC-044 every specified failure class has a non-executing registered remedy', () => {
  assert.equal(Object.keys(FOS_FAILURE_GUIDANCE).length, 17);
  for (const code of Object.keys(FOS_FAILURE_GUIDANCE)) {
    const guidance = fosFailureGuidance(code);
    assert.match(guidance.command, /^singularity-flow /);
    assert.equal(guidance.executesAutomatically, false);
  }
});
