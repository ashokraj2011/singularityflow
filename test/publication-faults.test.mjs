import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
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
