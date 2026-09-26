import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSkillPackagePath, assertStableSkillCapture, inspectSkillPackage,
  readBoundedSkillFile, SKP_CAPTURE_LIMITS, verifySkillPackage
} from '../src/skp-package.mjs';

async function fixture(t, name = 'portable-skill') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, name);
  await mkdir(directory);
  await writeFile(path.join(directory, 'SKILL.md'), '# Portable\r\n');
  return { root, directory };
}

test('membership digest is portable across file creation order and source directories', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  for (const entry of [first, second]) await mkdir(path.join(entry.directory, 'references'));
  await writeFile(path.join(first.directory, 'references', 'z.md'), 'z\r\n');
  await writeFile(path.join(first.directory, 'references', 'a.md'), 'a\n');
  await writeFile(path.join(second.directory, 'references', 'a.md'), 'a\n');
  await writeFile(path.join(second.directory, 'references', 'z.md'), 'z\r\n');
  const one = await inspectSkillPackage(first.directory);
  const two = await inspectSkillPackage(second.directory);
  assert.equal(one.manifest.packageSha256, two.manifest.packageSha256);
  assert.deepEqual(one.manifest.files.map((file) => file.path),
    ['SKILL.md', 'references/a.md', 'references/z.md']);
  await writeFile(path.join(second.directory, 'references', 'z.md'), 'z\n');
  const changed = await inspectSkillPackage(second.directory);
  assert.notEqual(changed.manifest.packageSha256, one.manifest.packageSha256);
});

test('selected source drift refuses a new binding while retained bytes still verify', async (t) => {
  const { directory } = await fixture(t);
  const retained = await inspectSkillPackage(directory);
  await writeFile(path.join(directory, 'SKILL.md'), '# Updated\n');
  await assert.rejects(inspectSkillPackage(directory, {
    expectedPackageSha256: retained.manifest.packageSha256
  }), { code: 'SKP_SKILL_DRIFT' });
  assert.equal(verifySkillPackage(retained).verified, true);
  retained.contents.set('SKILL.md', Buffer.from('# Corrupt\n'));
  assert.throws(() => verifySkillPackage(retained), { code: 'SKP_PACKAGE_CORRUPT' });
});

test('second-pass byte or membership changes cannot seal a mixed package', () => {
  const first = { directories: ['', 'references'], totalBytes: 3,
    files: new Map([['SKILL.md', Buffer.from('abc')]]) };
  assert.doesNotThrow(() => assertStableSkillCapture(first, {
    directories: ['', 'references'], totalBytes: 3,
    files: new Map([['SKILL.md', Buffer.from('abc')]])
  }));
  assert.throws(() => assertStableSkillCapture(first, {
    directories: ['', 'references'], totalBytes: 3,
    files: new Map([['SKILL.md', Buffer.from('abd')]])
  }), { code: 'SKP_CAPTURE_UNSTABLE' });
  assert.throws(() => assertStableSkillCapture(first, {
    directories: ['', 'references', 'assets'], totalBytes: 3,
    files: new Map([['SKILL.md', Buffer.from('abc')]])
  }), { code: 'SKP_CAPTURE_UNSTABLE' });
});

test('symlinks and non-portable path aliases are refused', async (t) => {
  const { root, directory } = await fixture(t);
  for (const invalid of [
    '../escape.md', 'CON.txt', 'COM¹.txt', '.env', 'a\\b.md', 'name.', 'bad:name.md',
    'a//b.md', 'e\u0301.md'
  ]) {
    assert.throws(() => assertSkillPackagePath(invalid), { code: 'SKP_PATH_REFUSED' }, invalid);
  }
  assert.equal(assertSkillPackagePath('References/Guide.md'), 'references/guide.md');
  assert.equal(assertSkillPackagePath('references/guide.md'), 'references/guide.md');
  const external = path.join(root, 'external.txt');
  await writeFile(external, 'outside');
  await symlink(external, path.join(directory, 'linked.txt'));
  await assert.rejects(inspectSkillPackage(directory), { code: 'SKP_PATH_REFUSED' });
});

