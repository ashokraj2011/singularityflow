import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deliverFosApprovalOutbox, enqueueFosApprovalRequest, retainFosReusableDefault
} from '../src/fos-convenience-store.mjs';
import { createFosApprovalRequest, createFosReusableDefault } from '../src/fos-features.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;
function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-convenience-'));
  git(['init', '-q', '-b', 'main'], root); git(['config', 'user.name', 'FOS Test'], root); git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, 'README.md'), 'fixture\n'); git(['add', '.'], root); git(['commit', '-qm', 'initial'], root);
  return root;
}

test('FOS:AC-038 reusable defaults are immutable non-authoritative local records', async () => {
  const root = await repository();
  const record = createFosReusableDefault({
    repositoryId: 'repo-1', authoritySha256: sha('a'), question: { id: 'workflow', version: '1' },
    contextSha256: sha('b'), policySha256: sha('c'), sourceSha256: sha('d'), value: 'feature',
    expiresAt: '2030-01-01T00:00:00.000Z'
  }, { features: { 'reusable-defaults': true } });
  assert.equal((await retainFosReusableDefault(root, record)).status, 'retained');
  assert.equal((await retainFosReusableDefault(root, record)).status, 'already-retained');
  assert.equal(git(['status', '--porcelain'], root), '');
});

test('FOS:AC-042 approval outbox retries delivery without granting approval', async () => {
  const root = await repository();
  const request = createFosApprovalRequest({
    operationId: 'approve', generation: 1, actorPrincipalId: 'user:author',
    targetAuthoritySha256: sha('a'), baseSha256: sha('b'), candidateSha256: sha('c'),
    evidenceSha256: sha('d'), policySha256: sha('e'), policyEpoch: 1,
    recipients: ['user:reviewer'], expiresAt: '2030-01-01T00:00:00.000Z'
  }, { features: { 'approval-routing': true }, now: new Date('2029-01-01') });
  assert.equal((await enqueueFosApprovalRequest(root, request)).status, 'queued');
  assert.equal((await enqueueFosApprovalRequest(root, request)).status, 'already-queued');
  const failed = await deliverFosApprovalOutbox(root, async () => ({ delivered: false, code: 'OFFLINE' }));
  assert.equal(failed[0].status, 'pending');
  const delivered = await deliverFosApprovalOutbox(root, async () => ({ delivered: true, messageId: 'm-1' }));
  assert.equal(delivered[0].status, 'delivered');
  const duplicate = await deliverFosApprovalOutbox(root, async () => assert.fail('must dedupe'));
  assert.equal(duplicate[0].status, 'already-delivered');
});
