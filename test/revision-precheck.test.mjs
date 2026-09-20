import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import {
  assertCurrentRevisionPrecheck, computeRevisionPrecheck, revisionHeadSnapshotSha256
} from '../src/revision/precheck.mjs';

const hash = (value) => `sha256:${recordSha256(value)}`;
const textHash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const subject = Object.freeze({ workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 });
const producer = Object.freeze({
  id: 'revision-test', version: '1', implementationSha256: digest('d')
});
const checks = [
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
];

function fixture() {
  const candidateReference = {
    family: 'sgos-candidate',
    namespace: 'refs/singularity-flow/candidates/CAN-RESULT1',
    candidateId: 'CAN-RESULT1',
    retainedRecordSha256: digest('a'),
    candidateSha256: digest('b'),
    repository: {
      baselineCommit: 'a'.repeat(40),
      candidateTree: 'b'.repeat(40),
      objectFormat: 'sha1'
    },
    sourceManifestSha256: digest('c'),
    effectSetSha256: digest('d'),
    createdBy: { kind: 'agent', id: 'registered-agent' }
  };
  const hunkClaimSet = {
    schemaVersion: 1, kind: 'revision-hunk-claim-set',
    subject, producer,
    parentCandidateId: 'CAN-PARENT1', resultCandidateId: 'CAN-RESULT1',
    claims: [{
      hunkId: 'HUNK-001', cause: { kind: 'criterion', id: 'PAY-142:AC-001' }, status: 'claimed'
    }],
    unexplained: []
  };
  hunkClaimSet.claimSetSha256 = hash(hunkClaimSet);
  return {
    subject,
    producer,
    candidateReference,
    head: {
      candidateId: candidateReference.candidateId,
      candidateSha256: candidateReference.candidateSha256,
      candidateRefSha256: hash(candidateReference),
      candidateTree: candidateReference.repository.candidateTree,
      headRevision: 3,
      headTransitionSha256: digest('e'),
      phaseGeneration: 1,
      workflowSha256: digest('f'),
      configSha256: digest('1'),
      proofProfileSha256: digest('2'),
      editorDiskIndexBaselineSha256: digest('3')
    },
    bindings: {
      criteriaBindingSha256: digest('4'),
      specificationDispositionSha256: digest('5'),
      hunkClaimSetSha256: hunkClaimSet.claimSetSha256
    },
    hunkClaimSet,
    worktree: {
      savedTree: candidateReference.repository.candidateTree,
      editorDiskIndexBaselineSha256: digest('3'),
      changedPaths: []
    },
    validations: Object.fromEntries(checks.map((name) => [name, {
      status: 'pass', evidenceSha256: textHash(name)
    }])),
    criteria: [{
      clauseId: 'PAY-142:AC-001', applicable: true, claimedChange: true,
      witnessReady: false, availability: 'available', contradicted: false,
      testBodySha256: null, environmentSha256: null, witnesses: []
    }, {
      clauseId: 'PAY-142:AC-002', applicable: true, claimedChange: false,
      witnessReady: true, availability: 'available', contradicted: false,
      testBodySha256: digest('7'), environmentSha256: digest('8'), witnesses: []
    }],
    refusalSummary: { count: 1, corrected: 1, unresolved: 0 },
    proofProfile: 'standard'
  };
}

function witnessFor(input, overrides = {}) {
  return {
    receiptSha256: digest('6'),
    candidateId: input.candidateReference.candidateId,
    candidateRefSha256: hash(input.candidateReference),
    candidateTree: input.candidateReference.repository.candidateTree,
    proofProfileSha256: input.head.proofProfileSha256,
    criteriaBindingSha256: input.bindings.criteriaBindingSha256,
    testBodySha256: digest('7'),
    environmentSha256: digest('8'),
    status: 'passed', registeredAdapter: true, policyPermitsReuse: true,
    independent: false, signed: false,
    ...overrides
  };
}

test('pure precheck is deterministic, head-bound, and reports readiness rather than verification', () => {
  const input = fixture();
  const before = canonicalJson(input);
  const first = computeRevisionPrecheck(input);
  const second = computeRevisionPrecheck(structuredClone(input));
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalJson(input), before);
  assert.equal(first.headSnapshotSha256,
    revisionHeadSnapshotSha256(input.candidateReference, input.head));
  assert.equal(first.candidateRefSha256, hash(input.candidateReference));
  assert.equal(first.hunkClaimSetSha256, input.hunkClaimSet.claimSetSha256);
  assert.deepEqual(first.criteria.map((row) => row.readiness), ['addressed', 'witness-ready']);
  assert.equal(first.publicationEligible, true);
  assert.equal(first.precheckSha256, hash(Object.fromEntries(
    Object.entries(first).filter(([key]) => key !== 'precheckSha256')
  )));
  assert.equal(canonicalJson(first).includes('"verified"'), false);
  assert.equal(assertCurrentRevisionPrecheck(first, input).precheckSha256, first.precheckSha256);
});

test('a prior-candidate witness is stale and never rendered current-pass', () => {
  const input = fixture();
  input.criteria[1].witnesses.push(witnessFor(input, {
    candidateId: 'CAN-PARENT1', candidateRefSha256: digest('9')
  }));
  const receipt = computeRevisionPrecheck(input);
  assert.equal(receipt.criteria[1].readiness, 'witness-ready');
  assert.equal(receipt.criteria[1].staleWitnessCount, 1);
  assert.equal(receipt.criteria[1].witnessCount, 0);
  assert.equal(receipt.criteria[1].executedAgainstCandidate, false);
});

