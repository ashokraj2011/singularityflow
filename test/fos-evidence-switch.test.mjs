import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestFosEvidence } from '../src/fos-evidence-ingestion.mjs';
import {
  createFosStorySwitchCheckpoint, recordFosStorySwitchOutcome, verifyFosStorySwitchCheckpoint
} from '../src/fos-story-switch.mjs';

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-evidence-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'FOS Test'], root);
  git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, 'README.md'), 'fixture\n');
  git(['add', '.'], root); git(['commit', '-qm', 'initial'], root);
  return root;
}

test('FOS:AC-045 evidence ingestion is scoped, local, bounded and unverified', async () => {
  const root = await repository();
  const result = await ingestFosEvidence(root, {
    bytes: 'observed browser output', mediaType: 'text/plain', workId: 'WORK-1',
    clauseIds: ['WORK-1:AC-001'], origin: 'paste', actor: { principalId: 'user:1' },
    consent: { localStorage: true, externalTransmission: false },
    features: { 'evidence-ingestion': true }
  });
  assert.equal(result.status, 'attached/unverified');
  assert.equal(result.receipt.authoritative, false);
  assert.equal(result.receipt.executed, false);
  assert.equal(result.receipt.transmittedExternally, false);
});

test('FOS:AC-046 claimed test JSON and executable/archive bytes never become proof', async () => {
  const root = await repository();
  const claimed = await ingestFosEvidence(root, {
    bytes: '{"allTestsPassed":true}', mediaType: 'application/json', workId: 'WORK-1',
    clauseIds: ['WORK-1:AC-001'], actor: { principalId: 'user:1' },
    consent: { localStorage: true }, features: { 'evidence-ingestion': true }
  });
  assert.equal(claimed.receipt.assurance, 'attached/unverified');
  await assert.rejects(() => ingestFosEvidence(root, {
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), mediaType: 'application/pdf',
    workId: 'WORK-1', clauseIds: ['WORK-1:AC-001'], consent: { localStorage: true },
    features: { 'evidence-ingestion': true }
  }), (error) => error.code === 'FOS_EVIDENCE_TYPE_UNSUPPORTED');
});

test('FOS:AC-047 Story-switch checkpoint preserves buffer bytes outside derived cache', async () => {
  const root = await repository();
  const target = path.join(path.dirname(root), `${path.basename(root)}-worktree`);
  git(['worktree', 'add', '-q', '-b', 'WORK-2', target, 'main'], root);
  const created = await createFosStorySwitchCheckpoint(root, {
    sourceWorktree: root, targetWorktree: target, consent: true,
    buffers: [{ id: 'untitled:1', bytes: Buffer.from([0, 10, 255]), dirty: true, language: 'binary' }],
    features: { 'story-switching': true }
  });
  const verified = await verifyFosStorySwitchCheckpoint(
    path.resolve(root, git(['rev-parse', '--git-common-dir'], root)), created.checkpoint.checkpointId
  );
  assert.equal(verified.cache, false);
  const object = path.join(created.path, verified.buffers[0].object);
  assert.deepEqual(await readFile(object), Buffer.from([0, 10, 255]));
});

test('FOS:AC-048 failed Story switching retains verified recovery and source identity', async () => {
  const root = await repository();
  const target = path.join(path.dirname(root), `${path.basename(root)}-worktree`);
  git(['worktree', 'add', '-q', '-b', 'WORK-2', target, 'main'], root);
  const created = await createFosStorySwitchCheckpoint(root, {
    sourceWorktree: root, targetWorktree: target, consent: true,
    buffers: [{ id: 'file:README.md', bytes: 'dirty\n', dirty: true }],
    features: { 'story-switching': true }
  });
  const outcome = await recordFosStorySwitchOutcome(
    path.resolve(root, git(['rev-parse', '--git-common-dir'], root)),
    created.checkpoint.checkpointId, { targetOpened: false, errorCode: 'EDITOR_OPEN_FAILED' }
  );
  assert.equal(outcome.status, 'recovery-available');
  assert.equal(outcome.activeWorktreeId, created.checkpoint.source.worktreeInstanceId);
  assert.equal(outcome.recoveryRetained, true);
});

test('FOS:AC-049 cache clearing cannot remove pending Story-switch recovery', async () => {
  const root = await repository();
  const target = path.join(path.dirname(root), `${path.basename(root)}-worktree`);
  git(['worktree', 'add', '-q', '-b', 'WORK-2', target, 'main'], root);
  const created = await createFosStorySwitchCheckpoint(root, {
    sourceWorktree: root, targetWorktree: target, buffers: [],
    features: { 'story-switching': true }
  });
  const { clearFosDerivedCache } = await import('../src/fos-derived-cache.mjs');
  await clearFosDerivedCache(root);
  const checkpoint = await verifyFosStorySwitchCheckpoint(
    path.resolve(root, git(['rev-parse', '--git-common-dir'], root)), created.checkpoint.checkpointId
  );
  assert.equal(checkpoint.checkpointId, created.checkpoint.checkpointId);
});
