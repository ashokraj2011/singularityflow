import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildRevisionAttempt, buildRevisionAttemptRestoration, buildRevisionCriteriaBinding,
  buildRevisionExplanation, buildRevisionFeedback, buildRevisionPublicationSummary,
  buildRevisionRecoveryJournal, buildRevisionSpecificationDisposition,
  REV_DURABLE_RECORD_FAMILIES, validateRevisionRecord
} from '../src/revision/contracts.mjs';
import {
  readRevisionRecord, revisionRecordPath, writeRevisionRecord
} from '../src/revision/store.mjs';
import {
  currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot
} from '../src/schema-migrations.mjs';
import { recordSha256 } from '../src/records.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = '2026-09-17T00:00:00.000Z';
const subject = Object.freeze({ workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 });
const producer = Object.freeze({
  id: 'revision-kernel', version: '0.9.0', implementationSha256: H('a')
});
const parentCandidate = Object.freeze({ candidateId: 'CAN-PARENT-100', candidateSha256: H('b') });
const resultCandidate = Object.freeze({
  candidateId: 'CAN-RESULT-103', candidateSha256: H('c'), candidateTree: 'd'.repeat(40),
  sourceManifestSha256: H('d')
});

function feedbackSha256(text) {
  return `sha256:${createHash('sha256').update(Buffer.from(text)).digest('hex')}`;
}

