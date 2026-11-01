import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  assert.match(refused.stderr + refused.stdout, /no record that its own push of it landed/u);
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

test('a push the remote refuses for its own reason is not called a lost race', async (t) => {
  const id = 'DENY-1';
  const { root, draft, refuse } = await story(t, id);
  await draft(root, 'Publish the intake to a branch that refuses every push.');
  await refuse(true);
  assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0);
  // The remote still points at the commit's parent: a protected branch or a 403, not another clone.
  const again = flow(root, ['sync'], { fail: true });
  assert.notEqual(again.status, 0);
  assert.doesNotMatch(again.stderr + again.stdout, /Another clone published/u);
  assert.match(again.stderr + again.stdout, /Push still fails/u);
  assert.ok(await waiting(root, id), 'the commit keeps waiting for the provider to accept it');
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

const cancel = (root, id, options) => flow(root, ['cancel', id, '--reason', 'The request was withdrawn.', '--confirm', id], options);
const automaticSync = (plan) => plan.actions.filter((entry) => entry.automatic && /\bsync\b/u.test(entry.command ?? ''));

test('a lost race a retry finds leads recover to its set-aside, never to sync again, and cancel goes on after it', async (t) => {
  // recover read the retry's stderr only, which has no reason for a refused ref, so it offered sync
  // [can apply] for ever, and the apply's refusal sent the person back to recover (2026-11-01).
  const id = 'RACE-2';
  const { base, root, remote, draft } = await story(t, id);
  const other = path.join(base, 'other');
  run('git', ['clone', '--quiet', '--branch', id, remote, other], base);
  for (const [key, value] of [['user.name', 'Publisher'], ['user.email', 'publisher@example.com']]) git(other, 'config', key, value);
  flow(other, ['resume', id]);
  await draft(root, 'This clone published second, after working offline.');
  await rename(remote, `${remote}.offline`);
  try { assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0); }
  finally { await rename(`${remote}.offline`, remote); }
  const sealed = await waiting(root, id);
  await draft(other, 'The other clone published first.');
  flow(other, ['phase', 'publish', 'intake']);
  const theirs = remoteTip(root, id);

  // The offline failure says nothing of the race, so recover retries once; the retry finds it.
  const before = JSON.parse(flow(root, ['recover', id, '--json']).stdout);
  assert.equal(automaticSync(before).length, 1);
  assert.notEqual(flow(root, ['recover', id, '--phase', 'intake', '--apply', '--confirm', before.planId], { fail: true }).status, 0);
  const after = JSON.parse(flow(root, ['recover', id, '--json']).stdout);
  assert.equal(after.actions[0]?.command, `singularity-flow sync ${id} --set-aside`, JSON.stringify(after.actions));
  assert.match(after.actions[0].detail, /another clone published first/u);
  assert.deepEqual(automaticSync(after), [], 'sync is never applied again');

  // Cancel waits on the commit, and names its set-aside rather than a sync that never lands it.
  const blocked = cancel(root, id, { fail: true });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /publicationPending/u);
  assert.match(blocked.stderr + blocked.stdout, /the remote moved past it/u);
  assert.match(blocked.stderr + blocked.stdout, new RegExp(`Shell: singularity-flow sync ${id} --set-aside`, 'u'));
  assert.doesNotMatch(blocked.stderr + blocked.stdout, /Shell: singularity-flow sync\n/u);
  flow(root, ['sync', id, '--set-aside', '--confirm', sealed.commit]);
  assert.equal(git(root, 'rev-parse', 'HEAD'), theirs);
  cancel(root, id);
  assert.equal(remoteTip(root, id), git(root, 'rev-parse', 'HEAD'), 'the cancellation is published');
});

