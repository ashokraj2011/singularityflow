import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeGitQuery, gitQueryDescriptor } from '../src/git-query.mjs';
import { parseGitIndexStages, parsePorcelainV2Status } from '../src/git-status-detail.mjs';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const c = 'c'.repeat(40);
const z = '0'.repeat(40);
const terminated = (value) => Buffer.concat([Buffer.isBuffer(value) ? value : Buffer.from(value),
  Buffer.from([0])]);
const fieldPath = (fields, rawPath) => terminated(Buffer.concat([
  Buffer.from(`${fields} `), Buffer.isBuffer(rawPath) ? rawPath : Buffer.from(rawPath)
]));
const parseStatus = (bytes, options = {}) => parsePorcelainV2Status(bytes, {
  objectFormat: 'sha1', ...options
});
const parseIndex = (bytes, options = {}) => parseGitIndexStages(bytes, {
  objectFormat: 'sha1', ...options
});

test('porcelain-v2 status preserves metadata, rename source and destination, unmerged stages, and byte paths', () => {
  const source = 'old\tname\nwith space.txt';
  const target = 'new\\literal\tname\nδ.txt';
  const invalidBytes = Buffer.from([0x62, 0x61, 0x64, 0x80, 0x2e, 0x74, 0x78, 0x74]);
  const output = Buffer.concat([
    terminated(`# branch.oid ${a}`),
    terminated('# branch.head main'),
    terminated('# branch.upstream origin/main'),
    terminated('# branch.ab +2 -3'),
    terminated('# stash 4'),
    terminated('# future.detail opaque data'),
    fieldPath(`1 .M SCMU 160000 160000 160000 ${a} ${b}`, 'submodule'),
    fieldPath(`2 R. N... 100644 100644 100644 ${a} ${b} R100`, target),
    terminated(source),
    fieldPath(`u UU N... 100644 100755 120000 000000 ${a} ${b} ${c}`, 'conflict.txt'),
    fieldPath('?', invalidBytes),
    fieldPath('!', 'ignored dir/')
  ]);
  const result = parseStatus(output, { includeIgnored: true, expectBranch: true });
  assert.deepEqual(result.scope, { untracked: 'all', includeIgnored: true });
  assert.equal(result.branch.state, 'attached');
  assert.equal(result.branch.oid, a);
  assert.equal(result.branch.head, 'main');
  assert.equal(result.branch.ahead, 2);
  assert.equal(result.branch.behind, 3);
  assert.equal(result.stashCount, 4);
  assert.equal(result.headers.at(-1).name, 'future.detail');
  assert.equal(result.entries[0].submodule.raw, 'SCMU');
  assert.deepEqual(result.entries[0].xy, { raw: '.M', index: '.', worktree: 'M' });
  assert.equal(result.entries[1].change, 'rename');
  assert.equal(result.entries[1].score, 100);
  assert.equal(result.entries[1].path.value, target);
  assert.equal(result.entries[1].sourcePath.value, source);
  assert.deepEqual(result.entries[2].stages.map(({ stage, mode, oid }) => ({ stage, mode, oid })), [
    { stage: 1, mode: '100644', oid: a },
    { stage: 2, mode: '100755', oid: b },
    { stage: 3, mode: '120000', oid: c }
  ]);
  assert.equal(result.entries[2].worktreeMode, '000000');
  assert.deepEqual(result.entries[3].path, {
    kind: 'bytes', base64: invalidBytes.toString('base64'),
    display: 'bad\\x80.txt', directoryHint: false
  });
  assert.equal(result.entries[4].path.directoryHint, true);
  assert.ok(Object.isFrozen(result.entries[2].stages[0]));
});

test('index stage parser preserves all conflict stages and paths with tabs, newlines and non-UTF-8 bytes', () => {
  const strange = Buffer.from([0x2d, 0x80, 0x09, 0x0a, 0x5c]);
  const output = Buffer.concat([
    terminated(`100644 ${a} 0\tordinary name`),
    ...[1, 2, 3].map((stage) => Buffer.concat([
      Buffer.from(`100755 ${b} ${stage}\t`), strange, Buffer.from([0])
    ]))
  ]);
  const result = parseIndex(output);
  assert.deepEqual(result.entries.map((entry) => entry.stage), [0, 1, 2, 3]);
  assert.equal(result.entries[0].path.value, 'ordinary name');
  assert.equal(result.entries[1].path.base64, strange.toString('base64'));
  assert.equal(result.entries[1].path.display, '-\\x80\\x09\\x0a\\x5c');
  assert.equal(result.entries[2].mode, '100755');
});

