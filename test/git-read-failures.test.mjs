import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hasLocalGovernanceAuthority } from '../src/cli-entry.mjs';
import { publishedGenerationCommit } from '../src/generation-publication-store.mjs';
import { gitCommitIdentity, remoteDefaultBranchName, remoteNames } from '../src/git.mjs';
import { worldModelCommit } from '../src/grounding.mjs';
import { storyWelEnrollmentStatus } from '../src/state.mjs';
import { readStoryReviewPacket } from '../src/story-lineage.mjs';
import { gitHeadIsUnborn, gitOutsideRepository, gitReadOutput, run } from '../src/util.mjs';

// A failed Git read used to return the same empty output as an honest empty answer: no commits, no
// remotes, a clean index, a record never added. These tests break Git for real and assert that the
// failure is refused with Git's own reason, while the genuinely empty states keep their answer.

const WORKFLOW = 'singularity/work-items/S-1/workflow.json';
const CONFIG = { workItemRoot: 'singularity/work-items' };

function refusal(label) {
  return (error) => error.code === 'GIT_READ_UNAVAILABLE'
    && error.message.startsWith(`${label} could not be read from Git: `)
    && /\S/.test(error.message.slice(`${label} could not be read from Git: `.length));
}

/** Repository-local Git with no global or system configuration leaking in from the machine. */
async function isolatedEnvironment(parent) {
  const empty = path.join(parent, 'empty.gitconfig');
  await writeFile(empty, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: os.devNull };
  delete env.SINGULARITY_FLOW_TEST_IDENTITY;
  delete env.NODE_ENV;
  return env;
}

/** A Story created in one commit and followed by another, so history can be broken below HEAD. */
async function storyRepository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-read-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo');
  await mkdir(path.join(root, 'singularity/work-items/S-1'), { recursive: true });
  const env = await isolatedEnvironment(parent);
  const git = (...args) => run('git', args, { cwd: root, env }).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Reader');
  git('config', 'user.email', 'reader@example.invalid');
  await writeFile(path.join(root, WORKFLOW), '{}\n');
  await mkdir(path.join(root, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(root, 'singularity/world-model/manifest.json'), '{}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'create S-1');
  const created = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'README.md'), 'later\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'later');
  return { parent, root, env, git, created };
}

/** Git can still name HEAD, but cannot walk past it: the commit below it is gone. */
async function deleteObject(root, objectId) {
  await rm(path.join(root, '.git/objects', objectId.slice(0, 2), objectId.slice(2)));
}

async function unbornRepository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-read-unborn-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: parent });
  return parent;
}

test('a Git read that failed is refused, never read as an empty answer', async (t) => {
  const { root, env, created } = await storyRepository(t);
  const read = (args, options = {}) => run('git', args, { cwd: root, env, allowFailure: true, ...options });

  // A read that succeeded may be empty; Git's documented negative answers are null.
  assert.equal(gitReadOutput(read(['log', '--format=%H', '--', 'never/added.json']), 'Absent record'), '');
  assert.equal(gitReadOutput(read(['rev-parse', '--verify', '--quiet', 'refs/heads/missing^{commit}']),
    'Missing branch', { absentStatus: 1 }), null);
  assert.equal(gitReadOutput(read(['config', '--get', 'user.signingkey']), 'Signing key', { absentStatus: 1 }), null);
  assert.equal(gitReadOutput(read(['remote', 'get-url', 'origin']), 'Origin', { absentStatus: 2 }), null);
  // The declared status is the only absence: the same missing branch without --quiet is a failure.
  assert.throws(() => gitReadOutput(read(['rev-parse', '--verify', 'refs/heads/missing^{commit}']),
    'Missing branch', { absentStatus: 1 }), refusal('Missing branch'));
  // Without --verify, rev-parse echoes an unresolved revision on stdout, so its output is not even
  // empty; only its exit status says the read failed.
  const echoed = read(['rev-parse', 'origin/S-1']);
  assert.equal(echoed.stdout.trim(), 'origin/S-1');
  assert.throws(() => gitReadOutput(echoed, 'Story branch'), refusal('Story branch'));

  // Git that could not start, or was stopped, never produced an answer, absent or otherwise.
  assert.throws(() => gitReadOutput(read(['status'], { cwd: path.join(root, 'no-such-directory') }),
    'Working tree status'), refusal('Working tree status'));
  assert.throws(() => gitReadOutput({ status: 1, signal: 'SIGKILL', stdout: '', stderr: '' },
    'Configured origin', { absentStatus: 1 }), (error) => error.code === 'GIT_READ_UNAVAILABLE'
    && /stopped by SIGKILL/.test(error.message));

  // Remove the creation commit: Git can still name HEAD but cannot walk the history below it.
  const history = ['log', '--format=%H', '--diff-filter=A', '--', WORKFLOW];
  assert.deepEqual(gitReadOutput(read(history), 'Story history').trim(), created);
  await deleteObject(root, created);
  assert.throws(() => gitReadOutput(read(history), 'Story history', {
    absentWhen: () => gitHeadIsUnborn(root, { env })
  }), refusal('Story history'));

  // An index Git cannot read is not a clean working tree.
  await writeFile(path.join(root, '.git/index'), 'not an index');
  assert.throws(() => gitReadOutput(read(['status', '--porcelain']), 'Working tree status'),
    refusal('Working tree status'));

  // A configuration Git cannot parse is not an unset key.
  await appendFile(path.join(root, '.git/config'), '[[[broken\n');
  assert.throws(() => gitReadOutput(read(['config', '--get', 'user.email']), 'Git user.email', {
    absentStatus: 1
  }), refusal('Git user.email'));
});

