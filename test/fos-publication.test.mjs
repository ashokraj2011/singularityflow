import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  fosRemotePublicationIdentity, publishFosRemoteRef
} from '../src/fos-publication.mjs';

const authorizationSha256 = `sha256:${'a'.repeat(64)}`;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-publish-'));
  const root = path.join(parent, 'source');
  const remote = path.join(parent, 'remote.git');
  git(['init', '-q', '-b', 'main', root], parent);
  git(['config', 'user.name', 'FOS Publisher'], root);
  git(['config', 'user.email', 'publisher@example.com'], root);
  await writeFile(path.join(root, 'source.txt'), 'initial\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'initial'], root);
  git(['init', '-q', '--bare', '-b', 'main', remote], parent);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-q', '-u', 'origin', 'main'], root);
  return { root, remote };
}

function input(remote, ref, candidateOid, expectedOid) {
  return { remote, ref, candidateOid, expectedOid, authorizationSha256 };
}

function guard(request) {
  return Object.freeze({
    authorized: true,
    requestDigest: request.requestDigest,
    authorizationSha256
  });
}

test('FOS:AC-011 remote leases enforce absence or exact old OID and operation replay never duplicates publication', async () => {
  const { root, remote } = await repository();
  await writeFile(path.join(root, 'source.txt'), 'candidate one\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'candidate one'], root);
  const candidateOne = git(['rev-parse', 'HEAD'], root);
  const ref = 'refs/heads/sflow/fos-law';
  const creation = input(remote, ref, candidateOne, null);
  const operation = fosRemotePublicationIdentity(creation, {
    name: 'FOS Publisher', email: 'publisher@example.com'
  });
  const first = await publishFosRemoteRef(root, creation, {
    operationId: operation.operationId, publicationGuard: guard
  });
  assert.equal(first.status, 'published');
  assert.equal(git(['--git-dir', remote, 'rev-parse', ref], root), candidateOne);

  const replay = await publishFosRemoteRef(root, creation, {
    operationId: operation.operationId, publicationGuard: guard
  });
  assert.equal(replay.status, 'reconciled');
  assert.equal(replay.published, false);
  assert.equal(replay.receipt.receiptSha256, first.receipt.receiptSha256);

  await writeFile(path.join(root, 'source.txt'), 'candidate two\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'candidate two'], root);
  const candidateTwo = git(['rev-parse', 'HEAD'], root);
  await assert.rejects(() => publishFosRemoteRef(root,
    input(remote, ref, candidateTwo, candidateOne), {
      operationId: operation.operationId, publicationGuard: guard
    }), (error) => error.code === 'IDEMPOTENCY_CONFLICT');

  const interruptedRef = 'refs/heads/sflow/fos-interrupted';
  const interruptedInput = input(remote, interruptedRef, candidateTwo, null);
  const interruptedOperation = fosRemotePublicationIdentity(interruptedInput, {
    name: 'FOS Publisher', email: 'publisher@example.com'
  });
  let guardCalls = 0;
  await assert.rejects(() => publishFosRemoteRef(root, interruptedInput, {
    operationId: interruptedOperation.operationId,
    publicationGuard: async (request) => {
      guardCalls += 1;
      return guard(request);
    },
    afterPush: async () => {
      const error = new Error('simulated interruption after remote acceptance');
      error.code = 'SIMULATED_INTERRUPT';
      throw error;
    }
  }), (error) => error.code === 'SIMULATED_INTERRUPT');
  assert.equal(git(['--git-dir', remote, 'rev-parse', interruptedRef], root), candidateTwo);
  const recovered = await publishFosRemoteRef(root, interruptedInput, {
    operationId: interruptedOperation.operationId,
    publicationGuard: async () => {
      guardCalls += 1;
      throw new Error('an identical recovery must not re-authorize or push');
    }
  });
  assert.equal(recovered.status, 'reconciled-after-interruption');
  assert.equal(recovered.published, false);
  assert.equal(recovered.receipt.observedOid, candidateTwo);
  assert.equal(guardCalls, 1);

  git(['switch', '-q', '-c', 'competitor', candidateOne], root);
  await writeFile(path.join(root, 'competitor.txt'), 'concurrent publication\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'concurrent candidate'], root);
  const competitor = git(['rev-parse', 'HEAD'], root);
  git(['switch', '-q', 'main'], root);
  await assert.rejects(() => publishFosRemoteRef(root,
    input(remote, ref, candidateTwo, candidateOne), {
      publicationGuard: guard,
      beforePush: async () => {
        git(['push', '-q', remote, `${competitor}:${ref}`], root);
      }
    }), (error) => error.code === 'AUTHORITY_MOVED');
  assert.equal(git(['--git-dir', remote, 'rev-parse', ref], root), competitor);
});
