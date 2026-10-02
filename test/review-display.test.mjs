import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { phaseDisplayBinding, phaseDocumentVersionMatches } from '../src/review-display.mjs';

const root = path.resolve('display-fixture');
const phase = { id: 'design', generation: 2 };
function document(id = 'ART-1', content = 'Complete design — verified.\n') {
  return {
    id, kind: 'design', path: `artifacts/design/${id}.md`, generation: 2,
    size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
    binary: false, truncated: false, content
  };
}
const binding = (documents = [document()], selectedPhase = phase) =>
  phaseDisplayBinding(root, 'DISPLAY-1', selectedPhase, documents);

test('display identity survives lifecycle metadata changes but never contains approval authority', () => {
  const published = binding(undefined, { ...phase, status: 'in_progress' });
  assert.deepEqual(binding(undefined, { ...phase, status: 'awaiting_approval' }), published);
  assert.deepEqual(Object.keys(published), ['schemaVersion', 'repositoryPath', 'workId', 'phase', 'generation', 'documents']);
  assert.equal(published.repositoryPath, root);
  assert.equal(published.documents[0].sha256, document().sha256);
});

test('display identity is stable for document order and changes with every content identity', () => {
  const first = document('A'), second = document('B');
  assert.deepEqual(binding([first, second]), binding([second, first]));
  for (const changed of [
    { ...first, id: 'C' }, { ...first, path: 'artifacts/another.md' },
    { ...first, kind: 'agent-brief' }, document('A', 'Changed design.\n')
  ]) assert.notDeepEqual(binding([changed, second]), binding([first, second]));
  assert.notDeepEqual(binding([first]), binding([first, second]));
  assert.notDeepEqual(phaseDisplayBinding(root, 'OTHER', phase, [first]), binding([first]));
  assert.notDeepEqual(phaseDisplayBinding(path.join(root, 'other'), 'DISPLAY-1', phase, [first]), binding([first]));
  assert.notDeepEqual(binding([first], { ...phase, id: 'review' }), binding([first]));
  assert.notDeepEqual(binding([{ ...first, generation: 3 }], { ...phase, generation: 3 }), binding([first]));
});

test('partial, unavailable, stale, ambiguous and unverified document sets cannot be reused', () => {
  const good = document();
  for (const changed of [
    { ...good, error: 'unavailable' }, { ...good, truncated: true },
    { ...good, truncated: undefined }, { ...good, content: 'summary' },
    { ...good, content: undefined }, { ...good, size: good.size + 1 },
    { ...good, sha256: 'f'.repeat(64) }, { ...good, sha256: null },
    { ...good, generation: 1 }, { ...good, binary: undefined },
    { ...good, id: '' }, { ...good, kind: '' }, { ...good, path: '' }
  ]) assert.equal(binding([changed]), null);
  assert.equal(binding([]), null);
  assert.equal(binding([good, good]), null);
  assert.equal(binding([good, { ...good, id: 'OTHER' }]), null);
  assert.equal(binding([good], { ...phase, generation: 0 }), null);
});

test('source previews need complete hash-verified full text, not merely matching preview metadata', () => {
  const source = document('CODE', 'export const value = 42;\n');
  const complete = {
    ...source, kind: 'code', content: undefined,
    display: { preview: 'export', truncated: true, full: source.content }
  };
  assert.ok(binding([complete]));
  assert.equal(binding([{ ...complete, display: { ...complete.display, full: null } }]), null);
  assert.equal(binding([{ ...complete, display: { ...complete.display, full: 'export' } }]), null);
});

test('verified binaries bind metadata only, without claiming text or human visual review', () => {
  const binary = { ...document(), kind: 'image', binary: true, content: null };
  assert.equal(binding([binary]).documents[0].binary, true);
  assert.equal(binding([{ ...binary, truncated: true }]), null);
});

test('catalog/read drift is rejected for binary documents before they enter a review', () => {
  const record = { ...document(), binary: true };
  const viewed = { verifiedSha256: record.sha256, size: record.size, binary: true };
  assert.equal(phaseDocumentVersionMatches(record, viewed), true);
  assert.equal(phaseDocumentVersionMatches(record, { ...viewed, verifiedSha256: 'f'.repeat(64) }), false);
  assert.equal(phaseDocumentVersionMatches(record, { ...viewed, size: record.size + 1 }), false);
  assert.equal(phaseDocumentVersionMatches(record, { ...viewed, verifiedSha256: undefined }), false);
});
