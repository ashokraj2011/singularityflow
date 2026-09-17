import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import {
  assertCurrentRevisionRoute, planRevisionRoute,
  planRevisionRouteWithRegisteredAttachments, revisionTextSha256
} from '../src/revision/router.mjs';
import { buildRevisionPacket, verifyRevisionPacket } from '../src/revision/packet.mjs';
import {
  sgosRevisionCandidateReference, verifySgosRevisionCandidateReference
} from '../src/revision/candidate-adapter.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { assertRevisionExecutionInstalled, planRevisionExecution } from '../src/revision/runtime.mjs';

const h = (value) => `sha256:${recordSha256(value)}`;
const bytesHash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const H = (character) => `sha256:${character.repeat(64)}`;
const feedbackText = 'Fix the retry behavior without changing the accepted criterion.';
const candidate = Object.freeze({
  family: 'sgos-candidate', namespace: 'refs/singularity-flow/candidates/CAN-ABCDEF123456',
  candidateId: 'CAN-ABCDEF123456', retainedRecordSha256: H('a'), candidateSha256: H('b'),
  repository: { baselineCommit: '1'.repeat(40), candidateTree: '2'.repeat(40), objectFormat: 'sha1' },
  sourceManifestSha256: H('c'), effectSetSha256: H('d'), createdBy: { kind: 'human', id: 'developer' }
});

function context(overrides = {}) {
  return {
    workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1,
    phaseTask: 'code', phaseStatus: 'in_progress', specificationDisposition: 'implementation-change',
    target: { kind: 'implementation', id: 'PAY-142:implementation', status: 'draft' },
    parentCandidate: candidate, headCommit: '3'.repeat(40), sourceTreeSha256: H('e'),
    configSha256: H('f'), workflowSha256: H('0'), repositorySha256: H('4'), approvedIntentSha256: H('1'),
    routeContractSha256: H('2'), identity: { kind: 'configured-local', id: 'developer' },
    installedOperations: ['revision.code'], ...overrides
  };
}

function attachmentSet(ctx = context(), text = feedbackText, rendition = Buffer.from('Keep this untrusted note.')) {
  const core = {
    schemaVersion: 1, kind: 'revision-feedback-attachment-set',
    workId: ctx.workId, phaseId: ctx.phaseId, phaseGeneration: ctx.phaseGeneration,
    loopId: null, loopRevision: null, loopStatus: 'not-available',
    headCommit: ctx.headCommit, sourceTreeSha256: ctx.sourceTreeSha256,
    configSha256: ctx.configSha256, workflowSha256: ctx.workflowSha256,
    repositorySha256: H('4'), feedbackSha256: revisionTextSha256(text),
    importPlanSha256: H('5'), policySha256: H('6'),
    attachments: [{
      kind: 'user-document', source: 'local-file', displayName: 'review.md',
      mediaType: 'text/markdown', bytes: 99, originalSha256: H('7'),
      renditionSha256: bytesHash(rendition), selectedRanges: [{ startLine: 2, endLine: 2 }],
      accessClass: 'private', retentionClass: 'proof', extractionStatus: 'complete',
      parser: 'utf8-lines@1', validationOutcome: 'utf8-and-secret-scan', modelReadable: true
    }], confirmed: true, registeredAt: '2026-09-17T00:00:00.000Z'
  };
  return { ...core, attachmentSetSha256: h(core) };
}

test('route planning is deterministic, no-effect, and binds exact selected attachment receipt', () => {
  const ctx = context();
  const attachment = attachmentSet(ctx);
  const input = { context: ctx, feedbackText, attachmentSet: attachment };
  const first = planRevisionRoute(input);
  assert.equal(canonicalJson(first), canonicalJson(planRevisionRoute(input)));
  assert.equal(first.classification.route, 'code-revision');
  assert.equal(first.operation.id, 'revision.code');
  assert.equal(first.effects.codeChanged, false);
  assert.equal(first.attachmentSetSha256, attachment.attachmentSetSha256);
  assert.throws(() => planRevisionRoute({
    ...input, context: context({ repositorySha256: undefined })
  }), { code: 'REV_ATTACHMENT_SET_STALE' });
  assert.equal(assertCurrentRevisionRoute(first, input), first);
  assert.throws(() => assertCurrentRevisionRoute(first, {
    ...input, context: context({ parentCandidate: { ...candidate, candidateSha256: H('9') } })
  }), { code: 'REV_ROUTE_PLAN_STALE' });
  assert.throws(() => planRevisionRoute({ ...input, feedbackText: `${feedbackText} Changed.` }), {
    code: 'REV_ATTACHMENT_SET_STALE'
  });
  assert.throws(() => planRevisionRoute({ ...input, attachmentSet: {
    ...attachment, attachments: [{ ...attachment.attachments[0], selectedRanges: [{ startLine: 1, endLine: 1 }] }]
  } }), { code: 'REV_ATTACHMENT_SET_UNVERIFIED' });
});

