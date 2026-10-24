#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverTestSuite, parsePositiveInteger, partitionTestFiles, summarizeTestShardReceipts,
  TEST_SUITES, testRunId, testShardReceiptMatches
} from './test-suite-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const suite = argv.find((argument) => !argument.startsWith('--')) ?? 'all';
if (!TEST_SUITES.includes(suite)) throw new Error(`Test suite must be one of: ${TEST_SUITES.join(', ')}.`);
const option = (name) => argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const requestedShards = parsePositiveInteger(
  option('shards') ?? process.env.SINGULARITY_FLOW_TEST_SHARDS ?? 16,
  'Test aggregate shard count', { maximum: 64 }
);
const workers = parsePositiveInteger(
  // Four shards at once since each child's deadline survives load (test/helpers/child-timeout.mjs) and
  // shards are balanced by measured time: 16 x 4 ran 12,101 tests in 82 minutes on 2026-10-24 with no
  // timeout, against 165 minutes for 8 x 2 on byte-balanced shards the day before.
  option('workers') ?? process.env.SINGULARITY_FLOW_TEST_SHARD_WORKERS ?? Math.min(4, requestedShards),
  'Test aggregate worker count', { maximum: requestedShards }
);
const deadlineMs = parsePositiveInteger(
  option('deadline-ms') ?? process.env.SINGULARITY_FLOW_TEST_DEADLINE_MS ?? 30 * 60 * 1000,
  'Test shard deadline', { minimum: 1_000, maximum: 4 * 60 * 60 * 1000 }
);
const requireClean = argv.includes('--require-clean');
const resume = !argv.includes('--no-resume');
const failOnSkipped = argv.includes('--fail-on-skipped')
  || process.env.SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES === '1';

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`Git could not establish aggregate identity: ${result.stderr || result.error?.message}`);
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const plan = await discoverTestSuite(root, suite);
// A suite with fewer files than shards (the slow lane) gets one shard per file, never an empty shard.
const shardCount = Math.min(requestedShards, plan.files.length);
const shards = partitionTestFiles(plan.files, shardCount);
const commit = git(['rev-parse', '--verify', 'HEAD']);
const tree = git(['rev-parse', '--verify', 'HEAD^{tree}']);
const status = git(['status', '--porcelain=v1', '--untracked-files=all']) ?? '';
const cleanCheckout = status === '';
if (requireClean && !cleanCheckout) {
  throw new Error(`Release aggregate requires a clean checkout; current changes:\n${status.slice(0, 16_384)}`);
}
const identity = Object.freeze({
  suite, shardCount, sourceSha256: plan.sourceSha256, commit, tree,
  platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
  failOnSkipped
});
const runId = testRunId(identity);
const gitPath = git(['rev-parse', '--path-format=absolute', '--git-path', `singularity-flow/test-runs/${runId}`]);
const runDirectory = path.resolve(root, gitPath);

function expectedReceipt(shard) {
  return {
    runId, suite, shardIndex: shard.index, shardCount,
    sourceSha256: shard.sourceSha256, commit, tree,
    platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
    cleanCheckout, failOnSkipped
  };
}

function reusableReceipt(receipt, expected) {
  if (!resume || !cleanCheckout || receipt?.status !== 'passed') return false;
  return testShardReceiptMatches(receipt, expected);
}

const receipts = new Map();
const pending = [];
for (const shard of shards) {
  const receiptFile = path.join(runDirectory, `shard-${shard.index}-of-${shardCount}.json`);
  const receipt = await readJson(receiptFile);
  if (reusableReceipt(receipt, expectedReceipt(shard))) {
    receipts.set(shard.index, receipt);
    console.log(`SFlow test shard ${shard.index}/${shardCount}: reused ${shard.files.length} passing file(s).`);
  } else pending.push({ shard, receiptFile });
}

