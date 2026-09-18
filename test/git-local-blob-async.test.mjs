import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { readLocalGitBlobsAsync } from '../src/git-local-blob-async.mjs';

const oidFor = (body) => createHash('sha1').update(`blob ${body.length}\0`).update(body)
  .digest('hex');

function fakeCommands(entries, content = null) {
  const byOid = new Map(entries.map((body) => [oidFor(body), body]));
  const batches = [];
  const runCommand = async (_executable, args, options) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: Buffer.from('sha1\n') };
    const requested = options.input.toString('utf8').trimEnd().split('\n');
    if (args[1].startsWith('--batch-check')) return {
      status: 0,
      stdout: Buffer.from(requested.map((oid) => `${oid} blob ${byOid.get(oid).length}\n`).join(''))
    };
    batches.push(requested);
    return {
      status: 0,
      stdout: content?.(requested, byOid) ?? Buffer.concat(requested.flatMap((oid) => [
        Buffer.from(`${oid} blob ${byOid.get(oid).length}\n`), byOid.get(oid), Buffer.from('\n')
      ]))
    };
  };
  return { runCommand, batches };
}

test('async blob transport splits at 512 objects and returns exact non-UTF-8 bytes', async () => {
  const bodies = Array.from({ length: 513 }, (_, index) =>
    Buffer.from([index & 0xff, index >> 8, 0, 255, 10]));
  const { runCommand, batches } = fakeCommands(bodies);
  const values = await readLocalGitBlobsAsync('/repository', bodies.map(oidFor), {
    executable: '/trusted/git', env: {}, runCommand
  });
  assert.equal(values.size, 513);
  assert.deepEqual(batches.map((batch) => batch.length), [512, 1]);
  assert.deepEqual(values.get(oidFor(bodies[512])), bodies[512]);
});

test('format, admission, and content commands share one absolute deadline', async () => {
  const body = Buffer.from('deadline');
  const { runCommand } = fakeCommands([body]);
  const deadlines = [];
  const value = await readLocalGitBlobsAsync('/repository', [oidFor(body)], {
    executable: '/trusted/git', env: {}, deadlineMs: 1_000,
    runCommand(executable, args, options) {
      deadlines.push(options.deadlineAt);
      return runCommand(executable, args, options);
    }
  });
  assert.deepEqual(value.get(oidFor(body)), body);
  assert.equal(deadlines.length, 3);
  assert.equal(new Set(deadlines).size, 1);
});

test('async blob transport rejects malformed framing, trailing output, and hash mismatch', async () => {
  const body = Buffer.from([0, 255, 10, 13]);
  const oid = oidFor(body);
  const cases = [
    Buffer.from(`${oid} blob 4\nBAD!\n`),
    Buffer.concat([Buffer.from(`${oid} blob 4\n`), body]),
    Buffer.concat([Buffer.from(`${oid} blob 4\n`), body, Buffer.from('\nextra')]),
    Buffer.concat([Buffer.from(`${oid} tree 4\n`), body, Buffer.from('\n')])
  ];
  for (const output of cases) {
    const { runCommand } = fakeCommands([body], () => output);
    await assert.rejects(readLocalGitBlobsAsync('/repository', [oid], {
      executable: '/trusted/git', env: {}, runCommand
    }), { code: 'GIT_BLOB_BATCH_INVALID' });
  }
});

test('async blob transport enforces object and aggregate admission before content reads', async () => {
  const bodies = [Buffer.from('first'), Buffer.from('second')];
  const { runCommand, batches } = fakeCommands(bodies);
  await assert.rejects(readLocalGitBlobsAsync('/repository', bodies.map(oidFor), {
    executable: '/trusted/git', env: {}, runCommand, maximumObjectBytes: 5
  }), { code: 'GAL_LIMIT_EXCEEDED' });
  await assert.rejects(readLocalGitBlobsAsync('/repository', bodies.map(oidFor), {
    executable: '/trusted/git', env: {}, runCommand, maximumBytes: 10
  }), { code: 'GAL_LIMIT_EXCEEDED' });
  await assert.rejects(readLocalGitBlobsAsync('/repository', bodies.map(oidFor), {
    executable: '/trusted/git', env: {}, runCommand,
    maximumObjectBytes: 100, maximumBatchBytes: 4
  }), { code: 'GAL_LIMIT_EXCEEDED' });
  assert.deepEqual(batches, []);
});

test('async blob transport rejects invalid numeric ceilings before spawning', async () => {
  const body = Buffer.from('body');
  const oid = oidFor(body);
  for (const invalid of [
    { maximumBytes: Number.NaN }, { maximumBytes: -1 },
    { maximumObjectBytes: Number.POSITIVE_INFINITY }, { maximumObjectBytes: -1 },
    { maximumBatchBytes: 0 }, { maximumBatchBytes: Number.NaN },
    { deadlineMs: -1 }, { deadlineMs: Number.NaN }
  ]) {
    await assert.rejects(readLocalGitBlobsAsync('/repository', [oid], {
      executable: '/trusted/git', env: {}, ...invalid,
      runCommand: () => { throw new Error('Invalid limits must not spawn Git.'); }
    }), { code: 'GIT_BLOB_BATCH_INVALID' });
  }
});

test('async blob transport refuses object format and check-stage protocol corruption', async () => {
  const body = Buffer.from('hi');
  const oid = oidFor(body);
  const { runCommand } = fakeCommands([body]);
  await assert.rejects(readLocalGitBlobsAsync('/repository', [oid], {
    executable: '/trusted/git', env: {},
    runCommand: async (executable, args, options) => args[0] === 'rev-parse'
      ? { status: 0, stdout: Buffer.from('sha256\n') }
      : runCommand(executable, args, options)
  }), { code: 'GIT_BLOB_BATCH_INVALID' });
  await assert.rejects(readLocalGitBlobsAsync('/repository', [oid], {
    executable: '/trusted/git', env: {},
    runCommand: async (executable, args, options) => args[1]?.startsWith('--batch-check')
      ? { status: 0, stdout: Buffer.from(`${oid} blob 2\nJUNK\n`) }
      : runCommand(executable, args, options)
  }), { code: 'GIT_BLOB_BATCH_INVALID' });
});
