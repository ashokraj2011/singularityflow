import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import {
  commitIsolated, gitDir, governedCommitIdentity, publicationPushOutcome
} from '../src/git.mjs';
import {
  classifyGitRemoteFailure, configuredRemoteFingerprint
} from '../src/git-remote-diagnostics.mjs';
import {
  discardCleanPreparedPublication, livePreparedPublicationOwner, readPendingPublication,
  recoverPreparedPublication, recoverPreparedPublicationBySubject, writePendingPublication
} from '../src/publication-pending.mjs';
import {
  capturePublicationPreimage, publicationReworkRefNamespace, restorePublicationPreimage
} from '../src/publication-recovery.mjs';
import {
  beginPublicationJournal, publicationJournalPath, readPublicationJournal
} from '../src/publication-journal.mjs';
import { acquireSubjectLock, releaseSubjectLock, subjectLockPath } from '../src/subject-lock.mjs';
import { runDraftTransaction } from '../src/draft-unit-of-work.mjs';
import { recordSha256 } from '../src/records.mjs';
import { syncPublication } from '../src/state.mjs';
import { syncInitiativePublication } from '../src/initiative-state.mjs';
import {
  capabilityPublicationPlanSha256, publishCapabilityRepositoriesDurably,
  retainCapabilityPublicationRecovery
} from '../src/capability-publication-recovery.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Fault Matrix'], root);
  git(['config', 'user.email', 'faults@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# publication fault matrix\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'initial'], root);
  return root;
}

async function ensurePublicationOrigin(root) {
  const configured = spawnSync('git', ['remote', 'get-url', '--push', 'origin'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (configured.status === 0 && configured.stdout.trim()) return configured.stdout.trim();
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-publication-fault-origin-'));
  git(['init', '--bare', '-q'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  return remote;
}

async function rejectPushes(remote) {
  const hook = path.join(remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  return () => rm(hook, { force: true });
}

const stages = ['after-state-write', 'after-commit', 'after-push', 'after-ledger'];
const kinds = ['story', 'initiative'];
const publicationModule = pathToFileURL(path.join(packageRoot, 'src/publication-unit-of-work.mjs')).href;
const draftModule = pathToFileURL(path.join(packageRoot, 'src/draft-unit-of-work.mjs')).href;
const eventModule = pathToFileURL(path.join(packageRoot, 'src/lifecycle-event.mjs')).href;
const recoveryModule = pathToFileURL(path.join(packageRoot, 'src/publication-recovery.mjs')).href;

async function crashPublication(root, subject, target, stage, { mode = 'required' } = {}) {
  // Required publication now refuses before opening its journal unless one exact push authority is
  // configured. These tests exercise later crash boundaries, so give only those cases a disposable
  // local authority; mode-off recovery must remain independent of remote configuration.
  if (mode !== 'off') await ensurePublicationOrigin(root);
  const script = [
    `import { writeFile } from 'node:fs/promises';`,
    `import { GitPublicationUnitOfWork } from ${JSON.stringify(publicationModule)};`,
    `import { lifecycleEvent } from ${JSON.stringify(eventModule)};`,
    `const root = ${JSON.stringify(root)};`,
    `const subject = ${JSON.stringify(subject)};`,
    `await new GitPublicationUnitOfWork(root).execute({`,
    `  subject, allowedPaths: [${JSON.stringify(target)}],`,
    `  event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),`,
    `  commit: { message: '[${subject.id}] crash identity test' },`,
    `  publication: { mode: ${JSON.stringify(mode)}, branch: 'main', remote: 'origin' },`,
    `  state: { write: () => writeFile(root + '/' + ${JSON.stringify(target)}, '{"status":"transaction"}\\n') },`,
    `  fault: (current) => { if (current === ${JSON.stringify(stage)}) process.exit(77); }`,
    `});`
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: packageRoot, encoding: 'utf8'
  });
  assert.equal(child.status, 77, child.stderr);
}

async function pathExists(target) {
  try { await access(target); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function waitForRemoteRef(remote, ref, expected, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', ref], {
      encoding: 'utf8'
    });
    if (observed.status === 0 && observed.stdout.trim() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(git(['--git-dir', remote, 'rev-parse', '--verify', ref], remote), expected);
}

function storyFor(subject) {
  return {
    workItem: { id: subject.id, branch: subject.branch },
    lineage: { canonicalBranch: subject.branch, childBranches: [] },
    resolution: { ledger: { enabled: false } }
  };
}

function initiativeFor(subject) {
  return {
    initiative: { id: subject.id, branch: subject.branch },
    resolution: { ledger: { enabled: false } }
  };
}

async function retainedPublication(kind, id, { eventPayload = {}, exactLease = false } = {}) {
  const root = await repository(`sflow-${kind}-verified-sync-`);
  const remote = await mkdtemp(path.join(os.tmpdir(), `sflow-${kind}-verified-origin-`));
  git(['init', '--bare', '-q'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  const subject = { kind, id, branch: 'main' };
  const target = `${kind}-state.json`;
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', `${kind} canonical state`], root);
  git(['push', 'origin', 'main'], root);
  const remoteBaseline = git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root);
  const allowPushes = await rejectPushes(remote);
  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    event: lifecycleEvent({
      type: 'artifact-generated', subject, phaseId: 'intake', generation: 1,
      payload: eventPayload
    }),
    commit: { message: `[${id}] retained exact publication` },
    publication: {
      mode: 'required', branch: 'main', remote: 'origin',
      ...(kind === 'story' || exactLease ? { expectedRemoteSha: remoteBaseline } : {})
    },
    allowedPaths: [target],
    state: { write: () => writeFile(path.join(root, target), '{"status":"pending"}\n') }
  }), /retained locally but push failed/);
  const pending = await readPendingPublication(root, subject);
  await allowPushes();
  return { root, remote, remoteBaseline, subject, marker: structuredClone(pending.record) };
}

async function capabilityTailFixture(id, { siblingCount = 1 } = {}) {
  const root = await repository(`sflow-capability-tail-root-${id}-`);
  const remote = await mkdtemp(path.join(os.tmpdir(), `sflow-capability-tail-root-origin-${id}-`));
  git(['init', '--bare', '-q'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  git(['switch', '-c', id], root);

  const siblings = [];
  const siblingRemotes = [];
  const entries = [];
  for (let index = 0; index < siblingCount; index += 1) {
    const sibling = await repository(`sflow-capability-tail-sibling-${id}-${index}-`);
    const siblingRemote = await mkdtemp(path.join(
      os.tmpdir(), `sflow-capability-tail-sibling-origin-${id}-${index}-`
    ));
    git(['init', '--bare', '-q'], siblingRemote);
    git(['remote', 'add', 'origin', siblingRemote], sibling);
    git(['push', '-u', 'origin', 'main'], sibling);
    siblings.push(sibling);
    siblingRemotes.push(siblingRemote);
    entries.push({
      schemaVersion: 1,
      repository: `sibling-${index + 1}`,
      root: sibling,
      remote: 'origin',
      branch: id,
      commit: git(['rev-parse', 'HEAD'], sibling),
      destinationRef: `refs/heads/${id}`,
      remoteFingerprint: configuredRemoteFingerprint(sibling, 'origin'),
      expectedRemoteSha: null,
      pushOutcome: 'not-attempted'
    });
  }
  const target = 'story-state.json';
  const subject = { kind: 'story', id, branch: id };
  const event = lifecycleEvent({
    type: 'binding', subject,
    payload: { capabilityPublicationPlanSha256: capabilityPublicationPlanSha256(entries) }
  });
  const pendingMetadata = {
    workId: id,
    recoveryStage: 'capability-publication-pending',
    capabilityPublicationPlan: entries,
    capabilityPublications: entries,
    error: 'Capability Story branch publication has not started.'
  };
  return {
    root, remote,
    sibling: siblings[0], siblingRemote: siblingRemotes[0], entry: entries[0],
    siblings, siblingRemotes, entries,
    target, subject, event, pendingMetadata
  };
}

async function publishCapabilityTailRoot(fixture) {
  const publication = await new GitPublicationUnitOfWork(fixture.root).execute({
    subject: fixture.subject,
    event: fixture.event,
    commit: { message: `[${fixture.subject.id}][init] start governed Story workflow` },
    publication: {
      mode: 'required', branch: fixture.subject.branch, remote: 'origin', expectedRemoteSha: null
    },
    allowedPaths: [fixture.target],
    state: {
      write: () => writeFile(path.join(fixture.root, fixture.target), '{"status":"ready"}\n')
    },
    pendingMetadata: fixture.pendingMetadata,
    retainPendingOnSuccess: true
  });
  return publication;
}

test('push outcome distinguishes ambiguous transport loss from definitive rejection', () => {
  assert.equal(publicationPushOutcome({ status: 0 }), 'published');
  assert.equal(publicationPushOutcome({ status: 1, timedOut: true }), 'transport-indeterminate');
  for (const stderr of [
    'fatal: early EOF',
    'send-pack: unexpected disconnect while reading sideband packet',
    'fatal: the remote end hung up unexpectedly',
    'error: RPC failed; curl 56 Recv failure: Connection was reset',
    'write error: Broken pipe'
  ]) {
    const result = { status: 1, stderr };
    assert.equal(classifyGitRemoteFailure(result).classification, 'network-transient', stderr);
    assert.equal(publicationPushOutcome(result), 'transport-indeterminate', stderr);
  }
  assert.equal(publicationPushOutcome({
    status: 1, failure: { classification: 'authorization-denied' }, stderr: 'rejected'
  }), 'rejected');
  assert.equal(publicationPushOutcome({ status: 1, stderr: 'stale info' }), 'rejected');
});

test('Story and Initiative publications have the same recovery boundary at every fault stage', async (t) => {
  for (const kind of kinds) {
    for (const stage of stages) {
      await t.test(`${kind}/${stage}`, async () => {
        const root = await repository(`sflow-${kind}-${stage}-`);
        const before = git(['rev-parse', 'HEAD'], root);
        const subject = { kind, id: `${kind.toUpperCase()}-${stage}`, branch: 'main' };
        const target = `${kind}-state.json`;
        const prior = `${JSON.stringify({ status: 'before' })}\n`;
        await writeFile(path.join(root, target), prior);
        git(['add', target], root);
        git(['commit', '-m', 'canonical state'], root);
        const canonical = git(['rev-parse', 'HEAD'], root);
        const event = lifecycleEvent({
          type: 'artifact-generated', subject, phaseId: 'intake', generation: 1
        });

        await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
          subject,
          event,
          commit: { message: `[${subject.id}] fault at ${stage}` },
          publication: { mode: 'off', branch: 'main' },
          allowedPaths: [target],
          state: {
            write: () => writeFile(path.join(root, target), `${JSON.stringify({ status: stage })}\n`),
            rollback: () => writeFile(path.join(root, target), prior)
          },
          fault: (current) => {
            if (current === stage) throw new Error(`fault:${kind}:${stage}`);
          }
        }), new RegExp(`fault:${kind}:${stage}`));

        const owner = await acquireSubjectLock(root, subject);
        assert.equal(await releaseSubjectLock(root, subject, owner), true,
          `${kind}/${stage} released the subject lock`);

        const after = git(['rev-parse', 'HEAD'], root);
        if (stage === 'after-state-write') {
          assert.equal(after, canonical, `${kind} did not cross the commit boundary`);
          assert.equal(await readFile(path.join(root, target), 'utf8'), prior,
            `${kind} restored its canonical state`);
        } else {
          assert.notEqual(after, canonical, `${kind} retained the completed local commit`);
          assert.match(await readFile(path.join(root, target), 'utf8'), new RegExp(stage));
        }
        assert.equal(git(['status', '--porcelain'], root), '', `${kind}/${stage} left a clean worktree`);
        assert.notEqual(before, canonical, 'the fixture has a real canonical-state commit');
      });
    }
  }
});

test('an active publication does not diagnose its own prewritten journal as pending', async () => {
  const root = await repository('sflow-journal-owner-');
  const subject = { kind: 'story', id: 'STORY-JOURNAL-OWNER', branch: 'main' };
  const target = 'story-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', 'canonical state'], root);
  let pendingSeenInsideValidation = 'not-called';

  await new GitPublicationUnitOfWork(root).execute({
    subject,
    event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),
    commit: { message: '[STORY-JOURNAL-OWNER] publish' },
    publication: { mode: 'off', branch: 'main' },
    allowedPaths: [target],
    state: {
      write: () => writeFile(path.join(root, target), '{"status":"committed"}\n'),
      validate: async () => { pendingSeenInsideValidation = await readPendingPublication(root, subject); }
    }
  });

  assert.equal(pendingSeenInsideValidation, null);
  assert.equal(await pathExists(publicationJournalPath(root, subject.kind, subject.id)), false);
});

test('Story and Initiative sync are true no-ops without a pending marker even after manual HEAD advances', async (t) => {
  for (const kind of ['story', 'initiative']) {
    await t.test(kind, async () => {
      const root = await repository(`sflow-${kind}-sync-no-marker-`);
      const remote = await mkdtemp(path.join(os.tmpdir(), `sflow-${kind}-sync-no-marker-origin-`));
      git(['init', '--bare', '-q'], remote);
      git(['remote', 'add', 'origin', remote], root);
      git(['push', '-u', 'origin', 'main'], root);
      const published = git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root);
      await writeFile(path.join(root, 'manual.txt'), 'not a governed publication\n');
      git(['add', 'manual.txt'], root);
      git(['commit', '-m', 'manual local commit'], root);
      const manualHead = git(['rev-parse', 'HEAD'], root);
      assert.notEqual(manualHead, published);
      const subject = { kind, id: `${kind.toUpperCase()}-NO-MARKER`, branch: 'main' };

      const result = kind === 'story'
        ? await syncPublication(root, { git: { remote: 'origin' }, ledger: { enabled: false } }, storyFor(subject))
        : await syncInitiativePublication(root, { git: { remote: 'origin' } }, initiativeFor(subject));

      assert.equal(result.noOp, true);
      assert.equal(result.pushed, null);
      assert.equal(result.ledger, null);
      assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), published,
        `${kind} sync pushed an unrelated manual HEAD`);
    });
  }
});

