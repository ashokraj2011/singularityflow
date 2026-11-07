/**
 * SDA M4: the subject branch, behind the lifecycle authority adapter, and the deterministic test
 * adapter pass one conformance suite; the test adapter can never be selected as lifecycle authority.
 * Two Git-only checks follow it: what a cancelled transition leaves in the checkout, and that the
 * subject's sync publishes a commit retained by a cancellation before its push.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { readPendingPublication, syncPendingLifecyclePublication } from '../src/publication-pending.mjs';
import { readPublicationJournal } from '../src/publication-journal.mjs';
import { createGitLedgerAdapter } from '../src/sda/git-ledger-adapter.mjs';
import {
  LIFECYCLE_AUTHORITY_CONTRACT, lifecycleAuthorityDescriptor, selectLifecycleAuthority
} from '../src/sda/lifecycle-authority-contract.mjs';
import { lifecycleAuthority } from '../src/sda/story-branch-authority.mjs';
import { createMemoryLifecycleAuthority } from './helpers/sda-lifecycle-memory-adapter.mjs';
import { lifecycleAuthorityConformance } from './helpers/sda-lifecycle-conformance.mjs';
import { gitLifecycleFixture as gitFixture } from './helpers/sda-git-lifecycle-fixture.mjs';

const git = (cwd, args) => run('git', args, { cwd }).stdout.trim();

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
