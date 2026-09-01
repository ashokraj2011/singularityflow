import assert from 'node:assert/strict';
import {
  access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gitCommonDir, gitDir } from '../src/git.mjs';
import {
  beginPublicationJournal, clearPublicationJournal, publicationJournalPath, readPublicationJournal
} from '../src/publication-journal.mjs';
import {
  localPendingPublicationPath, readPendingPublication, sealMachineLocalPublicationReceipt,
  writePendingPublication
} from '../src/publication-pending.mjs';
import { capturePublicationPreimage, restorePublicationPreimage } from '../src/publication-recovery.mjs';
import { run } from '../src/util.mjs';

async function exists(target) {
  try { await access(target); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-linked-recovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repository');
  const linked = path.join(base, 'linked');
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['config', 'user.name', 'Linked Recovery'], { cwd: root });
  run('git', ['config', 'user.email', 'linked@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# linked recovery\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-qm', 'initial'], { cwd: root });
  run('git', ['worktree', 'add', '-q', '-b', 'STORY-LINKED', linked], { cwd: root });
  return { base, root, linked };
}

function pendingRecord(id, suffix = 'one') {
  return {
    schemaVersion: 2,
    subject: { kind: 'story', id },
    branch: 'STORY-LINKED',
    remote: 'origin',
    commit: null,
    event: null,
    transactionId: `transaction-${suffix}`,
    tree: null,
    eventSha256: null,
    stateSha256: null,
    publicationMode: 'required',
    recoveryStage: 'interrupted-before-branch-ref-advanced',
    createdAt: new Date(0).toISOString()
  };
}

test('journals, pending markers, and rescues are repository-shared across linked worktrees', async (t) => {
  const { root, linked } = await fixture(t);
  const subject = { kind: 'story', id: 'SHARED-1', branch: 'STORY-LINKED' };
  const expectedHead = run('git', ['rev-parse', 'HEAD'], { cwd: linked }).stdout.trim();
  await beginPublicationJournal(linked, {
    subject, expectedHead, branch: 'STORY-LINKED', remote: 'origin', event: null
  });
  assert.equal(
    await realpath(publicationJournalPath(linked, subject.kind, subject.id)),
    await realpath(publicationJournalPath(root, subject.kind, subject.id))
  );
  assert.equal((await readPublicationJournal(root, subject)).record.subject.id, subject.id);
  await clearPublicationJournal(root, subject);

  await writePendingPublication(linked, { kind: subject.kind, id: subject.id, record: pendingRecord(subject.id) });
  assert.equal(
    await realpath(localPendingPublicationPath(linked, subject.kind, subject.id)),
    await realpath(localPendingPublicationPath(root, subject.kind, subject.id))
  );
  assert.equal((await readPendingPublication(root, { ...subject, migrate: false })).record.subject.id, subject.id);

  await mkdir(path.join(linked, 'governed'));
  await writeFile(path.join(linked, 'governed/state.txt'), 'before\n');
  const snapshot = await capturePublicationPreimage(linked, ['governed']);
  await writeFile(path.join(linked, 'governed/state.txt'), 'interrupted\n');
  const restored = await restorePublicationPreimage(linked, snapshot, { subject, preserveCurrent: true });
  const commonRescues = await realpath(path.join(gitCommonDir(root), 'singularity-flow', 'publication-rescues'));
  assert.ok((await realpath(restored.rescuePath)).startsWith(`${commonRescues}${path.sep}`));
  assert.equal(await exists(restored.rescuePath), true);
});

test('equivalent worktree-private journals and pending markers migrate from any linked worktree', async (t) => {
  const { root, linked } = await fixture(t);
  const subject = { kind: 'story', id: 'MIGRATE-1', branch: 'STORY-LINKED' };
  const expectedHead = run('git', ['rev-parse', 'HEAD'], { cwd: linked }).stdout.trim();
  await beginPublicationJournal(linked, {
    subject, expectedHead, branch: 'STORY-LINKED', remote: 'origin', event: null
  });
  const sharedJournal = publicationJournalPath(root, subject.kind, subject.id);
  const legacyJournal = path.join(
    gitDir(linked), 'singularity-flow', 'publication-journal', path.basename(sharedJournal)
  );
  await mkdir(path.dirname(legacyJournal), { recursive: true });
  await rename(sharedJournal, legacyJournal);
  const preview = await readPublicationJournal(root, subject, { migrate: false });
  assert.equal(await realpath(preview.path), await realpath(legacyJournal));
  assert.equal(await exists(sharedJournal), false);
  const migratedJournal = await readPublicationJournal(root, subject);
  assert.equal(await realpath(migratedJournal.path), await realpath(sharedJournal));
  assert.equal(await exists(legacyJournal), false);
  await clearPublicationJournal(root, subject);

  const sharedPending = await writePendingPublication(linked, {
    kind: subject.kind, id: subject.id, record: pendingRecord(subject.id)
  });
  const legacyPending = path.join(
    gitDir(linked), 'singularity-flow', 'pending-publication', path.basename(sharedPending)
  );
  await mkdir(path.dirname(legacyPending), { recursive: true });
  await rename(sharedPending, legacyPending);
  const migratedPending = await readPendingPublication(root, subject);
  assert.equal(await realpath(migratedPending.path), await realpath(sharedPending));
  assert.equal(await exists(legacyPending), false);
});

