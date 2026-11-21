/**
 * The reviewer's second pass, "does it work for its users and callers" (step intents spec §12.4, owner decision D7):
 * check (e) of a code review. A use finding that breaks use blocks, cites the code line and, when there is one, the
 * runtime check's finding, and goes to the author under the existing brake; an improvement is advice that never blocks
 * and never starts a version. Every runtime finding that breaks use is answered, one way or the other; a review
 * retained before a later check keeps its standing. The checklist follows the kinds the change touches.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { codeSourceId, evaluateSourceGroundedReview, sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { normalizeSourceReviewReport, sourceReviewCitationGuide, sourceReviewReportTemplate, USE_CHECKLISTS, validateSourceReviewReport } from '../src/source-review-contract.mjs';
import { checkSourceReviewReport } from '../src/source-review-lifecycle.mjs';

const GRAPH = ['import { useEffect, useRef } from "react";', 'export function Graph({ formula }) {', '  const ref = useRef(null);',
  '  useEffect(() => { ref.current.width = 400 + formula.length * 12; }, [formula]);', '  return <canvas ref={ref} />;', '}', ''].join('\n');
const TEST = ['import { test } from "node:test";', '// @ac:GR-1:REQ-001', 'test("plots the formula", () => {});', ''].join('\n');
const CAPTURE = { id: 'RTC-0123456789abcdef', current: true, checks: [{ project: 'repository-root', kind: 'web', status: 'ran', ran: ['load the page', 'typed into 1 input'],
  findings: [{ id: 'RT-001', use: 'breaks-use', type: 'layout-shift', title: 'canvas changes size while the page is used', detail: 'typing "Sam" into Formula: 400×300 became 436×300.' },
    { id: 'RT-002', use: 'improvement', type: 'overflow', title: 'The page scrolls sideways at phone width (390px)', detail: 'Its content is 40px wider than the window.' }] }] };

function context({ runtimeCheck = CAPTURE, useKinds = [] } = {}) {
  const sources = [{ id: codeSourceId('src/Graph.jsx'), path: 'src/Graph.jsx', text: GRAPH }, { id: codeSourceId('test/graph.test.mjs'), path: 'test/graph.test.mjs', text: TEST }];
  const code = { deliveredClauses: ['GR-1:REQ-001'], planned: { 'GR-1:REQ-001': { expectedPaths: ['src/Graph.jsx'], tests: ['test/graph.test.mjs'], testDisposition: 'unspecified' } },
    changedPaths: sources.map((source) => source.path), passedTests: ['test/graph.test.mjs'], quality: [] };
  const input = { kind: 'code', workId: 'GR-1', phase: 'implement', generation: 1, sources, code, ...(runtimeCheck ? { runtimeCheck } : {}), ...(useKinds.length ? { useKinds } : {}),
    artifact: { path: 'singularity/work-items/GR-1/artifacts/implement/summary.md', text: '# Implementation summary\n' },
    plan: { path: 'singularity/work-items/GR-1/artifacts/plan/plan.md', text: '# Plan\n' },
    authorAgentId: 'sflow-coder', reviewerAgentId: 'sflow-source-reviewer', reviewerReadOnly: true };
  return { ...input, binding: sourceReviewBinding(input) };
}
const at = (ctx, relative, quote) => {
  const source = ctx.sources.find((entry) => entry.path === relative);
  return { sourceId: source.id, line: source.text.split('\n').findIndex((line) => line.includes(quote)) + 1, quote };
};
const report = (ctx, findings = []) => ({ ...sourceReviewReportTemplate(ctx),
  rows: [{ clauseId: 'GR-1:REQ-001', implementation: [at(ctx, 'src/Graph.jsx', 'export function Graph')], tests: [at(ctx, 'test/graph.test.mjs', 'test("plots the formula"')],
    assessment: 'implemented', testAssessment: 'proves' }], findings });
const codes = (result) => result.findings.map((entry) => entry.code).sort();
const resize = (ctx, extra = {}) => ({ id: 'graph-resizes', check: 'use', use: 'breaks-use', severity: 'blocking', runtimeFinding: 'RT-001',
  message: 'The effect sets the canvas width from the formula length, so the graph resizes on every keystroke.', ...at(ctx, 'src/Graph.jsx', 'ref.current.width = 400 + formula.length * 12'), ...extra });

test('check (e) is in the guide with the checklists of the kinds the change touches, and the template names the runtime check it read', () => {
  const ctx = context({ useKinds: ['backend'] });
  const guide = sourceReviewCitationGuide(ctx);
  assert.match(guide.checks[4], /^\(e\) Does it work for its users and callers/u);
  assert.deepEqual(Object.keys(guide.useChecklist), ['any code', 'backend', 'web']);
  assert.equal(guide.useChecklist.web, USE_CHECKLISTS.web);
  assert.match(guide.runtimeRule, /Answer every runtimeCheck finding whose use is breaks-use/u);
  assert.equal(sourceReviewReportTemplate(ctx).runtimeChecked, 'RTC-0123456789abcdef');
  const plain = context({ runtimeCheck: null });
  assert.deepEqual(Object.keys(sourceReviewCitationGuide(plain).useChecklist), ['any code']);
  assert.equal(sourceReviewCitationGuide(plain).runtimeRule, undefined);
  assert.equal(Object.hasOwn(sourceReviewReportTemplate(plain), 'runtimeChecked'), false);
});

test('breaks use: a blocking finding citing the code line and the runtime evidence goes to the author', () => {
  const ctx = context();
  const value = report(ctx, [resize(ctx)]);
  assert.equal(validateSourceReviewReport(value, 'code').status, 'ready');
  const result = evaluateSourceGroundedReview(value, ctx);
  assert.deepEqual(codes(result), ['reviewer-blocker']);
  assert.equal(result.findings[0].reviewFindingId, 'graph-resizes');
  assert.equal(checkSourceReviewReport(value, ctx).retentionReady, true, 'retained as the author\'s to fix, under the existing brake');
  // It cites a line, as every finding does.
  const uncited = report(ctx, [resize(ctx, { line: undefined, quote: undefined })]);
  assert.ok(codes(evaluateSourceGroundedReview(uncited, ctx)).includes('finding-citation-missing'));
});

test('an improvement is advice: it never blocks and never starts a version, and the approval shows it', () => {
  const ctx = context();
  const advice = { id: 'labels', check: 'use', use: 'improvement', severity: 'advisory', message: 'The formula input has no visible label for screen readers.',
    ...at(ctx, 'src/Graph.jsx', 'return <canvas ref={ref} />;') };
  const answered = resize(ctx, { id: 'not-ours', use: 'improvement', severity: 'advisory', message: 'Not this change: the resize predates it.' });
  const result = evaluateSourceGroundedReview(report(ctx, [advice, answered]), ctx);
  assert.equal(result.status, 'ready', JSON.stringify(result.findings));
  assert.deepEqual(result.useAdvice.map((entry) => entry.id), ['labels', 'not-ours']);
});

test('a style-only review with improvements alone is ready; every runtime finding that breaks use must be answered', () => {
  const ctx = context();
  const style = { id: 'naming', check: 'use', use: 'improvement', severity: 'advisory', message: 'ref could be named canvasRef.', ...at(ctx, 'src/Graph.jsx', 'const ref = useRef(null);') };
  const silent = report(ctx, [style]);
  const result = evaluateSourceGroundedReview(silent, ctx);
  assert.deepEqual(codes(result), ['runtime-finding-unanswered']);
  assert.match(result.findings[0].message, /RT-001: canvas changes size while the page is used/u);
  assert.equal(checkSourceReviewReport(silent, ctx).retentionReady, false, 'the reviewer answers it before retaining');
  // With no runtime finding that breaks use, improvements alone never hold the step.
  const calm = context({ runtimeCheck: { ...CAPTURE, checks: [{ ...CAPTURE.checks[0], findings: [CAPTURE.checks[0].findings[1]] }] } });
  assert.equal(evaluateSourceGroundedReview(report(calm, [{ ...style, ...at(calm, 'src/Graph.jsx', 'const ref = useRef(null);') }]), calm).status, 'ready');
});

test('SFlow fills what it knows: the runtime check\'s id and a use finding\'s severity; an unknown runtime finding is named exactly', () => {
  const ctx = context();
  const { report: normalized, normalized: changes } = normalizeSourceReviewReport({ ...report(ctx, [resize(ctx, { severity: 'advisory' })]), runtimeChecked: undefined }, ctx);
  assert.equal(normalized.runtimeChecked, 'RTC-0123456789abcdef');
  assert.equal(normalized.findings[0].severity, 'blocking');
  assert.ok(changes.some((entry) => entry.why === 'use-class'));
  const mismatch = report(ctx, [resize(ctx, { severity: 'advisory' })]);
  assert.ok(codes(evaluateSourceGroundedReview(mismatch, ctx)).includes('use-severity-mismatch'));
  const unknown = evaluateSourceGroundedReview(report(ctx, [resize(ctx, { runtimeFinding: 'rt-001' })]), ctx);
  const named = unknown.findings.find((entry) => entry.code === 'runtime-finding-unknown');
  assert.deepEqual(named.proposedEdit, { field: 'findings[0].runtimeFinding', value: 'RT-001' });
});

test('a review retained before a later runtime check keeps its standing', () => {
  const ctx = context();
  const earlier = { ...report(ctx), runtimeChecked: 'RTC-ffffffffffffffff' };
  assert.equal(evaluateSourceGroundedReview(earlier, ctx).status, 'ready');
  const none = report(context({ runtimeCheck: null }));
  assert.equal(evaluateSourceGroundedReview(none, ctx).status, 'ready');
});
