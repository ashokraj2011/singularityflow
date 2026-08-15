import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIDENCE_CLASSES, EXPERIENCE_METRICS, PERSONAL_DRAFT_LABEL, WATCH_PREDICATES,
  assertDraftNotUsedAsInput, comparisonReport, experienceMetrics, handoffPacket, lineageEdge,
  lineageGraph, personalDraft, tokenSavingsClaim, watchNotification, watchSubscription
} from '../src/gateway/journey-contracts.mjs';

const code = (value) => (error) => error.code === value;

test('a comparison resolves both sides exactly and always declares whether it interpreted', () => {
  const report = comparisonReport({
    subjectKind: 'branch',
    left: { id: 'main', revision: 'a'.repeat(40) },
    right: { id: 'release/24.3', revision: 'b'.repeat(40) },
    changedFacts: ['3 clauses moved'],
    unchangedGuarantees: ['the public checkout interface did not change'],
    evidenceGaps: ['no build provenance for the right side'],
    authorities: ['git', 'clause']
  });
  assert.equal(report.assisted, false);
  assert.deepEqual([...report.authorities], ['clause', 'git']);
  assert.equal(report.unchangedGuarantees.length, 1);

  assert.throws(() => comparisonReport({ subjectKind: 'branch', left: { id: 'main' }, right: { id: 'x', revision: 'y' } }), code('COMPARISON_INVALID'));
  assert.throws(() => comparisonReport({
    subjectKind: 'branch',
    left: { id: 'a', revision: '1' },
    right: { id: 'b', revision: '2' },
    authorities: ['vibes']
  }), code('COMPARISON_INVALID'));
});

test('a lineage edge cites its evidence, unless it admits to being a hypothesis', () => {
  const recorded = lineageEdge({
    from: 'src/pay.ts:44', to: 'CLAUSE-12', relationship: 'implements',
    evidenceSource: 'claim-index', revision: 'sha256:abc', confidence: 'recorded'
  });
  assert.equal(recorded.confidence, 'recorded');

  // `[INT:CON-182]`: unsupported is allowed through, labelled, and counted.
  const guess = lineageEdge({ from: 'src/pay.ts:44', to: 'INC-9', relationship: 'references', confidence: 'hypothesis' });
  assert.equal(guess.revision, null);

  assert.throws(() => lineageEdge({
    from: 'a', to: 'b', relationship: 'implements', confidence: 'derived'
  }), code('LINEAGE_INVALID'));
  assert.throws(() => lineageEdge({ from: 'a', to: 'b', relationship: 'caused-by', confidence: 'recorded' }), code('LINEAGE_INVALID'));
  assert.deepEqual([...CONFIDENCE_CLASSES], ['recorded', 'derived', 'hypothesis']);
});

test('a lineage graph keeps its gaps visible and counts its guesses', () => {
  const graph = lineageGraph({
    subject: { kind: 'repository', id: 'checkout-service' },
    edges: [
      { from: 'a', to: 'b', relationship: 'implements', evidenceSource: 'claim-index', revision: 'sha256:1', confidence: 'recorded' },
      { from: 'b', to: 'c', relationship: 'references', confidence: 'hypothesis' }
    ],
    missingLinks: ['no approved design clause covers the retry path']
  });
  assert.equal(graph.hypothesisCount, 1);
  assert.equal(graph.missingLinks.length, 1);
  assert.throws(() => lineageGraph({ edges: [] }), code('LINEAGE_INVALID'));
});

const sections = (over = {}) => ({
  approvedIntent: 'Fix address validation before capture',
  currentPhase: 'implement',
  legalNextAction: 'submit',
  revisions: { 'checkout-service': 'a'.repeat(40) },
  completedWork: ['validation rewritten'],
  remainingWork: ['integration tests'],
  localChanges: { dirty: true, files: 3 },
  tests: { passing: 41, failing: 0 },
  evidence: ['ev:test-run-7'],
  openQuestions: [],
  risks: [],
  reconstruction: 'git fetch && git switch wi/WRK-123',
  ...over
});

