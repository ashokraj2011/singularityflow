import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  classifyPartialCloneResult, cloneStrategyArguments, normalizeCloneStrategy, REQUIRED_SPARSE_ROOTS
} from '../src/clone-strategy.mjs';
import { worldModelSourceSnapshot } from '../src/grounding.mjs';
import { porcelainV2RecordCount, repositoryPerformanceSnapshot } from '../src/performance-doctor.mjs';
import { run } from '../src/util.mjs';
import { createWorkspaceConfiguration } from '../src/workspace.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-monorepo-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Test User'], { cwd: root });
  run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  for (const directory of ['apps/payments', 'apps/catalog', 'packages/shared', 'singularity']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'apps/payments/index.js'), 'export const payment = 1;\n');
  await writeFile(path.join(root, 'apps/catalog/index.js'), 'export const catalog = 1;\n');
  await writeFile(path.join(root, 'packages/shared/index.js'), 'export const shared = 1;\n');
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 1\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-m', 'seed'], { cwd: root });
  return root;
}

const scoped = {
  worldModel: { sourceRoots: ['apps/payments'], sharedRoots: ['packages/shared'] }
};

test('porcelain-v2 counts a rename as one logical status entry', () => {
  const rename = '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 new-name.js\0old-name.js\0';
  const ordinary = '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb source.js\0';
  const untracked = '? new-file.js\0';
  assert.equal(porcelainV2RecordCount(`${rename}${ordinary}${untracked}`), 3);
});

test('partial-clone fallback distinguishes capability refusal from office transport failures', () => {
  assert.equal(classifyPartialCloneResult({
    status: 128, stderr: 'fatal: Authentication failed for https://example.invalid/repo.git'
  }).kind, 'transport-failed');
  assert.equal(classifyPartialCloneResult({
    status: 128, stderr: 'fatal: unable to access repository: SSL certificate problem'
  }).kind, 'transport-failed');
  assert.equal(classifyPartialCloneResult({
    status: 1, stderr: 'fatal: server does not support filter blob:none'
  }).kind, 'filter-rejected');
  assert.equal(classifyPartialCloneResult({
    status: 0, stderr: 'warning: --filter is ignored in local clones', stdout: ''
  }, { configured: false }).kind, 'filter-ignored');
  assert.equal(classifyPartialCloneResult({ status: 0 }, { configured: true }).kind,
    'partial-established');
});

function looseObjects(root) {
  const line = run('git', ['count-objects', '-v'], { cwd: root }).stdout
    .split(/\r?\n/).find((entry) => entry.startsWith('count:'));
  return Number(line?.split(':')[1]?.trim() ?? 0);
}

test('world-model fingerprints ignore unrelated monorepo bytes and do not write Git objects', async () => {
  const root = await repository();
  const initial = await worldModelSourceSnapshot(root, scoped);
  assert.deepEqual(initial.files.map((entry) => entry.path), [
    'apps/payments/index.js', 'packages/shared/index.js'
  ]);
  const objects = looseObjects(root);

  await writeFile(path.join(root, 'apps/catalog/index.js'), 'export const catalog = 2;\n');
  const unrelated = await worldModelSourceSnapshot(root, scoped);
  assert.equal(unrelated.sha256, initial.sha256);
  assert.equal(looseObjects(root), objects);

  await writeFile(path.join(root, 'apps/payments/index.js'), 'export const payment = 2;\n');
  const related = await worldModelSourceSnapshot(root, scoped);
  assert.notEqual(related.sha256, initial.sha256);
  assert.equal(looseObjects(root), objects);
});

