import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceTreeHash, testInputTreeHash } from '../src/state.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function repository(t, objectFormat = 'sha1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-source-publication-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(root, 'init', '-q', `--object-format=${objectFormat}`);
  git(root, 'config', 'user.name', 'Source Test');
  git(root, 'config', 'user.email', 'source@example.invalid');
  git(root, 'config', 'core.autocrlf', 'true');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/app.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'runner.txt'), 'runner = 1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}

test('source and separate test-input bindings survive CRLF staging/publication without hiding edits', async t => {
  const root = await repository(t);
  const workflow = { resolution: { capability: { sourceScope: {
    testConfigurationPaths: ['runner.txt']
  } } } };
  await writeFile(path.join(root, 'src/app.mjs'), 'export const value = 2;\r\n');
  await writeFile(path.join(root, 'src/café space.mjs'), 'export const extra = true;\r\n');
  await writeFile(path.join(root, 'runner.txt'), 'runner = 2\r\n');
  const index = await readFile(path.join(root, '.git/index'));
  const objects = git(root, 'count-objects', '-v');
  const source = await sourceTreeHash(root, {}, workflow);
  const input = await testInputTreeHash(root, {}, workflow);
  assert.deepEqual(await readFile(path.join(root, '.git/index')), index, 'read-only hashing must not stage changes');
  assert.equal(git(root, 'count-objects', '-v'), objects, 'read-only hashing must not write Git objects');
  git(root, 'add', '.');
  assert.equal(await sourceTreeHash(root, {}, workflow), source, 'staging uses the same canonical source bytes');
  assert.equal(await testInputTreeHash(root, {}, workflow), input);
  git(root, 'commit', '-qm', 'publish');
  assert.equal(await sourceTreeHash(root, {}, workflow), source, 'publication must not invalidate its own receipt');
  assert.equal(await testInputTreeHash(root, {}, workflow), input);
  await writeFile(path.join(root, 'src/app.mjs'), 'export const value = 3;\r\n');
  assert.notEqual(await sourceTreeHash(root, {}, workflow), source, 'real application changes remain stale');
  await writeFile(path.join(root, 'runner.txt'), 'runner = 3\r\n');
  assert.notEqual(await testInputTreeHash(root, {}, workflow), input, 'real test-input changes remain stale');
});

test('canonical source hashes preserve executable Git modes and SHA-256 object repositories', async t => {
  for (const format of ['sha1', 'sha256']) {
    const root = await repository(t, format);
    await chmod(path.join(root, 'src/app.mjs'), 0o755);
    git(root, 'update-index', '--chmod=+x', 'src/app.mjs');
    git(root, 'commit', '-qm', 'executable mode');
    await writeFile(path.join(root, 'src/app.mjs'), 'export const value = 2;\r\n');
    const before = await sourceTreeHash(root);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'publish executable');
    assert.equal(await sourceTreeHash(root), before, format);
  }
});

test('built-in working-tree encoding is bound to the bytes Git actually publishes', async t => {
  const root = await repository(t);
  await writeFile(path.join(root, '.gitattributes'), '*.utf16 text working-tree-encoding=UTF-16LE\n');
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-qm', 'encoding policy');
  await writeFile(path.join(root, 'src/encoded.utf16'), Buffer.from('value = 2\r\n', 'utf16le'));
  const before = await sourceTreeHash(root);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'publish encoded input');
  assert.equal(await sourceTreeHash(root), before);
});

test('source hashing respects binary and explicit -text bytes and never executes repository clean filters', async t => {
  const root = await repository(t);
  await writeFile(path.join(root, '.gitattributes'), '*.bin -text\n*.raw -text\n*.mjs filter=spy\n');
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-qm', 'attributes');
  git(root, 'config', 'filter.spy.clean', 'echo touched > .git/filter-ran');
  git(root, 'config', 'filter.spy.required', 'true');
  await writeFile(path.join(root, 'src/app.mjs'), 'export const value = 2;\r\n');
  await writeFile(path.join(root, 'src/data.bin'), Buffer.from([0, 1, 13, 10, 2]));
  await writeFile(path.join(root, 'src/data.raw'), 'raw\r\n');
  const before = await sourceTreeHash(root);
  await assert.rejects(access(path.join(root, '.git/filter-ran')), { code: 'ENOENT' });
  await writeFile(path.join(root, 'src/data.raw'), 'raw\n');
  assert.notEqual(await sourceTreeHash(root), before, '-text content is never normalized');
  const changed = await sourceTreeHash(root);
  await writeFile(path.join(root, 'src/data.bin'), Buffer.from([0, 1, 10, 2]));
  assert.notEqual(await sourceTreeHash(root), changed, 'binary CR bytes remain significant');
});
