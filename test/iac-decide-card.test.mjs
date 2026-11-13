/**
 * An intent amendment decided on the decisions card [owner, 2026-11-13].
 *
 * D1: a requirements (scope) approver approves or rejects a pending amendment on the card (VS Code #sflowDecide,
 * Copilot CLI sflow_decide), seeing each clause it changes, who proposed it and what it reaches; the card records
 * through `decisions record --answers`, bound to the list's digest, with every check `story intent-amendment
 * decide` makes. D2: anyone working on the Story acknowledges an approved one there. D3: a proposal the Story moved
 * under is refreshed with one choice: the stale one rejected, the same bytes proposed again against the step as it
 * is now, as two ordinary commits. Under SF Guard the signature stays in the person's own terminal.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { APPROVAL_HOLD_OWNERS, approvalHold } from '../src/approval-check.mjs';
import { recordableInApproval } from '../src/approval-decisions.mjs';
import { main } from '../src/cli.mjs';
import { approveCommand } from '../src/commands/approve.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { decisionPacket, decisionRecordPlan, holdItemKind, parseDecisionAnswers } from '../src/decision-list.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { intentAmendmentOutcome } from '../src/commands/decisions.mjs';
import { decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';
import { decisionsTable } from '../plugin/extensions/decisions/card.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { CLI, specification, startedSpecificationStory, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'IAC-1';
const AT = '2026-11-13T12:00:00.000Z';
const OWNER = { name: 'Product Owner', email: 'product.owner@example.test' };
const ARCHITECT = { name: 'Architect', email: 'architect@example.test' };
// A raw run of hexadecimal characters with a letter and a digit, as test/person-text-no-hashes.test.mjs finds a hash.
const HEX_RUN = /(?<![0-9A-Za-z_])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,64}(?![0-9A-Za-z_])/iu;
const PROPOSAL = `sha256:${'c0ffee'.repeat(10)}abcd`;

/** A Story whose planning awaits approval; the product approvers own the scope, the architects the plan. */
function story({ selfApproval = true } = {}) {
  return {
    workItem: { id: WORK, title: 'Card decisions', workType: 'demo', branch: WORK }, currentPhase: 'planning', phaseOrder: ['specification', 'planning', 'implementation'], status: 'in_progress',
    resolution: { approvalAuthorities: {
      architecture: { label: 'Architecture reviewers', allowAnyGitIdentity: false, members: [ARCHITECT] },
      product: { label: 'Product approvers', allowAnyGitIdentity: false, members: [OWNER] } } },
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['product'], minimum: 1, allowSelfApproval: selfApproval } },
      planning: { id: 'planning', label: 'Planning', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { authorities: ['architecture'], minimum: 1 } },
      implementation: { id: 'implementation', label: 'Code', status: 'pending', generation: 0, approvals: [], approvalPolicy: { authorities: ['architecture'], minimum: 1 } }
    }
  };
}

/** What decision-list-reads.mjs (intentAmendmentCardFacts) reads of a pending proposal for a full list. */
const card = (fields = {}) => ({
  proposer: 'Story Author', authored: 'governed-agent', reason: 'Review showed that value 2 is required.',
  changes: [{ clause: `${WORK}:AC-001`, change: 'revised', before: `The user sees the value 1. [${WORK}:AC-001]`, after: `The user sees the value 2. [${WORK}:AC-001]` }],
  moreChanges: 0,
  radius: { summary: '1 of your 2 claims affected; the other 1 stand. 1 artifact path(s) and 1 bound test(s) are in scope.', artifacts: ['src/value.mjs'], moreArtifacts: 0, tests: ['test/value.test.mjs'], moreTests: 0 },
  // What approving it does (state.mjs intentAmendmentEffect), the computation approval applies [CIC:REQ-012].
  effect: { firstReset: 'planning', dependents: [], repeats: { amendments: 1, repeated: [], reversed: [] }, steps: [
    { phase: 'planning', outcome: 'reopened', status: 'in_progress', generation: 1,
      reasons: [{ kind: 'cites', path: `singularity/work-items/${WORK}/artifacts/planning/plan.md`, clauses: [`${WORK}:AC-001`] }] },
    { phase: 'implementation', outcome: 'reset', status: 'pending', generation: 0, reasons: [{ kind: 'after-reset', phase: 'planning' }] }] },
  decisions: [], stale: null, ...fields
});
const proposed = (fields = {}) => ({ id: 'AMD-001', status: 'proposed', changedClauses: [`${WORK}:AC-001`], proposalSha256: PROPOSAL,
  proposedBy: { name: 'Story Author', email: 'author@example.test' }, recordPath: `singularity/work-items/${WORK}/context/intent-amendments/AMD-001.json`, card: card(), ...fields });

