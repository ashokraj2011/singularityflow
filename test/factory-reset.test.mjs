import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function command(executable, args, cwd, { ok = true } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });
  if (ok) assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, ...args) {
  return command('git', args, root).stdout.trim();
}

async function missing(file) {
  try { await access(file); return false; } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

test('factory reset previews, requires exact confirmation, and restores npm defaults without touching source or history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'application source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const beforeHead = git(root, 'rev-parse', 'HEAD');

  command(process.execPath, [cli, 'init'], root);
  const workflow = path.join(root, 'singularity', 'workflow.yml');
  await writeFile(workflow, `${await readFile(workflow, 'utf8')}\n# local customization removed by reset\n`);
  await mkdir(path.join(root, 'singularity', 'work-items', 'WORK-1'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'work-items', 'WORK-1', 'workflow.json'), '{}\n');
  const localRuntime = path.join(root, '.git', 'singularity-flow');
  await mkdir(localRuntime, { recursive: true });
  await writeFile(path.join(localRuntime, 'session.json'), '{"workId":"WORK-1"}\n');
  const qaAgent = path.join(root, '.github', 'agents', 'qa.agent.md');
  await writeFile(qaAgent, 'customized packaged agent\n');
  const customAgent = path.join(root, '.github', 'agents', 'company-specialist.agent.md');
  const customAgentContent = `---
name: company-specialist
description: Preserved repository-specific agent.
tools: [read]
---

# Company specialist

Preserve this custom repository agent during a factory reset.
`;
  await writeFile(customAgent, customAgentContent);

  const preview = command(process.execPath, [cli, 'factory-reset', '--dry-run', '--json'], root);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.operation, 'factory-reset');
  assert.equal(plan.confirmation, `RESET ${path.basename(root)}`);
  assert.equal(await readFile(workflow, 'utf8').then((text) => text.includes('local customization')), true);

  const refused = command(process.execPath, [cli, 'factory-reset', '--confirm', 'RESET WRONG'], root, { ok: false });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires exact confirmation/);

  const reset = command(process.execPath, [
    cli, 'factory-reset', '--confirm', plan.confirmation, '--json'
  ], root);
  const result = JSON.parse(reset.stdout);
  assert.equal(result.completed, true);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'application source remains\n');
  assert.equal(await readFile(workflow, 'utf8'), await readFile(path.join(packageRoot, 'templates', 'workflow.yml'), 'utf8'));
  assert.equal(await readFile(qaAgent, 'utf8'), await readFile(path.join(packageRoot, 'templates', 'agents', 'qa.agent.md'), 'utf8'));
  assert.equal(await readFile(customAgent, 'utf8'), customAgentContent);
  assert.equal(await missing(path.join(root, 'singularity', 'work-items')), true);
  assert.equal(await missing(localRuntime), true);

  const check = command(process.execPath, [cli, 'init', '--check', '--json'], root);
  assert.equal(JSON.parse(check.stdout).complete, true);
});

test('factory reset refuses symbolic-link control roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-link-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-outside-'));
  command('ln', ['-s', outside, path.join(root, 'singularity')], root);

  const result = command(process.execPath, [cli, 'factory-reset', '--dry-run'], root, { ok: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be a symbolic link/);
});
