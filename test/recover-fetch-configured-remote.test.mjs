import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');

function run(command, args, cwd, { fail = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Remote Publisher',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' })
    }
  });
  if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
const git = (cwd, ...args) => run('git', args, cwd).stdout.trim();

test('recover --fetch fast-forwards a Story branch from a remote that is not named origin', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-recover-upstream-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'repo');
  const reviewer = path.join(base, 'reviewer');
  run('git', ['init', '--bare', '-b', 'main', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  git(root, 'config', 'user.name', 'Remote Publisher');
  git(root, 'config', 'user.email', 'remote-publisher@example.invalid');
  git(root, 'remote', 'add', 'upstream', remote);
  await writeFile(path.join(root, 'README.md'), '# configured remote\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.git.remote = 'upstream';
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  git(root, 'push', '-u', 'upstream', 'main');
  flow(root, ['start', 'UPSTREAM-1', '--from-branch', 'main']);
  assert.equal(git(root, 'rev-parse', 'HEAD'), run('git', ['ls-remote', remote, 'refs/heads/UPSTREAM-1'], base).stdout.split(/\s+/)[0]);

  // A reviewer pushes to the Story branch: the remote now has a commit this checkout lacks.
  run('git', ['clone', '-q', '-o', 'upstream', '--branch', 'UPSTREAM-1', remote, reviewer], base);
  git(reviewer, 'config', 'user.name', 'Reviewer');
  git(reviewer, 'config', 'user.email', 'reviewer@example.invalid');
  await writeFile(path.join(reviewer, 'REVIEW.md'), 'reviewer note\n');
  git(reviewer, 'add', 'REVIEW.md');
  git(reviewer, 'commit', '-m', 'reviewer note');
  git(reviewer, 'push', '-q', 'upstream', 'UPSTREAM-1');
  const reviewed = git(reviewer, 'rev-parse', 'HEAD');

  const plan = JSON.parse(flow(root, ['recover', 'UPSTREAM-1', '--fetch', '--json']).stdout);
  assert.ok(plan.actions.some((entry) => entry.id === 'fast-forward' && entry.automatic), JSON.stringify(plan.actions));
  assert.match(plan.applyCommand, /--fetch/u);
  const applied = JSON.parse(flow(root, [
    'recover', 'UPSTREAM-1', '--fetch', '--apply', '--confirm', plan.planId, '--json'
  ]).stdout);
  assert.equal(applied.postconditionsMet, true);
  assert.equal(git(root, 'rev-parse', 'HEAD'), reviewed);

  // The host deletes the branch (as after a merge): no upstream is left, and recovery still
  // offers the fetch that lets the terminal gate compare HEAD with the base it merged into.
  git(reviewer, 'push', '-q', 'upstream', ':UPSTREAM-1');
  git(root, 'fetch', '-q', '--prune', 'upstream');
  const gone = JSON.parse(flow(root, ['recover', 'UPSTREAM-1', '--fetch', '--json']).stdout);
  const fetchAction = gone.actions.find((entry) => entry.id === 'fast-forward');
  assert.ok(fetchAction?.automatic, JSON.stringify(gone.actions));
  assert.match(fetchAction.detail, /no upstream, so nothing is fast-forwarded/u);
});