test('Story sync rejects every mutable identity mismatch and retains the recovery marker', async () => {
  const fixture = await retainedPublication('story', 'STORY-MARKER-MISMATCH');
  const { root, remote, remoteBaseline, subject, marker } = fixture;
  const changedDigest = (value) => `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
  const mismatches = [
    ['subject', (record) => { record.subject.id = 'OTHER-STORY'; }],
    ['branch', (record) => { record.branch = 'other-branch'; }],
    ['remote', (record) => { record.remote = 'unreviewed-remote'; }],
    ['commit', (record) => { record.commit = git(['rev-parse', 'HEAD^'], root); }],
    ['tree', (record) => { record.tree = changedDigest(record.tree); }],
    ['transaction', (record) => { record.transactionId = `${record.transactionId}-tampered`; }],
    ['event digest', (record) => { record.eventSha256 = changedDigest(record.eventSha256); }],
    ['state digest', (record) => { record.stateSha256 = changedDigest(record.stateSha256); }],
    ['publication mode', (record) => { record.publicationMode = 'warn'; }],
    ['expected remote commit', (record) => { record.expectedRemoteSha = '0'.repeat(40); }],
    ['event body', (record) => { record.event.payload = { tampered: true }; }],
    ['event source', (record) => { record.event.sourceCommit = git(['rev-parse', 'HEAD^'], root); }]
  ];

  for (const [label, mutate] of mismatches) {
    const changed = structuredClone(marker);
    mutate(changed);
    await writePendingPublication(root, { ...subject, record: changed });
    await assert.rejects(
      () => syncPublication(
        root,
        { git: { remote: 'origin' }, ledger: { enabled: false } },
        storyFor(subject)
      ),
      (error) => error?.code === 'PENDING_PUBLICATION_IDENTITY_INVALID',
      label
    );
    assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), remoteBaseline,
      `${label} marker advanced the remote`);
    assert.ok(await readPendingPublication(root, subject), `${label} marker was discarded`);
  }

  await writePendingPublication(root, { ...subject, record: marker });
  const synced = await syncPublication(
    root,
    { git: { remote: 'origin' }, ledger: { enabled: false } },
    storyFor(subject)
  );
  assert.equal(synced.pushed, marker.commit);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), marker.commit);
  assert.equal(await readPendingPublication(root, subject), null);
});

test('fresh Story publication and known-rejection sync both refuse an identical concurrent ref', async () => {
  const root = await repository('sflow-story-create-only-cas-');
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-create-only-origin-'));
  git(['init', '--bare', '-q'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  git(['switch', '-c', 'STORY-CREATE-ONLY'], root);
  const subject = { kind: 'story', id: 'STORY-CREATE-ONLY', branch: 'STORY-CREATE-ONLY' };
  const target = 'story-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');

  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    event: lifecycleEvent({ type: 'binding', subject }),
    commit: { message: '[STORY-CREATE-ONLY][init] start governed Story workflow' },
    publication: {
      mode: 'required', branch: subject.branch, remote: 'origin', expectedRemoteSha: null
    },
    allowedPaths: [target],
    state: { write: () => writeFile(path.join(root, target), '{"status":"ready"}\n') },
    fault: (stage, { sourceCommit } = {}) => {
      if (stage === 'after-commit') {
        // The other actor publishes the identical object after our local transaction commit but
        // before its network publication. Git would normally call the later push "up to date".
        git(['push', 'origin', `${sourceCommit}:refs/heads/${subject.branch}`], root);
      }
    }
  }), /retained locally but push failed/);

  const pending = await readPendingPublication(root, subject);
  assert.equal(pending.record.expectedRemoteSha, null);
  assert.equal(pending.record.pushOutcome, 'rejected');
  assert.equal(git(['--git-dir', remote, 'rev-parse', `refs/heads/${subject.branch}`], root), pending.record.commit);

  await assert.rejects(
    () => syncPublication(
      root,
      { git: { remote: 'origin' }, ledger: { enabled: false } },
      storyFor(subject)
    ),
    /Push still fails: Remote branch 'STORY-CREATE-ONLY' already exists/
  );
  assert.ok(await readPendingPublication(root, subject), 'known collision receipt is retained');

  const retained = await readPendingPublication(root, subject);
  const raw = JSON.parse(await readFile(retained.path, 'utf8'));
  raw.pushOutcome = 'transport-indeterminate';
  await writeFile(retained.path, `${JSON.stringify(raw, null, 2)}\n`);
  await assert.rejects(
    () => syncPublication(
      root,
      { git: { remote: 'origin' }, ledger: { enabled: false } },
      storyFor(subject)
    ),
    /Push still fails: Remote branch 'STORY-CREATE-ONLY' already exists/
  );
  assert.ok(await readPendingPublication(root, subject), 'tampered outcome cannot authorize equality');
});

test('a non-null Story lease cannot claim another actor identical update', async () => {
  const root = await repository('sflow-story-update-cas-');
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-update-origin-'));
  git(['init', '--bare', '-q'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  const expectedRemoteSha = git(['rev-parse', 'HEAD'], root);
  const subject = { kind: 'story', id: 'STORY-UPDATE-CAS', branch: 'main' };
  const target = 'story-state.json';

  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),
    commit: { message: '[STORY-UPDATE-CAS][intake] publish governed state' },
    publication: {
      mode: 'required', branch: subject.branch, remote: 'origin', expectedRemoteSha
    },
    allowedPaths: [target],
    state: { write: () => writeFile(path.join(root, target), '{"status":"ready"}\n') },
    fault: (stage, { sourceCommit } = {}) => {
      if (stage === 'after-commit') {
        // Another actor wins the old->new transition with the exact object this transaction made.
        // Git reports our subsequent leased push as "up to date" unless porcelain ownership is
        // checked for non-null leases too.
        git(['push', 'origin', `${sourceCommit}:refs/heads/main`], root);
      }
    }
  }), /retained locally but push failed/);

  const pending = await readPendingPublication(root, subject);
  assert.equal(pending.record.expectedRemoteSha, expectedRemoteSha);
  assert.equal(pending.record.pushOutcome, 'rejected');
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), pending.record.commit);
  await assert.rejects(
    () => syncPublication(
      root,
      { git: { remote: 'origin' }, ledger: { enabled: false } },
      storyFor(subject)
    ),
    /did not move from the explicitly leased commit/
  );
  assert.ok(await readPendingPublication(root, subject), 'known non-null collision is retained');
});

test('publication uses its captured authority across remote-name and URL-rewrite races', async () => {
  const root = await repository('sflow-publication-authority-race-');
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-publication-authority-origin-'));
  const alternate = await mkdtemp(path.join(os.tmpdir(), 'sflow-publication-authority-alternate-'));
  git(['init', '--bare', '-q'], remote);
  git(['init', '--bare', '-q'], alternate);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  const expectedRemoteSha = git(['rev-parse', 'HEAD'], root);
  const subject = { kind: 'story', id: 'STORY-AUTHORITY-RACE', branch: 'main' };

  const result = await new GitPublicationUnitOfWork(root).execute({
    subject,
    event: lifecycleEvent({ type: 'binding', subject }),
    commit: { message: '[STORY-AUTHORITY-RACE] exact authority' },
    publication: {
      mode: 'required', branch: 'main', remote: 'origin', expectedRemoteSha
    },
    allowedPaths: ['story-state.json'],
    state: { write: () => writeFile(path.join(root, 'story-state.json'), '{"status":"ready"}\n') },
    fault: (stage) => {
      if (stage === 'after-commit') {
        git(['remote', 'set-url', 'origin', alternate], root);
        // Git reapplies url.* rewrites to literal arguments. Without the invocation-local frozen
        // alias, this rule redirects the already captured path even though no remote name is used.
        git(['config', `url.${alternate}.insteadOf`, remote], root);
      }
    }
  });

  assert.equal(result.pushed, true);
  assert.equal(
    git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), result.sha,
    'the authority captured before the transaction received the governed commit'
  );
  assert.equal(spawnSync('git', [
    '--git-dir', alternate, 'show-ref', '--verify', '--quiet', 'refs/heads/main'
  ]).status, 1, 'the retargeted remote name received nothing');
});

test('Story sync accepts exact remote equality only after an indeterminate push transport', async () => {
  const root = await repository('sflow-story-indeterminate-cas-');
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-indeterminate-origin-'));
  git(['init', '--bare', '-q'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  git(['switch', '-c', 'STORY-INDETERMINATE'], root);
  const subject = { kind: 'story', id: 'STORY-INDETERMINATE', branch: 'STORY-INDETERMINATE' };
  const target = 'story-state.json';
  const hook = path.join(remote, 'hooks/post-receive');
  // Leave enough time for receive-pack to install the ref even when this file runs beside the
  // other Git-heavy fault suites. The much longer post-receive delay still guarantees that the
  // client crosses its timeout boundary only after the authoritative ref update.
  await writeFile(hook, '#!/bin/sh\nsleep 10\n');
  await chmod(hook, 0o755);
  const previousTimeout = process.env.SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS;
  let conflictCalls = 0;
  process.env.SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS = '2000';
  try {
    await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
      subject,
      event: lifecycleEvent({ type: 'binding', subject }),
      commit: { message: '[STORY-INDETERMINATE][init] start governed Story workflow' },
      publication: {
        mode: 'required', branch: subject.branch, remote: 'origin', expectedRemoteSha: null
      },
      conflictStrategy: () => {
        conflictCalls += 1;
        throw new Error('an indeterminate transport must never enter local replay');
      },
      allowedPaths: [target],
      state: { write: () => writeFile(path.join(root, target), '{"status":"ready"}\n') }
    }), /retained locally but push failed/);
  } finally {
    if (previousTimeout === undefined) delete process.env.SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS;
    else process.env.SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS = previousTimeout;
  }

  const pending = await readPendingPublication(root, subject);
  assert.equal(conflictCalls, 0);
  assert.equal(pending.record.pushOutcome, 'transport-indeterminate');
  assert.equal(pending.record.expectedRemoteSha, null);
  // The ref is updated before post-receive runs. Give the timed-out local transport's server-side
  // hook time to finish, then remove the artificial delay from the recovery probe.
  await waitForRemoteRef(remote, `refs/heads/${subject.branch}`, pending.record.commit);
  await writeFile(hook, '#!/bin/sh\nexit 0\n');
  assert.equal(git(['--git-dir', remote, 'rev-parse', `refs/heads/${subject.branch}`], root), pending.record.commit);

  const synced = await syncPublication(
    root,
    { git: { remote: 'origin' }, ledger: { enabled: false } },
    storyFor(subject)
  );
  assert.equal(synced.pushed, pending.record.commit);
  assert.equal(await readPendingPublication(root, subject), null);
});

test('Story sync durably recovers a crash after its root retry reached receive-pack', async () => {
  const fixture = await retainedPublication('story', 'STORY-SYNC-ROOT-CRASH');
  const { root, remote, subject, marker } = fixture;
  assert.equal(marker.pushOutcome, 'rejected');

  await assert.rejects(
    () => syncPublication(
      root,
      { git: { remote: 'origin' }, ledger: { enabled: false } },
      storyFor(subject),
      {
        fault: (stage) => {
          if (stage === 'after-root-push-before-receipt') {
            throw new Error('simulated hard crash after root receive-pack');
          }
        }
      }
    ),
    /simulated hard crash/
  );

  const interrupted = await readPendingPublication(root, subject);
  assert.equal(interrupted.record.pushOutcome, 'transport-indeterminate');
  assert.notEqual(interrupted.record.rootPublished, true);
  assert.equal(
    git(['--git-dir', remote, 'rev-parse', `refs/heads/${subject.branch}`], root),
    marker.commit
  );

  const recovered = await syncPublication(
    root,
    { git: { remote: 'origin' }, ledger: { enabled: false } },
    storyFor(subject)
  );
  assert.equal(recovered.pushed, marker.commit);
  assert.equal(await readPendingPublication(root, subject), null);
});

test('a hard crash after the root push retains the complete authenticated sibling plan', async () => {
  const fixture = await capabilityTailFixture('STORY-TAIL-ROOT-CRASH');
  const publicationModuleUrl = JSON.stringify(publicationModule);
  const eventModuleUrl = JSON.stringify(eventModule);
  const script = [
    `import { writeFile } from 'node:fs/promises';`,
    `import { GitPublicationUnitOfWork } from ${publicationModuleUrl};`,
    `import { lifecycleEvent } from ${eventModuleUrl};`,
    `const fixture = ${JSON.stringify({
      root: fixture.root,
      subject: fixture.subject,
      event: fixture.event,
      target: fixture.target,
      pendingMetadata: fixture.pendingMetadata
    })};`,
    `await new GitPublicationUnitOfWork(fixture.root).execute({`,
    `  subject: fixture.subject, event: fixture.event,`,
    `  commit: { message: '[STORY-TAIL-ROOT-CRASH][init] start governed Story workflow' },`,
    `  publication: { mode: 'required', branch: fixture.subject.branch, remote: 'origin', expectedRemoteSha: null },`,
    `  allowedPaths: [fixture.target],`,
    `  state: { write: () => writeFile(fixture.root + '/' + fixture.target, '{"status":"ready"}\\n') },`,
    `  pendingMetadata: fixture.pendingMetadata, retainPendingOnSuccess: true,`,
    `  fault: (stage) => { if (stage === 'after-push-before-pending-retention') process.exit(77); }`,
    `});`
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: packageRoot, encoding: 'utf8'
  });
  assert.equal(child.status, 77, child.stderr);

  const pending = await readPendingPublication(fixture.root, fixture.subject);
  assert.notEqual(pending.record.rootPublished, true);
  assert.deepEqual(pending.record.capabilityPublicationPlan, [fixture.entry]);
  assert.deepEqual(pending.record.capabilityPublications, [fixture.entry]);
  assert.equal(
    git(['--git-dir', fixture.remote, 'rev-parse', `refs/heads/${fixture.subject.id}`], fixture.root),
    pending.record.commit
  );

  const synced = await syncPublication(
    fixture.root,
    { git: { remote: 'origin' }, ledger: { enabled: false } },
    storyFor(fixture.subject)
  );
  assert.equal(synced.capabilityPublished.length, 1);
  assert.equal(await readPendingPublication(fixture.root, fixture.subject), null);
});

test('a post-receive hard crash recovers only the exact in-flight sibling ref', async () => {
  const fixture = await capabilityTailFixture('STORY-TAIL-SIBLING-CRASH');
  const publication = await publishCapabilityTailRoot(fixture);
  const hook = path.join(fixture.siblingRemote, 'hooks/post-receive');
  await writeFile(hook, '#!/bin/sh\nkill -KILL "$SFLOW_TEST_CLIENT_PID"\nexit 0\n');
  await chmod(hook, 0o755);
  const recoveryModuleUrl = pathToFileURL(
    path.join(packageRoot, 'src/capability-publication-recovery.mjs')
  ).href;
  const childScript = [
    `import { publishCapabilityRepositoriesDurably } from ${JSON.stringify(recoveryModuleUrl)};`,
    `process.env.SFLOW_TEST_CLIENT_PID = String(process.pid);`,
    `await publishCapabilityRepositoriesDurably(`,
    `  ${JSON.stringify(fixture.root)}, ${JSON.stringify(fixture.subject.id)},`,
    `  ${JSON.stringify({
      remote: 'origin', branch: fixture.subject.branch, commit: publication.sha, event: publication.event
    })},`,
    `  ${JSON.stringify([fixture.entry])}, { rootPublished: true }`,
    `);`
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
    cwd: packageRoot, encoding: 'utf8'
  });
  assert.equal(child.signal, 'SIGKILL', child.stderr);

  const pending = await readPendingPublication(fixture.root, fixture.subject);
  assert.equal(pending.record.capabilityPublications[0].pushOutcome, 'transport-indeterminate');
  assert.equal(
    git(['--git-dir', fixture.siblingRemote, 'rev-parse', `refs/heads/${fixture.subject.id}`], fixture.sibling),
    fixture.entry.commit
  );
  await writeFile(hook, '#!/bin/sh\nexit 0\n');

  const synced = await syncPublication(
    fixture.root,
    { git: { remote: 'origin' }, ledger: { enabled: false } },
    storyFor(fixture.subject)
  );
  assert.equal(synced.capabilityPublished[0].reconciled, true);
  assert.equal(await readPendingPublication(fixture.root, fixture.subject), null);
});

test('Story sync rejects tampering with every sibling publication authority field', async (t) => {
  const fixture = await capabilityTailFixture('STORY-TAIL-TAMPER');
  await publishCapabilityTailRoot(fixture);
  const original = (await readPendingPublication(fixture.root, fixture.subject)).record;
  const mutations = {
    schemaVersion: 2,
    repository: 'other-sibling',
    root: `${fixture.entry.root}-other`,
    remote: 'upstream',
    branch: 'OTHER-STORY',
    commit: `${fixture.entry.commit.slice(0, -1)}${fixture.entry.commit.endsWith('0') ? '1' : '0'}`,
    destinationRef: 'refs/heads/OTHER-STORY',
    expectedRemoteSha: '0'.repeat(40),
    pushOutcome: 'published'
  };
  for (const [field, value] of Object.entries(mutations)) {
    await t.test(field, async () => {
      const changed = structuredClone(original);
      changed.capabilityPublications[0][field] = value;
      await writePendingPublication(fixture.root, { ...fixture.subject, record: changed });
      await assert.rejects(
        () => syncPublication(
          fixture.root,
          { git: { remote: 'origin' }, ledger: { enabled: false } },
          storyFor(fixture.subject)
        ),
        (error) => error?.code === 'PENDING_CAPABILITY_PUBLICATION_IDENTITY_INVALID'
      );
      assert.equal(
        spawnSync('git', [
          '--git-dir', fixture.siblingRemote, 'show-ref', '--verify', '--quiet',
          `refs/heads/${fixture.subject.id}`
        ]).status,
        1,
        `tampering with ${field} moved the sibling ref`
      );
    });
  }
  await writePendingPublication(fixture.root, { ...fixture.subject, record: original });
});

test('signed progress cannot omit an unproven sibling publication', async (t) => {
  for (const [label, siblingCount, pendingCount] of [
    ['empty', 1, 0],
    ['subset', 2, 1]
  ]) {
    await t.test(label, async () => {
      const fixture = await capabilityTailFixture(`STORY-TAIL-OMIT-${label.toUpperCase()}`, { siblingCount });
      await publishCapabilityTailRoot(fixture);
      const current = await readPendingPublication(fixture.root, fixture.subject);
      const changed = structuredClone(current.record);
      changed.capabilityPublications = changed.capabilityPublications.slice(0, pendingCount);
      // Use the engine writer so this is a structurally valid receipt. Recovery must still prove
      // every omitted destination ref rather than trusting a shorter list.
      await writePendingPublication(fixture.root, { ...fixture.subject, record: changed });
      await assert.rejects(
        () => syncPublication(
          fixture.root,
          { git: { remote: 'origin' }, ledger: { enabled: false } },
          storyFor(fixture.subject)
        ),
        (error) => error?.code === 'PENDING_CAPABILITY_PUBLICATION_IDENTITY_INVALID'
      );
      for (let index = 0; index < siblingCount; index += 1) {
        assert.equal(spawnSync('git', [
          '--git-dir', fixture.siblingRemotes[index], 'show-ref', '--verify', '--quiet',
          `refs/heads/${fixture.subject.id}`
        ]).status, 1);
      }
    });
  }
});

test('tampering rejected sibling progress into indeterminate cannot claim an identical ref', async () => {
  const fixture = await capabilityTailFixture('STORY-TAIL-OUTCOME-TAMPER');
  await publishCapabilityTailRoot(fixture);
  const allowPushes = await rejectPushes(fixture.siblingRemote);
  const rejected = await publishCapabilityRepositoriesDurably(
    fixture.root, fixture.subject.id,
    {
      remote: 'origin', branch: fixture.subject.branch,
      commit: git(['rev-parse', 'HEAD'], fixture.root), event: fixture.event
    }, fixture.entries, { rootPublished: true }
  );
  assert.equal(rejected.pending[0].pushOutcome, 'rejected');
  await allowPushes();
  git(['push', 'origin', `${fixture.entry.commit}:refs/heads/${fixture.subject.id}`], fixture.sibling);

  const pending = await readPendingPublication(fixture.root, fixture.subject);
  const raw = JSON.parse(await readFile(pending.path, 'utf8'));
  raw.capabilityPublications[0].pushOutcome = 'transport-indeterminate';
  await writeFile(pending.path, `${JSON.stringify(raw, null, 2)}\n`);
  await assert.rejects(
    () => syncPublication(
      fixture.root,
      { git: { remote: 'origin' }, ledger: { enabled: false } },
      storyFor(fixture.subject)
    ),
    (error) => error?.code === 'PENDING_CAPABILITY_PUBLICATION_IDENTITY_INVALID'
  );
  assert.ok(await readPendingPublication(fixture.root, fixture.subject));
});

test('a retargeted root or sibling remote receives no pending Story commit', async (t) => {
  await t.test('root', async () => {
    const fixture = await retainedPublication('story', 'STORY-ROOT-REMOTE-RETARGET');
    const alternate = await mkdtemp(path.join(os.tmpdir(), 'sflow-root-retarget-alternate-'));
    git(['init', '--bare', '-q'], alternate);
    git(['remote', 'set-url', 'origin', alternate], fixture.root);
    await assert.rejects(
      () => syncPublication(
        fixture.root,
        { git: { remote: 'origin' }, ledger: { enabled: false } },
        storyFor(fixture.subject)
      ),
      (error) => error?.code === 'PENDING_PUBLICATION_REMOTE_CHANGED'
    );
    assert.equal(spawnSync('git', [
      '--git-dir', alternate, 'show-ref', '--verify', '--quiet', 'refs/heads/main'
    ]).status, 1);
  });

  await t.test('sibling', async () => {
    const fixture = await capabilityTailFixture('STORY-SIBLING-REMOTE-RETARGET');
    await publishCapabilityTailRoot(fixture);
    const alternate = await mkdtemp(path.join(os.tmpdir(), 'sflow-sibling-retarget-alternate-'));
    git(['init', '--bare', '-q'], alternate);
    git(['remote', 'set-url', 'origin', alternate], fixture.sibling);
    await assert.rejects(
      () => syncPublication(
        fixture.root,
        { git: { remote: 'origin' }, ledger: { enabled: false } },
        storyFor(fixture.subject)
      ),
      (error) => error?.code === 'PENDING_CAPABILITY_PUBLICATION_IDENTITY_INVALID'
    );
    assert.equal(spawnSync('git', [
      '--git-dir', alternate, 'show-ref', '--verify', '--quiet',
      `refs/heads/${fixture.subject.id}`
    ]).status, 1);
  });

  await t.test('literal local-path suffix', async () => {
    const root = await repository('sflow-root-retarget-literal-suffix-');
    const authorities = await mkdtemp(path.join(os.tmpdir(), 'sflow-literal-authorities-'));
    const original = path.join(authorities, 'authority?blue.git');
    const alternate = path.join(authorities, 'authority');
    git(['init', '--bare', '-q', original], root);
    git(['init', '--bare', '-q', alternate], root);
    git(['remote', 'add', 'origin', original], root);
    git(['push', '-u', 'origin', 'main'], root);
    git(['switch', '-c', 'STORY-LITERAL-REMOTE'], root);
    const allowPushes = await rejectPushes(original);
    const subject = { kind: 'story', id: 'STORY-LITERAL-REMOTE', branch: 'STORY-LITERAL-REMOTE' };
    await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
      subject,
      event: lifecycleEvent({ type: 'binding', subject }),
      commit: { message: '[STORY-LITERAL-REMOTE][init] start governed Story workflow' },
      publication: { mode: 'required', branch: subject.branch, remote: 'origin', expectedRemoteSha: null },
      allowedPaths: ['story-state.json'],
      state: { write: () => writeFile(path.join(root, 'story-state.json'), '{"status":"ready"}\n') }
    }), /retained locally but push failed/);
    await allowPushes();
    git(['remote', 'set-url', 'origin', alternate], root);
    await assert.rejects(
      () => syncPublication(
        root, { git: { remote: 'origin' }, ledger: { enabled: false } }, storyFor(subject)
      ),
      (error) => error?.code === 'PENDING_PUBLICATION_REMOTE_CHANGED'
    );
    assert.equal(spawnSync('git', [
      '--git-dir', alternate, 'show-ref', '--verify', '--quiet', `refs/heads/${subject.id}`
    ]).status, 1);
  });
});

test('rootPublished cannot skip an unpublished exact root ref', async () => {
  const fixture = await retainedPublication('story', 'STORY-ROOT-PUBLISHED-TAMPER');
  const pending = await readPendingPublication(fixture.root, fixture.subject);
  await writePendingPublication(fixture.root, {
    ...fixture.subject,
    record: { ...pending.record, rootPublished: true }
  });
  await assert.rejects(
    () => syncPublication(
      fixture.root,
      { git: { remote: 'origin' }, ledger: { enabled: false } },
      storyFor(fixture.subject)
    ),
    (error) => error?.code === 'PENDING_PUBLICATION_ROOT_UNPROVEN'
  );
  assert.ok(await readPendingPublication(fixture.root, fixture.subject));
});

test('raw rootPublished progress cannot claim an exact Story or Initiative ref', async (t) => {
  for (const kind of ['story', 'initiative']) {
    await t.test(kind, async () => {
      const fixture = await retainedPublication(kind, `${kind.toUpperCase()}-RAW-ROOT-PUBLISHED`, {
        exactLease: true
      });
      git(['push', 'origin', `${fixture.marker.commit}:refs/heads/main`], fixture.root);

      const pending = await readPendingPublication(fixture.root, fixture.subject);
      const raw = JSON.parse(await readFile(pending.path, 'utf8'));
      raw.rootPublished = true;
      await writeFile(pending.path, `${JSON.stringify(raw, null, 2)}\n`);

      const sync = kind === 'story'
        ? () => syncPublication(
          fixture.root,
          { git: { remote: 'origin' }, ledger: { enabled: false } },
          storyFor(fixture.subject)
        )
        : () => syncInitiativePublication(
          fixture.root, { git: { remote: 'origin' } }, initiativeFor(fixture.subject)
        );
      await assert.rejects(
        sync,
        (error) => error?.code === 'PENDING_PUBLICATION_PROGRESS_INTEGRITY_INVALID'
      );
      const retained = await readPendingPublication(fixture.root, fixture.subject);
      assert.equal(retained.integrityVerified, false);
      assert.equal(retained.record.rootPublished, true);
    });
  }
});

test('Initiative sync rejects a mismatched marker and retries only its verified exact commit', async () => {
  const fixture = await retainedPublication('initiative', 'INIT-MARKER-MISMATCH', {
    exactLease: true
  });
  const { root, remote, remoteBaseline, subject, marker } = fixture;
  const changed = structuredClone(marker);
  changed.stateSha256 = `${changed.stateSha256.slice(0, -1)}${changed.stateSha256.endsWith('0') ? '1' : '0'}`;
  await writePendingPublication(root, { ...subject, record: changed });

  await assert.rejects(
    () => syncInitiativePublication(root, { git: { remote: 'origin' } }, initiativeFor(subject)),
    (error) => error?.code === 'PENDING_PUBLICATION_IDENTITY_INVALID'
  );
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), remoteBaseline);
  assert.ok(await readPendingPublication(root, subject));

  await writePendingPublication(root, { ...subject, record: marker });
  const synced = await syncInitiativePublication(
    root,
    { git: { remote: 'origin' } },
    initiativeFor(subject)
  );
  assert.equal(synced.pushed, marker.commit);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), marker.commit);
  assert.equal(await readPendingPublication(root, subject), null);
});

test('Initiative sync refuses a retargeted configured remote before retrying publication', async () => {
  const fixture = await retainedPublication('initiative', 'INIT-REMOTE-RETARGET');
  const alternate = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-retarget-alternate-'));
  git(['init', '--bare', '-q'], alternate);
  git(['remote', 'set-url', 'origin', alternate], fixture.root);

  await assert.rejects(
    () => syncInitiativePublication(
      fixture.root, { git: { remote: 'origin' } }, initiativeFor(fixture.subject)
    ),
    (error) => error?.code === 'PENDING_PUBLICATION_REMOTE_CHANGED'
  );
  assert.equal(spawnSync('git', [
    '--git-dir', alternate, 'show-ref', '--verify', '--quiet', 'refs/heads/main'
  ]).status, 1, 'the retargeted authority received no ref');
  assert.ok(await readPendingPublication(fixture.root, fixture.subject), 'the sealed marker remains');
});

test('Story and Initiative recovery keep their captured authority through a remote-name race', async (t) => {
  for (const kind of ['story', 'initiative']) {
    await t.test(kind, async () => {
      const fixture = await retainedPublication(kind, `${kind.toUpperCase()}-RECOVERY-AUTHORITY-RACE`, {
        exactLease: true
      });
      const alternate = await mkdtemp(path.join(os.tmpdir(), `sflow-${kind}-recovery-race-alternate-`));
      git(['init', '--bare', '-q'], alternate);
      let retargeted = false;
      const options = {
        fault: (stage) => {
          if (stage === 'after-root-authority-capture' && !retargeted) {
            retargeted = true;
            git(['remote', 'set-url', 'origin', alternate], fixture.root);
          }
        }
      };
      const result = kind === 'story'
        ? await syncPublication(
          fixture.root,
          { git: { remote: 'origin' }, ledger: { enabled: false } },
          storyFor(fixture.subject),
          options
        )
        : await syncInitiativePublication(
          fixture.root,
          { git: { remote: 'origin' } },
          initiativeFor(fixture.subject),
          options
        );

      assert.equal(result.pushed, fixture.marker.commit);
      assert.equal(
        git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'], fixture.root),
        fixture.marker.commit,
        'the recovery receipt authority received the exact governed commit'
      );
      assert.equal(spawnSync('git', [
        '--git-dir', alternate, 'show-ref', '--verify', '--quiet', 'refs/heads/main'
      ]).status, 1, 'the retargeted remote name received nothing');
      assert.equal(await readPendingPublication(fixture.root, fixture.subject), null);
    });
  }
});

test('Initiative exact-lease recovery cannot claim another actor identical update', async () => {
  const fixture = await retainedPublication('initiative', 'INIT-EXACT-LEASE-COLLISION', {
    exactLease: true
  });
  git(['push', 'origin', `${fixture.marker.commit}:refs/heads/main`], fixture.root);

  await assert.rejects(
    () => syncInitiativePublication(
      fixture.root, { git: { remote: 'origin' } }, initiativeFor(fixture.subject)
    ),
    /did not move from the explicitly leased commit/
  );
  let pending = await readPendingPublication(fixture.root, fixture.subject);
  assert.equal(pending.record.pushOutcome, 'rejected');
  assert.notEqual(pending.record.rootPublished, true);

  const raw = JSON.parse(await readFile(pending.path, 'utf8'));
  raw.pushOutcome = 'transport-indeterminate';
  await writeFile(pending.path, `${JSON.stringify(raw, null, 2)}\n`);
  await assert.rejects(
    () => syncInitiativePublication(
      fixture.root, { git: { remote: 'origin' } }, initiativeFor(fixture.subject)
    ),
    /did not move from the explicitly leased commit/
  );
  pending = await readPendingPublication(fixture.root, fixture.subject);
  assert.equal(pending.integrityVerified, true, 'the definitive rejection is resealed');
  assert.equal(pending.record.pushOutcome, 'rejected', 'raw ambiguity was not laundered');
});

test('a legacy Initiative receipt without an exact lease cannot claim another actor identical update', async () => {
  const fixture = await retainedPublication('initiative', 'INIT-LEGACY-NO-LEASE');
  assert.equal(Object.hasOwn(fixture.marker, 'expectedRemoteSha'), false);
  git(['push', 'origin', `${fixture.marker.commit}:refs/heads/main`], fixture.root);

  await assert.rejects(
    () => syncInitiativePublication(
      fixture.root, { git: { remote: 'origin' } }, initiativeFor(fixture.subject)
    ),
    (error) => error?.code === 'PENDING_PUBLICATION_REMOTE_LEASE_MISSING'
  );
  const pending = await readPendingPublication(fixture.root, fixture.subject);
  assert.equal(pending.record.commit, fixture.marker.commit);
  assert.equal(Object.hasOwn(pending.record, 'expectedRemoteSha'), false);
  assert.notEqual(pending.record.rootPublished, true);
  assert.equal(
    git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'], fixture.root),
    fixture.marker.commit,
    'sync did not move or reclassify the other actor\'s exact ref'
  );
});

test('Initiative recovery survives both post-receive and post-success-marker crashes', async () => {
  const fixture = await retainedPublication('initiative', 'INIT-RECOVERY-CRASH', {
    exactLease: true
  });
  const initiative = initiativeFor(fixture.subject);

  await assert.rejects(
    () => syncInitiativePublication(
      fixture.root, { git: { remote: 'origin' } }, initiative, {
        fault: (stage) => {
          if (stage === 'after-recovery-push') throw new Error('fault:after-recovery-push');
        }
      }
    ),
    /fault:after-recovery-push/
  );
  let pending = await readPendingPublication(fixture.root, fixture.subject);
  assert.equal(pending.integrityVerified, true);
  assert.equal(pending.record.pushOutcome, 'transport-indeterminate');
  assert.notEqual(pending.record.rootPublished, true);
  assert.equal(pending.record.expectedRemoteSha, fixture.remoteBaseline);
  assert.equal(
    git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'], fixture.root),
    pending.record.commit,
    'receive-pack advanced the exact leased ref before the simulated crash'
  );

  await assert.rejects(
    () => syncInitiativePublication(
      fixture.root, { git: { remote: 'origin' } }, initiative, {
        fault: (stage) => {
          if (stage === 'after-root-published') throw new Error('fault:after-root-published');
        }
      }
    ),
    /fault:after-root-published/
  );
  pending = await readPendingPublication(fixture.root, fixture.subject);
  assert.equal(pending.integrityVerified, true);
  assert.equal(pending.record.rootPublished, true);
  assert.equal(pending.record.pushOutcome, 'not-attempted');

  const synced = await syncInitiativePublication(
    fixture.root, { git: { remote: 'origin' } }, initiative
  );
  assert.equal(synced.pushed, pending.record.commit);
  assert.equal(await readPendingPublication(fixture.root, fixture.subject), null);
});

test('capability recovery cannot hide a still-pending Story lifecycle commit', async () => {
  const sibling = await repository('sflow-capability-root-pending-');
  const siblingRemote = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-root-pending-origin-'));
  git(['init', '--bare', '-q'], siblingRemote);
  git(['remote', 'add', 'origin', siblingRemote], sibling);
  git(['push', '-u', 'origin', 'main'], sibling);
  const siblingCommit = git(['rev-parse', 'HEAD'], sibling);
  const siblingPublication = {
    schemaVersion: 1,
    repository: 'sibling',
    root: sibling,
    remote: 'origin',
    branch: 'STORY-ROOT-AND-CAPABILITY',
    commit: siblingCommit,
    destinationRef: 'refs/heads/STORY-ROOT-AND-CAPABILITY',
    remoteFingerprint: configuredRemoteFingerprint(sibling, 'origin'),
    expectedRemoteSha: null,
    pushOutcome: 'not-attempted'
  };
  const fixture = await retainedPublication('story', 'STORY-ROOT-AND-CAPABILITY', {
    eventPayload: {
      capabilityPublicationPlanSha256: capabilityPublicationPlanSha256([siblingPublication])
    }
  });
  const { root, remote, remoteBaseline, subject, marker } = fixture;

  await retainCapabilityPublicationRecovery(root, subject.id, {
    remote: 'origin', branch: 'main', commit: marker.commit, event: marker.event
  }, [siblingPublication], new Error('both lifecycle and capability publication remain pending'));
  const retained = await readPendingPublication(root, subject);
  assert.equal(retained.record.rootPublished, false);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), remoteBaseline);

  const synced = await syncPublication(
    root,
    { git: { remote: 'origin' }, ledger: { enabled: false } },
    storyFor(subject)
  );
  assert.equal(synced.pushed, marker.commit);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), marker.commit);
  assert.equal(git(['--git-dir', siblingRemote, 'rev-parse', `refs/heads/${subject.id}`], sibling), siblingCommit);
  assert.equal(await readPendingPublication(root, subject), null);
});

test('push-failure recovery binds a finalized event digest to its exact governed commit', async () => {
  const root = await repository('sflow-finalized-event-push-failure-');
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-finalized-event-origin-'));
  git(['init', '--bare', '-q'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  const subject = { kind: 'story', id: 'FINALIZED-EVENT', branch: 'main' };
  const target = 'story-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', 'canonical finalized-event state'], root);
  git(['push', 'origin', 'main'], root);
  const original = lifecycleEvent({
    type: 'artifact-generated', subject, phaseId: 'intake', generation: 1,
    payload: { documentId: null }
  });
  const finalized = {
    ...original,
    actor: { name: 'Allocated Reviewer', email: 'reviewer@example.test' },
    payload: { documentId: 'DOC-0001' }
  };
  const originalSha256 = `sha256:${recordSha256(original)}`;
  const allowPushes = await rejectPushes(remote);

  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    event: original,
    commit: { message: '[FINALIZED-EVENT] bind finalized result' },
    publication: { mode: 'required', branch: 'main', remote: 'origin' },
    allowedPaths: [target],
    state: {
      write: async () => {
        await writeFile(path.join(root, target), '{"status":"finalized"}\n');
        return { event: finalized };
      }
    }
  }), /retained locally but push failed/);

  const pending = await readPendingPublication(root, subject);
  const marker = pending.record;
  const transactionEvent = {
    ...marker.event,
    // These three values are derived from the commit after its transaction digest is sealed. The
    // trailer and marker bind the canonical finalized event with those transport bindings cleared.
    sourceCommit: null,
    idempotencyKey: null,
    idempotencyHash: null
  };
  const finalizedSha256 = `sha256:${recordSha256(transactionEvent)}`;
  const commitIdentity = governedCommitIdentity(root, marker.commit);
  assert.notEqual(finalizedSha256, originalSha256, 'the fixture did not finalize the event');
  assert.equal(marker.event.actor.email, 'reviewer@example.test');
  assert.equal(marker.event.payload.documentId, 'DOC-0001');
  assert.equal(marker.eventSha256, finalizedSha256);
  assert.equal(marker.eventSha256, commitIdentity.eventSha256);

  await allowPushes();
  const synced = await syncPublication(root, {
    git: { remote: 'origin' }, ledger: { enabled: false }
  }, {
    workItem: { id: subject.id, branch: 'main' },
    lineage: { canonicalBranch: 'main', childBranches: [] },
    resolution: { ledger: { enabled: false } }
  });
  assert.equal(synced.pushed, marker.commit);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root), marker.commit);
  assert.equal(await readPendingPublication(root, subject), null);
});

test('abrupt process death leaves the same recoverable boundary for Story and Initiative', async (t) => {
  for (const kind of kinds) {
    for (const stage of stages) {
      await t.test(`${kind}/${stage}`, async () => {
        const root = await repository(`sflow-kill-${kind}-${stage}-`);
        const subject = { kind, id: `${kind.toUpperCase()}-KILL-${stage}`, branch: 'main' };
        const target = `${kind}-state.json`;
        const prior = `${JSON.stringify({ status: 'before' })}\n`;
        await writeFile(path.join(root, target), prior);
        git(['add', target], root);
        git(['commit', '-m', 'canonical state'], root);
        const canonical = git(['rev-parse', 'HEAD'], root);
        const script = [
          `import { writeFile } from 'node:fs/promises';`,
          `import { GitPublicationUnitOfWork } from ${JSON.stringify(publicationModule)};`,
          `import { lifecycleEvent } from ${JSON.stringify(eventModule)};`,
          `const root = ${JSON.stringify(root)};`,
          `const subject = ${JSON.stringify(subject)};`,
          `const target = ${JSON.stringify(target)};`,
          `const event = lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 });`,
          `await new GitPublicationUnitOfWork(root).execute({`,
          `  subject, event, commit: { message: '[${subject.id}] killed at ${stage}' },`,
          `  publication: { mode: 'off', branch: 'main' }, allowedPaths: [target],`,
          `  state: { write: () => writeFile(root + '/' + target, ${JSON.stringify(`${JSON.stringify({ status: stage })}\n`)}) },`,
          `  fault: (current) => { if (current === ${JSON.stringify(stage)}) process.exit(73); }`,
          `});`
        ].join('\n');
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
          cwd: packageRoot, encoding: 'utf8'
        });
        assert.equal(child.status, 73, child.stderr);
        assert.equal(await readFile(path.join(root, target), 'utf8'),
          `${JSON.stringify({ status: stage })}\n`);

        const after = git(['rev-parse', 'HEAD'], root);
        if (stage === 'after-state-write') {
          assert.equal(after, canonical, `${kind} died before the commit boundary`);
          assert.match(git(['status', '--porcelain'], root), new RegExp(target),
            `${kind} exposes the interrupted pre-commit state for repair`);
        } else {
          assert.notEqual(after, canonical, `${kind} retained the atomic local commit`);
          assert.equal(git(['status', '--porcelain'], root), '', `${kind} committed a clean tree`);
        }

        // The killed owner is never treated as live. Recovery takes the subject lock and can now
        // inspect either the dirty pre-commit state or the completed local commit.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const owner = await acquireSubjectLock(root, subject, { ttlMs: 0 });
        assert.equal(await releaseSubjectLock(root, subject, owner), true);
      });
    }
  }
});

test('prewritten journals make hard process death discoverable before and after ref advancement', async (t) => {
  for (const kind of kinds) {
    for (const stage of ['after-state-write', 'after-ref-update']) {
      await t.test(`${kind}/${stage}`, async () => {
        const root = await repository(`sflow-journal-kill-${kind}-${stage}-`);
        const subject = { kind, id: `${kind.toUpperCase()}-JOURNAL-${stage}`, branch: 'main' };
        const target = `${kind}-state.json`;
        await writeFile(path.join(root, target), '{"status":"before"}\n');
        git(['add', target], root);
        git(['commit', '-m', 'canonical state'], root);
        const canonical = git(['rev-parse', 'HEAD'], root);
        await ensurePublicationOrigin(root);
        const script = [
          `import { writeFile } from 'node:fs/promises';`,
          `import { GitPublicationUnitOfWork } from ${JSON.stringify(publicationModule)};`,
          `import { lifecycleEvent } from ${JSON.stringify(eventModule)};`,
          `const root = ${JSON.stringify(root)};`,
          `const subject = ${JSON.stringify(subject)};`,
          `const target = ${JSON.stringify(target)};`,
          `await new GitPublicationUnitOfWork(root).execute({`,
          `  subject,`,
          `  event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),`,
          `  commit: { message: '[${subject.id}] crash journal' },`,
          `  publication: { mode: 'required', branch: 'main', remote: 'origin' },`,
          `  allowedPaths: [target],`,
          `  state: { write: () => writeFile(root + '/' + target, '{"status":"interrupted"}\\n') },`,
          `  fault: (current) => { if (current === ${JSON.stringify(stage)}) process.exit(73); }`,
          `});`
        ].join('\n');

        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
          cwd: packageRoot, encoding: 'utf8'
        });
        assert.equal(child.status, 73, child.stderr);
        assert.equal(await pathExists(publicationJournalPath(root, kind, subject.id)), true);

        const current = git(['rev-parse', 'HEAD'], root);
        const pending = await readPendingPublication(root, subject);
        if (stage === 'after-state-write') {
          assert.equal(current, canonical);
          assert.equal(pending.record.commit, null);
          assert.equal(pending.record.recoveryStage, 'interrupted-before-branch-ref-advanced');
          assert.equal(pending.journal, true);
          assert.equal(await pathExists(publicationJournalPath(root, kind, subject.id)), true);
        } else {
          assert.notEqual(current, canonical);
          assert.equal(pending.record.commit, current);
          assert.equal(pending.record.recoveryStage, 'branch-ref-advanced-before-publication');
          assert.equal(pending.record.event.sourceCommit, current);
          assert.equal(pending.migrated, true);
          assert.equal(await pathExists(publicationJournalPath(root, kind, subject.id)), false);
        }
      });
    }
  }
});

test('recovery refuses every advanced HEAD that is not the exact transaction commit', async (t) => {
  for (const pushed of [false, true]) {
    await t.test(pushed ? 'unrelated pushed commit' : 'unrelated local commit', async () => {
      const root = await repository(`sflow-diverged-${pushed ? 'pushed' : 'local'}-`);
      if (pushed) {
        const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-diverged-origin-'));
        git(['init', '--bare', '-q'], remote);
        git(['remote', 'add', 'origin', remote], root);
        git(['push', '-u', 'origin', 'main'], root);
      }
      const subject = { kind: 'story', id: `DIVERGED-${pushed ? 'PUSHED' : 'LOCAL'}`, branch: 'main' };
      const target = 'story-state.json';
      await writeFile(path.join(root, target), '{"status":"before"}\n');
      git(['add', target], root);
      git(['commit', '-m', 'canonical state'], root);
      await crashPublication(root, subject, target, 'after-state-write');

      await writeFile(path.join(root, 'manual.txt'), 'unrelated\n');
      git(['add', 'manual.txt'], root);
      git(['commit', '-m', 'manual unrelated commit'], root);
      if (pushed) git(['push', 'origin', 'main'], root);

      const pending = await readPendingPublication(root, subject);
      assert.equal(pending.record.code, 'PUBLICATION_RECOVERY_DIVERGED');
      assert.equal(pending.record.recoveryStage, 'publication-recovery-diverged');
      assert.equal(pending.journalRecord.commit, null);
      assert.equal(await pathExists(publicationJournalPath(root, subject.kind, subject.id)), true);
    });
  }

  await t.test('checkout switched to another branch', async () => {
    const root = await repository('sflow-diverged-branch-');
    const subject = { kind: 'story', id: 'DIVERGED-BRANCH', branch: 'main' };
    const target = 'story-state.json';
    await writeFile(path.join(root, target), '{"status":"before"}\n');
    git(['add', target], root);
    git(['commit', '-m', 'canonical state'], root);
    await crashPublication(root, subject, target, 'after-state-write');
    git(['switch', '-c', 'other'], root);
    const pending = await readPendingPublication(root, subject);
    assert.equal(pending.record.code, 'PUBLICATION_RECOVERY_DIVERGED');
    assert.match(pending.record.error, /checkout is on branch 'other'/);
    assert.equal(await pathExists(publicationJournalPath(root, subject.kind, subject.id)), true);
  });

  await t.test('advanced HEAD is merely an ancestor of the remote branch', async () => {
    const root = await repository('sflow-diverged-remote-ancestor-');
    const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-diverged-ancestor-origin-'));
    git(['init', '--bare', '-q'], remote);
    git(['remote', 'add', 'origin', remote], root);
    git(['push', '-u', 'origin', 'main'], root);
    const subject = { kind: 'story', id: 'DIVERGED-ANCESTOR', branch: 'main' };
    const target = 'story-state.json';
    await writeFile(path.join(root, target), '{"status":"before"}\n');
    git(['add', target], root);
    git(['commit', '-m', 'canonical state'], root);
    git(['push', 'origin', 'main'], root);
    await crashPublication(root, subject, target, 'after-state-write');
    await writeFile(path.join(root, 'manual.txt'), 'one\n');
    git(['add', 'manual.txt'], root);
    git(['commit', '-m', 'manual B'], root);
    const manualB = git(['rev-parse', 'HEAD'], root);
    await writeFile(path.join(root, 'manual-2.txt'), 'two\n');
    git(['add', 'manual-2.txt'], root);
    git(['commit', '-m', 'manual C'], root);
    git(['push', 'origin', 'main'], root);
    git(['reset', '--hard', manualB], root);
    const pending = await readPendingPublication(root, subject);
    assert.equal(pending.record.code, 'PUBLICATION_RECOVERY_DIVERGED');
    assert.equal(await pathExists(publicationJournalPath(root, subject.kind, subject.id)), true);
  });
});

test('transaction recovery verifies mode, tree, and event identity', async (t) => {
  await t.test('mode off never creates a remote-push marker', async () => {
    const root = await repository('sflow-mode-off-recovery-');
    const subject = { kind: 'story', id: 'MODE-OFF', branch: 'main' };
    const target = 'story-state.json';
    await writeFile(path.join(root, target), '{"status":"before"}\n');
    git(['add', target], root);
    git(['commit', '-m', 'canonical state'], root);
    await crashPublication(root, subject, target, 'after-ref-update', { mode: 'off' });
    assert.equal(await readPendingPublication(root, subject), null);
    assert.equal(await pathExists(publicationJournalPath(root, subject.kind, subject.id)), false);
    assert.equal(await pathExists(path.join(root, '.git', 'singularity-flow', 'pending-publication', 'story--MODE-OFF.json')), false);
  });

  await t.test('same-tree different commit is not accepted', async () => {
    const root = await repository('sflow-same-tree-identity-');
    const subject = { kind: 'story', id: 'SAME-TREE', branch: 'main' };
    const target = 'story-state.json';
    await writeFile(path.join(root, target), '{"status":"before"}\n');
    git(['add', target], root);
    git(['commit', '-m', 'canonical state'], root);
    const expectedHead = git(['rev-parse', 'HEAD'], root);
    await crashPublication(root, subject, target, 'after-commit-object');
    const journal = JSON.parse(await readFile(publicationJournalPath(root, subject.kind, subject.id), 'utf8'));
    const impostor = git(['commit-tree', journal.tree, '-p', expectedHead, '-m', 'same tree, wrong identity'], root);
    git(['update-ref', 'refs/heads/main', impostor, expectedHead], root);
    const pending = await readPendingPublication(root, subject);
    assert.notEqual(impostor, journal.commit);
    assert.equal(pending.record.code, 'PUBLICATION_RECOVERY_DIVERGED');
    assert.match(pending.record.error, /does not contain the exact transaction commit/);
  });

  await t.test('wrong event digest is rejected', async () => {
    const root = await repository('sflow-wrong-event-identity-');
    const subject = { kind: 'story', id: 'WRONG-EVENT', branch: 'main' };
    const target = 'story-state.json';
    await writeFile(path.join(root, target), '{"status":"before"}\n');
    git(['add', target], root);
    git(['commit', '-m', 'canonical state'], root);
    await crashPublication(root, subject, target, 'after-ref-update');
    const journalPath = publicationJournalPath(root, subject.kind, subject.id);
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.eventSha256 = `sha256:${'f'.repeat(64)}`;
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const pending = await readPendingPublication(root, subject);
    assert.equal(pending.record.code, 'PUBLICATION_RECOVERY_DIVERGED');
    assert.match(pending.record.error, /different event digest/);
    assert.equal(await pathExists(journalPath), true);
  });
});

test('a dead prepared journal is discarded only when Git proves the pre-commit transaction is empty', async () => {
  const root = await repository('sflow-clean-prepared-journal-');
  const subject = { kind: 'story', id: 'STORY-CLEAN-PREPARED', branch: 'main' };
  const expectedHead = git(['rev-parse', 'HEAD'], root);
  const event = lifecycleEvent({ type: 'approval-requested', subject, phaseId: 'implementation', generation: 2 });
  const journalPath = publicationJournalPath(root, subject.kind, subject.id);

  async function deadOwnerJournal() {
    await beginPublicationJournal(root, { subject, expectedHead, branch: 'main', remote: 'origin', event });
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.owner.pid = 2147483647;
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    return readPendingPublication(root, subject);
  }

  const clean = await deadOwnerJournal();
  assert.equal(await discardCleanPreparedPublication(root, clean), true);
  assert.equal(await pathExists(journalPath), false);
  assert.equal(git(['rev-parse', 'HEAD'], root), expectedHead);

  const dirty = await deadOwnerJournal();
  await writeFile(path.join(root, 'README.md'), '# interrupted bytes\n');
  assert.equal(await discardCleanPreparedPublication(root, dirty), false);
  assert.equal(await pathExists(journalPath), true);
  assert.match(git(['status', '--porcelain'], root), /README\.md/);
});

test('a live prepared journal is reported as active rather than interrupted', () => {
  const pending = {
    journal: true,
    record: { recoveryStage: 'interrupted-before-branch-ref-advanced' },
    journalRecord: {
      stage: 'prepared', commit: null,
      owner: { pid: process.pid, processId: 'live-test-owner' },
      createdAt: '2026-08-24T12:49:36.648Z', updatedAt: '2026-08-24T12:49:36.648Z'
    }
  };
  assert.deepEqual(livePreparedPublicationOwner(pending), {
    pid: process.pid,
    processId: 'live-test-owner',
    createdAt: '2026-08-24T12:49:36.648Z',
    updatedAt: '2026-08-24T12:49:36.648Z'
  });
  pending.journalRecord.owner.pid = 2147483647;
  assert.equal(livePreparedPublicationOwner(pending), null);
});

test('a dead pre-commit transaction restores its durable preimage and preserves unrelated work', async (t) => {
  for (const kind of kinds) {
    await t.test(kind, async () => {
      const root = await repository(`sflow-durable-rollback-${kind}-`);
      const subject = { kind, id: `${kind.toUpperCase()}-DURABLE-ROLLBACK`, branch: 'main' };
      const target = `${kind}-state.json`;
      const prior = `${JSON.stringify({ status: 'before', authored: 'preserve me' })}\n`;
      await writeFile(path.join(root, target), prior);
      git(['add', target], root);
      git(['commit', '-m', 'canonical state'], root);
      const canonical = git(['rev-parse', 'HEAD'], root);
      const script = [
        `import { writeFile } from 'node:fs/promises';`,
        `import { GitPublicationUnitOfWork } from ${JSON.stringify(publicationModule)};`,
        `import { lifecycleEvent } from ${JSON.stringify(eventModule)};`,
        `import { restorePublicationPreimage } from ${JSON.stringify(recoveryModule)};`,
        `const root = ${JSON.stringify(root)};`,
        `const subject = ${JSON.stringify(subject)};`,
        `const target = ${JSON.stringify(target)};`,
        `await new GitPublicationUnitOfWork(root).execute({`,
        `  subject,`,
        `  event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),`,
        `  commit: { message: '[${subject.id}] durable rollback' },`,
        `  publication: { mode: 'off', branch: 'main' }, allowedPaths: [target],`,
        `  state: {`,
        `    write: () => writeFile(root + '/' + target, '{"status":"interrupted"}\\n'),`,
        `    rollback: (preimage) => restorePublicationPreimage(root, preimage, { subject })`,
        `  },`,
        `  fault: (current) => { if (current === 'after-state-write') process.exit(73); }`,
        `});`
      ].join('\n');
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: packageRoot, encoding: 'utf8'
      });
      assert.equal(child.status, 73, child.stderr);
      assert.equal(await readFile(path.join(root, target), 'utf8'), '{"status":"interrupted"}\n');
      await writeFile(path.join(root, 'developer.txt'), 'unrelated work survives recovery\n');

      const pending = await readPendingPublication(root, subject);
      assert.equal(pending.journalRecord.recoveryPreimage.format, 'publication-preimage-v2');
      assert.equal('contents' in pending.journalRecord.recoveryPreimage.roots[0].files[0], false);
      const recovery = await recoverPreparedPublication(root, pending);
      assert.equal(recovery.restored, true);
      assert.ok(recovery.rescuePath);
      assert.equal(await readFile(path.join(root, target), 'utf8'), prior);
      assert.equal(await readFile(path.join(root, 'developer.txt'), 'utf8'), 'unrelated work survives recovery\n');
      assert.equal(await readFile(path.join(recovery.rescuePath, 'worktree', target), 'utf8'), '{"status":"interrupted"}\n');
      assert.equal(await pathExists(publicationJournalPath(root, kind, subject.id)), false);
      assert.equal(git(['rev-parse', 'HEAD'], root), canonical);
      assert.equal(git(['status', '--porcelain'], root), '?? developer.txt');
    });
  }
});

test('a corrupt durable preimage is refused before restoration', async () => {
  const root = await repository('sflow-corrupt-rollback-');
  const target = 'governed.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  const preimage = structuredClone(await capturePublicationPreimage(root, [target]));
  preimage.roots[0].files[0].blob.digest = '0'.repeat(64);
  await writeFile(path.join(root, target), '{"status":"interrupted"}\n');
  await assert.rejects(
    () => restorePublicationPreimage(root, preimage, { subject: { kind: 'story', id: 'CORRUPT' }, preserveCurrent: true }),
    /blob reference is invalid/
  );
  assert.equal(await readFile(path.join(root, target), 'utf8'), '{"status":"interrupted"}\n');
});

test('durable preimages restore executable modes as well as file bytes', async () => {
  const root = await repository('sflow-mode-rollback-');
  const target = path.join(root, 'governed.sh');
  await writeFile(target, '#!/bin/sh\necho before\n');
  await chmod(target, 0o755);
  const preimage = await capturePublicationPreimage(root, ['governed.sh']);
  await writeFile(target, '#!/bin/sh\necho interrupted\n');
  await chmod(target, 0o600);
  const recovery = await restorePublicationPreimage(root, preimage, {
    subject: { kind: 'story', id: 'MODE' }
  });
  assert.equal(recovery.restored, true);
  assert.equal(await readFile(target, 'utf8'), '#!/bin/sh\necho before\n');
  assert.equal((await stat(target)).mode & 0o777, 0o755);
});

test('subject-first recovery restores an aggregate that no longer parses', async () => {
  const root = await repository('sflow-subject-first-');
  const subject = { kind: 'story', id: 'BROKEN-AGGREGATE', branch: 'main' };
  const target = 'workflow.json';
  const prior = '{"status":"in_progress","currentPhase":"intake"}\n';
  await writeFile(path.join(root, target), prior);
  git(['add', target], root);
  git(['commit', '-m', 'canonical aggregate'], root);
  const script = [
    `import { writeFile } from 'node:fs/promises';`,
    `import { GitPublicationUnitOfWork } from ${JSON.stringify(publicationModule)};`,
    `import { lifecycleEvent } from ${JSON.stringify(eventModule)};`,
    `const root = ${JSON.stringify(root)};`,
    `const subject = ${JSON.stringify(subject)};`,
    `await new GitPublicationUnitOfWork(root).execute({`,
    `  subject, allowedPaths: [${JSON.stringify(target)}],`,
    `  event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),`,
    `  commit: { message: '[BROKEN-AGGREGATE] interrupted' },`,
    `  publication: { mode: 'off', branch: 'main' },`,
    `  state: { write: () => writeFile(root + '/workflow.json', '{') },`,
    `  fault: (stage) => { if (stage === 'after-state-write') process.exit(74); }`,
    `});`
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: packageRoot, encoding: 'utf8'
  });
  assert.equal(child.status, 74, child.stderr);
  assert.equal(await readFile(path.join(root, target), 'utf8'), '{');

  const recovered = await recoverPreparedPublicationBySubject(root, subject);
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.restored, true);
  assert.equal(await readFile(path.join(root, target), 'utf8'), prior);
});

test('a failed in-process rollback retains its journal for a later exact retry', async () => {
  const root = await repository('sflow-rollback-retry-');
  const subject = { kind: 'initiative', id: 'ROLLBACK-RETRY', branch: 'main' };
  const target = 'state.json';
  const prior = '{"status":"before"}\n';
  await writeFile(path.join(root, target), prior);
  git(['add', target], root);
  git(['commit', '-m', 'canonical state'], root);
  const script = [
    `import { writeFile } from 'node:fs/promises';`,
    `import { GitPublicationUnitOfWork } from ${JSON.stringify(publicationModule)};`,
    `import { lifecycleEvent } from ${JSON.stringify(eventModule)};`,
    `const root = ${JSON.stringify(root)};`,
    `const subject = ${JSON.stringify(subject)};`,
    `try { await new GitPublicationUnitOfWork(root).execute({`,
    `  subject, allowedPaths: [${JSON.stringify(target)}],`,
    `  event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'define', generation: 1 }),`,
    `  commit: { message: '[ROLLBACK-RETRY] interrupted' },`,
    `  publication: { mode: 'off', branch: 'main' },`,
    `  state: {`,
    `    write: () => writeFile(root + '/state.json', '{\"status\":\"partial\"}\\n'),`,
    `    validate: () => { throw new Error('validation failed'); },`,
    `    rollback: () => { throw new Error('restore failed'); }`,
    `  }`,
    `}); } catch (error) { if (error.code !== 'PUBLICATION_ROLLBACK_FAILED') process.exit(75); }`
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: packageRoot, encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
  const pending = await readPendingPublication(root, subject);
  assert.equal(pending.journalRecord.stage, 'rollback-failed');
  assert.match(pending.journalRecord.rollbackError, /restore failed/);

  const recovered = await recoverPreparedPublicationBySubject(root, subject);
  assert.equal(recovered.status, 'recovered');
  assert.equal(await readFile(path.join(root, target), 'utf8'), prior);
  assert.equal(await pathExists(publicationJournalPath(root, subject.kind, subject.id)), false);
});

test('a hard-killed draft preparation restores through the same subject-first recovery path', async () => {
  const root = await repository('sflow-draft-recovery-');
  const subject = { kind: 'story', id: 'DRAFT-RECOVERY', branch: 'main' };
  const target = 'story';
  await writeFile(path.join(root, 'story'), 'stable prepared state\n');
  git(['add', target], root);
  git(['commit', '-m', 'stable draft baseline'], root);
  const script = [
    `import { writeFile } from 'node:fs/promises';`,
    `import { runDraftTransaction } from ${JSON.stringify(draftModule)};`,
    `const root = ${JSON.stringify(root)};`,
    `const subject = ${JSON.stringify(subject)};`,
    `await runDraftTransaction(root, {`,
    `  subject, allowedPaths: ['story'], operation: 'prepare:intake',`,
    `  write: () => writeFile(root + '/story', 'partial preparation\\n'),`,
    `  fault: (stage) => { if (stage === 'after-draft-write') process.exit(76); }`,
    `});`
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: packageRoot, encoding: 'utf8'
  });
  assert.equal(child.status, 76, child.stderr);
  const pending = await readPendingPublication(root, subject);
  assert.equal(pending.journalRecord.transactionKind, 'draft');
  assert.equal(pending.journalRecord.operation, 'prepare:intake');
  assert.equal(await readFile(path.join(root, target), 'utf8'), 'partial preparation\n');

  const recovered = await recoverPreparedPublicationBySubject(root, subject);
  assert.equal(recovered.status, 'recovered');
  assert.equal(await readFile(path.join(root, target), 'utf8'), 'stable prepared state\n');
});

test('first creation hands its absent preimage into publication and restores no-work state on failure', async () => {
  const root = await repository('sflow-create-recovery-');
  const subject = { kind: 'story', id: 'CREATE-RECOVERY', branch: 'main' };
  const target = 'singularity/work-items/CREATE-RECOVERY';
  const before = git(['rev-parse', 'HEAD'], root);

  await assert.rejects(() => runDraftTransaction(root, {
    subject,
    allowedPaths: [target],
    operation: 'story-start',
    write: async (creationPreimage) => {
      await mkdir(path.join(root, target), { recursive: true });
      await writeFile(path.join(root, target, 'workflow.json'), '{"status":"creating"}\n');
      return new GitPublicationUnitOfWork(root).execute({
        subject,
        event: lifecycleEvent({ type: 'binding', subject }),
        commit: { message: '[CREATE-RECOVERY][init] start' },
        publication: { mode: 'off', branch: 'main' },
        allowedPaths: [target],
        recoveryPreimage: creationPreimage,
        state: {
          write: () => writeFile(path.join(root, target, 'workflow.json'), '{"status":"ready"}\n')
        },
        fault: (stage) => { if (stage === 'after-state-write') throw new Error('creation publication failed'); }
      });
    }
  }), /creation publication failed/);

  assert.equal(git(['rev-parse', 'HEAD'], root), before);
  assert.equal(await pathExists(path.join(root, target)), false, 'partial first aggregate was removed');
  assert.equal(await pathExists(publicationJournalPath(root, subject.kind, subject.id)), false);
  assert.equal(git(['status', '--porcelain'], root), '');
});

test('a lock left by a killed process is reclaimed for Story and Initiative subjects', async (t) => {
  const lockModule = pathToFileURL(path.join(packageRoot, 'src/subject-lock.mjs')).href;
  for (const kind of kinds) {
    await t.test(kind, async () => {
      const root = await repository(`sflow-${kind}-lock-crash-`);
      const subject = { kind, id: `${kind.toUpperCase()}-CRASH` };
      const script = [
        `import { acquireSubjectLock } from ${JSON.stringify(lockModule)};`,
        `await acquireSubjectLock(${JSON.stringify(root)}, ${JSON.stringify(subject)}, { ttlMs: 0 });`,
        'process.exit(73);'
      ].join('\n');
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: packageRoot, encoding: 'utf8'
      });
      assert.equal(child.status, 73, child.stderr);
      assert.equal(path.basename(subjectLockPath(root, subject)), `${kind}--${subject.id}.lock`);

      // The owner PID no longer exists. A zero TTL proves the stale record is reclaimed rather
      // than treated as live; the short yield avoids comparing timestamps from the same millisecond.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const owner = await acquireSubjectLock(root, subject, { ttlMs: 0 });
      assert.equal(await releaseSubjectLock(root, subject, owner), true);
    });
  }
});

test('governed publication preserves unrelated staged work and commits only allowed paths', async () => {
  const root = await repository('sflow-isolated-index-');
  await writeFile(path.join(root, 'developer.txt'), 'developer work\n');
  await writeFile(path.join(root, 'governed.json'), '{"status":"ready"}\n');
  git(['add', 'developer.txt'], root);
  const stagedBefore = git(['diff', '--cached', '--binary'], root);
  const before = git(['rev-parse', 'HEAD'], root);

  const committed = await commitIsolated(root, '[STORY-1][phase:intake] governed only', ['governed.json'], {
    expectedHead: before
  });

  assert.equal(git(['show', '--format=', '--name-only', committed], root), 'governed.json');
  assert.equal(git(['diff', '--cached', '--binary'], root), stagedBefore, 'developer index is unchanged');
  assert.equal(git(['diff', '--cached', '--name-only'], root), 'developer.txt');
  assert.equal(git(['status', '--porcelain'], root), 'A  developer.txt');
});

test('governed publication rejects a pre-staged governed path without changing HEAD or index', async () => {
  const root = await repository('sflow-isolated-overlap-');
  await writeFile(path.join(root, 'governed.json'), '{"status":"staged"}\n');
  git(['add', 'governed.json'], root);
  const before = git(['rev-parse', 'HEAD'], root);
  const stagedBefore = git(['diff', '--cached', '--binary'], root);

  await assert.rejects(
    () => commitIsolated(root, 'must not commit', ['governed.json'], { expectedHead: before }),
    /already staged governed path/
  );
  assert.equal(git(['rev-parse', 'HEAD'], root), before);
  assert.equal(git(['diff', '--cached', '--binary'], root), stagedBefore);
});

test('governed publication rejects an editor write during snapshot staging without advancing HEAD', async () => {
  const root = await repository('sflow-publication-snapshot-race-');
  const governedPath = path.join(root, 'governed.json');
  await writeFile(governedPath, '{"status":"ready"}\n');
  const before = git(['rev-parse', 'HEAD'], root);
  const guard = async () => readFile(governedPath, 'utf8');

  await assert.rejects(
    () => commitIsolated(root, 'must retain changing bytes', ['governed.json'], {
      expectedHead: before,
      stabilityGuard: guard,
      fault: async (stage) => {
        if (stage === 'after-staging') await writeFile(governedPath, '{"status":"editor-write"}\n');
      }
    }),
    (error) => error.code === 'PUBLICATION_SNAPSHOT_CHANGED'
  );

  assert.equal(git(['rev-parse', 'HEAD'], root), before);
  assert.equal(await readFile(governedPath, 'utf8'), '{"status":"editor-write"}\n');
  assert.match(git(['status', '--porcelain'], root), /\?\? governed\.json/);
});

test('isolated publication cannot advance a different branch at the same commit', async () => {
  const root = await repository('sflow-publication-branch-race-');
  const before = git(['rev-parse', 'HEAD'], root);
  git(['branch', 'story-a', before], root);
  git(['branch', 'story-b', before], root);
  git(['switch', 'story-a'], root);
  await writeFile(path.join(root, 'governed.json'), '{"status":"ready"}\n');

  await assert.rejects(
    () => commitIsolated(root, 'must remain on story-a', ['governed.json'], {
      expectedHead: before,
      expectedRef: 'refs/heads/story-a',
      fault: (stage) => {
        if (stage === 'after-commit-object') git(['switch', 'story-b'], root);
      }
    }),
    (error) => error.code === 'PUBLICATION_BRANCH_CHANGED'
      && error.details.expectedRef === 'refs/heads/story-a'
      && error.details.currentRef === 'refs/heads/story-b'
      && error.publicationRefAdvanced === false
  );

  assert.equal(git(['branch', '--show-current'], root), 'story-b');
  assert.equal(git(['rev-parse', 'story-a'], root), before);
  assert.equal(git(['rev-parse', 'story-b'], root), before);
  assert.match(git(['status', '--porcelain'], root), /\?\? governed\.json/);
});

test('a checkout switch after ref advancement retains the commit only on its captured branch', async () => {
  const root = await repository('sflow-publication-post-advance-branch-race-');
  const before = git(['rev-parse', 'HEAD'], root);
  git(['branch', 'story-a', before], root);
  git(['branch', 'story-b', before], root);
  git(['switch', 'story-a'], root);
  await writeFile(path.join(root, 'governed.json'), '{"status":"ready"}\n');
  let retained = null;

  await assert.rejects(
    () => commitIsolated(root, 'retain only on story-a', ['governed.json'], {
      expectedHead: before,
      expectedRef: 'refs/heads/story-a',
      onRefAdvanced: ({ sourceCommit }) => {
        retained = sourceCommit;
        git(['switch', '-f', 'story-b'], root);
      }
    }),
    (error) => error.code === 'PUBLICATION_BRANCH_CHANGED'
      && error.publicationRefAdvanced === true
      && error.publicationCommit === retained
  );

  assert.match(retained, /^[0-9a-f]{40,64}$/);
  assert.equal(git(['branch', '--show-current'], root), 'story-b');
  assert.equal(git(['rev-parse', 'story-a'], root), retained);
  assert.equal(git(['rev-parse', 'story-b'], root), before);
  assert.equal(git(['diff', '--cached', '--name-only'], root), '', 'the other branch index is untouched');
  assert.match(git(['status', '--porcelain'], root), /\?\? governed\.json/);
});

test('temporary-index faults before ref update leave no commit or index mutation', async (t) => {
  for (const stage of ['before-staging', 'after-staging', 'after-commit-object']) {
    await t.test(stage, async () => {
      const root = await repository(`sflow-index-${stage}-`);
      await writeFile(path.join(root, 'developer.txt'), 'developer work\n');
      await writeFile(path.join(root, 'governed.json'), `{\"stage\":\"${stage}\"}\n`);
      git(['add', 'developer.txt'], root);
      const before = git(['rev-parse', 'HEAD'], root);
      const stagedBefore = git(['diff', '--cached', '--binary'], root);
      await assert.rejects(() => commitIsolated(root, `fault ${stage}`, ['governed.json'], {
        expectedHead: before,
        fault: (current) => { if (current === stage) throw new Error(`fault:${stage}`); }
      }), new RegExp(`fault:${stage}`));
      assert.equal(git(['rev-parse', 'HEAD'], root), before);
      assert.equal(git(['diff', '--cached', '--binary'], root), stagedBefore);
      assert.match(git(['status', '--porcelain'], root), /A  developer.txt/);
      assert.match(git(['status', '--porcelain'], root), /\?\? governed.json/);
    });
  }
});

