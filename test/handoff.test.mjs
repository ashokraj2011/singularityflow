import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(cwd, args, persona = 'product-owner') {
  return run(process.execPath, [bin, ...args], cwd, { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Handoff Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona }) });
}

function identity(root, name) {
  run('git', ['config', 'user.name', name], root);
  run('git', ['config', 'user.email', `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`], root);
}

test('another clone resumes by work ID and fast-forwards tracked state', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-handoff-'));
  const remote = path.join(base, 'remote.git');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');

  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', first], base);
  identity(first, 'First Contributor');
  await writeFile(path.join(first, 'README.md'), '# Handoff test\n');
  run('git', ['add', 'README.md'], first);
  run('git', ['commit', '-m', 'initial'], first);
  run('git', ['remote', 'add', 'origin', remote], first);
  flow(first, ['init']);
  run('git', ['add', '.sdlc'], first);
  run('git', ['commit', '-m', 'configure workflow'], first);
  run('git', ['push', '-u', 'origin', 'main'], first);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  flow(first, ['start', 'HAND-101', '--title', 'Handoff test']);
  const intakePath = path.join(first, '.sdlc', 'work-items', 'HAND-101', 'artifacts', 'intake', 'intake.md');
  const intake = (await readFile(intakePath, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete handoff evidence and measurable outcomes for another terminal.');
  await writeFile(intakePath, intake);
  flow(first, ['phase', 'publish', 'intake']);
  flow(first, ['submit']);
  flow(first, ['approve', '--yes']);

  run('git', ['clone', '--no-hardlinks', remote, second], base);
  identity(second, 'Second Contributor');
  flow(second, ['resume', 'HAND-101', '--fetch'], 'architect');
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'HAND-101');
  const workflow = JSON.parse(await readFile(path.join(second, '.sdlc', 'work-items', 'HAND-101', 'workflow.json'), 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');

  await writeFile(path.join(first, 'handoff-note.txt'), 'Remote handoff update\n');
  run('git', ['add', 'handoff-note.txt'], first);
  run('git', ['commit', '-m', 'HAND-101 add handoff note'], first);
  run('git', ['push'], first);

  flow(second, ['resume', 'HAND-101', '--fetch'], 'developer');
  assert.equal(await readFile(path.join(second, 'handoff-note.txt'), 'utf8'), 'Remote handoff update\n');
  assert.equal(run('git', ['status', '--porcelain'], second).stdout.trim(), '');
});
