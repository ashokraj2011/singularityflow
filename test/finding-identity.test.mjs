/**
 * Gate problems are named by canonical finding ID, so a dispute matches its finding whatever the
 * sentence says, and a dispute recorded before IDs keeps matching its exact sentence. [SDA-AC-022]
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CANONICAL_FINDING_ID, canonicalFinding, canonicalFindingId } from '../src/finding-identity.mjs';
import { disputeCovers, disputeEntries } from '../src/phase-finding-dispute.mjs';

const unattached = { code: 'code.delivery.acceptance-tag-unattached', value: 'W:AC-001' };

test('a finding ID is its code, path and value: stable across wording and lines, distinct otherwise', () => {
  const id = canonicalFindingId(unattached);
  assert.match(id, CANONICAL_FINDING_ID);
  // Wording and line numbers are not inputs at all; the same identity is the same ID.
  assert.equal(canonicalFindingId({ ...unattached, path: null }), id);
  assert.equal(canonicalFindingId({ code: 'code.delivery.acceptance-tag-unattached', path: undefined, value: 'W:AC-001' }), id);
  assert.notEqual(canonicalFindingId({ ...unattached, code: 'code.delivery.acceptance-tag-missing' }), id);
  assert.notEqual(canonicalFindingId({ ...unattached, value: 'W:AC-002' }), id);
  assert.notEqual(canonicalFindingId({ ...unattached, path: 'test/a.test.mjs' }), id);
  // An aggregated sentence is one finding over a set of clause IDs: order and repeats do not count.
  const missing = (value) => canonicalFindingId({ code: 'code.delivery.source-clause-tag-missing', value });
  assert.equal(missing(['W:REQ-002', 'W:REQ-001']), missing(['W:REQ-001', 'W:REQ-002', 'W:REQ-001']));
  assert.notEqual(missing(['W:REQ-001']), missing(['W:REQ-001', 'W:REQ-002']));
  assert.deepEqual(canonicalFinding({ code: 'code.delivery.source-clause-tag-missing', value: ['B', 'A'] }),
    { id: missing(['A', 'B']), code: 'code.delivery.source-clause-tag-missing', path: null, value: ['A', 'B'] });
});

test('a dispute keyed by finding ID covers its finding after the sentence changes', () => {
  const finding = canonicalFinding(unattached);
  const entries = disputeEntries(['@ac:W:AC-001 is not on a test: test/a.test.mjs:4 (no declaration).'], [finding]);
  assert.equal(entries[0], `${finding.id} @ac:W:AC-001 is not on a test: test/a.test.mjs:4 (no declaration).`);
  assert.equal(disputeCovers(entries, [{ id: finding.id, problem: '@ac:W:AC-001 is not on a test: test/a.test.mjs:4 (no declaration).' }]), true);
  assert.equal(disputeCovers(entries, [{ id: finding.id, problem: '@ac:W:AC-001 sits on no test at test/a.test.mjs:12.' }]), true,
    'a reworded sentence or a moved line is still the disputed finding');
  const other = canonicalFindingId({ ...unattached, value: 'W:AC-002' });
  assert.equal(disputeCovers(entries, [{ id: finding.id, problem: 'x' }, { id: other, problem: 'y' }]), false,
    'a new finding is never covered');
  // Each entry stays within the schema's 2,000 characters and keeps its ID.
  const [long] = disputeEntries(['x'.repeat(2500)], [finding]);
  assert.equal(long.length, 2000);
  assert.equal(disputeCovers([long], [{ id: finding.id, problem: 'x'.repeat(2500) }]), true);
});

test('a dispute recorded before IDs matches its exact sentence, the migration alias, and nothing else', () => {
  const sentence = 'no acceptance test is available for the implementation';
  const id = canonicalFindingId({ code: 'code.delivery.acceptance-test-missing' });
  assert.equal(disputeCovers([sentence], [{ id, problem: sentence }]), true);
  assert.equal(disputeCovers([sentence], [{ id: null, problem: sentence }]), true);
  assert.equal(disputeCovers([sentence], [{ id, problem: 'no acceptance test is available for this implementation' }]), false,
    'a sentence-keyed record still breaks on rewording; only an ID-keyed one survives it');
  // Without an ID (an older gate's observation) a new record does not cover by ID.
  assert.deepEqual(disputeEntries([sentence]), [sentence]);
});