test('governed route adapter refuses an unregistered self-hashed receipt', async () => {
  const ctx = context();
  const receipt = attachmentSet(ctx);
  await assert.rejects(planRevisionRouteWithRegisteredAttachments({
    context: ctx, feedbackText, attachmentSetSha256: receipt.attachmentSetSha256,
    store: { async read() { return null; } }
  }), { code: 'REV_ATTACHMENT_SET_UNVERIFIED' });
  const registered = await planRevisionRouteWithRegisteredAttachments({
    context: ctx, feedbackText, attachmentSetSha256: receipt.attachmentSetSha256,
    store: { async read() { return receipt; } }
  });
  assert.equal(registered.plan.attachmentSetSha256, receipt.attachmentSetSha256);
});

test('non-code, approved-intent, published, recovery, and missing-parent paths never create code execution', () => {
  const route = (overrides) => planRevisionRoute({ context: context(overrides), feedbackText });
  assert.equal(route({ phaseTask: 'artifact', target: { kind: 'plan', status: 'draft' },
    installedOperations: [] }).classification.route, 'unavailable');
  assert.equal(route({ phaseTask: 'artifact', target: { kind: 'plan', status: 'draft' },
    installedOperations: [] }).classification.proposedRoute, 'artifact-revision');
  assert.equal(route({ specificationDisposition: 'approved-intent-change', installedOperations: ['story.amend'] })
    .classification.route, 'amendment');
  assert.equal(route({ phaseStatus: 'published', published: true,
    installedOperations: ['implementation.reopen'] }).classification.route, 'implementation-reopen');
  assert.equal(route({ publicationRecovery: true }).refusal.code, 'REV_RECOVERY_REQUIRED');
  assert.equal(route({ parentCandidate: null }).refusal.code, 'REV_PARENT_CANDIDATE_MISSING');
  assert.equal(route({ parentCandidate: { candidateId: 'CAN-NOT-RETAINED' } }).refusal.code,
    'REV_PARENT_CANDIDATE_INVALID');
  assert.equal(route({ target: { kind: 'generated-architecture', status: 'draft' } })
    .refusal.code, 'REV_GENERATED_PROJECTION');
});