test('only an unborn HEAD makes a failed history read genuinely empty', async (t) => {
  const unborn = await unbornRepository(t);
  assert.equal(gitHeadIsUnborn(unborn), true);
  const log = run('git', ['log', '--format=%H', '--', WORKFLOW], { cwd: unborn, allowFailure: true });
  assert.notEqual(log.status, 0, 'git log fails before the first commit');
  assert.equal(gitReadOutput(log, 'Story history', { absentWhen: () => gitHeadIsUnborn(unborn) }), null);

  const { root, parent } = await storyRepository(t);
  assert.equal(gitHeadIsUnborn(root), false, 'a repository with commits is not unborn');
  const plain = path.join(parent, 'plain');
  await mkdir(plain);
  assert.equal(gitHeadIsUnborn(plain), false, 'a directory outside any repository is not an unborn HEAD');
  await appendFile(path.join(root, '.git/config'), '[[[broken\n');
  assert.equal(gitHeadIsUnborn(root), false, 'a repository Git cannot read is not an unborn HEAD');
});

test('an accepted Story whose history Git cannot walk is refused, not reported as never created', async (t) => {
  const { root, created } = await storyRepository(t);
  assert.deepEqual(storyWelEnrollmentStatus(root, CONFIG, 'S-1'), {
    classification: 'legacy', mode: 'disabled', reason: 'created-with-story-workflow-v1', creationCommit: created
  });
  await deleteObject(root, created);
  assert.equal(storyWelEnrollmentStatus(root, CONFIG, 'S-1').reason, 'GIT_READ_UNAVAILABLE',
    'the creation record was not read, which is not the same as never created');

  const unborn = await unbornRepository(t);
  assert.equal(storyWelEnrollmentStatus(unborn, CONFIG, 'S-1').reason, 'creation-record-unavailable');
});

test('review packets, generation publications and world-model commits refuse an unreadable history', async (t) => {
  const workflow = {
    workItem: { id: 'S-1' },
    lineage: { submissions: [{ packetSha256: `sha256:${'a'.repeat(64)}`, path: 'singularity/work-items/S-1/review.json' }] }
  };
  const phase = {
    id: 'build', generation: 1, generationPublications: [],
    artifacts: [{ path: 'singularity/work-items/S-1/artifacts/build.md' }]
  };

  const unborn = await unbornRepository(t);
  await assert.rejects(readStoryReviewPacket(unborn, CONFIG, workflow),
    (error) => error.code === 'STORY_REVIEW_EVIDENCE_INVALID', 'before the first commit no packet was committed');
  assert.equal(publishedGenerationCommit(unborn, workflow, phase, 1), null);
  assert.equal(worldModelCommit(unborn, 'singularity/world-model'), null);

  const { root, created, git } = await storyRepository(t);
  await assert.rejects(readStoryReviewPacket(root, CONFIG, workflow),
    (error) => error.code === 'STORY_REVIEW_EVIDENCE_INVALID');
  assert.equal(publishedGenerationCommit(root, workflow, phase, 1), null, 'a generation never published');
  assert.equal(worldModelCommit(root, 'singularity/world-model'), created);
  assert.equal(worldModelCommit(root, 'singularity/never-built'), null);
  assert.equal(git('rev-parse', 'HEAD~1'), created);

  await deleteObject(root, created);
  await assert.rejects(readStoryReviewPacket(root, CONFIG, workflow),
    refusal("Story 'S-1' review packet history"));
  assert.throws(() => publishedGenerationCommit(root, workflow, phase, 1),
    refusal('Generation 1 publication record'));
  assert.throws(() => worldModelCommit(root, 'singularity/world-model'),
    refusal("World model 'singularity/world-model' commit"));
});

test('routing refuses a governance probe Git could not answer instead of choosing another workspace', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-read-routing-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo');
  await mkdir(root);
  const env = await isolatedEnvironment(parent);
  const git = (...args) => run('git', args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Reader');
  git('config', 'user.email', 'reader@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'application\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'application');

  // Every probe succeeded and found nothing, including `git grep` exiting 1 for no match.
  assert.equal(hasLocalGovernanceAuthority(root), false);
  await writeFile(path.join(root, '.git/index'), 'not an index');
  assert.throws(() => hasLocalGovernanceAuthority(root), refusal('Tracked governed subjects'));
});

test('remotes, the remote default branch and commit identity refuse a configuration Git cannot read', async (t) => {
  const { root, parent } = await storyRepository(t);
  const env = await isolatedEnvironment(parent);
  run('git', ['config', '--unset', 'user.email'], { cwd: root, env });

  assert.deepEqual(remoteNames(root, { env }), [], 'a repository with no remotes');
  assert.equal(remoteDefaultBranchName(root), null, 'a clone that records no remote default branch');
  assert.equal(gitCommitIdentity(root, { env }).email, null, 'an unset user.email');

  await appendFile(path.join(root, '.git/config'), '[[[broken\n');
  assert.throws(() => remoteNames(root, { env }), refusal('Git remotes'));
  assert.throws(() => remoteDefaultBranchName(root), refusal("The 'origin' default branch"));
  assert.throws(() => gitCommitIdentity(root, { env }), refusal('Git user.name'));
});

test('outside a repository is told apart from a repository Git cannot read', async (t) => {
  const { root, parent } = await storyRepository(t);
  const plain = path.join(parent, 'plain');
  await mkdir(plain);
  assert.equal(gitOutsideRepository(plain), true);
  assert.equal(gitOutsideRepository(root), false);
  // Both exit 128 from `rev-parse --git-dir`; only Git's own message says which.
  await appendFile(path.join(root, '.git/config'), '[[[broken\n');
  assert.equal(gitOutsideRepository(root), false, 'a bad configuration line is not "outside a repository"');
});