test('a failure after branch ref advancement records the exact commit for publication recovery', async (t) => {
  for (const kind of kinds) {
    await t.test(kind, async () => {
      const root = await repository(`sflow-ref-advanced-${kind}-`);
      const subject = { kind, id: `${kind.toUpperCase()}-REF-ADVANCED`, branch: 'main' };
      const target = `${kind}-state.json`;
      await writeFile(path.join(root, target), '{"status":"before"}\n');
      git(['add', target], root);
      git(['commit', '-m', 'canonical state'], root);
      const canonical = git(['rev-parse', 'HEAD'], root);
      await ensurePublicationOrigin(root);

      await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
        subject,
        event: lifecycleEvent({
          type: 'artifact-generated', subject, phaseId: 'intake', generation: 1
        }),
        commit: { message: `[${subject.id}] ref advanced` },
        publication: { mode: 'required', branch: 'main', remote: 'origin' },
        allowedPaths: [target],
        state: {
          write: () => writeFile(path.join(root, target), '{"status":"committed"}\n'),
          rollback: () => writeFile(path.join(root, target), '{"status":"before"}\n')
        },
        fault: (current) => {
          if (current === 'after-ref-update') throw new Error(`fault:${kind}:after-ref-update`);
        }
      }), new RegExp(`fault:${kind}:after-ref-update`));

      const committed = git(['rev-parse', 'HEAD'], root);
      assert.notEqual(committed, canonical);
      assert.equal(git(['status', '--porcelain'], root), '');
      const pending = await readPendingPublication(root, subject);
      assert.equal(pending.record.commit, committed);
      assert.equal(pending.record.branch, 'main');
      assert.equal(pending.record.recoveryStage, 'branch-ref-advanced-before-publication');
      assert.equal(pending.record.event.sourceCommit, committed);
    });
  }
});

