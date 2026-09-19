import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGitRuntime } from '../src/git-access.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, String(result.stderr || result.error || args.join(' ')));
  return result.stdout.trim();
}

function pinFor(remote, ownerRevision) {
  return {
    kind: 'owner-pinned-origin', ownerRevision,
    originUrlSha256: `sha256:${createHash('sha256').update(Buffer.from(remote)).digest('hex')}`
  };
}

async function fixture(t, runtimeOptions = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-remote-ref-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const work = path.join(base, 'work');
  const bare = path.join(base, 'authority.git');
  git(base, ['init', '-q', '-b', 'main', work]);
  git(base, ['init', '-q', '--bare', bare]);
  git(work, ['-c', 'user.name=GAL', '-c', 'user.email=gal@example.test',
    'commit', '--quiet', '--allow-empty', '-m', 'first']);
  const first = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', '--quiet', bare, 'HEAD:refs/heads/main']);
  git(work, ['remote', 'add', 'origin', bare]);
  const created = await createGitRuntime(runtimeOptions);
  assert.equal(created.ok, true, JSON.stringify(created));
  t.after(() => created.value.dispose());
  const opened = await created.value.openRepository(work);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return { base, work, bare, first, pin: pinFor(bare, first),
    invocation: opened.value.beginInvocation() };
}

test('GAL remoteRef observes the exact pinned origin/ref without fetching local refs or objects', async (t) => {
  const { base, work, bare, first, pin, invocation } = await fixture(t);
  const request = { pin, ref: 'refs/heads/main' };
  const observed = await invocation.remoteRef(request);
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.deepEqual(observed.value, {
    remote: 'origin', endpointSha256: pin.originUrlSha256,
    ownerPin: { ...pin, ownerRevisionObjectFormat: 'sha1' },
    ref: 'refs/heads/main', oid: first,
    objectFormat: 'sha1', repositoryObjectFormat: 'sha1'
  });
  assert.equal(observed.classification, 'remote-observational');
  assert.match(observed.observedAt, /^\d{4}-\d\d-\d\dT/u);
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], {
    cwd: work, encoding: 'utf8', timeout: 10_000
  }).status, 1);

  const other = path.join(base, 'other');
  git(base, ['init', '-q', '-b', 'main', other]);
  git(other, ['-c', 'user.name=GAL', '-c', 'user.email=gal@example.test',
    'commit', '--quiet', '--allow-empty', '-m', 'remote-only']);
  const remoteOnly = git(other, ['rev-parse', 'HEAD']);
  git(other, ['push', '--quiet', bare, 'HEAD:refs/heads/remote-only']);
  assert.equal((await invocation.remoteRef({ pin, ref: 'refs/heads/remote-only' }))
    .value.oid, remoteOnly);
  assert.notEqual(spawnSync('git', ['cat-file', '-e', remoteOnly], {
    cwd: work, encoding: 'utf8', timeout: 10_000
  }).status, 0);

  const captured = await invocation.remoteRef({ ...request, freshness: 'captured', captureKey: 'first' });
  assert.equal(captured.value.oid, first);
  git(work, ['-c', 'user.name=GAL', '-c', 'user.email=gal@example.test',
    'commit', '--quiet', '--allow-empty', '-m', 'second']);
  const second = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', '--quiet', bare, 'HEAD:refs/heads/main']);
  assert.equal((await invocation.remoteRef({ ...request, freshness: 'captured',
    captureKey: 'first' })).value.oid, first);
  assert.equal((await invocation.remoteRef(request)).value.oid, second);

  git(work, ['push', '--quiet', bare, 'HEAD:refs/heads/deep/topic']);
  assert.equal((await invocation.remoteRef({ pin, ref: 'refs/heads/topic' })).code,
    'GAL_REF_ABSENT');
  assert.equal((await invocation.remoteRef({ pin, ref: 'refs/heads/missing' })).code,
    'GAL_REF_ABSENT');
});

test('GAL remoteRef refuses naked endpoints, malformed caller pins and invalid refs', async (t) => {
  const { bare, pin, invocation } = await fixture(t);
  for (const remote of ['origin', '../authority.git', 'https://user:secret@example.test/repo.git',
    'ext::helper example.test', '--upload-pack=/tmp/evil']) {
    assert.equal((await invocation.remoteRef({ remote, ref: 'refs/heads/main' })).code,
      'GAL_INPUT_INVALID', remote);
  }
  assert.equal((await invocation.remoteRef({ pin: {
    ...pin, kind: 'caller-selected'
  }, ref: 'refs/heads/main' })).code, 'GAL_INPUT_INVALID');
  assert.equal((await invocation.remoteRef({ pin: {
    ...pin, originUrlSha256: `sha256:${'0'.repeat(64)}`
  }, ref: 'refs/heads/main' })).code, 'GAL_ENDPOINT_CHANGED');
  assert.equal((await invocation.remoteRef({ pin, ref: 'HEAD' })).code,
    'GAL_INPUT_INVALID');
  assert.equal((await invocation.remoteRef({ pin, ref: 'refs/heads/main',
    fetch: true })).code, 'GAL_INPUT_INVALID');
});

