import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import { commitIsolated, gitDir } from '../src/git.mjs';
import {
  discardCleanPreparedPublication, livePreparedPublicationOwner, readPendingPublication,
  recoverPreparedPublication, recoverPreparedPublicationBySubject
} from '../src/publication-pending.mjs';
import { capturePublicationPreimage, restorePublicationPreimage } from '../src/publication-recovery.mjs';
import { beginPublicationJournal, publicationJournalPath } from '../src/publication-journal.mjs';
import { acquireSubjectLock, releaseSubjectLock, subjectLockPath } from '../src/subject-lock.mjs';
import { runDraftTransaction } from '../src/draft-unit-of-work.mjs';

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

const stages = ['after-state-write', 'after-commit', 'after-push', 'after-ledger'];
const kinds = ['story', 'initiative'];
const publicationModule = pathToFileURL(path.join(packageRoot, 'src/publication-unit-of-work.mjs')).href;
const draftModule = pathToFileURL(path.join(packageRoot, 'src/draft-unit-of-work.mjs')).href;
const eventModule = pathToFileURL(path.join(packageRoot, 'src/lifecycle-event.mjs')).href;
const recoveryModule = pathToFileURL(path.join(packageRoot, 'src/publication-recovery.mjs')).href;

async function crashPublication(root, subject, target, stage, { mode = 'required' } = {}) {
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

test('an outer draft cannot erase a nested publication recovery record', async () => {
  const root = await repository('sflow-nested-publication-');
  const subject = { kind: 'story', id: 'NESTED-RECOVERY', branch: 'main' };
  const target = 'nested-state.json';
  await writeFile(path.join(root, target), '{"status":"before"}\n');
  git(['add', target], root);
  git(['commit', '-m', 'nested baseline'], root);

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
