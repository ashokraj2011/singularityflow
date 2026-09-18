import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGitRuntime } from '../src/git-access.mjs';

function git(cwd, args, input = undefined) {
  const result = spawnSync('git', args, {
    cwd, input, encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, String(result.stderr || result.error || args.join(' ')));
  return result.stdout.trim();
}

async function fixture(t, { commit = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'GAL Test']);
  git(root, ['config', 'user.email', 'gal@example.com']);
  if (commit) {
    await writeFile(path.join(root, 'source.txt'), 'initial\n');
    git(root, ['add', 'source.txt']);
    git(root, ['commit', '-qm', 'initial']);
  }
  return root;
}

async function open(t, root, options = {}) {
  const created = await createGitRuntime(options);
  assert.equal(created.ok, true, JSON.stringify(created));
  t.after(() => created.value.dispose());
  const opened = await created.value.openRepository(root);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return { runtime: created.value, repository: opened.value };
}

test('GAL runtime resolves before repository discovery and refuses an invalid explicit Git path', async (t) => {
  const bad = await createGitRuntime({ trustedGitPath: '/no/such/git' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'GAL_EXECUTABLE_UNAVAILABLE');
  const root = await fixture(t);
  const { runtime, repository } = await open(t, root);
  assert.ok(path.isAbsolute(runtime.identity.path));
  assert.equal(repository.identity.root, await realpath(root));
  assert.equal(repository.identity.objectFormat, 'sha1');
  assert.equal(repository.identity.bare, false);
  assert.ok(path.isAbsolute(repository.identity.gitDir));
});

test('GAL HEAD models attached, detached and unborn without converting errors to state', async (t) => {
  const root = await fixture(t);
  const { repository } = await open(t, root);
  const invocation = repository.beginInvocation();
  const attached = await invocation.head();
  assert.equal(attached.ok, true);
  assert.equal(attached.value.state, 'attached');
  assert.equal(attached.value.symbolicRef, 'refs/heads/main');
  assert.equal(attached.value.oid, git(root, ['rev-parse', 'HEAD']));
  git(root, ['checkout', '--detach', '-q']);
  const detached = await invocation.head();
  assert.equal(detached.ok, true);
  assert.equal(detached.value.state, 'detached');
  assert.equal(detached.value.symbolicRef, null);
  const unbornRoot = await fixture(t, { commit: false });
  const openedUnborn = await open(t, unbornRoot);
  const unborn = await openedUnborn.repository.beginInvocation().head();
  assert.equal(unborn.ok, true);
  assert.deepEqual(unborn.value, {
    state: 'unborn', symbolicRef: 'refs/heads/main', oid: null
  });
});

test('GAL ref observations default fresh; captured observations keep their named earlier value', async (t) => {
  const root = await fixture(t);
  const { repository } = await open(t, root);
  const invocation = repository.beginInvocation();
  const ref = 'refs/heads/main';
  const captured = await invocation.resolveRef({ ref, freshness: 'captured', captureKey: 'first' });
  assert.equal(captured.ok, true);
  const firstOid = captured.value.oid;
  // Caller mutation cannot poison a captured result.
  captured.value.oid = 'not-an-oid';
  await writeFile(path.join(root, 'source.txt'), 'second\n');
  git(root, ['add', 'source.txt']);
  git(root, ['commit', '-qm', 'second']);
  const sameCapture = await invocation.resolveRef({ ref, freshness: 'captured', captureKey: 'first' });
  assert.equal(sameCapture.value.oid, firstOid);
  const fresh = await invocation.resolveRef({ ref });
  assert.equal(fresh.ok, true);
  assert.notEqual(fresh.value.oid, firstOid);
  assert.equal(fresh.value.oid, git(root, ['rev-parse', 'HEAD']));
  const conflicting = await invocation.resolveRef({
    ref: 'refs/heads/other', freshness: 'captured', captureKey: 'first'
  });
  assert.equal(conflicting.code, 'GAL_CAPTURE_CONFLICT');
  const absent = await invocation.resolveRef({ ref: 'refs/heads/absent' });
  assert.equal(absent.ok, false);
  assert.equal(absent.code, 'GAL_REF_ABSENT');
  const invalid = await invocation.resolveRef({ ref: '--upload-pack=attacker' });
  assert.equal(invalid.code, 'GAL_INPUT_INVALID');
});

test('GAL raw blobs preserve arbitrary bytes, duplicate order and caller isolation', async (t) => {
  const root = await fixture(t);
  const original = Buffer.from([0, 13, 10, 255, 128, 65, 0, 66, 10]);
  const replacement = Buffer.from('replacement object\n');
  const oid = git(root, ['hash-object', '-w', '--stdin'], original);
  const replacementOid = git(root, ['hash-object', '-w', '--stdin'], replacement);
  git(root, ['replace', oid, replacementOid]);
  const { repository } = await open(t, root, {
    trustedEnvironment: {
      ...process.env, GIT_DIR: '/nonexistent', GIT_NO_REPLACE_OBJECTS: '0',
      SINGULARITY_FLOW_NO_NETWORK: '1'
    }
  });
  const invocation = repository.beginInvocation();
  const batch = await invocation.blobs({ oids: [oid, oid] });
  assert.equal(batch.ok, true, JSON.stringify(batch));
  assert.deepEqual(batch.value.entries.map((entry) => entry.oid), [oid, oid]);
  assert.deepEqual(batch.value.entries[0].bytes, original);
  batch.value.entries[0].bytes[0] = 99;
  assert.deepEqual(batch.value.entries[1].bytes, original);
  const one = await invocation.blob(oid);
  assert.equal(one.ok, true);
  assert.deepEqual(one.value.bytes, original);
  const missing = await invocation.blob('f'.repeat(40));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'GAL_OBJECT_MISSING');
  const wrongType = await invocation.blob(git(root, ['rev-parse', 'HEAD']));
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.code, 'GAL_WRONG_OBJECT_TYPE');
  const malformed = await invocation.blob('a'.repeat(48));
  assert.equal(malformed.code, 'GAL_INPUT_INVALID');
  const empty = await invocation.blobs({ oids: [] });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value.entries, []);
});

