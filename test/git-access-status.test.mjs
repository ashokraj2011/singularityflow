import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGitRuntime } from '../src/git-access.mjs';
import { createGitStatusReadFacade } from '../src/git-access-status.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';

function git(cwd, argv) {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, String(result.stderr || result.error || argv.join(' ')));
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-status-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'GAL Test']);
  git(root, ['config', 'user.email', 'gal@example.com']);
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '-qm', 'base']);
  const created = await createGitRuntime();
  assert.equal(created.ok, true, JSON.stringify(created));
  t.after(() => created.value.dispose());
  const opened = await created.value.openRepository(root);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const repository = opened.value;
  const calls = [];
  const execute = (argv, options) => {
    calls.push(argv);
    return runRemoteGitAsync(argv, {
      cwd: repository.identity.nativePath, env: process.env,
      operation: 'local-read', timeoutMs: 10_000, allowFailure: true,
      encoding: 'buffer', spawnCommand: (_selected, args, spawnOptions) => spawn(
        created.value.identity.path, args, spawnOptions
      ), ...options
    });
  };
  return { root, repository, calls, execute };
}

test('GAL status/index reads preserve unsafe names and bind exact subjects to the verified repository', {
  skip: process.platform === 'win32'
}, async (t) => {
  const { root, repository, calls, execute } = await fixture(t);
  const tracked = '--upload-pack=evil\tline\nname.txt';
  const invalid = Buffer.from([0x6e, 0x6f, 0x6e, 0x2d, 0x80, 0x2e, 0x74, 0x78, 0x74]);
  await writeFile(path.join(root, tracked), 'tracked\n');
  git(root, ['add', '--', tracked]);
  // Some macOS filesystems refuse non-UTF-8 names with EILSEQ. The synthetic fixture below
  // checks those bytes everywhere; this real-Git leg still checks hostile printable names.
  let bytePathCreated = false;
  try {
    await writeFile(Buffer.concat([Buffer.from(`${root}/`), invalid]), 'untracked\n');
    bytePathCreated = true;
  } catch (error) {
    if (error.code !== 'EILSEQ') throw error;
  }
  const reads = createGitStatusReadFacade(repository, execute);
  t.after(() => reads.dispose());
  const status = await reads.statusDetail({ untracked: 'all' });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual(status.subject, {
    repositoryInstanceId: repository.identity.repositoryInstanceId,
    objectFormat: repository.identity.objectFormat,
    untracked: 'all', includeIgnored: false
  });
  assert.equal(status.value.entries.find((entry) => entry.path.kind === 'utf8'
    && entry.path.value === tracked)?.xy.index, 'A');
  if (bytePathCreated) assert.equal(status.value.entries.find((entry) => entry.path.kind === 'bytes')
    ?.path.base64, invalid.toString('base64'));
  const index = await reads.indexDetail();
  assert.equal(index.ok, true, JSON.stringify(index));
  assert.equal(index.value.entries.find((entry) => entry.path.value === tracked)?.stage, 0);
  assert.equal(index.subject.repositoryInstanceId, repository.identity.repositoryInstanceId);
  assert.deepEqual(calls[0], [
    'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all',
    '--ignore-submodules=none'
  ]);
  assert.deepEqual(calls[1], ['ls-files', '--stage', '-z']);
});

test('GAL fixed descriptors keep invalid UTF-8 paths byte-exact through typed reads', async (t) => {
  const { repository } = await fixture(t);
  const invalid = Buffer.from([0x2d, 0x80, 0x09, 0x0a, 0x5c]);
  const head = git(repository.identity.nativePath, ['rev-parse', 'HEAD']);
  const statusBytes = Buffer.concat([
    Buffer.from(`# branch.oid ${head}\0# branch.head main\0? `), invalid, Buffer.from([0])
  ]);
  const indexBytes = Buffer.concat([
    Buffer.from(`100644 ${head} 0\t`), invalid, Buffer.from([0])
  ]);
  const reads = createGitStatusReadFacade(repository, async (argv) => ({
    status: 0, stdout: argv[0] === 'status' ? statusBytes : indexBytes,
    stderr: ''
  }));
  t.after(() => reads.dispose());
  const status = await reads.statusDetail();
  const index = await reads.indexDetail();
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(index.ok, true, JSON.stringify(index));
  assert.equal(status.value.entries[0].path.base64, invalid.toString('base64'));
  assert.equal(index.value.entries[0].path.base64, invalid.toString('base64'));
});

