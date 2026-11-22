/**
 * A review of a document SFlow writes from its records (record-documents.mjs) never asks that step's author for a fix
 * they cannot make. On d-story (2026-11-22) Verification reached version 11: its evidence is SFlow's, byte for byte the
 * same in every version, and each fresh reviewer blocked it for the same two things under new finding IDs, so the "same
 * finding came back" brake never held, and every route said to start the next version and fix the findings.
 *
 * - The document cites a person's sign-off for a slot the evaluator calls met.
 * - A blocking finding on the sealed document is the code step's whose records it reports (while publishing again would
 *   write it the same): the way on is one filled raise to that step's approvers, then it holds only the Story's ending.
 *   A person's dispute still stands as one.
 * - Starting the next version for such findings is refused with that raise: it would publish the same document again.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { recordDocumentOwner, sealed, testEvidence, writtenBySflow } from '../src/record-documents.mjs';
import { authoredArtifactText } from '../src/artifact-review-read.mjs';
import { evaluateSourceGroundedReview, sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { sourceReviewReportTemplate } from '../src/source-review-contract.mjs';
import { reviewUpstreamRoute, sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

const W = 'D-1';
const story = () => ({
  workItem: { id: W }, status: 'in_progress', currentPhase: 'verification', phaseOrder: ['specification', 'implementation', 'verification'],
  phases: {
    specification: { id: 'specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product'] } },
    implementation: { id: 'implementation', status: 'approved', generation: 1, approvalPolicy: { authorities: ['developers'] },
      deliveryEvidence: { testExecutions: [{ commandId: '.-node-tests', status: 'passed' }] } },
    verification: { id: 'verification', label: 'Verification', status: 'in_progress', generation: 11, approvalPolicy: { authorities: ['qa'] } }
  },
  witnessRecords: [{ id: 'WIT-004', clauseId: `${W}:AC-004`, slot: 'responsive-screen', method: 'visual', outcome: 'met',
    file: `singularity/work-items/${W}/evidence/visual-sign-offs/AC-004-responsive.png`, actor: 'qa-person' }]
});

test('a slot the evaluator calls met cites its person\'s sign-off, as on d-story\'s own records', () => {
  const workflow = story();
  const row = { id: `${W}:AC-004`, type: 'AC', result: 'satisfied', verification: { association: 'none', witnesses: [], tests: [],
    contract: { slots: [{ slot: 'responsive-screen', method: 'visual', status: 'met', witnesses: [] }] } } };
  assert.match(testEvidence(row, workflow.witnessRecords), /^visual sign-off `WIT-004` \(`singularity\/work-items\/D-1\/evidence\/visual-sign-offs\/AC-004-responsive\.png`\), confirmed by a person$/u);
});

test('the step that owns a record document\'s findings is the code step whose runs it reports', () => {
  const workflow = story();
  assert.equal(recordDocumentOwner(workflow, workflow.phases.verification), 'implementation');
  assert.equal(recordDocumentOwner(workflow, workflow.phases.specification), null, 'nothing before it delivered code');
});

test('the review reads a sealed record document as SFlow\'s, from the same authored text the review binds', async () => {
  const text = `<!-- singularity-flow:metadata\n{"schemaVersion":1,"generation":11}\n-->\n\n# ${W} — Verification Evidence\n\n> Written by SFlow from its records.\n\n## Agent brief\n\n9 of 10 requirements verified.\n`;
  const document = await sealed(text);
  assert.equal(await writtenBySflow(authoredArtifactText(document)), true);
  assert.equal(await writtenBySflow(authoredArtifactText(document).replace('9 of 10', '10 of 10')), false, 'an edit makes it the author\'s again');
});

function verificationReview({ recordDocument = null, humanDispositions = [] } = {}) {
  const input = { kind: 'document', workId: W, phase: 'verification', generation: 11,
    sources: [{ id: 'input:specification', path: 'spec.md', text: '# Spec\nA Playwright test verifies the circle.\n' }],
    artifact: { path: 'test-evidence.md', text: '# Verification\n' }, authorAgentId: 'qa', reviewerAgentId: 'sflow-source-reviewer', reviewerReadOnly: true,
    ...(recordDocument ? { recordDocument } : {}) };
  const context = { ...input, binding: sourceReviewBinding(input) };
  const report = { ...sourceReviewReportTemplate(context),
    rows: [{ id: 'r1', sourceId: 'input:specification', line: 2, quote: 'A Playwright test verifies the circle.', outcome: 'consistent' }],
    findings: [{ id: 'verification-playwright-evidence-missing', severity: 'blocking', clauseId: `${W}:AC-002`,
      message: 'D-1:AC-002 asks for a Playwright test (0, 0 circle), but the only run is the Vitest suite.' }] };
  return evaluateSourceGroundedReview(report, { ...context, humanDispositions });
}

test('a blocking finding on a sealed record document belongs to the code step whose records it reports', () => {
  const review = verificationReview({ recordDocument: { ownerPhase: 'implementation', upstreamIssues: [] } });
  assert.equal(review.status, 'correction-required');
  const [finding] = review.findings.filter((entry) => entry.code === 'reviewer-blocker');
  assert.equal(finding.upstreamPhase, 'implementation');
  assert.equal(finding.about, `${W}:AC-002`);
  assert.match(finding.message, /what SFlow wrote into verification from implementation's records, so a new version of verification would say the same/u);
  assert.equal(finding.recordDocument, true);
  assert.match(finding.problem, /^D-1:AC-002 asks for a Playwright test/u, 'the reviewer\'s own words, for the raise');
  // A document someone wrote by hand is still the step's own to correct.
  assert.equal(verificationReview().findings.find((entry) => entry.code === 'reviewer-blocker').upstreamPhase, undefined);
  // Once raised to implementation's approvers, it holds only the Story's ending: the review is ready.
  const raised = verificationReview({ recordDocument: { ownerPhase: 'implementation',
    upstreamIssues: [{ id: 'UPI-001', about: `${W}:AC-002`, problem: 'No Playwright test.', status: 'open' }] } });
  assert.equal(raised.status, 'ready');
  assert.deepEqual(raised.upstreamFindings.map((entry) => [entry.id, entry.issue]), [['verification-playwright-evidence-missing', 'UPI-001']]);
});

test('the way on is one raise, filled and runnable, never another version of the same document', () => {
  const workflow = story();
  const phase = workflow.phases.verification;
  const review = { ...verificationReview({ recordDocument: { ownerPhase: 'implementation', upstreamIssues: [] } }), reportSha256: 'a'.repeat(64), generation: 11 };
  const continuation = sourceReviewContinuation(workflow, phase, review);
  assert.equal(continuation.classification, 'upstream-issue-required');
  const [action] = continuation.actions;
  assert.doesNotMatch(action.command, /rollover|<[a-z-]+>/u, 'no new version, and nothing left to fill in');
  assert.match(action.command, /^singularity-flow upstream-issue raise --work-id D-1 --phase implementation --about verification-review-v11 --problem 'Review of verification version 11, a document SFlow wrote from implementation s records: D-1:AC-002, D-1:AC-002 asks for a Playwright test 0, 0 circle , but the only run is the Vitest suite\.'$/u);
  assert.ok(safeCommandGuidance({ command: action.command }), 'the route filter accepts it');
  assert.match(continuation.presentation, /^Now — Raise the review's findings to implementation's approvers\n/u);
  assert.match(reviewUpstreamRoute(workflow, phase, review).reason, /SFlow wrote verification from implementation's records, so another version would say the same\. Raise its findings to implementation's approvers; then only the ending waits\.$/u);
  // The refusal a start of the next version gets for it leads with that same raise.
  const plan = refusalRemediationPlan(Object.assign(new Error('refused'), { code: 'REVIEW_FINDINGS_UPSTREAM',
    details: { phase: 'verification', nextAction: { command: action.command, label: 'Raise it.', skill: '/sf-decide' } } }), ['phase', 'rollover', 'verification', '--review-findings', '--json']);
  assert.equal(plan.steps[0].command, action.command);
  assert.ok(plan.steps.every((entry) => !/rollover|recover --phase/u.test(entry.command ?? '')), JSON.stringify(plan.steps));
});

test('version 11 as it was: three rows found inconsistent and a blocker, raised in one issue that clears them all', () => {
  const workflow = story();
  const phase = workflow.phases.verification;
  const input = { kind: 'document', workId: W, phase: 'verification', generation: 11,
    sources: [{ id: 'input:specification', path: 'spec.md', text: '# Spec\nAC-004 is visual only.\n' },
      { id: 'input:planning', path: 'plan.md', text: '# Plan\nA responsive visual inspection.\n' },
      { id: 'input:implementation', path: 'summary.md', text: '# Summary\nVisual acceptance stays separate.\n' }],
    artifact: { path: 'test-evidence.md', text: '# Verification\n' }, authorAgentId: 'qa', reviewerAgentId: 'sflow-source-reviewer', reviewerReadOnly: true };
  const report = (context) => ({ ...sourceReviewReportTemplate(context),
    rows: [{ id: 'spec-visual-only', sourceId: 'input:specification', line: 2, quote: 'AC-004 is visual only.', outcome: 'inconsistent', note: 'Marked verified with no visual evidence.' },
      { id: 'plan-responsive', sourceId: 'input:planning', line: 2, quote: 'A responsive visual inspection.', outcome: 'inconsistent', note: 'No inspection recorded.' },
      { id: 'summary-visual', sourceId: 'input:implementation', line: 2, quote: 'Visual acceptance stays separate.', outcome: 'inconsistent', note: 'Not reported.' }],
    findings: [{ id: 'ac004-no-visual-evidence', severity: 'blocking', clauseId: `${W}:AC-004`, message: 'AC-004 is verified with no tagged test.' }] });
  const evaluate = (upstreamIssues) => {
    const context = { ...input, recordDocument: { ownerPhase: 'implementation', upstreamIssues } };
    const bound = { ...context, binding: sourceReviewBinding(context) };
    return { ...evaluateSourceGroundedReview(report(bound), bound), generation: 11, reportSha256: 'b'.repeat(64) };
  };
  const before = evaluate([]);
  assert.deepEqual(before.findings.map((entry) => [entry.code, entry.upstreamPhase]), [['document-inconsistent', 'implementation'],
    ['document-inconsistent', 'implementation'], ['document-inconsistent', 'implementation'], ['reviewer-blocker', 'implementation']]);
  const [action] = sourceReviewContinuation(workflow, phase, before).actions;
  for (const name of ['spec-visual-only', 'plan-responsive', 'summary-visual', 'D-1:AC-004']) assert.ok(action.command.includes(name), `${name} in ${action.command}`);
  assert.ok(safeCommandGuidance({ command: action.command }));
  // The issue that raise records (its about and problem as given) marks every one of them raised: the review is ready.
  const problem = action.command.match(/--problem '([^']+)'$/u)[1];
  const after = evaluate([{ id: 'UPI-001', about: 'verification-review-v11', problem, status: 'open' }]);
  assert.equal(after.status, 'ready', JSON.stringify(after.findings));
  assert.equal(after.upstreamFindings.length, 4);
});

test('a finding a person disputed stays disputed on a record document, and raises nothing', () => {
  const first = verificationReview({ recordDocument: { ownerPhase: 'implementation', upstreamIssues: [] } });
  const disputed = verificationReview({ recordDocument: { ownerPhase: 'implementation', upstreamIssues: [] }, humanDispositions: [{
    id: 'dispute:verification-playwright-evidence-missing', reportSha256: first.reportSha256, decision: 'accepted', actor: 'qa-person',
    reason: 'The Vitest suite drives the real canvas; the team agreed it stands in for Playwright here.' }] });
  assert.equal(disputed.status, 'ready');
  assert.equal(disputed.findings.some((entry) => entry.upstreamPhase), false);
  assert.deepEqual(disputed.disputedFindings.map((entry) => entry.id), ['verification-playwright-evidence-missing']);
});