test('a handoff packet is a projection with exact revisions and no optional sections', () => {
  const packet = handoffPacket(sections());
  assert.equal(packet.authority, 'projection-only');
  assert.equal(packet.revisions['checkout-service'].length, 40);
  // Empty is a statement someone checked; absent is a section nobody looked at.
  assert.deepEqual(packet.openQuestions, []);

  const missing = sections();
  delete missing.risks;
  assert.throws(() => handoffPacket(missing), (error) => error.code === 'HANDOFF_INVALID' && error.details.section === 'risks');
  assert.throws(() => handoffPacket(sections({ revisions: {} })), code('HANDOFF_INVALID'));
});

test('a personal draft says it is not governed in the record, not in a stylesheet', () => {
  const draft = personalDraft({ id: 'draft-1', ownerId: 'dev-1', label: 'retry idea' });
  assert.equal(draft.governed, false);
  assert.equal(draft.displayLabel, PERSONAL_DRAFT_LABEL);
  assert.equal(draft.eligibleForApproval, false);
  assert.equal(draft.visibleToLifecyclePlanners, false);
  assert.equal(draft.canSupplyApprovedInputs, false);

  assert.throws(() => assertDraftNotUsedAsInput(draft), code('DRAFT_NOT_GOVERNED'));
  assert.deepEqual(assertDraftNotUsedAsInput({ kind: 'specification' }), { kind: 'specification' });
  assert.throws(() => personalDraft({ id: 'd', label: 'x' }), code('DRAFT_INVALID'));
});

test('a watch is a typed subscription and never an authority', () => {
  const watch = watchSubscription({
    id: 'watch-1', ownerId: 'dev-1', predicate: 'approval-decided', subject: { kind: 'story', id: 'WRK-123' }
  });
  assert.equal(watch.delivery, 'event-driven');
  assert.equal(watch.authoritative, false);
  assert.equal(watch.revocable, true);
  assert.throws(() => watchSubscription({
    id: 'w', ownerId: 'd', predicate: 'feels-done', subject: { kind: 'story', id: 'x' }
  }), code('WATCH_INVALID'));
  assert.ok(WATCH_PREDICATES.includes('publication-failed'));
});

test('a notification carries no action, because it will be opened late', () => {
  const notification = watchNotification({
    watchId: 'watch-1', eventId: 'evt-9', subject: { kind: 'story', id: 'WRK-123' },
    changed: 'approval recorded by a second reviewer'
  });
  assert.equal(notification.nextActions, null);
  assert.equal(notification.recomputeNextActionsOnOpen, true);
  assert.throws(() => watchNotification({ watchId: 'w', subject: { kind: 'story', id: 'x' }, changed: 'y' }), code('WATCH_NOTIFICATION_INVALID'));
});

test('experience metrics report what was not measured, and refuse what must not be stored', () => {
  const metrics = experienceMetrics({ clarificationRate: 0.12, contextTokensSelected: 11_800 });
  assert.equal(metrics.values.clarificationRate, 0.12);
  assert.equal(metrics.unmeasured.length, EXPERIENCE_METRICS.length - 2);
  assert.ok(metrics.forbiddenUses.includes('evaluating-individuals'));

  assert.throws(() => experienceMetrics({ transcript: 'the user said...' }), code('METRICS_INVALID'));
  assert.throws(() => experienceMetrics({ vanityScore: 9 }), code('METRICS_INVALID'));
});

test('a token-savings claim names what it is a saving against', () => {
  const claim = tokenSavingsClaim({
    wholeContextBaseline: 180_000, selected: 11_800, cacheReused: 7_200,
    tokenizer: 'bytes-per-token-4.0', limitations: 'approximation; not provider billing'
  });
  assert.equal(claim.avoided, 168_200);
  assert.equal(claim.cacheReused, 7_200);
  assert.equal(claim.exact, false);

  assert.throws(() => tokenSavingsClaim({ selected: 100, tokenizer: 't', limitations: 'l' }), code('METRICS_INVALID'));
  assert.throws(() => tokenSavingsClaim({ wholeContextBaseline: 10, selected: 1, limitations: 'l' }), code('METRICS_INVALID'));
  assert.throws(() => tokenSavingsClaim({ wholeContextBaseline: 10, selected: 1, tokenizer: 't' }), code('METRICS_INVALID'));
});
