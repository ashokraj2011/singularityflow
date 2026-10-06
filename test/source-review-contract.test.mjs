import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { sourceReviewReportSchema, sourceReviewReportTemplate, validateSourceReviewReport } from '../src/source-review-contract.mjs';
import { checkSourceReviewReport, evaluateSubmittedSourceReview } from '../src/source-review-lifecycle.mjs';

function input() {
  const context = { kind: 'planning', workId: 'REVIEW-1', phase: 'custom-plan', generation: 1,
    authorAgentId: 'architect', reviewerAgentId: 'source-reviewer', reviewerAgentSha256: 'a'.repeat(64),
    sources: [{ id: 'story', path: 'USER-STORY.md', text: 'The existing behavior must be verified.' }],
    upstreamSpec: { path: 'spec.md', text: '# Requirements\n- Verify existing behavior. [REVIEW-1:REQ-001]\n- Show both success and error screenshots. [REVIEW-1:AC-001]\n' },
    artifact: { path: 'plan.md', text: `# Plan
| Clause | Expected paths | Planned tests | Fulfillment | Steps | Observable result |
|---|---|---|---|---|---|
| \`REVIEW-1:REQ-001\` | - | \`test/app.test.mjs\` | test-only | verification | Existing behavior verified |
| \`REVIEW-1:AC-001\` | \`docs/screenshots.md\` | not-applicable: manual screenshot inspection | document | implementation | Success screenshot |
` } };
  return { ...context, binding: sourceReviewBinding(context) };
}

function reviewed(context) {
  const report = sourceReviewReportTemplate(context);
  for (const row of report.rows) row.assessment = 'supported';
  return report;
}

const session = { workId: 'REVIEW-1', phaseId: 'custom-plan', agent: 'source-reviewer', agentSha256: 'a'.repeat(64) };

test('context contract seeds exact planning metadata, never a supported judgment, for custom phase names', () => {
  const ctx = input();
  const draft = sourceReviewReportTemplate(ctx);
  assert.equal(draft.kind, 'planning');
  assert.deepEqual(draft.rows.map((row) => row.assessment), ['unreviewed', 'unreviewed']);
  assert.deepEqual(draft.rows[0], { clauseId: 'REVIEW-1:REQ-001', expectedPaths: [],
    plannedTests: ['test/app.test.mjs'], testDisposition: 'applicable', testReason: null,
    fulfillment: 'test-only', steps: ['verification'], observableResult: 'Existing behavior verified', assessment: 'unreviewed' });
  const schema = sourceReviewReportSchema('planning');
  assert.equal(schema.properties.kind.const, 'planning');
  assert.ok(schema.properties.rows.items.required.includes('plannedTests'));
  assert.ok(!schema.properties.rows.items.properties.assessment.enum.includes('unreviewed'));
  assert.ok(validateSourceReviewReport(draft, 'planning').findings.every((entry) => entry.field.endsWith('.assessment')));
  assert.equal(validateSourceReviewReport(reviewed(ctx), 'planning').status, 'ready');
});

test('the guessed fields from the incident are rejected with exact JSON field paths', () => {
  for (const [field, alias] of [['plannedTests', 'tests'], ['clauseId', 'clauseIds'], ['assessment', 'outcome']]) {
    const packet = reviewed(input());
    packet.rows[0][alias] = packet.rows[0][field];
    delete packet.rows[0][field];
    const checked = checkSourceReviewReport(packet, input());
    assert.equal(checked.retentionReady, false);
    assert.ok(checked.findings.some((entry) => entry.field === `rows[0].${field}`));
    assert.throws(() => evaluateSubmittedSourceReview(packet, input(), session), (error) =>
      error.code === 'SOURCE_REVIEW_REPORT_INVALID' && error.details.findings.some((entry) => entry.field === `rows[0].${field}`));
  }
  const packet = reviewed(input());
  packet.findings = [{ id: 'missing-error', severity: 'high', explanation: 'Missing error screenshot.' }];
  const fields = checkSourceReviewReport(packet, input()).findings.map((entry) => entry.field);
  assert.ok(fields.includes('findings[0].severity'));
  assert.ok(fields.includes('findings[0].message'));
});

test('test-only paths are legitimate but independent unsupported judgments and human decisions remain gates', () => {
  const ctx = input();
  const packet = reviewed(ctx);
  packet.rows[1].assessment = 'unsupported';
  packet.findings = [{ id: 'missing-error', severity: 'blocking', clauseId: 'REVIEW-1:AC-001',
    message: 'The approved specification requires success and error screenshots; only success is planned.' }];
  const checked = checkSourceReviewReport(packet, ctx);
  assert.equal(checked.retentionReady, true, 'honest semantic gaps can be retained without granting phase approval');
  assert.equal(checked.evaluation.status, 'correction-required');
  assert.ok(!checked.evaluation.findings.some((entry) => entry.code === 'plan-path-missing'));
  assert.ok(checked.evaluation.findings.some((entry) => entry.code === 'plan-assessment-gap'));
  assert.ok(checked.evaluation.findings.some((entry) => entry.code === 'reviewer-blocker'));
  assert.equal(checked.evaluation.pendingDispositions[0].id, 'not-applicable:REVIEW-1:AC-001');
  assert.equal(evaluateSubmittedSourceReview(packet, ctx, session).status, 'correction-required');
});

test('a reviewer cannot alter pinned plan obligations or use test-only to waive source paths', () => {
  const ctx = input();
  for (const [field, value] of [['plannedTests', []], ['fulfillment', 'new'], ['observableResult', 'Changed'], ['steps', ['other']]]) {
    const packet = reviewed(ctx);
    packet.rows[0][field] = value;
    const checked = checkSourceReviewReport(packet, ctx);
    assert.equal(checked.retentionReady, false);
    assert.ok(checked.findings.some((entry) => entry.field === `rows[0].${field}`));
  }
  const ordinary = input();
  ordinary.artifact.text = ordinary.artifact.text.replace(' | Fulfillment | Steps | Observable result |', ' | Steps | Observable result |')
    .replace('|---|---|---|---|---|---|', '|---|---|---|---|---|')
    .replace(' | test-only | verification |', ' | verification |').replace(' | document | implementation |', ' | implementation |');
  ordinary.binding = sourceReviewBinding(ordinary);
  const report = reviewed(ordinary);
  const checked = checkSourceReviewReport(report, ordinary);
  assert.ok(checked.evaluation.findings.some((entry) => entry.code === 'plan-path-missing'));
  report.rows[0].fulfillment = 'test-only';
  assert.equal(checkSourceReviewReport(report, ordinary).retentionReady, false);
});

test('planning schema cannot be used as the specification schema, and checks cannot invent provenance', () => {
  const ctx = input();
  assert.equal(validateSourceReviewReport(reviewed(ctx), 'specification').status, 'correction-required');
  assert.throws(() => evaluateSubmittedSourceReview(reviewed(ctx), ctx, { ...session, agent: ctx.authorAgentId }),
    (error) => error.code === 'SOURCE_REVIEW_INDEPENDENT_AGENT_REQUIRED');
  const packet = reviewed(ctx);
  packet.binding.generation = 2;
  assert.equal(checkSourceReviewReport(packet, input()).retentionReady, false);
});
