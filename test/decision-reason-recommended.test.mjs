/**
 * No reason for the recommended option [owner, 2026-11-19, C10], and the record of whether each answer matched it [Q13].
 *
 * Picking the item's single recommended option on a kind 2 to 4 item asks no reason: the record keeps "Followed SFlow's
 * recommendation: <why>", long enough for every command's own minimum. Any other option keeps its reason, so does every
 * exception (an accepted risk, a reuse that accepts one, a responsibility that does not apply), and so does every option
 * of an item that names no single option. The question asked in chat says which answer is recommended and which side
 * takes a reason. The cards and the engine read the same needs, bound by the digest; each recorded answer carries its
 * advice entry, written with the decision.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { advisedItem, exceptionOption, RECOMMENDATION_REASON } from '../src/decision-advice.mjs';
import { decisionPacket, decisionRecordPlan, parseDecisionAnswers } from '../src/decision-list.mjs';
import { adviceLearning, adviceLearningLines, appendAdviceOutcomes, recordIdOf } from '../src/advice-outcomes.mjs';
import { upstreamIssueStates } from '../src/upstream-routes.mjs';
import { detailForm } from '../plugin/extensions/decisions/card.mjs';
import { decisionAnswersFromChoices } from '../apps/vscode/src/views/decision-list-model.ts';

const AT = '2026-11-19T09:00:00.000Z';
const WORK = 'REC-7';
const actor = { name: 'Decider', email: 'decider@example.invalid', login: null };

function story() {
  const group = (label) => ({ label, allowAnyGitIdentity: true, members: [] });
  return {
    workItem: { id: WORK }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product'] } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1, approvalPolicy: { authorities: ['engineering'] } }
    },
    resolution: { approvalAuthorities: { product: group('Product approvers'), engineering: group('Engineering reviewers') } },
    upstreamIssues: [], upstreamIssueDecisions: []
  };
}

const departure = (id, clauses = ['REC-7:AC-001']) => ({ departure: { id, kind: 'path', phase: 'implementation', paths: [`src/${id}.js`], clauses,
  reason: `src/${id}.js changed in this generation, and no row of the approved plan names it.`, recordedBy: 'sflow' }, status: 'open', groups: ['engineering'], words: `src/${id}.js changed`, acceptAll: true });

function packetOf(workflow = story(), extra = {}) {
  return decisionPacket(workflow, { phaseId: 'implementation', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {},
    departures: { phase: 'implementation', planRows: [{ clauseId: 'REC-7:AC-001', result: 'export' }, { clauseId: 'REC-7:AC-002', result: 'import' }], codeStepOpen: true,
      findingTitles: {}, acceptance: {}, reopens: {}, tests: {}, entries: [departure('DEP-001')] }, ...extra },
  { authorities: workflow.resolution.approvalAuthorities, actor, at: AT });
}

test('the recommended Accept needs no reason; Reject keeps its own, and the question says which side takes one', () => {
  const [item] = packetOf().items;
  assert.equal(item.kind, 'departure');
  assert.equal(item.recommended.option, 'accept');
  assert.equal(item.recommended.form, 'option');
  const accept = item.options.find((entry) => entry.id === 'accept');
  const reject = item.options.find((entry) => entry.id === 'reject');
  assert.equal(accept.needs.reason.minimum, 0);
  assert.equal(accept.needs.reason.recommended, true);
  assert.ok(accept.needs.reason.default.startsWith(RECOMMENDATION_REASON));
  assert.ok(accept.needs.reason.default.length >= 20, 'every command\'s own minimum still holds');
  assert.equal(reject.needs.reason.minimum, 20);
  assert.equal(reject.needs.reason.default, '');
  assert.match(item.yesNo.question, /Accept\? Recommended: yes\. The code step names AC-001 as what it serves/u);
  assert.match(item.yesNo.question, / A no says why in at least 20 characters\.$/u);
  assert.doesNotMatch(item.yesNo.question, /Say why in at least/u);
});

test('the engine records the recommendation\'s own reason for a blank Accept, refuses a blank Reject, and keeps a typed one', () => {
  const packet = packetOf();
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=accept'] }), { at: AT });
  assert.ok(plan.steps[0].values.reason.startsWith(RECOMMENDATION_REASON));
  assert.deepEqual(plan.steps[0].advice, { kind: 'departure', subject: 'DEP-001', phase: 'implementation', recommended: { form: 'option', option: 'accept' },
    chosen: { option: 'accept', outcome: 'accept' }, matched: true, reason: 'recommendation' });
  // A card sends an empty field as '': still the recommendation's own.
  const blank = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=accept'], reason: ['d1='] }), { at: AT });
  assert.ok(blank.steps[0].values.reason.startsWith(RECOMMENDATION_REASON));
  assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=reject'] }), { at: AT }), /The reason for d1 must be 20 to 1000 characters/u);
  const typed = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=reject'], reason: ['d1=This file belongs to another Story entirely.'] }), { at: AT });
  assert.equal(typed.steps[0].values.reason, 'This file belongs to another Story entirely.');
  assert.deepEqual([typed.steps[0].advice.matched, typed.steps[0].advice.reason], [false, 'typed']);
});

test('an exception keeps its reason even when it is the recommendation, and an item with no single option keeps every reason', () => {
  const workflow = story();
  workflow.upstreamIssues = [{ id: 'UPI-001', phase: 'specification', about: 'REC-7:REQ-001', problem: 'A field is missing.', raisedIn: { phase: 'implementation' } }];
  const packet = packetOf(workflow, { issues: upstreamIssueStates(workflow, AT),
    activeReuse: [{ id: 'ERU-001', phase: 'implementation', clauses: ['REC-7:REQ-001'] }] });
  const issue = packet.items.find((entry) => entry.kind === 'upstream-issue');
  assert.equal(issue.recommended.option, 'accept-risk');
  const risk = issue.options.find((entry) => entry.id === 'accept-risk');
  assert.ok(exceptionOption(risk));
  assert.equal(risk.needs.reason.minimum, 20, 'an accepted risk is always the person\'s reason');
  // Departures naming no clause: a lean, no single option.
  const lean = packetOf(story(), { departures: { phase: 'implementation', planRows: [{ clauseId: 'REC-7:AC-001' }, { clauseId: 'REC-7:AC-002' }], codeStepOpen: true,
    findingTitles: {}, acceptance: {}, reopens: {}, tests: {}, entries: [departure('DEP-002', [])] } }).items[0];
  assert.equal(lean.recommended.option, null);
  assert.ok(lean.options.every((entry) => !entry.needs.reason || entry.needs.reason.minimum === 20));
  // A kind 1 item keeps its own rule: an intent amendment's decision is never touched.
  const amendment = advisedItem(workflow, { id: 'd1', kind: 'intent-amendment', title: 'IAM-001', why: '', decidedBy: { allowed: true }, details: { status: 'approved' },
    options: [{ id: 'acknowledge', label: 'Acknowledge it', effects: [{ kind: 'intent-amendment-acknowledge' }], needs: { reason: { default: '', minimum: 20, maximum: 1000 } }, decidedBy: { allowed: true } }] });
  assert.equal(amendment.options[0].needs.reason.minimum, 20);
});

test('both cards take the recommended answer with nothing typed, and still ask a reason for the other', () => {
  const packet = { ...packetOf(), packetSha256: `sha256:${'a'.repeat(64)}` };
  const [item] = packet.items;
  // The Copilot CLI card: a reason field that may be empty is not required.
  const acceptForm = detailForm(item, item.options.find((entry) => entry.id === 'accept'));
  assert.equal(acceptForm.requestedSchema.required.includes('reason'), false);
  assert.equal(detailForm(item, item.options.find((entry) => entry.id === 'reject')).requestedSchema.required.includes('reason'), true);
  // VS Code's card: an empty field passes for Accept, and the engine fills the recommendation's reason.
  const accepted = decisionAnswersFromChoices(packet, [{ item: 'd1', option: 'accept', reason: '' }]);
  assert.deepEqual(accepted.errors, []);
  const rejected = decisionAnswersFromChoices(packet, [{ item: 'd1', option: 'reject', reason: '' }]);
  assert.match(rejected.errors.join(' '), /the reason must be 20 to 1000 characters/u);
});

test('the advice record keeps no free text and names the record the decision wrote; the report lists candidates only', () => {
  const workflow = story();
  const entry = { kind: 'departure', subject: 'DEP-001', phase: 'implementation', recommended: { form: 'option', option: 'accept' },
    chosen: { option: 'accept', outcome: 'accept' }, matched: true, reason: 'recommendation', words: 'never kept', actor: 'never kept' };
  const [kept] = appendAdviceOutcomes(workflow, [entry], { surface: 'card', record: recordIdOf({ id: 'PAM-004' }), at: AT });
  assert.deepEqual(kept, { id: 'ADV-001', kind: 'departure', subject: 'DEP-001', phase: 'implementation', recommended: { form: 'option', option: 'accept' },
    chosen: { option: 'accept', outcome: 'accept' }, matched: true, reason: 'recommendation', surface: 'card', record: 'PAM-004', at: AT });
  assert.equal(recordIdOf({ record: { id: 'DDC-002' } }), 'DDC-002');
  // Twenty answers across five Stories, all followed and none taken back: a candidate to settle, never settled by this.
  const stories = Array.from({ length: 5 }, (_, index) => {
    const each = { ...story(), workItem: { id: `REC-${index + 1}` } };
    for (let answer = 0; answer < 4; answer += 1) appendAdviceOutcomes(each, [entry], { surface: 'chat', at: AT });
    each.settledDecisions = [{ id: 'STL-001', kind: 'plan-accounting', effect: { file: 'docs/a.md', class: 'documentation' } }, { id: 'STL-002', undoes: 'STL-001' }];
    return each;
  });
  const report = adviceLearning(stories);
  assert.deepEqual(report.toSettle.map((row) => [row.kind, row.option, row.answers, row.stories, row.matchedPercent]), [['departure', 'accept', 20, 5, 100]]);
  assert.deepEqual(report.toAsk.map((row) => [row.kind, row.undonePercent]), [['plan-accounting (documentation)', 100]]);
  assert.match(adviceLearningLines(report).join('\n'), /a code change the owner approves/u);
  // A later answer to the same item that differs is a reversal: no longer a candidate.
  stories[0].adviceOutcomes.push({ ...stories[0].adviceOutcomes[0], id: 'ADV-099', chosen: { option: 'reject', outcome: 'return' }, matched: false, at: '2026-11-20T09:00:00.000Z' });
  assert.deepEqual(adviceLearning(stories).toSettle, []);
});