function listFor(actor, amendments, workflow = story()) {
  return decisionPacket(workflow, { phaseId: 'planning', endsStory: false, gaps: [], issues: [], evidence: [], visual: [], testRisks: [], testCommands: [],
    scopePhase: 'specification', approvalCheck: null, pending: { intentAmendments: amendments }, state: null },
  { authorities: workflow.resolution.approvalAuthorities, actor, at: AT });
}
const amendmentItem = (packet, id = 'AMD-001') => packet.items.find((item) => item.kind === 'intent-amendment' && item.details.amendment === id);
const personText = (item) => [item.title, item.why, ...(item.details.lines ?? []), item.details.proposedBy ?? '', item.details.reach ?? '', item.details.stale ?? '',
  item.decidedBy.words, ...item.options.flatMap((option) => [option.label, option.words, option.decidedBy.words])].join('\n');
const choose = (item, option) => parseDecisionAnswers({ choose: [`${item}=${option}`] });

test('a scope approver decides a pending amendment on the card, with what it changes and reaches in front of them', () => {
  const packet = listFor(OWNER, [proposed()]);
  const item = amendmentItem(packet);
  const decide = (decision) => `singularity-flow story intent-amendment decide AMD-001 --decision ${decision} --confirm AMD-001 --work-id ${WORK}`;
  assert.deepEqual(item.options.map((option) => [option.id, option.recordable !== false, option.decidedBy.allowed, option.terminal]),
    [['reject', true, true, decide('reject')], ['approve', true, true, decide('approve')]]);
  assert.deepEqual(item.options.map((option) => option.effects), [
    [{ kind: 'intent-amendment-decision', amendment: 'AMD-001', decision: 'reject', proposalSha256: PROPOSAL, groups: ['product'] }],
    [{ kind: 'intent-amendment-decision', amendment: 'AMD-001', decision: 'approve', proposalSha256: PROPOSAL, groups: ['product'] }]]);
  assert.ok(item.options.every((option) => option.oneByOne && option.needs.reason.minimum === 0), 'its own row, and a reason only if the person gives one');
  assert.equal(item.answer.where, 'card', 'answered on the card or in a terminal, never recorded by a chat turn');
  assert.deepEqual(item.details.lines, ['AC-001 is revised from "The user sees the value 1." to "The user sees the value 2."']);
  assert.equal(item.details.proposedBy, 'Story Author proposed it; Copilot wrote the wording: "Review showed that value 2 is required.".');
  assert.equal(item.details.reach, '1 of your 2 claims affected; the other 1 stand. 1 artifact path(s) and 1 bound test(s) are in scope. Files: src/value.mjs. Tests: test/value.test.mjs. '
    + 'If it is approved: Planning is reopened: it cites AC-001.', 'exactly what approving does, not every later step [CIC:REQ-012]');
  assert.deepEqual(item.details.commands, [decide('approve'), decide('reject')]);
  assert.doesNotMatch(personText(item), HEX_RUN, 'a person never reads a hash');
  const plan = decisionRecordPlan(packet, choose(item.id, 'approve'), { at: AT });
  assert.deepEqual(plan.steps.map((step) => [step.option, step.values.reason, step.effects[0].decision]), [['approve', '', 'approve']]);
  // Never written in an approval commit: each is its own commit, by its own command's function.
  for (const kind of ['intent-amendment-decision', 'intent-amendment-refresh', 'intent-amendment-acknowledge']) {
    assert.equal(recordableInApproval({ effects: [{ kind }] }), false, kind);
  }

  // Both cards show it, and keep each choice's terminal command beside it.
  const html = decideHtml({ ...packet, packetSha256: 'sha256:x', repositoryPath: '/repo' });
  assert.match(html, /<li>AC-001 is revised from &quot;The user sees the value 1\.&quot; to &quot;The user sees the value 2\.&quot;<\/li>/u);
  assert.match(html, /Story Author proposed it; Copilot wrote the wording/u);
  assert.match(html, /If it is approved: Planning is reopened: it cites AC-001\./u);
  assert.match(html, /<option value="approve" data-needs="reason" data-one="1">Approve AMD-001<\/option>/u);
  assert.match(html, new RegExp(`Or in your own terminal:</span>\\s*<code>${decide('approve')}</code><button type="button" class="secondary" data-copy="approve">`, 'u'));
  const table = decisionsTable(packet);
  assert.ok(table.includes('- AC-001 is revised from "The user sees the value 1." to "The user sees the value 2."'), table);
  assert.ok(table.includes(`Your decision, on the forms below; or in your terminal: Reject AMD-001: \`${decide('reject')}\``), table);
});

