import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGitRuntime } from '../src/git-access.mjs';

function git(cwd, args, input = undefined) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, String(result.stderr || result.error || args.join(' ')));
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-typed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'GAL Typed Test']);
  git(root, ['config', 'user.email', 'gal-typed@example.test']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], Buffer.from([0, 255, 10]));
  git(root, ['update-ref', 'refs/heads/main', git(root, ['commit-tree', git(root, ['mktree'], ''), '-m', 'head'])]);
  const created = await createGitRuntime();
  assert.equal(created.ok, true, JSON.stringify(created));
  t.after(() => created.value.dispose());
  const opened = await created.value.openRepository(root);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return { root, blob, commit: git(root, ['rev-parse', 'HEAD']), invocation: opened.value.beginInvocation() };
}

function makeTree(root, rows) {
  const result = spawnSync('git', ['mktree', '-z'], {
    cwd: root, input: Buffer.concat(rows.map(({ mode, type, oid, name }) => Buffer.concat([
      Buffer.from(`${mode} ${type} ${oid}\t`, 'ascii'), Buffer.from(name), Buffer.from([0])
    ]))), encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, String(result.stderr || result.error));
  return result.stdout.trim();
}

test('GAL exact tree listing retains modes, gitlinks and non-UTF-8 path bytes', async (t) => {
  const { root, blob, commit, invocation } = await fixture(t);
  const child = makeTree(root, [{ mode: '100644', type: 'blob', oid: blob, name: 'inner.txt' }]);
  const tree = makeTree(root, [
    { mode: '040000', type: 'tree', oid: child, name: 'dir' },
    { mode: '100755', type: 'blob', oid: blob, name: 'exec.sh' },
    { mode: '120000', type: 'blob', oid: blob, name: 'link' },
    { mode: '160000', type: 'commit', oid: commit, name: 'submodule' },
    { mode: '100644', type: 'blob', oid: blob, name: Buffer.from([0x62, 0x61, 0x64, 0xff]) },
    { mode: '100644', type: 'blob', oid: blob, name: 'line\nbreak' }
  ]);
  const listed = await invocation.tree({ oid: tree });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.value.treeOid, tree);
  assert.equal(listed.value.entries.length, 6);
  assert.deepEqual(listed.value.entries.find((entry) => entry.path.text === 'dir'), {
    path: { bytes: Buffer.from('dir'), text: 'dir', base64: null },
    mode: '040000', objectType: 'tree', oid: child, size: null
  });
  assert.equal(listed.value.entries.find((entry) => entry.path.text === 'exec.sh').mode, '100755');
  assert.equal(listed.value.entries.find((entry) => entry.path.text === 'link').mode, '120000');
  assert.equal(listed.value.entries.find((entry) => entry.path.text === 'submodule').objectType, 'commit');
  const unusual = listed.value.entries.find((entry) => entry.path.text === null);
  assert.deepEqual(unusual.path.bytes, Buffer.from([0x62, 0x61, 0x64, 0xff]));
  assert.equal(unusual.path.base64, Buffer.from([0x62, 0x61, 0x64, 0xff]).toString('base64'));
  assert.equal(listed.value.entries.find((entry) => entry.path.text === 'line\nbreak').size, 3);
  unusual.path.bytes[0] = 0;
  assert.deepEqual((await invocation.tree({ oid: tree })).value.entries.find((entry) => entry.path.text === null)
    .path.bytes, Buffer.from([0x62, 0x61, 0x64, 0xff]));
  const scoped = await invocation.tree({ oid: tree, recursive: true, scope: 'dir' });
  assert.equal(scoped.ok, true, JSON.stringify(scoped));
  assert.deepEqual(scoped.value.entries.map((entry) => entry.path.text), ['dir/inner.txt']);
  assert.equal((await invocation.tree({ oid: tree, scope: 'dir' })).code, 'GAL_INPUT_INVALID');
  assert.equal((await invocation.tree({ oid: tree, recursive: true, scope: '../dir' })).code,
    'GAL_INPUT_INVALID');
  assert.equal((await invocation.tree({ oid: blob })).code, 'GAL_WRONG_OBJECT_TYPE');
  assert.equal((await invocation.tree({ oid: 'f'.repeat(40) })).code, 'GAL_OBJECT_UNAVAILABLE');
  assert.equal((await invocation.tree({ oid: '--upload-pack=attacker' })).code, 'GAL_INPUT_INVALID');
});

