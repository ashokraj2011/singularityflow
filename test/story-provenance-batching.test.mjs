import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { readStoryPathHistory } from '../src/story-path-history.mjs';
import { storyTreeListing, withStoryTreeReads, withStoryHistoryBatch } from '../src/story-tree-read.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provenance-batch-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Provenance Tester');
  git('config', 'user.email', 'provenance@example.invalid');
  await mkdir(path.join(root, 'story/evidence'), { recursive: true });
  const write = (name, content) => writeFile(path.join(root, name), content);
  await write('story/evidence/a.json', 'A\n'); await write('story/evidence/b.json', 'B\n');
  const commit = message => { git('add', '-A'); return git('-c', 'commit.gpgsign=false', 'commit', '-qm', message); };
  commit('first');
  return { root, git, write, commit };
}

test('batched exact Story history preserves first-add/touches, rename and restored-byte detection', async t => {
  const f = await fixture(t);
  await f.write('story/evidence/a.json', 'changed\n'); f.commit('change');
  await f.write('story/evidence/a.json', 'A\n'); f.commit('restore');
  f.git('mv', 'story/evidence/b.json', 'story/evidence/c.json'); f.commit('rename');
  for (const name of ['a.json', 'b.json', 'c.json', 'absent.json']) {
    const relative = `story/evidence/${name}`;
    const exact = readStoryPathHistory(f.root, relative, name);
    const batched = withStoryHistoryBatch(f.root, ['story/evidence'], () => readStoryPathHistory(f.root, relative, name));
    assert.deepEqual(batched, exact, name);
  }
  assert.equal(readStoryPathHistory(f.root, 'story/evidence/a.json', 'a').touches.length, 3);
});

test('history scopes invalidate after a commit and retain exact-path traversal for merge graphs', async t => {
  const f = await fixture(t);
  await withStoryHistoryBatch(f.root, ['story/evidence'], async () => {
    assert.equal(readStoryPathHistory(f.root, 'story/evidence/a.json', 'a').touches.length, 1);
    await f.write('story/evidence/a.json', 'second\n'); f.commit('second');
    assert.equal(readStoryPathHistory(f.root, 'story/evidence/a.json', 'a').touches.length, 2);
  });
  f.git('switch', '-qc', 'side');
  await f.write('story/evidence/b.json', 'side\n'); f.commit('side');
  f.git('switch', '-q', 'main');
  await f.write('unrelated.txt', 'main\n'); f.commit('main');
  f.git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-qm', 'merge', 'side');
  for (const name of ['a.json', 'b.json', 'absent.json']) {
    const relative = `story/evidence/${name}`, expected = readStoryPathHistory(f.root, relative, name);
    assert.deepEqual(withStoryHistoryBatch(f.root, ['story/evidence'], () => readStoryPathHistory(f.root, relative, name)), expected);
  }
});

test('tree acquisition batches selected namespaces, invalidates HEAD and does not leak across scopes', async t => {
  const f = await fixture(t);
  assert.equal(storyTreeListing(f.root, 'HEAD', ['story/evidence/a.json']), null);
  await withStoryTreeReads(f.root, ['story/evidence'], async () => {
    const before = storyTreeListing(f.root, 'HEAD', ['story/evidence/a.json']);
    assert.match(before.stdout.toString(), /100644 blob [a-f0-9]+\tstory\/evidence\/a.json\0/u);
    assert.equal(storyTreeListing(f.root, 'HEAD', ['unrelated.txt']), null);
    assert.equal(storyTreeListing(f.root, 'HEAD', ['story/evidence/absent.json']).stdout.length, 0);
    await f.write('story/evidence/a.json', 'new\n'); f.commit('new');
    assert.notDeepEqual(storyTreeListing(f.root, 'HEAD', ['story/evidence/a.json']).stdout, before.stdout);
  });
  assert.equal(storyTreeListing(f.root, 'HEAD', ['story/evidence/a.json']), null);
});

test('failed Git history is refused rather than accepted as a missing immutable record', async t => {
  const f = await fixture(t);
  await assert.rejects(withStoryHistoryBatch(f.root, ['story/evidence'], async () => {
    f.git('config', 'extensions.refStorage', 'unsupported-fixture-storage');
    readStoryPathHistory(f.root, 'story/evidence/a.json', 'evidence');
  }), { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
});