test('GAL status/index capture stays named and fresh observations see later mutable state', async (t) => {
  const { root, repository, calls, execute } = await fixture(t);
  const reads = createGitStatusReadFacade(repository, execute);
  t.after(() => reads.dispose());
  const first = await reads.statusDetail({ freshness: 'captured', captureKey: 'first' });
  assert.equal(first.ok, true);
  assert.equal(first.value.entries.length, 0);
  first.value.entries.push({ forged: true });
  await writeFile(path.join(root, 'new.txt'), 'new\n');
  const captured = await reads.statusDetail({ freshness: 'captured', captureKey: 'first' });
  assert.equal(captured.value.entries.length, 0);
  const fresh = await reads.statusDetail();
  assert.equal(fresh.ok, true);
  assert.equal(fresh.value.entries.find((entry) => entry.path.value === 'new.txt')?.type, 'untracked');
  const conflict = await reads.statusDetail({ untracked: 'no', freshness: 'captured',
    captureKey: 'first' });
  assert.equal(conflict.code, 'GAL_CAPTURE_CONFLICT');
  const initialIndex = await reads.indexDetail({ freshness: 'captured', captureKey: 'index' });
  git(root, ['add', '--', 'new.txt']);
  const heldIndex = await reads.indexDetail({ freshness: 'captured', captureKey: 'index' });
  const freshIndex = await reads.indexDetail();
  assert.deepEqual(heldIndex.value.entries, initialIndex.value.entries);
  assert.ok(freshIndex.value.entries.some((entry) => entry.path.value === 'new.txt'));
  const beforeInvalid = calls.length;
  for (const request of [
    { untracked: '--upload-pack=evil' }, { includeIgnored: 'yes' },
    { freshness: 'captured', captureKey: '../bad' }, { argv: ['status'] }
  ]) {
    assert.equal((await reads.statusDetail(request)).code, 'GAL_INPUT_INVALID');
  }
  assert.equal(calls.length, beforeInvalid);
});

test('verified GitInvocation exposes closed status and index reads', async (t) => {
  const { root, repository } = await fixture(t);
  const invocation = repository.beginInvocation();
  t.after(() => invocation.dispose());
  await writeFile(path.join(root, '--literal\tpath'), 'new\n');
  const status = await invocation.status();
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.subject.repositoryInstanceId, repository.identity.repositoryInstanceId);
  assert.equal(status.value.entries.find((entry) => entry.path.value === '--literal\tpath')?.type,
    'untracked');
  git(root, ['add', '--', '--literal\tpath']);
  const index = await invocation.index();
  assert.equal(index.ok, true, JSON.stringify(index));
  assert.equal(index.value.entries.find((entry) => entry.path.value === '--literal\tpath')?.stage, 0);
  assert.equal(typeof invocation.run, 'undefined');
  assert.equal(typeof invocation.mutate, 'undefined');
});

test('bare repositories refuse status and index as unsupported without spawning', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-bare-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '--bare', '-q']);
  const created = await createGitRuntime();
  assert.equal(created.ok, true, JSON.stringify(created));
  t.after(() => created.value.dispose());
  const opened = await created.value.openRepository(root);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const invocation = opened.value.beginInvocation();
  assert.equal((await invocation.status()).code, 'GAL_OPERATION_UNSUPPORTED');
  assert.equal((await invocation.index()).code, 'GAL_OPERATION_UNSUPPORTED');
});

test('GAL status read cancellation cannot publish a late result and disposed reads do not spawn', async (t) => {
  const { repository } = await fixture(t);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const reads = createGitStatusReadFacade(repository, async () => {
    calls += 1;
    entered();
    return pending;
  });
  const reading = reads.statusDetail({ freshness: 'captured', captureKey: 'pending' });
  await started;
  reads.dispose();
  release({ status: 0, stdout: Buffer.from(`# branch.oid ${git(repository.identity.nativePath,
    ['rev-parse', 'HEAD'])}\0# branch.head main\0`), stderr: '' });
  const cancelled = await reading;
  assert.equal(cancelled.code, 'GAL_CANCELLED');
  assert.equal(cancelled.subject.repositoryInstanceId, repository.identity.repositoryInstanceId);
  assert.equal((await reads.statusDetail()).code, 'GAL_DISPOSED');
  assert.equal(calls, 1);
});

test('GAL status read rejects decoded stdout rather than corrupting a repository path', async (t) => {
  const { repository } = await fixture(t);
  const reads = createGitStatusReadFacade(repository, async () => ({
    status: 0, stdout: '# branch.oid (initial)\0# branch.head main\0', stderr: ''
  }));
  t.after(() => reads.dispose());
  assert.equal((await reads.statusDetail()).code, 'GAL_PROTOCOL_INVALID');
});