test('who may not decide it is named, and a plan approver signs only the rows it carries', () => {
  const theirs = amendmentItem(listFor(ARCHITECT, [proposed()]));
  assert.equal(theirs.decidedBy.allowed, false);
  assert.match(theirs.decidedBy.words, /^The Product approvers \(Product Owner\) decide this|^The Product approvers decide this/u);
  assert.equal(theirs.decidedBy.share, `/sf-decide ${WORK}`);
  const plan = decisionRecordPlan(listFor(ARCHITECT, [proposed()]), choose(theirs.id, 'approve'), { at: AT });
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.refused.map((entry) => [entry.item, entry.option]), [[theirs.id, 'approve']]);

  // Carrying the plan's rows, the plan's approvers may approve it (they sign the rows); only the scope's reject it.
  const carrying = amendmentItem(listFor(ARCHITECT, [proposed({ planCorrections: [{ ownerPhase: 'planning', addsRows: [`${WORK}:AC-003`], removesRows: [], keepsRows: [] }] })]));
  assert.deepEqual(carrying.options.map((option) => [option.id, option.decidedBy.allowed]), [['reject', false], ['approve', true]]);
  assert.deepEqual(carrying.options.find((option) => option.id === 'approve').effects[0].groups, ['product', 'architecture']);
  assert.match(carrying.decidedBy.words, /^You may choose "Approve AMD-001"; the Product approvers/u);
});

