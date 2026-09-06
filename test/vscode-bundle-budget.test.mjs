import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildVsCodeBundleBudgetReport } from '../src/vscode-bundle-budget.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(await readFile(
  path.join(root, 'benchmarks', 'dx', 'vscode-bundle-budgets.json'), 'utf8'
));

test('every shipped VS Code runtime has a reviewed byte and module ceiling', () => {
  for (const [name, limits] of Object.entries(policy.entries)) {
    assert.match(name, /^[a-z0-9-]+\.cjs$/);
    assert.ok(Number.isSafeInteger(limits.maximumBytes) && limits.maximumBytes > 0, `${name} byte ceiling`);
    assert.ok(Number.isSafeInteger(limits.maximumModules) && limits.maximumModules > 0, `${name} module ceiling`);
  }
  const pass = buildVsCodeBundleBudgetReport(Object.fromEntries(
    Object.entries(policy.entries).map(([name]) => [name, {
      bytes: 1, modules: 1
    }])
  ), policy);
  assert.equal(pass.status, 'passed');
});

test('bundle budgets refuse oversized, missing, and unreviewed runtime graphs', () => {
  const measured = Object.fromEntries(Object.entries(policy.entries).map(([name]) => [name, {
    bytes: 1, modules: 1
  }]));
  const first = Object.keys(policy.entries)[0];
  measured[first].bytes = policy.entries[first].maximumBytes + 1;
  delete measured[Object.keys(policy.entries)[1]];
  measured['surprise-runtime.cjs'] = { bytes: 1, modules: 1 };
  const report = buildVsCodeBundleBudgetReport(measured, policy);
  assert.equal(report.status, 'failed');
  assert.ok(report.failures.some((failure) => failure.startsWith(`${first}:bytes>`)));
  assert.ok(report.failures.some((failure) => failure.endsWith(':measurement-missing')));
  assert.ok(report.failures.includes('surprise-runtime.cjs:unbudgeted-entry'));
});

test('the built VS Code CommonJS closure remains inside the reviewed budget', { timeout: 120_000 }, () => {
  const run = spawnSync(process.execPath, ['scripts/vscode-bundle-budget.mjs', '--json'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'passed');
  assert.deepEqual(Object.keys(report.entries).sort(), Object.keys(policy.entries).sort());
  assert.ok(report.totalJavaScriptBytes <= policy.totalJavaScriptBytes.maximum);
  assert.doesNotMatch(run.stdout, /\/Users\/|[A-Z]:\\|repositoryPath|workId|identity/);
});