test('GAL remoteRef refuses a symbolic remote authority instead of accepting its target', async (t) => {
  const { bare, first, pin, invocation } = await fixture(t);
  git(bare, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/main']);

  const result = await invocation.remoteRef({ pin, ref: 'refs/heads/alias' });
  assert.equal(result.code, 'GAL_PROTOCOL_INVALID', JSON.stringify(result));
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), first,
    'observing a symbolic authority must not alter its target');
});

test('GAL remoteRef reports continuity only; a caller-claimed revision is not approval proof',
  async (t) => {
    const { bare, first, invocation } = await fixture(t);
    const unverifiedPin = pinFor(bare, 'a'.repeat(40));
    const result = await invocation.remoteRef({ pin: unverifiedPin, ref: 'refs/heads/main' });
    assert.equal(result.ok, true);
    assert.equal(result.value.oid, first);
    assert.equal(result.value.ownerPin.ownerRevision, 'a'.repeat(40));
    assert.equal(result.classification, 'remote-observational');
    assert.equal(Object.hasOwn(result.value, 'approved'), false);
  });

test('GAL remoteRef refuses changed, missing and ambiguous repository-local origin values', async (t) => {
  const { base, work, bare, pin, invocation } = await fixture(t);
  const request = { pin, ref: 'refs/heads/main', freshness: 'captured', captureKey: 'pin' };
  assert.equal((await invocation.remoteRef(request)).ok, true);
  const replacement = path.join(base, 'replacement.git');
  git(base, ['init', '-q', '--bare', replacement]);
  git(work, ['config', '--local', 'remote.origin.url', replacement]);
  assert.equal((await invocation.remoteRef(request)).code, 'GAL_ENDPOINT_CHANGED');
  git(work, ['config', '--local', 'remote.origin.url', bare]);
  git(work, ['config', '--local', '--add', 'remote.origin.url', bare]);
  assert.equal((await invocation.remoteRef(request)).code, 'GAL_ORIGIN_AMBIGUOUS');
  git(work, ['config', '--local', '--unset-all', 'remote.origin.url']);
  assert.equal((await invocation.remoteRef(request)).code, 'GAL_ORIGIN_UNCONFIGURED');
});

