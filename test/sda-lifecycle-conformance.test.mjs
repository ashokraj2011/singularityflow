/**
 * SDA M4: the subject branch, behind the lifecycle authority adapter, and the deterministic test
 * adapter pass one conformance suite; the test adapter can never be selected as lifecycle authority.
 * Two Git-only checks follow it: what a cancelled transition leaves in the checkout, and that the
 * subject's sync publishes a commit retained by a cancellation before its push.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { readPendingPublication, syncPendingLifecyclePublication } from '../src/publication-pending.mjs';
import { readPublicationJournal } from '../src/publication-journal.mjs';
import { createGitLedgerAdapter } from '../src/sda/git-ledger-adapter.mjs';
import {
  LIFECYCLE_AUTHORITY_CONTRACT, lifecycleAuthorityDescriptor, selectLifecycleAuthority
} from '../src/sda/lifecycle-authority-contract.mjs';
import { createStoryBranchAuthority, lifecycleAuthority } from '../src/sda/story-branch-authority.mjs';
import { createMemoryLifecycleAuthority } from './helpers/sda-lifecycle-memory-adapter.mjs';
import { lifecycleAuthorityConformance } from './helpers/sda-lifecycle-conformance.mjs';
import { realGitForTest, writeGitTestWrapper } from './helpers/git-test-wrapper.mjs';

const git = (cwd, args) => run('git', args, { cwd }).stdout.trim();
const GIT_STAGE_BEFORE = Object.freeze({ 'before-commit': 'after-candidate-verification', 'before-publishing': 'after-commit' });
const identity = (cwd) => {
  git(cwd, ['config', 'user.name', 'Lifecycle Writer']);
  git(cwd, ['config', 'user.email', 'lifecycle@example.test']);
};

/**
 * A repository on its subject branch with a bare remote that has never seen that branch. Its Git is
 * wrapped on PATH for the lifetime of the fixture: with the marker present, the next push runs and
 * then reports a lost connection, as a response lost after receive-pack accepted the update would.
 * With the hold marker present, the next push says it started and waits for its release, so a
 * transition can be cancelled while its push is in flight.
 */
