import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');

function command(executable, args, cwd, { allowFailure = false, selection = true } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Story Developer',
    ...(selection ? { SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'developer' }) } : {})
  };
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, args, options = {}) {
  return command('git', args, root, { ...options, selection: false });
}

function flow(root, args, options = {}) {
  return command(process.execPath, [bin, ...args], root, options);
}

async function repository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-lineage-'));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  git(base, ['init', '--bare', remote]);
  git(base, ['init', '-b', 'main', root]);
  git(root, ['config', 'user.name', 'Story Developer']);
  git(root, ['config', 'user.email', 'developer@example.com']);
  git(root, ['remote', 'add', 'origin', remote]);
  await writeFile(path.join(root, 'README.md'), '# Story lineage fixture\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize Story repository']);
  git(root, ['push', '-u', 'origin', 'main']);
  return { root, remote };
}

test('registered child branches publish hash-bound review packets and unknown branches require a parent Story', async () => {
  const { root, remote } = await repository();
  flow(root, ['start', 'MOB-123', '--title', 'Build mobile login']);
  flow(root, ['story', 'branch', 'create', 'feature/login-ui', '--parent', 'MOB-123']);

  const status = JSON.parse(flow(root, ['story', 'branch', 'status', '--parent', 'MOB-123', '--json']).stdout);
  assert.equal(status.workId, 'MOB-123');
  assert.equal(status.canonicalBranch, 'MOB-123');
  assert.equal(status.currentBranch, 'feature/login-ui');
  assert.equal(status.kind, 'child');
  assert.equal(status.registered, true);

  const workflowPath = path.join(root, 'singularity/work-items/MOB-123/workflow.json');
  let workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  const artifactPath = path.join(root, 'singularity/work-items/MOB-123/artifacts/intake/intake.md');
  await writeFile(
    artifactPath,
    (await readFile(artifactPath, 'utf8'))
      .replace(/TODO:[^\n]*/g, 'Complete Epic-derived scope and acceptance evidence for the mobile login Story.')
      .replace(/\bTODO\b/g, 'Complete')
  );
  flow(root, ['phase', 'publish', 'intake']);
  const submitted = flow(root, ['story', 'submit']);
  assert.match(submitted.stdout, /Review packet:/);

  workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  const record = workflow.lineage.submissions.at(-1);
  assert.equal(record.branch, 'feature/login-ui');
  assert.match(record.packetSha256, /^[a-f0-9]{64}$/);
  const packet = JSON.parse(await readFile(path.join(root, record.path), 'utf8'));
  assert.equal(packet.workId, 'MOB-123');
  assert.equal(packet.canonicalBranch, 'MOB-123');
  assert.equal(packet.submittedBranch, 'feature/login-ui');
  assert.equal(packet.packetSha256, record.packetSha256);
  assert.match(
    git(root, ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'refs/heads/feature/login-ui']).stdout,
    new RegExp(record.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );

  git(root, ['switch', '-c', 'feature/unregistered']);
  const blocked = flow(root, ['persona', 'MOB-123'], { allowFailure: true, selection: false });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /not registered for Story 'MOB-123'/);
  assert.match(blocked.stderr, /story branch attach --parent MOB-123/);
});
