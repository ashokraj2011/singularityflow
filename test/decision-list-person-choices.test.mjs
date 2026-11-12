/**
 * What the owner's card answers beyond a plan path: a scope statement, a responsibility the Story's end
 * leaves out, a review of the scope, and a route. Each is a choice with nothing chosen and no reason
 * suggested, written by the same function its own command uses. A review nothing waits on is offered and
 * never counted, so no surface starts asking for it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionPacket, decisionRecordPlan, effectWords, parseDecisionAnswers, pendingSummary } from '../src/decision-list.mjs';
import { DECIDABLE_SCOPE_DISPOSITIONS, CLAUSE_LINKED_DISPOSITIONS } from '../src/scope/extract.mjs';
import { DECISION_LIST_CHAT_OPTIONS } from '../src/command-skills.mjs';
import { SingularityFlowError } from '../src/util.mjs';

const AT = '2026-11-06T00:00:00.000Z';
const ME = { name: 'Reviewer', email: 'reviewer@example.test' };
const OTHER = { name: 'Other', email: 'other@example.test' };
const AUTHORITIES = { product: { label: 'Product approvers', members: [ME] } };
const story = () => ({ workItem: { id: 'W-1' }, currentPhase: 'design', phaseOrder: ['requirements', 'design'], status: 'in_progress',
  phases: { requirements: { id: 'requirements', label: 'Requirements', status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['product'], minimum: 1 } },
    design: { id: 'design', label: 'Design', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { authorities: ['product'], minimum: 1 } } },
  resolution: { approvalAuthorities: AUTHORITIES } });
const scope = (id, text = 'The export must include its header.') => ({ kind: 'scope', id, text, source: 'story:3', groups: ['product'], clauses: ['W-1:REQ-001', 'W-1:AC-010'],
  command: 'singularity-flow decision scope W-1', otherCommand: 'singularity-flow decision scope W-1 --as x' });
const applicability = { responsibility: 'verify', authority: 'product', declaredReason: 'This Story builds nothing.' };
const routing = { key: 'route-1', decision: 'direction', label: 'Where next?', after: 'requirements', reason: 'ask', by: ['product'],
  options: [{ id: 'go', label: 'Continue', to: 'next' }, { id: 'stop', label: 'Finish here', to: 'end' }, { id: 'again', label: 'Another round', to: 'requirements' }] };
const completeness = { inventorySha256: 'sha256:inv', statements: 3, groups: ['product'], decisions: ['satisfied', 'exception', 'not-applicable'],
  articles: [{ id: 'completeness', title: 'Completeness', question: 'Covered?' }, { id: 'ambiguity', title: 'Ambiguity', question: 'Clear?' }] };
const list = (facts = {}, actor = ME) => decisionPacket(story(), { phaseId: 'design', gaps: [], issues: [], approvalCheck: null, pending: {}, ...facts }, { authorities: AUTHORITIES, actor, at: AT });
const owed = (...entries) => ({ pending: { owed: entries } });

test('a scope statement offers every disposition, asks for clauses only where they carry it, and suggests nothing', () => {
  const packet = list(owed(scope('SRI-1')));
  const [item] = packet.items;
  assert.equal(item.kind, 'owed-decision', 'it still owes the ending, and holds nothing');
  assert.equal(item.holdsApproval, false);
  assert.deepEqual(item.options.map((option) => option.id), DECIDABLE_SCOPE_DISPOSITIONS.map((entry) => `scope-${entry}`));
  for (const option of item.options) {
    assert.equal(option.recommended, false, 'nothing is chosen for the person');
    assert.equal(option.needs.reason.default, '', 'a reason is the person\'s');
    assert.equal(option.recordable, undefined);
    assert.deepEqual(option.decidedBy.groups, ['product']);
    const disposition = option.id.replace('scope-', '');
    assert.equal(Boolean(option.needs.clause), CLAUSE_LINKED_DISPOSITIONS.includes(disposition));
    assert.equal(option.chat.command, `singularity-flow decision scope W-1 --fetch --item SRI-1 --as ${disposition}${option.needs.clause ? ' --clause <CLAUSES>' : ''} --reason "<REASON>"`);
    assert.equal(DECISION_LIST_CHAT_OPTIONS.includes(option.id), false, 'a chat turn runs its own command, never this list\'s record');
  }
  assert.deepEqual(item.options[0].needs.clause.known, ['W-1:REQ-001', 'W-1:AC-010']);
  // "Included" and "existing" both name clauses; each says which it is, so a statement this Story's own criterion states
  // is not answered "existing" [office, 2026-11-12].
  const option = (id) => item.options.find((entry) => entry.id === id);
  assert.equal(option('scope-included').label, 'Included: a clause of this Story states it');
  assert.match(option('scope-included').words, /^Name the clause of this Story that states it/u);
  assert.equal(option('scope-existing').label, 'Already in the product before this Story');
  assert.match(option('scope-existing').words, /^Only for behaviour the product had before this Story/u);
  assert.equal(packet.record.copilotCommand, '/sf-decide W-1', 'the /sf-decide route keeps working');
});

test('recording a statement names its clauses as the Story\'s index spells them, and refuses anything else', () => {
  const packet = list(owed(scope('SRI-1')));
  const choose = (option, values = {}) => decisionRecordPlan(packet, parseDecisionAnswers({ choose: { d1: option }, reason: { d1: 'The first requirement carries this statement.' }, ...values }), { at: AT });
  assert.deepEqual(choose('scope-included', { clause: { d1: 'req-001, W-1:AC-010' } }).steps[0].values.clause, ['W-1:REQ-001', 'W-1:AC-010']);
  assert.throws(() => choose('scope-included'), (error) => error instanceof SingularityFlowError && /Name the clauses/u.test(error.message));
  assert.throws(() => choose('scope-included', { clause: { d1: 'REQ-999' } }), /REQ-999, which is not a clause of this Story\. Its clauses: W-1:REQ-001/u);
  assert.throws(() => choose('scope-excluded', { clause: { d1: 'REQ-001' } }), /takes no --clause/u);
  assert.match(effectWords(story(), choose('scope-included', { clause: { d1: 'REQ-001' } }).steps[0].effects[0], { clause: ['W-1:REQ-001'] }), /record scope item SRI-1 as included, carried by REQ-001/u);
  assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers({ choose: { d1: 'scope-excluded' }, reason: { d1: 'Too short.' } }), { at: AT }), /must be 20 to 1000/u);
});

test('someone outside the group is told who decides, and the digest binds what a person chooses from', () => {
  const theirs = list(owed(scope('SRI-1')), OTHER);
  assert.equal(theirs.items[0].decidedBy.allowed, false);
  assert.match(theirs.items[0].decidedBy.words, /The Product approvers decide this/u);
  const refused = decisionRecordPlan(theirs, parseDecisionAnswers({ choose: { d1: 'scope-excluded' }, reason: { d1: 'A reason that is long enough.' } }), { at: AT });
  assert.deepEqual(refused.steps, []);
  assert.equal(refused.refused[0].item, 'd1');
  assert.notEqual(list(owed(scope('SRI-1'))).packetSha256, list(owed(scope('SRI-1', 'Another statement must hold.'))).packetSha256);
  assert.notEqual(list(owed({ ...scope('SRI-1'), clauses: ['W-1:REQ-002'] })).packetSha256, list(owed(scope('SRI-1'))).packetSha256);
});

test('a responsibility the end leaves out is a choice with its own reason, and holds no step', () => {
  const packet = list({ pending: { applicability: [applicability] } });
  const [item] = packet.items;
  assert.equal(item.title, 'Say why verify does not apply');
  assert.match(item.why, /This Story ends without verify: This Story builds nothing\./u);
  assert.equal(item.holdsApproval, false);
  assert.deepEqual(item.options[0].effects, [{ kind: 'applicability', responsibility: 'verify', groups: ['product'] }]);
  assert.equal(item.options[0].chat.command, 'singularity-flow decision applicability W-1 --fetch --responsibility verify --reason "<REASON>"');
  assert.match(packet.headline, /1 open decision; none holds its approval/u);
});

test('each route is a choice, a step the decision lets a person name is too, and a route is written last', () => {
  const packet = list({ pending: { routing, owed: [scope('SRI-1')] } });
  const item = packet.items.find((entry) => entry.kind === 'routing-decision');
  assert.deepEqual(item.options.map((option) => [option.id, option.label]), [['choose-go', 'Continue'], ['choose-stop', 'Finish here (finishes the Story)'], ['choose-again', 'Another round (goes to Requirements)']]);
  assert.doesNotMatch(item.why, /\bask\b/u, 'the reason code is not a word to read');
  assert.equal(item.options[0].chat.command, 'singularity-flow decision choose W-1 --fetch --option go --reason "<REASON>" --expected route-1');
  assert.equal(item.options[0].needs.reason.minimum, 1, 'decision choose asks only for a reason the log can keep');
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: { d1: 'choose-go', d2: 'scope-excluded' }, reason: { d1: 'On to design.', d2: 'Not part of this Story at all.' } }), { at: AT });
  assert.deepEqual(plan.steps.map((step) => step.option), ['scope-excluded', 'choose-go'], 'what else was chosen is written before the Story moves');
  const reopen = list({ pending: { routing: { ...routing, options: routing.options.slice(0, 1), reopen: ['requirements'] } } }).items[0];
  assert.deepEqual(reopen.options.map((option) => option.id), ['choose-go', 'to-requirements']);
  assert.deepEqual(reopen.options[1].effects[0], { kind: 'routing', key: 'route-1', groups: ['product'], to: 'requirements' });
  assert.match(reopen.options[1].chat.command, /--to requirements --reason "<REASON>" --expected route-1$/u);
  const anyStep = list({ pending: { routing: { ...routing, options: [], anyStep: true } } }).items[0];
  assert.deepEqual(anyStep.options.map((option) => option.label), ['Go to Requirements', 'Go to Design', 'Finish the Story here']);
});

test('a route nobody is named for stays the person\'s own step, with who cannot be said', () => {
  const [item] = list({ pending: { routing: { ...routing, by: [] } } }).items;
  assert.equal(item.options.every((option) => option.recordable === false && option.action.command), true);
  assert.equal(item.decidedBy.allowed, false);
});

test('a review nothing waits on is offered beside the list: in no count, on the digest and the record', () => {
  const bare = list();
  const packet = list({ completeness });
  assert.equal(packet.open, 0);
  assert.equal(packet.status, 'nothing-to-decide');
  assert.equal(packet.next, null);
  assert.equal(packet.headline, bare.headline, 'it says nothing is waiting');
  assert.deepEqual(pendingSummary(packet).items, [], 'no surface counts it');
  assert.equal(packet.items.length, 0);
  assert.equal(packet.offered[0].id, 'd1');
  assert.equal(packet.offered[0].holdsApproval, false);
  assert.notEqual(packet.packetSha256, bare.packetSha256);
  const answer = (article, reason = 'I looked at all of it, carefully.') => parseDecisionAnswers({ choose: { d1: 'reviewed' }, reason: { d1: reason }, article: { d1: article } });
  const good = [{ article: 'completeness', decision: 'satisfied' }, { article: 'ambiguity', decision: 'exception', reason: 'Two words read two ways.' }];
  const { steps } = decisionRecordPlan(packet, answer(good), { at: AT });
  assert.deepEqual(steps[0].values.article, good);
  assert.deepEqual(steps[0].effects, [{ kind: 'completeness-review', inventorySha256: 'sha256:inv', groups: ['product'] }]);
  assert.throws(() => decisionRecordPlan(packet, answer(good.slice(0, 1)), { at: AT }), /Answer every checklist article once/u);
  assert.throws(() => decisionRecordPlan(packet, answer([good[0], { article: 'ambiguity', decision: 'exception' }]), { at: AT }), /needs its own reason/u);
  assert.throws(() => decisionRecordPlan(packet, answer([good[0], { article: 'ambiguity', decision: 'maybe', reason: 'x' }]), { at: AT }), /Each article is satisfied, exception, not-applicable/u);
  assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers({ choose: { d1: 'reviewed' }, reason: { d1: 'I looked at all of it, carefully.' } }), { at: AT }), /A terminal asks each one/u);
  assert.throws(() => parseDecisionAnswers({ article: { x1: good } }), /each item of the list holds/u);
});
