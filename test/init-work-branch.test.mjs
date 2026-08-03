import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('init check finds missing assets and repair restores them without overwriting custom files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-repair-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Branch Repair Tester');
  git(root, 'config', 'user.email', 'branch-repair@example.com');
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'initial');
  run(process.execPath, [cli, 'init', '--work-id', 'WORK-REPAIR', '--base', 'main'], root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const customizedWorkflow = `${await readFile(workflowPath, 'utf8')}\n# company customization remains\n`;
  await writeFile(workflowPath, customizedWorkflow);
  await rm(path.join(root, '.github/agents/qa.agent.md'));
  await rm(path.join(root, 'singularity/prompts/copilot-planning.md'));

  const before = JSON.parse(run(process.execPath, [cli, 'init', '--check', '--json'], root).stdout);
  assert.equal(before.complete, false);
  assert.ok(before.missingFiles.includes('.github/agents/qa.agent.md'));
  assert.ok(before.missingFiles.includes('singularity/prompts/copilot-planning.md'));

  const repaired = run(process.execPath, [cli, 'init', '--repair'], root);
  assert.match(repaired.stdout, /Repaired/);
  const after = JSON.parse(run(process.execPath, [cli, 'init', '--check', '--json'], root).stdout);
  assert.equal(after.complete, true);
  assert.equal(after.missingFiles.length, 0);
  assert.equal(await readFile(workflowPath, 'utf8'), customizedWorkflow);
  assert.match(await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8'), /\S/);
  assert.match(await readFile(path.join(root, 'singularity/prompts/copilot-planning.md'), 'utf8'), /\S/);
});
