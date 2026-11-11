/**
 * A witness is named as a person reads it, its criterion and its number among several, and that name binds
 * exactly the submitted mapping its digest did [no hashes shown].
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { namedWitnessText, resolveWitnessNames, WITNESS_NAME, witnessNames } from '../src/witness-names.mjs';

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const mappings = [
  { clauseId: 'PAY-1:AC-002', sourcePath: 'test/b.test.mjs', test: 'second', mappingSha256: digest('b') },
  { clauseId: 'PAY-1:AC-001', sourcePath: 'test/a.test.mjs', test: 'only', mappingSha256: digest('a') },
  { clauseId: 'PAY-1:AC-002', sourcePath: 'test/a.test.mjs', test: 'first', mappingSha256: digest('c') }
];

test('a witness is its criterion, numbered only when the criterion has several, in the same order whatever the list order', () => {
  const names = witnessNames(mappings);
  assert.equal(names.get(digest('a')), 'PAY-1:AC-001');
  assert.equal(names.get(digest('c')), 'PAY-1:AC-002#1', 'ordered by test file, then test');
  assert.equal(names.get(digest('b')), 'PAY-1:AC-002#2');
  assert.deepEqual(witnessNames([...mappings].reverse()), names, 'the same submitted set gives the same names');
  for (const name of names.values()) assert.match(name, WITNESS_NAME);
});

test('a named decision binds the digest of the mapping that name stands for; a digest or an unknown name is left as given', () => {
  const resolved = resolveWitnessNames([{ mappingSha256: 'PAY-1:AC-002#2', decision: 'not-applicable' }, { mappingSha256: digest('a'), decision: 'satisfied' },
    { mappingSha256: 'PAY-1:AC-009', decision: 'satisfied' }], mappings);
  assert.deepEqual(resolved.map((entry) => entry.mappingSha256), [digest('b'), digest('a'), 'PAY-1:AC-009']);
  assert.equal(resolved[0].decision, 'not-applicable');
  assert.equal(namedWitnessText(`unknown witness mapping '${digest('c')}'`, mappings), "unknown witness mapping 'PAY-1:AC-002#1'");
});
