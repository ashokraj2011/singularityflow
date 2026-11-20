/**
 * SFlow fills what it knows [owner, 2026-11-20]: what a review report copies from its context is set by the check, in
 * the staged file, never a repair the reviewer spends. A planning review repeated eight plan fields per clause and a
 * code review wrote opaque source IDs by hand; each slip was a blocking copy finding and one of two repairs.
 * Judgments (assessment, testAssessment, outcome, severity, a finding's words) and near-match guesses never change.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { codeSourceId, sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { normalizeSourceReviewReport, sourceReviewCorrectionWords, sourceReviewReportTemplate } from '../src/source-review-contract.mjs';
import { checkSourceReviewReport, correctSourceReviewReport, withFieldValues } from '../src/source-review-lifecycle.mjs';

const W = 'REVIEW-1';
const PLAN = `# Plan
| Clause | Expected paths | Planned tests | Fulfillment | Steps | Observable result |
|---|---|---|---|---|---|
| \`${W}:REQ-001\` | \`src/app.mjs\` | \`test/app.test.mjs\`, \`test/app-more.test.mjs\` | new | implementation | The app verifies existing behavior |
| \`${W}:AC-001\` | \`docs/screenshots.md\` | not-applicable: manual screenshot inspection | document | implementation | Success screenshot |
`;

function planning() {
  const context = { kind: 'planning', workId: W, phase: 'plan', generation: 1,
    authorAgentId: 'architect', reviewerAgentId: 'sflow-source-reviewer', reviewerAgentSha256: 'a'.repeat(64),
    sources: [{ id: 'story', path: 'singularity/work-items/REVIEW-1/story.md', text: 'The existing behavior must be verified.\n' }],
    upstreamSpec: { path: 'spec.md', text: `# Requirements\n- Verify existing behavior. [${W}:REQ-001]\n- Show both success and error screenshots. [${W}:AC-001]\n` },
    artifact: { path: 'plan.md', text: PLAN } };
  return { ...context, binding: sourceReviewBinding(context) };
}

function supported(ctx) {
  const report = sourceReviewReportTemplate(ctx);
  for (const row of report.rows) row.assessment = 'supported';
  return report;
}

test('a planning report with copy slips everywhere is retainable in one check, judgments untouched', () => {
  const ctx = planning();
  const clean = supported(ctx);
  assert.equal(checkSourceReviewReport(clean, ctx).retentionReady, true, JSON.stringify(checkSourceReviewReport(clean, ctx).findings));
  const slipped = structuredClone(clean);
  const [first, second] = slipped.rows;
  first.testReason = 'reworded by the reviewer';
  first.expectedPaths = ['./src/app.mjs'];
  first.plannedTests = ['test/app.test.mjs'];
  first.clauseId = `${W}:req-001`.toLowerCase();
  first.observableResult = 'The app verifies "existing" behaviour';
  delete second.plannedTests;
  second.tests = ['other.test.mjs'];
  second.testDisposition = 'applicable';
  slipped.sourcesReviewed = ['singularity/work-items/REVIEW-1/story.md'];
  slipped.reviewer = { agentId: 'sflow-source-reviewr', readOnly: true };
  slipped.resultType = 'source-review';
  slipped.findings = [{ id: 'F-1', severity: 'advisory', clauseId: `${W}:ac-001`.toLowerCase(), explanation: 'Only the success screenshot is planned.' }];
  // A binding copied by hand with a hash cut short: a slip, never changed inputs.
  slipped.binding = structuredClone(ctx.binding);
  slipped.binding.artifact.sha256 = slipped.binding.artifact.sha256.slice(0, 20);
  const before = JSON.stringify(slipped);
  assert.equal(checkSourceReviewReport(slipped, ctx).retentionReady, false, 'without SFlow filling, each slip blocks');

  const { report, checked, corrected, correctedWords } = correctSourceReviewReport(slipped, ctx);
  assert.equal(checked.retentionReady, true, JSON.stringify(checked.findings));
  assert.equal(JSON.stringify(slipped), before, 'the packet given is not changed in place');
  assert.deepEqual(report.rows, clean.rows, 'the staged rows hold the plan\'s exact values');
  assert.deepEqual(report.sourcesReviewed, ['story']);
  assert.deepEqual(report.reviewer, { agentId: 'sflow-source-reviewer', readOnly: true });
  assert.equal(report.resultType, 'source-grounded-review');
  assert.deepEqual(report.findings, [{ id: 'F-1', severity: 'advisory', clauseId: `${W}:AC-001`, message: 'Only the success screenshot is planned.' }]);
  assert.deepEqual(report.binding, ctx.binding);
  const by = (why) => corrected.filter((entry) => entry.why === why).map((entry) => entry.field);
  assert.deepEqual(by('plan').sort(), ['rows[0].expectedPaths', 'rows[0].observableResult', 'rows[0].plannedTests', 'rows[0].testReason',
    'rows[1].plannedTests', 'rows[1].testDisposition'].sort());
  assert.deepEqual(by('clause-id'), ['rows[0].clauseId', 'findings[0].clauseId']);
  assert.deepEqual(by('renamed'), ['findings[0].message', 'rows[1].plannedTests']);
  assert.deepEqual(by('binding'), ['binding']);
  assert.equal(corrected.find((entry) => entry.why === 'binding').to, 'from-context', 'the file says from-context');
  assert.match(correctedWords, /^SFlow set \d+ values the report copies from its context \(.*plan fields.*the binding.*\)\.$/u);

  // Written back the way the staged file is: the same edits, applied to the file's own JSON.
  const file = withFieldValues(slipped, corrected);
  assert.equal(file.binding, 'from-context');
  assert.deepEqual(file.rows, clean.rows);
  assert.equal(Object.hasOwn(file.rows[1], 'tests'), false, 'a renamed key is moved, not copied');
  assert.equal(Object.hasOwn(file.findings[0], 'explanation'), false);
});

test('judgments, other clauses and near-match guesses stay the reviewer\'s', () => {
  const ctx = planning();
  const report = supported(ctx);
  report.rows[0].assessment = 'unsupported';
  report.rows[1].clauseId = `${W}:REQ-009`;
  report.findings = [{ id: 'F-1', severity: 'blocking', clauseId: `${W}:REQ-001`, message: 'The plan misses the error path.' }];
  const { normalized } = normalizeSourceReviewReport(report, ctx);
  assert.deepEqual(normalized, [], 'an unknown clause is a choice, never set; an assessment is a judgment');
  const result = correctSourceReviewReport(report, ctx);
  assert.equal(result.report, report);
  assert.equal(result.checked.retentionReady, false);
  const row = result.checked.findings.find((entry) => entry.field === 'rows[1].clauseId');
  assert.ok(row, 'the reviewer still gets the clause finding with its choices');

  // Changed inputs: nothing is filled from the new plan into a review of the old one.
  const stale = supported(ctx);
  stale.rows[0].testReason = 'reworded';
  stale.binding = { ...structuredClone(ctx.binding), generation: 2 };
  const kept = correctSourceReviewReport(stale, ctx);
  assert.deepEqual(kept.corrected, []);
  assert.equal(kept.report, stale);
  assert.equal(kept.checked.evaluation.status, 'stale');
});

const CODE = ['export const add = (a, b) => a + b;', ''].join('\n');
const LONG = `src/${'deeply-nested-folder/'.repeat(6)}math.mjs`;
const TESTS = [`import { add } from '../${LONG}';`,
  "test('adds', () => assert.equal(add(1, 2), 3));", ''].join('\n');

function code() {
  const sources = [{ id: codeSourceId(LONG), path: LONG, text: CODE }, { id: codeSourceId('test/math.test.mjs'), path: 'test/math.test.mjs', text: TESTS },
    { id: codeSourceId('src/App.jsx'), path: 'src/App.jsx', text: 'export default function App() { return null; }\n' }];
  const input = { kind: 'code', workId: 'ARSHY', phase: 'implementation', generation: 1, sources,
    code: { deliveredClauses: ['ARSHY:REQ-001'], changedPaths: sources.map((source) => source.path), passedTests: ['test/math.test.mjs'],
      quality: [{ id: 'sonar:1', summary: 'Complexity' }, { id: 'secret-scan', summary: 'Clean' }],
      planned: { 'ARSHY:REQ-001': { expectedPaths: [LONG], tests: ['test/math.test.mjs'], testDisposition: 'applicable' } } },
    clarifications: [{ id: 'clarification:author', phase: 'implementation', generation: 1, path: 'c.json', sha256: 'b'.repeat(64) }],
    artifact: { path: 'singularity/work-items/ARSHY/artifacts/implementation/summary.md', text: '# Summary\n' },
    plan: { path: 'singularity/work-items/ARSHY/artifacts/plan/plan.md', text: '# Plan\n' },
    authorAgentId: 'sflow-coder', reviewerAgentId: 'sflow-source-reviewer', reviewerReadOnly: true };
  return { ...input, binding: sourceReviewBinding(input) };
}

test('a code review cites files by path and leaves the reviewed lists to SFlow', () => {
  const ctx = code();
  assert.ok(/^code:[0-9a-f]{32}$/u.test(ctx.sources[0].id), 'the long path\'s ID is a hash the reviewer cannot derive');
  const template = sourceReviewReportTemplate(ctx);
  assert.deepEqual(template.qualityReviewed, ['sonar:1', 'secret-scan'], 'SFlow pre-ticks the quality results');
  assert.deepEqual(template.clarificationsReviewed, ['clarification:author'], 'and the clarifications');
  const report = { ...template, clarificationsReviewed: ['clarification:authr'], qualityReviewed: ['sonar-1'],
    rows: [{ clauseId: 'ARSHY:REQ-001', implementation: [{ path: LONG, line: 1, quote: 'export const add' }],
      tests: [{ sourceId: 'code:test/math.test.mjs', line: 2, quote: "test('adds'" }], assessment: 'implemented', testAssessment: 'proves' }],
    unplannedPaths: [{ sourceId: 'src/App.jsx', assessment: 'supporting', note: 'The app shell.' }],
    findings: [{ id: 'F-1', severity: 'advisory', check: 'design', sourceId: `./${LONG}`, line: 1, quote: 'a + b', message: 'Fine.' }] };
  const { report: fixed, checked, corrected } = correctSourceReviewReport(report, ctx);
  assert.equal(checked.retentionReady, true, JSON.stringify(checked.findings));
  assert.equal(fixed.rows[0].implementation[0].sourceId, ctx.sources[0].id);
  assert.equal(Object.hasOwn(fixed.rows[0].implementation[0], 'path'), false);
  assert.equal(fixed.rows[0].tests[0].sourceId, ctx.sources[1].id);
  assert.equal(fixed.unplannedPaths[0].sourceId, ctx.sources[2].id);
  assert.equal(fixed.findings[0].sourceId, ctx.sources[0].id);
  assert.deepEqual(fixed.qualityReviewed, ['sonar:1', 'secret-scan']);
  assert.deepEqual(fixed.clarificationsReviewed, ['clarification:author']);
  assert.equal(fixed.rows[0].assessment, 'implemented');
  assert.equal(fixed.rows[0].testAssessment, 'proves');
  assert.deepEqual(new Set(corrected.map((entry) => entry.why)), new Set(['renamed', 'source-id', 'acknowledged']));
  assert.match(sourceReviewCorrectionWords(corrected), /source IDs written as paths/u);

  // A path no source has is the reviewer's to fix: never guessed.
  const unknown = { ...report, unplannedPaths: [{ sourceId: 'src/Other.jsx', assessment: 'supporting', note: 'x' }] };
  assert.equal(correctSourceReviewReport(unknown, ctx).report.unplannedPaths[0].sourceId, 'src/Other.jsx');
});

test('a re-raised disputed finding keeps its ID when only its case slipped; a different finding never takes it', () => {
  const ctx = { ...code(), disputedEarlier: [{ id: 'DES-1', check: 'design', path: LONG, version: 1, message: 'm', reason: 'r' }] };
  const finding = (id, check = 'design') => ({ id, severity: 'blocking', check, defect: 'd', sourceId: ctx.sources[0].id, line: 1, quote: 'a + b', message: 'Same.' });
  const base = { ...sourceReviewReportTemplate(ctx) };
  assert.equal(normalizeSourceReviewReport({ ...base, findings: [finding('des-1')] }, ctx).report.findings[0].id, 'DES-1');
  assert.equal(normalizeSourceReviewReport({ ...base, findings: [finding('DES-2')] }, ctx).report.findings[0].id, 'DES-2', 'another ID is another finding');
  assert.equal(normalizeSourceReviewReport({ ...base, findings: [finding('des-1', 'plan')] }, ctx).report.findings[0].id, 'des-1', 'another check is another finding');
});
