import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { WORKTREE_FINGERPRINT_ALGORITHM, worktreeFingerprint } from '../src/worktree-fingerprint.mjs';

function looseObjects(root) {
  return Number(/^count: (\d+)$/m.exec(run('git', ['count-objects', '-v'], { cwd: root }).stdout)?.[1] ?? -1);
}

test('the shared fingerprint covers unborn repositories without mutating their real index', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });

  const empty = worktreeFingerprint(root);
  assert.equal(empty.dirty, false);
  assert.equal(empty.algorithm, WORKTREE_FINGERPRINT_ALGORITHM);
  assert.match(empty.sha256, /^[a-f0-9]{64}$/);

  await writeFile(path.join(root, 'new.txt'), 'version one\n');
  const first = worktreeFingerprint(root);
  assert.equal(first.dirty, true);
  assert.equal(run('git', ['diff', '--cached', '--name-only'], { cwd: root }).stdout, '',
    'inspection must not stage developer files');

  await writeFile(path.join(root, 'new.txt'), 'version two\n');
  assert.notEqual(worktreeFingerprint(root).sha256, first.sha256);
});

test('assume-unchanged bytes and index flags participate in the fingerprint', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-hidden-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Fingerprint Test'], { cwd: root });
  run('git', ['config', 'user.email', 'fingerprint@example.test'], { cwd: root });
  await writeFile(path.join(root, 'tracked.txt'), 'base\n');
  run('git', ['add', 'tracked.txt'], { cwd: root });
  run('git', ['commit', '-qm', 'base'], { cwd: root });

  const ordinary = worktreeFingerprint(root);
  run('git', ['update-index', '--assume-unchanged', 'tracked.txt'], { cwd: root });
  const flagged = worktreeFingerprint(root);
  assert.notEqual(flagged.sha256, ordinary.sha256, 'the index flag itself changes the revision');

  await writeFile(path.join(root, 'tracked.txt'), 'hidden change\n');
  const changed = worktreeFingerprint(root);
  assert.equal(changed.dirty, true);
  assert.deepEqual(changed.hiddenChanges, ['tracked.txt']);
  assert.notEqual(changed.sha256, flagged.sha256);
});

test('an absent skip-worktree path is represented without being called dirty', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-sparse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Fingerprint Test'], { cwd: root });
  run('git', ['config', 'user.email', 'fingerprint@example.test'], { cwd: root });
  await writeFile(path.join(root, 'sparse.txt'), 'indexed\n');
  run('git', ['add', 'sparse.txt'], { cwd: root });
  run('git', ['commit', '-qm', 'base'], { cwd: root });
  run('git', ['update-index', '--skip-worktree', 'sparse.txt'], { cwd: root });
  await unlink(path.join(root, 'sparse.txt'));

  const fingerprint = worktreeFingerprint(root);
  assert.equal(fingerprint.dirty, false);
  assert.ok(fingerprint.paths.includes('sparse.txt'));
  assert.deepEqual(fingerprint.hiddenChanges, []);
});

test('the shared fingerprint remains available while the Git index has merge conflicts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Fingerprint Test'], { cwd: root });
  run('git', ['config', 'user.email', 'fingerprint@example.test'], { cwd: root });
  await writeFile(path.join(root, 'shared.txt'), 'base\n');
  run('git', ['add', 'shared.txt'], { cwd: root });
  run('git', ['commit', '-qm', 'base'], { cwd: root });
  run('git', ['switch', '-qc', 'side'], { cwd: root });
  await writeFile(path.join(root, 'shared.txt'), 'side\n');
  run('git', ['commit', '-qam', 'side'], { cwd: root });
  run('git', ['switch', '-q', 'main'], { cwd: root });
  await writeFile(path.join(root, 'shared.txt'), 'main\n');
  run('git', ['commit', '-qam', 'main'], { cwd: root });
  const merge = run('git', ['merge', 'side'], { cwd: root, allowFailure: true });
  assert.notEqual(merge.status, 0);

  const before = run('git', ['ls-files', '--stage', '-z'], { cwd: root }).stdout;
  const fingerprint = worktreeFingerprint(root);
  assert.equal(fingerprint.dirty, true);
  assert.match(fingerprint.indexTree, /^[a-f0-9]{64}$/);
  assert.equal(run('git', ['ls-files', '--stage', '-z'], { cwd: root }).stdout, before,
    'inspection must preserve every conflict stage in the real index');
});

test('fingerprinting dirty bytes does not create unreachable Git objects', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-objects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Fingerprint Test'], { cwd: root });
  run('git', ['config', 'user.email', 'fingerprint@example.test'], { cwd: root });
  await writeFile(path.join(root, 'tracked.txt'), 'base\n');
  run('git', ['add', 'tracked.txt'], { cwd: root });
  run('git', ['commit', '-qm', 'base'], { cwd: root });

  await writeFile(path.join(root, 'tracked.txt'), 'dirty one\n');
  const before = looseObjects(root);
  worktreeFingerprint(root);
  const afterFirst = looseObjects(root);
  await writeFile(path.join(root, 'tracked.txt'), 'dirty two\n');
  worktreeFingerprint(root);
  const afterSecond = looseObjects(root);

  assert.deepEqual([afterFirst, afterSecond], [before, before]);
});

test('fingerprinting does not invoke configured clean filters', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-filter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Fingerprint Test'], { cwd: root });
  run('git', ['config', 'user.email', 'fingerprint@example.test'], { cwd: root });
  await writeFile(path.join(root, '.gitattributes'), 'tracked.txt filter=sflow-probe\n');
  await writeFile(path.join(root, 'tracked.txt'), 'base\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'base'], { cwd: root });
  run('git', ['config', 'filter.sflow-probe.clean', 'touch filter-invoked; cat'], { cwd: root });
  run('git', ['config', 'filter.sflow-probe.required', 'true'], { cwd: root });
  await writeFile(path.join(root, 'tracked.txt'), 'changed\n');

  const fingerprint = worktreeFingerprint(root);
  assert.equal(fingerprint.dirty, true);
  await assert.rejects(() => access(path.join(root, 'filter-invoked')));
});
