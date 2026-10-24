import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fetchRemote, remoteNames } from '../src/git.mjs';
import { runRemoteGit } from '../src/git-execution.mjs';
import { frozenRemoteTransport } from '../src/git-remote-diagnostics.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

// Two leftovers from an older version: each Story command that fetched into a blobless checkout
// registered its one-shot alias as another promisor remote.
const LEAKED = [
  'sflow-frozen-74024af1-2b65-4027-b142-1241901058b7:',
  'sflow-frozen-cf7fd459-1266-45fe-8ff5-bf8dcf7ec4c3:'
];

function git(root, args) {
  const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: childTimeout(20_000) });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout.trim();
}

function commit(root, file, text) {
  writeFileSync(path.join(root, file), text);
  git(root, ['add', '--', file]);
  git(root, ['-c', 'user.name=SFlow Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', file]);
}

function aliasSections(root) {
  const listed = spawnSync('git', ['config', '--local', '--get-regexp', '^remote\\.sflow-frozen-'], {
    cwd: root, encoding: 'utf8'
  });
  return listed.stdout.trim();
}

/** A Story remote and a blobless shallow clone of it, the kind a second laptop's workspace makes. */
function bloblessCheckout(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'sflow-frozen-alias-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = path.join(base, 'origin');
  git(base, ['init', '-q', '-b', 'main', origin]);
  git(origin, ['config', 'uploadpack.allowFilter', 'true']);
  commit(origin, 'one.txt', 'first\n');
  const checkout = path.join(base, 'checkout');
  git(base, ['clone', '-q', '--depth=1', '--filter=blob:none', pathToFileURL(origin).href, checkout]);
  assert.equal(git(checkout, ['config', '--local', '--get', 'remote.origin.promisor']), 'true');
  return { base, origin, checkout };
}

test('a filtered fetch into a blobless checkout leaves no one-shot alias as a remote', async (t) => {
  const { origin, checkout } = bloblessCheckout(t);
  commit(origin, 'two.txt', 'second\n');
  await fetchRemote(checkout, 'origin', { branches: ['main'], respectPartialClone: true });
  assert.equal(git(checkout, ['rev-parse', 'refs/remotes/origin/main']), git(origin, ['rev-parse', 'HEAD']));
  assert.equal(aliasSections(checkout), '');
  assert.deepEqual(git(checkout, ['remote']).split('\n'), ['origin']);
});

test('aliases an older version left are ignored as remotes and removed by the next filtered fetch', async (t) => {
  const { origin, checkout } = bloblessCheckout(t);
  for (const alias of LEAKED) {
    git(checkout, ['config', '--local', `remote.${alias}.promisor`, 'true']);
    git(checkout, ['config', '--local', `remote.${alias}.partialclonefilter`, 'blob:none']);
  }
  assert.equal(git(checkout, ['remote']).split('\n').length, 3);
  assert.deepEqual(remoteNames(checkout), ['origin']);

  commit(origin, 'two.txt', 'second\n');
  await fetchRemote(checkout, 'origin', { branches: ['main'], respectPartialClone: true });
  assert.equal(aliasSections(checkout), '');
  assert.deepEqual(git(checkout, ['remote']).split('\n'), ['origin']);
  assert.equal(git(checkout, ['config', '--local', '--get', 'remote.origin.promisor']), 'true',
    "the checkout's own promisor remote stays");
});

test("a bare object store keeps its alias registration: it reads through it and seals itself", (t) => {
  const { base, origin } = bloblessCheckout(t);
  const store = path.join(base, 'store.git');
  git(base, ['init', '-q', '--bare', store]);
  const transport = frozenRemoteTransport(pathToFileURL(origin).href);
  runRemoteGit(['fetch', '--quiet', '--no-tags', '--filter=blob:none', transport.remote, 'refs/heads/main'], {
    cwd: store, env: transport.env, operation: 'remote-configuration', allowFailure: false
  });
  assert.match(aliasSections(store), /\.promisor true/u);
});
