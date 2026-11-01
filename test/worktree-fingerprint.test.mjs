import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { WORKTREE_FINGERPRINT_ALGORITHM, assertNoHiddenWorktreeChanges, worktreeFingerprint } from '../src/worktree-fingerprint.mjs';
import { canonicalJson } from '../src/records.mjs';

// Independent legacy two-read projection proves stored recovery receipts keep their exact hash.
function legacyIndexHash(root) {
  const flags = new Map(run('git', ['ls-files', '-v', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean)
    .map(entry => [entry.slice(2), entry[0]]));
  const entries = run('git', ['ls-files', '--stage', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, object, stage] = entry.slice(0, tab).split(' ');
    const relative = entry.slice(tab + 1), flag = flags.get(relative) ?? 'H';
    return { path: relative, mode, object, stage: Number(stage),
      assumeUnchanged: /^[a-z]$/u.test(flag), skipWorktree: flag.toUpperCase() === 'S' };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.stage - b.stage);
  return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

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
  assert.equal(ordinary.indexTree, legacyIndexHash(root));
  run('git', ['update-index', '--assume-unchanged', 'tracked.txt'], { cwd: root });
  const flagged = worktreeFingerprint(root);
  assert.equal(flagged.indexTree, legacyIndexHash(root));
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
  assert.equal(fingerprint.indexTree, legacyIndexHash(root));
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
  assert.equal(fingerprint.indexTree, legacyIndexHash(root));
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

test('a checkout Git converted to CRLF is what checkout writes; a real or a line-ending-only edit is still a change', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-eol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  run('git', ['init', '-q', '-b', 'main', repository]);
  run('git', ['config', 'user.name', 'Fingerprint Test'], { cwd: repository });
  run('git', ['config', 'user.email', 'fingerprint@example.test'], { cwd: repository });
  await writeFile(path.join(repository, 'notes.txt'), 'one\ntwo\n');
  await writeFile(path.join(repository, 'filtered.txt'), 'base\n');
  await writeFile(path.join(repository, '.gitattributes'), 'filtered.txt filter=sflow-probe\n');
  run('git', ['add', '-A'], { cwd: repository });
  run('git', ['commit', '-qm', 'base'], { cwd: repository });
  run('git', ['config', 'filter.sflow-probe.smudge', 'touch filter-invoked; cat'], { cwd: repository });
  run('git', ['config', 'filter.sflow-probe.clean', 'touch filter-invoked; cat'], { cwd: repository });
  // Git for Windows sets core.autocrlf=true in its system configuration: its checkouts hold CRLF.
  const system = path.join(root, 'system.gitconfig');
  await writeFile(system, '[core]\n\tautocrlf = true\n');
  const previous = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_SYSTEM = system;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = previous; });
  for (const file of ['notes.txt', 'filtered.txt']) await unlink(path.join(repository, file));
  run('git', ['checkout', '--', 'notes.txt', 'filtered.txt'], { cwd: repository });
  assert.equal(await readFile(path.join(repository, 'notes.txt'), 'utf8'), 'one\r\ntwo\r\n');
  // Past the index's racy window, so Git's own status compares stat data alone; it may run the filter.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  run('git', ['update-index', '-q', '--refresh'], { cwd: repository });
  await unlink(path.join(repository, 'filter-invoked')).catch(() => {});
  // A destructive proof runs Git without system or global configuration.
  const empty = path.join(root, 'empty.gitconfig');
  await writeFile(empty, '');
  const proof = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_GLOBAL: empty };

  const converted = worktreeFingerprint(repository, { fresh: true, exhaustive: true, env: proof });
  assert.deepEqual(converted.exhaustiveChanges, []);
  assert.equal(converted.dirty, false);
  await assert.rejects(() => access(path.join(repository, 'filter-invoked')), 'a configured filter never runs');

  await writeFile(path.join(repository, 'notes.txt'), 'one\r\nchanged\r\n');
  assert.deepEqual(worktreeFingerprint(repository, { fresh: true, exhaustive: true, env: proof }).exhaustiveChanges, ['notes.txt']);
  // Line endings that are neither the blob's nor what checkout writes are a change, though Git's
  // clean form of them is the blob.
  await writeFile(path.join(repository, 'notes.txt'), 'one\r\ntwo\n');
  assert.deepEqual(worktreeFingerprint(repository, { fresh: true, exhaustive: true, env: proof }).exhaustiveChanges, ['notes.txt']);
  await assert.rejects(() => access(path.join(repository, 'filter-invoked')));
});

