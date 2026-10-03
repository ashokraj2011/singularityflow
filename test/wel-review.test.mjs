import assert from 'node:assert/strict';
import test from 'node:test';

import { ADEQUACY_FACETS, evaluateWitnessMappingReview } from '../src/wel-review.mjs';
import { recordSha256 } from '../src/records.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-01-01T00:00:00.000Z');

function mapping(overrides = {}) {
  const core = {
    clauseId: 'WRK-1:AC-001',
    witnessType: 'test',
    executionProfile: 'junit5-surefire-v2',
    logicalTestId: digest('d'),
    sourcePath: 'src/test/java/example/OrderTest.java',
    sourceDeclarationSha256: digest('e'),
    supportSha256: digest('f'),
    clauseBodySha256: digest('c'),
    contractSha256: digest('a'),
    slot: 'tests',
    ...overrides
  };
  return { mappingSha256: `sha256:${recordSha256(core)}`, ...core };
}
const allAdequate = Object.fromEntries(ADEQUACY_FACETS.map((facet) => [facet, 'adequate']));

test('an approval without witness proposals records nothing', () => {
  assert.deepEqual(evaluateWitnessMappingReview(), { valid: true, errors: [], decisions: [] });
});

test('approving accepts every undecided witness as adequate on all five facets, as one batch', () => {
  const result = evaluateWitnessMappingReview({ mappings: [mapping()], now: NOW });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.decisions, [{
    mappingSha256: mapping().mappingSha256, clauseId: 'WRK-1:AC-001', clauseBodySha256: digest('c'),
    logicalTestId: digest('d'), sourcePath: 'src/test/java/example/OrderTest.java', sourceDeclarationSha256: digest('e'),
    slot: 'tests', decision: 'satisfied', reason: null, expiresAt: null, adequacy: allAdequate, source: 'batch'
  }]);
});

test('every exact adapter profile can be reviewed; anything else fails closed', () => {
  for (const executionProfile of ['junit5-surefire-v2', 'junit5-gradle-v2', 'jest-static-v2', 'vitest-static-v2']) {
    assert.equal(evaluateWitnessMappingReview({ mappings: [mapping({ executionProfile })], now: NOW }).valid, true, executionProfile);
  }
  for (const executionProfile of ['junit5-surefire-v1', 'module-counts-v1', 'generic-json-v1']) {
    assert.equal(evaluateWitnessMappingReview({ mappings: [mapping({ executionProfile })], now: NOW }).valid, false, executionProfile);
  }
  const tampered = { ...mapping(), sourceDeclarationSha256: digest('9') };
  assert.match(evaluateWitnessMappingReview({ mappings: [tampered], now: NOW }).errors.join('\n'), /invalid or repeated witness mapping/);
});

test('an exception names its inadequate facets, a reason and a future expiry; ruling a test out needs a reason', () => {
  const sha = mapping().mappingSha256;
  const review = (decision) => evaluateWitnessMappingReview({ mappings: [mapping()], decisions: [{ mappingSha256: sha, ...decision }], now: NOW });
  assert.match(review({ decision: 'exception', inadequate: ['boundaries'] }).errors.join('\n'), /requires a reason/);
  assert.match(review({ decision: 'exception', reason: 'No negative amounts yet', expiresAt: '2026-02-01' }).errors.join('\n'), /must name its inadequate facets/);
  assert.match(review({ decision: 'exception', inadequate: ['vibes'], reason: 'No negative amounts yet', expiresAt: '2026-02-01' }).errors.join('\n'), /must name its inadequate facets/);
  assert.match(review({ decision: 'exception', inadequate: ['boundaries'], reason: 'No negative amounts yet', expiresAt: '2025-12-31' }).errors.join('\n'), /future ISO expiry/);
  const excepted = review({ decision: 'exception', inadequate: ['boundaries', 'assertions'], reason: 'No negative amounts yet', expiresAt: '2026-02-01T00:00:00Z' });
  assert.equal(excepted.valid, true, excepted.errors.join('\n'));
  assert.deepEqual(excepted.decisions[0].adequacy, { ...allAdequate, assertions: 'inadequate', boundaries: 'inadequate' });
  assert.equal(excepted.decisions[0].expiresAt, '2026-02-01T00:00:00.000Z');
  assert.equal(excepted.decisions[0].source, 'explicit');
  assert.match(review({ decision: 'not-applicable' }).errors.join('\n'), /requires a reason for not-applicable/);
  const ruledOut = review({ decision: 'not-applicable', reason: 'This test checks the totals, not the refund.' });
  assert.equal(ruledOut.decisions[0].adequacy, null);
});

test('a decision on an identical witness carries forward; a lapsed exception or any changed digest does not', () => {
  const prior = [{ mappingSha256: mapping().mappingSha256, decision: 'not-applicable', reason: 'Checks the totals only.', adequacy: null }];
  const carried = evaluateWitnessMappingReview({ mappings: [mapping()], prior, now: NOW });
  assert.equal(carried.decisions[0].decision, 'not-applicable');
  assert.equal(carried.decisions[0].source, 'carried-forward');
  const changed = evaluateWitnessMappingReview({ mappings: [mapping({ sourceDeclarationSha256: digest('7') })], prior, now: NOW });
  assert.equal(changed.decisions[0].source, 'batch', 'a new revision of the test is a new witness');
  const lapsed = evaluateWitnessMappingReview({
    mappings: [mapping()], now: NOW,
    prior: [{ mappingSha256: mapping().mappingSha256, decision: 'exception', reason: 'Gap', expiresAt: '2025-12-01T00:00:00.000Z' }]
  });
  assert.equal(lapsed.decisions[0].source, 'batch');
});

test('unknown and duplicate witness decisions fail closed', () => {
  const result = evaluateWitnessMappingReview({
    mappings: [mapping()], now: NOW,
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
