/**
 * Reads that used to start one Git process per item now start one per batch. `[perf]`
 *
 * Each reader must answer exactly as the per-item reads did, so every test here compares against
 * those reads, run directly, before it counts anything.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertNoSecrets, governedCommitIdentity, shallowBoundaryCommit, stagedEntriesForPaths } from '../src/git.mjs';

const gitModule = fileURLToPath(new URL('../src/git.mjs', import.meta.url));

function git(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-git-batch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Batch Tester']);
  git(root, ['config', 'user.email', 'batch@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(root, 'README.md'), 'first\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-q', '-m', 'first']);
  return root;
}

/** How many subprocesses `expression` started, measured in a child with the probe on. */
function subprocesses(root, expression) {
  const script = `const m = await import(${JSON.stringify(gitModule)}); ${expression};`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_SUBPROCESS_PROBE: '1', SINGULARITY_FLOW_GIT_FACT_STORE: 'off' }
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = /^subprocesses:\s+(\d+)\s+calls/m.exec(result.stderr);
  assert.ok(summary, `the probe reported nothing: ${result.stderr}`);
  return Number(summary[1]);
}

test('staged content is read in one batch and matches git show :<path> for every kind of entry', async (t) => {
  const root = await repository(t);
  const names = Array.from({ length: 12 }, (_, index) => `notes/file ${index}.txt`);
  await mkdir(path.join(root, 'notes'));
  for (const [index, name] of names.entries()) await writeFile(path.join(root, name), `content ${index}\n`);
  await writeFile(path.join(root, 'tool.sh'), '#!/bin/sh\necho hi\n');
  await chmod(path.join(root, 'tool.sh'), 0o755);
  await writeFile(path.join(root, 'café.md'), 'accented\n');
  await symlink('README.md', path.join(root, 'link'));
  git(root, ['add', '-A']);
  // The staged version, not the one on disk, is what an index commit takes.
  await writeFile(path.join(root, names[0]), 'changed on disk only\n');
  const paths = [...names, 'tool.sh', 'café.md', 'link', 'never-staged.txt'];

  const expected = [];
  for (const item of paths) {
    const show = spawnSync('git', ['show', `:${item}`], { cwd: root, encoding: 'utf8' });
    if (show.status === 0) expected.push({ path: item, content: show.stdout });
  }
  assert.equal(expected.length, paths.length - 1, 'the unstaged path has no staged content');
  assert.deepEqual(stagedEntriesForPaths(root, paths), expected);
  assert.deepEqual(stagedEntriesForPaths(root, ['tool.sh']), expected.filter((entry) => entry.path === 'tool.sh'));
  assert.deepEqual(stagedEntriesForPaths(root, []), []);

  const batched = subprocesses(root, `m.stagedEntriesForPaths(process.cwd(), ${JSON.stringify(paths)})`);
  // The path Git has no entry for is still asked alone, exactly as before.
  assert.ok(batched <= 5, `${paths.length} staged paths took ${batched} subprocesses`);
});

test('an index commit is refused for a staged credential even when the file on disk is clean', async (t) => {
  const root = await repository(t);
  const credential = `ghp_${'Q'.repeat(36)}`;
  await writeFile(path.join(root, 'a.txt'), 'plain\n');
  await writeFile(path.join(root, 'config.txt'), `token=${credential}\n`);
  git(root, ['add', 'a.txt', 'config.txt']);
  await writeFile(path.join(root, 'config.txt'), 'token=redacted\n');
  assert.throws(() => assertNoSecrets(root), (error) => error.code === 'SECRET_DETECTED');

  // And the reverse: a credential only on disk does not refuse a commit of the clean staged blob.
  git(root, ['add', 'config.txt']);
  await writeFile(path.join(root, 'config.txt'), `token=${credential}\n`);
  assert.doesNotThrow(() => assertNoSecrets(root));
});

