import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sourceReviewProvenanceObjects, withSourceReviewSnapshot, prefetchSourceReviewFiles,
  committedSourceReviewFile } from '../src/source-review-snapshot.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';
import { clearGitFactCache, withFreshGitFacts } from '../src/git-fact-cache.mjs';

test('immutable provenance batches cold objects, reuses warm proofs, and bypasses them at retention', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Review Tester');
  git('config', 'user.email', 'review@example.test'); git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'a.json'), '{"one":1}\n');
  await writeFile(path.join(root, 'b.json'), '{"two":2}\n');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Original');
  const first = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'a.json'), '{"one":2}\n');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Second');
  const head = git('rev-parse', 'HEAD');
  const specs = [`${head}:a.json`, `${head}:b.json`, `${head}^:a.json`];
  const counters = {};
  const timer = { increment: (name, n) => { counters[name] = (counters[name] ?? 0) + n; }, measure: (_name, read) => read() };
  clearGitFactCache();
  const read = () => withCommandTiming(timer, () => sourceReviewProvenanceObjects(root, specs));
  const cold = read();
  assert.equal(counters['git.spawns'], 1);
  assert.equal(read().get(specs[0]).stdout.toString(), cold.get(specs[0]).stdout.toString());
  assert.equal(counters['git.spawns'], 1, 'warm proof needs no child process');
  assert.equal(counters['source-review.provenance-hits'], 3);
  withFreshGitFacts(read);
  assert.equal(counters['git.spawns'], 2, 'fresh proof must actually ask Git again');
  await writeFile(path.join(root, '.git', 'shallow'), `${head}\n`);
  assert.notEqual(read().get(`${head}^:a.json`).status, 0, 'shallow history cannot reuse the parent proof');
  await rm(path.join(root, '.git', 'shallow'));
  const oid = git('rev-parse', `${first}:a.json`);
  const oldSpec = `${first}:a.json`;
  sourceReviewProvenanceObjects(root, [oldSpec]);
  await rm(path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  assert.notEqual(sourceReviewProvenanceObjects(root, [oldSpec]).get(oldSpec).status, 0,
    'a missing Git object invalidates cached provenance');
});

test('many individually legal attachments cannot exhaust memory through review prefetch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Review Tester');
  git('config', 'user.email', 'review@example.test'); git('config', 'core.autocrlf', 'false');
  const names = ['one.bin', 'two.bin', 'three.bin'];
  for (const [index, name] of names.entries()) await writeFile(path.join(root, name), Buffer.alloc(12 * 1024 * 1024, index));
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Large legal attachments');
  const counters = {};
  const timer = { increment: (name, n) => { counters[name] = (counters[name] ?? 0) + n; }, measure: (_name, read) => read() };
  await withCommandTiming(timer, () => withSourceReviewSnapshot(root, async () => {
    await prefetchSourceReviewFiles(root, names);
    for (const name of names) assert.equal(committedSourceReviewFile(root, name).stdout.length, 12 * 1024 * 1024);
  }));
  assert.equal(counters['source-review.blob-hits'], 2, 'third file takes the bounded individual fallback');
});