test('what its own command would refuse is said, never offered: an approval given, the proposer\'s own, a stale proposal', () => {
  const again = amendmentItem(listFor(OWNER, [proposed({ approvals: { reached: 1, required: 2, missingAuthorities: [] }, card: card({ decisions: [{ decision: 'approved', actor: OWNER }] }) })]));
  const approve = again.options.find((option) => option.id === 'approve');
  assert.deepEqual([approve.recordable, approve.available, approve.words], [false, false, 'You approved it already; another approver decides next.']);
  assert.match(again.why, / 1 of 2 approvals are recorded\./u);
  const own = amendmentItem(listFor(OWNER, [proposed({ proposedBy: OWNER })], story({ selfApproval: false })));
  assert.equal(own.options.find((option) => option.id === 'approve').words, 'You proposed it, and Specification\'s policy has someone else approve it.');

  const stale = listFor(OWNER, [proposed({ card: card({ stale: { cause: 'source-evidence', phase: 'planning' } }) })]);
  const item = amendmentItem(stale);
  assert.deepEqual(item.options.map((option) => [option.id, option.recommended, option.recordable !== false]), [['refresh', true, true], ['reject', false, true], ['approve', false, false]]);
  assert.deepEqual(item.options[0].effects, [{ kind: 'intent-amendment-refresh', amendment: 'AMD-001', proposalSha256: PROPOSAL, groups: ['product'] }]);
  assert.match(item.why, /It no longer matches the Story: the code or Planning's document changed after it was proposed\.$/u);
  assert.equal(item.options[2].words, 'It cannot be approved as it is: the code or Planning\'s document changed after it was proposed. Refresh it, or reject it.');
  assert.throws(() => decisionRecordPlan(stale, choose(item.id, 'approve'), { at: AT }), { code: 'DECISIONS_OPTION_NOT_RECORDABLE' });
  assert.doesNotMatch(personText(item), HEX_RUN);
});

test('while it is pending, the step it was proposed in waits, and the pause is the scope approvers\' to lift on the card', () => {
  const item = amendmentItem(listFor(OWNER, [proposed({ sourcePhase: 'planning' })]));
  assert.equal(item.holds, 'this-step', 'the engine refuses the step\'s begin, prepare, publish and submit until it is decided');
  assert.match(item.why, / Planning waits until it is decided\./u);
  // An older proposal names its step only in its history entry.
  const older = story();
  older.history = [{ event: 'intent_amendment_proposed', phase: 'planning', detail: 'AMD-001 proposes 1 clause change(s): IAC-1:AC-001' }];
  assert.equal(amendmentItem(listFor(OWNER, [proposed()], older)).details.sourcePhase, 'planning');
  assert.equal(amendmentItem(listFor(OWNER, [proposed()])).holds, 'approval-later', 'a proposal from another step holds this one only at its approval');
  // The engine's refusal while it waits is the scope approvers' to clear, carried by the amendment's own item.
  assert.equal(APPROVAL_HOLD_OWNERS.INTENT_AMENDMENT_PENDING_PAUSE, 'someone-decides');
  assert.equal(holdItemKind({ code: 'INTENT_AMENDMENT_PENDING_PAUSE', owner: 'someone-decides' }), 'intent-amendment');
  const hold = approvalHold(new SingularityFlowError('Planning waits for intent amendment AMD-001.', { code: 'INTENT_AMENDMENT_PENDING_PAUSE', details: { scopePhase: 'specification' } }), story(), story().phases.planning);
  assert.deepEqual([hold.clearedBy.kind, hold.clearedBy.steps, hold.who], ['approvers', ['specification'], 'An approver of Specification decides']);
});

test('what a decision did is said in words: a partial approval waits for the rest, and a rejection keeps every submission', () => {
  const workflow = story();
  const partial = intentAmendmentOutcome(workflow, { reached: false, applied: false,
    proposal: { id: 'AMD-001', approvals: { reached: 1, required: 2, missingAuthorities: [], planSignOffsMissing: ['planning'] } } });
  assert.equal(partial.words, 'Your approval of AMD-001 is recorded: 1 of 2 approvals, and an approver of Planning still signs the plan rows it carries by deciding it. It waits for the rest before it changes anything');
  assert.equal(intentAmendmentOutcome(workflow, { reached: true, applied: false, proposal: { id: 'AMD-001' } }).words,
    'AMD-001 is rejected: the approved clauses stay as they are, and every submission stays valid');
  const applied = intentAmendmentOutcome(workflow, { reached: true, applied: true, proposal: { id: 'AMD-001', application: { toSpecificationGeneration: 2 } } });
  assert.deepEqual([applied.generation, applied.words], [2, 'AMD-001 is approved: the amended scope is in force. Acknowledge it next, on this list or in a terminal']);
  const settled = intentAmendmentOutcome(workflow, { reached: true, applied: true, proposal: { id: 'AMD-001', application: { revalidate: [{ phase: 'planning' }] } } });
  assert.match(settled.words, /nothing was reset, and Planning has a row on this list for its approvers$/u);
  for (const outcome of [partial, applied, settled]) assert.doesNotMatch(outcome.words, HEX_RUN);
});

test('an approved amendment is acknowledged on the card by anyone on the Story; a decision is never mixed with another choice', () => {
  const approved = { id: 'AMD-001', status: 'approved', changedClauses: [`${WORK}:AC-001`], acknowledgementRequired: true, acknowledgedAt: null, card: card({ decisions: undefined }) };
  const packet = listFor(ARCHITECT, [approved, proposed({ id: 'AMD-002' })]);
  const acknowledge = amendmentItem(packet, 'AMD-001');
  assert.deepEqual(acknowledge.options.map((option) => [option.id, option.recordable !== false, option.decidedBy.allowed, option.terminal]),
    [['acknowledge', true, true, `singularity-flow story intent-amendment acknowledge AMD-001 --work-id ${WORK}`]]);
  assert.deepEqual(acknowledge.options[0].effects, [{ kind: 'intent-amendment-acknowledge', amendment: 'AMD-001' }]);
  assert.equal(acknowledge.decidedBy.words, 'Anyone working on this Story may decide this.');
  assert.deepEqual(acknowledge.details.lines, ['AC-001 is revised from "The user sees the value 1." to "The user sees the value 2."'], 'what was changed, read before it is acknowledged');

  const both = listFor(OWNER, [approved, proposed({ id: 'AMD-002' })]);
  const [first, second] = [amendmentItem(both, 'AMD-001'), amendmentItem(both, 'AMD-002')];
  assert.throws(() => decisionRecordPlan(both, parseDecisionAnswers({ choose: [`${first.id}=acknowledge`, `${second.id}=reject`] }), { at: AT }),
    (error) => error.code === 'DECISIONS_CHOOSE_ALONE' && /recorded on its own, as its own commit\. Choose only d2 and record it, then decide the rest\. Nothing was recorded\./u.test(error.message));
  assert.equal(decisionRecordPlan(both, choose(first.id, 'acknowledge'), { at: AT }).steps.length, 1, 'an acknowledgement alone records');
});

// The CLI, on a Story whose planning was submitted, as the cards run it: `decisions --json`, then `decisions record --answers`.
let answersFiles = 0;
async function cardRecord({ run, candidate }, work, choices, digest, { extra = {}, allowFailure = false } = {}) {
  const file = path.join(path.dirname(candidate), `answers-${answersFiles += 1}.json`);
  await writeFile(file, JSON.stringify({ choose: choices, ...extra, confirm: digest }));
  return run(process.execPath, [CLI, '--no-model', 'decisions', 'record', work, '--answers', file, '--json'], { allowFailure });
}
const data = (result) => { const parsed = JSON.parse(result.stdout); return parsed.resultType === 'command-result' ? parsed.data : parsed; };
const refusal = (result) => { const parsed = JSON.parse(result.stdout || result.stderr); return parsed.error ?? parsed; };

test('approved on the card: the amendment is installed and attributed to the card, and acknowledging it there clears the hold', slowLane({ timeout: 300_000 }), async (t) => {
  const story = await submittedPlanningStory(t, WORK);
  const { cli, git, item, candidate } = story;
  await writeFile(candidate, specification(WORK, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.', '--authored', 'human');
  const list = () => data(cli('decisions', WORK, '--json'));
  let packet = list();
  const decision = packet.items.find((entry) => entry.kind === 'intent-amendment');
  assert.deepEqual(decision.details.lines, ['AC-001 is revised from "The user sees the value 1." to "The user sees the value 2."',
    'REQ-002 is revised from "The application returns the value 1." to "The application returns the value 2."']);
  assert.match(decision.details.proposedBy, /^History Tester proposed it; a person wrote the wording: "Review showed that value 2 is required\."\.$/u);
  assert.match(decision.details.reach, /Files: src\/value\.mjs\. Tests: test\/value\.test\.mjs\. If it is approved: Planning is reopened: /u);
  // Another proposal waits for this one, and its refusal names the card first.
  const again = story.run(process.execPath, [CLI, '--no-model', 'story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Another change.', '--json'], { allowFailure: true });
  assert.equal(refusal(again).code, 'INTENT_AMENDMENT_ALREADY_PENDING');
  assert.deepEqual(JSON.parse(again.stdout).remediationPlan.steps.slice(1, 3).map((step) => [step.command, step.copilotCommand]),
    [[`singularity-flow decisions ${WORK}`, `/sf-decide ${WORK}`], [`singularity-flow story intent-amendment decide AMD-001 --decision <approve|reject> --confirm AMD-001 --work-id ${WORK}`, null]]);
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).intentAmendments[0].sourcePhase, 'planning', 'the step it was proposed in');
  const decided = data(await cardRecord(story, WORK, { [decision.id]: 'approve' }, packet.packetSha256));
  assert.match(decided.decided[0].words, /^Approve AMD-001: approve AMD-001: the approved clauses change and the steps that cite them reopen \(intent amendment decision\)\. AMD-001 is approved: the amended scope is in force/u);
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.specification.generation, 2, 'the amended scope is the new generation');
  const amendment = workflow.intentAmendments.find((entry) => entry.id === 'AMD-001');
  assert.equal(amendment.status, 'approved');
  assert.equal(amendment.decision?.channel ?? JSON.parse(await readFile(path.join(item, 'context/intent-amendments/AMD-001.json'), 'utf8')).decisions.at(-1).channel, 'decisions-card');
  assert.equal(git('log', '-1', '--format=%s'), `[${WORK}][intent-amendment:approve] AMD-001`);

  // The Story-wide hold: the reopened step is not prepared until someone acknowledges what changed.
  const prepare = () => story.run(process.execPath, [CLI, '--no-model', 'prepare', 'planning', '--json'], { allowFailure: true });
  const held = prepare();
  assert.notEqual(held.status, 0);
  assert.match(held.stdout + held.stderr, /INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED/u);
  packet = list();
  const acknowledge = packet.items.find((entry) => entry.kind === 'intent-amendment');
  assert.equal(acknowledge.title, 'Acknowledge intent amendment AMD-001');
  data(await cardRecord(story, WORK, { [acknowledge.id]: 'acknowledge' }, packet.packetSha256));
  const after = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(typeof after.intentAmendments[0].acknowledgedAt, 'string');
  assert.equal(after.history.at(-1).detail, 'AMD-001 acknowledged on the decisions card before downstream revalidation');
  assert.equal(git('log', '-1', '--format=%s'), `[${WORK}][intent-amendment:acknowledge] AMD-001`);
  assert.equal(list().items.some((entry) => entry.kind === 'intent-amendment'), false, 'nothing left to acknowledge');
  assert.doesNotMatch((({ stdout, stderr }) => stdout + stderr)(prepare()), /INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED/u, 'the hold is cleared');
});

