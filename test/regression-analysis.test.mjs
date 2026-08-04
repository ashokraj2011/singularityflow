import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeRegression, regressionReportMarkdown } from '../src/regression-analysis.mjs';
import { run } from '../src/util.mjs';

function git(cwd, args) { return run('git', args, { cwd }).stdout.trim(); }

test('regression analysis ranks focused changes and exposes merge history without mutating Git', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-regression-'));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.com']);
  await writeFile(path.join(root, 'rules.js'), 'export const rule = true;\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'initial']);
  const good = git(root, ['rev-parse', 'HEAD']);
  git(root, ['switch', '-c', 'feature']);
  await writeFile(path.join(root, 'rules.js'), 'export const rule = false;\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'change rule behavior']);
  const focused = git(root, ['rev-parse', 'HEAD']);
  git(root, ['switch', 'main']);
  await writeFile(path.join(root, 'README.md'), '# docs\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'docs']);
  git(root, ['merge', '--no-ff', 'feature', '-m', 'merge feature regression fix']);
  const before = git(root, ['rev-parse', 'HEAD']);

  const report = analyzeRegression(root, { base: 'main', good, bad: 'HEAD', paths: ['rules.js'] });
  assert.equal(report.bad, before);
  assert.ok(report.mergeCommits.length >= 1);
  assert.equal(report.candidates[0].commit, focused, 'the focused path change outranks the merge wrapper');
  assert.match(report.caveat, /reproducible failing test/);
  assert.match(regressionReportMarkdown(report), /Regression investigation/);
  assert.equal(git(root, ['rev-parse', 'HEAD']), before, 'analysis must not move HEAD');
});
