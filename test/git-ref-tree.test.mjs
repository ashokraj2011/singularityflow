import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readRefTree, readRefTreeResult } from '../src/git-ref-tree.mjs';

const TREE_OID = 'a'.repeat(40);

function blobOid(content, algorithm = 'sha1') {
  const body = Buffer.from(content);
  return createHash(algorithm).update(`blob ${body.length}\0`).update(body).digest('hex');
}

function fakeRepository(files, { corruptAfter = null, algorithm = 'sha1' } = {}) {
  const entries = [...files.entries()].map(([file, content]) => ({
    file,
    content: Buffer.from(content),
    oid: blobOid(content, algorithm)
  }));
  const calls = [];
  const runCommand = (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${algorithm === 'sha256' ? 'a'.repeat(64) : TREE_OID}\n`, stderr: '' };
    if (args[0] === 'ls-tree') return {
      status: 0,
      stdout: `${entries.map((entry) => `100644\tblob\t${entry.oid}\t${entry.content.length}\t${entry.file}`).join('\0')}\0`,
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
  return { runCommand, calls, entries };
}

function git(root, args, input = undefined) {
  const child = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout.trim();
}

function realRepository(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'sflow-ref-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  mkdirSync(path.join(root, 'state'));
  writeFileSync(path.join(root, 'state', 'one.json'), 'first');
  git(root, ['add', '--', 'state/one.json']);
  git(root, ['-c', 'user.name=SFlow Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  git(root, ['branch', 'state']);
  return root;
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
  assert.equal(fake.calls.every((call) => call.options.env.GIT_NO_REPLACE_OBJECTS === '1'), true);
  assert.equal(fake.calls.every((call) => call.options.env.GIT_LITERAL_PATHSPECS === '1'), true);
  assert.equal(fake.calls.find((call) => call.args[0] === 'ls-tree').args[4], TREE_OID,
    'tree listing uses the verified object ID');
});

test('ref movement after verification cannot change the tree being listed', () => {
  const firstTree = 'a'.repeat(40);
  const secondTree = 'b'.repeat(40);
  const firstBlob = blobOid('first');
  const secondBlob = blobOid('later');
  let currentTree = firstTree;
  const calls = [];
  const runCommand = (_command, args, options) => {
    calls.push(args);
    if (args[0] === 'rev-parse') {
      currentTree = secondTree; // Simulate another process advancing the ref between Git commands.
      return { status: 0, stdout: `${firstTree}\n`, stderr: '' };
    }
    if (args[0] === 'ls-tree') {
      const tree = args[4] === 'state' ? currentTree : args[4];
      const blob = tree === firstTree ? firstBlob : secondBlob;
      return { status: 0, stdout: `100644\tblob\t${blob}\t5\tstate.json\0`, stderr: '' };
    }
    const oid = String(options.input).trim();
    const body = oid === firstBlob ? 'first' : 'later';
    return { status: 0, stdout: Buffer.from(`${oid} blob 5\n${body}\n`), stderr: Buffer.alloc(0) };
  };

  const observed = readRefTreeResult('/repository', 'state', ['state.json'], { runCommand });
  assert.equal(observed.status, 'ok');
  assert.equal(observed.contents.get('state.json'), 'first');
  assert.equal(calls.find((args) => args[0] === 'ls-tree')[4], firstTree);
  assert.equal(currentTree, secondTree);
});

test('a filter can bound blob admission from listed object sizes before materialization', () => {
  const files = new Map([
    ['history/models/one.json', '{"schemaVersion":1}'],
    ['history/models/two.json', '{"schemaVersion":1,"padding":"larger"}']
  ]);
  const fake = fakeRepository(files);
  const listed = [];
  const observed = readRefTreeResult('/repository', 'state', ['history/models'], {
    runCommand: fake.runCommand,
    filter: (file, metadata) => {
      listed.push({ file, ...metadata });
      return file.endsWith('one.json');
    }
  });

  assert.equal(observed.status, 'ok');
  assert.equal(observed.objectsRequested, 1);
  assert.deepEqual([...observed.contents.keys()], ['history/models/one.json']);
  assert.deepEqual(listed.map(({ file, size }) => ({ file, size })), [...files].map(
    ([file, contents]) => ({ file, size: Buffer.byteLength(contents) })
  ));
  assert.ok(listed.every(({ mode, type }) => mode === '100644' && type === 'blob'),
    'filters receive the tree entry kind before admitting content');
  const requested = fake.calls.find((call) => call.args[0] === 'cat-file').options.input;
  assert.equal(requested.includes(fake.entries[1].oid), false,
    'a filtered blob must never be handed to cat-file');
});

test('a same-size substituted blob is rejected before its contents are exposed', () => {
  const files = new Map([['one.json', 'first'], ['two.json', 'other']]);
  const fake = fakeRepository(files);
  const observed = readRefTreeResult('/repository', 'state', [], {
    runCommand: (command, args, options) => {
      if (args[0] !== 'cat-file') return fake.runCommand(command, args, options);
      const [first, second] = fake.entries;
      return {
        status: 0,
        stdout: Buffer.from(`${first.oid} blob 5\nfirst\n${second.oid} blob 5\nspoof\n`),
        stderr: Buffer.alloc(0)
      };
    }
  });
  assert.equal(observed.status, 'partial');
  assert.equal(observed.objectsRead, 1);
  assert.deepEqual([...observed.contents.entries()], [['one.json', 'first']]);
  assert.equal(observed.errors[0].code, 'REF_TREE_OBJECT_HASH_MISMATCH');
  assert.equal(observed.errors[0].path, 'two.json');
});

test('SHA-256 blob IDs are verified with the repository object format', () => {
  const fake = fakeRepository(new Map([['one.json', 'first']]), { algorithm: 'sha256' });
  const observed = readRefTreeResult('/repository', 'state', [], { runCommand: fake.runCommand });
  assert.equal(observed.status, 'ok');
  assert.equal(observed.contents.get('one.json'), 'first');
});

test('pathspec magic is literal in a real repository', (t) => {
  const root = realRepository(t);
  const magic = readRefTreeResult(root, 'state', [':(glob)state/*.json']);
  assert.equal(magic.status, 'ok');
  assert.equal(magic.contents.size, 0);
  const literal = readRefTreeResult(root, 'state', ['state/one.json']);
  assert.equal(literal.status, 'ok');
  assert.equal(literal.contents.get('state/one.json'), 'first');
});

test('replacement objects cannot alter a real repository blob read', (t) => {
  const root = realRepository(t);
  const original = git(root, ['rev-parse', 'state:state/one.json']);
  const replacement = git(root, ['hash-object', '-w', '--stdin'], 'later');
  git(root, ['replace', original, replacement]);
  assert.equal(git(root, ['cat-file', 'blob', original]), 'later', 'replacement is active outside this reader');
  const observed = readRefTreeResult(root, 'state', ['state/one.json']);
  assert.equal(observed.status, 'ok');
  assert.equal(observed.contents.get('state/one.json'), 'first');
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
    runCommand: () => ({ status: 1, stdout: '', stderr: '' })
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.contents.size, 0);

  const empty = readRefTreeResult('/repository', 'state', [], {
    runCommand: (_command, args) => args[0] === 'rev-parse'
      ? { status: 0, stdout: `${TREE_OID}\n`, stderr: '' }
      : { status: 0, stdout: '', stderr: '' }
  });
  assert.equal(empty.status, 'ok');
  assert.equal(empty.contents.size, 0);
});

test('Git overflow and timeout remain unavailable causes rather than empty state', () => {
  const trustFailure = readRefTreeResult('/repository', 'state', [], {
    runCommand: () => ({ status: 128, stdout: '', stderr: 'fatal: dubious ownership' })
  });
  assert.equal(trustFailure.status, 'unavailable');
  assert.equal(trustFailure.errors[0].code, 'REF_TREE_REF_FAILED');

  const listOverflow = readRefTreeResult('/repository', 'state', [], {
    runCommand: (_command, args) => args[0] === 'rev-parse'
      ? { status: 0, stdout: `${TREE_OID}\n`, stderr: '' }
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

test('malformed successful rev-parse output is unavailable and never listed', () => {
  for (const stdout of ['', 'a'.repeat(39), `${TREE_OID}\n${'b'.repeat(40)}\n`, `${TREE_OID} extra\n`]) {
    const calls = [];
    const observed = readRefTreeResult('/repository', 'state', [], {
      runCommand: (_command, args) => {
        calls.push(args);
        return { status: 0, stdout, stderr: '' };
      }
    });
    assert.equal(observed.status, 'unavailable');
    assert.equal(observed.errors[0].code, 'REF_TREE_REF_INVALID');
    assert.equal(calls.length, 1);
  }
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
