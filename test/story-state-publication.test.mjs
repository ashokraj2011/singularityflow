// SSB M3 [SSB:REQ-004, REQ-005, REQ-008]: a state-ref Story's state ref is its lifecycle authority. It passes the
// lifecycle authority conformance suite behind the same adapter as the branch, and its records are published with the
// Story branch, the ledger entry and its pin in one atomic push: all land, or none. A push refused, cancelled, lost or
// stopped midway is kept and finished by the next transition or by sync. Real clones and a bare remote throughout.
// docs/plans/SSB-M3-PLAN.md §2 and §3 (a).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { run as runProcess } from '../src/util.mjs';
import { lifecycleEvent, LIFECYCLE_EVENT } from '../src/lifecycle-event.mjs';
import { createStoryBranchAuthority } from '../src/sda/story-branch-authority.mjs';
import { readPendingPublication } from '../src/publication-pending.mjs';
import { openStoryState } from '../src/story-state-ref.mjs';
import { setAsideStoryStatePublication, planStoryStateSetAside, syncStoryStatePublication } from '../src/story-state-publication.mjs';
import { loadDefinition } from '../src/config.mjs';
import { manualStorySource, startStory } from '../src/story-start.mjs';
import { loadWorkflow } from '../src/story-workflow-read.mjs';
import { commitAndPublish } from '../src/story-publication-service.mjs';
import { forgetStoryLayouts } from '../src/story-paths.mjs';
import { STORY_STATE_REF_PREVIEW } from '../src/work-item-location.mjs';
import { lifecycleAuthorityConformance } from './helpers/sda-lifecycle-conformance.mjs';
import { realGitForTest, writeGitTestWrapper } from './helpers/git-test-wrapper.mjs';
import { lifecycleAuthorityOutcome } from '../src/sda/lifecycle-authority-contract.mjs';

const git = (cwd, args) => runProcess('git', args, { cwd }).stdout.trim();
const maybe = (cwd, args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null; };
const identity = (cwd, name = 'State Writer') => {
  git(cwd, ['config', 'user.name', name]);
  git(cwd, ['config', 'user.email', 'state-writer@example.test']);
};
// The unit of work's last hook before each boundary: just before the state commit, and just after it.
const STATE_STAGE_BEFORE = Object.freeze({ 'before-commit': 'before-state-commit', 'before-publishing': 'after-commit' });

/**
 * A clone on its Story branch with a state ref and checkout, and a bare remote that has seen neither. Git is wrapped on
 * PATH as test/sda-lifecycle-conformance.test.mjs does: a marker loses the next push's answer after it landed, and a
 * hold marker keeps the next push waiting for its release.
 */