test('an unrelated HEAD advancement cannot erase a draft recovery journal', async () => {
  const root = await repository('sflow-draft-unrelated-head-');
  const subject = { kind: 'story', id: 'DRAFT-UNRELATED-HEAD', branch: 'main' };
  const target = 'draft-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', 'draft baseline'], root);
  const expectedHead = git(['rev-parse', 'HEAD'], root);

  await assert.rejects(() => runDraftTransaction(root, {
    subject,
    operation: 'draft-with-unrelated-commit',
    allowedPaths: [target],
    write: async () => {
      await writeFile(path.join(root, target), '{"status":"partial"}\n');
      git(['add', target], root);
      git(['commit', '-m', 'manual unrelated advancement'], root);
      throw new Error('draft writer failed after unrelated commit');
    }
  }), (error) => error?.code === 'DRAFT_RECOVERY_DIVERGED');

  const observedHead = git(['rev-parse', 'HEAD'], root);
  assert.notEqual(observedHead, expectedHead);
  const retained = await readPublicationJournal(root, subject);
  assert.ok(retained, 'unrelated HEAD advancement erased the draft journal');
  assert.equal(retained.record.transactionKind, 'draft');
  assert.equal(retained.record.expectedHead, expectedHead);
  assert.equal(retained.record.stage, 'draft-head-diverged');
  assert.equal(retained.record.observedHead, observedHead);
});