const perShardConcurrency = parsePositiveInteger(
  process.env.SINGULARITY_FLOW_TEST_CONCURRENCY_PER_SHARD
    ?? 1,
  'Per-shard test concurrency', { maximum: 32 }
);

async function runShard(entry) {
  const { shard, receiptFile } = entry;
  const child = spawn(process.execPath, [
    path.join(root, 'scripts/run-test-suite.mjs'), suite,
    `--shard=${shard.index}/${shardCount}`,
    `--deadline-ms=${deadlineMs}`,
    `--receipt=${receiptFile}`
  ], {
    cwd: root, stdio: 'inherit', shell: false,
    env: {
      ...process.env,
      SINGULARITY_FLOW_TEST_CONCURRENCY: String(perShardConcurrency),
      ...(failOnSkipped ? { SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1' } : {})
    }
  });
  const exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
  const receipt = await readJson(receiptFile);
  if (exitCode !== 0 || !receipt) {
    return { shard, exitCode, receipt: receipt ?? null, status: 'failed' };
  }
  const expected = expectedReceipt(shard);
  return {
    shard, exitCode, receipt,
    status: testShardReceiptMatches(receipt, expected) ? 'passed' : 'failed'
  };
}

let cursor = 0;
const results = [];
await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, async () => {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= pending.length) return;
    results.push(await runShard(pending[index]));
  }
}));
for (const result of results) if (result.receipt) receipts.set(result.shard.index, result.receipt);

const orderedReceipts = shards.map((shard) => receipts.get(shard.index) ?? null);
const failedShards = shards.filter((shard) => {
  const receipt = receipts.get(shard.index);
  return !testShardReceiptMatches(receipt, expectedReceipt(shard));
});
const summarized = summarizeTestShardReceipts(orderedReceipts.filter(Boolean), { failOnSkipped });
const counters = summarized.counters;
const statusValue = failedShards.length === 0 ? summarized.status : 'failed';
const aggregate = {
  schemaVersion: 1, // schema-transient: local test-run receipt, never a durable product record
  runId, suite, status: statusValue, generatedAt: new Date().toISOString(),
  commit, tree, cleanCheckout, sourceSha256: plan.sourceSha256,
  platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
  shardCount, workers, perShardConcurrency, deadlineMs, failOnSkipped,
  selectedFiles: plan.files.length, counters,
  shardReceiptsSha256: orderedReceipts.filter(Boolean).map((receipt) => sha256(`${JSON.stringify(receipt)}\n`)),
  failedShards: failedShards.map((shard) => shard.index)
};
await writeAtomic(path.join(runDirectory, 'aggregate.json'), aggregate);
// Every shard that ran wrote how long its files took; together they are this run's timing profile.
const measured = {};
for (const { receiptFile } of pending) Object.assign(measured, (await readJson(`${receiptFile}.durations.json`))?.files ?? {});
const durationsFile = path.join(runDirectory, 'durations.json');
if (Object.keys(measured).length) await writeAtomic(durationsFile, { schemaVersion: 1, files: measured });

console.log(`\nSFlow aggregate ${runId}: ${statusValue}; ${shardCount} shard(s), ${plan.files.length} file(s).`);
console.log(`ℹ tests ${counters.tests}`);
console.log(`ℹ pass ${counters.passed}`);
console.log(`ℹ fail ${counters.failed}`);
console.log(`ℹ cancelled ${counters.cancelled}`);
console.log(`ℹ skipped ${counters.skipped}`);
console.log(`ℹ todo ${counters.todo}`);
console.log(`Aggregate receipt: ${path.join(runDirectory, 'aggregate.json')}`);
if (Object.keys(measured).length) console.log(`Timing profile: ${durationsFile} (update the committed one with node scripts/update-test-durations.mjs ${runDirectory})`);
if (statusValue !== 'passed') {
  console.error(`Retry only incomplete shards: node scripts/run-test-aggregate.mjs ${suite} --shards=${shardCount} --workers=${workers} --deadline-ms=${deadlineMs}`);
  process.exitCode = 1;
}