test('parser refuses strings, bad framing, unsupported forms, missing rename source and malformed metadata', () => {
  const valid = fieldPath(`1 .M N... 100644 100644 100644 ${a} ${b}`, 'file');
  assert.throws(() => parseStatus(valid.toString('utf8')), (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(valid.subarray(0, -1)), (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(Buffer.concat([valid, Buffer.from([0])])),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(terminated('x unsupported')),
    (error) => error.code === 'GAL_OPERATION_UNSUPPORTED');
  assert.throws(() => parseStatus(fieldPath(`2 R. N... 100644 100644 100644 ${a} ${b} R75`, 'dest')),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(fieldPath(`1 .M N... 100644 100644 100644 ${a} ${z.slice(1)}`, 'file')),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(fieldPath(`1 .M N... 100644 100644 100644 ${a} ${b}`, '../escape')),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(fieldPath('?', 'not-requested'), { untracked: 'no' }),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(fieldPath('!', 'not-requested')),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(terminated('# branch.oid (initial)'), { expectBranch: true }),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(Buffer.concat([
    terminated(`# branch.oid ${a}`), terminated('# branch.head main'),
    terminated('# branch.ab +1 -0')
  ])), (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(Buffer.concat([
    terminated('# branch.oid (initial)'), terminated('# branch.head (detached)')
  ])), (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(Buffer.concat([
    fieldPath(`2 R. N... 100644 100644 100644 ${a} ${b} C75`, 'dest'), terminated('source')
  ])), (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseStatus(valid, { maxBytes: valid.length - 1 }),
    (error) => error.code === 'GAL_LIMIT_EXCEEDED');
});

test('index parser rejects truncated and malformed stage records', () => {
  const valid = terminated(`100644 ${a} 0\tfile`);
  assert.throws(() => parseIndex(valid.subarray(0, -1)), (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseIndex(terminated(`100644 ${a} 4\tfile`)),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseIndex(terminated(`100644 ${a} 0 file`)),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseIndex(terminated(`100644 ${a} 0\tfoo//bar`)),
    (error) => error.code === 'GAL_PARSE_INVALID');
  assert.throws(() => parseIndex(valid, { objectFormat: 'sha256' }),
    (error) => error.code === 'GAL_PARSE_INVALID');
});

test('UTF-8 BOM and SHA-256 OIDs remain exact rather than being normalized or shortened', () => {
  const longOid = 'a'.repeat(64);
  const withBom = Buffer.from([0xef, 0xbb, 0xbf, 0x66, 0x69, 0x6c, 0x65]);
  const output = fieldPath(`1 .M N... 100644 100644 100644 ${longOid} ${longOid}`, withBom);
  const result = parsePorcelainV2Status(output, { objectFormat: 'sha256' });
  assert.equal(result.entries[0].path.value, '\ufefffile');
  assert.deepEqual(Buffer.from(result.entries[0].path.value, 'utf8'), withBom);
  assert.equal(result.entries[0].oids.head, longOid);
});

test('closed query descriptors request raw buffers, validate selections before spawn, and retain strict results', () => {
  const statusBytes = Buffer.concat([
    terminated(`# branch.oid ${a}`), terminated('# branch.head main'),
    fieldPath('?', 'untracked name')
  ]);
  const indexBytes = terminated(`100644 ${b} 0\ttracked name`);
  const calls = [];
  const runner = (_command, argv, options) => {
    calls.push({ argv, options });
    return { status: 0, stdout: argv[0] === 'status' ? statusBytes : indexBytes };
  };
  const status = executeGitQuery('/tmp', 'repository.status-detail', {
    objectFormat: 'sha1', untracked: 'normal', includeIgnored: true
  }, { runner });
  const index = executeGitQuery('/tmp', 'repository.index-detail', {
    objectFormat: 'sha1'
  }, { runner });
  assert.equal(status.entries[0].path.value, 'untracked name');
  assert.equal(index.entries[0].path.value, 'tracked name');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.encoding, 'buffer');
  assert.ok(calls[0].argv.includes('--untracked-files=normal'));
  assert.ok(calls[0].argv.includes('--ignored'));
  assert.ok(calls[0].argv.includes('--ignore-submodules=none'));
  assert.deepEqual(calls[1].argv, ['ls-files', '--stage', '-z']);
  assert.equal(gitQueryDescriptor('repository.status-detail').dependency, 'mutable');
  assert.equal(gitQueryDescriptor('repository.index-detail').effects, 'none');
  assert.throws(() => executeGitQuery('/tmp', 'repository.status-detail', {
    objectFormat: 'sha1', untracked: 'invalid'
  }, { runner }), (error) => error.code === 'GIT_QUERY_INPUT_INVALID');
  assert.throws(() => executeGitQuery('/tmp', 'repository.index-detail', {}, { runner }),
    (error) => error.code === 'GIT_QUERY_INPUT_INVALID');
  assert.equal(calls.length, 2, 'invalid selections never spawn Git');
  assert.throws(() => executeGitQuery('/tmp', 'repository.index-detail', {
    objectFormat: 'sha1'
  }, { runner: () => ({ status: 0, stdout: indexBytes.toString('utf8') }) }),
  (error) => error.code === 'GAL_PARSE_INVALID');
});

test('real Git output round-trips a rename with whitespace and a dirty tracked path', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gal-status-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'buffer' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'GAL Test']);
  git(['config', 'user.email', 'gal@example.com']);
  const source = 'old\tline\nname';
  const target = 'new space\tname';
  await writeFile(path.join(root, source), 'original\n');
  git(['add', '--', source]);
  git(['commit', '-qm', 'initial']);
  git(['mv', '--', source, target]);
  await writeFile(path.join(root, target), 'modified\n');
  const status = parseStatus(git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']), {
    expectBranch: true
  });
  const renamed = status.entries.find((entry) => entry.type === 'rename-or-copy');
  assert.equal(renamed.path.value, target);
  assert.equal(renamed.sourcePath.value, source);
  assert.equal(renamed.xy.raw, 'RM');
  const index = parseIndex(git(['ls-files', '--stage', '-z']));
  assert.equal(index.entries[0].path.value, target);
  assert.equal(index.entries[0].stage, 0);
  const queriedStatus = executeGitQuery(root, 'repository.status-detail', { objectFormat: 'sha1' });
  const queriedIndex = executeGitQuery(root, 'repository.index-detail', { objectFormat: 'sha1' });
  assert.equal(queriedStatus.entries.find((entry) => entry.type === 'rename-or-copy').sourcePath.value,
    source);
  assert.equal(queriedIndex.entries[0].path.value, target);
});
