/**
 * A phase transition finishes a Story's retained publication instead of refusing it, when that is
 * the ordinary retry the earlier command already asked for.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');

function run(command, args, cwd, { fail = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Publisher',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
      ...env
    }
  });
  if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);

async function storyWithRetainedPublication(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-transition-repair-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  run('git', ['config', 'user.name', 'Publisher'], root);
  run('git', ['config', 'user.email', 'publisher@example.com'], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(path.join(root, 'README.md'), '# repair\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'init'], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  flow(root, ['start', 'REPAIR-1', '--from-branch', 'main']);
  const artifact = path.join(root, 'singularity/work-items/REPAIR-1/artifacts/intake/intake.md');
  await writeFile(artifact, (await readFile(artifact, 'utf8'))
    .replace(/TODO:[^\n]*/g, 'Complete the retained publication before the next transition.'));
  const rejectHook = path.join(remote, 'hooks/pre-receive');
  await writeFile(rejectHook, '#!/bin/sh\nexit 1\n');
  await chmod(rejectHook, 0o755);
  const failed = flow(root, ['phase', 'publish', 'intake'], { fail: true });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /push failed/);
  return { root, remote, rejectHook };
}

const published = (root) => run('git', ['ls-remote', 'origin', 'refs/heads/REPAIR-1'], root).stdout.split(/\s+/)[0];
const head = (root) => run('git', ['rev-parse', 'HEAD'], root).stdout.trim();

test('a transition publishes the retained commit first, and refuses as before when it cannot', async (t) => {
  const { root, rejectHook } = await storyWithRetainedPublication(t);
  const retained = head(root);
  const pendingRecord = path.join(root, '.git', 'singularity-flow', 'pending-publication', 'story--REPAIR-1.json');
  assert.ok(JSON.parse(await readFile(pendingRecord, 'utf8')), 'the failed push left its publication retained');

  // The remote still refuses: the retry fails and the gate refuses exactly as it always did.
  const blocked = flow(root, ['submit'], { fail: true });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Publication is pending/);
  assert.notEqual(published(root), retained);

  await rm(rejectHook, { force: true });
  // Switched off, the transition does not publish on its own.
  const off = flow(root, ['submit'], { fail: true, env: { SINGULARITY_FLOW_TRANSITION_REPAIR: 'off' } });
  assert.equal(off.status, 2);
  assert.match(off.stderr, /Publication is pending/);

  const submitted = flow(root, ['submit']);
  assert.match(submitted.stderr, /Published the retained local commit before this transition \(submit[^)]*\)/);
  assert.equal(published(root), head(root), 'the retained commit and the submission both reached the remote');
  assert.equal(run('git', ['status', '--porcelain'], root).stdout.trim(), '');
  assert.equal(await readFile(pendingRecord).then(() => true, () => false), false, 'no publication is left pending');
});