test('rejected on the card: the submission waiting for approval stays valid', slowLane({ timeout: 300_000 }), async (t) => {
  const work = `${WORK}R`;
  const story = await submittedPlanningStory(t, work);
  const { cli, git, item, candidate } = story;
  await writeFile(candidate, specification(work, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
  const packet = data(cli('decisions', work, '--json'));
  const decision = packet.items.find((entry) => entry.kind === 'intent-amendment');
  const decided = data(await cardRecord(story, work, { [decision.id]: 'reject' }, packet.packetSha256, { extra: { reason: { [decision.id]: 'Value 1 stays as approved.' } } }));
  assert.match(decided.decided[0].words, /AMD-001 is rejected: the approved clauses stay as they are, and every submission stays valid$/u);
  assert.equal(git('log', '-1', '--format=%s'), `[${work}][intent-amendment:reject] AMD-001`);
  const record = JSON.parse(await readFile(path.join(item, 'context/intent-amendments/AMD-001.json'), 'utf8'));
  assert.deepEqual([record.status, record.decision.channel, record.decision.reason], ['rejected', 'decisions-card', 'Value 1 stays as approved.']);
  cli('approve', 'planning', '--yes');
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.planning.status, 'approved', 'approved as submitted, with no fresh submission');
  assert.equal(workflow.phases.planning.generation, 1);
});

test('a proposal the step moved under: an old list records nothing, and Refresh proposes the same bytes again', slowLane({ timeout: 300_000 }), async (t) => {
  const work = `${WORK}S`;
  const story = await submittedPlanningStory(t, work);
  const { cli, git, item, candidate } = story;
  const root = path.resolve(item, '../../..');
  const amendments = path.join(item, 'context/intent-amendments');
  const recordOf = async (id) => JSON.parse(await readFile(path.join(amendments, `${id}.json`), 'utf8'));
  await writeFile(candidate, specification(work, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.',
    '--authored', 'human', '--external-ai', 'assisted', '--change-origin', 'mixed');
  const list = () => data(cli('decisions', work, '--json'));
  const amendmentOf = (packet) => packet.items.find((entry) => entry.kind === 'intent-amendment');
  const before = list();
  assert.deepEqual(amendmentOf(before).options.map((option) => option.id), ['reject', 'approve']);

  // The code moves under the proposal: approving it would be refused, and a list read before that records nothing.
  await writeFile(path.join(root, 'moved.mjs'), 'export const moved = true;\n');
  git('add', 'moved.mjs');
  git('commit', '-qm', 'Source changes after the proposal');
  const old = await cardRecord(story, work, { [amendmentOf(before).id]: 'approve' }, before.packetSha256, { allowFailure: true });
  assert.notEqual(old.status, 0);
  assert.equal(refusal(old).code, 'DECISIONS_PACKET_CHANGED');
  const stale = list();
  const offered = amendmentOf(stale);
  assert.deepEqual(offered.options.map((option) => [option.id, option.recordable !== false]), [['refresh', true], ['reject', true], ['approve', false]]);
  assert.equal(offered.details.stale, 'the code or Planning\'s document changed after it was proposed');
  const head = git('rev-parse', 'HEAD');

  // A refresh that no longer applies (here the scope already says what it proposes) leaves the proposal pending and records nothing.
  const scope = path.join(item, 'artifacts/specification/spec.md');
  const approvedScope = await readFile(scope, 'utf8');
  await writeFile(scope, await readFile(path.join(amendments, 'AMD-001-proposed.md'), 'utf8'));
  const moot = list();
  const refused = await cardRecord(story, work, { [amendmentOf(moot).id]: 'refresh' }, moot.packetSha256, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.equal(refusal(refused).code, 'INTENT_AMENDMENT_REFRESH_REFUSED');
  assert.match(refusal(refused).message, /AMD-001 could not be refreshed, so it stays pending and nothing was recorded: The proposed specification does not change any clause\./u);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal((await recordOf('AMD-001')).status, 'proposed');
  await writeFile(scope, approvedScope);

  // One choice refreshes it: two ordinary commits, the stale one rejected and the same change proposed again.
  const current = list();
  const refreshed = data(await cardRecord(story, work, { [amendmentOf(current).id]: 'refresh' }, current.packetSha256));
  assert.match(refreshed.decided[0].words, /AMD-001 is rejected and proposed again as AMD-002, against the step as it is now; the scope's approvers decide AMD-002$/u);
  assert.deepEqual(git('log', '-2', '--format=%s').split('\n'), [`[${work}][intent-amendment:propose] AMD-002`, `[${work}][intent-amendment:reject] AMD-001`]);
  const [first, second] = [await recordOf('AMD-001'), await recordOf('AMD-002')];
  assert.deepEqual([first.status, first.decision.reason, first.decision.channel], ['rejected', 'Refreshed as AMD-002: the step changed after it was proposed.', 'decisions-card']);
  assert.equal(await readFile(path.join(amendments, 'AMD-002-proposed.md'), 'utf8'), await readFile(path.join(amendments, 'AMD-001-proposed.md'), 'utf8'), 'the same bytes');
  assert.equal(second.status, 'proposed');
  assert.equal(second.refreshes, 'AMD-001');
  assert.equal(second.reason, first.reason);
  assert.deepEqual(second.proposedBy, first.proposedBy);
  for (const key of ['producer', 'channel', 'actor', 'externalAiUse', 'changeOrigins']) assert.deepEqual(second.authorship[key], first.authorship[key], key);
  assert.equal(second.specification.proposedSha256, first.specification.proposedSha256);
  assert.notEqual(second.source.sourceTreeSha256, first.source.sourceTreeSha256, 'bound to the step as it is now');

  // The refreshed proposal is decided on the card like any other.
  const fresh = list();
  const pending = amendmentOf(fresh);
  assert.equal(pending.details.amendment, 'AMD-002');
  assert.deepEqual(pending.options.map((option) => option.id), ['reject', 'approve']);
  data(await cardRecord(story, work, { [pending.id]: 'approve' }, fresh.packetSha256));
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.specification.generation, 2);
});

// SF Guard's readers for one person at a Mac holding `key`, in this process (test/sf-guard-approvals.test.mjs).
const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
function guardPerson(email, keys) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing(keys.map((key) => ({ keyId: key.keyId })))) }),
    readableCopies: () => [], publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })), snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString(), reason: null }),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false })
  };
}
const signer = (key, overrides = {}) => ({ personTerminal: () => ({ person: true, reason: null }), signerAvailability: () => ({ available: true, reason: null }),
  holdsKey: async (keyId) => keyId === key.keyId, card: async (fields) => JSON.stringify(fields),
  sign: async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false }), ...overrides });
