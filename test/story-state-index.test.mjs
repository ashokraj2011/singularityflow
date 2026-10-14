import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, createLedgerIntent } from '../src/ledger.mjs';
import { storyPointersFromLedger } from '../src/story-state-index.mjs';

function entry(id, parent = null, commit = 'a'.repeat(40), extra = {}) {
  const value = { ...createLedgerIntent({ eventType: 'binding', capabilityId: 'test',
    subject: { kind: 'story', workId: id, branch: `feature/${id}` }, actor: { name: 'Fixture' } }),
    parentEntryHash: parent, transport: { publishedCommit: commit }, ...extra };
  const text = canonicalJson(value);
  const hash = createHash('sha256').update(text).digest('hex');
  return { hash, value, file: `ledger/entries/test/${hash}.json`, text };
}

test('state Story discovery follows reachable ledger order, not branch count or clocks', () => {
  const first = entry('A');
  const second = entry('B', first.hash);
  const latest = entry('A', second.hash, 'b'.repeat(40), { createdAt: '2000-01-01T00:00:00Z' });
  const orphan = entry('ORPHAN');
  const files = new Map([first, second, latest, orphan].map(x => [x.file, x.text]));
  const result = storyPointersFromLedger({ sequence: 3, entryHash: latest.hash }, files);
  assert.deepEqual(result.map(x => x.id), ['A', 'B']);
  assert.equal(result[0].commitOid, 'b'.repeat(40));
  assert.equal(result[0].branch, 'feature/A');
});

test('an empty state index is empty; missing, changed and incomplete metadata is refused', () => {
  assert.deepEqual(storyPointersFromLedger({ sequence: 0, entryHash: null }, new Map()), []);
  const valid = entry('A');
  for (const [head, files] of [
    [{ sequence: 1, entryHash: valid.hash }, new Map()],
    [{ sequence: 1, entryHash: valid.hash }, new Map([[valid.file, valid.text.replace('feature/A', 'feature/B')]])],
    [{ sequence: 2, entryHash: valid.hash }, new Map([[valid.file, valid.text]])],
    [{ sequence: 100001, entryHash: null }, new Map()],
    [{ sequence: 0, entryHash: '' }, new Map()]
  ]) assert.throws(() => storyPointersFromLedger(head, files), { code: 'SESSION_STATE_INDEX_INVALID' });
});

test('an explicitly indexed Story with an invalid source pointer is not silently omitted', () => {
  const invalid = entry('A', null, 'short');
  assert.throws(() => storyPointersFromLedger({ sequence: 1, entryHash: invalid.hash },
    new Map([[invalid.file, invalid.text]])), { code: 'SESSION_STATE_INDEX_INVALID' });
});

test('non-Story subjects do not become session candidates', () => {
  const other = entry('INIT', null, 'a'.repeat(40), { subject: { kind: 'initiative', workId: 'INIT', branch: 'initiative' } });
  assert.deepEqual(storyPointersFromLedger({ sequence: 1, entryHash: other.hash }, new Map([[other.file, other.text]])), []);
});

test('state Story discovery extracts Story summary details recorded on the ledger subject', () => {
  const rich = entry('STORY-42', null, 'c'.repeat(40), {
    createdAt: '2026-04-01T12:00:00.000Z',
    subject: {
      kind: 'story',
      workId: 'STORY-42',
      title: 'State-indexed Story',
      workType: 'feature',
      status: 'active',
      phase: 'design',
      currentPhase: 'design',
      progress: { available: true, approved: 1, total: 4 },
      branch: 'feature/STORY-42',
      canonicalBranch: 'feature/STORY-42',
      aliases: ['STORY-42', 'feature/STORY-42'],
      updatedAt: '2026-04-01T12:00:00.000Z'
    }
  });
  const result = storyPointersFromLedger({ sequence: 1, entryHash: rich.hash }, new Map([[rich.file, rich.text]]));
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'STORY-42');
  assert.equal(result[0].story?.title, 'State-indexed Story');
  assert.equal(result[0].story?.status, 'active');
  assert.equal(result[0].story?.phase, 'design');
  assert.deepEqual(result[0].story?.progress, { available: true, approved: 1, total: 4 });
  assert.equal(result[0].story?.commitOid, 'c'.repeat(40));
});

test('a child-branch publication entry omits fast-path story summary without failing the repository index', () => {
  const valid = entry('STORY-1', null, 'a'.repeat(40), {
    subject: {
      kind: 'story',
      workId: 'STORY-1',
      title: 'Valid Story',
      status: 'active',
      progress: { available: true, approved: 1, total: 2 },
      branch: 'feature/STORY-1',
      canonicalBranch: 'feature/STORY-1'
    }
  });
  const childPublished = entry('STORY-2', valid.hash, 'b'.repeat(40), {
    subject: {
      kind: 'story',
      workId: 'STORY-2',
      title: 'Child Branch Story',
      status: 'active',
      progress: { available: true, approved: 0, total: 2 },
      branch: 'feature/STORY-2/child',
      canonicalBranch: 'feature/STORY-2'
    }
  });
  const result = storyPointersFromLedger(
    { sequence: 2, entryHash: childPublished.hash },
    new Map([
      [valid.file, valid.text],
      [childPublished.file, childPublished.text]
    ])
  );
  assert.deepEqual(result.map((item) => item.id), ['STORY-1', 'STORY-2']);
  assert.equal(result[0].story?.title, 'Valid Story');
  assert.equal(result[1].story, undefined);
  assert.equal(result[1].branch, 'feature/STORY-2/child');
});

