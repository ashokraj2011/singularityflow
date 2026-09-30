import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateSourceGroundedReview, sourceReviewBinding } from '../src/source-grounded-review.mjs';

const workId = 'EXAMPLE';
const specification = `# Specification
## Actors
Member
## User scenarios
### S1 — Save a draft
- Given a draft, when saved, then it persists.
## Requirements
- Save the draft. (S1) [EXAMPLE:REQ-001]
- Show saved status. (S1) [EXAMPLE:AC-001]
`;
const plan = `# Plan
## Test strategy
| Clause | Expected paths | Planned tests |
|---|---|---|
| \`EXAMPLE:REQ-001\` | \`src/drafts.mjs\` | \`test/drafts.test.mjs\` |
| \`EXAMPLE:AC-001\` | \`src/drafts.mjs\` | \`test/drafts.test.mjs\` |
`;
const sources = [
  { id: 'story', path: 'singularity/work-items/EXAMPLE/USER-STORY.md',
    text: '# Story\nSave a draft and show saved status.\n' },
  { id: 'attachment-1', path: 'singularity/work-items/EXAMPLE/inputs/notes.md',
    text: '# Notes\nDrafts must persist.\n' }
];
const authorAgentId = 'product-owner';
const reviewerAgentId = 'source-reviewer';

function context(kind = 'specification') {
  return {
    kind, workId, phase: kind, generation: 1, sources,
    artifact: { path: `singularity/work-items/EXAMPLE/artifacts/${kind}/${kind === 'specification' ? 'spec.md' : 'plan.md'}`,
      text: kind === 'specification' ? specification : plan },
    ...(kind === 'planning' ? { upstreamSpec: {
      path: 'singularity/work-items/EXAMPLE/artifacts/specification/spec.md', text: specification
    } } : {}),
    authorAgentId, reviewerAgentId, reviewerReadOnly: true
  };
}

function report(ctx) {
  return {
    schemaVersion: 1, resultType: 'source-grounded-review', kind: ctx.kind,
    binding: sourceReviewBinding(ctx), reviewer: { agentId: reviewerAgentId, readOnly: true },
    sourcesReviewed: ['story', 'attachment-1'], findings: [],
    rows: ctx.kind === 'specification' ? [
      { id: 'story-draft', sourceId: 'story', line: 2, quote: 'Save a draft and show saved status.',
        outcome: 'covered', scenarioId: 'S1', clauseIds: ['EXAMPLE:REQ-001', 'EXAMPLE:AC-001'] },
      { id: 'notes-draft', sourceId: 'attachment-1', line: 2, quote: 'Drafts must persist.',
        outcome: 'covered', scenarioId: 'S1', clauseIds: ['EXAMPLE:REQ-001'] }
    ] : [
      { clauseId: 'EXAMPLE:REQ-001', expectedPaths: ['src/drafts.mjs'], plannedTests: ['test/drafts.test.mjs'],
        testDisposition: 'applicable', assessment: 'supported' },
      { clauseId: 'EXAMPLE:AC-001', expectedPaths: ['src/drafts.mjs'], plannedTests: ['test/drafts.test.mjs'],
        testDisposition: 'applicable', assessment: 'supported' }
    ]
  };
}

test('a current independent review can trace every pinned source and clause', () => {
  const ctx = context();
  const result = evaluateSourceGroundedReview(report(ctx), ctx);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.findings, []);
});

test('changing a pinned source, artifact, or approved spec invalidates the review', () => {
  for (const change of [
    (ctx) => { ctx.sources = [{ ...sources[0], text: `${sources[0].text}More.\n` }, sources[1]]; },
    (ctx) => { ctx.artifact = { ...ctx.artifact, text: `${ctx.artifact.text}\nChange` }; },
    (ctx) => { ctx.upstreamSpec = { ...ctx.upstreamSpec, text: `${ctx.upstreamSpec.text}\nChange` }; }
  ]) {
    const original = context('planning');
    const packet = report(original);
    const changed = context('planning');
    change(changed);
    assert.equal(evaluateSourceGroundedReview(packet, changed).status, 'stale');
  }
});