test('world-model reads never execute repository clean filters', async () => {
  const root = await repository();
  const marker = path.join(root, 'clean-filter-ran');
  await writeFile(path.join(root, '.gitattributes'), 'apps/payments/*.js filter=sflow-test\n');
  run('git', ['add', '.gitattributes'], { cwd: root });
  run('git', ['commit', '-m', 'filter contract'], { cwd: root });
  run('git', ['config', 'filter.sflow-test.clean', `sh -c 'printf ran > "${marker}"; cat'`], { cwd: root });
  run('git', ['config', 'filter.sflow-test.required', 'true'], { cwd: root });
  await writeFile(path.join(root, 'apps/payments/index.js'), 'export const payment = 3;\n');

  await worldModelSourceSnapshot(root, scoped);
  await assert.rejects(readFile(marker), (error) => error?.code === 'ENOENT');
});

test('blobless sparse strategy retains governance roots and performance diagnostics report scope', async () => {
  const strategy = normalizeCloneStrategy({
    mode: 'blobless-sparse', sparseCone: ['apps/payments'], fallback: 'refuse'
  });
  assert.deepEqual(cloneStrategyArguments(strategy), ['--filter=blob:none', '--sparse']);
  assert.deepEqual(strategy.sparseCone, [...REQUIRED_SPARSE_ROOTS, 'apps/payments'].sort());

  const root = await repository();
  const report = await repositoryPerformanceSnapshot(root, scoped);
  assert.equal(report.files.tracked, 4);
  assert.equal(report.files.scoped, 2);
  assert.equal(report.scope.all, false);
  assert.equal(report.fingerprint, (await worldModelSourceSnapshot(root, scoped)).sha256);
  assert.ok(report.timings.status.warmMs >= 0);
  assert.ok(report.timings.worldModelFingerprint.warmMs >= 0);
});

test('workspace materialization honors blobless sparse checkout without touching the remote branch', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-sparse-workspace-'));
  const source = path.join(base, 'source');
  const bare = path.join(base, 'platform.git');
  await mkdir(source);
  run('git', ['init', '-b', 'main'], { cwd: source });
  run('git', ['config', 'user.name', 'Test User'], { cwd: source });
  run('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
  for (const directory of ['apps/payments', 'apps/catalog', 'singularity', '.github/agents']) {
    await mkdir(path.join(source, directory), { recursive: true });
    await writeFile(path.join(source, directory, 'kept.txt'), `${directory}\n`);
  }
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-m', 'seed'], { cwd: source });
  const original = run('git', ['rev-parse', 'main'], { cwd: source }).stdout.trim();
  run('git', ['clone', '--bare', source, bare], { cwd: base });
  run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: bare });

  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(base, 'workspaces'),
    id: 'payments',
    name: 'Payments',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: pathToFileURL(bare).href,
        defaultBranch: 'main',
        clone: { mode: 'blobless-sparse', sparseCone: ['apps/payments'], fallback: 'refuse' }
      }
    }
  }, { confirmation: 'payments' });

  const checkout = path.join(created.workspace.path, 'repos/platform');
  assert.equal(existsSync(path.join(checkout, 'apps/payments/kept.txt')), true);
  assert.equal(existsSync(path.join(checkout, 'apps/catalog')), false);
  assert.equal(existsSync(path.join(checkout, 'singularity/kept.txt')), true);
  assert.equal(existsSync(path.join(checkout, '.github/agents/kept.txt')), true);
  assert.equal(run('git', ['config', '--get', 'remote.origin.promisor'], { cwd: checkout }).stdout.trim(), 'true');
  run('git', ['remote', 'set-url', 'origin', pathToFileURL(path.join(base, 'unreachable.git')).href], { cwd: checkout });
  const absentScope = await worldModelSourceSnapshot(checkout, {
    worldModel: { sourceRoots: ['apps/catalog'] }
  });
  assert.deepEqual(absentScope.files.map((entry) => ({ path: entry.path, materialization: entry.materialization })), [
    { path: 'apps/catalog/kept.txt', materialization: 'sparse-absent' }
  ], 'a read-only fingerprint must use the sparse index without fetching the omitted blob');

  const fallbackTrace = path.join(base, 'fallback-trace.jsonl');
  const fallback = await createWorkspaceConfiguration({
    baseDirectory: path.join(base, 'fallback-workspaces'),
    id: 'explicit-full-fallback',
    name: 'Explicit full fallback',
    leadRepository: 'platform',
    repositories: {
      platform: {
        // A direct local-path clone is how Git demonstrates an unsupported filter: it exits zero
        // but warns that --filter was ignored. That must not masquerade as a partial clone.
        url: bare,
        defaultBranch: 'main',
        clone: { mode: 'blobless', fallback: 'full' }
      }
    }
  }, {
    confirmation: 'explicit-full-fallback',
    env: { ...process.env, GIT_TRACE2_EVENT: fallbackTrace }
  });
  assert.equal(fallback.materialization[0].fallbackUsed, true);
  assert.equal(fallback.materialization[0].requested.mode, 'blobless');
  assert.equal(fallback.materialization[0].actual.mode, 'full');
  const fallbackEvents = (await readFile(fallbackTrace, 'utf8')).trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(fallbackEvents.filter((event) => event.event === 'cmd_name' && event.name === 'clone').length, 1,
    'a successful clone which ignored filtering is retained instead of downloading the monorepo twice');
  const refusedRoot = path.join(base, 'refused-workspaces');
  await assert.rejects(createWorkspaceConfiguration({
    baseDirectory: refusedRoot,
    id: 'refuse-full-fallback',
    name: 'Refuse full fallback',
    leadRepository: 'platform',
    repositories: {
      platform: { url: bare, defaultBranch: 'main', clone: { mode: 'blobless', fallback: 'refuse' } }
    }
  }, { confirmation: 'refuse-full-fallback' }), /did not establish a blobless partial clone/);
  assert.equal(existsSync(path.join(refusedRoot, 'refuse-full-fallback/repos/platform/.git')), false,
    'a server which ignores filtering leaves no accidental full clone behind');
  assert.equal(run('git', ['rev-parse', 'refs/heads/main'], { cwd: bare }).stdout.trim(), original,
    'workspace creation is read-only with respect to the selected base branch');
});