/** The identity as the three separate reads produced it. */
function identityAsBefore(root, commit) {
  const tree = git(root, ['rev-parse', `${commit}^{tree}`]);
  const parents = git(root, ['show', '-s', '--format=%P', commit]).split(/\s+/).filter(Boolean);
  const message = spawnSync('git', ['show', '-s', '--format=%B', commit], { cwd: root, encoding: 'utf8' }).stdout;
  const trailer = (name) => {
    const matches = [...message.matchAll(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'gmi'))];
    return matches.length === 1 ? matches[0][1] : null;
  };
  return { tree, parents, transactionId: trailer('Singularity-Flow-Transaction'), stateSha256: trailer('Singularity-Flow-State-SHA256') };
}

test('a governed commit identity reads tree, parents and trailers from one commit object', async (t) => {
  const root = await repository(t);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-q', '-b', 'side']);
  await writeFile(path.join(root, 'side.txt'), 'side\n');
  git(root, ['add', 'side.txt']);
  git(root, ['commit', '-q', '-m', 'side']);
  const side = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', `${side}^{tree}`]);
  const message = ['Governed merge', '', 'Singularity-Flow-Transaction: tx-123', `Singularity-Flow-State-SHA256: ${'b'.repeat(64)}`].join('\n');
  const merge = git(root, ['commit-tree', tree, '-p', base, '-p', side, '-m', message]);
  // A signed commit carries a multi-line header whose blank lines are a single space.
  const raw = spawnSync('git', ['cat-file', 'commit', merge], { cwd: root, encoding: 'utf8' }).stdout;
  const signature = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----';
  const signed = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'],
    raw.replace(/\n\n/u, `\n${signature}\n\n`));
  const rootCommit = git(root, ['commit-tree', tree, '-m', 'Singularity-Flow-Transaction: only-root']);
  const noMessage = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], raw.slice(0, raw.indexOf('\n\n') + 1));

  for (const commit of [merge, signed, rootCommit, noMessage, base]) {
    const identity = governedCommitIdentity(root, commit);
    const before = identityAsBefore(root, commit);
    assert.equal(identity.commit, commit);
    assert.deepEqual({ tree: identity.tree, parents: identity.parents, transactionId: identity.transactionId,
      stateSha256: identity.stateSha256 }, before, `commit ${commit}`);
  }
  assert.equal(governedCommitIdentity(root, merge).transactionId, 'tx-123');
  assert.equal(governedCommitIdentity(root, signed).transactionId, 'tx-123');
  assert.equal(governedCommitIdentity(root, 'f'.repeat(40)), null);
  assert.equal(subprocesses(root, `m.governedCommitIdentity(process.cwd(), ${JSON.stringify(merge)})`), 2);
});

test('a shallow merge boundary is found with one check for all of its parents', async (t) => {
  const root = await repository(t);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-q', '-b', 'side']);
  await writeFile(path.join(root, 'side.txt'), 'side\n');
  git(root, ['add', 'side.txt']);
  git(root, ['commit', '-q', '-m', 'side']);
  const side = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', `${side}^{tree}`]);
  const merge = git(root, ['commit-tree', tree, '-p', base, '-p', side, '-m', 'merge']);
  const raw = spawnSync('git', ['cat-file', 'commit', merge], { cwd: root, encoding: 'utf8' }).stdout;
  const orphan = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], raw.replace(`parent ${side}`, `parent ${'f'.repeat(40)}`));

  assert.equal(shallowBoundaryCommit(root, merge), false, 'not a shallow clone');
  await writeFile(path.join(root, '.git', 'shallow'), `${base}\n`);
  assert.equal(shallowBoundaryCommit(root, merge), false, 'every parent is present');
  assert.equal(shallowBoundaryCommit(root, orphan), true, 'one parent was never fetched');
  assert.equal(shallowBoundaryCommit(root, side), false, 'a single present parent');
  assert.equal(subprocesses(root, `m.shallowBoundaryCommit(process.cwd(), ${JSON.stringify(merge)})`), 3);
});
