import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import YAML from 'yaml';

// A waiting Story commit that could never be published froze the Story: sync repeated one refusal
// and cancel waited on it (2026-10-28). Each case here is one way that happened.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
function run(command, args, cwd, { fail = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Publisher',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
const git = (root, ...args) => run('git', args, root).stdout.trim();
const remoteTip = (root, branch) => git(root, 'ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/u)[0] || null;
const marker = (root, id) => path.join(root, `.git/singularity-flow/pending-publication/story--${id}.json`);
const waiting = async (root, id) => readFile(marker(root, id), 'utf8').then(JSON.parse, () => null);

async function story(t, id) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-unhappy-publish-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  for (const [key, value] of [['user.name', 'Publisher'], ['user.email', 'publisher@example.com']]) git(root, 'config', key, value);
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# unhappy publication\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  git(root, 'push', '-u', 'origin', 'main');
  flow(root, ['start', id, '--from-branch', 'main']);
  const draft = async (dir, words) => {
    const artifact = path.join(dir, `singularity/work-items/${id}/artifacts/intake/intake.md`);
    await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/gu, words));
  };
  const hook = path.join(remote, 'hooks/pre-receive');
  const refuse = async (on) => {
    if (on) { await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755); } else await rm(hook, { force: true });
  };
  return { base, root, remote, draft, refuse };
}

test('a waiting commit sent by hand is never claimed by sync, and the person stops waiting for it', async (t) => {
  const id = 'HAVE-1';
  const { root, draft, refuse } = await story(t, id);
  await draft(root, 'Publish the intake once the remote accepts it.');
  await refuse(true);
  assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0);
  const sealed = await waiting(root, id);
  assert.equal(sealed.pushOutcome, 'rejected');
  await refuse(false);
  // The person pushes it by hand. A push SFlow did not make (one that skipped the hooks, say) is never
  // counted as its publication, but sync used to repeat "did not move from the leased commit" for ever.
  git(root, 'push', 'origin', `${sealed.commit}:refs/heads/${id}`);
  const refused = flow(root, ['sync'], { fail: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /sent outside SFlow/u);
  assert.match(refused.stderr + refused.stdout, /--set-aside/u);
  assert.ok(await waiting(root, id), 'sync claims nothing');
  const stopped = flow(root, ['sync', id, '--set-aside', '--confirm', sealed.commit]);
  assert.match(stopped.stdout, /Stopped waiting for commit/u);
  assert.equal(await waiting(root, id), null, 'the waiting publication is cleared');
  assert.equal(remoteTip(root, id), sealed.commit);
  assert.equal(git(root, 'rev-parse', 'HEAD'), sealed.commit, 'the branch stays as it is');
});

test('a Story branch deleted from the remote is created again, by a new step and by sync', async (t) => {
  const id = 'GONE-1';
  const { root, draft, refuse } = await story(t, id);
  git(root, 'push', 'origin', '--delete', id);
  assert.equal(remoteTip(root, id), null);
  await draft(root, 'Publish the intake after the branch was deleted.');
  flow(root, ['phase', 'publish', 'intake']);
  assert.equal(remoteTip(root, id), git(root, 'rev-parse', 'HEAD'), 'publishing creates the branch again, create-only');

  // A commit that waited while the branch existed, then the branch was deleted (a merged pull request).
  await refuse(true);
  assert.notEqual(flow(root, ['submit', 'intake'], { fail: true }).status, 0);
  const sealed = await waiting(root, id);
  assert.ok(sealed?.commit);
  await refuse(false);
  git(root, 'push', 'origin', '--delete', id);
  flow(root, ['sync']);
  assert.equal(remoteTip(root, id), sealed.commit);
  assert.equal(await waiting(root, id), null);
});

test('a waiting commit undone with git reset is never pushed, and is set aside only with its exact ID', async (t) => {
  const id = 'UNDO-1';
  const { root, draft, refuse } = await story(t, id);
  const before = remoteTip(root, id);
  await draft(root, 'Publish the intake, then think better of it.');
  await refuse(true);
  assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0);
  const sealed = await waiting(root, id);
  await refuse(false);
  git(root, 'reset', '--hard', 'HEAD~1');
  const refused = flow(root, ['sync'], { fail: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /no longer on UNDO-1/u);
  assert.equal(remoteTip(root, id), before, 'what the person undid was not published');

  const preview = flow(root, ['sync', id, '--set-aside']);
  assert.match(preview.stdout, /Preview only: nothing was changed/u);
  assert.ok(await waiting(root, id), 'a preview changes nothing');
  const wrong = flow(root, ['sync', id, '--set-aside', '--confirm', before], { fail: true });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr + wrong.stdout, /Confirm with the full ID/u);
  const done = flow(root, ['sync', id, '--set-aside', '--confirm', sealed.commit]);
  assert.match(done.stdout, /Set aside commit/u);
  assert.equal(await waiting(root, id), null);
  assert.equal(git(root, 'rev-parse', `refs/sflow-set-aside/${id}/${sealed.commit}`), sealed.commit, 'the commit is kept');
  assert.equal(remoteTip(root, id), before);
});

test('a commit that lost the race to another clone is named as such and set aside onto what was published', async (t) => {
  const id = 'RACE-1';
  const { base, root, remote, draft } = await story(t, id);
  const other = path.join(base, 'other');
  run('git', ['clone', '--quiet', '--branch', id, remote, other], base);
  for (const [key, value] of [['user.name', 'Publisher'], ['user.email', 'publisher@example.com']]) git(other, 'config', key, value);
  flow(other, ['resume', id]);

  // This clone works offline: its commit is kept, waiting.
  await draft(root, 'This clone published second.');
  await rename(remote, `${remote}.offline`);
  try { assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0); }
  finally { await rename(`${remote}.offline`, remote); }
  const sealed = await waiting(root, id);
  // Meanwhile the other clone publishes first.
  await draft(other, 'The other clone published first.');
  flow(other, ['phase', 'publish', 'intake']);
  const theirs = remoteTip(root, id);

  const lost = flow(root, ['sync'], { fail: true });
  assert.notEqual(lost.status, 0);
  assert.match(lost.stderr + lost.stdout, /Another clone published to RACE-1 after this checkout made commit/u);
  assert.match(lost.stderr + lost.stdout, /--set-aside/u);
  flow(root, ['sync', id, '--set-aside', '--confirm', sealed.commit]);
  assert.equal(git(root, 'rev-parse', 'HEAD'), theirs, 'the branch is at what the other clone published');
  assert.equal(await waiting(root, id), null);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('a publish still running in another command is said to be running, not stuck', async (t) => {
  const id = 'BUSY-1';
  const { root, draft, refuse } = await story(t, id);
  await draft(root, 'Publish the intake while another command holds the Story.');
  await refuse(true);
  assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0);
  await refuse(false);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireSubjectLock } from ${JSON.stringify(new URL('../src/subject-lock.mjs', import.meta.url).href)};
    await acquireSubjectLock(process.cwd(), { kind: 'story', id: ${JSON.stringify(id)} });
    console.log('held');
    setInterval(() => {}, 1000);
  `], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const busy = flow(root, ['submit', 'intake'], { fail: true });
  assert.notEqual(busy.status, 0);
  assert.match(busy.stderr + busy.stdout, /is publishing Story 'BUSY-1' right now/u);
});