test('the performance report measures the AST read twice, so failed automatic warming is visible', async () => {
  /**
   * Everything else in this report is measured cold and warm. AST reads now warm immutable
   * content-addressed skeletons automatically, so measuring twice exposes a cache path that is
   * unavailable, ineffective, or dominated by repository census and cache-read cost.
   *
   * Measured on this repository's own checkout: `status` warmed to 63% of its cold cost and the
   * world-model fingerprint to 51%, while a repeated AST read cost 86% — the shape of no cache at
   * all, next to two that work.
   *
   * The assertion is on the measurement, not on the ratio. A three-file fixture is too small and too
   * fast for a warm/cold ratio to mean anything, and pinning one here would be a test of scheduler
   * noise. What must not regress is that the number is taken and reported.
   */
  const root = await repository();
  const report = await repositoryPerformanceSnapshot(root, {});

  const ast = report.timings.astContext;
  assert.ok(ast, 'the report no longer measures the AST read');
  if (ast.unavailable) {
    // A disabled extractor is a legitimate answer, but it has to say so rather than report a zero.
    assert.ok(ast.unavailable.length > 0);
    assert.equal(ast.coldMs, null);
  } else {
    assert.ok(Number.isFinite(ast.coldMs) && ast.coldMs >= 0, 'no cold AST measurement');
    assert.ok(Number.isFinite(ast.warmMs) && ast.warmMs >= 0, 'no warm AST measurement');
    assert.ok(Number.isInteger(ast.facts), 'the report does not say how much the AST read returned');
  }

  // The recommendation exists and is reachable: it turns the ratio into an explicit diagnostic and
  // retains the fail-closed build command for a deliberate rebuild.
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/performance-doctor.mjs'), 'utf8');
  assert.match(source, /id: 'ast-cache-cold'/);
  assert.match(source, /wm ast build/, 'the advice does not name the command that warms the store');
});
