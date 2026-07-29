import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(packageRoot, 'scripts/worldmodel-minimal.sh');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-minimal-worldmodel-'));
  run('git', ['init', '-b', 'main'], root);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 1\n');
  return root;
}

test('minimum world-model script defaults to one quick local development build', async () => {
  const root = await repository();
  run('bash', ['-n', script], packageRoot);
  const result = run(script, ['--repository', root, '--dry-run'], packageRoot, {
    ...process.env,
    SINGULARITY_FLOW_BIN: '/opt/singularity-flow'
  });
  assert.match(result.stdout, /Mode: quick minimum/);
  assert.match(result.stdout, /\/opt\/singularity-flow wm build --depth quick --resume/);
  assert.match(result.stdout, /--views development/);
  assert.match(result.stdout, /--no-parallel/);
  assert.match(result.stdout, /--local/);
});

test('minimum world-model script can use phase policy, checkpoints, a target branch, and publication', async () => {
  const root = await repository();
  const result = run(script, [
    '--repository', root,
    '--phase', 'design',
    '--views', 'security',
    '--task', 'Design safely',
    '--branch', 'WORK-123',
    '--parallel',
    '--workers', '3',
    '--publish',
    '--dry-run'
  ], packageRoot, {
    ...process.env,
    SINGULARITY_FLOW_BIN: '/opt/singularity-flow'
  });
  assert.match(result.stdout, /--phase design/);
  assert.match(result.stdout, /--views security/);
  assert.match(result.stdout, /--task Design\\ safely/);
  assert.match(result.stdout, /--branch WORK-123/);
  assert.match(result.stdout, /--parallel --workers 3/);
  assert.doesNotMatch(result.stdout, /--local/);
});
