import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateAstAdapterManifest } from '../src/ast-adapter-contract.mjs';
import {
  astCacheStatus, astCommand, effectiveAstMode, readAstPreference, setAstPreference,
  validateAstResultEnvelope
} from '../src/ast-intelligence.mjs';
import { normalizeAstPolicy } from '../src/ast-policy.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'AST Test']);
  git(root, ['config', 'user.email', 'ast@example.com']);
  await writeFile(path.join(root, 'one.ts'), 'export function one() { return 1; }\n');
  await writeFile(path.join(root, 'two.ts'), "import { one } from './one.js';\nexport const two = one();\n");
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

async function withPreferenceFile(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-preference-'));
  const before = process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
  process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = path.join(directory, 'preference.json');
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
    else process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = before;
  }
}

test('AST policy is closed, bounded, and cannot disable a required predicate', () => {
  const value = normalizeAstPolicy({ mode: 'auto', budgets: { maxFiles: 7 } });
  assert.equal(value.budgets.maxFiles, 7);
  assert.equal(value.budgets.maxFileBytes, 2 * 1024 * 1024);
  assert.throws(() => normalizeAstPolicy({ mode: 'off', predicates: [{ id: 'must', mode: 'required', type: 'path-exists', path: 'src' }] }), /cannot be combined/);
  assert.throws(() => normalizeAstPolicy({ surprise: true }), /unknown field/);
});

test('the most restrictive preference wins and show has no write side effect', async () => withPreferenceFile(async () => {
  const shown = await readAstPreference();
  assert.equal(shown.mode, 'auto');
  assert.equal(shown.exists, false);
  await setAstPreference('off');
  const effective = await effectiveAstMode(normalizeAstPolicy({ mode: 'auto' }));
  assert.equal(effective.mode, 'off');
  assert.equal((await readAstPreference()).exists, true);
}));

test('off returns a valid disabled envelope and creates no AST store', async () => withPreferenceFile(async () => {
  const root = await repository();
  await setAstPreference('off');
  const result = await astCommand(root, ['context'], { all: true });
  assert.equal(validateAstResultEnvelope(result).status, 'disabled');
  assert.equal(result.coverage.processed, 0);
  assert.equal((await astCacheStatus(root)).exists, false);
}));

test('default scope never expands empty roots to the repository and explicit all is bounded', async () => withPreferenceFile(async () => {
  const root = await repository();
  const quiet = await astCommand(root, ['context'], { json: false });
  assert.equal(quiet.scope.kind, 'changed');
  assert.equal(quiet.coverage.selected, 0);
  const result = await astCommand(root, ['context'], { all: true, 'max-files': '1' });
  assert.equal(result.scope.kind, 'all');
  assert.equal(result.coverage.selected, 2);
  assert.equal(result.coverage.processed, 1);
  assert.equal(result.status, 'partial');
}));

test('text facts contain references and hashes but never source bodies', async () => withPreferenceFile(async () => {
  const root = await repository();
  const result = await astCommand(root, ['context'], { all: true });
  assert.equal(result.assurance, 'text');
  assert.ok(result.facts.some((fact) => fact.kind === 'symbol' && fact.name === 'one'));
  assert.ok(result.facts.some((fact) => fact.kind === 'import' && fact.target === './one.js'));
  assert.doesNotMatch(JSON.stringify(result), /return 1/);
}));

test('build writes only to the git-common cache and cache clear is confirmation-bound', async () => withPreferenceFile(async () => {
  const root = await repository();
  await astCommand(root, ['build'], { all: true });
  const status = await astCacheStatus(root);
  assert.equal(status.exists, true);
  assert.match(status.root, /\.git\/singularity-flow\/ast\/v1$/);
  await assert.rejects(() => astCommand(root, ['cache', 'clear'], {}), /CLEAR AST CACHE/);
  await astCommand(root, ['cache', 'clear'], { confirm: 'CLEAR AST CACHE' });
  assert.equal((await astCacheStatus(root)).exists, false);
}));

test('budgeted builds resume through an opaque handle bound to exact worktree bytes', async () => withPreferenceFile(async () => {
  const root = await repository();
  const first = await astCommand(root, ['build'], { all: true, 'max-files': '1' });
  assert.match(first.resumeHandle, /^ast_[0-9a-f-]{36}_[A-Za-z0-9_-]+$/);
  const second = await astCommand(root, ['build', first.resumeHandle], { resume: true, 'max-files': '1' });
  assert.equal(second.coverage.processed, 1);
  assert.equal(second.resumeHandle, null);
  await assert.rejects(
    () => astCommand(root, ['build', first.resumeHandle], { resume: true, 'max-files': '1' }),
    /unknown or already consumed/
  );
}));

test('resume refuses a handle after worktree bytes change', async () => withPreferenceFile(async () => {
  const root = await repository();
  const first = await astCommand(root, ['build'], { all: true, 'max-files': '1' });
  await writeFile(path.join(root, 'one.ts'), 'export function one() { return 2; }\n');
  await assert.rejects(
    () => astCommand(root, ['build', first.resumeHandle], { resume: true, 'max-files': '1' }),
    /worktree bytes changed/
  );
}));

test('cache prune previews and removes only stale derived records after exact confirmation', async () => withPreferenceFile(async () => {
  const root = await repository();
  await astCommand(root, ['build'], { all: true });
  await writeFile(path.join(root, 'one.ts'), 'export function one() { return 3; }\n');
  const preview = await astCommand(root, ['cache', 'prune'], { 'dry-run': true });
  assert.equal(preview.candidates, 1);
  assert.equal(preview.removed, 0);
  await assert.rejects(() => astCommand(root, ['cache', 'prune'], {}), /PRUNE AST CACHE/);
  const applied = await astCommand(root, ['cache', 'prune'], { confirm: 'PRUNE AST CACHE' });
  assert.equal(applied.removed, 1);
}));

test('adapter manifests are versioned structured argv contracts', () => {
  const adapter = validateAstAdapterManifest({
    protocolVersion: 1,
    id: 'typescript-reference',
    languages: ['typescript', 'javascript'],
    assurance: 'syntax',
    argv: ['node', '/opt/adapter.mjs'],
    extractorVersion: '1.0.0',
    capabilities: ['skeleton', 'query']
  });
  assert.deepEqual(adapter.argv, ['node', '/opt/adapter.mjs']);
  assert.throws(() => validateAstAdapterManifest({ ...adapter, protocolVersion: 2 }), /protocolVersion/);
});
