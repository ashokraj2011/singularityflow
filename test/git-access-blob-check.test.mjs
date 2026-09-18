import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGitRuntime } from '../src/git-access.mjs';
import { checkLocalGitBlobsAsync } from '../src/git-local-blob-async.mjs';

function git(cwd, args, input = undefined, allowFailure = false) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 10_000 });
  if (!allowFailure) assert.equal(result.status, 0, String(result.stderr || result.error));
  return result;
}

async function fixture(t, objectFormat = 'sha1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-blob-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = git(root, ['init', '-q', '-b', 'main',
    ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : [])], undefined, true);
  if (initialized.status !== 0) return null;
  git(root, ['config', 'user.name', 'GAL Test']);
  git(root, ['config', 'user.email', 'gal@example.com']);
  const original = Buffer.from([0, 255, 13, 10, 65]);
  const oid = git(root, ['hash-object', '-w', '--stdin'], original).stdout.trim();
  const replacementOid = git(root, ['hash-object', '-w', '--stdin'], Buffer.from('much longer replacement'))
    .stdout.trim();
  git(root, ['replace', oid, replacementOid]);
  const treeOid = git(root, ['mktree'], Buffer.alloc(0)).stdout.trim();
  return { root, oid, treeOid, original };
}

async function open(t, root) {
  const created = await createGitRuntime({ trustedEnvironment: {
    ...process.env, GIT_DIR: '/nonexistent', GIT_NO_REPLACE_OBJECTS: '0',
    SINGULARITY_FLOW_NO_NETWORK: '1'
  } });
  assert.equal(created.ok, true, JSON.stringify(created));
  t.after(() => created.value.dispose());
  const opened = await created.value.openRepository(root);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened.value.beginInvocation();
}

for (const objectFormat of ['sha1', 'sha256']) {
  test(`blobCheck returns metadata only for exact ${objectFormat} OIDs`, async (t) => {
    const sample = await fixture(t, objectFormat);
    if (!sample) { t.skip('Git does not support SHA-256 object repositories'); return; }
    const invocation = await open(t, sample.root);
    const empty = await invocation.blobCheck([]);
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.value.entries, []);
    const checked = await invocation.blobCheck([sample.oid, sample.oid]);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(checked.objectFormat, objectFormat);
    assert.equal(checked.classification, 'metadata-only');
    assert.deepEqual(checked.value.entries, [
      { oid: sample.oid, objectType: 'blob', size: sample.original.length },
      { oid: sample.oid, objectType: 'blob', size: sample.original.length }
    ]);
    assert.equal('bytes' in checked.value.entries[0], false);
    checked.value.entries[0].size = 999;
    assert.equal(checked.value.entries[1].size, sample.original.length);
    assert.equal((await invocation.blobCheck(['f'.repeat(sample.oid.length)])).code,
      'GAL_OBJECT_MISSING');
    assert.equal((await invocation.blobCheck([sample.treeOid])).code,
      'GAL_WRONG_OBJECT_TYPE');
    assert.equal((await invocation.blobCheck([sample.oid, sample.treeOid])).code,
      'GAL_WRONG_OBJECT_TYPE');
    for (const malformed of [sample.oid.slice(1), `${sample.oid}0`, 'HEAD',
      `${sample.oid}^{blob}`, '--batch-all-objects']) {
      assert.equal((await invocation.blobCheck([malformed])).code, 'GAL_INPUT_INVALID');
    }
  });
}

test('blob metadata helper bounds count and refuses malformed framing before accepting a batch', async () => {
  let calls = 0;
  const oid = 'a'.repeat(40);
  const runCommand = async (_executable, args) => {
    calls += 1;
    return { status: 0, stdout: Buffer.from(args[0] === 'rev-parse'
      ? 'sha1\n' : `${oid} blob 4\nextra\n`), stderr: '' };
  };
  await assert.rejects(checkLocalGitBlobsAsync('/unused', Array(4_097).fill(oid), {
    executable: '/unused/git', runCommand
  }), { code: 'GIT_BLOB_BATCH_INVALID' });
  assert.equal(calls, 0);
  await assert.rejects(checkLocalGitBlobsAsync('/unused', [oid], {
    executable: '/unused/git', runCommand
  }), { code: 'GIT_BLOB_BATCH_INVALID' });
  assert.equal(calls, 2);
});

test('blobCheck cancellation does not turn a stopped metadata read into success', async (t) => {
  const sample = await fixture(t);
  const invocation = await open(t, sample.root);
  const pending = invocation.blobCheck([sample.oid]);
  await invocation.dispose();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GAL_CANCELLED');

  const controller = new AbortController();
  let calls = 0;
  const waiting = checkLocalGitBlobsAsync(sample.root, [sample.oid], {
    executable: '/unused/git', signal: controller.signal,
    runCommand: async () => {
      calls += 1;
      controller.abort();
      return { status: 0, stdout: Buffer.from('sha1\n'), stderr: '' };
    }
  });
  await assert.rejects(waiting, { code: 'GAL_CANCELLED' });
  assert.equal(calls, 1);
});