test('GAL refs provide exact full names, symbolic targets and peeled tag IDs with fresh captures', async (t) => {
  const { root, commit, invocation } = await fixture(t);
  git(root, ['tag', '-a', 'v1', '-m', 'tagged']);
  git(root, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/main']);
  git(root, ['branch', 'café']);
  const listed = await invocation.refs({ includePeeled: true });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const alias = listed.value.entries.find((entry) => entry.ref === 'refs/heads/alias');
  assert.equal(alias.symbolicRef, 'refs/heads/main');
  assert.equal(alias.oid, commit);
  const tag = listed.value.entries.find((entry) => entry.ref === 'refs/tags/v1');
  assert.equal(tag.objectType, 'tag');
  assert.equal(tag.peeledOid, commit);
  const unicode = listed.value.entries.find((entry) => entry.ref === 'refs/heads/café');
  assert.deepEqual(unicode.refBytes, Buffer.from('refs/heads/café'));
  const captured = await invocation.refs({ prefix: 'refs/heads', freshness: 'captured', captureKey: 'first' });
  assert.ok(Buffer.isBuffer(captured.value.entries[0].refBytes));
  const capturedAgain = await invocation.refs({ prefix: 'refs/heads', freshness: 'captured', captureKey: 'first' });
  assert.ok(Buffer.isBuffer(capturedAgain.value.entries[0].refBytes));
  captured.value.entries[0].refBytes[0] = 0;
  assert.equal(capturedAgain.value.entries[0].refBytes[0], 0x72);
  git(root, ['branch', 'later']);
  assert.deepEqual((await invocation.refs({ prefix: 'refs/heads', freshness: 'captured', captureKey: 'first' }))
    .value.entries, capturedAgain.value.entries);
  assert.ok((await invocation.refs({ prefix: 'refs/heads' })).value.entries
    .some((entry) => entry.ref === 'refs/heads/later'));
  assert.equal((await invocation.refs({ prefix: '--bad' })).code, 'GAL_INPUT_INVALID');
  assert.equal((await invocation.refs({ prefix: 'refs/heads', captureKey: 'bad' })).code,
    'GAL_INPUT_INVALID');
  git(root, ['tag', '-a', 'v2', 'v1', '-m', 'nested']);
  const nested = await invocation.refs({ includePeeled: true });
  assert.equal(nested.ok, true, JSON.stringify(nested));
  assert.equal(nested.value.entries.find((entry) => entry.ref === 'refs/tags/v2').peeledOid,
    commit);
});

test('GAL approved config preserves complete value bytes and excludes unapproved keys', async (t) => {
  const { root, invocation } = await fixture(t);
  git(root, ['config', '--local', '--add', 'remote.origin.url', ' https://example.test/one ']);
  git(root, ['config', '--local', '--add', 'remote.origin.url', 'https://example.test/two\npath']);
  const config = await invocation.config({ keys: ['remote.origin.url', 'core.filemode'] });
  assert.equal(config.ok, true, JSON.stringify(config));
  assert.deepEqual(config.value.entries[0].values.map((value) => value.text), [
    ' https://example.test/one ', 'https://example.test/two\npath'
  ]);
  assert.deepEqual(config.value.entries[0].values[1].bytes,
    Buffer.from('https://example.test/two\npath'));
  const captured = await invocation.config({
    keys: ['remote.origin.url'], freshness: 'captured', captureKey: 'remote'
  });
  assert.ok(Buffer.isBuffer(captured.value.entries[0].values[0].bytes));
  git(root, ['config', '--local', '--add', 'remote.origin.url', 'https://example.test/three']);
  assert.deepEqual((await invocation.config({
    keys: ['remote.origin.url'], freshness: 'captured', captureKey: 'remote'
  })).value, captured.value);
  assert.equal((await invocation.config({ keys: ['remote.origin.url'] })).value.entries[0].values.length, 3);
  assert.deepEqual((await invocation.config({ keys: ['extensions.objectformat'] })).value.entries[0].values, []);
  assert.equal((await invocation.config({ keys: ['credential.helper'] })).code, 'GAL_INPUT_INVALID');
  assert.equal((await invocation.config({ keys: ['remote.origin.url', 'remote.origin.url'] })).code,
    'GAL_INPUT_INVALID');
  assert.equal((await invocation.config({ keys: [] })).code, 'GAL_INPUT_INVALID');
});

test('GAL typed reads refuse malformed framing without treating it as empty', {
  skip: process.platform === 'win32'
}, async (t) => {
  const { root } = await fixture(t);
  const found = await createGitRuntime();
  assert.equal(found.ok, true, JSON.stringify(found));
  const realGit = found.value;
  t.after(() => realGit.dispose());
  const wrapper = path.join(root, 'git-malformed-reads');
  await writeFile(wrapper, '#!/bin/sh\n'
    + 'if [ "$1" = "ls-tree" ]; then printf "not-a-tree-record\\000"; exit 0; fi\n'
    + 'if [ "$1" = "for-each-ref" ]; then printf "not-a-ref-record"; exit 0; fi\n'
    + 'if [ "$1" = "config" ] && [ "$2" = "--null" ]; then printf "unterminated"; exit 0; fi\n'
    + 'exec "$GAL_TEST_REAL_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const selected = await createGitRuntime({
    trustedGitPath: wrapper,
    trustedEnvironment: { ...process.env, GAL_TEST_REAL_GIT: realGit.identity.path }
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  t.after(() => selected.value.dispose());
  const opened = await selected.value.openRepository(root);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const invocation = opened.value.beginInvocation();
  const treeOid = git(root, ['rev-parse', 'HEAD^{tree}']);
  assert.equal((await invocation.tree({ oid: treeOid })).code, 'GAL_PROTOCOL_INVALID');
  assert.equal((await invocation.refs()).code, 'GAL_PROTOCOL_INVALID');
  assert.equal((await invocation.config({ keys: ['core.filemode'] })).code, 'GAL_PROTOCOL_INVALID');
});

test('GAL tree and refs enforce the repository SHA-256 object format', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-typed-sha256-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-q', '--object-format=sha256', '-b', 'main'], {
    cwd: root, encoding: 'utf8', timeout: 10_000
  });
  if (initialized.status !== 0) {
    t.diagnostic('This Git does not support SHA-256 repositories.');
    return;
  }
  const blob = git(root, ['hash-object', '-w', '--stdin'], Buffer.from('sha256 tree\n'));
  const treeOid = makeTree(root, [{ mode: '100644', type: 'blob', oid: blob, name: 'file' }]);
  const created = await createGitRuntime();
  assert.equal(created.ok, true, JSON.stringify(created));
  t.after(() => created.value.dispose());
  const opened = await created.value.openRepository(root);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const invocation = opened.value.beginInvocation();
  assert.equal(invocation.identity.objectFormat, 'sha256');
  const tree = await invocation.tree({ oid: treeOid });
  assert.equal(tree.ok, true, JSON.stringify(tree));
  assert.equal(tree.value.entries[0].oid, blob);
  assert.equal((await invocation.tree({ oid: 'a'.repeat(40) })).code, 'GAL_INPUT_INVALID');
  assert.deepEqual((await invocation.refs()).value.entries, []);
});
