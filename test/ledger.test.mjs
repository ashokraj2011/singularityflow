import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { normalizeLedgerConfig } from '../src/ledger-config.mjs';
import {
  appendLedgerIntent,
  archiveLedger,
  canonicalJson,
  createLedgerIntent,
  initializeLedger,
  ledgerDoctor,
  ledgerLog,
  ledgerShow,
  ledgerStatus,
  persistLedgerIntent,
  publishToStateBranch,
  reconcileLedger,
  sha256,
  verifyLedger
} from '../src/ledger.mjs';

function git(root, args) {
  return run('git', args, { cwd: root });
}

async function repository() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-ledger-test-'));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  await mkdir(root);
  run('git', ['init', '--bare', remote]);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Ledger Tester']);
  git(root, ['config', 'user.email', 'ledger@example.com']);
  await writeFile(path.join(root, 'README.md'), '# application\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'application root']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-u', 'origin', 'main']);
  return { parent, remote, root };
}

const enabled = {
  enabled: true,
  branch: 'singularity/ledger',
  remote: 'origin',
  behind: 'block',
  enforcement: 'shadow',
  signing: 'off',
  trustTier: 'T0',
  maxRetries: 3
};

test('ledger configuration is opt-in and rejects dishonest signed trust tiers', () => {
  assert.equal(normalizeLedgerConfig().enabled, false);
  assert.equal(normalizeLedgerConfig().branch, 'singularity/ledger');
  assert.throws(() => normalizeLedgerConfig({ enabled: true, trustTier: 'T2' }), /requires ledger.signing/);
  assert.throws(() => normalizeLedgerConfig({ behind: 'continue' }), /warn or block/);
});