test('a nested pending commit must equal HEAD before the outer draft can release its journal', async (t) => {
  const root = await repository('sflow-draft-nested-then-unrelated-');
  const subject = { kind: 'story', id: 'DRAFT-NESTED-THEN-UNRELATED', branch: 'main' };
  const target = 'draft-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', 'nested divergence baseline'], root);
  const expectedHead = git(['rev-parse', 'HEAD'], root);
  const remote = await ensurePublicationOrigin(root);
  const allowPushes = await rejectPushes(remote);
  t.after(allowPushes);
  let nestedCommit = null;

  await assert.rejects(() => runDraftTransaction(root, {
    subject,
    operation: 'nested-then-unrelated',
    allowedPaths: [target, 'unrelated.txt'],
    write: async () => {
      try {
        await new GitPublicationUnitOfWork(root).execute({
          subject,
          event: lifecycleEvent({
            type: 'artifact-generated', subject, phaseId: 'intake', generation: 1
          }),
          commit: { message: '[DRAFT-NESTED-THEN-UNRELATED] nested publication' },
          publication: { mode: 'required', branch: 'main', remote: 'origin' },
          allowedPaths: [target],
          state: { write: () => writeFile(path.join(root, target), '{"status":"nested"}\n') }
        });
      } catch (error) {
        nestedCommit = git(['rev-parse', 'HEAD'], root);
        await writeFile(path.join(root, 'unrelated.txt'), 'advanced after nested recovery\n');
        git(['add', 'unrelated.txt'], root);
        git(['commit', '-m', 'unrelated descendant'], root);
        throw error;
      }
    }
  }), (error) => error?.code === 'DRAFT_RECOVERY_DIVERGED');

  const observedHead = git(['rev-parse', 'HEAD'], root);
  assert.notEqual(nestedCommit, expectedHead);
  assert.notEqual(observedHead, nestedCommit);
  const pending = await readPendingPublication(root, subject);
  assert.equal(pending.record.commit, nestedCommit, 'the exact nested publication marker changed');
  const retained = await readPublicationJournal(root, subject);
  assert.ok(retained, 'the outer draft journal was erased by an ancestor pending marker');
  assert.equal(retained.record.transactionKind, 'draft');
  assert.equal(retained.record.expectedHead, expectedHead);
  assert.equal(retained.record.observedHead, observedHead);
  assert.equal(retained.record.stage, 'draft-head-diverged');
});

