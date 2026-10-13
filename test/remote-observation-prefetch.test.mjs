import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { remotePushCount, runRemoteGit } from '../src/git-execution.mjs';
import {
  abandonRemoteBranchObservations, prefetchRemoteBranchObservation, takeRemoteBranchObservation
} from '../src/remote-observation-prefetch.mjs';

const answer = { reachable: true, sha: 'a'.repeat(40), malformed: false };
// A push as the Git runner records it, with no Git process.
const noteRemotePush = () => runRemoteGit(['push', '--porcelain', '--', 'origin', 'HEAD:refs/heads/story-1'], {
  operation: 'remote-push', env: { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' }
});

test('an early answer serves the same ask once; any other ask is asked afresh', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-prefetch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asks = [];
  const observe = async (...args) => { asks.push(args.slice(0, 3)); return answer; };
  prefetchRemoteBranchObservation(root, 'https://example.test/repo.git', 'story-1', observe);
  prefetchRemoteBranchObservation(root, 'https://example.test/repo.git', 'story-1', observe);
  assert.equal(await takeRemoteBranchObservation(root, 'https://example.test/other.git', 'story-1'), null);
  assert.equal(await takeRemoteBranchObservation(root, 'https://example.test/repo.git', 'story-2'), null);
  // The entry and the handler may name one checkout differently; it is still one ask.
  const linked = path.join(path.dirname(root), `${path.basename(root)}-link`);
  await symlink(root, linked, 'dir');
  t.after(() => rm(linked, { force: true }));
  assert.deepEqual(await takeRemoteBranchObservation(linked, 'https://example.test/repo.git', 'story-1'), answer);
  assert.equal(asks.length, 1, 'asked once');
  assert.equal(await takeRemoteBranchObservation(root, 'https://example.test/repo.git', 'story-1'), null, 'used once');
});

test('a push after the ask, a failed ask, or an ended command leaves publication to ask itself', async () => {
  const signals = [];
  const slow = (_root, _remote, _branch, { signal }) => { signals.push(signal); return new Promise(() => {}); };
  prefetchRemoteBranchObservation('/repo-a', 'https://example.test/a.git', 'story-1', slow);
  const before = remotePushCount();
  noteRemotePush();
  assert.equal(remotePushCount(), before + 1, 'the runner counts the push');
  assert.equal(await takeRemoteBranchObservation('/repo-a', 'https://example.test/a.git', 'story-1'), null,
    'a push of this process may have moved the tip');
  assert.equal(signals[0].aborted, true, 'and the unused ask stops');

  prefetchRemoteBranchObservation('/repo-b', 'https://example.test/b.git', 'story-1', async () => { throw new Error('offline'); });
  assert.equal(await takeRemoteBranchObservation('/repo-b', 'https://example.test/b.git', 'story-1'), null,
    'a failure is reported by the real ask, never replayed');

  let pending = 0;
  const pushDuring = async () => { pending += 1; noteRemotePush(); return answer; };
  prefetchRemoteBranchObservation('/repo-c', 'https://example.test/c.git', 'story-1', pushDuring);
  assert.equal(await takeRemoteBranchObservation('/repo-c', 'https://example.test/c.git', 'story-1'), null,
    'a push while the answer was outstanding');
  assert.equal(pending, 1);

  prefetchRemoteBranchObservation('/repo-d', 'https://example.test/d.git', 'story-1', slow);
  abandonRemoteBranchObservations();
  assert.equal(signals.at(-1).aborted, true, 'a command that did not publish does not wait for the remote');
  assert.equal(await takeRemoteBranchObservation('/repo-d', 'https://example.test/d.git', 'story-1'), null);
});