async function gitFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-lifecycle-'));
  const remote = path.join(parent, 'remote.git');
  const work = path.join(parent, 'work');
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['init', '-q', '-b', 'main', work]);
  identity(work);
  await writeFile(path.join(work, 'README.md'), '# application\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-qm', 'application root']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  const subject = { kind: 'story', id: 'LIFE-1', branch: 'LIFE-1' };
  git(work, ['switch', '-q', '-c', subject.branch]);

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
  /** Cancel when the held push has started, then let it run on. */
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
    subject,
    work,
    remote,
    target: { branch: subject.branch, remote: 'origin' },
    transition({ expectedRemoteSha, content, cancelAt = null }) {
      if (cancelAt?.stage === 'during-push') cancelDuringPush(cancelAt.controller);
      return {
        subject,
        allowedPaths: ['governed.json'],
        event: lifecycleEvent({ type: 'binding', subject, payload: { content } }),
        commit: { message: `[${subject.id}] ${content}` },
        publication: {
          mode: 'required', remote: 'origin', branch: subject.branch,
          ...(expectedRemoteSha === undefined ? {} : { expectedRemoteSha })
        },
        state: { write: () => writeFile(path.join(work, 'governed.json'), `${JSON.stringify({ content, sequence: ++sequence })}\n`) },
        // The unit of work's last fault hook before each boundary: its Candidate is verified just
        // before the commit, and the commit is made just before the push.
        ...(cancelAt && cancelAt.stage !== 'during-push' ? {
          fault: (stage) => {
            if (stage === GIT_STAGE_BEFORE[cancelAt.stage]) cancelAt.controller.abort();
          }
        } : {})
      };
    },
    async moveAuthority() {
      // Another clone publishes to the subject's branch first.
      const other = path.join(parent, `other-${++sequence}`);
      run('git', ['clone', '-q', '--branch', subject.branch, remote, other]);
      identity(other);
      await writeFile(path.join(other, 'other.txt'), `another writer ${sequence}\n`);
      git(other, ['add', 'other.txt']);
      git(other, ['commit', '-qm', 'another writer']);
      git(other, ['push', '-q', 'origin', subject.branch]);
      return git(other, ['rev-parse', 'HEAD']);
    },
    async loseNextResponse() { await writeFile(marker, 'lose\n'); },
    async cleanup() {
      clearInterval(watch);
      process.env.PATH = previousPath;
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

function memoryFixture() {
  const authority = createMemoryLifecycleAuthority();
  const subject = { kind: 'story', id: 'LIFE-M', branch: 'LIFE-M' };
  return {
    authority,
    subject,
    target: { branch: subject.branch, remote: 'memory' },
    transition: ({ expectedRemoteSha, content, cancelAt = null }) => ({
      subject,
      event: { payload: { content } },
      publication: { mode: 'required', branch: subject.branch, ...(expectedRemoteSha === undefined ? {} : { expectedRemoteSha }) },
      ...(cancelAt ? { reachedStage: (stage) => { if (stage === cancelAt.stage) cancelAt.controller.abort(); } } : {})
    }),
    moveAuthority: () => authority.moveAuthority(subject.branch),
    loseNextResponse: () => authority.loseNextResponse(),
    cleanup: () => {}
  };
}

lifecycleAuthorityConformance('story-branch authority', gitFixture);
lifecycleAuthorityConformance('memory lifecycle authority', memoryFixture);

test('the subject branch: a transition cancelled before its commit leaves HEAD, the working tree and no journal as they were', async (t) => {
  const fixture = await gitFixture();
  t.after(() => fixture.cleanup());
  const { authority, subject, transition, work } = fixture;
  const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
  const governed = await readFile(path.join(work, 'governed.json'), 'utf8');
  const controller = new AbortController();
  await assert.rejects(authority.publish(transition({
    expectedRemoteSha: created.sha, content: 'cancelled', cancelAt: { stage: 'before-commit', controller }
  }), { signal: controller.signal }), (error) => error.code === 'SDA_OPERATION_CANCELLED');
  assert.equal(git(work, ['rev-parse', 'HEAD']), created.sha);
  assert.equal(await readFile(path.join(work, 'governed.json'), 'utf8'), governed, 'the state write was restored');
  assert.equal(git(work, ['status', '--porcelain']), '');
  assert.equal(await readPublicationJournal(work, subject), null);
});

test('the subject branch: the commit a cancellation before the push retains is what the subject\'s sync publishes', async (t) => {
  const fixture = await gitFixture();
  t.after(() => fixture.cleanup());
  const { authority, subject, target, transition, work } = fixture;
  const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
  const controller = new AbortController();
  let cancelled;
  await assert.rejects(authority.publish(transition({
    expectedRemoteSha: created.sha, content: 'cancelled', cancelAt: { stage: 'before-publishing', controller }
  }), { signal: controller.signal }), (error) => { cancelled = error; return error.code === 'PUBLICATION_CANCELLED_BEFORE_PUSH'; });
  assert.equal(cancelled.details.nextAction, `singularity-flow sync ${subject.id}`);
  assert.equal(git(work, ['rev-parse', 'HEAD']), cancelled.publicationCommit, 'the branch keeps the commit');
  assert.equal(await readPublicationJournal(work, subject), null);
  const { record } = await readPendingPublication(work, subject);
  assert.deepEqual([record.commit, record.pushOutcome, record.recoveryStage, record.expectedRemoteSha],
    [cancelled.publicationCommit, 'not-attempted', 'branch-ref-advanced-before-publication', created.sha]);

  const synced = await syncPendingLifecyclePublication(work, { kind: subject.kind, id: subject.id });
  assert.equal(synced.pushed, cancelled.publicationCommit);
  assert.equal((await authority.observe(target)).revision, cancelled.publicationCommit);
  assert.equal(await authority.pending(subject), null);
});

test('only the production subject-branch adapter is selected as lifecycle authority', async () => {
  const selected = lifecycleAuthority(os.tmpdir());
  assert.deepEqual([selected.descriptor.id, selected.descriptor.contract, selected.descriptor.qualification],
    ['subject-branch', LIFECYCLE_AUTHORITY_CONTRACT, 'production']);
  assert.throws(() => selectLifecycleAuthority(createMemoryLifecycleAuthority()),
    (error) => error.code === 'SDA_ADAPTER_NOT_PRODUCTION');
  assert.throws(() => selectLifecycleAuthority(createGitLedgerAdapter(os.tmpdir(), { enabled: true, branch: 'state' })),
    (error) => error.code === 'SDA_ADAPTER_CONTRACT_MISMATCH');
  const partial = { descriptor: lifecycleAuthorityDescriptor({ id: 'partial', qualification: 'production', capabilities: ['exact-observation'] }) };
  assert.throws(() => selectLifecycleAuthority(partial),
    (error) => error.code === 'SDA_ADAPTER_CAPABILITY_UNSUPPORTED'
      && error.details.missing.join() === 'conditional-transition,pending-recovery,cancellation');
});
