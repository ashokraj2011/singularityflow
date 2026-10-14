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
