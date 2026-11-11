/**
 * What a review finding says reaches the right reader [N5, agent input repairs]: a stage refusal carries a
 * finding's message, not its detail lists, so the IDs a reviewer must acknowledge are in the words; and a
 * question row is read by the reviewer before retention and by the author after it, so each is told what is
 * theirs (a retained review cannot be "corrected" by its author).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSourceReviewReport } from '../src/source-review-lifecycle.mjs';
import { sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';

function fixture() {
  const input = { workId: 'CONVERTER', phase: 'specification', kind: 'specification', generation: 1,
    authorAgentId: 'product-owner', reviewerAgentId: 'source-reviewer',
    sources: [{ id: 'story', path: 'USER-STORY.md', text: '# Converter\nAdd a converter.\n' }],
    artifact: { path: 'spec.md', text: '# Specification\n### S1 — Convert\n- Convert in both directions. (S1) [CONVERTER:REQ-001]\n' },
    clarifications: [{ id: 'clarification:current-phase', phase: 'specification', generation: 1, path: 'clarification.json', sha256: 'a'.repeat(64), responses: [] }] };
  input.binding = sourceReviewBinding(input);
  const report = { schemaVersion: 1, resultType: 'source-grounded-review', kind: 'specification', binding: structuredClone(input.binding),
    reviewer: { agentId: 'source-reviewer', readOnly: true }, sourcesReviewed: ['story'], clarificationsReviewed: ['clarification:current-phase'],
    rows: [{ id: 'conversion', sourceId: 'story', line: 2, quote: 'Add a converter.', outcome: 'covered', scenarioId: 'S1', clauseIds: ['CONVERTER:REQ-001'] }], findings: [] };
  return { input, report };
}

test('the clarification IDs a review must acknowledge are in the message the stage refusal carries', () => {
  const { input, report } = fixture();
  report.clarificationsReviewed = ['clarification:currentphase'];
  const checked = checkSourceReviewReport(report, input);
  const finding = checked.findings.find((entry) => entry.code === 'clarifications-not-all-reviewed');
  assert.match(finding.message, /missing: clarification:current-phase; unknown: clarification:currentphase/u);
  assert.deepEqual(finding.proposedEdit, { field: 'clarificationsReviewed[0]', value: 'clarification:current-phase' });
  const details = refusalEnvelope(new SingularityFlowError('Repair.', { code: 'SOURCE_REVIEW_REPORT_INVALID', details: checked }), ['review-source', 'stage', 'specification']).error.details;
  const carried = details.findings.find((entry) => entry.code === 'clarifications-not-all-reviewed');
  assert.match(carried.message, /missing: clarification:current-phase/u, 'the IDs survive the refusal boundary');
  assert.deepEqual(carried.proposedEdit, finding.proposedEdit);
});

test('a question row tells the reviewer and the author each what is theirs', () => {
  const { input, report } = fixture();
  report.rows[0] = { ...report.rows[0], outcome: 'question', question: 'Which units?' };
  delete report.rows[0].scenarioId; delete report.rows[0].clauseIds;
  const finding = checkSourceReviewReport(report, input).evaluation.findings.find((entry) => entry.code === 'source-question-unresolved');
  assert.match(finding.message, /Reviewer, before retaining: .*change this row to covered/u);
  assert.match(finding.message, /Author, once the review is retained: get the question answered in this step's clarification, then publish a corrected successor/u);
  assert.doesNotMatch(finding.message, /correct this review if/u, 'a retained review cannot be corrected by its author');
});
