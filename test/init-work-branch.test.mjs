import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, ...args) {
  return run('git', args, root).stdout.trim();
}

test('init can bootstrap configuration on a Work-ID branch without changing main', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-work-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Branch Bootstrap Tester');
  git(root, 'config', 'user.email', 'branch-bootstrap@example.com');
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'initial');
  const mainBefore = git(root, 'rev-parse', 'main');

  const initialized = run(process.execPath, [
    cli, 'init', '--work-id', 'WORK-123', '--base', 'main'
  ], root);

  assert.equal(git(root, 'branch', '--show-current'), 'WORK-123');
  assert.equal(git(root, 'rev-parse', 'main'), mainBefore);
  assert.equal(git(root, 'rev-parse', 'WORK-123'), mainBefore);
  assert.match(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'), /defaultBaseBranch: main/);
  assert.match(initialized.stdout, /Initialized Singularity Flow on Work-ID branch WORK-123/);
  assert.match(initialized.stdout, /base branch was not modified/);
  assert.match(initialized.stdout, /singularity-flow start WORK-123/);
});

test('branch-local init refuses to carry uncommitted changes to the Work-ID branch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-dirty-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Branch Bootstrap Tester');
  git(root, 'config', 'user.email', 'branch-bootstrap@example.com');
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'initial');
  await writeFile(path.join(root, 'uncommitted.txt'), 'do not carry me\n');

  const result = spawnSync(process.execPath, [
    cli, 'init', '--work-id', 'WORK-124', '--base', 'main'
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Working tree is not clean/);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});
