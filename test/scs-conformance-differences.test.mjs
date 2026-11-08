/**
 * Spec–code sync M1 [SCS:REQ-010 to REQ-014]: a deviated or unplanned conformance row is a difference a
 * person decides, as a partial or missing one is: fix the code, update the spec, accept it for now, or
 * dismiss it. Only Stories that pin the rule; a Story pinned before keeps the rule its report was approved under.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { verdictSummaryBlock } from '../src/conformance-readiness.mjs';
import { conformanceVerdictGaps, decidesConformanceDifferences, unstatedConformanceDifferences } from '../src/conformance-verdicts.mjs';
import { recordableInApproval } from '../src/approval-decisions.mjs';
import { decisionGroups, decisionPacket, decisionRecordPlan, effectWords, ISSUE_ONLY_OPTIONS, parseDecisionAnswers } from '../src/decision-list.mjs';
import { DECISION_LIST_CHAT_OPTIONS } from '../src/person-step-catalog.mjs';
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
