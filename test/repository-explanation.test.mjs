/**
 * Whole-repository code explanation: what a repository holds, by folder, with declarations, tests
 * and clause tags. The AST budget decides what is explained up front: a repository within it is
 * explained whole and indexed in the background once a workspace has its checkout; a larger one is
 * explained a folder or file at a time, and nothing is indexed until someone asks.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { latestStoryStartAstWarmStatus, readRepositoryAstWarmStatus } from '../src/ast-story-start-status.mjs';
import { runStoryStartAstWarmWorker } from '../src/ast-story-start-warm.mjs';
import { explainRepository, scheduleRepositoryAstWarm } from '../src/comprehension/repository-explanation.mjs';
import { cliJson, createChangeRepository, git, isolatedHome } from './helpers/xpl2-fixture.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

const SHOP = {
  'src/cart.js': '// @clause:SHOP:REQ-001 — sums item prices\nexport function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n',
  'src/pay/card.js': 'export function charge(amount) {\n  return amount;\n}\n',
  'src/pay/refund.js': 'export class Refund {\n}\n',
  'test/cart.test.js': "import test from 'node:test';\n// @ac:SHOP:AC-001\ntest('total', () => {});\n",
  'package.json': '{ "type": "module" }\n'
};

async function shop(t, { maxFiles = null } = {}) {
  const home = await isolatedHome(t);
  const repository = await createChangeRepository(t, {
    baseline: SHOP,
    prepare: async (root) => {
      assert.equal(cliJson(root, home, ['init']).status, 0);
      if (!maxFiles) return;
      const file = path.join(root, 'singularity', 'workflow.yml');
      const definition = YAML.parse(await readFile(file, 'utf8'));
      definition.ast = { ...definition.ast, budgets: { ...definition.ast?.budgets, maxFiles } };
      await writeFile(file, YAML.stringify(definition));
    }
  });
  return { ...repository, home };
}

const explain = (root, home, ...args) => cliJson(root, home, ['explain', 'code', '--repository', ...args, '--json']);

test('a repository within the AST budget is explained whole: folders, declarations, tests and clause tags', async (t) => {
  const { root, home } = await shop(t);
  const result = explain(root, home);
  assert.equal(result.status, 0, result.stderr);
  const explanation = result.json.data.repository;
  assert.equal(explanation.kind, 'repository-explanation');
  assert.equal(explanation.budget.status, 'within-budget');
  assert.deepEqual(explanation.files.map((file) => file.path),
    ['package.json', 'src/cart.js', 'src/pay/card.js', 'src/pay/refund.js', 'test/cart.test.js']);
  assert.ok(explanation.hiddenSingularityFiles > 0, 'Singularity Flow\'s own files are counted, not shown');
  assert.deepEqual(explanation.entries.map((entry) => [entry.path, entry.kind, entry.files]),
    [['src', 'folder', 3], ['test', 'folder', 1], ['package.json', 'file', 1]]);
  const declared = Object.fromEntries(explanation.files.map((file) => [file.path, file.symbols.map((symbol) => `${symbol.kind} ${symbol.name}`)]));
  assert.deepEqual(declared['src/cart.js'], ['function total']);
  assert.deepEqual(declared['src/pay/card.js'], ['function charge']);
  assert.deepEqual(declared['src/pay/refund.js'], ['class Refund']);
  assert.equal(explanation.files.find((file) => file.path === 'test/cart.test.js').test, true);
  assert.deepEqual(explanation.clauses, [
    { clauseId: 'SHOP:AC-001', code: [], tests: [{ path: 'test/cart.test.js', line: 2 }] },
    { clauseId: 'SHOP:REQ-001', code: [{ path: 'src/cart.js', line: 1, note: 'sums item prices' }], tests: [] }
  ]);
  assert.equal(explanation.index.built, true, 'a cold index is filled for the scope asked about');

  // The same HEAD is read, not rebuilt.
  const again = explain(root, home).json.data.repository;
  assert.equal(again.index.built, false);
  assert.equal(again.index.counts.symbols, 3);
  assert.match(cliJson(root, home, ['explain', 'code', '--repository']).stdout,
    /src\/cart\.js[^\n]*\n\s+function total L2\n\s+@clause SHOP:REQ-001 at L1: “sums item prices”/u);
});

test('a repository over the AST budget is explained a folder at a time and indexes nothing until asked', async (t) => {
  const { root, home } = await shop(t, { maxFiles: 3 });
  const whole = explain(root, home);
  assert.equal(whole.status, 0, whole.stderr);
  const explanation = whole.json.data.repository;
  assert.deepEqual({ status: explanation.budget.status, reason: explanation.budget.reason, files: explanation.budget.files },
    { status: 'over-budget', reason: 'file-budget', files: 5 });
  assert.equal(explanation.index.status, 'not-indexed');
  assert.deepEqual(explanation.files, []);
  assert.deepEqual(explanation.entries.map((entry) => [entry.path, entry.files]), [['src', 3], ['test', 1], ['package.json', 1]]);
  assert.ok(whole.json.next.some((entry) => entry.command === 'singularity-flow explain code --repository --path src'));
  assert.equal(await readRepositoryAstWarmStatus(root), null, 'nothing was indexed');

  const folder = explain(root, home, '--path', 'src/pay').json.data.repository;
  assert.equal(folder.budget.status, 'within-budget');
  assert.deepEqual(folder.files.map((file) => [file.path, file.symbols.map((symbol) => symbol.name)]),
    [['src/pay/card.js', ['charge']], ['src/pay/refund.js', ['Refund']]]);
  assert.equal((await readRepositoryAstWarmStatus(root, 'src/pay')).status, 'complete');
  const file = explain(root, home, '--path', 'src/cart.js').json.data.repository;
  assert.equal(file.scope.kind, 'file');
  assert.deepEqual(file.files[0].symbols.map((symbol) => symbol.name), ['total']);
});

test('a scope must be a tracked application folder or file', async (t) => {
  const { root, home } = await shop(t);
  for (const [scope, pattern] of [
    ['../outside', /without '\.\.'/u],
    ['singularity', /only Singularity Flow's own files/u],
    ['src/missing', /No tracked file is at src\/missing/u]
  ]) {
    const result = explain(root, home, '--path', scope);
    assert.notEqual(result.status, 0, scope);
    assert.match(JSON.stringify(result.json), pattern, scope);
  }
  const mixed = explain(root, home, '--since', 'HEAD');
  assert.notEqual(mixed.status, 0);
  assert.match(JSON.stringify(mixed.json), /does not take --since/u);
});

test('files that differ from HEAD are explained as they are now', async (t) => {
  const { root, home } = await shop(t);
  assert.equal(explain(root, home).status, 0);
  await writeFile(path.join(root, 'src/pay/card.js'),
    'export function charge(amount) {\n  return amount * 2;\n}\nexport function refund(amount) {\n  return -amount;\n}\n');
  const explanation = explain(root, home).json.data.repository;
  assert.deepEqual(explanation.files.find((file) => file.path === 'src/pay/card.js').symbols.map((symbol) => symbol.name), ['charge', 'refund']);
  assert.equal(explanation.index.counts.workingTreeFiles, 1);
  assert.equal(explanation.index.counts.notIndexedFiles, 0);
});

test('a checkout queues its background index only when its code fits the budget', async (t) => {
  const { root } = await shop(t);
  let launched = null;
  const scheduled = await scheduleRepositoryAstWarm(root, { launcher: (where, key) => { launched = { where, key }; } });
  assert.equal(scheduled.status, 'scheduled');
  assert.deepEqual(launched, { where: root, key: '@repository' });
  const done = await runStoryStartAstWarmWorker(root, '@repository');
  assert.equal(done.status, 'complete');
  assert.equal(done.result.selected, 5, 'exactly the application files are indexed');
  assert.equal(await latestStoryStartAstWarmStatus(root), null, 'a repository warm is not reported as a Story-start warm');
  const explanation = await explainRepository(root);
  assert.equal(explanation.index.built, false);
  assert.deepEqual({ mode: explanation.index.warm.mode, status: explanation.index.warm.status }, { mode: 'background', status: 'complete' });
  assert.equal(explanation.index.counts.notIndexedFiles, 0);

  const big = await shop(t, { maxFiles: 2 });
  let launchedBig = false;
  const skipped = await scheduleRepositoryAstWarm(big.root, { launcher: () => { launchedBig = true; } });
  assert.deepEqual({ status: skipped.status, reason: skipped.reason }, { status: 'skipped', reason: 'over-budget' });
  assert.equal(launchedBig, false);
});

test('workspace creation indexes the cloned repository in the background, and its explanation says so', { timeout: 120_000 }, async (t) => {
  const { root, home } = await shop(t);
  const remote = `${root}-remote.git`;
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'push', '-q', remote, 'HEAD:main');
  t.after(() => spawnSync('rm', ['-rf', remote]));
  // The detached worker is suppressed inside the test runner; this run is the real product path.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const created = spawnSync(process.execPath, [CLI, 'workspace', 'create', '--local', '--id', 'WS-1', '--name', 'Shop',
    '--repository', `shop=${remote}`, '--lead', 'shop', '--clone', '--base', path.join(home, 'workspaces'),
    '--confirm', 'WS-1', '--json'], {
    cwd: home, encoding: 'utf8',
    env: {
      ...env, HOME: home, USERPROFILE: home, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(home, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(home, 'active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(home, 'leads.json')
    }
  });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const result = JSON.parse(created.stdout);
  assert.deepEqual(result.codeIndex, [{ repository: 'shop', status: 'scheduled', reason: null }]);
  const checkout = path.join(result.workspace.path, 'repos', 'shop');
  let warm = null;
  for (let attempt = 0; attempt < 150 && !['complete', 'partial', 'failed', 'skipped'].includes(warm?.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    warm = await readRepositoryAstWarmStatus(checkout);
  }
  assert.equal(warm?.status, 'complete', JSON.stringify(warm));
  const explanation = explain(checkout, home).json.data.repository;
  assert.equal(explanation.index.built, false, 'the background index answers; nothing is rebuilt');
  assert.deepEqual({ mode: explanation.index.warm.mode, status: explanation.index.warm.status }, { mode: 'background', status: 'complete' });
  assert.equal(explanation.index.counts.symbols, 3);
});
