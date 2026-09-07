import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function repository(parent, name, changed) {
  const root = path.join(parent, name);
  await mkdir(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Private Corpus Person']);
  git(root, ['config', 'user.email', 'private-corpus@example.invalid']);
  await writeFile(path.join(root, 'private-source.txt'), 'before\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  if (changed) {
    await writeFile(path.join(root, 'private-source.txt'), 'after\n');
    await writeFile(path.join(root, 'private-untracked.txt'), 'new\n');
  }
  return root;
}

test('real CMP corpus measurement aggregates repositories without leaking or changing them', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-real-corpus-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const changed = await repository(parent, 'customer-payments-secret', true);
  const clean = await repository(parent, 'customer-ledger-secret', false);
  const beforeChanged = git(changed, ['status', '--porcelain=v1', '-z']);
  const beforeClean = git(clean, ['status', '--porcelain=v1', '-z']);

  const result = spawnSync(process.execPath, [
    'scripts/cmp-corpus-measurement.mjs', '--samples', '2',
    '--repository', changed, '--repository', clean, '--base', 'HEAD'
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'sflow-cmp-real-corpus/v1');
  assert.equal(report.assurance, 'content-free-local-measurement');
  assert.equal(report.authority, 'none');
  assert.equal(report.repositoryCount, 2);
  assert.equal(report.requestedSamplesPerRepository, 2);
  assert.equal(report.completedMeasurements, 4);
  assert.equal(report.counts.repositoriesWithChanges, 1);
  assert.equal(report.counts.repositoriesWithoutChanges, 1);
  assert.equal(report.counts.regions, 2);
  assert.equal(report.counts.materialRegions, 2);
  assert.equal(report.counts.unresolved, 2);
  assert.equal(report.availability.model, 'not-invoked');
  assert.equal(report.availability.structuralExtraction, 'not-invoked');
  assert.equal(report.availability.network, 'not-invoked');
  assert.equal(report.repositoryState, 'unchanged-observed');
  assert.equal(report.lifecycleGate, false);
  assert.equal(report.authoritative, false);
  assert.ok(report.storageBytesPerRepository.recordModePreview.maximum > 0);
  assert.equal(git(changed, ['status', '--porcelain=v1', '-z']), beforeChanged);
  assert.equal(git(clean, ['status', '--porcelain=v1', '-z']), beforeClean);
  assert.equal(await readFile(path.join(changed, 'private-source.txt'), 'utf8'), 'after\n');

  const serialized = JSON.stringify(report);
  for (const forbidden of [
    parent, 'customer-payments-secret', 'customer-ledger-secret', 'private-source.txt',
    'private-untracked.txt', 'Private Corpus Person', 'private-corpus@example.invalid', 'sha256:'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('real CMP corpus measurement refuses unsafe inputs without echoing their path', async () => {
  const secret = path.join(os.tmpdir(), 'definitely-missing-private-corpus');
  const result = spawnSync(process.execPath, [
    'scripts/cmp-corpus-measurement.mjs', '--repository', secret, '--samples', '1'
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CMP_REAL_CORPUS_INVALID/);
  assert.doesNotMatch(result.stderr, /definitely-missing-private-corpus/);
});

test('real CMP corpus measurement refuses ranges, duplicates, and unbounded fan-out', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-real-corpus-bounds-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await repository(parent, 'one', true);
  for (const args of [
    ['--repository', root, '--base', 'HEAD..main'],
    ['--repository', root, '--repository', root],
    ['--repository', root, '--samples', '21']
  ]) {
    const result = spawnSync(process.execPath, ['scripts/cmp-corpus-measurement.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CMP_REAL_CORPUS_INVALID/);
  }
});
