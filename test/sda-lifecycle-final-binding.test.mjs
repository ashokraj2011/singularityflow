/**
 * SDA-AC-011 under M4: a governed transition binds to the lifecycle authority itself, read through the
 * adapter at the moment it publishes, never to an advisory read. With the read index just refreshed,
 * a Story branch another clone has advanced refuses the transition as a revision conflict and leaves
 * the checkout, the remote and the recovery records exactly as they were.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Publisher',
  SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
function run(command, args, cwd, { fail = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const git = (cwd, args) => run('git', args, cwd).stdout.trim();
const flow = (cwd, args, options) => run(process.execPath, [bin, ...args], cwd, options);

test('a Story transition refuses a branch another clone advanced, with the advisory index fresh (SDA-AC-011)', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-final-binding-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  for (const [key, value] of [['user.name', 'Publisher'], ['user.email', 'publisher@example.com']]) git(root, ['config', key, value]);
  git(root, ['remote', 'add', 'origin', remote]);
  await writeFile(path.join(root, 'README.md'), '# final binding\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['push', '-u', 'origin', 'main']);
  flow(root, ['start', 'BIND-1', '--from-branch', 'main']);
  const artifact = path.join(root, 'singularity/work-items/BIND-1/artifacts/intake/intake.md');
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Bind the governed transition to the live Story branch.'));
  git(root, ['push', '-q', 'origin', 'BIND-1']);

  // The advisory read is as fresh as it can be.
  flow(root, ['index', 'refresh']);

  // Another clone publishes to the Story branch.
  const other = path.join(base, 'other');
  run('git', ['clone', '-q', '--branch', 'BIND-1', remote, other], base);
  for (const [key, value] of [['user.name', 'Other'], ['user.email', 'other@example.com']]) git(other, ['config', key, value]);
  await writeFile(path.join(other, 'other.txt'), 'another clone\n');
  git(other, ['add', 'other.txt']);
  git(other, ['commit', '-qm', 'another clone']);
  git(other, ['push', '-q', 'origin', 'BIND-1']);
  const moved = git(other, ['rev-parse', 'HEAD']);

  const before = { head: git(root, ['rev-parse', 'HEAD']), status: git(root, ['status', '--porcelain']) };
  const refused = flow(root, ['phase', 'publish', 'intake', '--json'], { fail: true });
  assert.notEqual(refused.status, 0);
  const envelope = JSON.parse(refused.stdout);
  assert.equal(envelope.error.code, 'STORY_PUBLICATION_REMOTE_DIVERGED', refused.stdout);
  assert.equal(envelope.error.outcomeClass, 'REVISION_CONFLICT');
  assert.deepEqual({ head: git(root, ['rev-parse', 'HEAD']), status: git(root, ['status', '--porcelain']) }, before);
  assert.equal(git(root, ['ls-remote', 'origin', 'refs/heads/BIND-1']).split(/\s+/u)[0], moved, 'the other clone\'s revision stands');
  assert.equal(existsSync(path.join(root, '.git/singularity-flow/pending-publication/story--BIND-1.json')), false);
});