test('a Story branch rewritten on the remote while its commit waited is named, set aside, and cancel goes on', async (t) => {
  // The remote moved, but not onto the commit's parent: sync said "Push still fails" and pointed at
  // recover, recover offered sync, and cancel waited on both (2026-11-01).
  const id = 'REWRITE-1';
  const { base, root, remote, draft } = await story(t, id);
  await draft(root, 'This clone published after working offline for a while.');
  await rename(remote, `${remote}.offline`);
  try { assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0); }
  finally { await rename(`${remote}.offline`, remote); }
  const sealed = await waiting(root, id);
  // Someone reset the Story branch on the remote to main and force-pushed another commit on it.
  const other = path.join(base, 'other');
  run('git', ['clone', '--quiet', '--branch', 'main', remote, other], base);
  for (const [key, value] of [['user.name', 'Publisher'], ['user.email', 'publisher@example.com']]) git(other, 'config', key, value);
  await writeFile(path.join(other, 'NOTE.md'), 'rewritten\n');
  git(other, 'add', 'NOTE.md');
  git(other, 'commit', '-m', 'Rewrite the Story branch');
  git(other, 'push', '--force', 'origin', `HEAD:refs/heads/${id}`);

  const refused = flow(root, ['sync'], { fail: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /no longer has what commit [0-9a-f]{8} \(artifact-generated at intake\) was made on: its history there was rewritten or reset/u);
  assert.match(refused.stderr + refused.stdout, new RegExp(`sync ${id} --set-aside`, 'u'));
  assert.doesNotMatch(refused.stderr + refused.stdout, /Push still fails/u);
  const plan = JSON.parse(flow(root, ['recover', id, '--json']).stdout);
  assert.equal(plan.actions[0]?.command, `singularity-flow sync ${id} --set-aside`, JSON.stringify(plan.actions));
  assert.match(plan.actions[0].detail, /its history there was rewritten or reset/u);
  assert.deepEqual(automaticSync(plan), []);
  const blocked = cancel(root, id, { fail: true });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, new RegExp(`Shell: singularity-flow sync ${id} --set-aside`, 'u'));

  flow(root, ['sync', id, '--set-aside', '--confirm', sealed.commit]);
  assert.equal(git(root, 'rev-parse', 'HEAD'), git(root, 'rev-parse', `${sealed.commit}^`), 'the branch is back at the commit before it');
  assert.equal(await waiting(root, id), null);
  // What is left here is SFlow's own history the remote dropped, never "made outside SFlow".
  const diverged = cancel(root, id, { fail: true });
  assert.notEqual(diverged.status, 0);
  assert.match(diverged.stderr + diverged.stdout, new RegExp(`git pull --no-rebase origin ${id}`, 'u'));
  assert.doesNotMatch(diverged.stderr + diverged.stdout, /made outside SFlow/u);
  // What the remote has comes in by a reviewed merge, never a reset; then the Story goes on.
  run('git', ['pull', '--no-rebase', '--no-edit', 'origin', id], root);
  cancel(root, id);
  assert.equal(remoteTip(root, id), git(root, 'rev-parse', 'HEAD'), 'the cancellation is published');
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

test('a publish another machine holds names its owner and the reviewed release, and the release lets sync finish it', async (t) => {
  // Before SDA a remote owner expired after its TTL; now nothing takes it over, so "wait, then retry"
  // and sync's "return to that terminal" never ended (D3/E3).
  const id = 'HELD-2';
  const { root, draft, refuse } = await story(t, id);
  await draft(root, 'Publish the intake while another laptop holds the Story.');
  await refuse(true);
  assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0);
  await refuse(false);
  const { subjectLockPath } = await import('../src/subject-lock.mjs');
  const lock = subjectLockPath(root, { kind: 'story', id });
  const lockToken = '5d1e7c3a-2b4f-4e6a-9c8d-7f6e5d4c3b2a';
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ schemaVersion: 1, subject: { kind: 'story', id }, pid: 4242,
    host: 'other-laptop.example', machineId: '0a1b2c3d-0000-4000-8000-000000000000', processToken: 'elsewhere', lockToken,
    acquiredAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-01T03:00:00.000Z' })}\n`);
  const release = `singularity-flow lock release story ${id} --confirm ${lockToken}`;
  const held = flow(root, ['submit', 'intake', '--json'], { fail: true });
  const envelope = JSON.parse(held.stdout);
  assert.equal(envelope.error.code, 'STORY_PUBLICATION_IN_PROGRESS');
  assert.doesNotMatch(envelope.error.message, /wait for it to finish/u);
  assert.match(envelope.error.message, /PID 4242 on other-laptop\.example/u);
  assert.equal(envelope.error.details.releaseCommand, release);
  assert.deepEqual(envelope.remediationPlan.steps.map((step) => step.command), [release, `singularity-flow lock show story ${id}`]);
  const synced = flow(root, ['sync', id, '--json'], { fail: true });
  assert.notEqual(synced.status, 0);
  assert.equal(JSON.parse(synced.stdout).error.details.releaseCommand, release, 'sync names the same release');
  flow(root, ['lock', 'release', 'story', id, '--confirm', lockToken]);
  flow(root, ['sync', id]);
  assert.equal(await waiting(root, id), null, 'the waiting commit was published');
});