test('GAL remoteRef reports the remote object format separately from local storage format',
  async (t) => {
    const { base, work, invocation } = await fixture(t);
    const sha256Work = path.join(base, 'sha256-work');
    const sha256Bare = path.join(base, 'sha256.git');
    git(base, ['init', '-q', '--object-format=sha256', '-b', 'main', sha256Work]);
    git(base, ['init', '-q', '--object-format=sha256', '--bare', sha256Bare]);
    git(sha256Work, ['-c', 'user.name=GAL', '-c', 'user.email=gal@example.test',
      'commit', '--quiet', '--allow-empty', '-m', 'sha256 remote']);
    const oid = git(sha256Work, ['rev-parse', 'HEAD']);
    git(sha256Work, ['push', '--quiet', sha256Bare, 'HEAD:refs/heads/main']);
    git(work, ['config', '--local', 'remote.origin.url', sha256Bare]);
    const pin = pinFor(sha256Bare, oid);
    const result = await invocation.remoteRef({ pin, ref: 'refs/heads/main' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.oid, oid);
    assert.equal(result.value.objectFormat, 'sha256');
    assert.equal(result.value.repositoryObjectFormat, 'sha1');
    assert.equal(result.value.ownerPin.ownerRevisionObjectFormat, 'sha256');
  });

test('GAL remoteRef preserves offline policy while local repository observations remain usable',
  async (t) => {
    const { first, pin, invocation } = await fixture(t, {
      trustedEnvironment: { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' }
    });
    assert.equal((await invocation.head()).value.oid, first);
    const denied = await invocation.remoteRef({ pin, ref: 'refs/heads/main' });
    assert.equal(denied.code, 'GAL_NETWORK_DISABLED');
    assert.equal(denied.diagnostic.blocked, true);
  });

test('GAL remoteRef distinguishes unavailable authority from an absent advertisement', async (t) => {
  const { base, work, first, invocation } = await fixture(t);
  const missing = path.join(base, 'missing-authority.git');
  git(work, ['config', '--local', 'remote.origin.url', missing]);
  const result = await invocation.remoteRef({
    pin: pinFor(missing, first), ref: 'refs/heads/main'
  });
  assert.equal(result.code, 'GAL_REMOTE_UNAVAILABLE');
  assert.equal(result.diagnostic.remoteClassification, 'remote-not-found');
  assert.equal(JSON.stringify(result).includes(missing), false);
});

test('GAL remoteRef classifies auth denial without returning provider stderr', {
  skip: process.platform === 'win32'
}, async (t) => {
  const { base, work, pin } = await fixture(t);
  const real = await createGitRuntime();
  assert.equal(real.ok, true);
  t.after(() => real.value.dispose());
  const wrapper = path.join(base, 'git-denied-remote-ref');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "ls-remote" ]; then printf "fatal: Authentication failed for SECRET-PROVIDER-TEXT\\n" >&2; exit 128; fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const selected = await createGitRuntime({
    trustedGitPath: wrapper,
    trustedEnvironment: { ...process.env, GAL_TEST_REAL_GIT: real.value.identity.path }
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  t.after(() => selected.value.dispose());
  const opened = await selected.value.openRepository(work);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const result = await opened.value.beginInvocation().remoteRef({ pin, ref: 'refs/heads/main' });
  assert.equal(result.code, 'GAL_REMOTE_DENIED');
  assert.equal(result.diagnostic.remoteClassification, 'authentication-required');
  assert.equal(JSON.stringify(result).includes('SECRET-PROVIDER-TEXT'), false);
});

test('GAL remoteRef discards an answer when local origin changes during the frozen probe', {
  skip: process.platform === 'win32'
}, async (t) => {
  const { base, work, pin } = await fixture(t);
  const replacement = path.join(base, 'replacement.git');
  git(base, ['init', '-q', '--bare', replacement]);
  const real = await createGitRuntime();
  assert.equal(real.ok, true);
  t.after(() => real.value.dispose());
  const wrapper = path.join(base, 'git-changing-origin');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "ls-remote" ]; then "$GAL_TEST_REAL_GIT" -C "$GAL_TEST_WORK" config --local remote.origin.url "$GAL_TEST_REPLACEMENT"; fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const selected = await createGitRuntime({
    trustedGitPath: wrapper,
    trustedEnvironment: {
      ...process.env, GAL_TEST_REAL_GIT: real.value.identity.path,
      GAL_TEST_WORK: work, GAL_TEST_REPLACEMENT: replacement
    }
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  t.after(() => selected.value.dispose());
  const opened = await selected.value.openRepository(work);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const result = await opened.value.beginInvocation().remoteRef({
    pin, ref: 'refs/heads/main', freshness: 'captured', captureKey: 'not-retained'
  });
  assert.equal(result.code, 'GAL_ENDPOINT_CHANGED');
});

test('GAL remoteRef rejects malformed Git framing without accepting a partial observation', {
  skip: process.platform === 'win32'
}, async (t) => {
  const { base, work, pin } = await fixture(t);
  const real = await createGitRuntime();
  assert.equal(real.ok, true);
  t.after(() => real.value.dispose());
  const wrapper = path.join(base, 'git-malformed-remote-ref');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "ls-remote" ]; then printf "not-an-oid\\trefs/heads/main\\n"; exit 0; fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const selected = await createGitRuntime({
    trustedGitPath: wrapper,
    trustedEnvironment: { ...process.env, GAL_TEST_REAL_GIT: real.value.identity.path }
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  t.after(() => selected.value.dispose());
  const opened = await selected.value.openRepository(work);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const result = await opened.value.beginInvocation().remoteRef({ pin, ref: 'refs/heads/main' });
  assert.equal(result.code, 'GAL_PROTOCOL_INVALID');
});

test('GAL remoteRef applies the existing endpoint-specific local authority deadline', {
  skip: process.platform === 'win32'
}, async (t) => {
  const { base, work, pin } = await fixture(t);
  const real = await createGitRuntime();
  assert.equal(real.ok, true);
  t.after(() => real.value.dispose());
  const wrapper = path.join(base, 'git-slow-remote-ref');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "ls-remote" ]; then sleep 2; fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const selected = await createGitRuntime({
    trustedGitPath: wrapper, deadlineMs: 5000,
    trustedEnvironment: {
      ...process.env, GAL_TEST_REAL_GIT: real.value.identity.path,
      SINGULARITY_FLOW_GIT_CONFIGURATION_TIMEOUT_MS: '100'
    }
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  t.after(() => selected.value.dispose());
  const opened = await selected.value.openRepository(work);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const started = Date.now();
  const result = await opened.value.beginInvocation().remoteRef({ pin, ref: 'refs/heads/main' });
  assert.equal(result.code, 'GAL_TIMEOUT');
  assert.equal(result.diagnostic.timedOut, true);
  assert.ok(Date.now() - started < 1800);
});
