import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { astCacheStatus, buildAstCache, readCachedAstSymbols } from '../src/ast-intelligence.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-cached-symbols-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'CMP Symbols');
  git(root, 'config', 'user.email', 'cmp-symbols@example.com');
  await writeFile(path.join(root, 'one.ts'), 'export function one() { return 1; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

async function isolatedPreference(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-symbol-preference-'));
  const before = process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
  process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = path.join(directory, 'preference.json');
  try { return await run(); } finally {
    if (before === undefined) delete process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
    else process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = before;
  }
}

test('cached symbol projection never builds AST on a cache miss', async () => isolatedPreference(async () => {
  const root = await repository();
  const before = git(root, 'status', '--porcelain=v1');
  assert.equal((await astCacheStatus(root)).exists, false);

  const result = await readCachedAstSymbols(root, { paths: ['one.ts'] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'cache-miss');
  assert.deepEqual(result.symbols, []);
  assert.equal((await astCacheStatus(root)).exists, false,
    'a read-only Comprehension projection cannot warm or repair AST');
  assert.equal(git(root, 'status', '--porcelain=v1'), before);
}));

test('cached symbol projection reuses current cache facts without source bodies', async () => isolatedPreference(async () => {
  const root = await repository();
  await buildAstCache(root, { paths: ['one.ts'], 'max-facts': 1000 });
  const cacheBefore = await astCacheStatus(root);
  const filesBefore = (await readdir(path.join(root, '.git', 'singularity-flow', 'ast', 'v2', 'blobs'))).sort();

  const result = await readCachedAstSymbols(root, { paths: ['one.ts'] });
  assert.equal(result.status, 'available');
  assert.ok(result.symbols.some((symbol) => symbol.name === 'one' && symbol.path === 'one.ts'));
  assert.ok(result.symbols.every((symbol) => Number.isInteger(symbol.line) && symbol.line > 0));
  assert.doesNotMatch(JSON.stringify(result), /sourceBody|return 1/u);
  assert.match(result.projectionSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(result.symbols), true);
  assert.deepEqual(await astCacheStatus(root), cacheBefore);
  assert.deepEqual(
    (await readdir(path.join(root, '.git', 'singularity-flow', 'ast', 'v2', 'blobs'))).sort(),
    filesBefore
  );

  await writeFile(path.join(root, 'one.ts'), 'export function changed() { return 2; }\n');
  const stale = await readCachedAstSymbols(root, { paths: ['one.ts'] });
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.reason, 'cache-miss');
  assert.equal(stale.symbols.some((symbol) => symbol.name === 'one'), false,
    'old cache facts cannot cross a current-byte identity change');
  assert.doesNotMatch(await readFile(path.join(root, 'one.ts'), 'utf8'), /function one/u);
}));

test('a previously built Java syntax preview supplies optional cached navigation', async () => isolatedPreference(async () => {
  const root = await repository();
  await writeFile(path.join(root, 'Widget.java'), 'package fixture;\npublic final class Widget { void calculate() {} }\n');
  git(root, 'add', 'Widget.java');
  git(root, 'commit', '-m', 'add Java fixture');
  await buildAstCache(root, { paths: ['Widget.java'], 'max-facts': 1000 });

  const result = await readCachedAstSymbols(root, { paths: ['Widget.java'] });
  assert.equal(result.status, 'available');
  assert.ok(result.symbols.some((symbol) =>
    symbol.name === 'Widget' && symbol.extractor === 'sflow-polyglot-syntax'));
  assert.equal(result.lifecycleGate, false);
  assert.equal(result.authoritative, false);
}));

test('AST off stays an optional unavailable symbol view', async () => isolatedPreference(async () => {
  const root = await repository();
  const before = process.env.SINGULARITY_FLOW_AST;
  process.env.SINGULARITY_FLOW_AST = 'off';
  try {
    const result = await readCachedAstSymbols(root, { paths: ['one.ts'] });
    assert.equal(result.status, 'disabled');
    assert.equal(result.reason, 'ast-disabled');
    assert.deepEqual(result.symbols, []);
    assert.equal(result.lifecycleGate, false);
  } finally {
    if (before === undefined) delete process.env.SINGULARITY_FLOW_AST;
    else process.env.SINGULARITY_FLOW_AST = before;
  }
}));
