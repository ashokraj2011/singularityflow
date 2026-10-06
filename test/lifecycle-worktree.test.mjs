import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertLifecycleWorktreeClean, inspectLifecycleWorktree } from '../src/lifecycle-worktree.mjs';
import { commitReviewedPaths } from '../src/git.mjs';
import { worktreeFingerprint } from '../src/worktree-fingerprint.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { parseArgs } from '../src/util.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function repo(t, format = 'sha1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-decision-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'story-1', `--object-format=${format}`);
  git(root, 'config', 'user.name', 'Worktree Reviewer');
  git(root, 'config', 'user.email', 'reviewer@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Before\n');
  await writeFile(path.join(root, 'other.txt'), 'Before\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'baseline');
  return root;
}
async function report(root, name = 'node-tests.json', content = '{"passed":16}\n') {
  const relative = `.sflow/results/${name}`;
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
  return relative;
}

for (const format of ['sha1', 'sha256']) test(`regular untracked reports are preserved without blocking decisions (${format})`, async t => {
  const root = await repo(t, format);
  const relative = await report(root, 'report with spaces "quoted".json');
  const before = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  const index = git(root, 'write-tree');
  const result = assertLifecycleWorktreeClean(root, null, null, { workId: 'story-1' });
  assert.deepEqual(result.disposableUntrackedPaths, [relative]);
  assert.equal(git(root, 'write-tree'), index);
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), before);
  assert.equal(await readFile(path.join(root, relative), 'utf8'), '{"passed":16}\n');
});

test('staged/tracked reports, source, and arbitrary output directories remain visible', async t => {
  const root = await repo(t);
  const relative = await report(root);
  git(root, 'add', relative);
  assert.throws(() => assertLifecycleWorktreeClean(root, null, null, { workId: 'story-1' }), error =>
    error.code === 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED' && error.details.paths.includes(relative)
    && error.details.recoveryCommand === 'singularity-flow recover story-1 --json');
  git(root, 'commit', '-m', 'track legacy report');
  await report(root, 'node-tests.json', '{"changed":true}\n');
  await writeFile(path.join(root, 'README.md'), '# After\n');
  await mkdir(path.join(root, 'coverage'));
  await writeFile(path.join(root, 'coverage', 'unknown.json'), '{}\n');
  assert.deepEqual(inspectLifecycleWorktree(root).entries.map(entry => entry.path.value).sort(),
    [relative, 'README.md', 'coverage/unknown.json'].sort());
});

