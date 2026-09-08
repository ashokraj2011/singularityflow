import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyFosGitSpeed, inspectFosGitSpeed } from '../src/fos-git-speed.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-speed-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'FOS Test'], root);
  git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, 'source.txt'), 'source\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'initial'], root);
  return root;
}

test('FOS:AC-032 Git speed doctor inspects without changing repository settings', async () => {
  const root = await repository();
  const before = git(['config', '--local', '--list'], root);
  const report = inspectFosGitSpeed(root);
  assert.equal(report.status, 'inspected');
  assert.equal(report.changed, false);
  assert.equal(git(['config', '--local', '--list'], root), before);
});

test('FOS:AC-032 explicit accelerator apply is repository-local and produces a receipt', async () => {
  const root = await repository();
  const applied = await applyFosGitSpeed(root, ['untracked-cache']);
  assert.equal(applied.status, 'applied');
  assert.equal(git(['config', '--local', '--get', 'core.untrackedCache'], root), 'true');
  assert.equal(applied.receipt.scope, 'repository-local');
  assert.deepEqual(applied.receipt.selected, ['untracked-cache']);
});

test('FOS:AC-032 custom accelerator values are preserved', async () => {
  const root = await repository();
  git(['config', '--local', 'core.fsmonitor', '/custom/hook'], root);
  await assert.rejects(() => applyFosGitSpeed(root, ['fsmonitor']),
    (error) => error.code === 'GIT_SPEED_CUSTOM_SETTING');
  assert.equal(git(['config', '--local', '--get', 'core.fsmonitor'], root), '/custom/hook');
});
