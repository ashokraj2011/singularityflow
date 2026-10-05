import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { withReadinessBase } from '../src/readiness-base.mjs';
import { buildRepositoryReadinessPlan, recordEmptyRepositoryReadiness, inspectRepositoryReadinessReceipt } from '../src/initialization/runtime-readiness.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-base-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  git('init', '-q'); git('config', 'user.name', 'Baseline'); git('config', 'user.email', 'baseline@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'selected base\n');
  git('add', '.'); git('commit', '-qm', 'selected base');
  const selected = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'README.md'), 'open Story commit\n');
  git('add', '.'); git('commit', '-qm', 'other Story');
  await writeFile(path.join(root, 'README.md'), 'preserve dirty Story\n');
  return { root, git, selected };
}

test('selected-base plan and receipt share Git objects while preserving a dirty open Story', async t => {
  const { root, git, selected } = await repository(t);
  const before = git('worktree', 'list', '--porcelain');
  const planned = await withReadinessBase(root, selected, async checkout => {
    assert.notEqual(checkout, root);
    assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), 'selected base\n');
    const plan = await buildRepositoryReadinessPlan(checkout, { scope: 'dependency-test' });
    await recordEmptyRepositoryReadiness(checkout, { scope: 'dependency-test' });
    return plan;
  });
  const repeated = await withReadinessBase(root, selected, checkout => buildRepositoryReadinessPlan(checkout, { scope: 'dependency-test' }));
  assert.equal(repeated.planId, planned.planId, 'temporary paths never change the reviewed plan');
  assert.equal((await inspectRepositoryReadinessReceipt(root, { commit: selected, scope: 'dependency-test', recompute: false })).status, 'pass');
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'preserve dirty Story\n');
  assert.equal(git('worktree', 'list', '--porcelain'), before);
});

test('selected-base failure cleans only its allocated checkout and never switches the open branch', async t => {
  const { root, git, selected } = await repository(t);
  const before = git('worktree', 'list', '--porcelain');
  await assert.rejects(withReadinessBase(root, selected, () => { throw Error('baseline refused'); }), /baseline refused/);
  assert.equal(git('worktree', 'list', '--porcelain'), before);
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'preserve dirty Story\n');
  await assert.rejects(withReadinessBase(root, '../main', () => {}), /exact local Git commit/);
});

test('selected-base checkout retains sparse selection instead of materializing excluded modules', async t => {
  const { root, git } = await repository(t);
  await writeFile(path.join(root, 'README.md'), 'selected sparse base\n');
  await mkdir(path.join(root, 'selected')); await mkdir(path.join(root, 'excluded'));
  await writeFile(path.join(root, 'selected/value.txt'), 'in scope');
  await writeFile(path.join(root, 'excluded/value.txt'), 'out of scope');
  git('add', '.'); git('commit', '-qm', 'sparse base');
  const base = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qm', 'next commit');
  git('sparse-checkout', 'set', '--cone', 'selected');
  await withReadinessBase(root, base, async checkout => {
    assert.equal(await readFile(path.join(checkout, 'selected/value.txt'), 'utf8'), 'in scope');
    await assert.rejects(readFile(path.join(checkout, 'excluded/value.txt')), { code: 'ENOENT' });
  });
});

test('temporary cleanup refusal cannot turn completed immutable evidence into a failure', async t => {
  let checkout;
  let git;
  t.after(async () => {
    if (!checkout) return;
    git('worktree', 'unlock', checkout);
    git('worktree', 'remove', '--force', checkout);
    await rm(path.dirname(checkout), { recursive: true, force: true });
  });
  const repositoryValue = await repository(t);
  git = repositoryValue.git;
  const completed = Object.freeze({ status: 'pass' });
  const result = await withReadinessBase(repositoryValue.root, repositoryValue.selected, target => {
    checkout = target;
    git('worktree', 'lock', target);
    return completed;
  });
  assert.equal(result, completed);
  assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), 'selected base\n');
  assert.equal(await readFile(path.join(repositoryValue.root, 'README.md'), 'utf8'), 'preserve dirty Story\n');
});