function records() {
  const feedbackText = 'Handle the no-cache path using the shared parser.';
  const feedback = buildRevisionFeedback({
    feedbackId: 'REVFB-PAY-142-003', subject,
    author: { kind: 'configured-local', id: 'developer@example.com', name: 'Developer' },
    text: feedbackText, bytes: Buffer.byteLength(feedbackText),
    feedbackSha256: feedbackSha256(feedbackText), capturedAt: NOW, producer
  });
  const binding = buildRevisionCriteriaBinding({
    subject, feedbackSha256: feedback.feedbackSha256, mode: 'explicit',
    criteria: [{ clauseId: 'PAY-142:AC-002', clauseSha256: H('e') }],
    binder: { id: 'revision-criteria-binder', version: 1, implementationSha256: H('f') },
    producer
  });
  const disposition = buildRevisionSpecificationDisposition({
    subject, feedbackSha256: feedback.feedbackSha256, bindingSha256: binding.bindingSha256,
    result: 'implementation-change',
    predicateResults: [{ predicateId: 'structured-value-conflict', result: 'not-applicable' }],
    humanResolution: null, producer
  });
  const restoration = buildRevisionAttemptRestoration({
    subject, attemptId: 'REVATT-003-01', parentCandidate,
    preimageSha256: H('1'), postimageSha256: H('1'),
    processTreeQuiesced: true, filesystemRestored: true, externalEffectsAbsent: true,
    status: 'restored', reasonCode: null, restoredAt: NOW, producer
  });
  const attempt = buildRevisionAttempt({
    attemptId: 'REVATT-003-01', intervalId: 'REV-PAY-142-IMPLEMENT-003', sequence: 1,
    subject, parentCandidate,
    provider: { id: 'copilot-acp', version: '1', implementationSha256: H('2') },
    status: 'refused-restored', reasonCode: 'REV_SCOPE_VIOLATION', effectSetSha256: H('3'),
    resultCandidate: null, restorationReceiptSha256: restoration.restorationReceiptSha256,
    startedAt: NOW, endedAt: '2026-09-17T00:01:00.000Z', producer
  });
  const summary = buildRevisionPublicationSummary({
    subject,
    revisionLoop: {
      intervalCount: 3, initialCandidateId: parentCandidate.candidateId,
      publishedCandidateId: resultCandidate.candidateId, loopSha256: H('4'),
      intervalSetSha256: H('5'), correctedRefusalCount: 1, unresolvedRefusalCount: 0
    },
    publishedCandidate: resultCandidate,
    chain: {
      path: 'singularity/work-items/PAY-142/evidence/revisions/implementation/chain',
      manifestSha256: H('6'), chainSha256: H('7')
    },
    publishedAt: '2026-09-17T00:02:00.000Z', producer
  });
  const recovery = buildRevisionRecoveryJournal({
    journalId: 'REVREC-PAY-142-1', subject, loopId: 'REV-LOOP-PAY-142', state: 'resolved',
    reasonCode: null, rescueContentSha256: null,
    actions: [{ sequence: 1, kind: 'restore', status: 'succeeded', receiptSha256: restoration.restorationReceiptSha256 }],
    createdAt: NOW, updatedAt: '2026-09-17T00:01:00.000Z', producer
  });
  const explanation = buildRevisionExplanation({
    subject, loopSha256: H('4'), intervalId: 'REV-PAY-142-IMPLEMENT-003',
    feedbackSha256: feedback.feedbackSha256, parentCandidate,
    resultCandidate: { candidateId: resultCandidate.candidateId, candidateSha256: resultCandidate.candidateSha256 },
    attemptCount: 2,
    refusals: [{
      attemptId: attempt.attemptId, code: attempt.reasonCode, resourcesSha256: H('8'), corrected: true
    }],
    precheckSha256: H('9'), authority: 'deterministic-records', producer
  });
  return { feedback, binding, disposition, restoration, attempt, summary, recovery, explanation };
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('REV semantic record builders close, stamp, and self-hash every durable family', () => {
  const built = records();
  for (const record of Object.values(built)) {
    assert.equal(record.schemaVersion, currentSchemaVersion(record.kind));
    assert.deepEqual(validateRevisionRecord(record.kind, record), record);
    const hashField = Object.keys(record).find((key) => /(?:Sha256|sha256)$/.test(key)
      && ['recordSha256', 'bindingSha256', 'dispositionSha256', 'attemptSha256',
        'restorationReceiptSha256', 'summarySha256', 'journalSha256', 'explanationSha256'].includes(key));
    assert.ok(hashField, record.kind);
  }
  assert.deepEqual(Object.keys(built), [
    'feedback', 'binding', 'disposition', 'restoration', 'attempt', 'summary', 'recovery', 'explanation'
  ]);
});

test('REV record readers reject tampering, unknown fields, unsafe feedback, and false restoration claims', () => {
  const built = records();
  assert.throws(() => validateRevisionRecord('revision-feedback', {
    ...built.feedback, text: 'changed'
  }), { code: 'REV_RECORD_INVALID' });
  assert.throws(() => validateRevisionRecord('revision-feedback', {
    ...built.feedback, injectedAuthority: true
  }), { code: 'REV_RECORD_INVALID' });
  assert.throws(() => buildRevisionFeedback({
    feedbackId: 'REVFB-PAY-142-004', subject,
    author: { kind: 'configured-local', id: 'developer@example.com', name: 'Developer' },
    text: 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890', bytes: 44, // sflow-allow-secret: invented token asserting REV feedback refusal
    feedbackSha256: feedbackSha256('token=ghp_abcdefghijklmnopqrstuvwxyz1234567890'), // sflow-allow-secret: repeated invented token binds the refused bytes
    capturedAt: NOW, producer
  }), { code: 'REV_RECORD_INVALID' });
  assert.throws(() => buildRevisionAttemptRestoration({
    subject, attemptId: 'REVATT-003-02', parentCandidate,
    preimageSha256: H('1'), postimageSha256: H('2'),
    processTreeQuiesced: true, filesystemRestored: true, externalEffectsAbsent: true,
    status: 'restored', reasonCode: null, restoredAt: NOW, producer
  }), { code: 'REV_RECORD_INVALID' });
  assert.throws(() => buildRevisionAttempt({
    attemptId: 'REVATT-003-02', intervalId: 'REV-PAY-142-IMPLEMENT-003', sequence: 2,
    subject, parentCandidate,
    provider: { id: 'copilot-acp', version: '1', implementationSha256: H('2') },
    status: 'candidate-frozen', reasonCode: null, effectSetSha256: null,
    resultCandidate, restorationReceiptSha256: null, startedAt: NOW, endedAt: NOW, producer
  }), { code: 'REV_RECORD_INVALID' });
});

test('REV durable schemas are packaged closed contracts registered as frozen immutable identities', async () => {
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  for (const family of REV_DURABLE_RECORD_FAMILIES) {
    const descriptor = registry.get(family);
    assert.equal(descriptor?.currentVersion, 1, family);
    assert.equal(descriptor?.immutable, true, family);
    assert.equal(descriptor?.migrationPolicy, 'frozen-identity', family);
    const schema = JSON.parse(await readFile(
      new URL(`../schemas/${family}.schema.json`, import.meta.url), 'utf8'
    ));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', family);
    assert.equal(schema.additionalProperties, false, family);
    assert.equal(schema.properties.schemaVersion.const, 1, family);
    assert.equal(schema.properties.kind.const, family, family);
    for (const required of schema.required) assert.ok(schema.properties[required], `${family}.${required}`);
  }
});

test('schema census paths recognize private and shared REV records plus local loop state', () => {
  const hex = 'a'.repeat(64);
  for (const family of REV_DURABLE_RECORD_FAMILIES) {
    const privatePath = `$git/revisions/PAY-142/implementation/1/records/${family}/${hex}.json`;
    assert.equal(familyForStoredPath(privatePath)?.id, family, privatePath);
    const sharedPath = `singularity/work-items/PAY-142/evidence/revisions/implementation/${hex}/records/${family}/${hex}.json`;
    if (family === 'revision-recovery-journal') {
      assert.equal(familyForStoredPath(sharedPath), null, sharedPath);
    } else assert.equal(familyForStoredPath(sharedPath)?.id, family, sharedPath);
  }
  assert.equal(familyForStoredPath(`$git/revisions/${hex}/journal/0000000000.json`)?.id,
    'revision-loop-journal-entry');
  assert.equal(familyForStoredPath(`$git/revisions/${hex}/interactive/confirmations/${hex}.json`)?.id,
    'revision-interactive-start-pin');
  assert.equal(familyForStoredPath(`$git/revisions/${hex}/interactive/confirmation-results/${hex}.json`)?.id,
    'revision-interactive-confirmation-result');
  assert.equal(familyForStoredPath(`$git/revisions/${hex}/interactive/state.json`)?.id,
    'revision-interactive-state');
  assert.equal(familyForStoredPath(`$git/revisions/${hex}/interactive/payloads/${hex}.json`)?.id,
    'revision-interactive-payload');
  assert.equal(familyForStoredPath(
    `$git/revision-feedback-attachments/PAY-142/implementation/0001/plans/${hex}.json`
  )?.id, 'revision-feedback-attachment-import-plan');
  assert.equal(familyForStoredPath(
    `$git/revision-feedback-attachments/PAY-142/implementation/0001/revocation-plans/${hex}.json`
  )?.id, 'revision-feedback-attachment-revocation-plan');
  assert.equal(familyForStoredPath(
    `$git/revision-feedback-attachments/PAY-142/implementation/0001/revocations/${hex}.json`
  )?.id, 'revision-feedback-attachment-revocation');
  assert.equal(familyForStoredPath(
    `$git/revision-feedback-attachments/PAY-142/implementation/0001/requests/${hex}.json`
  )?.id, 'revision-feedback-attachment-store-entry');
  assert.equal(familyForStoredPath(
    `$git/revision-publication-attestations/${hex}.prepared.json`
  )?.id, 'revision-publication-prepared');
  assert.equal(familyForStoredPath(
    `$git/revision-publication-attestations/${hex}.committed.json`
  )?.id, 'revision-publication-commit-retained');
});

test('REV record store is immutable and separates private recovery from shared evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-records-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  const built = records();

  const first = await writeRevisionRecord(root, built.feedback);
  assert.equal(first.created, true);
  assert.equal((await writeRevisionRecord(root, built.feedback)).created, false);
  assert.deepEqual(await readRevisionRecord(root, built.feedback.kind, built.feedback.recordSha256, {
    subject
  }), built.feedback);
  for (const record of [built.binding, built.disposition, built.restoration]) {
    const written = await writeRevisionRecord(root, record);
    const hashField = record.kind === 'revision-criteria-binding' ? 'bindingSha256'
      : record.kind === 'revision-specification-disposition' ? 'dispositionSha256'
        : 'restorationReceiptSha256';
    assert.equal(written.created, true, record.kind);
    assert.deepEqual(await readRevisionRecord(root, record.kind, record[hashField], { subject }),
      record);
  }
  assert.match(first.path, /\.git[/\\]singularity-flow[/\\]revisions/);

  const shared = await writeRevisionRecord(root, built.summary, {
    storage: 'shared', loopSha256: built.summary.revisionLoop.loopSha256
  });
  assert.equal(shared.created, true);
  assert.deepEqual(await readRevisionRecord(root, built.summary.kind, built.summary.summarySha256, {
    subject, storage: 'shared', loopSha256: built.summary.revisionLoop.loopSha256
  }), built.summary);
  assert.match(shared.path, /singularity[/\\]work-items[/\\]PAY-142[/\\]evidence[/\\]revisions/);

  await assert.rejects(writeRevisionRecord(root, built.recovery, {
    storage: 'shared', loopSha256: H('4')
  }), { code: 'REV_RECORD_STORE_PRIVATE_ONLY' });

  await writeFile(first.path, '{}\n');
  await assert.rejects(readRevisionRecord(root, built.feedback.kind, built.feedback.recordSha256, {
    subject
  }), { code: 'REV_RECORD_INVALID' });
});