test('raw artifact bytes remain bound even when their decoded text is the same', () => {
  const original = context();
  original.artifact.originalSha256 = 'a'.repeat(64);
  const packet = report(original);
  const changed = context();
  changed.artifact.originalSha256 = 'b'.repeat(64);
  assert.equal(evaluateSourceGroundedReview(packet, changed).status, 'stale');
});

test('missing source citations, clauses, and a distinct read-only reviewer block review', () => {
  const ctx = context();
  const packet = report(ctx);
  packet.sourcesReviewed = ['story'];
  packet.rows[0].quote = 'not on this line';
  packet.rows.splice(1);
  const result = evaluateSourceGroundedReview(packet, { ...ctx, reviewerAgentId: authorAgentId });
  assert.equal(result.status, 'correction-required');
  assert.ok(result.findings.some((entry) => entry.code === 'sources-not-all-reviewed'));
  assert.ok(result.findings.some((entry) => entry.code === 'citation-quote-invalid'));
  assert.ok(result.findings.some((entry) => entry.code === 'source-unmapped'));
  assert.ok(result.findings.some((entry) => entry.code === 'reviewer-not-independent'));
});

test('a proposed source exclusion needs a separate hash-bound human disposition', () => {
  const ctx = context();
  const packet = report(ctx);
  packet.rows[1] = { id: 'notes-exclusion', sourceId: 'attachment-1', line: 2,
    quote: 'Drafts must persist.', outcome: 'excluded', reason: 'Duplicate of the Story.' };
  const pending = evaluateSourceGroundedReview(packet, ctx);
  assert.equal(pending.status, 'correction-required');
  assert.deepEqual(pending.pendingDispositions.map((entry) => entry.id), ['exclusion:notes-exclusion']);
  const accepted = evaluateSourceGroundedReview(packet, { ...ctx, humanDispositions: [{
    id: 'exclusion:notes-exclusion', reportSha256: pending.reportSha256,
    decision: 'accepted', reason: 'Confirmed duplicate against the Story.', actor: 'reviewer@example.test'
  }] });
  assert.equal(accepted.status, 'ready');
  assert.equal(evaluateSourceGroundedReview(packet, { ...ctx, humanDispositions: [{
    id: 'exclusion:notes-exclusion', reportSha256: '0'.repeat(64), decision: 'accepted',
    reason: 'Wrong review.', actor: 'reviewer@example.test'
  }] }).status, 'correction-required');
});

test('plan review must mirror exact structured rows and assess every approved clause', () => {
  const ctx = context('planning');
  assert.equal(evaluateSourceGroundedReview(report(ctx), ctx).status, 'ready');
  const packet = report(ctx);
  packet.rows[0].plannedTests = ['test/other.test.mjs'];
  packet.rows.splice(1);
  const result = evaluateSourceGroundedReview(packet, ctx);
  assert.equal(result.status, 'correction-required');
  assert.ok(result.findings.some((entry) => entry.code === 'plan-row-mismatch'));
  assert.ok(result.findings.some((entry) => entry.code === 'clause-unreviewed'));
});

test('non-testable clauses need explicit approval of the exact review packet', () => {
  const ctx = context('planning');
  ctx.artifact = { ...ctx.artifact, text: ctx.artifact.text.replace(
    '| `EXAMPLE:AC-001` | `src/drafts.mjs` | `test/drafts.test.mjs` |',
    '| `EXAMPLE:AC-001` | `src/drafts.mjs` | not-applicable: witnessed by manual review |'
  ) };
  const packet = report(ctx);
  packet.rows[1] = { clauseId: 'EXAMPLE:AC-001', expectedPaths: ['src/drafts.mjs'], plannedTests: [],
    testDisposition: 'not-applicable', testReason: 'witnessed by manual review', assessment: 'supported' };
  const pending = evaluateSourceGroundedReview(packet, ctx);
  assert.equal(pending.status, 'correction-required');
  assert.deepEqual(pending.pendingDispositions.map((entry) => entry.id), ['not-applicable:EXAMPLE:AC-001']);
  assert.equal(evaluateSourceGroundedReview(packet, { ...ctx, humanDispositions: [{
    id: 'not-applicable:EXAMPLE:AC-001', reportSha256: pending.reportSha256,
    decision: 'accepted', reason: 'Human inspection is the only possible check.', actor: 'reviewer@example.test'
  }] }).status, 'ready');
});
