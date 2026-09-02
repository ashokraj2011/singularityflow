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
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { blastRadius, clauseDiff, radiusSummary } from '../src/amendment.mjs';
import { intentAmendmentBlastRadius } from '../src/commands/story.mjs';
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

test('intent-amendment radius retains cumulative plan and observation evidence across intervals', () => {
  const clauseId = 'S:REQ-002';
  const records = {
    planned: [
      { phase: 'implementation-plan', generation: 1, claims: { [clauseId]: {
        expectedPaths: ['src/pay.js'], tests: ['test/pay.test.mjs'], testDisposition: 'applicable'
      } } },
      { phase: 'implementation-plan', generation: 2, claims: { [clauseId]: {
        expectedPaths: ['src/audit.js'], tests: ['test/audit.test.mjs'], testDisposition: 'applicable'
      } } }
    ],
    observed: [
      { phase: 'implementation', generation: 1, claims: { [clauseId]: {
        observedPaths: ['src/pay.js'], testResults: ['test/pay.test.mjs'],
        commits: ['a'.repeat(40)], verdict: 'partial'
      } } },
      { phase: 'implementation', generation: 2, claims: { [clauseId]: {
        observedPaths: ['src/audit.js'], testResults: ['test/audit.test.mjs'],
        commits: ['b'.repeat(40)], verdict: 'partial'
      } } }
    ]
  };

  const radius = intentAmendmentBlastRadius(diffOfShipped(), records);
  const affected = radius.affected.find((entry) => entry.clauseId === clauseId);
  assert.deepEqual([...affected.artifacts], ['src/audit.js', 'src/pay.js'],
    'the later plan replaced an earlier expected path for the same clause');
  assert.deepEqual([...affected.tests], ['test/audit.test.mjs', 'test/pay.test.mjs'],
    'the later plan replaced an earlier test obligation for the same clause');
  assert.equal(affected.verdict, 'matched',
    'two cumulative partial observations were not recomputed as one complete claim');
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

test('update-intent is the reality-altitude door, and it blocks', async () => {
  /**
   * `[AMD:REQ-010]` door (b): reconciliation found the code right and the plan wrong. The spec named
   * this as an existing disposition; it was not one — the shipped set was rework,
   * accepted-deviation, dismissed, deferred.
   *
   * It blocks for the mirror of rework's reason. Rework says the code has not caught up with the
   * plan; update-intent says the plan has not caught up with the code. Either way the Story would
   * advance on a specification known to be wrong.
   */
  const { advancementBlocked, DISPOSITIONS, validateAdjudication } = await import('../src/convergence.mjs');
  assert.ok(DISPOSITIONS.includes('update-intent'));

  const decision = validateAdjudication(
    { itemId: 'CF-abc', disposition: 'update-intent', reason: 'the retry rule as written is wrong', clauseIds: ['S:AC-003'] },
    { facts: [{ id: 'CF-abc' }] }
  );
  assert.equal(decision.disposition, 'update-intent');
  assert.deepEqual(decision.clauseIds, ['S:AC-003']);

  const reasons = advancementBlocked({
    unresolvedBlockers: ['CF-abc'],
    findings: [{ id: 'CF-abc', itemId: 'CF-abc', disposition: 'update-intent', clauseIds: ['S:AC-003'] }],
    facts: [{ id: 'CF-abc' }],
    candidates: []
  });
  assert.ok(reasons.some((reason) => reason.includes("dispositioned 'update-intent'")),
    'a plan known to be wrong did not block advancement');
});

test('update-intent must name the clauses it wants changed', async () => {
  // The amendment it triggers is computed from a clause set; without one there is nothing to revise.
  // Every other disposition may leave the list empty, because none of them moves the specification.
  const { validateAdjudication } = await import('../src/convergence.mjs');
  assert.throws(() => validateAdjudication({ itemId: 'CF-1', disposition: 'update-intent', reason: 'wrong' }),
    (error) => {
      assert.equal(error.code, 'ADJUDICATION_CLAUSES_REQUIRED');
      assert.match(error.message, /nothing for an amendment to revise/);
      return true;
    });
  assert.doesNotThrow(() => validateAdjudication({ itemId: 'CF-1', disposition: 'accepted-deviation', reason: 'tolerated' }));
});

test('update-intent and accepted-deviation are not the same decision', async () => {
  /**
   * The distinction the taxonomy exists for. `accepted-deviation` tolerates a divergence and leaves
   * the clause saying what it always said; `update-intent` says the clause itself is wrong. Only one
   * of them stops the Story, and collapsing them would let a plan everyone knows is wrong ship with
   * a note attached.
   */
  const { advancementBlocked } = await import('../src/convergence.mjs');
  const projection = (disposition) => ({
    unresolvedBlockers: disposition === 'update-intent' ? ['CF-1'] : [],
    findings: [{ id: 'CF-1', itemId: 'CF-1', disposition, clauseIds: ['S:AC-003'] }],
    facts: [{ id: 'CF-1' }],
    candidates: []
  });
  assert.equal(advancementBlocked(projection('accepted-deviation')).length, 0, 'a tolerated deviation blocked the Story');
  assert.ok(advancementBlocked(projection('update-intent')).length, 'a known-wrong plan did not block the Story');
});

test('update-intent offers an amendment transition and never advertises code rework by itself', async () => {
  const { convergenceProjection } = await import('../src/convergence.mjs');
  const facts = [{ id: 'CF-1', kind: 'claim-without-observed-evidence', clauseIds: ['S:AC-003'] }];
  const projection = convergenceProjection({
    workId: 'WORK-1',
    bindings: { iteration: 1 },
    facts,
    adjudications: [{
      itemId: 'CF-1', disposition: 'update-intent', reason: 'the intended retry behavior changed',
      clauseIds: ['S:AC-003'], actor: 'owner@example.test', at: '2026-08-17T00:00:00.000Z'
    }]
  });
  assert.ok(projection.allowedNext.includes('propose-intent-amendment'));
  assert.ok(!projection.allowedNext.includes('create-rework'));
});

test('a verdict recorded before a revision is unverified, not wrong', async () => {
  /**
   * `[AMD:REQ-050]`. The reconciliation said `matched` against text the specification no longer
   * contains. The honest fact is that the verdict has not been re-checked — not that the work is
   * unimplemented. Calling it unimplemented would be the CON-033 mistake in a new place: absent
   * evidence about new wording is missing trace evidence, not a finding about the code.
   *
   * Distinct from `claimed-withdrawn-clause`, which fires when the clause goes away entirely. Here
   * the clause still exists and still has a verdict; only the words moved.
   */
  const { convergenceFacts, FACT_KINDS } = await import('../src/convergence.mjs');
  assert.ok(FACT_KINDS.includes('verdict-against-superseded-clause'));

  const inputs = {
    reconciliation: { changedPaths: [], summary: {} },
    // Clause objects, not entries: `convergenceFacts` maps them by `clause.id`.
    indexes: [{ clauses: [{ id: 'S:AC-003' }, { id: 'S:AC-009' }] }],
    observed: [{ claims: {
      'S:AC-003': { verdict: 'matched', observedPaths: ['src/retry.js'] },
      'S:AC-009': { verdict: 'matched', observedPaths: ['src/other.js'] }
    } }]
  };

  const withoutAmendment = convergenceFacts(inputs).facts ?? convergenceFacts(inputs);
  const before = (Array.isArray(withoutAmendment) ? withoutAmendment : withoutAmendment.facts ?? [])
    .filter((entry) => entry.kind === 'verdict-against-superseded-clause');
  assert.equal(before.length, 0, 'a superseded verdict was reported without any amendment');

  const result = convergenceFacts({ ...inputs, amendedClauses: ['S:AC-003'] });
  const facts = (Array.isArray(result) ? result : result.facts ?? [])
    .filter((entry) => entry.kind === 'verdict-against-superseded-clause');
  assert.equal(facts.length, 1, 'a revised clause with a recorded verdict produced no fact');
  assert.deepEqual(facts[0].clauseIds, ['S:AC-003'], 'the fact named the wrong clause, or spread to an untouched one');
  assert.match(facts[0].detail, /has not been re-checked/);
  assert.doesNotMatch(facts[0].detail, /unimplemented/);
});

test('churn counts revisions of one clause, not amendments', async () => {
  /**
   * `[AMD:REQ-051]`. Five amendments across five clauses is a specification being filled in; five to
   * one clause is a specification arguing with itself. Only the second is worth interrupting anyone
   * about, so only the second crosses the floor.
   */
  const { amendmentChurn } = await import('../src/amendment.mjs');
  const spread = amendmentChurn([
    { clauses: ['S:AC-001'] }, { clauses: ['S:AC-002'] }, { clauses: ['S:AC-003'] }, { clauses: ['S:AC-004'] }
  ]);
  assert.equal(spread.amendments, 4);
  assert.equal(spread.quiet, true, 'four amendments across four clauses were treated as churn');

  const focused = amendmentChurn([{ clauses: ['S:AC-003'] }, { clauses: ['S:AC-003'] }, { clauses: ['S:AC-003'] }]);
  assert.equal(focused.quiet, false);
  assert.deepEqual(focused.unsettled, [{ clauseId: 'S:AC-003', revisions: 3 }]);

  // The floor is configurable, and below it the same history is quiet.
  assert.equal(amendmentChurn([{ clauses: ['S:AC-003'] }, { clauses: ['S:AC-003'] }]).quiet, true);
  assert.equal(amendmentChurn([{ clauses: ['S:AC-003'] }, { clauses: ['S:AC-003'] }], { floor: 2 }).quiet, false);
});

test('the recap tells the story once, instead of leaving it to be reconstructed', async () => {
  // `[AMD:REQ-052]`. Reconstruction from four sections and a diff is the part people skip when busy,
  // which is exactly when an amendment is most likely to be missed.
  const { amendmentChurn, amendmentRecap } = await import('../src/amendment.mjs');
  const amendments = [
    { toGeneration: 2, clauses: ['S:AC-003'], reason: 'tightened the retry rule' },
    { toGeneration: 3, clauses: ['S:AC-003'] },
    { toGeneration: 4, clauses: ['S:AC-003', 'S:AC-009'] }
  ];
  const recap = amendmentRecap({ amendments, churn: amendmentChurn(amendments) });
  assert.match(recap, /amended 3 times/);
  assert.match(recap, /generation 4/);
  assert.match(recap, /2 clauses changed: S:AC-003, S:AC-009/);
  assert.match(recap, /S:AC-003 has been revised 3 times/);
  assert.match(recap, /worth settling before more is built on it/);

  assert.equal(amendmentRecap({}), 'The specification has not changed since this interval began.');
});

test('the P3 computations are reachable from a command, not just exported', async () => {
  /**
   * Every piece of this specification was built as a pure function first, and twice in this session
   * a pure function sat with no caller while the work looked finished. `verdict-against-superseded-
   * clause` in particular can only ever fire if someone passes `amendedClauses`, so a check that
   * nothing feeds is a check that never runs.
   *
   * Asserted against the call sites rather than behaviour: the behaviour is covered above, and what
   * is at risk here is the wiring being removed by a refactor that keeps every test green.
   */
  const { commandLayerSource, withoutComments } = await import('./helpers/command-source.mjs');
  const cli = withoutComments(await commandLayerSource());
  const context = withoutComments(await readFile(
    new URL('../src/convergence-context.mjs', import.meta.url), 'utf8'
  ));

  // The shared exact-context boundary tells convergence which clauses the interval's amendments
  // touched, and the command consumes that boundary rather than rebuilding a weaker snapshot.
  assert.match(context, /amendedClauses: \[\.\.\.new Set\(\(workflow\.workIntervals\?\.current\?\.amendments/,
    'story converge no longer passes the amended clause set');
  assert.match(cli, /currentConvergenceContext\(root, config, workflow\)/,
    'story converge bypasses the exact convergence context');

  // The recap and the churn floor reach the reader.
  assert.match(cli, /amendmentRecap\(\{ amendments: current\.amendments/, 'interval status no longer prints the recap');
  assert.match(cli, /amendmentChurn\(current\.amendments/, 'interval status no longer computes churn');
});
