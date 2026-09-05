import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { refreshBranch } from '../src/branch-refresh.mjs';
import { run } from '../src/util.mjs';

function git(cwd, args, allowFailure = false) { return run('git', args, { cwd, allowFailure }); }

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-'));
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  git(base, ['init', '--bare', '-b', 'main', remote]);
  git(base, ['clone', remote, seed]);
  git(seed, ['config', 'user.name', 'Fixture']);
  git(seed, ['config', 'user.email', 'fixture@example.com']);
  await writeFile(path.join(seed, 'README.md'), '# fixture\n');
  git(seed, ['add', '.']); git(seed, ['commit', '-m', 'initial']); git(seed, ['push', '-u', 'origin', 'main']);
  const local = path.join(base, 'local'); const peer = path.join(base, 'peer');
  git(base, ['clone', remote, local]); git(base, ['clone', remote, peer]);
  for (const repo of [local, peer]) {
    git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.com']);
  }
  return { base, local, peer };
}

test('refresh is fast-forward-only and reports up-to-date and ahead branches', async () => {
  const { local, peer } = await fixture();
  assert.equal((await refreshBranch(local)).status, 'up-to-date');

  await writeFile(path.join(peer, 'remote.txt'), 'remote\n');
  git(peer, ['add', '.']); git(peer, ['commit', '-m', 'remote update']); git(peer, ['push']);
  const advanced = await refreshBranch(local);
  assert.equal(advanced.status, 'fast-forwarded');
  assert.equal(advanced.behind, 1);

  await writeFile(path.join(local, 'local.txt'), 'local\n');
  git(local, ['add', '.']); git(local, ['commit', '-m', 'local update']);
  const ahead = await refreshBranch(local);
  assert.equal(ahead.status, 'ahead');
  assert.equal(ahead.ahead, 1);
});

test('refresh refuses dirty and diverged work without changing HEAD', async () => {
  const { local, peer } = await fixture();
  await writeFile(path.join(local, 'dirty.txt'), 'dirty\n');
  await assert.rejects(refreshBranch(local), /Working tree is not clean/);
  git(local, ['clean', '-f']);

  await writeFile(path.join(local, 'local.txt'), 'local\n');
  git(local, ['add', '.']); git(local, ['commit', '-m', 'local']);
  const before = git(local, ['rev-parse', 'HEAD']).stdout.trim();
  await writeFile(path.join(peer, 'peer.txt'), 'peer\n');
  git(peer, ['add', '.']); git(peer, ['commit', '-m', 'peer']); git(peer, ['push']);
  await assert.rejects(refreshBranch(local), /has diverged.*Nothing was changed/);
  assert.equal(git(local, ['rev-parse', 'HEAD']).stdout.trim(), before);
});

test('refresh uses the asynchronous bounded remote runner and preserves timeout diagnosis', async () => {
  const { local } = await fixture();
  let invoked = false;
  await assert.rejects(refreshBranch(local, {
    async runRemoteCommand(args, options) {
      invoked = true;
      assert.deepEqual(args, [
        'fetch', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main'
      ]);
      assert.equal(options.operation, 'remote-configuration');
      return {
        status: 1, stdout: '', stderr: '', timedOut: true,
        failure: { code: 'GIT_REMOTE_TIMEOUT', advice: 'Git remote access timed out.', retryable: true }
      };
    }
  }), (error) => {
    assert.equal(error.code, 'GIT_REMOTE_TIMEOUT');
    assert.equal(error.details.timedOut, true);
    assert.equal(error.details.retryable, true);
    assert.match(error.message, /Git remote access timed out/);
    return true;
  });
  assert.equal(invoked, true);
});