test('an exact completed nested publication remains the stable boundary when outer validation fails', async () => {
  const root = await repository('sflow-draft-exact-nested-complete-');
  const subject = { kind: 'story', id: 'DRAFT-EXACT-NESTED-COMPLETE', branch: 'main' };
  const target = 'draft-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', 'completed nested baseline'], root);
  const expectedHead = git(['rev-parse', 'HEAD'], root);

  await assert.rejects(() => runDraftTransaction(root, {
    subject,
    operation: 'completed-nested-then-validation',
    allowedPaths: [target],
    write: () => new GitPublicationUnitOfWork(root).execute({
      subject,
      event: lifecycleEvent({
        type: 'artifact-generated', subject, phaseId: 'intake', generation: 1
      }),
      commit: { message: '[DRAFT-EXACT-NESTED-COMPLETE] nested publication' },
      publication: { mode: 'off', branch: 'main' },
      allowedPaths: [target],
      state: { write: () => writeFile(path.join(root, target), '{"status":"committed"}\n') }
    }),
    validate: () => { throw new Error('outer validation failed after nested completion'); }
  }), /outer validation failed after nested completion/);

  assert.notEqual(git(['rev-parse', 'HEAD'], root), expectedHead);
  assert.equal(await readFile(path.join(root, target), 'utf8'), '{"status":"committed"}\n');
  assert.equal(await readPublicationJournal(root, subject), null);
});

