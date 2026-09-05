import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateWitnessMappingReview } from '../src/wel-review.mjs';
import { recordSha256 } from '../src/records.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;

function mapping(overrides = {}) {
  const core = {
    sourceProposalSha256: digest('b'),
    clauseId: 'WRK-1:AC-001',
    witnessType: 'test',
    executionProfile: 'junit5-surefire-v1',
    clauseBodySha256: digest('c'),
    logicalTestId: digest('d'),
    sourcePath: 'src/test/java/example/OrderTest.java',
    sourceDeclarationSha256: digest('e'),
    parserManifestSha256: digest('f'),
    ...overrides
  };
  return { mappingSha256: `sha256:${recordSha256(core)}`, ...core };
}

test('an approval without witness proposals remains backward compatible', () => {
  assert.deepEqual(evaluateWitnessMappingReview(), {
    valid: true,
    errors: [],
    decisions: []
  });
});

test('every exact witness proposal requires an explicit human decision', () => {
  const result = evaluateWitnessMappingReview({ mappings: [mapping()] });
  assert.equal(result.valid, false);
  assert.deepEqual(result.decisions, []);
  assert.match(result.errors[0], /has no review decision/);
});

test('satisfied witness review binds the exact proposal and clause identities', () => {
  const result = evaluateWitnessMappingReview({
    mappings: [mapping()],
    decisions: [{ mappingSha256: mapping().mappingSha256, decision: 'satisfied' }]
  });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.decisions, [{
    mappingSha256: mapping().mappingSha256,
    sourceProposalSha256: digest('b'),
    clauseId: 'WRK-1:AC-001',
    clauseBodySha256: digest('c'),
    logicalTestId: digest('d'),
    sourceDeclarationSha256: digest('e'),
    decision: 'satisfied',
    reason: null,
    expiresAt: null
  }]);
});

test('exceptions require a reason and a future expiry', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const missing = evaluateWitnessMappingReview({
    mappings: [mapping()],
    decisions: [{ mappingSha256: mapping().mappingSha256, decision: 'exception' }],
    now
  });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join('\n'), /requires a reason/);

  const expired = evaluateWitnessMappingReview({
    mappings: [mapping()],
    decisions: [{
      mappingSha256: mapping().mappingSha256, decision: 'exception', reason: 'Temporary compatibility gap',
      expiresAt: '2025-12-31T00:00:00.000Z'
    }],
    now
  });
  assert.equal(expired.valid, false);
  assert.match(expired.errors.join('\n'), /future ISO expiry/);

  const accepted = evaluateWitnessMappingReview({
    mappings: [mapping()],
    decisions: [{
      mappingSha256: mapping().mappingSha256, decision: 'exception', reason: 'Temporary compatibility gap',
      expiresAt: '2026-02-01T00:00:00Z'
    }],
    now
  });
  assert.equal(accepted.valid, true, accepted.errors.join('\n'));
  assert.equal(accepted.decisions[0].expiresAt, '2026-02-01T00:00:00.000Z');
});

test('unknown and duplicate mapping decisions fail closed', () => {
  const result = evaluateWitnessMappingReview({
    mappings: [mapping()],
    decisions: [
      { mappingSha256: digest('f'), decision: 'satisfied' },
      { mappingSha256: mapping().mappingSha256, decision: 'satisfied' },
      { mappingSha256: mapping().mappingSha256, decision: 'satisfied' }
    ]
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /unknown witness mapping/);
  assert.match(result.errors.join('\n'), /decided more than once/);
});