test('divergent shared and worktree-private records fail closed without deleting either copy', async (t) => {
  const { root, linked } = await fixture(t);
  const journalSubject = { kind: 'story', id: 'JOURNAL-DIVERGED', branch: 'STORY-LINKED' };
  await beginPublicationJournal(root, {
    subject: journalSubject,
    expectedHead: run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(),
    branch: 'main', remote: 'origin', event: null
  });
  const sharedJournal = publicationJournalPath(root, journalSubject.kind, journalSubject.id);
  const legacyJournal = path.join(
    gitDir(linked), 'singularity-flow', 'publication-journal', path.basename(sharedJournal)
  );
  await mkdir(path.dirname(legacyJournal), { recursive: true });
  const divergentJournal = JSON.parse(await readFile(sharedJournal, 'utf8'));
  divergentJournal.transactionId = 'different-transaction';
  await writeFile(legacyJournal, `${JSON.stringify(divergentJournal, null, 2)}\n`);
  await assert.rejects(
    () => readPublicationJournal(linked, journalSubject),
    (error) => error.code === 'PUBLICATION_RECOVERY_STORAGE_DIVERGED'
  );
  assert.equal(await exists(sharedJournal), true);
  assert.equal(await exists(legacyJournal), true);

  const subject = { kind: 'story', id: 'DIVERGED-1', branch: 'STORY-LINKED' };
  const shared = await writePendingPublication(root, {
    kind: subject.kind, id: subject.id, record: pendingRecord(subject.id, 'shared')
  });
  const legacy = path.join(gitDir(linked), 'singularity-flow', 'pending-publication', path.basename(shared));
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, `${JSON.stringify(pendingRecord(subject.id, 'legacy'), null, 2)}\n`);

  await assert.rejects(
    () => readPendingPublication(root, subject),
    (error) => error.code === 'PUBLICATION_RECOVERY_STORAGE_DIVERGED'
  );
  assert.equal(await exists(shared), true);
  assert.equal(await exists(legacy), true);
});

test('a symlinked worktree-private recovery directory is refused without touching its target', async (t) => {
  const { base, root, linked } = await fixture(t);
  const external = path.join(base, 'outside-recovery');
  const redirected = path.join(gitDir(linked), 'singularity-flow');
  await mkdir(path.join(external, 'pending-publication'), { recursive: true });
  const externalRecord = path.join(external, 'pending-publication', 'story--SYMLINK-1.json');
  await writeFile(externalRecord, `${JSON.stringify(pendingRecord('SYMLINK-1'), null, 2)}\n`);
  await symlink(external, redirected);

  await assert.rejects(
    () => readPendingPublication(root, { kind: 'story', id: 'SYMLINK-1' }),
    (error) => error.code === 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
  );
  assert.equal(await exists(externalRecord), true);
  assert.equal(await exists(localPendingPublicationPath(root, 'story', 'SYMLINK-1')), false);
});

test('a symlinked machine-local integrity key is refused without touching its target', async (t) => {
  const { base, root } = await fixture(t);
  const runtime = path.join(gitCommonDir(root), 'singularity-flow');
  const externalKey = path.join(base, 'outside-integrity.key');
  const original = `${Buffer.alloc(32, 7).toString('base64')}\n`;
  await mkdir(runtime, { recursive: true });
  await writeFile(externalKey, original);
  await symlink(externalKey, path.join(runtime, 'pending-publication-integrity.key'));

  await assert.rejects(
    () => sealMachineLocalPublicationReceipt(root, 'goal-lifecycle-worktree', {
      path: '/tmp/sflow-gex-forged', branch: 'GEX-FORGED'
    }),
    (error) => error.code === 'PUBLICATION_RECOVERY_STORAGE_UNSAFE'
  );
  assert.equal(await readFile(externalKey, 'utf8'), original);
});

test('legacy rescue bundles migrate, while a same-name divergent bundle blocks restoration', async (t) => {
  const { root, linked } = await fixture(t);
  const subject = { kind: 'story', id: 'RESCUE-LINKED', branch: 'STORY-LINKED' };
  const legacyParent = path.join(gitDir(linked), 'singularity-flow', 'publication-rescues');
  const commonParent = path.join(gitCommonDir(root), 'singularity-flow', 'publication-rescues');
  const migratedName = 'story--RESCUE-LINKED--legacy';
  await mkdir(path.join(legacyParent, migratedName), { recursive: true });
  await writeFile(path.join(legacyParent, migratedName, 'rescue.json'), '{"legacy":true}\n');

  await mkdir(path.join(linked, 'governed'));
  await writeFile(path.join(linked, 'governed/state.txt'), 'before\n');
  const snapshot = await capturePublicationPreimage(linked, ['governed']);
  await writeFile(path.join(linked, 'governed/state.txt'), 'first interruption\n');
  await restorePublicationPreimage(linked, snapshot, { subject, preserveCurrent: true });
  assert.equal(await exists(path.join(commonParent, migratedName, 'rescue.json')), true);
  assert.equal(await exists(path.join(legacyParent, migratedName)), false);

  const collision = 'story--RESCUE-LINKED--collision';
  await mkdir(path.join(commonParent, collision), { recursive: true });
  await mkdir(path.join(legacyParent, collision), { recursive: true });
  await writeFile(path.join(commonParent, collision, 'rescue.json'), '{"copy":"shared"}\n');
  await writeFile(path.join(legacyParent, collision, 'rescue.json'), '{"copy":"legacy"}\n');
  await writeFile(path.join(linked, 'governed/state.txt'), 'second interruption\n');
  await assert.rejects(
    () => restorePublicationPreimage(linked, snapshot, { subject, preserveCurrent: true }),
    (error) => error.code === 'PUBLICATION_RECOVERY_STORAGE_DIVERGED'
  );
  assert.equal(await readFile(path.join(linked, 'governed/state.txt'), 'utf8'), 'second interruption\n');
  assert.equal(await exists(path.join(commonParent, collision)), true);
  assert.equal(await exists(path.join(legacyParent, collision)), true);
});
