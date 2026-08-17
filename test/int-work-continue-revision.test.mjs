/**
 * `work.continue` and the two facts it used to conflate.
 *
 * Run against a real repository with real uncommitted files, because both defects here are about
 * what is actually on disk: a fixture that hands the planner a `localChanges` object tests the
 * injection path, which was the only path that ever worked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { localChangesFor, workContinueResult } from '../src/gateway/planners/work-continue.mjs';
import { run } from '../src/util.mjs';

const item = (over = {}) => ({
  id: 'PAY-1187', kind: 'story', phase: 'implement', generation: 2, group: 'active', blockers: [],
  nextAction: { operation: 'work.continue', reasonCode: 'work.resume-phase' }, lastMaterialEvent: null,
  ...over
});

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-continue-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.email', 'dev@example.test'], { cwd: root });
  run('git', ['config', 'user.name', 'Dev'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'first'], { cwd: root });
  return root;
}

test('the commit slot holds a commit, not a digest of git status', async (t) => {
  /**
   * The defect. `sourceCommit` was set from `localChanges.worktreeHash`, so every consumer reading
   * a commit received a hash of `git status` output — same shape, different fact, nothing to notice
   * it by. A handle bound from this subject would revalidate against a commit no repository has.
   */
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'changed.txt'), 'local work\n');

  const local = localChangesFor(root);
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const result = workContinueResult(item(), { localChanges: local, sourceCommit: commit });

  assert.equal(result.subject.revision.sourceCommit, commit);
  assert.match(result.subject.revision.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(result.subject.revision.worktreeHash, local.worktreeHash);
  assert.notEqual(result.subject.revision.sourceCommit, result.subject.revision.worktreeHash,
    'the two facts are carried separately');
});

test('a subject revision declares both, and null means unread', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  // Clean tree: there is no worktree hash to report, and that is a fact rather than a gap.
  assert.deepEqual(localChangesFor(root), { dirty: false, files: 0, worktreeHash: null, paths: [] });

  const result = workContinueResult(item(), {});
  assert.deepEqual(Object.keys(result.subject.revision).sort(),
    ['lifecycleHash', 'policyHash', 'registryHash', 'sourceCommit', 'worktreeHash']);
  assert.equal(result.subject.revision.sourceCommit, null);
  assert.equal(result.subject.revision.worktreeHash, null);
});

test('the changed-path count is computed, not supplied', async (t) => {
  /**
   * `[DHR:REQ-041]` asks for how many paths changed. `localChanges` reached the planner only by
   * injection and nothing ever injected it, so the count did not exist — declared, threaded
   * through, and always null in production.
   */
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'one.txt'), 'a\n');
  await writeFile(path.join(root, 'two.txt'), 'b\n');
  await writeFile(path.join(root, 'README.md'), '# edited\n');

  const local = localChangesFor(root);
  assert.equal(local.dirty, true);
  assert.equal(local.files, 3);
  assert.deepEqual(local.paths.sort(), ['README.md', 'one.txt', 'two.txt']);
  assert.match(local.worktreeHash, /^[0-9a-f]{64}$/);

  // And it reaches the reader as a disclosure, bound to the revision it was seen at.
  const result = workContinueResult(item(), { localChanges: local });
  const warning = result.warnings.find((entry) => entry.code === 'work.local-changes-present');
  assert.equal(warning.slots.files, '3');
  assert.equal(warning.reference, local.worktreeHash);
});

test('the worktree hash tracks the uncommitted bytes and nothing else', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, 'one.txt'), 'a\n');
  const first = localChangesFor(root);
  // Same set of changes, read twice: a handle bound to these bytes must stay valid.
  assert.equal(localChangesFor(root).worktreeHash, first.worktreeHash);

  // The path and status shape are unchanged. Only a content-aware fingerprint can see this edit.
  await writeFile(path.join(root, 'one.txt'), 'different bytes\n');
  assert.notEqual(localChangesFor(root).worktreeHash, first.worktreeHash);
});

test('an unread tree is null, never a zeroed record', async (t) => {
  /**
   * `{dirty: false, files: 0}` asserts a clean tree. A caller that supplied nothing has not said
   * the tree is clean — it has said nothing, and a reader who acts on the first reading of the
   * second is the one who commits over their own uncommitted work.
   */
  const result = workContinueResult(item(), {});
  assert.equal(result.data.localChanges, null);
  assert.equal(result.warnings.length, 0, 'nothing read means nothing disclosed');
});

test('a root that is not a repository is null, not an exception', async (t) => {
  /**
   * The first version of `localChangesFor` called Git unconditionally and threw on a plain
   * directory — reintroducing the exact class this codebase has spent the most effort removing: a
   * read path that dies because the world lacks something. Caught by an existing fixture, which is
   * the argument for fixtures that are not all perfectly formed.
   */
  const plain = await mkdtemp(path.join(tmpdir(), 'sflow-nogit-'));
  t.after(() => rm(plain, { recursive: true, force: true }));

  assert.equal(localChangesFor(plain), null, '"we could not look" is a fact, not a crash');
  const result = workContinueResult(item(), { localChanges: localChangesFor(plain) });
  assert.equal(result.data.localChanges, null);
  assert.equal(result.warnings.length, 0);
});