test('exact current witness is reusable only with adapter and policy authority', () => {
  const input = fixture();
  input.criteria[1].witnesses.push(witnessFor(input));
  assert.equal(computeRevisionPrecheck(input).criteria[1].readiness, 'witness-passed-current');
  input.criteria[1].witnesses[0].registeredAdapter = false;
  assert.equal(computeRevisionPrecheck(input).criteria[1].readiness, 'witness-ready');
  input.criteria[1].witnesses[0].registeredAdapter = true;
  input.criteria[1].witnesses[0].policyPermitsReuse = false;
  assert.equal(computeRevisionPrecheck(input).criteria[1].readiness, 'witness-ready');
});

test('regulated profile requires independent signed witness', () => {
  const input = fixture();
  input.proofProfile = 'regulated';
  input.head.proofProfileSha256 = digest('a');
  input.criteria[1].witnesses.push(witnessFor(input));
  assert.equal(computeRevisionPrecheck(input).criteria[1].readiness, 'witness-ready');
  input.criteria[1].witnesses[0].independent = true;
  input.criteria[1].witnesses[0].signed = true;
  assert.equal(computeRevisionPrecheck(input).criteria[1].readiness, 'witness-passed-current');
});

test('an old receipt is stale after head revision, transition, policy, or claim set change', () => {
  const input = fixture();
  const receipt = computeRevisionPrecheck(input);
  for (const mutate of [
    (next) => { next.head.headRevision += 1; },
    (next) => { next.head.headTransitionSha256 = digest('a'); },
    (next) => { next.head.configSha256 = digest('b'); },
    (next) => { next.head.proofProfileSha256 = digest('c'); },
    (next) => { next.criteria[1].testBodySha256 = digest('d'); },
    (next) => { next.criteria[1].environmentSha256 = digest('e'); },
    (next) => {
      next.hunkClaimSet.unexplained.push('HUNK-002');
      next.hunkClaimSet.claimSetSha256 = hash(Object.fromEntries(
        Object.entries(next.hunkClaimSet).filter(([key]) => key !== 'claimSetSha256')
      ));
      next.bindings.hunkClaimSetSha256 = next.hunkClaimSet.claimSetSha256;
    }
  ]) {
    const next = structuredClone(input);
    mutate(next);
    assert.throws(() => assertCurrentRevisionPrecheck(receipt, next),
      (error) => error.code === 'REV_PRECHECK_STALE');
  }
});

test('candidate mismatch and changed editor baseline fail closed', () => {
  const input = fixture();
  input.head.candidateTree = 'f'.repeat(40);
  assert.throws(() => computeRevisionPrecheck(input),
    (error) => error.code === 'REV_PRECHECK_STALE');
  const next = fixture();
  next.worktree.editorDiskIndexBaselineSha256 = digest('f');
  assert.throws(() => computeRevisionPrecheck(next),
    (error) => error.code === 'REV_PRECHECK_STALE');
});

test('saved worktree drift refuses with exact changed paths and creates no capture', () => {
  const input = fixture();
  input.worktree.savedTree = 'f'.repeat(40);
  input.worktree.changedPaths = ['src/client.mjs'];
  assert.throws(() => computeRevisionPrecheck(input), (error) => {
    assert.equal(error.code, 'REV_MANUAL_DRIFT');
    assert.deepEqual(error.details.changedPaths, ['src/client.mjs']);
    return true;
  });
});

test('failed deterministic predicate and unresolved refusal make publication ineligible', () => {
  const input = fixture();
  input.validations.secretScan.status = 'fail';
  input.refusalSummary = { count: 1, corrected: 0, unresolved: 1 };
  const receipt = computeRevisionPrecheck(input);
  assert.equal(receipt.publicationEligible, false);
  assert.deepEqual(receipt.remainingObligations,
    ['deterministic-check:secretScan', 'unresolved-refusals']);
});

test('high assurance blocks unexplained hunks at precheck; standard lists them without claiming proof', () => {
  const input = fixture();
  input.hunkClaimSet.unexplained.push('HUNK-002');
  input.hunkClaimSet.claimSetSha256 = hash(Object.fromEntries(
    Object.entries(input.hunkClaimSet).filter(([key]) => key !== 'claimSetSha256')
  ));
  input.bindings.hunkClaimSetSha256 = input.hunkClaimSet.claimSetSha256;
  assert.equal(computeRevisionPrecheck(input).precheckPassed, true);
  assert.equal(computeRevisionPrecheck(input).publicationEligible, false);
  input.proofProfile = 'high-assurance';
  const receipt = computeRevisionPrecheck(input);
  assert.equal(receipt.publicationEligible, false);
  assert.deepEqual(receipt.remainingObligations, ['precheck:unexplained-hunks']);
});

test('unknown authority fields and forged hunk digest are rejected', () => {
  const input = fixture();
  input.loopSha256 = digest('e');
  assert.throws(() => computeRevisionPrecheck(input),
    (error) => error.code === 'REV_PRECHECK_INPUT');
  delete input.loopSha256;
  input.hunkClaimSet.claimSetSha256 = digest('e');
  assert.throws(() => computeRevisionPrecheck(input),
    (error) => error.code === 'REV_PRECHECK_INPUT');
});

test('precheck never invokes a model, project command, or writes a receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-precheck-pure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'marker');
  await writeFile(marker, 'unchanged');
  const before = await readFile(marker, 'utf8');
  for (let index = 0; index < 5; index += 1) computeRevisionPrecheck(fixture());
  assert.equal(await readFile(marker, 'utf8'), before);
  assert.deepEqual(await readdir(root), ['marker']);
});