test('a completed nested publication with a tampered Candidate sidecar cannot release the draft journal', async () => {
  const root = await repository('sflow-draft-nested-candidate-tamper-');
  const subject = { kind: 'story', id: 'DRAFT-NESTED-CANDIDATE-TAMPER', branch: 'main' };
  const target = 'draft-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', 'tampered nested baseline'], root);

  await assert.rejects(() => runDraftTransaction(root, {
    subject,
    operation: 'completed-nested-candidate-tamper',
    allowedPaths: [target],
    write: () => new GitPublicationUnitOfWork(root).execute({
      subject,
      event: lifecycleEvent({
        type: 'artifact-generated', subject, phaseId: 'intake', generation: 1
      }),
      commit: { message: '[DRAFT-NESTED-CANDIDATE-TAMPER] nested publication' },
      publication: { mode: 'off', branch: 'main' },
      allowedPaths: [target],
      state: { write: () => writeFile(path.join(root, target), '{"status":"committed"}\n') }
    }),
    validate: async (result) => {
      const sidecar = path.join(
        root, '.git', 'singularity-flow', 'sgos', 'candidates',
        result.candidate.candidateId, 'candidate.json'
      );
      const record = JSON.parse(await readFile(sidecar, 'utf8'));
      record.totals.bytes += 1;
      await writeFile(sidecar, `${JSON.stringify(record, null, 2)}\n`);
      throw new Error('outer validation exposed Candidate tampering');
    }
  }), (error) => error?.code === 'DRAFT_RECOVERY_DIVERGED');

  const journal = await readPublicationJournal(root, subject);
  assert.ok(journal, 'tampered Candidate sidecar incorrectly released the outer draft journal');
  assert.equal(journal.record.stage, 'draft-head-diverged');
});

test('an outer draft cannot erase a nested publication recovery record', async () => {
  const root = await repository('sflow-nested-publication-');
  const subject = { kind: 'story', id: 'NESTED-RECOVERY', branch: 'main' };
  const target = 'nested-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', 'nested baseline'], root);
  await ensurePublicationOrigin(root);

  await assert.rejects(() => runDraftTransaction(root, {
    subject,
    operation: 'outer-draft',
    allowedPaths: [target],
    write: async () => {
      await writeFile(path.join(root, target), '{"status":"draft"}\n');
      return new GitPublicationUnitOfWork(root).execute({
        subject,
        event: lifecycleEvent({
          type: 'artifact-generated', subject, phaseId: 'intake', generation: 1
        }),
        commit: { message: '[NESTED-RECOVERY] nested publication' },
        publication: { mode: 'required', branch: 'main', remote: 'origin' },
        allowedPaths: [target],
        state: { write: () => writeFile(path.join(root, target), '{"status":"committed"}\n') },
        fault: (stage) => {
          if (stage === 'after-ref-update') throw new Error('nested ref advanced');
        }
      });
    }
  }), /nested ref advanced/);

  const pending = await readPendingPublication(root, subject);
  assert.ok(pending, 'the outer draft erased the nested publication recovery marker');
  assert.equal(pending.record.commit, git(['rev-parse', 'HEAD'], root));
  assert.equal(pending.record.recoveryStage, 'branch-ref-advanced-before-publication');
  assert.equal(await readPublicationJournal(root, subject), null,
    'the verified nested marker should replace the completed outer draft recovery boundary');
});

test('preimages are content-addressed and reject oversized files and directory depth', async () => {
  const root = await repository('sflow-preimage-bounds-');
  await mkdir(path.join(root, 'governed'), { recursive: true });
  await writeFile(path.join(root, 'governed', 'small.txt'), 'bounded bytes\n');
  const snapshot = await capturePublicationPreimage(root, ['governed']);
  const file = snapshot.roots[0].files[0];
  assert.equal(file.contents, undefined, 'preimage bytes must not be embedded in the journal');
  assert.equal(file.blob.digest, file.sha256);

  const oversized = path.join(root, 'oversized.bin');
  await writeFile(oversized, '');
  await truncate(oversized, 64 * 1024 * 1024 + 1);
  await assert.rejects(
    () => capturePublicationPreimage(root, ['oversized.bin']),
    (error) => error.code === 'PUBLICATION_PREIMAGE_QUOTA_EXCEEDED'
  );

  let nested = path.join(root, 'too-deep');
  for (let index = 0; index < 66; index += 1) nested = path.join(nested, `d${index}`);
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, 'leaf.txt'), 'too deep\n');
  await assert.rejects(
    () => capturePublicationPreimage(root, ['too-deep']),
    (error) => error.code === 'PUBLICATION_PREIMAGE_QUOTA_EXCEEDED'
  );
});