test('GAL blob subprocess I/O does not block the event loop', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  const body = Buffer.from([0, 255, 10]);
  const oid = git(root, ['hash-object', '-w', '--stdin'], body);
  const baseline = await open(t, root);
  const wrapper = path.join(root, 'git-slow-blob');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then sleep 0.35; fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const { repository } = await open(t, root, {
    trustedGitPath: wrapper,
    trustedEnvironment: { ...process.env, GAL_TEST_REAL_GIT: baseline.runtime.identity.path }
  });
  const read = repository.beginInvocation().blob(oid);
  const first = await Promise.race([
    read.then(() => 'read'), new Promise((resolve) => setTimeout(() => resolve('timer'), 40))
  ]);
  assert.equal(first, 'timer', 'a timer must run while Git is producing blob output');
  const result = await read;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.bytes, body);
});

test('GAL disposal cancels an in-flight blob read', {
  skip: process.platform === 'win32', timeout: 5_000
}, async (t) => {
  const root = await fixture(t);
  const oid = git(root, ['hash-object', '-w', '--stdin'], Buffer.from('cancel me'));
  const baseline = await open(t, root);
  const wrapper = path.join(root, 'git-blocked-blob');
  const marker = path.join(root, 'blob-started');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then\n'
    + '  : > "$GAL_TEST_MARKER"\n'
    + '  sleep 10\n'
    + 'fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const { repository } = await open(t, root, {
    trustedGitPath: wrapper,
    trustedEnvironment: {
      ...process.env, GAL_TEST_REAL_GIT: baseline.runtime.identity.path, GAL_TEST_MARKER: marker
    }
  });
  const invocation = repository.beginInvocation();
  const pending = invocation.blob(oid);
  let entered = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(marker); entered = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.equal(entered, true, 'the read reached its content subprocess');
  await invocation.dispose();
  const result = await pending;
  assert.equal(result.code, 'GAL_CANCELLED');
  assert.equal(result.diagnostic.cancelled, true);
});

