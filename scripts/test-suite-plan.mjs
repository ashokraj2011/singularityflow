import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const TEST_SUITES = Object.freeze(['all', 'cli', 'vscode']);

// These files perform full Story/worktree/remote/model-transport or durable-runtime journeys.
// Source bytes radically understate that cost. Reviewed scheduling weights keep them out of the
// ordinary lanes; the values affect scheduling only and can never change coverage or a receipt
// digest.
const PROCESS_HEAVY_FILE_WEIGHTS = Object.freeze({
  'test/auto-mode.test.mjs': 8_000_000,
  // SGOS runtime exercises durable locks, subprocess cancellation, and hundreds of immutable
  // transitions. Workspace exercises repeated local bare remotes and checkout recovery. Both are
  // substantially more expensive and more latency-sensitive than their source byte counts imply.
  'test/sgos-runtime.test.mjs': 8_000_000,
  'test/workspace.test.mjs': 4_000_000
});

export function needsTypeStripping(source) {
  return /['"`][^'"`]*\.ts['"`]/.test(source) || source.includes('apps/vscode');
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export async function discoverTestSuite(root, suite = 'all') {
  if (!TEST_SUITES.includes(suite)) {
    throw new Error(`Test suite must be one of: ${TEST_SUITES.join(', ')}.`);
  }
  const names = (await readdir(path.join(root, 'test')))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  const files = [];
  for (const name of names) {
    const relative = path.posix.join('test', name);
    const source = await readFile(path.join(root, relative), 'utf8');
    const kind = source.includes('apps/vscode') ? 'vscode' : 'cli';
    if (suite !== 'all' && suite !== kind) continue;
    files.push(Object.freeze({
      relative,
      kind,
      bytes: Buffer.byteLength(source),
      sourceSha256: digest(source),
      needsTypeStripping: needsTypeStripping(source)
    }));
  }
  if (!files.length) throw new Error(`No ${suite} tests were discovered.`);
  return Object.freeze({
    suite,
    files: Object.freeze(files),
    sourceSha256: testSelectionSha256(files),
    needsTypeStripping: files.some((file) => file.needsTypeStripping)
  });
}

/**
 * Deterministically distribute expensive files without requiring machine-specific timing data.
 *
 * Source bytes are only a scheduling hint, never evidence. Largest-first placement keeps the
 * unusually large Auto, SGOS, VS Code, and World-Model fixtures in separate lanes; the exact
 * selected-file digest below is what proves coverage. A future reviewed timing profile can replace
 * the weight without changing shard identity or completeness rules.
 */
export function partitionTestFiles(files, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 64) {
    throw new Error('Test shard count must be an integer from 1 through 64.');
  }
  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index: index + 1, weight: 0, files: []
  }));
  const weightOf = (file) => Math.max(file.bytes, PROCESS_HEAVY_FILE_WEIGHTS[file.relative] ?? 0);
  const ordered = [...files].sort((left, right) => (
    weightOf(right) - weightOf(left) || left.relative.localeCompare(right.relative)
  ));
  for (const file of ordered) {
    const shard = shards.reduce((selected, candidate) => (
      candidate.weight < selected.weight
        || (candidate.weight === selected.weight && candidate.index < selected.index)
        ? candidate : selected
    ), shards[0]);
    shard.files.push(file);
    shard.weight += weightOf(file);
  }
  return Object.freeze(shards.map((shard) => Object.freeze({
    index: shard.index,
    weight: shard.weight,
    files: Object.freeze(shard.files.sort((left, right) => left.relative.localeCompare(right.relative))),
    sourceSha256: testSelectionSha256(shard.files)
  })));
}

export function testSelectionSha256(files) {
  const canonical = [...files]
    .sort((left, right) => left.relative.localeCompare(right.relative))
    .map((file) => `${file.relative}\0${file.sourceSha256}\n`)
    .join('');
  return digest(canonical);
}

export function parseShard(value, fallbackCount = 1) {
  if (value == null || value === '') return Object.freeze({ index: 1, count: fallbackCount });
  const match = /^(\d+)\/(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error('Test shard must use INDEX/COUNT, for example 2/4.');
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isInteger(count) || count < 1 || count > 64 || index < 1 || index > count) {
    throw new Error('Test shard INDEX/COUNT must select one of 1 through 64 shards.');
  }
  return Object.freeze({ index, count });
}

export function parsePositiveInteger(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

export function testRunId(value) {
  return digest(`${JSON.stringify(value)}\n`).slice('sha256:'.length, 'sha256:'.length + 24);
}

export function testShardReceiptMatches(receipt, expected) {
  const summary = receipt?.summary;
  const counters = summary && ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']
    .every((key) => Number.isInteger(summary[key]) && summary[key] >= 0);
  return receipt?.status === 'passed'
    && Object.entries(expected).every(([key, value]) => receipt[key] === value)
    && counters && summary.tests > 0
    && summary.tests === summary.passed + summary.failed + summary.cancelled
      + summary.skipped + summary.todo
    && summary.failed === 0
    && summary.cancelled === 0
    && summary.todo === 0
    && (expected.failOnSkipped !== true || summary.skipped === 0);
}

export function summarizeTestShardReceipts(receipts, { failOnSkipped = false } = {}) {
  const counters = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const receipt of receipts) {
    for (const key of Object.keys(counters)) counters[key] += Number(receipt?.summary?.[key] ?? 0);
  }
  const status = receipts.length > 0
    && counters.failed === 0 && counters.cancelled === 0 && counters.todo === 0
    && (!failOnSkipped || counters.skipped === 0)
    ? 'passed' : 'failed';
  return Object.freeze({ status, counters: Object.freeze(counters) });
}