async function inRoot(root, action) {
  const previous = process.cwd();
  const [log, warn] = [console.log, console.warn];
  process.chdir(root);
  console.log = () => {}; console.warn = () => {};
  try { return { value: await action() }; } catch (error) { return { error }; } finally { console.log = log; console.warn = warn; process.chdir(previous); }
}
async function asPerson(root, presence, argv) {
  forgetPresenceContexts();
  setPersonStepPresenceDependencies({ ...presence, argv: ['node', 'singularity-flow', ...argv] });
  try { return await inRoot(root, () => main([...argv, '--json'])); } finally { setPersonStepPresenceDependencies({}); }
}

test('SF Guard required: the card records nothing and hands the decision to the person\'s own terminal, which signs it', { timeout: 300_000 }, async (t) => {
  const work = `${WORK}G`;
  const key = softwarePresenceKey();
  const { root, git, cli, item } = await startedSpecificationStory(t, work, {
    configure: (configuration) => { for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE]; },
    beforeStart: async ({ root: at, git: inGit }) => {
      inGit('config', 'user.email', ONE.email);
      for (const words of [['register'], ['enable']]) {
        const outcome = await inRoot(at, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...(words[0] === 'enable' ? { 'remote-check': 'sf-guard-verify' } : {}) } }, guardPerson(ONE.email, [key])));
        assert.equal(outcome.error, undefined, outcome.error?.message);
      }
      inGit('add', PRESENCE_CHAIN_PATH, '.github/agents');
      inGit('commit', '-qm', 'Turn SF Guard on');
      inGit('push', '-q', 'origin', 'main');
    }
  });
  t.after(() => setPersonStepPresenceDependencies({}));
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(work, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  const published = await asPerson(root, signer(key), ['phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place']);
  assert.equal(published.error, undefined, published.error?.message);
  cli('submit', 'specification', '--skip-checks');
  forgetPresenceContexts();
  const approved = await inRoot(root, () => approveCommand(['approve', 'specification'], { yes: true }, { presence: signer(key) }));
  assert.equal(approved.error, undefined, approved.error?.message);
  const candidate = path.join(path.dirname(root), 'amended-spec.md');
  await writeFile(candidate, specification(work, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
  const packet = data(cli('decisions', work, '--json'));
  const decision = packet.items.find((entry) => entry.kind === 'intent-amendment');
  const answers = path.join(path.dirname(root), 'answers.json');
  await writeFile(answers, JSON.stringify({ choose: { [decision.id]: 'approve' }, confirm: packet.packetSha256 }));
  const record = ['decisions', 'record', work, '--answers', answers];
  const head = git('rev-parse', 'HEAD');
  const amendment = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).intentAmendments[0];

  // The card's process has no person's terminal: refused before anything is written, the card's cue to hand it over.
  const card = await asPerson(root, signer(key, { personTerminal: () => ({ person: false, reason: 'the decisions card started this command' }) }), record);
  assert.equal(card.error?.code, 'PSS_CARD_NOT_SHOWN', card.error?.message);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal((await amendment()).status, 'proposed');

  // In the person's own terminal the same decision takes the card and the touch, and is signed.
  const terminal = await asPerson(root, signer(key), record);
  assert.equal(terminal.error, undefined, terminal.error?.message);
  const signed = await amendment();
  assert.equal(signed.status, 'approved');
  assert.equal(signed.decision.presence?.keyId, key.keyId, 'the decision carries the approver\'s signature');
});