test('GAL blob deadline stops a slow content stage', {
  skip: process.platform === 'win32', timeout: 8_000
}, async (t) => {
  const root = await fixture(t);
  const oid = git(root, ['hash-object', '-w', '--stdin'], Buffer.from('time out'));
  const baseline = await open(t, root);
  const wrapper = path.join(root, 'git-timeout-blob');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then sleep 10; fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const { repository } = await open(t, root, {
    trustedGitPath: wrapper, deadlineMs: 2_000,
    trustedEnvironment: { ...process.env, GAL_TEST_REAL_GIT: baseline.runtime.identity.path }
  });
  const result = await repository.beginInvocation().blob(oid);
  assert.equal(result.code, 'GAL_TIMEOUT');
  assert.equal(result.diagnostic.timedOut, true);
});

test('GAL rejects a well-framed blob with bytes that do not hash to its OID', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  const oid = git(root, ['hash-object', '-w', '--stdin'], Buffer.from('real'));
  const baseline = await open(t, root);
  const wrapper = path.join(root, 'git-corrupt-blob');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then\n'
    + '  printf "%s blob 4\\nFAKE\\n" "$GAL_TEST_OID"\n'
    + '  exit 0\n'
    + 'fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const { repository } = await open(t, root, {
    trustedGitPath: wrapper,
    trustedEnvironment: {
      ...process.env, GAL_TEST_REAL_GIT: baseline.runtime.identity.path, GAL_TEST_OID: oid
    }
  });
  const result = await repository.beginInvocation().blob(oid);
  assert.equal(result.code, 'GAL_OBJECT_UNAVAILABLE');
});

test('GAL refuses arbitrary mutation and returns idempotent typed disposal', async (t) => {
  const root = await fixture(t);
  const { runtime, repository } = await open(t, root);
  const invocation = repository.beginInvocation();
  assert.equal(typeof invocation.mutate, 'undefined');
  assert.equal(typeof invocation.run, 'undefined');
  assert.equal(typeof runtime.initialize, 'undefined');
  assert.equal((await invocation.dispose()).value.alreadyClosed, false);
  assert.equal((await invocation.dispose()).value.alreadyClosed, true);
  assert.equal((await invocation.head()).code, 'GAL_DISPOSED');
  assert.equal((await repository.dispose()).value.alreadyClosed, false);
  assert.equal((await repository.dispose()).value.alreadyClosed, true);
  assert.equal((await runtime.dispose()).value.alreadyClosed, false);
  assert.equal((await runtime.dispose()).value.alreadyClosed, true);
});

test('GAL opens bare repositories and validates SHA-256 OIDs by storage format', async (t) => {
  const bareRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-bare-'));
  t.after(() => rm(bareRoot, { recursive: true, force: true }));
  git(bareRoot, ['init', '--bare', '-q']);
  const bare = await open(t, bareRoot);
  assert.equal(bare.repository.identity.bare, true);
  assert.equal(bare.repository.identity.root, null);
  const shaRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-sha256-'));
  t.after(() => rm(shaRoot, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-q', '--object-format=sha256'], {
    cwd: shaRoot, encoding: 'utf8', timeout: 10_000
  });
  if (initialized.status !== 0) {
    t.diagnostic('This Git does not support SHA-256 repositories.');
    return;
  }
  const sha = await open(t, shaRoot);
  assert.equal(sha.repository.identity.objectFormat, 'sha256');
  const invocation = sha.repository.beginInvocation();
  const invalid = await invocation.blob('a'.repeat(40));
  assert.equal(invalid.code, 'GAL_INPUT_INVALID');
  const body = Buffer.from([0, 255, 0, 10]);
  const oid = git(shaRoot, ['hash-object', '-w', '--stdin'], body);
  assert.equal(oid.length, 64);
  const result = await invocation.blob(oid);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.bytes, body);
});

