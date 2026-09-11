import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readStableReleaseJson, writeReleaseFileNoClobber, writeReleaseJsonNoClobber
} from '../src/secure-release-files.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-release-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function absent(file) {
  return (await lstat(file).catch(() => null)) == null;
}

test('stable release JSON reads one bounded ordinary UTF-8 file', async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, 'receipt.json');
  await writeFile(file, '{"trusted":true}\n');
  const result = await readStableReleaseJson(file, { label: 'Receipt', maxBytes: 64 });
  assert.deepEqual(result.value, { trusted: true });
  assert.equal(result.path, file);

  await writeFile(file, Buffer.alloc(65, 0x20));
  await assert.rejects(readStableReleaseJson(file, { label: 'Receipt', maxBytes: 64 }),
    /ordinary file from 1 to 64 bytes/);
  await writeFile(file, Buffer.from([0xff]));
  await assert.rejects(readStableReleaseJson(file, { label: 'Receipt', maxBytes: 64 }),
    /not valid UTF-8/);
});

test('stable release JSON refuses a final-component symlink', async (t) => {
  const directory = await fixture(t);
  const target = path.join(directory, 'target.json');
  const linked = path.join(directory, 'linked.json');
  await writeFile(target, '{"trusted":false}\n');
  await symlink(target, linked);
  await assert.rejects(readStableReleaseJson(linked), /ordinary file/);
});

test('release output is a synced atomic no-clobber claim', async (t) => {
  const directory = await fixture(t);
  const output = path.join(directory, 'receipt.json');
  assert.equal(await writeReleaseJsonNoClobber(output, { complete: true }), await realpath(output));
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { complete: true });
  await assert.rejects(writeReleaseJsonNoClobber(output, { complete: false }),
    (error) => error?.code === 'EEXIST');
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { complete: true });
  assert.deepEqual((await readdir(directory)).sort(), ['receipt.json']);
});

test('failed and interrupted receipt publication never leaves partial final bytes', async (t) => {
  const directory = await fixture(t);
  const before = path.join(directory, 'before.json');
  await assert.rejects(writeReleaseFileNoClobber(before, 'complete\n', {
    beforeClaim() { throw new Error('before claim'); }
  }), /before claim/);
  assert.equal(await absent(before), true);

  const after = path.join(directory, 'after.json');
  await assert.rejects(writeReleaseFileNoClobber(after, 'complete\n', {
    afterClaim() { throw new Error('simulated process death after claim'); }
  }), /simulated process death/);
  assert.equal(await readFile(after, 'utf8'), 'complete\n');
  assert.deepEqual((await readdir(directory)).sort(), ['after.json']);
});

test('release output filenames have a portable component boundary', async (t) => {
  const directory = await fixture(t);
  await assert.rejects(
    writeReleaseFileNoClobber(path.join(directory, `${'a'.repeat(256)}.json`), 'complete\n'),
    /portable filesystem boundary/
  );
});