test('publication recovery removes a rework-baseline ref created after the durable preimage', async () => {
  const root = await repository('sflow-preimage-new-rework-ref-');
  const subject = { kind: 'story', id: 'NEW-REWORK-REF' };
  const refPrefix = publicationReworkRefNamespace(subject);
  await writeFile(path.join(root, 'governed.json'), '{"status":"before"}\n');
  git(['add', 'governed.json'], root);
  git(['commit', '-m', 'governed baseline'], root);
  const snapshot = await capturePublicationPreimage(root, ['governed.json'], {
    refPrefixes: [refPrefix]
  });
  const createdRef = `${refPrefix}${'a'.repeat(64)}`;
  git(['update-ref', createdRef, 'HEAD'], root);

  const recovery = await restorePublicationPreimage(root, snapshot, {
    subject
  });

  assert.equal(recovery.restored, true);
  const probe = spawnSync('git', ['show-ref', '--verify', '--quiet', createdRef], { cwd: root });
  assert.equal(probe.status, 1, 'the interrupted transaction ref must be deleted');
});

test('publication recovery restores a pre-existing rework-baseline ref to its exact object', async () => {
  const root = await repository('sflow-preimage-existing-rework-ref-');
  const subject = { kind: 'story', id: 'EXISTING-REWORK-REF' };
  const refPrefix = publicationReworkRefNamespace(subject);
  await writeFile(path.join(root, 'governed.json'), '{"status":"before"}\n');
  git(['add', 'governed.json'], root);
  git(['commit', '-m', 'first governed baseline'], root);
  const originalTarget = git(['rev-parse', 'HEAD'], root);
  const existingRef = `${refPrefix}${'b'.repeat(64)}`;
  git(['update-ref', existingRef, originalTarget], root);
  const snapshot = await capturePublicationPreimage(root, ['governed.json'], {
    refPrefixes: [refPrefix]
  });
  const tampered = structuredClone(snapshot);
  tampered.refs[0].target = '0'.repeat(originalTarget.length);
  await assert.rejects(
    () => restorePublicationPreimage(root, tampered, {
      subject: { kind: 'story', id: 'TAMPERED-REWORK-REF' }
    }),
    /manifest failed integrity validation/
  );

  git(['commit', '--allow-empty', '-m', 'later object'], root);
  const interruptedTarget = git(['rev-parse', 'HEAD'], root);
  git(['update-ref', existingRef, interruptedTarget, originalTarget], root);
  const recovery = await restorePublicationPreimage(root, snapshot, {
    subject
  });

  assert.equal(recovery.restored, true);
  assert.equal(git(['rev-parse', existingRef], root), originalTarget);
});

test('a ref-bearing preimage is refused for a different Story before admission or recovery', async () => {
  const root = await repository('sflow-preimage-subject-mismatch-');
  const first = { kind: 'story', id: 'FIRST', branch: 'main' };
  const second = { kind: 'story', id: 'SECOND', branch: 'main' };
  const firstPrefix = publicationReworkRefNamespace(first);
  const firstRef = `${firstPrefix}${'d'.repeat(64)}`;
  const target = path.join(root, 'governed.json');
  await writeFile(target, '{"status":"before"}\n');
  git(['add', 'governed.json'], root);
  git(['commit', '-m', 'governed baseline'], root);
  const original = git(['rev-parse', 'HEAD'], root);
  git(['update-ref', firstRef, original], root);
  const snapshot = await capturePublicationPreimage(root, ['governed.json'], {
    refPrefixes: [firstPrefix]
  });
  await assert.rejects(
    () => restorePublicationPreimage(root, snapshot),
    (error) => error.code === 'PUBLICATION_PREIMAGE_SUBJECT_MISMATCH'
  );

  await assert.rejects(
    () => beginPublicationJournal(root, {
      subject: second,
      expectedHead: original,
      branch: 'main',
      remote: 'origin',
      event: lifecycleEvent({ type: 'binding', subject: second }),
      recoveryPreimage: snapshot
    }),
    (error) => error.code === 'PUBLICATION_PREIMAGE_SUBJECT_MISMATCH'
  );
  assert.equal(await readPublicationJournal(root, second), null,
    'a mismatched preimage must be refused before journal admission');

  git(['commit', '--allow-empty', '-m', 'later ref target'], root);
  const later = git(['rev-parse', 'HEAD'], root);
  git(['update-ref', firstRef, later, original], root);
  await writeFile(target, '{"status":"interrupted"}\n');
  await assert.rejects(
    () => restorePublicationPreimage(root, snapshot, { subject: second }),
    (error) => error.code === 'PUBLICATION_PREIMAGE_SUBJECT_MISMATCH'
  );
  assert.equal(await readFile(target, 'utf8'), '{"status":"interrupted"}\n',
    'mismatch refusal must happen before worktree restoration');
  assert.equal(git(['rev-parse', firstRef], root), later,
    'mismatch refusal must happen before another Story ref is restored');
});

test('journal lookup refuses a record whose subject was swapped beneath another subject filename', async (t) => {
  await t.test('top-level journal', async () => {
    const root = await repository('sflow-journal-swapped-subject-');
    const first = { kind: 'story', id: 'FIRST', branch: 'main' };
    const second = { kind: 'story', id: 'SECOND', branch: 'main' };
    const secondPrefix = publicationReworkRefNamespace(second);
    const secondRef = `${secondPrefix}${'e'.repeat(64)}`;
    const target = path.join(root, 'governed.json');
    await writeFile(target, '{"status":"before"}\n');
    git(['add', 'governed.json'], root);
    git(['commit', '-m', 'governed baseline'], root);
    git(['update-ref', secondRef, 'HEAD'], root);
    const secondPreimage = await capturePublicationPreimage(root, ['governed.json'], {
      refPrefixes: [secondPrefix]
    });
    await beginPublicationJournal(root, {
      subject: second,
      expectedHead: git(['rev-parse', 'HEAD'], root),
      branch: 'main',
      remote: 'origin',
      event: lifecycleEvent({ type: 'binding', subject: second }),
      recoveryPreimage: secondPreimage
    });
    await rename(
      publicationJournalPath(root, second.kind, second.id),
      publicationJournalPath(root, first.kind, first.id)
    );
    await writeFile(target, '{"status":"interrupted"}\n');

    await assert.rejects(
      () => recoverPreparedPublicationBySubject(root, first),
      (error) => error.code === 'PUBLICATION_JOURNAL_SUBJECT_MISMATCH'
    );
    assert.equal(await readFile(target, 'utf8'), '{"status":"interrupted"}\n');
    assert.equal(git(['rev-parse', secondRef], root), git(['rev-parse', 'HEAD'], root));
    assert.equal(await pathExists(publicationJournalPath(root, first.kind, first.id)), true,
      'the mismatched journal must remain available for manual diagnosis');
  });

  await t.test('embedded parent journal', async () => {
    const root = await repository('sflow-journal-swapped-parent-');
    const first = { kind: 'story', id: 'FIRST', branch: 'main' };
    const second = { kind: 'story', id: 'SECOND', branch: 'main' };
    const firstPreimage = await capturePublicationPreimage(root, ['governed.json'], {
      refPrefixes: [publicationReworkRefNamespace(first)]
    });
    const secondPreimage = await capturePublicationPreimage(root, ['governed.json'], {
      refPrefixes: [publicationReworkRefNamespace(second)]
    });
    const journalOptions = {
      subject: first,
      expectedHead: git(['rev-parse', 'HEAD'], root),
      branch: 'main',
      remote: 'origin',
      event: lifecycleEvent({ type: 'binding', subject: first }),
      recoveryPreimage: firstPreimage
    };
    await beginPublicationJournal(root, journalOptions);
    await beginPublicationJournal(root, journalOptions);
    const journalPath = publicationJournalPath(root, first.kind, first.id);
    const nested = JSON.parse(await readFile(journalPath, 'utf8'));
    nested.parentJournal.subject = second;
    nested.parentJournal.recoveryPreimage = secondPreimage;
    await writeFile(journalPath, `${JSON.stringify(nested, null, 2)}\n`);

    await assert.rejects(
      () => readPublicationJournal(root, first, { migrate: false }),
      (error) => error.code === 'PUBLICATION_JOURNAL_SUBJECT_MISMATCH'
    );
    assert.equal(await pathExists(journalPath), true);
  });
});

test('publication recovery restores only the interrupted Story rework-ref namespace', async () => {
  const root = await repository('sflow-preimage-story-ref-isolation-');
  await writeFile(path.join(root, 'governed.json'), '{"status":"before"}\n');
  git(['add', 'governed.json'], root);
  git(['commit', '-m', 'shared baseline'], root);
  const original = git(['rev-parse', 'HEAD'], root);
  const firstPrefix = publicationReworkRefNamespace({ kind: 'story', id: 'FIRST' });
  const secondPrefix = publicationReworkRefNamespace({ kind: 'story', id: 'SECOND' });
  const firstRef = `${firstPrefix}${'a'.repeat(64)}`;
  const secondRef = `${secondPrefix}${'b'.repeat(64)}`;
  git(['update-ref', firstRef, original], root);
  git(['update-ref', secondRef, original], root);
  const snapshot = await capturePublicationPreimage(root, ['governed.json'], {
    refPrefixes: [firstPrefix]
  });

  git(['commit', '--allow-empty', '-m', 'concurrent targets'], root);
  const later = git(['rev-parse', 'HEAD'], root);
  git(['update-ref', firstRef, later, original], root);
  git(['update-ref', secondRef, later, original], root);
  await restorePublicationPreimage(root, snapshot, {
    subject: { kind: 'story', id: 'FIRST' }
  });

  assert.equal(git(['rev-parse', firstRef], root), original);
  assert.equal(git(['rev-parse', secondRef], root), later,
    'recovering FIRST must not roll back SECOND\'s concurrent checkpoint');
});

test('historical publication preimages remain restorable without claiming authority over refs', async (t) => {
  await t.test('v2 without ref metadata', async () => {
    const root = await repository('sflow-preimage-historical-v2-');
    const target = path.join(root, 'governed.json');
    await writeFile(target, '{"status":"before"}\n');
    const current = structuredClone(await capturePublicationPreimage(root, ['governed.json']));
    delete current.refs;
    delete current.refPrefixes;
    current.sha256 = recordSha256({
      format: current.format,
      roots: current.roots.map((entry) => ({
        path: entry.path,
        type: entry.type,
        mode: entry.mode ?? null,
        directories: (entry.directories ?? []).map(({ path: directory, mode }) => ({ path: directory, mode })),
        files: entry.files.map((file) => ({
          path: file.path, mode: file.mode, size: file.size, sha256: file.sha256,
          blob: { algorithm: file.blob.algorithm, digest: file.blob.digest }
        }))
      }))
    });
    const laterRef = `refs/singularity-flow/rework-baselines/${'c'.repeat(64)}`;
    git(['update-ref', laterRef, 'HEAD'], root);
    await writeFile(target, '{"status":"interrupted"}\n');

    assert.equal((await restorePublicationPreimage(root, current, {
      subject: { kind: 'story', id: 'HISTORICAL-V2' }
    })).restored, true);
    assert.equal(await readFile(target, 'utf8'), '{"status":"before"}\n');
    assert.equal(git(['rev-parse', laterRef], root), git(['rev-parse', 'HEAD'], root));
  });

  await t.test('v1 inline-byte manifest', async () => {
    const root = await repository('sflow-preimage-historical-v1-');
    const target = path.join(root, 'governed.json');
    const before = Buffer.from('{"status":"before"}\n');
    await writeFile(target, before);
    const info = await stat(target);
    const file = {
      path: 'governed.json', mode: info.mode & 0o777, size: before.length,
      sha256: createHash('sha256').update(before).digest('hex'), contents: before.toString('base64')
    };
    const legacy = {
      format: 'publication-preimage-v1',
      roots: [{ path: 'governed.json', type: 'file', files: [file] }]
    };
    legacy.sha256 = recordSha256({
      format: legacy.format,
      roots: [{
        path: 'governed.json', type: 'file',
        files: [{ path: file.path, mode: file.mode, size: file.size, sha256: file.sha256 }]
      }]
    });
    await writeFile(target, '{"status":"interrupted"}\n');

    assert.equal((await restorePublicationPreimage(root, legacy, {
      subject: { kind: 'story', id: 'HISTORICAL-V1' }
    })).restored, true);
    assert.equal(await readFile(target, 'utf8'), before.toString('utf8'));
  });
});

test('recovery restores directory modes and bounds rescue retention per subject', async () => {
  const root = await repository('sflow-rescue-retention-');
  const subject = { kind: 'story', id: 'RESCUE-BOUNDS', branch: 'main' };
  const directory = path.join(root, 'governed');
  await mkdir(path.join(directory, 'nested'), { recursive: true });
  await chmod(directory, 0o750);
  await chmod(path.join(directory, 'nested'), 0o710);
  await writeFile(path.join(directory, 'nested', 'state.txt'), 'original\n');
  const snapshot = await capturePublicationPreimage(root, ['governed']);

  for (let index = 0; index < 5; index += 1) {
    await chmod(directory, 0o777);
    await chmod(path.join(directory, 'nested'), 0o777);
    await writeFile(path.join(directory, 'nested', 'state.txt'), `interrupted ${index}\n`);
    await restorePublicationPreimage(root, snapshot, { subject, preserveCurrent: true });
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o750);
  assert.equal((await stat(path.join(directory, 'nested'))).mode & 0o777, 0o710);

  const rescueRoot = path.join(gitDir(root), 'singularity-flow', 'publication-rescues');
  const retained = (await readdir(rescueRoot)).filter((name) => name.startsWith('story--RESCUE-BOUNDS--'));
  assert.equal(retained.length, 3, 'only the configured per-subject rescue generations are retained');
});

test('preimage capture never follows a governed symlink', async () => {
  const root = await repository('sflow-preimage-symlink-');
  await writeFile(path.join(root, 'outside.txt'), 'must not enter recovery evidence\n');
  await mkdir(path.join(root, 'governed'));
  await symlink('../outside.txt', path.join(root, 'governed', 'replacement.txt'));
  await assert.rejects(
    () => capturePublicationPreimage(root, ['governed']),
    /refuses symbolic links|must not be a symbolic link/
  );
});
