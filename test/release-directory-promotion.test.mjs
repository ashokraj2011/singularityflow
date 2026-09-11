import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  promoteReleaseDirectory, recoverReleaseDirectoryPromotion
} from '../src/release-directory-promotion.mjs';

async function fixture(t, { prior = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-release-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'dist');
  const candidate = path.join(root, '.dist-candidate-fixture');
  if (prior) {
    await mkdir(destination);
    await writeFile(path.join(destination, 'value.txt'), 'prior\n');
  }
  await mkdir(candidate);
  await writeFile(path.join(candidate, 'value.txt'), 'candidate\n');
  return { root, destination, candidate };
}

async function absent(file) {
  return (await lstat(file).catch(() => null)) == null;
}

test('release directory promotion swaps a verified same-parent candidate', async (t) => {
  const { root, destination, candidate } = await fixture(t);
  await promoteReleaseDirectory(candidate, destination);
  assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'candidate\n');
  assert.equal(await absent(candidate), true);
  assert.equal(await absent(path.join(root, '.dist.release-previous')), true);
  assert.equal(await absent(path.join(root, '.dist.release-promotion.json')), true);
});

test('next-run recovery restores the prior release after death between the two renames', async (t) => {
  const { root, destination, candidate } = await fixture(t);
  await assert.rejects(promoteReleaseDirectory(candidate, destination, {
    recoverOnError: false,
    afterStep(step) { if (step === 'prior-moved') throw new Error('simulated process death'); }
  }), /simulated process death/);
  assert.equal(await absent(destination), true);
  assert.equal(await absent(path.join(root, '.dist.release-previous')), false);
  assert.equal(await absent(path.join(root, '.dist.release-promotion.json')), false);

  const recovery = await recoverReleaseDirectoryPromotion(destination, { assumeOwnerStopped: true });
  assert.equal(recovery.outcome, 'prior-restored');
  assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'prior\n');
  assert.equal(await absent(candidate), true);
  assert.equal(await absent(path.join(root, '.dist.release-promotion.json')), true);
});

test('next-run recovery retains a candidate that reached dist before process death', async (t) => {
  const { root, destination, candidate } = await fixture(t);
  await assert.rejects(promoteReleaseDirectory(candidate, destination, {
    recoverOnError: false,
    afterStep(step) { if (step === 'candidate-moved') throw new Error('simulated process death'); }
  }), /simulated process death/);
  assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'candidate\n');
  assert.equal(await absent(path.join(root, '.dist.release-previous')), false);

  const recovery = await recoverReleaseDirectoryPromotion(destination, { assumeOwnerStopped: true });
  assert.equal(recovery.outcome, 'promotion-retained');
  assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'candidate\n');
  assert.equal(await absent(path.join(root, '.dist.release-previous')), true);
  assert.equal(await absent(path.join(root, '.dist.release-promotion.json')), true);
});

test('ordinary promotion errors restore the prior state before returning', async (t) => {
  const { root, destination, candidate } = await fixture(t);
  await assert.rejects(promoteReleaseDirectory(candidate, destination, {
    afterStep(step) { if (step === 'prior-moved') throw new Error('ordinary failure'); }
  }), /ordinary failure/);
  assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'prior\n');
  assert.equal(await absent(candidate), true);
  assert.equal(await absent(path.join(root, '.dist.release-previous')), true);
  assert.equal(await absent(path.join(root, '.dist.release-promotion.json')), true);
});

test('next-run recovery preserves the intentional absence of a prior release', async (t) => {
  const { root, destination, candidate } = await fixture(t, { prior: false });
  await assert.rejects(promoteReleaseDirectory(candidate, destination, {
    recoverOnError: false,
    afterStep(step) { if (step === 'prior-moved') throw new Error('simulated process death'); }
  }), /simulated process death/);
  assert.equal(await absent(destination), true);
  assert.equal(await absent(candidate), false);

  const recovery = await recoverReleaseDirectoryPromotion(destination, { assumeOwnerStopped: true });
  assert.equal(recovery.outcome, 'prior-absence-retained');
  assert.equal(await absent(destination), true);
  assert.equal(await absent(candidate), true);
  assert.equal(await absent(path.join(root, '.dist.release-promotion.json')), true);
});

test('an orphaned prior release without a journal is never trusted or moved', async (t) => {
  const { root, destination } = await fixture(t);
  const backup = path.join(root, '.dist.release-previous');
  await rm(path.join(root, '.dist-candidate-fixture'), { recursive: true, force: true });
  await rename(destination, backup);
  await assert.rejects(recoverReleaseDirectoryPromotion(destination), /no durable promotion journal/);
  assert.equal(await absent(destination), true);
  assert.equal(await readFile(path.join(backup, 'value.txt'), 'utf8'), 'prior\n');
});

test('a corrupt promotion journal refuses recovery without changing public paths', async (t) => {
  const { root, destination, candidate } = await fixture(t);
  const journal = path.join(root, '.dist.release-promotion.json');
  await writeFile(journal, '{not-json}\n');
  await assert.rejects(recoverReleaseDirectoryPromotion(destination), /invalid JSON/);
  assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'prior\n');
  assert.equal(await readFile(path.join(candidate, 'value.txt'), 'utf8'), 'candidate\n');
});

test('a competing promotion cannot reinterpret a live executor journal as crash recovery', async (t) => {
  const { destination, candidate } = await fixture(t);
  const secondCandidate = path.join(path.dirname(destination), '.dist-candidate-second');
  await mkdir(secondCandidate);
  await writeFile(path.join(secondCandidate, 'value.txt'), 'second\n');
  let releaseFirst;
  const firstPaused = new Promise((resolve) => { releaseFirst = resolve; });
  let continueFirst;
  const firstCanContinue = new Promise((resolve) => { continueFirst = resolve; });
  const first = promoteReleaseDirectory(candidate, destination, {
    async afterStep(step) {
      if (step === 'journal-durable') {
        releaseFirst();
        await firstCanContinue;
      }
    }
  });
  await firstPaused;
  await assert.rejects(promoteReleaseDirectory(secondCandidate, destination),
    /currently owned by live process/);
  continueFirst();
  await first;
  assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'candidate\n');
  assert.equal(await readFile(path.join(secondCandidate, 'value.txt'), 'utf8'), 'second\n');
});
