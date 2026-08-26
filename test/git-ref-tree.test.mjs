import test from 'node:test';
import assert from 'node:assert/strict';

import { readRefTree, readRefTreeResult } from '../src/git-ref-tree.mjs';

function fakeRepository(files, { corruptAfter = null } = {}) {
  const entries = [...files.entries()].map(([file, content], index) => ({
    file,
    content: Buffer.from(content),
    oid: String(index + 1).padStart(40, '0')
  }));
  const calls = [];
  const runCommand = (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'tree\n', stderr: '' };
    if (args[0] === 'ls-tree') return {
      status: 0,
      stdout: `${entries.map((entry) => `${entry.oid}\t${entry.content.length}\t${entry.file}`).join('\0')}\0`,
      stderr: ''
    };
    const requested = Buffer.from(options.input).toString('utf8').trim().split('\n');
    const chunks = [];
    for (let index = 0; index < requested.length; index += 1) {
      const entry = entries.find((candidate) => candidate.oid === requested[index]);
      if (corruptAfter != null && index >= corruptAfter) break;
      chunks.push(Buffer.from(`${entry.oid} blob ${entry.content.length}\n`), entry.content, Buffer.from('\n'));
    }
    return { status: 0, stdout: Buffer.concat(chunks), stderr: Buffer.alloc(0) };
  };
  return { runCommand, calls };
}

test('aggregate ref state is chunked instead of overflowing one cat-file response', () => {
  const files = new Map(Array.from({ length: 70 }, (_, index) => [
    `singularity/work-items/S-${index}/workflow.json`,
    JSON.stringify({ title: `नमस्ते ${index}` })
  ]));
  const fake = fakeRepository(files);
  const observed = readRefTreeResult('/repository', 'state', ['singularity/work-items'], {
    runCommand: fake.runCommand,
    maxBatchBytes: 256
  });
  assert.equal(observed.status, 'ok');
  assert.equal(observed.objectsRequested, 70);
  assert.equal(observed.objectsRead, 70);
  assert.equal(observed.contents.size, 70);
  assert.ok(fake.calls.filter((call) => call.args[0] === 'cat-file').length > 1,
    'aggregate content is split across bounded cat-file calls');
  assert.equal(fake.calls.every((call) => call.options.env.GIT_NO_LAZY_FETCH === '1'), true,
    'no local object read may start an implicit promisor fetch');
});

test('a truncated batch is partial evidence and the strict reader refuses it', () => {
  const files = new Map([['one.json', '{"one":1}'], ['two.json', '{"two":2}']]);
  const partial = fakeRepository(files, { corruptAfter: 1 });
  const observed = readRefTreeResult('/repository', 'state', [], { runCommand: partial.runCommand });
  assert.equal(observed.status, 'partial');
  assert.equal(observed.objectsRequested, 2);
  assert.equal(observed.objectsRead, 1);
  assert.equal(observed.errors[0].code, 'REF_TREE_BATCH_HEADER_MISSING');
  assert.throws(() => readRefTree('/repository', 'state', [], { runCommand: partial.runCommand }), (error) => {
    assert.equal(error.code, 'REF_TREE_PARTIAL');
    return true;
  });
});

test('a missing ref is distinct from a valid empty tree', () => {
  const missing = readRefTreeResult('/repository', 'gone', [], {
    runCommand: () => ({ status: 1, stdout: '', stderr: 'unknown revision' })
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.contents.size, 0);

  const empty = readRefTreeResult('/repository', 'state', [], {
    runCommand: (_command, args) => args[0] === 'rev-parse'
      ? { status: 0, stdout: 'tree\n', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }
  });
  assert.equal(empty.status, 'ok');
  assert.equal(empty.contents.size, 0);
});

test('Git overflow and timeout remain unavailable causes rather than empty state', () => {
  const listOverflow = readRefTreeResult('/repository', 'state', [], {
    runCommand: (_command, args) => args[0] === 'rev-parse'
      ? { status: 0, stdout: 'tree\n', stderr: '' }
      : { status: null, stdout: '', stderr: '', error: { code: 'ENOBUFS' } }
  });
  assert.equal(listOverflow.status, 'unavailable');
  assert.equal(listOverflow.errors[0].code, 'REF_TREE_LIST_OVERFLOW');

  const refTimeout = readRefTreeResult('/repository', 'state', [], {
    runCommand: () => ({ status: null, stdout: '', stderr: '', timedOut: true })
  });
  assert.equal(refTimeout.status, 'unavailable');
  assert.equal(refTimeout.errors[0].code, 'REF_TREE_REF_TIMEOUT');
});

test('a missing promisor object is explicit partial state with lazy fetch disabled', () => {
  const files = new Map([['one.json', '{"one":1}'], ['two.json', '{"two":2}']]);
  const fake = fakeRepository(files);
  const original = fake.runCommand;
  fake.runCommand = (command, args, options) => {
    if (args[0] !== 'cat-file') return original(command, args, options);
    const requested = Buffer.from(options.input).toString('utf8').trim().split('\n');
    const first = [...files.values()][0];
    return {
      status: 1,
      stdout: Buffer.concat([
        Buffer.from(`${requested[0]} blob ${Buffer.byteLength(first)}\n${first}\n`),
        Buffer.from(`${requested[1]} missing\n`)
      ]),
      stderr: Buffer.from('missing promisor object')
    };
  };
  const observed = readRefTreeResult('/repository', 'state', [], { runCommand: fake.runCommand });
  assert.equal(observed.status, 'partial');
  assert.equal(observed.objectsRead, 1);
  assert.ok(observed.errors.some((entry) => entry.code === 'REF_TREE_OBJECT_MISSING'));
  assert.ok(fake.calls.every((call) => call.options.env.GIT_NO_LAZY_FETCH === '1'));
});
