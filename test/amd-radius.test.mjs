/**
 * What an amendment changed, and who it reaches. `[AMD:REQ-011]` `[AMD:REQ-020]` `[AMD:REQ-021]`
 *
 * Both computations are deterministic and take no model `[AMD:CON-003]`: the kernel says what moved
 * and who is downstream of it, and a human decides what to do. Nothing here reopens a phase or
 * stales an approval.
 *
 * The clauses and claim maps are built with the shipped extractor and normalizer rather than by
 * hand, so a change to either shape fails here instead of at the first real amendment.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { blastRadius, clauseDiff, radiusSummary } from '../src/amendment.mjs';
import { extractClauses, normalizeClaimMap } from '../src/specifications.mjs';

const G2 = `# Spec
- The system retries a failed payment. [S:REQ-001]
- The system preserves the original attempt. [S:REQ-002]
- The operator sees the retry outcome. [S:REQ-003]
`;

// REQ-002 reworded, REQ-003 removed, REQ-004 added. REQ-001 untouched.
const G3 = `# Spec
- The system retries a failed payment. [S:REQ-001]
- The system preserves the original attempt **and its provider response**. [S:REQ-002]
- The operator may cancel a retry in flight. [S:REQ-004]
`;

/**
 * Anchors are bare, not backticked. A backticked anchor sits in an ignored range on purpose — that
 * is what stops a template's own example clauses being inherited by every Story built from it.
 */
const clauses = (markdown) => extractClauses(markdown, { sourcePath: 'spec.md' });
const diffOfShipped = () => clauseDiff(clauses(G2), clauses(G3), { beforeMarkdown: G2, afterMarkdown: G3 });

test('both-doors-mint-a-generation', () => {
  /**
   * `[AMD:AC-001]`, at the half that is computable: whichever door produced the new generation, the
   * changed-clause set is derived from the two texts rather than trusted from the author.
   */
  const diff = diffOfShipped();
  assert.deepEqual([...diff.added], ['S:REQ-004']);
  assert.deepEqual([...diff.revised], ['S:REQ-002'], 'a reworded clause was not detected as revised');
  assert.deepEqual([...diff.removed], ['S:REQ-003'], 'a removed clause vanished silently');
  assert.deepEqual([...diff.unchanged], ['S:REQ-001'], 'an untouched clause was reported as changed');
  assert.match(diff.sha256, /^[0-9a-f]{64}$/);

  // Reformatting is not revision: the same clause body re-extracted must compare equal.
  assert.deepEqual([...clauseDiff(clauses(G2), clauses(G2), { beforeMarkdown: G2, afterMarkdown: G2 }).changed], []);
});

test('radius-is-claim-closed', () => {
  /**
   * `[AMD:AC-002]`. The radius is exactly the claims citing changed clauses — their artifacts and
   * their bound tests — and nothing reached by file adjacency. A claim that happens to live in the
   * same file as an affected one is not affected, and a radius that grew that way would stop being
   * believable at the size where believing it matters.
   */
  const planned = normalizeClaimMap({
    claims: {
      'S:REQ-001': { expectedPaths: ['src/pay.js'], tests: ['test/pay.test.mjs'] },
      'S:REQ-002': { expectedPaths: ['src/pay.js', 'src/audit.js'], tests: ['test/audit.test.mjs'] },
      'S:REQ-003': { expectedPaths: ['src/ui.js'], tests: [] }
    }
  }, { kind: 'planned' });

  const radius = blastRadius(diffOfShipped(), planned);
  assert.deepEqual(radius.affected.map((entry) => entry.clauseId), ['S:REQ-002', 'S:REQ-003']);
  assert.deepEqual(radius.untouched.map((entry) => entry.clauseId), ['S:REQ-001'],
    'an unaffected claim was pulled into the radius');

  // src/pay.js is claimed by both REQ-001 and REQ-002. It is in scope because REQ-002 changed, and
  // REQ-001 is still untouched — sharing a file does not spread the amendment.
  assert.deepEqual([...radius.artifacts], ['src/audit.js', 'src/pay.js', 'src/ui.js']);
  assert.deepEqual([...radius.tests], ['test/audit.test.mjs']);
  assert.equal(radius.untouched[0].clauseId, 'S:REQ-001');

  // The added clause is claimed by nobody yet — named rather than dropped, because it is the one
  // part of the radius the claim map cannot account for.
  assert.deepEqual([...radius.unclaimed], ['S:REQ-004']);
  assert.deepEqual(radius.totals, { claims: 3, affected: 2, untouched: 1 });
});

test('the complement is stated, because reassurance is half the feature', () => {
  // `[AMD:REQ-021]`. Told only what broke, a reader has to prove the silence means safety.
  const planned = normalizeClaimMap({
    claims: {
      'S:REQ-001': { expectedPaths: ['src/pay.js'], tests: [] },
      'S:REQ-002': { expectedPaths: ['src/audit.js'], tests: [] },
      'S:REQ-003': { expectedPaths: ['src/ui.js'], tests: [] }
    }
  }, { kind: 'planned' });
  const summary = radiusSummary(blastRadius(diffOfShipped(), planned));
  assert.match(summary, /2 of your 3 claims affected/);
  assert.match(summary, /the other 1 stand/, 'the summary never says what is safe');

  // Nothing affected must say so outright rather than printing an empty list.
  const quiet = blastRadius(clauseDiff(clauses(G2), clauses(G2), { beforeMarkdown: G2, afterMarkdown: G2 }), planned);
  assert.match(radiusSummary(quiet), /None of your 3 claims are affected; all of them stand\./);
});

test('the last reconciliation verdict rides along, so a reader can tell settled from in-flight', () => {
  const planned = normalizeClaimMap({ claims: { 'S:REQ-002': { expectedPaths: ['src/audit.js'], tests: [] } } }, { kind: 'planned' });
  const observed = normalizeClaimMap({
    claims: { 'S:REQ-002': { verdict: 'matched', observedPaths: ['src/audit.js'], commits: [] } }
  }, { kind: 'observed' });
  const radius = blastRadius(diffOfShipped(), planned, { observed });
  assert.equal(radius.affected[0].verdict, 'matched',
    'a claim already reconciled looks identical to one never started');
});

test('the computation refuses nonsense rather than inventing a radius', () => {
  assert.throws(() => blastRadius(null, {}), /needs a clause diff/);
  assert.throws(() => clauseDiff([{ body: 'no id' }], []), /clause with no id/);
});

test('nothing in the amendment path consults a model or mutates state', async () => {
  /**
   * `[AMD:CON-003]`: the kernel computes, people advance. Structural, because a module that later
   * grew a provider call or a state write would still pass every assertion above.
   */
  const text = (await import('node:fs/promises')).readFile;
  const source = (await text(new URL('../src/amendment.mjs', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['invokeModel', 'writeFile', 'writeJson', 'spawn', 'reopen']) {
    assert.ok(!source.includes(forbidden), `amendment.mjs reaches for ${forbidden}; it must only compute`);
  }
});
