/**
 * A read model must never put a network round trip in front of a person, and must never report a
 * lookup it did not perform as one that came back empty.
 *
 * `identity()` used to spend 965 ms on `gh api user` on a cold cache — measured — on the exact path
 * the VS Code sidebar runs at activation. The obvious fix, `{ offline: true }`, was rejected once
 * for a good reason: it made `identities.github` null and the disclosure then read "unavailable",
 * which is a claim about the account rather than about the lookup. These tests pin both halves.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GITHUB_LOOKUP, gitCommitIdentity, identity } from '../src/git.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-offline-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Read Model'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'read@example.invalid'], { cwd: root });
  return root;
}

const cacheFile = (root) => path.join(root, '.git', 'singularity-flow', 'github-account.json');

async function seedAccount(root, { login, name, at = Date.now() }) {
  await mkdir(path.dirname(cacheFile(root)), { recursive: true });
  await writeFile(cacheFile(root), JSON.stringify({ at, stdout: JSON.stringify({ login, name }) }));
}

test('a cold read declares that it did not look, rather than that nobody is signed in', async () => {
  const root = await repository();
  const resolved = identity(root, { offline: true });
  assert.equal(resolved.login, null);
  assert.equal(resolved.githubLookup, GITHUB_LOOKUP.NOT_CHECKED);
  // Nothing was written, because nothing was asked. A read path must not populate the cache either:
  // the cost it is avoiding is exactly the call that would fill it.
  await assert.rejects(() => readFile(cacheFile(root), 'utf8'));
});

test('commit authorship never performs or claims a GitHub account lookup', async () => {
  const root = await repository();
  const actor = gitCommitIdentity(root);
  assert.deepEqual(actor, {
    name: 'Read Model', email: 'read@example.invalid', login: null,
    githubLookup: GITHUB_LOOKUP.NOT_CHECKED
  });
});

test('a warm read is free and still names the real account', async () => {
  const root = await repository();
  await seedAccount(root, { login: 'octocat', name: 'The Octocat' });
  const resolved = identity(root, { offline: true });
  assert.equal(resolved.login, 'octocat');
  assert.equal(resolved.githubLookup, GITHUB_LOOKUP.RESOLVED);
  // The cached display name wins over the local Git one, exactly as it does online.
  assert.equal(resolved.name, 'The Octocat');
});

test('an expired cache degrades to not-checked instead of to a stale login', async () => {
  const root = await repository();
  await seedAccount(root, { login: 'octocat', name: 'The Octocat', at: Date.now() - (60 * 60 * 1000) });
  const resolved = identity(root, { offline: true });
  assert.equal(resolved.login, null, 'an hour-old answer is not evidence of who is signed in now');
  assert.equal(resolved.githubLookup, GITHUB_LOOKUP.NOT_CHECKED);
  // The local Git identity is unaffected: it is read from config and is always current.
  assert.equal(resolved.name, 'Read Model');
  assert.equal(resolved.email, 'read@example.invalid');
});

test('a refused network is not-checked, never unavailable', async () => {
  const root = await repository();
  // `unavailable` is a statement about the account. Only a lookup that actually ran may make it.
  const previous = process.env.SINGULARITY_FLOW_NO_NETWORK;
  process.env.SINGULARITY_FLOW_NO_NETWORK = '1';
  try {
    const resolved = identity(root);
    assert.equal(resolved.githubLookup, GITHUB_LOOKUP.NOT_CHECKED);
    assert.equal(resolved.login, null);
  } finally {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_NO_NETWORK;
    else process.env.SINGULARITY_FLOW_NO_NETWORK = previous;
  }
});