test('case aliases collide wherever the host filesystem can represent both names', async (t) => {
  const { directory } = await fixture(t);
  await writeFile(path.join(directory, 'Guide.md'), 'one');
  await writeFile(path.join(directory, 'guide.md'), 'two');
  const names = await readdir(directory);
  if (names.includes('Guide.md') && names.includes('guide.md')) {
    await assert.rejects(inspectSkillPackage(directory), { code: 'SKP_ID_CASE_COLLISION' });
  } else {
    assert.equal(assertSkillPackagePath('Guide.md'), assertSkillPackagePath('guide.md'));
  }
});

test('entry, reference, count, and total budgets refuse complete capture', async (t) => {
  const { directory } = await fixture(t);
  await assert.rejects(inspectSkillPackage(directory, { limits: { entryBytes: 3 } }),
    { code: 'SKP_BUDGET_EXCEEDED', details: { dimension: 'entryBytes', path: 'SKILL.md', limit: 3, actual: 12 } });
  await mkdir(path.join(directory, 'references'));
  await writeFile(path.join(directory, 'references', 'guide.md'), '12345');
  await assert.rejects(inspectSkillPackage(directory, { limits: { referenceBytes: 4 } }),
    { code: 'SKP_BUDGET_EXCEEDED' });
  await assert.rejects(inspectSkillPackage(directory, { limits: { files: 1 } }),
    { code: 'SKP_BUDGET_EXCEEDED' });
  await assert.rejects(inspectSkillPackage(directory, { limits: { totalBytes: 16 } }),
    { code: 'SKP_BUDGET_EXCEEDED' });
  await assert.rejects(inspectSkillPackage(directory, {
    limits: { referenceBytes: SKP_CAPTURE_LIMITS.referenceBytes + 1 }
  }), { code: 'SKP_BUDGET_EXCEEDED' });
});

test('a concurrently growing file is refused after a bounded positional read', async () => {
  const initial = Buffer.from('abc');
  const requests = [];
  const virtualSizeAfterGrowth = 1_000_000_000;
  const handle = {
    async read(buffer, offset, length, position) {
      requests.push({ bufferBytes: buffer.byteLength, length, position });
      if (position >= initial.byteLength) {
        assert.ok(position < virtualSizeAfterGrowth);
        return { bytesRead: 1 }; // the first extra byte reveals the unbounded append
      }
      const count = Math.min(1, length); // exercise a partial read loop
      initial.copy(buffer, offset, position, position + count);
      return { bytesRead: count };
    }
  };
  await assert.rejects(readBoundedSkillFile(handle, initial.byteLength, 3, 'SKILL.md'),
    { code: 'SKP_CAPTURE_UNSTABLE' });
  assert.deepEqual(requests.map((request) => request.position), [0, 1, 2, 3]);
  assert.ok(requests.every((request) => request.bufferBytes <= 3 && request.length <= 3),
    'the reader must never request or allocate based on the grown file size');
  assert.equal(requests.at(-1).length, 1, 'growth detection reads one byte only');
});

test('bounded file reader returns exact bytes and refuses a pre-read budget excess', async () => {
  const source = Buffer.from('abc');
  let calls = 0;
  const handle = {
    async read(buffer, offset, length, position) {
      calls += 1;
      const count = Math.min(length, source.byteLength - position);
      if (count > 0) source.copy(buffer, offset, position, position + count);
      return { bytesRead: count };
    }
  };
  assert.deepEqual(await readBoundedSkillFile(handle, 3, 3, 'SKILL.md'), source);
  await assert.rejects(readBoundedSkillFile(handle, 4, 3, 'SKILL.md'),
    { code: 'SKP_BUDGET_EXCEEDED' });
  await assert.rejects(readBoundedSkillFile(handle, 3, SKP_CAPTURE_LIMITS.entryBytes + 1, 'SKILL.md'),
    { code: 'SKP_BUDGET_EXCEEDED' });
  assert.equal(calls, 2, 'one exact read and one bounded growth probe');
});

test('missing entry and selected folder fail explicitly', async (t) => {
  const { directory } = await fixture(t);
  await rm(path.join(directory, 'SKILL.md'));
  await assert.rejects(inspectSkillPackage(directory), { code: 'SKP_SKILL_MISSING' });
  await assert.rejects(inspectSkillPackage(path.join(directory, 'absent')),
    { code: 'SKP_SKILL_MISSING' });
});
