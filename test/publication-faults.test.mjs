import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import { commitIsolated } from '../src/git.mjs';
import { readPendingPublication } from '../src/publication-pending.mjs';
import { publicationJournalPath } from '../src/publication-journal.mjs';
import { acquireSubjectLock, releaseSubjectLock, subjectLockPath } from '../src/subject-lock.mjs';

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
const eventModule = pathToFileURL(path.join(packageRoot, 'src/lifecycle-event.mjs')).href;

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