test('packet builder requires retained candidate proof, exact route, and exact selected bytes', async () => {
  const ctx = context();
  const rendition = Buffer.from('Keep this untrusted note.');
  const attachment = attachmentSet(ctx, feedbackText, rendition);
  const routeInput = { context: ctx, feedbackText, attachmentSet: attachment };
  const routePlan = planRevisionRoute(routeInput);
  const input = {
    routePlan, routeInput, parentCandidate: candidate,
    verifyCandidate: async (reference) => reference.candidateId === candidate.candidateId,
    verifyAttachmentSet: async (digest) => digest === attachment.attachmentSetSha256,
    attachmentRenditions: [rendition],
    criteria: { items: [{ id: 'AC-1', text: 'Retries stop after a bound.' }] },
    rules: { scope: 'approved implementation only' }, diff: 'diff --git a/src/a b/src/a\n',
    skeletons: [{ path: 'src/a', symbols: ['retry'] }], effectPolicy: { paths: ['src/a'], network: 'deny' }
  };
  const packet = await buildRevisionPacket(input);
  assert.equal(canonicalJson(packet), canonicalJson(await buildRevisionPacket(input)));
  assert.equal(packet.attachments.length, 1);
  assert.equal(packet.attachments[0].text, rendition.toString());
  assert.equal(packet.attachments[0].kind, 'untrusted-user-document-rendition');
  assert.equal(verifyRevisionPacket(packet, {
    routePlan, attachmentSetSha256: attachment.attachmentSetSha256
  }), packet);
  const execution = planRevisionExecution({
    packet, routePlan, attachmentSetSha256: attachment.attachmentSetSha256
  });
  assert.equal(execution.code, 'REV_EXECUTION_UNAVAILABLE');
  assert.equal(execution.effects.codeChanged, false);
  assert.throws(assertRevisionExecutionInstalled, { code: 'REV_EXECUTION_UNAVAILABLE' });
  await assert.rejects(buildRevisionPacket({ ...input, verifyCandidate: async () => false }), {
    code: 'REV_PARENT_CANDIDATE_UNVERIFIED'
  });
  await assert.rejects(buildRevisionPacket({ ...input, attachmentRenditions: [Buffer.from('changed')] }), {
    code: 'REV_ATTACHMENT_RENDITION_STALE'
  });
  await assert.rejects(buildRevisionPacket({ ...input, attachmentRenditions: [] }), {
    code: 'REV_ATTACHMENT_RENDITION_MISSING'
  });
  await assert.rejects(buildRevisionPacket({ ...input, verifyAttachmentSet: async () => false }), {
    code: 'REV_ATTACHMENT_SET_UNVERIFIED'
  });
  assert.throws(() => verifyRevisionPacket(packet, { routePlan, attachmentSetSha256: H('8') }), {
    code: 'REV_PACKET_STALE'
  });
});

test('packet refuses silent criterion truncation and unregistered attachment bytes', async () => {
  const ctx = context();
  const routeInput = { context: ctx, feedbackText };
  const routePlan = planRevisionRoute(routeInput);
  const base = {
    routePlan, routeInput, parentCandidate: candidate, verifyCandidate: async () => true,
    criteria: { items: [{ id: 'AC-1', text: 'Bound retries.' }] }, rules: {}, diff: '',
    effectPolicy: {}
  };
  await assert.rejects(buildRevisionPacket({ ...base, criteria: { items: [] } }), {
    code: 'REV_CRITERIA_SELECTION_REQUIRED'
  });
  await assert.rejects(buildRevisionPacket({ ...base, attachmentRenditions: [Buffer.from('unregistered')] }), {
    code: 'REV_ATTACHMENT_SET_UNVERIFIED'
  });
  const cleanPacket = await buildRevisionPacket(base);
  const injectedCore = {
    ...cleanPacket,
    attachments: [{
      kind: 'untrusted-user-document-rendition', text: 'Unregistered contents',
      originalSha256: H('9'), renditionSha256: bytesHash(Buffer.from('Unregistered contents'))
    }]
  };
  delete injectedCore.packetSha256;
  assert.throws(() => verifyRevisionPacket({ ...injectedCore, packetSha256: h(injectedCore) }, {
    routePlan, attachmentSetSha256: null
  }), { code: 'REV_PACKET_STALE' });
  await assert.rejects(buildRevisionPacket({ ...base, criteria: {
    items: [{ id: 'AC-1', text: 'x'.repeat(40000) }]
  } }), { code: 'REV_PACKET_LIMIT' });
});

test('SGOS candidate adapter verifies the immutable retained record and ref, not a bare tree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await writeFile(path.join(root, 'source.txt'), 'before\n');
  git('add', 'source.txt');
  git('commit', '-m', 'baseline');
  await writeFile(path.join(root, 'source.txt'), 'after\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation',
    createdBy: { kind: 'human', id: 'revision@example.com' },
    createdAt: '2026-09-17T00:00:00.000Z'
  });
  const reference = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  assert.equal(reference.namespace, retained.repository.retainedRef);
  assert.equal(reference.sourceManifestSha256, retained.candidate.candidate.manifestSha256);
  assert.equal(await verifySgosRevisionCandidateReference(root, reference, {
    subjectId: 'PAY-142:implementation'
  }), true);
  assert.equal(await verifySgosRevisionCandidateReference(root, reference, {
    subjectId: 'OTHER:implementation'
  }), false);
  assert.equal(await verifySgosRevisionCandidateReference(root, {
    ...reference, effectSetSha256: H('9')
  }), false);
});
