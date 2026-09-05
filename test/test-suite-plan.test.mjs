import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  discoverTestSuite, needsTypeStripping, parsePositiveInteger, parseShard, partitionTestFiles,
  summarizeTestShardReceipts, testRunId, testSelectionSha256, testShardReceiptMatches
} from '../scripts/test-suite-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const file = (relative, bytes) => ({
  relative, bytes, sourceSha256: `sha256:${relative.padEnd(64, '0').slice(0, 64)}`
});

test('test shards are deterministic, disjoint, complete, and weight-balanced', () => {
  const files = [
    file('test/large.test.mjs', 100), file('test/medium.test.mjs', 60),
    file('test/small-a.test.mjs', 25), file('test/small-b.test.mjs', 15),
    file('test/tiny.test.mjs', 5)
  ];
  const first = partitionTestFiles(files, 3);
  const second = partitionTestFiles([...files].reverse(), 3);
  assert.deepEqual(first, second, 'input order must not change shard identity');
  const selected = first.flatMap((shard) => shard.files.map((entry) => entry.relative));
  assert.deepEqual([...selected].sort(), files.map((entry) => entry.relative).sort());
  assert.equal(new Set(selected).size, files.length, 'one test file appeared in multiple shards');
  assert.ok(Math.max(...first.map((entry) => entry.weight))
    - Math.min(...first.map((entry) => entry.weight)) <= 100,
  'largest-first scheduling became less balanced than the largest indivisible file');
  assert.equal(first[0].sourceSha256, testSelectionSha256(first[0].files));
});

test('reviewed process-heavy integration files stay out of ordinary aggregate lanes', async () => {
  const plan = await discoverTestSuite(root, 'all');
  const shards = partitionTestFiles(plan.files, 8);
  for (const relative of [
    'test/auto-mode.test.mjs',
    'test/sgos-runtime.test.mjs',
    'test/workspace.test.mjs'
  ]) {
    const shard = shards.find((candidate) =>
      candidate.files.some((entry) => entry.relative === relative));
    assert.ok(shard, `${relative} was omitted from the aggregate`);
    assert.deepEqual(shard.files.map((entry) => entry.relative), [relative],
      `${relative} must not share a process-heavy lane`);
  }
});

test('test shard and bound parsing refuses ambiguous or unbounded values', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
  for (const value of ['0/4', '5/4', '1/0', 'x/4', '1/65']) {
    assert.throws(() => parseShard(value));
  }
  assert.equal(parsePositiveInteger('30000', 'deadline', { minimum: 1_000 }), 30_000);
  assert.throws(() => parsePositiveInteger('0', 'deadline', { minimum: 1_000 }));
  assert.throws(() => parsePositiveInteger('infinite', 'deadline'));
});

test('test-run identity changes with exact source or execution identity', () => {
  const base = {
    suite: 'all', shardCount: 4, sourceSha256: `sha256:${'a'.repeat(64)}`,
    commit: 'b'.repeat(40), tree: 'c'.repeat(40), platform: 'linux',
    architecture: 'x64', nodeVersion: '22.18.0', failOnSkipped: true
  };
  assert.equal(testRunId(base), testRunId(structuredClone(base)));
  assert.notEqual(testRunId(base), testRunId({ ...base, shardCount: 5 }));
  assert.notEqual(testRunId(base), testRunId({ ...base, sourceSha256: `sha256:${'d'.repeat(64)}` }));
});

test('only exact complete shard receipts can be resumed or aggregated', () => {
  const expected = {
    runId: 'run-1', suite: 'all', shardIndex: 1, shardCount: 2,
    sourceSha256: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    platform: 'linux', architecture: 'x64', nodeVersion: '22.18.0',
    cleanCheckout: true, failOnSkipped: false
  };
  const receipt = {
    ...expected, status: 'passed', summary: {
      tests: 4, passed: 4, failed: 0, cancelled: 0, skipped: 0, todo: 0
    }
  };
  assert.equal(testShardReceiptMatches(receipt, expected), true);
  assert.equal(testShardReceiptMatches({ ...receipt, commit: 'd'.repeat(40) }, expected), false);
  assert.equal(testShardReceiptMatches({
    ...receipt, summary: { ...receipt.summary, cancelled: 1 }
  }, expected), false);
  const summary = summarizeTestShardReceipts([receipt, {
    ...receipt, shardIndex: 2,
    summary: { tests: 3, passed: 2, failed: 0, cancelled: 0, skipped: 1, todo: 0 }
  }]);
  assert.deepEqual(summary.counters, {
    tests: 7, passed: 6, failed: 0, cancelled: 0, skipped: 1, todo: 0
  });
  assert.equal(summary.status, 'passed');
  assert.equal(summarizeTestShardReceipts([receipt, {
    ...receipt, summary: { ...receipt.summary, skipped: 1 }
  }], { failOnSkipped: true }).status, 'failed');
});

test('TypeScript stripping follows what a test loads rather than its suite label', () => {
  assert.equal(needsTypeStripping("await import('../apps/vscode/src/extension.ts');"), true);
  assert.equal(needsTypeStripping("const file = path.join(root, 'fixture.ts');"), true);
  assert.equal(needsTypeStripping("await import('../src/api.mjs');"), false);
});

test('a shard deadline writes a retryable receipt and terminates the expensive child', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-shard-deadline-'));
  const receiptPath = path.join(directory, 'receipt.json');
  try {
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts/run-test-suite.mjs'), 'all', '--shard=1/64',
      '--deadline-ms=1000', `--receipt=${receiptPath}`
    ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /exceeded its 1000 ms deadline/);
    assert.match(output, /Retry exactly: .*--shard=1\/64 --deadline-ms=1000/);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.timedOut, true);
    assert.equal(receipt.outputOverflow, false);
    assert.equal(receipt.shardIndex, 1);
    assert.equal(receipt.shardCount, 64);
    assert.equal(receipt.selectedFiles, 1,
      'the reviewed heavy-file weight must keep Auto isolated from unrelated tests');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
