/**
 * Anchoring a review diff to the reviewer's own last decision.
 *
 * Screen B is stronger than `[UXH:REQ-080]` here, and these pin the difference: the spec asks for
 * the previous *relevant* generation, the screen asks for the last generation *you* ruled on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { anchorIsStale, reviewAnchor } from '../src/gateway/review-anchor.mjs';

const phase = (approvals, generation = 5) => ({ generation, approvals });
const decision = (over) => ({ actor: 'dev@example.test', decision: 'approved', at: '2026-08-01T00:00:00Z', generation: 2, ...over });

test('the diff anchors to your last decision, not the newest generation', () => {
  /**
   * The case the spec's wording gets wrong. You approved g2, were away through g3 and g4, and are
   * now asked about g5. A diff against g4 shows one increment of a change you have never seen.
   */
  const anchor = reviewAnchor(phase([
    decision({ generation: 2 }),
    decision({ actor: 'someone@else.test', generation: 4 })
  ]), { actorId: 'dev@example.test' });

  assert.equal(anchor.kind, 'your-approval');
  assert.equal(anchor.generation, 2);
  assert.equal(anchor.current, 5);
});

test('a rejection carries your own words back to you', () => {
  // Screen B: "Changed because you sent g2 back: 'idempotency unclear on retry path'".
  const anchor = reviewAnchor(phase([
    decision({ decision: 'rejected', generation: 2, reason: 'idempotency unclear on retry path' })
  ]), { actorId: 'dev@example.test' });

  assert.equal(anchor.kind, 'your-rejection');
  assert.equal(anchor.reason, 'idempotency unclear on retry path');
});

test('an approval carries no reason, because there was no complaint', () => {
  // Inventing one would be putting words in the reviewer's mouth.
  assert.equal(reviewAnchor(phase([decision({})]), { actorId: 'dev@example.test' }).reason, null);
  // And a rejection recorded without a comment says null rather than inventing a summary.
  assert.equal(reviewAnchor(phase([decision({ decision: 'rejected', reason: undefined })]),
    { actorId: 'dev@example.test' }).reason, null);
});

test('another reviewer\'s decision is never labelled as yours', () => {
  /**
   * The failure worth being strict about: a diff anchored to somebody else's approval, labelled
   * "your last approval", gets a change approved on the strength of another person's reading.
   */
  const anchor = reviewAnchor(phase([decision({ actor: 'someone@else.test', generation: 3 })]),
    { actorId: 'dev@example.test' });
  assert.equal(anchor.kind, 'first-review');
  assert.equal(anchor.generation, null);
});

test('an unidentified reviewer gets no anchor at all', () => {
  const anchor = reviewAnchor(phase([decision({})]), {});
  assert.equal(anchor.kind, 'unknown-reviewer');
  assert.equal(anchor.generation, null);
});

test('a first look is named, not diffed against nothing', () => {
  /**
   * Anchoring to generation 0 and calling it a diff presents the whole artifact as "what changed",
   * which trains reviewers to skim exactly when they should not.
   */
  const anchor = reviewAnchor(phase([]), { actorId: 'dev@example.test' });
  assert.equal(anchor.kind, 'first-review');
  assert.equal(anchor.generation, null);
  assert.equal(anchor.decisions, 0);
});

test('an annulled decision is not an anchor', () => {
  // `invalidatedAt` marks a judgement the lifecycle already withdrew. Anchoring to one shows a
  // comparison against a decision that no longer counts, and it looks authoritative.
  const anchor = reviewAnchor(phase([
    decision({ generation: 4, invalidatedAt: '2026-08-02T00:00:00Z' }),
    decision({ generation: 2 })
  ]), { actorId: 'dev@example.test' });
  assert.equal(anchor.generation, 2);
  assert.equal(anchor.decisions, 1);
});

test('the newest of your decisions wins, whatever order they are stored in', () => {
  const anchor = reviewAnchor(phase([
    decision({ generation: 2, at: '2026-08-01T00:00:00Z' }),
    decision({ generation: 4, at: '2026-08-03T00:00:00Z', decision: 'rejected', reason: 'later' }),
    decision({ generation: 3, at: '2026-08-02T00:00:00Z' })
  ]), { actorId: 'dev@example.test' });
  assert.equal(anchor.generation, 4);
  assert.equal(anchor.reason, 'later');
  assert.equal(anchor.decisions, 3);
});

test('an anchor on the current generation is stale', () => {
  // "Since your last approval" over an empty diff reads as "nothing changed", when the truth is
  // "you are looking at the thing you already approved".
  assert.equal(anchorIsStale(reviewAnchor(phase([decision({ generation: 5 })], 5), { actorId: 'dev@example.test' })), true);
  assert.equal(anchorIsStale(reviewAnchor(phase([decision({ generation: 2 })], 5), { actorId: 'dev@example.test' })), false);
  assert.equal(anchorIsStale(reviewAnchor(phase([]), { actorId: 'dev@example.test' })), false);
});