test('shared REV records reject a symlink at the final content-addressed target', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-record-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  const summary = records().summary;
  const privateRecord = await writeRevisionRecord(root, summary);
  const target = revisionRecordPath(root, summary, {
    storage: 'shared', loopSha256: summary.revisionLoop.loopSha256
  });
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(privateRecord.path, target);

  await assert.rejects(writeRevisionRecord(root, summary, {
    storage: 'shared', loopSha256: summary.revisionLoop.loopSha256
  }), { code: 'REV_RECORD_STORE_UNSAFE' });
  await assert.rejects(readRevisionRecord(root, summary.kind, summary.summarySha256, {
    subject, storage: 'shared', loopSha256: summary.revisionLoop.loopSha256
  }), { code: 'REV_RECORD_STORE_UNSAFE' });
  assert.equal((await lstat(target)).isSymbolicLink(), true,
    'the unsafe target is rejected rather than followed or replaced');
});

test('revision-packet durable validator accepts the existing packet shape and rejects injected fields', () => {
  const rules = { task: 'code', writeScope: 'source-and-artifact', protectedPaths: [] };
  const effectPolicy = {
    writeScope: 'source-and-artifact', maximumChangedFiles: 32,
    protectedPaths: [], protectedPathsSha256: H('b'),
    applicationPathPolicySha256: H('c'), externalEffectsAllowed: false
  };
  const core = {
    schemaVersion: 1, kind: 'revision-packet', subject, routePlanSha256: H('1'),
    producer,
    parentCandidate: { candidateId: parentCandidate.candidateId, candidateSha256: H('2'), candidateRefSha256: H('3') },
    feedback: {
      feedbackId: 'REVFB-ABCDEF123456', feedbackRecordSha256: H('3'),
      feedbackSha256: `sha256:${createHash('sha256').update('Bounded feedback.').digest('hex')}`,
      text: 'Bounded feedback.'
    }, attachments: [],
    criteria: { items: [{ id: 'AC-1', text: 'A bounded criterion.' }] },
    criteriaBindingSha256: H('5'), specificationDispositionSha256: H('6'),
    rules, rulesSha256: `sha256:${recordSha256(rules)}`, diff: '',
    diffSha256: `sha256:${createHash('sha256').update('').digest('hex')}`, skeletons: [],
    skeletonSetSha256: `sha256:${recordSha256([])}`, effectPolicy,
    effectPolicySha256: `sha256:${recordSha256(effectPolicy)}`, expansions: [],
    budgets: {
      maximumInputBytes: 131072, maximumOutputBytes: 1048576,
      maximumToolCalls: 50, maximumSubattempts: 3
    }
  };
  const packet = { ...core, packetSha256: `sha256:${recordSha256(core)}` };
  assert.deepEqual(validateRevisionRecord('revision-packet', packet), packet);
  assert.throws(() => validateRevisionRecord('revision-packet', { ...packet, execute: true }), {
    code: 'REV_RECORD_INVALID'
  });
});
