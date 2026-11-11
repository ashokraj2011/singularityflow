/**
 * The code review contract [review level 2]: a code step's change is checked against its approved plan and the
 * evidence its delivery recorded, on four checks, every one cited at file:line:
 *   (a) plan: each delivered clause implemented where its plan row says; every changed path planned or reviewed;
 *   (b) tests: each delivered clause's own planned test ran, passed and proves it;
 *   (c) quality and security: every counted, held or unavailable result is reviewed;
 *   (d) readability and design: advisory, blocking only for a named maintainability defect.
 * And the policy that puts a review in every authored step of a new Story, and only a new one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { codeSourceId, evaluateSourceGroundedReview, sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { sourceReviewCitationGuide, sourceReviewReportTemplate, validateSourceReviewReport } from '../src/source-review-contract.mjs';
import { checkSourceReviewReport } from '../src/source-review-lifecycle.mjs';
import { availableDefaultSourceReview, normalizeSourceReviewPolicy, sourceReviewPolicyNotice, sourceReviewRequired } from '../src/source-review-policy.mjs';
import { sourceReviewKind } from '../src/phase-roles.mjs';

const CODE = ['// @clause:PAY-1:REQ-001 refunds go back to the card', 'export function refund(amount) {', '  return { amount, to: "card" };', '}', ''].join('\n');
const HELPER = ['export const round = (value) => Math.round(value * 100) / 100;', ''].join('\n');
const TESTS = ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { refund } from '../src/refund.mjs';",
  '// @ac:PAY-1:REQ-001', "test('refunds to the card', () => assert.equal(refund(5).to, 'card'));", ''].join('\n');

function context({ passed = true, quality = [], planned = true } = {}) {
  const sources = [
    { id: codeSourceId('src/refund.mjs'), path: 'src/refund.mjs', text: CODE },
    { id: codeSourceId('src/round.mjs'), path: 'src/round.mjs', text: HELPER },
    { id: codeSourceId('test/refund.test.mjs'), path: 'test/refund.test.mjs', text: TESTS }
  ];
  const code = {
    deliveredClauses: ['PAY-1:REQ-001'],
    planned: planned ? { 'PAY-1:REQ-001': { expectedPaths: ['src/refund.mjs'], tests: ['test/refund.test.mjs'], testDisposition: 'unspecified' } } : null,
    changedPaths: sources.map((source) => source.path),
    passedTests: passed ? ['test/refund.test.mjs'] : [],
    quality
  };
  const input = { kind: 'code', workId: 'PAY-1', phase: 'implement', generation: 1, sources, code,
    artifact: { path: 'singularity/work-items/PAY-1/artifacts/implement/summary.md', text: '# Implementation summary\n' },
    plan: { path: 'singularity/work-items/PAY-1/artifacts/intake/intake.md', text: '# Plan\n' },
    authorAgentId: 'sflow-coder', reviewerAgentId: 'sflow-source-reviewer', reviewerReadOnly: true };
  return { ...input, binding: sourceReviewBinding(input) };
}

const at = (ctx, relative, quote) => {
  const source = ctx.sources.find((entry) => entry.path === relative);
  return { sourceId: source.id, line: source.text.split('\n').findIndex((line) => line.includes(quote)) + 1, quote };
};

function report(ctx, change = (value) => value) {
  return change({
    ...sourceReviewReportTemplate(ctx),
    rows: [{ clauseId: 'PAY-1:REQ-001', implementation: [at(ctx, 'src/refund.mjs', 'return { amount, to: "card" };')],
      tests: [at(ctx, 'test/refund.test.mjs', "test('refunds to the card'")], assessment: 'implemented', testAssessment: 'proves' }],
    unplannedPaths: [{ sourceId: codeSourceId('src/round.mjs'), assessment: 'supporting', note: 'Rounds the refunded amount.' }],
    qualityReviewed: ctx.code.quality.map((entry) => entry.id),
    findings: []
  });
}

const codes = (result) => result.findings.map((entry) => entry.code).sort();

test('a code review that cites each clause\'s planned implementation and its own passing test is ready', () => {
  const ctx = context();
  const template = sourceReviewReportTemplate(ctx);
  assert.deepEqual(template.rows, [{ clauseId: 'PAY-1:REQ-001', implementation: [], tests: [], assessment: 'unreviewed', testAssessment: 'unreviewed' }],
    'the template names every delivered clause and leaves every judgement to the reviewer');
  assert.deepEqual(template.unplannedPaths, [{ sourceId: codeSourceId('src/round.mjs'), assessment: 'unreviewed', note: '' }]);
  assert.equal(validateSourceReviewReport(template, 'code').status, 'correction-required', 'an unreviewed template is not a review');
  const value = report(ctx);
  assert.equal(validateSourceReviewReport(value, 'code').status, 'ready');
  const result = evaluateSourceGroundedReview(value, ctx);
  assert.equal(result.status, 'ready', JSON.stringify(result.findings));
  assert.equal(checkSourceReviewReport(value, ctx).retentionReady, true);
  const guide = sourceReviewCitationGuide(ctx);
  assert.equal(guide.checks.length, 4);
  assert.match(guide.checks.join(' '), /\(a\) Plan.*\(b\) Tests.*\(c\) Quality and security.*\(d\) Readability and design/su);
  assert.match(guide.findingRule, /names its check and cites a changed file/u);
});

test('(a) plan: implementation outside the plan row, an unimplemented clause and an unreviewed or out-of-scope path hold the step', () => {
  const ctx = context();
  const outside = evaluateSourceGroundedReview(report(ctx, (value) => {
    value.rows[0].implementation = [at(ctx, 'src/round.mjs', 'export const round')];
    return value;
  }), ctx);
  assert.deepEqual(codes(outside), ['implementation-outside-plan']);
  assert.equal(outside.findings[0].check, 'plan');
  assert.match(outside.findings[0].message, /src\/round\.mjs.*planned: src\/refund\.mjs/u);
  assert.deepEqual(codes(evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value,
    rows: [{ ...value.rows[0], assessment: 'not-implemented' }] })), ctx)), ['clause-not-implemented']);
  assert.deepEqual(codes(evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value,
    rows: [{ ...value.rows[0], implementation: [] }] })), ctx)), ['clause-implementation-uncited']);
  assert.deepEqual(codes(evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value, unplannedPaths: [] })), ctx)), ['unplanned-path-unreviewed']);
  assert.deepEqual(codes(evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value,
    unplannedPaths: [{ ...value.unplannedPaths[0], assessment: 'out-of-scope', note: 'Not in the approved plan.' }] })), ctx)), ['unplanned-change']);
  assert.deepEqual(codes(evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value, rows: [] })), ctx)), ['clause-unreviewed']);
});

test('(b) tests: each delivered clause has its own planned test that ran, passed and proves it', () => {
  const ctx = context();
  assert.deepEqual(codes(evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value,
    rows: [{ ...value.rows[0], tests: [] }] })), ctx)), ['clause-test-uncited']);
  assert.deepEqual(codes(evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value,
    rows: [{ ...value.rows[0], testAssessment: 'does-not-prove' }] })), ctx)), ['clause-test-not-proving']);
  const unplanned = evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value,
    rows: [{ ...value.rows[0], tests: [at(ctx, 'src/round.mjs', 'export const round')] }] })), ctx);
  assert.deepEqual(codes(unplanned), ['clause-test-not-run', 'test-outside-plan']);
  const notRun = context({ passed: false });
  const result = evaluateSourceGroundedReview(report(notRun), notRun);
  assert.deepEqual(codes(result), ['clause-test-not-run']);
  assert.equal(result.findings[0].check, 'tests');
});

test('(c) quality and security: every counted, held or unavailable result is reviewed', () => {
  const ctx = context({ quality: [{ id: 'sonar-S2068', summary: 'sonarqube S2068 at src/refund.mjs:2: hard-coded credential' },
    { id: 'unavailable:secret-scan', summary: 'secret-scan could not run' }] });
  const missing = evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value, qualityReviewed: ['sonar-S2068'] })), ctx);
  assert.deepEqual(codes(missing), ['quality-not-reviewed']);
  assert.equal(missing.findings[0].qualityId, 'unavailable:secret-scan');
  assert.equal(evaluateSourceGroundedReview(report(ctx), ctx).status, 'ready');
  const blocking = evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value, findings: [{ id: 'fix-credential', severity: 'blocking', check: 'quality',
    message: 'The credential must come from configuration.', clauseId: 'PAY-1:REQ-001', ...at(ctx, 'src/refund.mjs', 'export function refund') }] })), ctx);
  assert.deepEqual(codes(blocking), ['reviewer-blocker']);
});

test('(d) readability and design: advisory by default, blocking only with a named defect; every finding cites file:line', () => {
  const ctx = context();
  const finding = { id: 'design-note', check: 'design', message: 'The refund target could be an enum.', ...at(ctx, 'src/refund.mjs', 'to: "card"') };
  const advisory = evaluateSourceGroundedReview(report(ctx, (value) => ({ ...value, findings: [{ ...finding, severity: 'advisory' }] })), ctx);
  assert.equal(advisory.status, 'ready', 'an advisory design finding never holds the step');
  const unnamed = report(ctx, (value) => ({ ...value, findings: [{ ...finding, severity: 'blocking' }] }));
  const refused = evaluateSourceGroundedReview(unnamed, ctx);
  assert.deepEqual(codes(refused), ['design-blocking-without-defect', 'reviewer-blocker']);
  assert.equal(checkSourceReviewReport(unnamed, ctx).retentionReady, false, 'a design blocker without a defect is the reviewer\'s to correct');
  const named = report(ctx, (value) => ({ ...value, findings: [{ ...finding, severity: 'blocking',
    defect: 'Two call sites already compare the string by hand; a third copy will drift.' }] }));
  assert.deepEqual(codes(evaluateSourceGroundedReview(named, ctx)), ['reviewer-blocker']);
  assert.equal(checkSourceReviewReport(named, ctx).retentionReady, true);
  const uncited = report(ctx, (value) => ({ ...value, findings: [{ id: 'vague', severity: 'advisory', check: 'design', message: 'Could be cleaner.' }] }));
  assert.deepEqual(codes(evaluateSourceGroundedReview(uncited, ctx)), ['finding-citation-missing']);
  assert.equal(checkSourceReviewReport(uncited, ctx).retentionReady, false);
  const unchecked = report(ctx, (value) => ({ ...value, findings: [{ id: 'which', severity: 'advisory', message: 'No check named.', ...at(ctx, 'src/refund.mjs', 'to: "card"') }] }));
  assert.deepEqual(codes(evaluateSourceGroundedReview(unchecked, ctx)), ['finding-citation-missing']);
  const misquoted = report(ctx, (value) => ({ ...value, rows: [{ ...value.rows[0], implementation: [{ ...value.rows[0].implementation[0], quote: 'return null;' }] }] }));
  assert.deepEqual(codes(evaluateSourceGroundedReview(misquoted, ctx)), ['citation-quote-invalid']);
  assert.equal(checkSourceReviewReport(misquoted, ctx).retentionReady, false);
});

test('a code review is bound to the changed bytes and the delivery evidence: either changing makes it stale', () => {
  const ctx = context();
  const value = report(ctx);
  const changed = context();
  changed.sources[0].text = CODE.replace('card', 'wallet');
  changed.binding = sourceReviewBinding(changed);
  assert.equal(evaluateSourceGroundedReview(value, changed).status, 'stale');
  const evidence = context({ passed: false });
  assert.equal(evaluateSourceGroundedReview(value, evidence).status, 'stale');
});

test('a document review gives every pinned source a cited row; an inconsistency or question holds the step', () => {
  const input = { kind: 'document', workId: 'PAY-1', phase: 'verify', generation: 1,
    sources: [{ id: 'story', path: 'story.md', text: 'Refunds go back to the card.\nNo partial refunds.\n' },
      { id: 'input:intake', path: 'intake.md', text: '# Intake\nRefund to the card.\n' }],
    artifact: { path: 'verify.md', text: '# Verification\n' }, authorAgentId: 'sflow-verifier', reviewerAgentId: 'sflow-source-reviewer', reviewerReadOnly: true };
  const ctx = { ...input, binding: sourceReviewBinding(input) };
  const rows = [{ id: 'r1', sourceId: 'story', line: 1, quote: 'Refunds go back to the card.', outcome: 'consistent' },
    { id: 'r2', sourceId: 'input:intake', line: 2, quote: 'Refund to the card.', outcome: 'consistent' }];
  const value = { ...sourceReviewReportTemplate(ctx), rows };
  assert.equal(validateSourceReviewReport(value, 'document').status, 'ready');
  assert.equal(evaluateSourceGroundedReview(value, ctx).status, 'ready');
  assert.deepEqual(codes(evaluateSourceGroundedReview({ ...value, rows: [rows[0]] }, ctx)), ['source-unmapped']);
  assert.deepEqual(codes(evaluateSourceGroundedReview({ ...value, rows: [rows[0], { ...rows[1], outcome: 'inconsistent', note: 'Says wallet.' }] }, ctx)), ['document-inconsistent']);
  assert.deepEqual(codes(evaluateSourceGroundedReview({ ...value, rows: [rows[0], { ...rows[1], outcome: 'question', note: 'Which card?' }] }, ctx)), ['source-question-unresolved']);
  assert.match(sourceReviewCitationGuide(ctx).mappingRule, /each pinned source/u);
});

test('every authored step of a new Story is reviewed unless the work type turns it off or skips the step; an old pin keeps its review', () => {
  const phases = ['intake', 'implement', 'converge', 'verify'];
  const authored = (id) => ({ intake: 'document', implement: 'code', converge: null, verify: 'document' })[id];
  const defaulted = normalizeSourceReviewPolicy(undefined, { workTypeId: 'quick-fix', phases, authored });
  assert.deepEqual(defaulted, { mode: 'enforce', level: 2, phases: ['intake', 'implement', 'verify'],
    kinds: { intake: 'document', implement: 'code', verify: 'document' }, reviewerAgent: 'sflow-source-reviewer', defaulted: true });
  assert.deepEqual(normalizeSourceReviewPolicy(defaulted, { workTypeId: 'quick-fix', phases, authored }), defaulted, 'normalizing twice changes nothing');
  assert.deepEqual(normalizeSourceReviewPolicy({ mode: 'off' }, { phases, authored }), { mode: 'off', phases: [], reviewerAgent: null });
  const skipped = normalizeSourceReviewPolicy({ skip: ['verify'] }, { phases, authored });
  assert.deepEqual(skipped.phases, ['intake', 'implement']);
  assert.deepEqual(skipped.skip, ['verify']);
  assert.throws(() => normalizeSourceReviewPolicy({ skip: ['nowhere'] }, { phases, authored }), /skip must list distinct active steps/u);
  // A legacy list no longer limits the review: it is kept, reported, and its scope step keeps its own kind.
  const legacy = normalizeSourceReviewPolicy({ mode: 'enforce', phases: ['intake'], reviewerAgent: 'sflow-source-reviewer' },
    { workTypeId: 'spec', phases, authored, reviewable: (id) => (id === 'intake' ? 'specification' : null) });
  assert.deepEqual(legacy.kinds, { intake: 'specification', implement: 'code', verify: 'document' });
  assert.deepEqual(legacy.supersededPhases, ['intake']);
  assert.match(sourceReviewPolicyNotice(legacy, 'spec'), /sourceReview\.phases \(intake\) is superseded: from review level 2 every authored step is reviewed, and the listed scope and plan steps keep their own reviews; list a step under sourceReview\.skip/u);
  assert.equal(sourceReviewPolicyNotice(defaulted, 'quick-fix'), null);
  // The default needs the packaged read-only reviewer; without one it says why instead of refusing every Story.
  assert.deepEqual(availableDefaultSourceReview(defaulted, [{ id: 'someone-else', metadata: {} }]),
    { mode: 'off', phases: [], reviewerAgent: null, defaulted: true, unavailableReviewer: 'sflow-source-reviewer' });
  const reviewer = { id: 'sflow-source-reviewer', metadata: { 'sflow-mode': 'read-only-review' }, defaultFor: ['verify'] };
  assert.deepEqual(availableDefaultSourceReview(defaulted, [reviewer]).phases, ['intake', 'implement'], 'a reviewer never reviews a step it authors');

  const pinned = (sourceReview) => ({ workItem: { id: 'PAY-1' }, resolution: { sourceReview, obligationGraph: { nodes: phases.map((id) => ({ id, responsibilities: id === 'intake' ? ['scope', 'plan'] : [] })) } },
    phases: Object.fromEntries(phases.map((id) => [id, { id }])) });
  const current = pinned(defaulted);
  assert.equal(sourceReviewKind(current, 'implement'), 'code');
  assert.equal(sourceReviewRequired(current, 'implement'), true);
  assert.equal(sourceReviewRequired(current, 'converge'), false, 'a step the kernel builds is not reviewed');
  const old = pinned({ mode: 'enforce', phases: ['intake'], reviewerAgent: 'sflow-source-reviewer' });
  assert.equal(sourceReviewRequired(old, 'intake'), true);
  assert.equal(sourceReviewRequired(old, 'implement'), false, 'a Story pinned before level 2 does not review its new steps');
  assert.equal(sourceReviewRequired(pinned({ mode: 'off', phases: [], reviewerAgent: null }), 'intake'), false);
});

// Exact repairs for a code review's own copying slips [agent input repairs, Story anu-bin 2026-11-11].
test('a code citation one line off gets its exact line, as a specification citation does', () => {
  const ctx = context();
  const value = report(ctx, (draft) => {
    draft.rows[0].implementation[0].line -= 1;
    draft.rows[0].tests[0].line += 1;
    return draft;
  });
  const checked = checkSourceReviewReport(value, ctx);
  assert.equal(checked.retentionReady, false);
  const fixed = report(ctx);
  // Before: the nested field was never read, so the guide said "No exact single-line match" with no line.
  assert.deepEqual(checked.repair.citations.map((entry) => entry.proposedEdit), [
    { field: 'rows[0].implementation[0].line', value: fixed.rows[0].implementation[0].line },
    { field: 'rows[0].tests[0].line', value: fixed.rows[0].tests[0].line }]);
  assert.ok(checked.repair.citations.every((entry) => entry.matchCount === 1 && typeof entry.suppliedLineText === 'string'));
});

test('a source ID that looks valid but is no source gets the exact ID, through the stage refusal too', async () => {
  const { refusalEnvelope } = await import('../src/refusal-remediation.mjs');
  const { SingularityFlowError } = await import('../src/util.mjs');
  const ctx = context();
  const value = report(ctx, (draft) => { draft.rows[0].tests[0].sourceId = 'code:refund.test.mjs'; return draft; });
  const checked = checkSourceReviewReport(value, ctx);
  assert.equal(checked.retentionReady, false);
  const unknown = checked.findings.find((entry) => entry.code === 'source-unknown');
  assert.match(unknown.message, /cites unknown source 'code:refund\.test\.mjs'; use code:test:refund\.test\.mjs exactly from sources\[\]\.id/u);
  assert.deepEqual(unknown.proposedEdit, { field: 'rows[0].tests[0].sourceId', value: 'code:test:refund.test.mjs' });
  assert.deepEqual(checked.repair.sourceIds, [{ field: 'rows[0].tests[0].sourceId', proposedEdit: unknown.proposedEdit }]);
  const refusal = refusalEnvelope(new SingularityFlowError('Repair.', { code: 'SOURCE_REVIEW_REPORT_INVALID', details: checked }), ['review-source', 'stage', 'implement']);
  assert.deepEqual(refusal.error.details.repair.sourceIds, checked.repair.sourceIds);
  assert.deepEqual(refusal.error.details.findings.find((entry) => entry.code === 'source-unknown').proposedEdit, unknown.proposedEdit);
});

test('a reviewer\'s slip in qualityReviewed or unplannedPaths is its own repair, never a gap retained for the author', () => {
  const ctx = context({ quality: [{ id: 'Q-1', summary: 'Unused variable', kind: 'quality' }] });
  const value = report(ctx, (draft) => {
    draft.qualityReviewed = ['Q-l'];
    draft.unplannedPaths[0].sourceId = 'code:src:rounding.mjs';
    return draft;
  });
  const checked = checkSourceReviewReport(value, ctx);
  // Before: both were dropped, the step got "Q-1 is not reviewed" and "src/round.mjs is in no plan row", and the
  // repair said "Retain this valid packet".
  assert.equal(checked.retentionReady, false);
  assert.equal(checked.repair.status, 'repair-packet');
  assert.deepEqual(checked.repair.repairs.map((entry) => entry.proposedEdit), [
    { field: 'unplannedPaths[0].sourceId', value: codeSourceId('src/round.mjs') },
    { field: 'qualityReviewed[0]', value: 'Q-1' }]);
});