test('a CRLF checkout whose stat data no longer matches the index is clean to the proof\'s own status', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-racy-eol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  run('git', ['init', '-q', '-b', 'main', repository]);
  run('git', ['config', 'user.name', 'Fingerprint Test'], { cwd: repository });
  run('git', ['config', 'user.email', 'fingerprint@example.test'], { cwd: repository });
  await writeFile(path.join(repository, 'notes.txt'), 'one\ntwo\n');
  run('git', ['add', '-A'], { cwd: repository });
  run('git', ['commit', '-qm', 'base'], { cwd: repository });
  const system = path.join(root, 'system.gitconfig');
  await writeFile(system, '[core]\n\tautocrlf = true\n');
  const previous = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_SYSTEM = system;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = previous; });
  await unlink(path.join(repository, 'notes.txt'));
  run('git', ['checkout', '--', 'notes.txt'], { cwd: repository });
  assert.equal(await readFile(path.join(repository, 'notes.txt'), 'utf8'), 'one\r\ntwo\r\n');
  // A file Git has to compare by content: a racily clean checkout, or one whose timestamp moved.
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(repository, 'notes.txt'), later, later);
  const empty = path.join(root, 'empty.gitconfig');
  await writeFile(empty, '');
  const proof = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_GLOBAL: empty };
  // Without the person's line endings Git's status calls the file modified.
  assert.match(run('git', ['status', '--porcelain=v1'], { cwd: repository, env: proof }).stdout, /^ M notes\.txt$/mu);

  const fingerprint = worktreeFingerprint(repository, { fresh: true, exhaustive: true, env: proof });
  assert.deepEqual(fingerprint.exhaustiveChanges, []);
  assert.equal(fingerprint.dirty, false);
  await writeFile(path.join(repository, 'notes.txt'), 'one\r\nchanged\r\n');
  assert.equal(worktreeFingerprint(repository, { fresh: true, exhaustive: true, env: proof }).dirty, true);
});

test('an assume-unchanged file Git converted to CRLF is no hidden change; edited, it is', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fingerprint-hidden-eol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Fingerprint Test'], { cwd: root });
  run('git', ['config', 'user.email', 'fingerprint@example.test'], { cwd: root });
  await writeFile(path.join(root, 'notes.txt'), 'one\ntwo\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'base'], { cwd: root });
  run('git', ['config', 'core.autocrlf', 'true'], { cwd: root });
  await unlink(path.join(root, 'notes.txt'));
  run('git', ['checkout', '--', 'notes.txt'], { cwd: root });
  run('git', ['update-index', '--assume-unchanged', 'notes.txt'], { cwd: root });
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'one\r\ntwo\r\n');
  assert.deepEqual(worktreeFingerprint(root, { fresh: true }).hiddenChanges, []);
  assert.deepEqual(assertNoHiddenWorktreeChanges(root).hiddenChanges, []);
  await writeFile(path.join(root, 'notes.txt'), 'one\r\nchanged\r\n');
  assert.deepEqual(worktreeFingerprint(root, { fresh: true }).hiddenChanges, ['notes.txt']);
  assert.throws(() => assertNoHiddenWorktreeChanges(root), { code: 'WORKTREE_HIDDEN_CHANGE' });
});
