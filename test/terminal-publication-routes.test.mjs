import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyStoryGateFailures } from '../src/gate-recovery.mjs';
import { commitLandedOn } from '../src/branch-landing.mjs';
import { terminalPublicationObservation } from '../src/governance.mjs';
import { run } from '../src/util.mjs';

function git(cwd, ...args) { return run('git', args, { cwd }).stdout.trim(); }

async function commitFile(cwd, file, text, message) {
  await writeFile(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A Story checkout and a reviewer clone sharing a remote that is not called origin. */
async function topology(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-terminal-routes-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  const story = path.join(base, 'story');
  const reviewer = path.join(base, 'reviewer');
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', story);
  for (const cwd of [story]) {
    git(cwd, 'config', 'user.name', 'Terminal Routes');
    git(cwd, 'config', 'user.email', 'terminal-routes@example.invalid');
  }
  await commitFile(story, 'README.md', '# terminal routes\n', 'initial');
  git(story, 'remote', 'add', 'upstream', remote);
  git(story, 'push', '-q', '-u', 'upstream', 'main');
  git(base, 'clone', '-q', '-o', 'upstream', remote, reviewer);
  git(reviewer, 'config', 'user.name', 'Reviewer');
  git(reviewer, 'config', 'user.email', 'reviewer@example.invalid');
  return { story, reviewer };
}

async function storyBranch(story, name) {
  git(story, 'switch', '-q', '-c', name, 'main');
  await commitFile(story, `${name}.md`, `${name} delivered\n`, `[${name}] deliver`);
  git(story, 'push', '-q', '-u', 'upstream', name);
}

const observe = (story, name) => terminalPublicationObservation(story, 'upstream', name, { baseBranch: 'main' });

test('a branch deleted after a merge commit or a squash merge is published on its base', async (t) => {
  const { story, reviewer } = await topology(t);
  await storyBranch(story, 'STORY-MERGED');
  assert.equal((await observe(story, 'STORY-MERGED')).state, 'published');

  git(reviewer, 'fetch', '-q', 'upstream');
  git(reviewer, 'merge', '-q', '--no-ff', '-m', 'Merge STORY-MERGED', 'upstream/STORY-MERGED');
  git(reviewer, 'push', '-q', 'upstream', 'main', ':STORY-MERGED');
  const unfetched = await observe(story, 'STORY-MERGED');
  assert.equal(unfetched.published, false);
  assert.equal(unfetched.state, 'absent');
  assert.match(unfetched.reason, /has commits this checkout has not fetched/u);
  git(story, 'fetch', '-q', 'upstream');
  const merged = await observe(story, 'STORY-MERGED');
  assert.deepEqual([merged.published, merged.state, merged.landed], [true, 'landed', 'ancestor']);

  await storyBranch(story, 'STORY-SQUASHED');
  git(reviewer, 'fetch', '-q', 'upstream');
  git(reviewer, 'switch', '-q', 'main');
  git(reviewer, 'pull', '-q', '--ff-only', 'upstream', 'main');
  git(reviewer, 'merge', '-q', '--squash', 'upstream/STORY-SQUASHED');
  git(reviewer, 'commit', '-qm', 'STORY-SQUASHED (squashed)');
  await commitFile(reviewer, 'LATER.md', 'later unrelated work\n', 'later work on main');
  git(reviewer, 'push', '-q', 'upstream', 'main', ':STORY-SQUASHED');
  git(story, 'fetch', '-q', 'upstream');
  const squashed = await observe(story, 'STORY-SQUASHED');
  assert.deepEqual([squashed.published, squashed.state, squashed.landed], [true, 'landed', 'equivalent']);
});

test('a reverted squash, an unmerged deletion and diverged tips are never called published', async (t) => {
  const { story, reviewer } = await topology(t);
  await storyBranch(story, 'STORY-REVERTED');
  git(reviewer, 'fetch', '-q', 'upstream');
  git(reviewer, 'merge', '-q', '--squash', 'upstream/STORY-REVERTED');
  git(reviewer, 'commit', '-qm', 'squash');
  git(reviewer, 'revert', '--no-edit', 'HEAD');
  git(reviewer, 'push', '-q', 'upstream', 'main', ':STORY-REVERTED');
  git(story, 'fetch', '-q', 'upstream');
  assert.equal(commitLandedOn(story, 'HEAD', 'upstream/main'), null);
  const reverted = await observe(story, 'STORY-REVERTED');
  assert.deepEqual([reverted.published, reverted.state], [false, 'absent']);

  await storyBranch(story, 'STORY-AHEAD');
  await commitFile(story, 'local.md', 'unpushed\n', 'local only');
  assert.equal((await observe(story, 'STORY-AHEAD')).state, 'ahead');

  await storyBranch(story, 'STORY-BEHIND');
  git(reviewer, 'fetch', '-q', 'upstream');
  git(reviewer, 'switch', '-q', '-c', 'STORY-BEHIND', 'upstream/STORY-BEHIND');
  await commitFile(reviewer, 'review.md', 'reviewer fix\n', 'reviewer pushed');
  git(reviewer, 'push', '-q', 'upstream', 'STORY-BEHIND');
  assert.equal((await observe(story, 'STORY-BEHIND')).state, 'unfetched');
  git(story, 'fetch', '-q', 'upstream');
  assert.equal((await observe(story, 'STORY-BEHIND')).state, 'behind');
  await commitFile(story, 'mine.md', 'my change\n', 'local change');
  assert.equal((await observe(story, 'STORY-BEHIND')).state, 'diverged');
});

const closedStory = () => ({
  workItem: { id: 'ROUTE-1' }, phaseOrder: ['delivery'], currentPhase: null, status: 'in_progress',
  phases: { delivery: { id: 'delivery', status: 'approved', generation: 1, approvalPolicy: { rejectTo: ['delivery'] } } },
  resolution: {}
});
const finding = (state) => ({
  code: 'gate.publication.remote-missing', message: `terminal: ${state}`, phase: null, path: null,
  publication: { state, remote: 'upstream', branch: 'ROUTE-1', base: 'main' }
});

test('remote-missing recovery offers sync only when a retained commit is waiting', () => {
  const [pending] = classifyStoryGateFailures(closedStory(), [finding('ahead')], { publicationPending: true });
  assert.equal(pending.recovery.command, 'singularity-flow sync');
  assert.equal(pending.recovery.mode, 'automatic');

  const route = (state) => classifyStoryGateFailures(closedStory(), [finding(state)], { publicationPending: false })[0].recovery;
  for (const state of ['behind', 'unfetched', 'absent']) {
    assert.equal(route(state).command, 'singularity-flow recover ROUTE-1 --fetch', state);
    assert.equal(route(state).mode, 'guided');
    assert.match(route(state).detail, /No retained commit is waiting for sync/u);
  }
  assert.match(route('absent').detail, /upstream\/ROUTE-1 is gone/u);
  for (const state of ['ahead', 'diverged']) {
    assert.equal(route(state).command, null, state);
    assert.equal(route(state).mode, 'manual');
  }
  assert.equal(route('unavailable').command, 'singularity-flow workspace doctor --network');
  // A caller that does not say keeps the retry: the historical route for a retained commit.
  assert.equal(classifyStoryGateFailures(closedStory(), [finding('behind')])[0].recovery.command, 'singularity-flow sync');
});