test('GAL retires an open handle after repository reinitialization, including named captures', async (t) => {
  const root = await fixture(t);
  const { repository } = await open(t, root);
  const invocation = repository.beginInvocation();
  const first = await invocation.resolveRef({
    ref: 'refs/heads/main', freshness: 'captured', captureKey: 'before-reinit'
  });
  assert.equal(first.ok, true);
  await rename(path.join(root, '.git'), path.join(root, '.git-before-reinit'));
  git(root, ['init', '-q', '-b', 'main']);
  const cached = await invocation.resolveRef({
    ref: 'refs/heads/main', freshness: 'captured', captureKey: 'before-reinit'
  });
  assert.equal(cached.code, 'GAL_REPOSITORY_CHANGED');
  assert.equal((await invocation.head()).code, 'GAL_REPOSITORY_CHANGED');
  assert.equal((await invocation.blob(first.value.oid)).code, 'GAL_REPOSITORY_CHANGED');
  const reopened = await open(t, root);
  assert.notEqual(reopened.repository.identity.repositoryInstanceId,
    repository.identity.repositoryInstanceId);
  assert.equal((await reopened.repository.beginInvocation().head()).value.state, 'unborn');
});

test('GAL binds linked-worktree handles to their .git pointer and common directory', async (t) => {
  const root = await fixture(t);
  const sibling = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-linked-'));
  t.after(() => rm(sibling, { recursive: true, force: true }));
  git(root, ['worktree', 'add', '-q', '-b', 'linked', sibling]);
  const { repository } = await open(t, sibling);
  assert.notEqual(repository.identity.gitDir, repository.identity.commonDir);
  assert.equal((await repository.beginInvocation().head()).value.symbolicRef, 'refs/heads/linked');
  await writeFile(path.join(sibling, '.git'), `gitdir: ${path.join(root, '.git')}\n`);
  assert.equal((await repository.beginInvocation().head()).code, 'GAL_REPOSITORY_CHANGED');
});

test('GAL refuses a torn HEAD observation when checkout changes between its reads', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  git(root, ['branch', 'other']);
  const baseline = await open(t, root);
  const realGitPath = baseline.runtime.identity.path;
  const wrapper = path.join(root, 'git-wrapper');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "HEAD" ]; then\n'
    + '  "$GAL_TEST_REAL_GIT" -C "$GAL_TEST_REPO" switch -q other\n'
    + 'fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const { repository } = await open(t, root, {
    trustedGitPath: wrapper,
    trustedEnvironment: { ...process.env, GAL_TEST_REAL_GIT: realGitPath, GAL_TEST_REPO: root }
  });
  const observed = await repository.beginInvocation().head();
  assert.equal(observed.ok, false);
  assert.equal(observed.code, 'GAL_OBSERVATION_CHANGED');
  assert.equal(git(root, ['symbolic-ref', 'HEAD']), 'refs/heads/other');
});

test('GAL does not release an in-flight captured result after repository replacement', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await fixture(t);
  const baseline = await open(t, root);
  const wrapper = path.join(root, 'git-delayed');
  const entered = path.join(root, 'show-ref-entered');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "show-ref" ] && [ "$2" = "--verify" ] && [ "$3" = "--quiet" ]; then\n'
    + '  : > "$GAL_TEST_SIGNAL"\n'
    + '  sleep 1\n'
    + 'fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const selected = await open(t, root, {
    trustedGitPath: wrapper,
    trustedEnvironment: {
      ...process.env, GAL_TEST_REAL_GIT: baseline.runtime.identity.path, GAL_TEST_SIGNAL: entered
    }
  });
  const invocation = selected.repository.beginInvocation();
  const request = { ref: 'refs/heads/main', freshness: 'captured', captureKey: 'in-flight' };
  const first = invocation.resolveRef(request);
  let signaled = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(entered); signaled = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.equal(signaled, true, 'the first captured read reached Git');
  const coalesced = invocation.resolveRef(request);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rename(path.join(root, '.git'), path.join(root, '.git-before-reinit'));
  git(root, ['init', '-q', '-b', 'main']);
  const outcomes = await Promise.all([first, coalesced]);
  assert.deepEqual(outcomes.map((result) => result.code), [
    'GAL_REPOSITORY_CHANGED', 'GAL_REPOSITORY_CHANGED'
  ]);
});
