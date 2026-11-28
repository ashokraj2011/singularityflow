/**
 * The approval page never leaves the person stuck [owner, 2026-11-28; review "SFlow stuck points and decision whys",
 * section 4 items 2-5]:
 * - it told people to send the step back and had no button: Send back, with one reason field that says why it is asked;
 * - Approve could be pressed while a decision on the page was undecided, and the engine refused after the page closed;
 * - "Decide what blocks this step" went round the older Decisions page and Approvals back to this page;
 * - "Approval would be refused" showed a raw command with nothing to press.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { adviceForStep } from '../src/step-advice.mjs';

const page = await import('../apps/vscode/src/views/approval-review.ts');
const W = 'NSB-1';
const SEND_BACK = `singularity-flow reject planning --work-id ${W} --fetch --to planning --reason <reason>`;
const advice = adviceForStep({ phases: { planning: { label: 'Planning' } } }, 'planning');
const base = { title: 'Approve Planning', expected: 'planning', workId: W, phaseId: 'planning', phaseLabel: 'Planning', generation: 1,
  artifact: null, articles: [], findings: [], witnessedClauses: null, priorExceptions: [], selfApproval: false, advice };
const item = { id: 'd1', title: 'AC-001: a problem reported in Specification', why: 'Planning reported a problem.',
  options: [{ id: 'accept-risk', label: 'Accept it as a risk until a date', needs: { expires: { default: '2026-12-25' }, reason: { default: 'Accepted until the date.' } } },
    { id: 'dismiss', label: 'Dismiss it', needs: { reason: { default: 'Not a defect.' } } }] };

test('Send back: a button with one reason field, whose words say why the reason is asked, and the engine\'s own route', () => {
  const html = page.approvalReviewBody(base);
  assert.match(html, /<button type="button" class="secondary" data-send-back-button>Send back<\/button>/u);
  assert.match(html, /<div class="approval-send-back" data-send-back hidden>/u);
  assert.ok(html.includes(`Why send it back? <span>${page.afterLabel(advice.sendBack, 'Send back')}</span>`), 'the field says the next version is written to answer it');
  assert.doesNotMatch(html.match(/<textarea data-send-back-reason[^>]*>/u)[0], /required/u, 'a hidden field never blocks Approve');
  // One press after the reason: the script posts it, with no second confirmation.
  assert.match(page.REVIEW_SCRIPT, /postMessage\(\{ type: 'approval\.sendBack', reason: reason \}\)/u);
  assert.doesNotMatch(page.REVIEW_SCRIPT, /confirm\(/u);
  // The host checks the reason, and runs the decision list's own route with it, never a command from the page.
  assert.deepEqual(page.sendBackReason({ type: 'approval.sendBack', reason: '  ' }).reason, null);
  assert.equal(page.sendBackReason({ type: 'approval.sendBack', reason: ' The plan misses the error case. ' }).reason, 'The plan misses the error case.');
  const listed = { items: [{ kind: 'approval', details: { sendBack: SEND_BACK } }] };
  assert.equal(page.sendBackOf(listed), SEND_BACK);
  assert.deepEqual(page.sendBackArgv(page.sendBackOf(listed), 'The plan misses the error case.'),
    ['reject', 'planning', '--work-id', W, '--fetch', '--to', 'planning', '--reason', 'The plan misses the error case.']);
  assert.equal(page.sendBackOf({ items: [{ kind: 'approval', details: { sendBack: 'rm -rf /' } }] }), null, 'only the engine\'s reject route');
  assert.equal(page.sendBackArgv(null, 'x'), null);
});

test('Approve stays off while a decision on the page is undecided: one line says what and why, with a button to each', () => {
  const request = { ...base, inApproval: { digest: 'sha256:'.padEnd(71, 'a'), items: [item] }, pendingDecisions: { count: 1, headline: 'Planning has 1 decision.' } };
  const html = page.approvalReviewBody(request);
  assert.match(html, /<option value="">Choose a decision…<\/option>/u, 'no "Not now" that reads as an answer');
  assert.ok(html.includes(`data-undecided="${advice.stops.undecided.replaceAll('\'', '&#39;')}"`), 'the line says why it blocks, from the advice');
  // The script keeps Approve off while a row is undecided or a decision the page cannot answer holds it, and names each.
  assert.match(page.REVIEW_SCRIPT, /return complete && !undecidedRows\(\)\.length && !heldElsewhere;/u);
  assert.match(page.REVIEW_SCRIPT, /go\.textContent = 'Decide ' \+ row\.querySelector\('legend'\)\.textContent;/u);
  // The host refuses the same, so a page that let it through still records nothing.
  const undecided = page.validateApprovalReviewSubmission(request, { confirmation: 'planning', decisions: [], witnessDecisions: [], inApprovalDecisions: [] });
  assert.equal(undecided.value, null);
  assert.match(undecided.errors.join(' '), /Decide 'AC-001: a problem reported in Specification' first\. Approve stays off until each item below is decided/u);
  const decided = page.validateApprovalReviewSubmission(request, { confirmation: 'planning', decisions: [], witnessDecisions: [],
    inApprovalDecisions: [{ item: 'd1', option: 'dismiss', reason: 'It is covered by the plan.' }] });
  assert.deepEqual(decided.errors, []);
  // A decision the page cannot answer: Approve stays off too, and the button that decides it returns here.
  const held = { ...base, pendingDecisions: { count: 2, headline: 'Planning has 2 decisions.' } };
  assert.match(page.approvalReviewBody(held), /The button opens them on one card, then brings you back to this page\./u);
  assert.match(page.validateApprovalReviewSubmission(held, { confirmation: 'planning', decisions: [], witnessDecisions: [] }).errors.join(' '),
    /Choose Decide what blocks this step: it opens them, then brings you back here\./u);
});

test('"Approval would be refused" has something to press: its route by place, run by the host from its own list', async () => {
  const approvalCheck = { ready: false, holds: [{ code: 'APPROVAL_INTENT_AMENDMENT_PENDING', owner: 'someone-decides', who: 'An approver of Specification',
    summary: 'Approving planning waits for intent amendment AMD-001 to be decided.', action: { label: 'Decide it on the card.', command: `singularity-flow decisions ${W}` } }] };
  const request = { ...base, approvalCheck };
  assert.deepEqual(page.approvalPageRoutes(request), [`singularity-flow decisions ${W}`]);
  const html = page.approvalReviewBody(request);
  assert.match(html, /<button type="button" class="secondary" data-hold-run="0">Do this now<\/button>/u);
  assert.doesNotMatch(html.slice(html.indexOf('Holds on this approval')), /<pre><code>singularity-flow decisions/u, 'no raw command to copy');
  assert.match(page.REVIEW_SCRIPT, /postMessage\(\{ type: 'approval\.run', route: Number\(run\.dataset\.holdRun\) \}\)/u);
  // The Approvals card does the same for its holds, by place.
  const { holdRoutes } = await import('../apps/vscode/src/views/approvals-model.ts');
  assert.deepEqual(holdRoutes({ approvalHolds: [{ action: { command: `singularity-flow decisions ${W}` } }, { action: null }] }), [`singularity-flow decisions ${W}`]);
});

test('the page says why the person is asked, and each button\'s line, from the step\'s advice', () => {
  const html = page.approvalReviewBody(base);
  const shown = (text) => html.includes(text.replaceAll('\'', '&#39;'));
  assert.ok(shown(`<strong>Why you are asked:</strong> ${advice.decides}`));
  assert.ok(shown(`<strong>Approve Planning v1:</strong> ${page.afterLabel(advice.yes, 'Yes')}`));
  assert.ok(shown(`<strong>Send back:</strong> ${page.afterLabel(advice.sendBack, 'Send back')}`));
  assert.ok(shown(`<strong>Not now:</strong> ${page.afterLabel(advice.notNow, 'Not now')}`));
  assert.ok(shown(advice.settles), 'what SFlow settles itself');
});
