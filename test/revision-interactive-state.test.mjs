import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  readOrCreateRevisionStartPin, readRevisionInteractiveState,
  writeRevisionInteractiveState
} from '../src/revision/interactive-state.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const feedbackSha256 = (text) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

test('confirmed REV start pins feedback first and exact retries reuse its capture identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-start-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const subject = { workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 };
  const feedbackText = 'Fix the implementation without changing accepted behavior.';
  const expected = {
    startPlanSha256: H('1'), feedbackSha256: feedbackSha256(feedbackText), feedbackText,
    author: { kind: 'configured-local', id: 'developer@example.com', name: 'Developer' },
    privacyPolicySha256: H('4'),
    producer: { id: 'revision-kernel', version: '1', implementationSha256: H('3') },
    criteria: {
      mode: 'explicit',
      bound: [{ id: 'PAY-142:AC-001', clauseSha256: H('2') }],
      packet: [{ id: 'PAY-142:AC-001', clauseSha256: H('2') }]
    },
    disposition: { result: 'implementation-change', predicateId: 'implementation-correction-language', human: false }
  };
  const first = await readOrCreateRevisionStartPin(root, subject, expected);
  const replay = await readOrCreateRevisionStartPin(root, subject, expected);
  assert.deepEqual(replay, first);
  assert.equal(first.feedbackSha256, expected.feedbackSha256);
  assert.equal(first.feedbackText, feedbackText);
  await assert.rejects(readOrCreateRevisionStartPin(root, subject, {
    ...expected, feedbackText: `${feedbackText} changed`
  }), { code: 'REV_FEEDBACK_INVALID' });
});

test('REV start pin refuses secret-bearing feedback before durable storage', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-start-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  const feedbackText = 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890'; // sflow-allow-secret: invented token asserting start-pin refusal
  await assert.rejects(readOrCreateRevisionStartPin(root, {
    workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1
  }, {
    startPlanSha256: H('1'), feedbackSha256: feedbackSha256(feedbackText), feedbackText,
    author: { kind: 'configured-local', id: 'developer@example.com', name: 'Developer' },
    privacyPolicySha256: H('4'),
    producer: { id: 'revision-kernel', version: '1', implementationSha256: H('3') },
    criteria: { mode: 'unscoped', bound: [], packet: [] },
    disposition: { result: 'implementation-change', predicateId: 'explicit', human: true }
  }), { code: 'REV_FEEDBACK_SECRET' });
});

test('REV start pin rejects missing and unknown nested authority fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-start-shape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  const subject = { workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 };
  const feedbackText = 'Fix the implementation without changing accepted behavior.';
  const expected = {
    startPlanSha256: H('1'), feedbackSha256: feedbackSha256(feedbackText), feedbackText,
    author: { kind: 'configured-local', id: 'developer@example.com', name: 'Developer' },
    criteria: {
      mode: 'explicit',
      bound: [{ id: 'PAY-142:AC-001', clauseSha256: H('2') }],
      packet: [{ id: 'PAY-142:AC-001', clauseSha256: H('2') }]
    },
    disposition: {
      result: 'implementation-change',
      predicateId: 'implementation-correction-language',
      human: false
    },
    privacyPolicySha256: H('4'),
    producer: { id: 'revision-kernel', version: '1', implementationSha256: H('3') }
  };
  const invalid = [
    { ...expected, author: { ...expected.author, unknown: true } },
    { ...expected, author: { kind: expected.author.kind, id: expected.author.id } },
    { ...expected, criteria: { mode: expected.criteria.mode, bound: expected.criteria.bound } },
    { ...expected, criteria: { ...expected.criteria, unknown: true } },
    { ...expected, criteria: { ...expected.criteria,
      bound: [{ ...expected.criteria.bound[0], unknown: true }] } },
    { ...expected, disposition: {
      result: expected.disposition.result, predicateId: expected.disposition.predicateId
    } },
    { ...expected, disposition: { ...expected.disposition, unknown: true } },
    { ...expected, producer: {
      id: expected.producer.id, implementationSha256: expected.producer.implementationSha256
    } },
    { ...expected, producer: { ...expected.producer, unknown: true } }
  ];
  for (const authority of invalid) {
    await assert.rejects(readOrCreateRevisionStartPin(root, subject, authority), {
      code: 'REV_INTERACTIVE_STATE_INVALID'
    });
  }
});

test('REV interactive pointer makes abandonment crash recovery an explicit exact state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-abandon-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  const subject = { workId: 'PAY-142', phaseId: 'implementation', phaseGeneration: 1 };
  const created = await writeRevisionInteractiveState(root, {
    subject, status: 'awaiting-edit', loopId: 'REVLOOP-PAY-142', loopRevision: 0,
    startPlanSha256: H('1'), startPlanPayloadSha256: H('2'), startPinSha256: H('3'),
    contextSha256: H('4'), feedbackRecordSha256: H('5'),
    criteriaBindingSha256: H('6'), dispositionSha256: H('7'), packetSha256: H('8'),
    routePlanSha256: H('9'), parentCandidateId: 'CAN-PAY-142-BASE',
    resultCandidateId: null, capturePlanSha256: null, capturePayloadSha256: null,
    captureEffectSetSha256: null, recoveryCode: null, captureStartedAt: null,
    captureEndedAt: null, abandonPlanSha256: null, abandonPayloadSha256: null,
    precheckSha256: null, precheckInputSha256: null
  }, { expectedStateSha256: null });
  const abandoning = await writeRevisionInteractiveState(root, {
    ...created, status: 'abandoning', abandonPlanSha256: H('a'),
    abandonPayloadSha256: H('b'), updatedAt: new Date().toISOString()
  }, { expectedStateSha256: created.stateSha256 });
  assert.equal(abandoning.status, 'abandoning');
  assert.equal((await readRevisionInteractiveState(root, subject)).stateSha256,
    abandoning.stateSha256);

  await assert.rejects(writeRevisionInteractiveState(root, {
    ...abandoning, status: 'abandoned', abandonPayloadSha256: null,
    updatedAt: new Date().toISOString()
  }, { expectedStateSha256: abandoning.stateSha256 }), {
    code: 'REV_INTERACTIVE_STATE_INVALID'
  });
});
