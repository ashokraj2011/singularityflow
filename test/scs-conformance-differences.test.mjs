/**
 * Spec–code sync M1 [SCS:REQ-010 to REQ-014]: a deviated or unplanned conformance row is a difference a
 * person decides, as a partial or missing one is: fix the code, update the spec, accept it for now, or
 * dismiss it. Only Stories that pin the rule; a Story pinned before keeps the rule its report was approved under.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verdictSummaryBlock } from '../src/conformance-readiness.mjs';
import { conformanceVerdictGaps, decidesConformanceDifferences, unstatedConformanceDifferences } from '../src/conformance-verdicts.mjs';
import { recordableInApproval } from '../src/approval-decisions.mjs';
import { decisionGroups, decisionPacket, decisionRecordPlan, effectWords, ISSUE_ONLY_OPTIONS, parseDecisionAnswers } from '../src/decision-list.mjs';
import { DECISION_LIST_CHAT_OPTIONS } from '../src/person-step-catalog.mjs';
import { EACH, firstForm, NOT_NOW, RECORD, runCard, sharedAnswers } from '../plugin/extensions/decisions/card.mjs';
import { decideHtml, sharedAnswers as cardSharedAnswers } from '../apps/vscode/src/views/decide-card-page.ts';
import { normalizeSpecPolicy } from '../src/specifications.mjs';
import { conformanceGapDecisions, conformanceGapRefusal, upstreamIssueStates } from '../src/upstream-routes.mjs';

const W = 'ORD-7';
const AT = '2026-11-09T09:00:00.000Z';
const DECIDE = { conformanceDifferences: 'decide' };

function story({ spec = DECIDE, status = 'awaiting_approval', issues = [], decisions = [], extra = {} } = {}) {
  return {
    workItem: { id: W }, status: 'in_progress', currentPhase: 'conformance',
    phaseOrder: ['requirements', 'implementation', 'verification', 'conformance'],
    phases: {
      requirements: { id: 'requirements', label: 'Requirements', status: 'approved', generation: 1, requiredArtifact: { kind: 'requirements' },
        approvalPolicy: { authorities: ['product-approvers'] } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'approved', generation: 1, generationPolicy: { task: 'code' },
        writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary' }, approvalPolicy: { authorities: ['engineering-reviewers'] } },
      verification: { id: 'verification', label: 'Verification', status: 'approved', generation: 1, requiredArtifact: { kind: 'test-evidence' } },
      conformance: { id: 'conformance', label: 'Conformance', status, generation: 1,
        requiredArtifact: { kind: 'conformance-report', path: 'artifacts/conformance/spec-code-comparison.md' },
        approvalPolicy: { authorities: ['quality-reviewers'], rejectTo: ['implementation', 'verification', 'conformance'] } }
    },
    resolution: { spec, obligationGraph: { nodes: [{ id: 'requirements', responsibilities: ['scope'] }, { id: 'implementation', responsibilities: [] },
      { id: 'verification', responsibilities: [] }, { id: 'conformance', responsibilities: [] }] }, approvalAuthorities: {
      'product-approvers': { label: 'Product approvers', allowAnyGitIdentity: true, members: [] },
      'engineering-reviewers': { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] },
      'quality-reviewers': { label: 'Quality reviewers', allowAnyGitIdentity: true, members: [] }
    } },
    upstreamIssues: issues, upstreamIssueDecisions: decisions, ...extra
  };
}

const REPORT = [
  '| Clause ID | Requirement/specification | Code evidence | Test evidence | Verdict | Deviation |', '|---|---|---|---|---|---|',
  `| \`${W}:REQ-003\` | Search times out after 5 s | src/search.js | test/search.test.js | deviated | code waits 10 s; the clause says 5 s |`,
  `| \`${W}:REQ-004\` | Orders list | src/orders.js, src/cache.js | test/orders.test.js | unplanned | src/cache.js adds a cache no clause asks for |`,
  `| \`${W}:REQ-005\` | Totals | src/totals.js | test/totals.test.js | partial | rounding untested |`,
  `| \`${W}:REQ-006\` | Export | src/export.js | test/export.test.js | matched | |`
].join('\n');

const gapsOf = (workflow, report = REPORT) => conformanceVerdictGaps(report, { workflow, phaseId: 'conformance' });
const decided = (workflow, options = {}) => conformanceGapDecisions(workflow, 'conformance', gapsOf(workflow), { now: AT, ...options });
const byClause = (gaps, clause) => gaps.find((entry) => entry.clauseId === `${W}:${clause}`);

test('a new Story decides deviated and unplanned rows; a Story pinned before keeps partial and missing only', () => {
  assert.equal(normalizeSpecPolicy().conformanceDifferences, 'decide');
  assert.equal(normalizeSpecPolicy({ conformanceDifferences: 'legacy' }).conformanceDifferences, 'legacy');
  assert.throws(() => normalizeSpecPolicy({ conformanceDifferences: 'maybe' }), /spec.conformanceDifferences must be legacy or decide/u);
  // The pinned raw field decides, never a normalized default: an older Story has no field.
  assert.equal(decidesConformanceDifferences(story()), true);
  assert.equal(decidesConformanceDifferences(story({ spec: {} })), false);
  assert.equal(decidesConformanceDifferences(story({ spec: { conformanceDifferences: 'legacy' } })), false);
  assert.deepEqual(gapsOf(story()).map((entry) => [entry.clauseId, entry.verdict, entry.difference ?? null]), [
    [`${W}:REQ-003`, 'deviated', 'code waits 10 s; the clause says 5 s'],
    [`${W}:REQ-004`, 'unplanned', 'src/cache.js adds a cache no clause asks for'],
    [`${W}:REQ-005`, 'partial', null]
  ]);
  assert.deepEqual(gapsOf(story({ spec: {} })).map((entry) => entry.clauseId), [`${W}:REQ-005`], 'an older Story keeps its rule');
  // The verdict words read as before: a verdict joined to its note by a colon is not a verdict.
  assert.deepEqual(gapsOf(story(), REPORT.replace('| partial |', '| partial: rounding |')).map((entry) => entry.verdict), ['deviated', 'unplanned']);
});

test('a deviated or unplanned row must say what differs; a note after the verdict counts, a TODO does not', () => {
  const table = (verdict, deviation) => ['| Clause ID | Code evidence | Verdict | Deviation |', '|---|---|---|---|',
    `| \`${W}:REQ-003\` | src/search.js | ${verdict} | ${deviation} |`].join('\n');
  assert.deepEqual(unstatedConformanceDifferences(table('deviated', '')).map((row) => [row.verdict, row.line]), [['deviated', 3]]);
  assert.deepEqual(unstatedConformanceDifferences(table('unplanned', 'TODO')).map((row) => row.verdict), ['unplanned']);
  assert.deepEqual(unstatedConformanceDifferences(table('deviated (waits 10 s, the clause says 5 s)', '')), []);
  assert.deepEqual(unstatedConformanceDifferences(table('deviated', 'waits 10 s')), []);
  assert.deepEqual(unstatedConformanceDifferences(table('partial', '')), [], 'a gap row needs no difference');
  // A table with no Deviation column still says it after the verdict.
  const plain = ['| Criterion | Verdict |', '|---|---|', `| \`${W}:REQ-003\` | deviated |`].join('\n');
  assert.deepEqual(unstatedConformanceDifferences(plain).map((row) => row.verdict), ['deviated']);
});

test('an undecided difference offers fixing the code and reporting it, never reusing a recorded run', () => {
  const workflow = story();
  const reused = [{ id: 'ERU-001', clauses: [`${W}:REQ-003`, `${W}:REQ-004`, `${W}:REQ-005`], label: 'Implementation\'s run' }];
  const gaps = decided(workflow, { reused, satisfied: [`${W}:REQ-003`] });
  const deviated = byClause(gaps, 'REQ-003');
  assert.equal(deviated.status, 'unraised', 'a recorded run proves tests ran, not that the code says what the clause says');
  assert.equal(deviated.evidenceSatisfied, undefined);
  assert.equal(deviated.owner, 'requirements', 'the step that defines the clause owns a difference; fixing the code is one of its choices');
  assert.deepEqual(deviated.choices.map((choice) => choice.kind), ['correct-report', 'update-spec', 'raise-upstream-issue', 'fix-code']);
  assert.match(deviated.choices.find((choice) => choice.kind === 'update-spec').command,
    /story intent-amendment draft --clause ORD-7:REQ-003 --work-id ORD-7 --out "<amended scope file>"/u);
  assert.match(deviated.choices.find((choice) => choice.kind === 'fix-code').command, /reject conformance --work-id ORD-7 --to implementation/u);
  assert.match(deviated.choices.find((choice) => choice.kind === 'raise-upstream-issue').command, /<how the code differs from the clause>/u);
  assert.match(byClause(gaps, 'REQ-004').choices.find((choice) => choice.kind === 'raise-upstream-issue').command,
    /<what the code does that the clause does not ask for>/u);
  assert.equal(byClause(gaps, 'REQ-005').status, 'decided', 'a partial row keeps its reuse');
  assert.deepEqual(conformanceGapRefusal(workflow, 'conformance', gapsOf(workflow), { now: AT }).gaps.map((entry) => entry.clauseId),
    [`${W}:REQ-003`, `${W}:REQ-004`, `${W}:REQ-005`]);
  assert.equal(conformanceGapRefusal(story({ spec: {} }), 'conformance', gapsOf(story({ spec: {} })), { now: AT }).gaps.length, 1,
    'an older Story is held only by its partial row');
});

test('a difference is settled by a dated risk, a dismissal, the spec following the code, or an accepted departure', () => {
  const issue = { id: 'UPI-001', phase: 'requirements', about: `${W}:REQ-003`, problem: 'The search waits 10 s; the requirement says 5 s.' };
  // A dated risk decides it, as for a gap.
  const risked = decided(story({ issues: [issue], decisions: [{ issue: 'UPI-001', outcome: 'accept-risk', expiresAt: '2026-12-01T00:00:00.000Z',
    reason: 'Accepted until the timeout is reviewed.', at: AT }] }));
  assert.deepEqual([byClause(risked, 'REQ-003').status, byClause(risked, 'REQ-003').outcome], ['decided', 'accept-risk']);
  // Update the spec: the clause's step changes only through an intent amendment; one waiting for the
  // scope approvers holds the row as amending, and its approval settles it.
  const open = byClause(decided(story({ issues: [issue] })), 'REQ-003');
  assert.deepEqual([open.status, open.choices.map((choice) => choice.kind)], ['undecided', ['correct-report', 'update-spec', 'decide-upstream-issue', 'fix-code']]);
  const proposedIntent = byClause(decided(story({ extra: { intentAmendments: [{ id: 'AMD-001', status: 'proposed', changedClauses: [`${W}:REQ-003`] }] } })), 'REQ-003');
  assert.deepEqual([proposedIntent.status, proposedIntent.issue, proposedIntent.choices.map((choice) => choice.kind)],
    ['amending', 'AMD-001', ['decide-intent-amendment']]);
  // A forward amendment of a document step, proposed for the issue, holds it the same way.
  const proposal = { id: 'FAM-001', phase: 'requirements', upstreamIssue: 'UPI-001', fromGeneration: 1, proposedPath: 'x', reason: 'r', at: AT };
  const amending = byClause(decided(story({ issues: [issue], extra: { forwardAmendments: [proposal] } })), 'REQ-003');
  assert.deepEqual([amending.status, amending.issue, amending.choices.map((choice) => choice.kind)], ['amending', 'FAM-001', ['decide-amendment']]);
  assert.match(conformanceGapRefusal(story({ issues: [issue], extra: { forwardAmendments: [proposal] } }), 'conformance',
    gapsOf(story()), { now: AT }).lines.join('\n'), /FAM-001 is updating requirements's document to match the code/u);
  // Approved, the spec now says what the code does.
  const approved = byClause(decided(story({ issues: [issue], extra: { forwardAmendments: [proposal],
    forwardAmendmentDecisions: [{ amendment: 'FAM-001', phase: 'requirements', decision: 'approved', reason: 'r', at: AT }] } })), 'REQ-003');
  assert.deepEqual([approved.status, approved.outcome, approved.issue], ['decided', 'amended', 'FAM-001']);
  // So is an approved intent amendment naming the clause.
  const intent = byClause(decided(story({ extra: { intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: [`${W}:REQ-003`] }] } })), 'REQ-003');
  assert.deepEqual([intent.status, intent.outcome], ['decided', 'amended']);
  // Read by the clauses a proposal records it changes (changedClauses), never by another clause's amendment.
  assert.equal(byClause(decided(story({ extra: { intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: [`${W}:REQ-006`] }] } })), 'REQ-003').status, 'unraised');
  // An unplanned row the code step already departed with, accepted by a person, is never asked again.
  const departure = { id: 'DEP-001', kind: 'path', phase: 'implementation', generation: 1, paths: ['src/cache.js'], clauses: [] };
  const amendment = { id: 'PAM-001', departures: ['DEP-001'], at: AT, contentHashes: {} };
  const covered = byClause(decided(story({ extra: { departures: [departure], planAmendments: [amendment] } })), 'REQ-004');
  assert.deepEqual([covered.status, covered.outcome, covered.issue], ['decided', 'departure', 'DEP-001']);
  assert.equal(byClause(decided(story({ extra: { departures: [departure] } })), 'REQ-004').status, 'unraised', 'an open departure decides nothing');
});

test('the decision list shows a difference with its four choices, apart from gaps, and leaves an amendment to its own item', () => {
  const workflow = story();
  const gaps = decided(workflow).filter((entry) => entry.status !== 'decided').map((entry) => ({ ...entry, report: 'conformance' }));
  const groups = decisionGroups(workflow, { gaps, issues: [] });
  assert.deepEqual(groups.map((group) => group.gaps.map((entry) => entry.verdict)), [['deviated', 'unplanned'], ['partial']],
    'a difference is its own problem, never merged with a gap');
  assert.deepEqual(decisionGroups(workflow, { gaps: [{ ...gaps[0], status: 'amending' }] }), [], 'the pending amendment is its own item');

  const facts = { phaseId: 'conformance', at: AT, endsStory: true, gaps: gaps.filter((entry) => entry.verdict !== 'partial'), issues: upstreamIssueStates(workflow, AT), activeReuse: [], candidates: [],
    reuseProblems: [], testRisks: [], unavailable: [], state: {} };
  const packet = decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Quality Person', email: 'quality@example.invalid', login: null }, at: AT });
  const item = packet.items.find((entry) => entry.kind === 'conformance-gap');
  assert.match(item.title, /REQ-003 and REQ-004 are deviated and unplanned in the Conformance report/u);
  assert.match(item.why, /It says: REQ-003: code waits 10 s; the clause says 5 s; REQ-004: src\/cache\.js adds a cache no clause asks for\./u);
  assert.deepEqual(item.options.map((entry) => entry.id), ['fix-code', 'update-spec', 'accept-risk', 'dismiss']);
  const update = item.options.find((entry) => entry.id === 'update-spec');
  assert.notEqual(update.recordable, false, 'one choice drafts it, with no command to copy [SCS:REQ-020]');
  assert.deepEqual(item.options.find((entry) => entry.id === 'accept-risk').effects.map((effect) => [effect.kind, effect.phase ?? effect.issuePhase]),
    [['upstream-issue', 'requirements'], ['upstream-issue-decision', 'requirements']], 'accepting it for now is the scope approvers\' call');
  assert.ok(!DECISION_LIST_CHAT_OPTIONS.includes('update-spec') && ISSUE_ONLY_OPTIONS.includes('accept-risk'));
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=accept-risk'] }), { at: AT });
  assert.deepEqual(plan.steps.map((step) => [step.item, step.option]), [['d1', 'accept-risk']]);
  assert.match(item.options.find((entry) => entry.id === 'fix-code').action.command, /reject conformance --work-id ORD-7 --to implementation/u);
});

test('an older Story keeps its exact summary sentence; a new one names every verdict it decides', () => {
  const none = '| Clause ID | Verdict | Deviation |\n|---|---|---|\n| `ORD-7:REQ-006` | matched | |';
  assert.match(verdictSummaryBlock(none, story({ spec: {} }), 'conformance'), /- No clause in the table is partial or missing\./u);
  assert.match(verdictSummaryBlock(none, story(), 'conformance'), /- No clause in the table is partial, missing, deviated or unplanned\./u);
  const summary = verdictSummaryBlock(REPORT, story(), 'conformance', { now: AT });
  assert.match(summary, /`ORD-7:REQ-003`: deviated; no issue raised yet; requirements owns it\./u);
  assert.match(summary, /`ORD-7:REQ-005`: partial; no issue raised yet; implementation owns it\./u);
});

const DRAFT = '/repo/.git/singularity-flow/intent-amendment-drafts/ORD-7.md';

function differencePacket(draft = { path: DRAFT, clauses: [] }, actor = { name: 'Someone Else', email: 'else@example.invalid', login: null }) {
  const workflow = story({ extra: { resolution: { ...story().resolution, approvalAuthorities: {
    ...story().resolution.approvalAuthorities, 'product-approvers': { label: 'Product approvers', allowAnyGitIdentity: false, members: [{ githubLogin: 'product-lead' }] } } } } });
  const gaps = decided(workflow).filter((entry) => entry.status !== 'decided' && entry.verdict !== 'partial').map((entry) => ({ ...entry, report: 'conformance' }));
  const facts = { phaseId: 'conformance', at: AT, endsStory: true, gaps, issues: upstreamIssueStates(workflow, AT), activeReuse: [], candidates: [],
    reuseProblems: [], testRisks: [], unavailable: [], state: {}, intentAmendmentDraft: draft };
  return { workflow, packet: decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities, actor, at: AT }) };
}

test('Update the spec drafts the amendment in one choice, with the rows and the person\'s reason, and decides nothing [SCS:REQ-020]', () => {
  const { workflow, packet } = differencePacket();
  const item = packet.items.find((entry) => entry.kind === 'conformance-gap');
  const update = item.options.find((entry) => entry.id === 'update-spec');
  assert.equal(update.action, undefined, 'no command for the person to copy');
  assert.deepEqual(update.effects.map((effect) => [effect.kind, effect.phase, effect.clauses, effect.path]),
    [['intent-amendment-draft', 'requirements', [`${W}:REQ-003`, `${W}:REQ-004`], DRAFT]]);
  assert.deepEqual(update.effects[0].rows, [
    { clauseId: `${W}:REQ-003`, verdict: 'deviated', difference: 'code waits 10 s; the clause says 5 s', report: 'Conformance report' },
    { clauseId: `${W}:REQ-004`, verdict: 'unplanned', difference: 'src/cache.js adds a cache no clause asks for', report: 'Conformance report' }]);
  assert.deepEqual([update.needs.reason.default, update.needs.reason.minimum], ['', 20], 'the reason in the slot is the person\'s own');
  // Drafting decides nothing, so anyone on the Story may take it; deciding the difference stays with the scope approvers.
  assert.equal(update.decidedBy.allowed, true);
  assert.match(update.decidedBy.words, /Requirements's approvers decide the amendment/u);
  assert.equal(item.options.find((entry) => entry.id === 'accept-risk').decidedBy.allowed, false, 'accepting it for now is still theirs alone');
  assert.equal(recordableInApproval(update), false, 'an approval never carries a draft');
  assert.ok(!DECISION_LIST_CHAT_OPTIONS.includes('update-spec'), 'a chat turn never writes it for the person');
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=update-spec'], reason: ['d1=Legacy callers rely on the longer wait.'] }), { at: AT });
  assert.deepEqual(plan.steps.map((step) => [step.option, step.values.reason]), [['update-spec', 'Legacy callers rely on the longer wait.']]);
  assert.match(effectWords(workflow, plan.steps[0].effects[0]), new RegExp(`^draft Requirements's scope with a slot for REQ-003 and REQ-004 at ${DRAFT}; nothing is recorded or decided`, 'u'));
  assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=update-spec'] }), { at: AT }), /reason for d1 must be 20 to 1000 characters/u);
});

test('once drafted, the list says where the draft is and that writing and proposing it is next [SCS:REQ-021, REQ-022]', () => {
  const { packet } = differencePacket({ path: DRAFT, clauses: [`${W}:REQ-003`, `${W}:REQ-004`] });
  const item = packet.items.find((entry) => entry.kind === 'conformance-gap');
  assert.match(item.why, new RegExp(`A draft of Requirements's scope with a slot for each of them is at ${DRAFT}: write them as the code does it, then propose it\\.`, 'u'));
  assert.deepEqual(item.details.draft, { path: DRAFT, clauses: [`${W}:REQ-003`, `${W}:REQ-004`] });
  const update = item.options.find((entry) => entry.id === 'update-spec');
  assert.equal(update.recordable, false, 'the wording is a person\'s or the Story\'s agent\'s');
  assert.equal(update.action.command, `singularity-flow story intent-amendment propose --work-id ${W} --file "${DRAFT}" --reason "<why the specification changes>"`);
  assert.equal(update.action.file, DRAFT, 'a host may open the engine\'s own path');
  assert.match(update.words, /\/sf-reject intent-amendment propose/u);
  assert.equal(update.decidedBy.allowed, true);
  assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=update-spec'] }), { at: AT }), /is your own step, not a recorded decision/u);
  // A draft for other clauses, or one from before an approved amendment (no clauses), drafts again.
  const other = differencePacket({ path: DRAFT, clauses: [`${W}:REQ-003`] }).packet.items.find((entry) => entry.kind === 'conformance-gap');
  assert.equal(other.options.find((entry) => entry.id === 'update-spec').effects[0].kind, 'intent-amendment-draft');
  assert.equal(other.details.draft, null);
});

test('a proposed amendment is the row\'s item: it holds the approval, and the approval check adds no item of its own [SCS:REQ-023]', () => {
  const workflow = story({ extra: { intentAmendments: [{ id: 'AMD-001', status: 'proposed', changedClauses: [`${W}:REQ-003`] }] } });
  const gaps = decided(workflow).filter((entry) => entry.status !== 'decided' && entry.clauseId === `${W}:REQ-003`).map((entry) => ({ ...entry, report: 'conformance' }));
  assert.deepEqual(gaps.map((entry) => [entry.status, entry.issue]), [['amending', 'AMD-001']]);
  const words = `Phase 'conformance' cannot be approved until a person decides each clause: ${W}:REQ-003 remains deviated: AMD-001 is updating requirements's document to match the code.`;
  const facts = { phaseId: 'conformance', at: AT, endsStory: true, gaps, issues: upstreamIssueStates(workflow, AT), activeReuse: [], candidates: [], reuseProblems: [], testRisks: [],
    unavailable: [], state: {}, scopePhase: 'requirements', pending: { intentAmendments: workflow.intentAmendments },
    approvalCheck: { holds: [{ code: 'CONFORMANCE_BLOCKING_VERDICTS', owner: 'someone-decides', summary: words, message: words },
      { code: 'STORY_COMPLETION_REFUSED', owner: 'someone-decides', summary: `Story ${W} cannot finish yet.`, message: `Story ${W} cannot finish yet: AMD-001.` }] } };
  const packet = decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Quality Person', email: 'quality@example.invalid', login: null }, at: AT });
  assert.deepEqual(packet.items.map((item) => [item.kind, item.holdsApproval]), [['intent-amendment', true], ['approval', false]]);
  assert.match(packet.items[0].title, /Decide intent amendment AMD-001/u);
});

test('an approved amendment that is revalidated still decides its row', () => {
  const workflow = story({ extra: { intentAmendments: [{ id: 'AMD-001', status: 'revalidated', changedClauses: [`${W}:REQ-003`] }] } });
  assert.deepEqual([byClause(decided(workflow), 'REQ-003').status, byClause(decided(workflow), 'REQ-003').outcome], ['decided', 'amended']);
});

test('a revalidation row is the step\'s own approvers\' choice on the list: it still holds, or the Story returns to it [SCS:REQ-022]', () => {
  const workflow = story({ status: 'awaiting_approval', extra: { intentAmendments: [{ id: 'AMD-001', status: 'approved', producer: 'requirements',
    revalidate: [{ phase: 'implementation', generation: 1 }, { phase: 'conformance', generation: 1 }] }] } });
  const facts = { phaseId: 'conformance', at: AT, endsStory: true, gaps: [], issues: [], activeReuse: [], candidates: [], reuseProblems: [], testRisks: [],
    unavailable: [], state: {}, pending: { forwardAmendments: [
      { code: 'AMENDMENT_REVALIDATION_REQUIRED', amendment: 'AMD-001', phase: 'implementation', producer: 'requirements', message: 'm',
        command: 'singularity-flow upstream-issue revalidate implementation --work-id ORD-7 --amendment AMD-001 --outcome unchanged|return --reason "<why>"' },
      { code: 'AMENDMENT_REVALIDATION_REQUIRED', amendment: 'AMD-001', phase: 'conformance', producer: 'requirements', message: 'm', command: 'c' }] } };
  const packet = decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Quality Person', email: 'quality@example.invalid', login: null }, at: AT });
  const [code, report] = packet.items.filter((entry) => entry.kind === 'forward-amendment');
  assert.equal(code.title, 'Revalidate Implementation after AMD-001');
  assert.match(code.why, /^Implementation read Requirements before AMD-001 amended it\. Its approvers say it still holds/u);
  assert.deepEqual(code.options.map((entry) => [entry.id, entry.label, entry.effects[0].outcome, entry.decidedBy.groups]), [
    ['still-holds', 'Implementation still holds', 'unchanged', ['engineering-reviewers']],
    ['return-step', 'Return the Story to Implementation', 'return', ['engineering-reviewers']]]);
  assert.deepEqual(report.options.map((entry) => entry.label), ['Confirm the report: it still holds', 'Return it for a new report']);
  assert.deepEqual(report.options[0].decidedBy.groups, ['quality-reviewers'], 'the report\'s approvers confirm it');
  // "Still holds" may be one answer for the rows a person approves, worded alike on each host; a return is row by row.
  assert.deepEqual([...code.options, ...report.options].map((entry) => [entry.id, entry.oneByOne ?? false, entry.sharedLabel ?? null]), [
    ['still-holds', false, 'Still holds'], ['return-step', true, null], ['still-holds', false, 'Still holds'], ['return-step', true, null]]);
  assert.ok(!DECISION_LIST_CHAT_OPTIONS.includes('still-holds') && !DECISION_LIST_CHAT_OPTIONS.includes('return-step'), 'never a chat turn\'s to answer');
  assert.equal(recordableInApproval(code.options[0]), false);
  // A return moves the Story, so it is written after every other answer.
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: [`${report.id}=return-step`, `${code.id}=still-holds`],
    reason: [`${report.id}=The report should judge the amended requirement again.`] }), { at: AT });
  assert.deepEqual(plan.steps.map((step) => [step.item, step.option]), [[code.id, 'still-holds'], [report.id, 'return-step']]);
  assert.match(effectWords(workflow, plan.steps[0].effects[0]), /^record that Implementation still holds under AMD-001/u);
  assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers({ choose: [`${report.id}=return-step`] }), { at: AT }), /reason for d\d must be 20 to 1000/u);
});

test('"Still holds for all N, with one reason" covers only the rows this person decides; each is still its own record [SCS:REQ-022]', async () => {
  // Verification's row is the test leads': it stays listed for them.
  const base = story();
  const workflow = story({ status: 'awaiting_approval', extra: {
    intentAmendments: [{ id: 'AMD-001', status: 'approved', producer: 'requirements',
      revalidate: [{ phase: 'implementation', generation: 1 }, { phase: 'verification', generation: 1 }, { phase: 'conformance', generation: 1 }] }],
    resolution: { ...base.resolution, approvalAuthorities: { ...base.resolution.approvalAuthorities,
      'test-leads': { label: 'Test leads', allowAnyGitIdentity: false, members: [{ githubLogin: 'test-lead' }] } } } } });
  workflow.phases.verification.approvalPolicy = { authorities: ['test-leads'] };
  const row = (phase) => ({ code: 'AMENDMENT_REVALIDATION_REQUIRED', amendment: 'AMD-001', phase, producer: 'requirements', message: 'm', command: 'c' });
  const facts = { phaseId: 'conformance', at: AT, endsStory: true, gaps: [], issues: [], activeReuse: [], candidates: [], reuseProblems: [], testRisks: [],
    unavailable: [], state: {}, pending: { forwardAmendments: ['implementation', 'verification', 'conformance'].map(row) } };
  const packet = decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Quality Person', email: 'quality@example.invalid', login: null }, at: AT });
  const [code, testing, report] = packet.items.filter((entry) => entry.kind === 'forward-amendment');
  assert.deepEqual([code, testing, report].map((entry) => entry.decidedBy.allowed), [true, false, true]);

  // Copilot CLI: one choice beside "Decide each one"; the return is not offered for all.
  assert.deepEqual(sharedAnswers(packet).map((entry) => [entry.id, entry.label, entry.items.map((item) => item.id), entry.others.map((item) => item.id)]),
    [['still-holds', 'Still holds', [code.id, report.id], [testing.id]]]);
  const { form } = firstForm(packet);
  assert.deepEqual(form.requestedSchema.properties.choice.enum, ['Still holds for all 2, with one reason', EACH, NOT_NOW]);
  assert.match(form.message, /"Still holds for all 2, with one reason" covers only the rows you decide; 1 more stays listed for their own approvers \(Revalidate Verification after AMD-001\)\.$/u);
  const reason = 'The amended requirement is what each step was built and checked against.';
  const asked = [];
  const replies = [{ action: 'accept', content: { choice: 'Still holds for all 2, with one reason' } }, { action: 'accept', content: { reason } },
    { action: 'accept', content: { confirm: RECORD } }];
  let document = null;
  const result = await runCard({ ask: async (shown) => { asked.push(shown); return replies.shift() ?? { action: 'cancel' }; }, show: async () => {},
    read: async () => packet, record: async (read, written) => { document = written; return { recorded: Object.keys(written.choose).map((item) => ({ item, record: item })) }; },
    witness: async () => null, inspect: async () => {} });
  assert.match(asked[1].message, /^Still holds for all 2, with one reason\. Each of the 2 is recorded on its own, with this reason\./u);
  assert.equal(result.status, 'recorded');
  assert.deepEqual([document.choose, document.reason], [{ [code.id]: 'still-holds', [report.id]: 'still-holds' }, { [code.id]: reason, [report.id]: reason }]);
  // Recorded as two revalidations, one per row, each with the shared reason; the test leads' row is left to them.
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: Object.entries(document.choose).map(([item, option]) => `${item}=${option}`),
    reason: Object.entries(document.reason).map(([item, text]) => `${item}=${text}`) }), { at: AT });
  assert.deepEqual(plan.steps.map((step) => [step.item, step.effects.map((effect) => [effect.kind, effect.phase, effect.outcome])]), [
    [code.id, [['amendment-revalidation', 'implementation', 'unchanged']]], [report.id, [['amendment-revalidation', 'conformance', 'unchanged']]]]);

  // The VS Code card offers the same answer in the same words, and says what it leaves.
  assert.deepEqual(cardSharedAnswers(packet).map((entry) => [entry.id, entry.label, entry.rows, entry.others]), [['still-holds', 'Still holds', 2, 1]]);
  const html = decideHtml(packet);
  assert.match(html, /<option value="still-holds">Still holds \(2 rows\)<\/option>/u);
  assert.match(html, /"Still holds" covers only the rows you decide; 1 more stays listed for their own approvers\./u);
});

test('rows hold the waiting step\'s approval and carry its input, ending and history holds, so no hold reads as nobody\'s [SCS:REQ-022]', () => {
  const workflow = story({ extra: { intentAmendments: [{ id: 'AMD-001', status: 'approved', producer: 'requirements', revalidate: [{ phase: 'conformance', generation: 1 }] }] } });
  const words = 'These 2 commits after the submission may not precede approval: - 15b3 [ORD-7][intent-amendment:propose] AMD-001; - 180e [ORD-7][intent-amendment:approve] AMD-001.';
  const facts = { phaseId: 'conformance', at: AT, endsStory: true, gaps: [], issues: [], activeReuse: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {},
    pending: { forwardAmendments: [{ code: 'AMENDMENT_REVALIDATION_REQUIRED', amendment: 'AMD-001', phase: 'conformance', producer: 'requirements', message: 'm', command: 'c' }] },
    approvalCheck: { holds: [{ code: 'STORY_REVIEW_INTERVENING_COMMIT', owner: 'author-repairs', summary: words, message: words },
      { code: 'STORY_COMPLETION_REFUSED', owner: 'someone-decides', summary: 'Story ORD-7 cannot finish yet.', message: 'conformance read requirements before AMD-001 amended it.' }] } };
  const packet = decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Quality Person', email: 'quality@example.invalid', login: null }, at: AT });
  assert.deepEqual(packet.items.map((item) => [item.kind, item.holdsApproval]), [['forward-amendment', true], ['approval', false]]);
  // Another commit after the submission is its own hold, as before.
  const other = decisionPacket(workflow, { ...facts, approvalCheck: { holds: [{ code: 'STORY_REVIEW_INTERVENING_COMMIT', owner: 'author-repairs',
    summary: 'One commit after the submission: 9a9a [ORD-7] edit the report.', message: 'One commit after the submission: 9a9a [ORD-7] edit the report.' }] } },
  { authorities: workflow.resolution.approvalAuthorities, actor: { name: 'Quality Person', email: 'quality@example.invalid', login: null }, at: AT });
  assert.deepEqual(other.items.map((item) => item.kind), ['forward-amendment', 'approval-hold', 'approval']);
});

test('only an amendment whose changed clauses are all differences of the waiting report is revalidated; any other reopens, as before [SCS:REQ-022]', async (t) => {
  const { differenceAmendmentReport } = await import('../src/state.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-scs-qualifies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { workItemRoot: 'singularity/work-items' };
  await mkdir(path.join(root, 'singularity/work-items', W, 'artifacts/conformance'), { recursive: true });
  await writeFile(path.join(root, 'singularity/work-items', W, 'artifacts/conformance/spec-code-comparison.md'), REPORT);
  const amendment = (...changed) => ({ diff: { changed } });
  const qualifies = (workflow, proposal) => differenceAmendmentReport(root, config, workflow, proposal);
  assert.deepEqual(await qualifies(story(), amendment(`${W}:REQ-003`)), { phase: 'conformance', clauses: [`${W}:REQ-003`] });
  assert.deepEqual(await qualifies(story(), amendment(`${W}:REQ-004`, `${W}:REQ-003`)), { phase: 'conformance', clauses: [`${W}:REQ-003`, `${W}:REQ-004`] });
  assert.equal(await qualifies(story(), amendment(`${W}:REQ-003`, `${W}:REQ-006`)), null, 'a matched clause changes what the code must do');
  assert.equal(await qualifies(story(), amendment(`${W}:REQ-005`)), null, 'a partial row is a gap, not a difference');
  assert.equal(await qualifies(story(), amendment(`${W}:REQ-099`)), null, 'a new clause');
  assert.equal(await qualifies(story(), amendment()), null);
  assert.equal(await qualifies(story({ spec: {} }), amendment(`${W}:REQ-003`)), null, 'a Story pinned before differences were decided');
  assert.equal(await qualifies(story({ status: 'in_progress' }), amendment(`${W}:REQ-003`)), null, 'the report is not waiting for its approval');
  assert.equal(await qualifies({ ...story(), currentPhase: 'verification' }, amendment(`${W}:REQ-003`)), null, 'the current step is not the report');
});