test('a symlink report and symlink parent cannot hide worktree changes', async t => {
  const root = await repo(t);
  await mkdir(path.join(root, '.sflow', 'results'), { recursive: true });
  try { await symlink(path.join(root, 'README.md'), path.join(root, '.sflow', 'results', 'link.json')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Host cannot create symlinks'); return; } throw error; }
  assert.equal(inspectLifecycleWorktree(root).disposableUntrackedPaths.length, 0);
  assert.throws(() => assertLifecycleWorktreeClean(root), { code: 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED' });
  await rm(path.join(root, '.sflow', 'results'), { recursive: true });
  await symlink(root, path.join(root, '.sflow', 'results'), 'dir');
  assert.throws(() => assertLifecycleWorktreeClean(root), { code: 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED' });
});

test('assume-unchanged cannot hide source edits at approval', async t => {
  const root = await repo(t);
  git(root, 'update-index', '--assume-unchanged', 'README.md');
  await writeFile(path.join(root, 'README.md'), '# Hidden edit\n');
  assert.throws(() => assertLifecycleWorktreeClean(root), { code: 'WORKTREE_HIDDEN_CHANGE' });
});

test('reviewed commit includes only confirmed bytes and retains other staged work and reports', async t => {
  const root = await repo(t);
  await writeFile(path.join(root, 'README.md'), '# Reviewed\n');
  const added = 'notes with spaces [1].md';
  await writeFile(path.join(root, added), '# New notes\n');
  await writeFile(path.join(root, 'other.txt'), 'Unrelated staged draft\n');
  git(root, 'add', 'other.txt');
  const stagedBefore = git(root, 'diff', '--cached', '--', 'other.txt');
  const relative = await report(root);
  const expectedHead = git(root, 'rev-parse', 'HEAD');
  const fingerprint = worktreeFingerprint(root, { fresh: true }).sha256;
  const commit = await commitReviewedPaths(root, 'reviewed authoring', ['README.md', added], {
    expectedHead, stabilityGuard: () => worktreeFingerprint(root, { fresh: true }).sha256 === fingerprint
  });
  assert.equal(git(root, 'show', `${commit}:other.txt`), 'Before');
  assert.equal(git(root, 'show', `${commit}:README.md`), '# Reviewed');
  assert.equal(git(root, 'show', `${commit}:${added}`), '# New notes');
  assert.equal(git(root, 'diff', '--cached', '--', 'other.txt'), stagedBefore);
  assert.equal(await readFile(path.join(root, relative), 'utf8'), '{"passed":16}\n');
  assert.deepEqual(inspectLifecycleWorktree(root).entries.map(entry => entry.path.value), ['other.txt']);
});

test('changed review fingerprint refuses a commit without staging or changing HEAD', async t => {
  const root = await repo(t);
  await writeFile(path.join(root, 'README.md'), '# Review\n');
  const expectedHead = git(root, 'rev-parse', 'HEAD');
  const index = git(root, 'write-tree');
  await assert.rejects(commitReviewedPaths(root, 'stale', ['README.md'], { expectedHead, stabilityGuard: () => false }),
    { code: 'RECOVERY_PLAN_STALE' });
  assert.equal(git(root, 'rev-parse', 'HEAD'), expectedHead);
  assert.equal(git(root, 'write-tree'), index);
});

test('normal Git hook veto is respected and does not lose reviewed edits', async t => {
  const root = await repo(t);
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\necho "Repository hook veto" >&2\nexit 1\n');
  await chmod(hook, 0o755);
  await writeFile(path.join(root, 'README.md'), '# Preserved\n');
  const expectedHead = git(root, 'rev-parse', 'HEAD');
  const index = git(root, 'write-tree');
  await assert.rejects(commitReviewedPaths(root, 'hook veto', ['README.md'], { expectedHead, stabilityGuard: () => true }),
    error => error.code === 'RECOVERY_COMMIT_FAILED' && /Repository hook veto/u.test(error.message));
  assert.equal(git(root, 'rev-parse', 'HEAD'), expectedHead);
  assert.equal(git(root, 'write-tree'), index);
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), '# Preserved\n');
});

test('hook-altered commits are retained and reported without approving unreviewed bytes', async t => {
  const root = await repo(t);
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf "Hook changed the reviewed bytes\\n" > README.md\ngit add -- README.md\n');
  await chmod(hook, 0o755);
  await writeFile(path.join(root, 'README.md'), '# Reviewed\n');
  const expectedHead = git(root, 'rev-parse', 'HEAD');
  const index = git(root, 'write-tree');
  let committed;
  await assert.rejects(commitReviewedPaths(root, 'hook changed bytes', ['README.md'], {
    expectedHead, stabilityGuard: () => true
  }), error => {
    assert.equal(error.code, 'RECOVERY_COMMIT_CHANGED');
    committed = error.details.commit;
    assert.match(error.message, /commit is retained/u);
    return true;
  });
  assert.equal(git(root, 'rev-parse', 'HEAD'), committed);
  assert.equal(git(root, 'rev-parse', `${committed}^`), expectedHead);
  assert.equal(git(root, 'show', `${committed}:README.md`), 'Hook changed the reviewed bytes');
  assert.equal(git(root, 'write-tree'), index, 'a changed hook must not overwrite the original index');
});

test('commit-reviewed is a model-free mutation, not a read or an automatic apply', () => {
  const { positionals, options } = parseArgs(['recover', '--commit-reviewed', 'story-1', '--confirm', 'sha256:abc']);
  assert.deepEqual(positionals, ['recover', 'story-1']);
  const operation = resolveOperation({ requestedCommand: 'recover', positionals, options });
  assert.equal(operation.id, 'recover.commit-reviewed');
  assert.equal(operation.classification, 'mutation');
  assert.equal(operation.modelPolicy, 'never');
});