async function stateRefFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-ssb-publish-'));
  const remote = path.join(parent, 'remote.git');
  const work = path.join(parent, 'work');
  runProcess('git', ['init', '-q', '--bare', remote]);
  runProcess('git', ['init', '-q', '-b', 'main', work]);
  identity(work);
  await writeFile(path.join(work, 'README.md'), '# application\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-qm', 'application root']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  const subject = { kind: 'story', id: 'LIFE-S', branch: 'LIFE-S' };
  git(work, ['switch', '-q', '-c', subject.branch]);
  const opened = await openStoryState(work, subject.id);

  const wrappers = path.join(parent, 'git-wrapper');
  const marker = path.join(parent, 'lose-next-response');
  const hold = path.join(parent, 'hold-next-push');
  const started = path.join(parent, 'push-started');
  const release = path.join(parent, 'push-released');
  await writeGitTestWrapper(wrappers, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('push') && fs.existsSync(${JSON.stringify(hold)})) {
  fs.rmSync(${JSON.stringify(hold)});
  fs.writeFileSync(${JSON.stringify(started)}, 'started\\n');
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
const result = spawnSync(${JSON.stringify(realGitForTest())}, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
if (args.includes('push') && fs.existsSync(${JSON.stringify(marker)}) && result.status === 0) {
  fs.rmSync(${JSON.stringify(marker)});
  process.stderr.write('fatal: the remote end hung up unexpectedly\\n');
  process.exit(128);
}
process.exit(result.status == null ? 1 : result.status);
`);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrappers}${path.delimiter}${previousPath}`;
  let sequence = 0;
  let watch = null;
  const cancelDuringPush = (controller) => {
    writeFileSync(hold, 'hold\n');
    watch = setInterval(() => {
      if (!existsSync(started)) return;
      clearInterval(watch);
      controller.abort();
      writeFileSync(release, 'release\n');
    }, 10);
  };
  return {
    authority: createStoryBranchAuthority(work),
    subject, work, remote, ref: opened.ref,
    target: { ref: opened.ref, remote: 'origin' },
    transition({ expectedRemoteSha, content, cancelAt = null }) {
      if (cancelAt?.stage === 'during-push') cancelDuringPush(cancelAt.controller);
      return {
        subject,
        event: lifecycleEvent({ type: 'binding', subject, payload: { content } }),
        commit: { message: `[${subject.id}][state] ${content}` },
        publication: { mode: 'required', remote: 'origin', branch: subject.branch,
          ...(expectedRemoteSha === undefined ? {} : { expectedRemoteSha }) },
        storage: { layout: 'state-ref' },
        state: { write: () => writeFile(path.join(work, '.sflow-state', 'governed.json'), `${JSON.stringify({ content, sequence: ++sequence })}\n`) },
        ...(cancelAt && cancelAt.stage !== 'during-push' ? {
          fault: (stage) => { if (stage === STATE_STAGE_BEFORE[cancelAt.stage]) cancelAt.controller.abort(); }
        } : {})
      };
    },
    async moveAuthority() {
      // Another clone publishes records to the Story's state ref first.
      const other = path.join(parent, `other-${++sequence}`);
      runProcess('git', ['clone', '-q', remote, other]);
      identity(other, 'Another Writer');
      git(other, ['fetch', '-q', 'origin', `+${opened.ref}:${opened.ref}`]);
      const tree = git(other, ['hash-object', '-t', 'tree', '-w', '/dev/null']);
      const moved = git(other, ['commit-tree', tree, '-p', opened.ref, '-m', 'another writer\'s records']);
      git(other, ['push', '-q', 'origin', `${moved}:${opened.ref}`]);
      return moved;
    },
    async loseNextResponse() { await writeFile(marker, 'lose\n'); },
    async cleanup() {
      clearInterval(watch);
      process.env.PATH = previousPath;
      forgetStoryLayouts();
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

lifecycleAuthorityConformance('state-ref authority', stateRefFixture);

test('the state ref: a transition commits on the state ref only and names the code commit it is about [REQ-004]', async (t) => {
  const fixture = await stateRefFixture();
  t.after(() => fixture.cleanup());
  const { authority, transition, work, remote, ref, subject } = fixture;
  const code = git(work, ['rev-parse', 'HEAD']);
  const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
  assert.equal(created.pushed, true);
  assert.equal(git(work, ['rev-parse', 'HEAD']), code, 'the Story branch gets no commit');
  assert.equal(git(work, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.match(git(work, ['log', '-1', '--format=%B', ref]), new RegExp(`Story-Code-Commit: ${code}`, 'u'));
  // The state ref and the new Story branch landed together; the branch at the code commit, the tracking ref follows.
  assert.equal(git(remote, ['rev-parse', ref]), created.sha);
  assert.equal(git(remote, ['rev-parse', `refs/heads/${subject.branch}`]), code);
  assert.equal(git(work, ['rev-parse', `refs/singularity/remotes/origin/state/${subject.id}`]), created.sha);
  // The next transition leaves the unchanged branch out of its push.
  const next = await authority.publish(transition({ expectedRemoteSha: created.sha, content: 'next' }));
  assert.equal(git(remote, ['rev-parse', ref]), next.sha);
  assert.equal(git(remote, ['rev-parse', `refs/heads/${subject.branch}`]), code);
});

test('the state ref: a lost answer is settled by sync from what the remote holds', async (t) => {
  const fixture = await stateRefFixture();
  t.after(() => fixture.cleanup());
  const { authority, transition, work, remote, ref, subject, loseNextResponse } = fixture;
  const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
  await loseNextResponse();
  let lost;
  await assert.rejects(authority.publish(transition({ expectedRemoteSha: created.sha, content: 'lost' })), (error) => { lost = error; return true; });
  assert.equal(lifecycleAuthorityOutcome(lost), 'OUTCOME_UNKNOWN');
  const synced = await syncStoryStatePublication(work, { git: { remote: 'origin' } }, { workItem: { id: subject.id } });
  assert.equal(synced.pushed, lost.publicationCommit);
  assert.equal(git(remote, ['rev-parse', ref]), lost.publicationCommit);
  assert.equal(git(work, ['rev-parse', `refs/singularity/remotes/origin/state/${subject.id}`]), lost.publicationCommit);
  assert.equal(await readPendingPublication(work, subject), null);
  const after = await authority.publish(transition({ expectedRemoteSha: lost.publicationCommit, content: 'after' }));
  assert.equal(git(remote, ['rev-parse', ref]), after.sha);
});

test('the state ref: one atomic push refused for its state ref moves no other ref; set aside, the Story goes on', async (t) => {
  const fixture = await stateRefFixture();
  t.after(() => fixture.cleanup());
  const { authority, transition, work, remote, ref, subject } = fixture;
  const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
  // The Story branch moved too, so it is in the push.
  await writeFile(path.join(work, 'code.txt'), 'code\n');
  git(work, ['add', 'code.txt']);
  git(work, ['commit', '-qm', 'code']);
  const branchBefore = git(remote, ['rev-parse', `refs/heads/${subject.branch}`]);
  // A teammate moves the state ref after this transition observed it and before it pushed: the lease is stale.
  let teammate;
  const stale = transition({ expectedRemoteSha: created.sha, content: 'stale' });
  stale.fault = async (stage) => {
    if (stage !== 'before-state-commit') return;
    const tree = git(remote, ['hash-object', '-t', 'tree', '-w', '/dev/null']);
    teammate = git(remote, ['commit-tree', tree, '-p', created.sha, '-m', 'teammate']);
    git(remote, ['update-ref', ref, teammate, created.sha]);
  };
  let refused;
  await assert.rejects(authority.publish(stale), (error) => { refused = error; return true; });
  assert.equal(lifecycleAuthorityOutcome(refused), 'REVISION_CONFLICT', refused.message);
  assert.deepEqual(refused.details.nextAction.argv, ['sync', subject.id, '--set-aside']);
  assert.equal(git(remote, ['rev-parse', ref]), teammate, 'the teammate\'s records stand');
  assert.equal(git(remote, ['rev-parse', `refs/heads/${subject.branch}`]), branchBefore, 'the branch did not move alone');
  assert.equal((await readPendingPublication(work, subject)).record.commit, refused.publicationCommit);
  // The set-aside keeps this clone's records on a ref of their own and goes on from the published ones.
  const config = { git: { remote: 'origin' } };
  const workflow = { workItem: { id: subject.id } };
  const plan = await planStoryStateSetAside(work, config, workflow);
  assert.deepEqual([plan.needed, plan.local, plan.published], [true, refused.publicationCommit, teammate]);
  const aside = await setAsideStoryStatePublication(work, config, workflow, { confirm: plan.local });
  assert.equal(git(work, ['rev-parse', ref]), teammate);
  assert.equal(git(work, ['rev-parse', aside.aside]), refused.publicationCommit);
  assert.equal(git(path.join(work, '.sflow-state'), ['rev-parse', 'HEAD']), teammate);
  assert.equal(await readPendingPublication(work, subject), null);
  const after = await authority.publish(transition({ expectedRemoteSha: teammate, content: 'after' }));
  assert.equal(git(remote, ['rev-parse', ref]), after.sha);
  assert.equal(git(remote, ['rev-parse', `refs/heads/${subject.branch}`]), git(work, ['rev-parse', 'HEAD']));
});

test('the state ref: a host hook that refuses the state ref moves nothing, and the records wait', async (t) => {
  const fixture = await stateRefFixture();
  t.after(() => fixture.cleanup());
  const { authority, transition, work, remote, ref, subject } = fixture;
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nwhile read old new name; do case "$name" in refs/singularity/state/*) echo "refs/singularity/state is not allowed here" >&2; exit 1;; esac; done\nexit 0\n');
  await chmod(hook, 0o755);
  let refused;
  await assert.rejects(authority.publish(transition({ expectedRemoteSha: null, content: 'refused' })), (error) => { refused = error; return true; });
  assert.match(refused.message, /refs\/singularity\/state is not allowed here/u);
  assert.equal(maybe(remote, ['rev-parse', '--verify', '--quiet', ref]), null);
  assert.equal(maybe(remote, ['rev-parse', '--verify', '--quiet', `refs/heads/${subject.branch}`]), null, 'the branch did not land alone');
  assert.equal(git(work, ['rev-parse', ref]), refused.publicationCommit, 'the records are kept here');
  assert.equal((await readPendingPublication(work, subject)).record.pushOutcome, 'rejected');
  assert.ok(refused.details.nextAction, 'it names its way out');
});

// A real Story: `story.storage: state-ref` under the preview, publication on, the ledger on (init's default).
function preview(t) {
  const was = process.env[STORY_STATE_REF_PREVIEW];
  process.env[STORY_STATE_REF_PREVIEW] = '1';
  t.after(() => { if (was === undefined) delete process.env[STORY_STATE_REF_PREVIEW]; else process.env[STORY_STATE_REF_PREVIEW] = was; });
}
function sh(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'State Ref Tester' } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
const cli = (root, ...args) => sh(process.execPath, [path.resolve('bin/singularity-flow.mjs'), ...args], root);

async function storyRepository(t, { publish = 'required', pinTransport = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ssb-story-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(`${root}.git`, { recursive: true, force: true }),
    rm(`${root}-second`, { recursive: true, force: true })]));
  sh('git', ['init', '-b', 'main'], root);
  identity(root, 'State Ref Tester');
  await writeFile(path.join(root, 'README.md'), '# State ref Stories\n');
  cli(root, 'init');
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = publish;
  definition.repositoryReadiness.requiredBeforeStory = false;
  definition.story = { storage: 'state-ref' };
  if (pinTransport) definition.ledger = { ...(definition.ledger ?? {}), pinTransport };
  await writeFile(definitionPath, YAML.stringify(definition));
  sh('git', ['add', '.'], root);
  sh('git', ['commit', '-m', 'initialize'], root);
  sh('git', ['init', '--bare', '-b', 'main', `${root}.git`], root);
  sh('git', ['remote', 'add', 'origin', `${root}.git`], root);
  sh('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

async function note(root, id, message, options = {}) {
  forgetStoryLayouts();
  const definition = await loadDefinition(root);
  const workflow = await loadWorkflow(root, definition, id);
  return commitAndPublish(root, definition, workflow, { type: LIFECYCLE_EVENT.BINDING }, `[${id}][state] ${message}`, [], options);
}

test('a state-ref Story\'s start lands its branch, state ref, ledger entry and pin in one push', async (t) => {
  preview(t);
  const root = await storyRepository(t);
  const remote = `${root}.git`;
  const base = git(root, ['rev-parse', 'HEAD']);
  const started = await startStory(root, { id: 'SSB-P1', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-P1', { title: 'Published at its start' }) });
  assert.equal(started.storage.layout, 'state-ref');
  assert.equal(started.storage.published, true);
  assert.equal(git(remote, ['rev-parse', 'refs/singularity/state/SSB-P1']), started.storage.commit);
  assert.equal(git(remote, ['rev-parse', 'refs/heads/SSB-P1']), base, 'the Story branch has no SFlow commit');
  const pins = git(remote, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/singularity/pins/']).split('\n').filter(Boolean);
  assert.ok(pins.length >= 1 && pins.every((line) => line.startsWith(`${base} `)), `the pin keeps the code commit: ${pins.join('; ')}`);
  const ledger = git(remote, ['ls-tree', '-r', '--name-only', 'refs/heads/state']).split('\n');
  assert.ok(ledger.some((file) => file.startsWith('ledger/entries/')), ledger.join('\n'));
  // The ledger intent is a record on the state ref, never on the branch.
  const records = git(root, ['ls-tree', '-r', '--name-only', 'refs/singularity/state/SSB-P1']).split('\n');
  assert.ok(records.some((file) => file.startsWith('context/ledger-intents/')), records.join('\n'));
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all']), '');
});

test('a transition stopped after its state commit and before its push is finished by the next transition, and by sync', async (t) => {
  preview(t);
  const root = await storyRepository(t);
  const remote = `${root}.git`;
  const started = await startStory(root, { id: 'SSB-P2', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-P2', { title: 'Interrupted' }) });
  const ref = 'refs/singularity/state/SSB-P2';
  await assert.rejects(note(root, 'SSB-P2', 'stopped', { fault: async (stage) => { if (stage === 'after-commit') throw new Error('stopped before the push'); } }),
    /stopped before the push/u);
  const stopped = git(root, ['rev-parse', ref]);
  assert.notEqual(stopped, started.storage.commit);
  assert.equal(git(remote, ['rev-parse', ref]), started.storage.commit, 'nothing was pushed');
  assert.equal((await readPendingPublication(root, { kind: 'story', id: 'SSB-P2' })).record.pushOutcome, 'not-attempted');
  // The next transition publishes the waiting records first, then its own.
  const next = await note(root, 'SSB-P2', 'next');
  assert.equal(next.pushed, true);
  assert.equal(git(remote, ['rev-parse', ref]), next.sha);
  assert.ok(git(root, ['rev-list', ref]).split('\n').includes(stopped));
  assert.equal(await readPendingPublication(root, { kind: 'story', id: 'SSB-P2' }), null);
  // And sync, run as a person would.
  await assert.rejects(note(root, 'SSB-P2', 'stopped again', { fault: async (stage) => { if (stage === 'after-commit') throw new Error('stopped again'); } }), /stopped again/u);
  const waiting = git(root, ['rev-parse', ref]);
  cli(root, 'sync', 'SSB-P2');
  assert.equal(git(remote, ['rev-parse', ref]), waiting);
  assert.equal(await readPendingPublication(root, { kind: 'story', id: 'SSB-P2' }), null);
});

test('a second clone resumes a state-ref Story and publishes on it; the first clone is told to fetch before it writes', async (t) => {
  preview(t);
  const root = await storyRepository(t);
  const remote = `${root}.git`;
  await startStory(root, { id: 'SSB-P3', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-P3', { title: 'Two laptops' }) });
  const ref = 'refs/singularity/state/SSB-P3';
  const second = `${root}-second`;
  sh('git', ['clone', '-q', remote, second], path.dirname(root));
  identity(second, 'Second Laptop');
  cli(second, 'resume', 'SSB-P3', '--fetch', '--json');
  const theirs = await note(second, 'SSB-P3', 'from the second laptop');
  assert.equal(theirs.pushed, true);
  assert.equal(git(remote, ['rev-parse', ref]), theirs.sha);
  // The first clone's tracking ref is behind: its next transition is refused before it writes, with the fetch named.
  const before = git(root, ['rev-parse', ref]);
  let refused;
  await assert.rejects(note(root, 'SSB-P3', 'from the first laptop'), (error) => { refused = error; return true; });
  assert.equal(refused.code, 'STORY_STATE_REMOTE_MOVED', refused.message);
  assert.deepEqual(refused.details.nextAction.argv, ['resume', 'SSB-P3', '--fetch']);
  assert.equal(git(root, ['rev-parse', ref]), before, 'nothing was written');
  assert.equal(git(path.join(root, '.sflow-state'), ['status', '--porcelain']), '');
  cli(root, 'resume', 'SSB-P3', '--fetch', '--json');
  const ours = await note(root, 'SSB-P3', 'from the first laptop');
  assert.equal(git(remote, ['rev-parse', ref]), ours.sha);
  assert.ok(git(root, ['rev-list', ref]).split('\n').includes(theirs.sha));
});

test('under ledger.pinTransport: branches the state ref is the branch sflow/state/<ID>, published the same way', async (t) => {
  preview(t);
  const root = await storyRepository(t, { pinTransport: 'branches' });
  const remote = `${root}.git`;
  const started = await startStory(root, { id: 'SSB-P4', workType: 'feature', baseBranch: 'main',
    source: manualStorySource('SSB-P4', { title: 'Branches transport' }) });
  assert.equal(started.storage.ref, 'refs/heads/sflow/state/SSB-P4');
  assert.equal(git(remote, ['rev-parse', 'refs/heads/sflow/state/SSB-P4']), started.storage.commit);
  assert.equal(maybe(remote, ['rev-parse', '--verify', '--quiet', 'refs/singularity/state/SSB-P4']), null);
});
