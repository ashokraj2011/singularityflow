import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readLocalGitBlobs } from '../src/git-blob-batch.mjs';
import { withLocalReadDeadline } from '../src/local-read-deadline.mjs';
import { run } from '../src/util.mjs';

function git(root, args, { input, encoding = 'utf8', env = process.env } = {}) {
  const result = spawnSync('git', args, {
    cwd: root, env, input, encoding, timeout: 10_000
  });
  assert.equal(result.status, 0, String(result.stderr || result.error || args.join(' ')));
  return result.stdout;
}

function objectId(format, body) {
  return createHash(format)
    .update(`blob ${body.length}\0`, 'utf8')
    .update(body)
    .digest('hex');
}

for (const format of ['sha1', 'sha256']) {
  test(`raw ${format} blob reads retain exact bytes despite a replacement ref`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), `sflow-raw-${format}-`));
    try {
      const initialized = spawnSync('git', [
        'init', '--quiet', ...(format === 'sha256' ? ['--object-format=sha256'] : [])
      ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      if (initialized.status !== 0 && format === 'sha256') {
        t.skip('This Git does not support SHA-256 repositories.');
        return;
      }
      assert.equal(initialized.status, 0, initialized.stderr || String(initialized.error));
      assert.equal(git(root, ['rev-parse', '--show-object-format']).trim(), format);

      const original = Buffer.from([0, 13, 10, 255, 128, 65, 0, 66, 10]);
      const replacement = Buffer.from('replacement bytes with a different length\n');
      const originalOid = git(root, ['hash-object', '-w', '--stdin'], { input: original }).trim();
      const replacementOid = git(root, ['hash-object', '-w', '--stdin'], { input: replacement }).trim();
      assert.equal(originalOid, objectId(format, original));
      git(root, ['replace', originalOid, replacementOid]);

      const replacementEnabledEnv = { ...process.env };
      delete replacementEnabledEnv.GIT_NO_REPLACE_OBJECTS;
      const substituted = git(root, ['cat-file', 'blob', originalOid], {
        encoding: null, env: replacementEnabledEnv
      });
      assert.deepEqual(substituted, replacement, 'the fixture must actually activate replacement');

      const blobs = readLocalGitBlobs(root, [originalOid, originalOid], {
        env: {
          ...replacementEnabledEnv,
          GIT_NO_REPLACE_OBJECTS: '0',
          GIT_NO_LAZY_FETCH: '0'
        }
      });
      assert.equal(blobs.size, 1);
      assert.deepEqual(blobs.get(originalOid), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('blob IDs must be complete and match the repository storage format', () => {
  const calls = [];
  const runCommand = (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'sha1\n' };
    throw new Error('Invalid OID must not reach cat-file.');
  };
  assert.throws(() => readLocalGitBlobs('/repository', ['a'.repeat(48)], { runCommand }),
    { code: 'GIT_BLOB_BATCH_INVALID' });
  assert.equal(calls.length, 0, 'an intermediate-length OID is refused before Git runs');

  assert.throws(() => readLocalGitBlobs('/repository', ['a'.repeat(64)], { runCommand }),
    { code: 'GIT_BLOB_BATCH_INVALID' });
  assert.equal(calls.length, 1, 'a full OID for the wrong format is refused before cat-file');
  assert.deepEqual(calls[0].args, ['rev-parse', '--show-object-format']);
  assert.equal(calls[0].options.env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(calls[0].options.env.GIT_NO_LAZY_FETCH, '1');
});

test('a well-framed but hash-mismatched blob is rejected', () => {
  const original = Buffer.from([0, 10, 13, 255, 0]);
  const corrupt = Buffer.from([0, 10, 13, 254, 0]);
  const oid = objectId('sha1', original);
  const calls = [];
  const runCommand = (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'sha1\n' };
    if (args[1].startsWith('--batch-check')) return {
      status: 0, stdout: `${oid} blob ${original.length}\n`
    };
    return {
      status: 0,
      stdout: Buffer.concat([
        Buffer.from(`${oid} blob ${corrupt.length}\n`), corrupt, Buffer.from('\n')
      ])
    };
  };
  assert.throws(() => readLocalGitBlobs('/repository', [oid], { runCommand }), (error) => {
    assert.equal(error.code, 'GIT_BLOB_BATCH_INVALID');
    assert.match(error.message, /do not match the requested object identity/);
    return true;
  });
  // The single read sees the mismatch and hands over; the sized read refuses it.
  assert.deepEqual(calls.map(({ args }) => args[1] ?? args[0]), ['--show-object-format', '--batch',
    '--batch-check=%(objectname) %(objecttype) %(objectsize)', '--batch']);
  assert.equal(calls.every(({ options }) => options.env.GIT_NO_REPLACE_OBJECTS === '1'), true);
  assert.equal(calls.every(({ options }) => options.env.GIT_NO_LAZY_FETCH === '1'), true);
});

test('content requests split at the bounded object-count ceiling', () => {
  const bodies = Array.from({ length: 513 }, (_, index) => Buffer.from(`blob-${index}`));
  const entries = bodies.map((body) => ({ oid: objectId('sha1', body), body }));
  const byOid = new Map(entries.map((entry) => [entry.oid, entry.body]));
  let contentCalls = 0;
  const runCommand = (_command, args, options) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'sha1\n' };
    const requested = String(options.input).trim().split('\n');
    if (args[1].startsWith('--batch-check')) return {
      status: 0,
      stdout: requested.map((oid) => `${oid} blob ${byOid.get(oid).length}`).join('\n') + '\n'
    };
    contentCalls += 1;
    assert.ok(requested.length <= 512);
    return {
      status: 0,
      stdout: Buffer.concat(requested.flatMap((oid) => [
        Buffer.from(`${oid} blob ${byOid.get(oid).length}\n`), byOid.get(oid), Buffer.from('\n')
      ]))
    };
  };
  const result = readLocalGitBlobs('/repository', entries.map(({ oid }) => oid), {
    runCommand, maximumBatchBytes: 1024 * 1024
  });
  assert.equal(result.size, 513);
  assert.equal(contentCalls, 2);
});

function blobRepository(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sflow-blob-reads-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet']);
  const write = (body) => git(root, ['hash-object', '-w', '--stdin'], { input: body }).trim();
  const calls = [];
  const runCommand = (command, args, options) => { calls.push(args[1] ?? args[0]); return run(command, args, options); };
  return { root, write, calls, runCommand };
}

test('a small set is read with one cat-file process and the same verified bytes', (t) => {
  const { root, write, calls, runCommand } = blobRepository(t);
  const first = Buffer.from([0, 10, 255, 13, 10]);
  const empty = Buffer.alloc(0);
  const [firstOid, emptyOid] = [write(first), write(empty)];
  const blobs = readLocalGitBlobs(root, [firstOid, emptyOid, firstOid], { runCommand, maximumBytes: 64 });
  assert.deepEqual([...blobs.keys()], [firstOid, emptyOid]);
  assert.deepEqual(blobs.get(firstOid), first);
  assert.deepEqual(blobs.get(emptyOid), empty);
  assert.deepEqual(calls, ['--show-object-format', '--batch'], 'no separate sizing process');
});

test('what one read cannot prove is refused by the sized read, exactly as before', async (t) => {
  const { root, write, calls, runCommand } = blobRepository(t);
  const large = Buffer.alloc(4096, 7);
  const largeOid = write(large);
  const sized = ['--show-object-format', '--batch', '--batch-check=%(objectname) %(objecttype) %(objectsize)'];

  const missing = 'f'.repeat(40);
  assert.throws(() => readLocalGitBlobs(root, [missing], { runCommand, code: 'X_UNAVAILABLE' }), (error) => {
    assert.equal(error.code, 'X_UNAVAILABLE');
    assert.match(error.message, /unavailable, unsupported, or oversized object/);
    assert.deepEqual(error.details, { object: missing, maximumObjectBytes: Number.POSITIVE_INFINITY });
    return true;
  });
  assert.deepEqual(calls.splice(0), sized);

  assert.throws(() => readLocalGitBlobs(root, [largeOid], { runCommand, maximumObjectBytes: 1024, limitCode: 'X_LIMIT' }), (error) => {
    assert.equal(error.code, 'X_LIMIT');
    assert.deepEqual(error.details, { object: largeOid, bytes: 4096, maximumObjectBytes: 1024 });
    return true;
  });
  assert.deepEqual(calls.splice(0), sized, 'a full buffer hands over to the sized read');

  // A scoped read deadline refuses a full buffer itself, so reads under one keep the sized read.
  await withLocalReadDeadline(10_000, async () => {
    assert.deepEqual(readLocalGitBlobs(root, [largeOid], { runCommand }).get(largeOid), large);
  });
  assert.deepEqual(calls.splice(0), ['--show-object-format',
    '--batch-check=%(objectname) %(objecttype) %(objectsize)', '--batch']);
});

test('the object format is asked once per checkout, and again for a repository recreated in place', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sflow-object-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const module = new URL('../src/git-blob-batch.mjs', import.meta.url).href;
  const script = `import { repositoryObjectFormat } from ${JSON.stringify(module)};
import { rmSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
const root = process.argv[1]; const formats = [];
for (let i = 0; i < 3; i += 1) formats.push(repositoryObjectFormat(root));
if (process.argv[2] === 'recreate') {
  rmSync(root + '/.git', { recursive: true, force: true });
  if (spawnSync('git', ['init', '-q', '--object-format=sha256'], { cwd: root }).status !== 0) { console.log(JSON.stringify({ skip: true })); process.exit(0); }
  formats.push(repositoryObjectFormat(root));
}
console.log(JSON.stringify({ formats }));`;
  const runChild = (mode) => spawnSync(process.execPath, ['--input-type=module', '-e', script, root, mode], {
    encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' }, timeout: 30_000
  });
  git(root, ['init', '--quiet']);
  const same = runChild('same');
  assert.equal(same.status, 0, same.stderr);
  assert.deepEqual(JSON.parse(same.stdout.trim().split('\n').at(-1)).formats, ['sha1', 'sha1', 'sha1']);
  assert.match(same.stderr, /^\s+1x\s+\d+ ms\s+git rev-parse --show-object-format/mu, 'one Git process for three answers');
  const recreated = runChild('recreate');
  const report = JSON.parse(recreated.stdout.trim().split('\n').at(-1));
  if (report.skip) { t.skip('This Git does not support SHA-256 repositories.'); return; }
  assert.deepEqual(report.formats, ['sha1', 'sha1', 'sha1', 'sha256'], 'a new .git at the same path is asked afresh');
});