test('canonical ledger JSON is stable across object key order', () => {
  const left = canonicalJson({ z: 1, a: { y: 2, b: 3 } });
  const right = canonicalJson({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(left, right);
  assert.equal(sha256(left), sha256(right));
});

test('capability ledger is an orphan branch and verifies its content-addressed chain', async () => {
  const { root } = await repository();
  const initialized = await initializeLedger(root, enabled);
  assert.equal(initialized.created, true);
  assert.match(git(root, ['config', '--get-all', 'remote.origin.fetch']).stdout, /refs\/singularity\/pins/);
  const doctor = await ledgerDoctor(root, enabled);
  assert.equal(doctor.valid, true);
  assert.equal(doctor.checks.find((check) => check.id === 'orphan').status, 'pass');
  run('git', ['fetch', 'origin', 'singularity/ledger:refs/remotes/origin/singularity/ledger'], { cwd: root });
  const mergeBase = run('git', ['merge-base', 'main', 'origin/singularity/ledger'], { cwd: root, allowFailure: true });
  assert.notEqual(mergeBase.status, 0);

  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-1',
    subject: { workId: 'WORK-1', phase: 'design', generation: 1 },
    actor: { name: 'Reviewer', email: 'reviewer@example.com' },
    workingLens: 'architect',
    authorityGroup: 'architecture-reviewers',
    payload: { bundleHash: 'a'.repeat(64) }
  });
  const appended = await appendLedgerIntent(root, enabled, intent, git(root, ['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(appended.sequence, 1);
  const duplicate = await appendLedgerIntent(root, enabled, intent, git(root, ['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(duplicate.duplicate, true);
  const sameOperation = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-1',
    subject: { workId: 'WORK-1', phase: 'design', generation: 1 },
    actor: { name: 'Reviewer', email: 'reviewer@example.com' }
  });
  const idempotent = await appendLedgerIntent(root, enabled, sameOperation, git(root, ['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(idempotent.duplicate, true);

  const verified = await verifyLedger(root, enabled);
  assert.equal(verified.valid, true);
  assert.equal(verified.entries, 1);
  assert.equal(verified.sequence, 1);
  const log = await ledgerLog(root, enabled);
  assert.equal(log[0].eventId, intent.eventId);
  assert.equal((await ledgerShow(root, enabled, intent.eventId)).entry.eventType, 'phase-approved');

  const offline = await verifyLedger(root, enabled, { offline: true });
  assert.equal(offline.valid, true);
  const archive = await archiveLedger(root, enabled, 'archives/capability-ledger.bundle');
  assert.equal(archive.signature, 'unsigned');
  assert.match(archive.sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(await readFile(archive.manifestPath, 'utf8')).sha256, archive.sha256);
  assert.equal(git(root, ['bundle', 'verify', archive.path]).status, 0);
  await assert.rejects(
    archiveLedger(root, enabled, 'archives/capability-ledger.bundle'),
    /will not be replaced/
  );
});

test('a failed first ledger push retains the orphan root locally for safe retry', async () => {
  const { root, parent } = await repository();
  git(root, ['remote', 'set-url', 'origin', path.join(parent, 'unavailable.git')]);
  await assert.rejects(initializeLedger(root, enabled), /retained locally but push failed/);
  assert.match(git(root, ['rev-parse', '--verify', 'refs/heads/singularity/ledger']).stdout.trim(), /^[0-9a-f]{40}$/);
  const mergeBase = run('git', ['merge-base', 'main', 'singularity/ledger'], { cwd: root, allowFailure: true });
  assert.notEqual(mergeBase.status, 0);
});

test('durable work-branch intents reconcile from Git without relying on the local outbox', async () => {
  const { root } = await repository();
  await initializeLedger(root, enabled);
  const intent = createLedgerIntent({
    eventType: 'work-completed',
    capabilityId: 'story-WORK-2',
    subject: { workId: 'WORK-2', phase: 'conformance', generation: 1 },
    actor: { email: 'owner@example.com' }
  });
  const relative = await persistLedgerIntent(root, 'singularity/work-items/WORK-2', intent);
  git(root, ['add', relative]);
  git(root, ['commit', '-m', '[WORK-2][finalize] ready']);
  git(root, ['push', 'origin', 'main']);

  const reconciled = await reconcileLedger(root, enabled, { workId: 'WORK-2' });
  assert.equal(reconciled.appended.length, 1);
  assert.equal(reconciled.failed.length, 0);
  const second = await reconcileLedger(root, enabled, { workId: 'WORK-2' });
  assert.equal(second.existing.length, 1);
  const status = await ledgerStatus(root, enabled);
  assert.equal(status.pending.length, 0);
  const committed = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  assert.equal(committed.eventId, intent.eventId);
});

test('a fresh machine reconciles durable intents discovered on remote work branches', async () => {
  const { parent, remote, root } = await repository();
  await initializeLedger(root, enabled);
  git(root, ['switch', '-c', 'WORK-REMOTE']);
  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-REMOTE',
    subject: { workId: 'WORK-REMOTE', phase: 'requirements', generation: 1 },
    actor: { email: 'remote-reviewer@example.com' }
  });
  const relative = await persistLedgerIntent(root, 'singularity/work-items/WORK-REMOTE', intent);
  git(root, ['add', relative]);
  git(root, ['commit', '-m', '[WORK-REMOTE][phase:requirements][approve]']);
  git(root, ['push', '-u', 'origin', 'WORK-REMOTE']);

  const fresh = path.join(parent, 'fresh');
  run('git', ['clone', remote, fresh]);
  git(fresh, ['config', 'user.name', 'Fresh Machine']);
  git(fresh, ['config', 'user.email', 'fresh@example.com']);
  const result = await reconcileLedger(fresh, enabled, { workId: 'WORK-REMOTE' });
  assert.equal(result.appended.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.appended[0].eventId, intent.eventId);
  assert.equal((await ledgerStatus(fresh, enabled)).pending.length, 0);
});

test('a governed file can be published to the state branch, and republishing the same bytes is a no-op', async () => {
  // The state-branch copy is the one `resolveWorldModelSource` and every organisation-level read
  // prefer. Nothing wrote it until now, which made the preference inert.
  const { root } = await repository();
  await initializeLedger(root, enabled);

  const first = await publishToStateBranch(root, enabled, {
    'singularity/capabilities.yml': 'version: 1\ncapabilities: {}\n'
  }, 'Publish the capability map');
  assert.equal(first.changed, true);
  assert.equal(first.branch, 'singularity/ledger');
  assert.deepEqual(first.published, ['singularity/capabilities.yml']);

  // Readable from the branch without a checkout, which is how the readers reach it.
  const shown = run('git', ['show', `${enabled.branch}:singularity/capabilities.yml`], { cwd: root }).stdout;
  assert.match(shown, /^version: 1$/m);
  // And it did not touch the working tree it was published from.
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim(), '');

  // Publishing runs on every capability edit and most edits change one file out of several, so
  // identical bytes must not leave an empty commit behind.
  const again = await publishToStateBranch(root, enabled, {
    'singularity/capabilities.yml': 'version: 1\ncapabilities: {}\n'
  }, 'Publish the capability map');
  assert.equal(again.changed, false);
  assert.equal(again.commit, null);

  const changed = await publishToStateBranch(root, enabled, {
    'singularity/capabilities.yml': 'version: 1\ncapabilities: { commerce: { name: Commerce } }\n'
  }, 'Update capability commerce');
  assert.equal(changed.changed, true);
  assert.notEqual(changed.commit, first.commit);
});

test('a state-branch path that climbs out of the branch is refused', async () => {
  // The files are written into a temporary worktree, so `..` writes into the system temp folder.
  const { root } = await repository();
  await initializeLedger(root, enabled);
  await assert.rejects(
    () => publishToStateBranch(root, enabled, { '../escape.yml': 'x' }, 'Escape'),
    /must stay inside the branch/);
  await assert.rejects(
    () => publishToStateBranch(root, enabled, { '/etc/passwd': 'x' }, 'Escape'),
    /must stay inside the branch/);
});

test('publishing nothing does nothing', async () => {
  const { root } = await repository();
  const result = await publishToStateBranch(root, enabled, {}, 'Nothing');
  assert.equal(result.changed, false);
  assert.deepEqual(result.published, []);
});
