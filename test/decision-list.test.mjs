/**
 * The decision list's pure parts: grouping by underlying problem, plain words, recommendations only
 * when the facts make them safe, the digest, the record plan, part-way failure, the terminal prompt,
 * next-step parity, and the refusal routes. [decision list]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { promptDecisionAnswers } from '../src/commands/decisions.mjs';
import { DECISION_LIST_CHAT_OPTIONS } from '../src/copilot-mutation-guard.mjs';
import {
  decisionGroups, decisionPacket, decisionRecordCommand, decisionRecordPlan, decisionRefusalLead, ISSUE_ONLY_OPTIONS, parseDecisionAnswers, runDecisionPlan
} from '../src/decision-list.mjs';
import { terminalEvidenceDecisions, terminalRefusalMessage } from '../src/evidence/terminal.mjs';
import { decisionsMayBePending } from '../src/decision-list-facts.mjs';
import { decisionListFacts } from '../src/decision-list-reads.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { validateSflowExecutionCommand } from '../src/safe-command-guidance.mjs';
import { upstreamIssueStates } from '../src/upstream-routes.mjs';
import { decideUpstreamIssue } from '../src/upstream-issues.mjs';
import { recordTestRunRisk } from '../src/test-run-risk.mjs';

const AT = '2026-10-19T09:00:00.000Z';
const RECORD_ID = /\b(?:UPI|ERU|TRR|CR|PRC|FAM)-\d{3}\b|\bTA-[a-f0-9]{20}\b|\s--[a-z]/u;
const ATTEMPT = 'TA-0123456789abcdef0123';

function story({ status = 'awaiting_approval', anyone = true } = {}) {
  return {
    workItem: { id: 'BIN-501' }, status: 'in_progress', currentPhase: 'release',
    phaseOrder: ['specification', 'implementation', 'verification', 'release'],
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product-approvers'] } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'approved', generation: 1, writeScope: 'source-and-artifact',
        approvalPolicy: { authorities: ['engineering-reviewers'] } },
      verification: { id: 'verification', label: 'Verification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['quality-reviewers'] } },
      release: { id: 'release', label: 'Release', status, generation: 1, requiredArtifact: { kind: 'conformance-report', path: 'artifacts/release/conformance.md' },
        approvalPolicy: { authorities: ['release-approvers'] } }
    },
    resolution: { approvalAuthorities: {
      'product-approvers': { label: 'Product approvers', allowAnyGitIdentity: true, members: [] },
      'engineering-reviewers': { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] },
      'quality-reviewers': { label: 'Verification reviewers', allowAnyGitIdentity: anyone, members: [{ email: 'qa@example.invalid' }] },
      'release-approvers': { label: 'Release approvers', allowAnyGitIdentity: true, members: [] }
    } },
    upstreamIssues: [
      { id: 'UPI-001', phase: 'verification', about: 'BIN-501:REQ-001', problem: 'Verification cites a run that was never recorded for this requirement.',
        raisedIn: { phase: 'release', status: 'awaiting_approval', generation: 1 } },
      { id: 'UPI-002', phase: 'implementation', about: 'BIN-501:REQ-001', supersedes: 'UPI-001',
        problem: 'The delivered change has no recorded run for this requirement beyond the code step.',
        raisedIn: { phase: 'release', status: 'awaiting_approval', generation: 1 } }
    ],
    upstreamIssueDecisions: []
  };
}

const gap = (clauseId, issue = 'UPI-002', owner = 'implementation') => ({ report: 'release', clauseId, verdict: 'partial', line: 3, owner,
  status: issue ? 'undecided' : 'unraised', issue, choices: [{ command: `singularity-flow upstream-issue decide ${issue ?? 'X'}` }] });
const candidate = { attemptId: ATTEMPT, producer: 'implementation', consumer: 'verification',
  tests: { discovered: 33, passed: 33, failed: 0, skipped: 0 }, clauses: ['BIN-501:REQ-001', 'BIN-501:REQ-002'], sourceCommit: 'a'.repeat(40) };
function facts(workflow, overrides = {}) {
  return { phaseId: 'release', at: AT, endsStory: true, gaps: [gap('BIN-501:REQ-001')], issues: upstreamIssueStates(workflow, AT),
    activeReuse: [], candidates: [candidate], reuseProblems: [], testRisks: [], unavailable: [], state: { upstreamIssues: 2 }, ...overrides };
}
const actor = { name: 'Release Person', email: 'release@example.invalid', login: null };
const packetOf = (workflow, extra = {}, who = actor) => decisionPacket(workflow, facts(workflow, extra),
  { authorities: workflow.resolution.approvalAuthorities, actor: who, at: AT });

test('a gap and the issue that names it are one item; the superseded original never appears', () => {
  const workflow = story();
  const groups = decisionGroups(workflow, { gaps: [gap('BIN-501:REQ-001')], issues: upstreamIssueStates(workflow, AT), includeAllIssues: true });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].issue.id, 'UPI-002');
  const packet = packetOf(workflow);
  assert.equal(packet.headline, 'Release can\'t be approved yet: 1 decision needed.');
  assert.equal(packet.items.length, 1);
  const [item] = packet.items;
  assert.equal(item.title, 'REQ-001 is partial in the Release report');
  assert.equal(item.why, 'The Release report marks REQ-001 partial; Implementation owns the linked upstream problem. No run by Verification is recorded, and the code '
    + 'has not changed since Implementation\'s recorded run (33 of 33 passed), which covers it. A problem reported against Implementation names it '
    + 'and is not decided yet. The verdict stays as written; a person decides the gap.');
  for (const words of [item.title, item.why, ...item.options.map((entry) => entry.label), ...item.options.map((entry) => entry.words)]) {
    assert.doesNotMatch(words, RECORD_ID, words);
  }
  assert.deepEqual(item.details.supersedes, ['UPI-001']);
  assert.doesNotMatch(JSON.stringify([item.title, item.why]), /UPI-001/u);
  // Unraised gaps of one report and owner are one problem; another owner is another.
  const unraised = decisionGroups(workflow, { gaps: [gap('BIN-501:REQ-003', null), gap('BIN-501:REQ-004', null), gap('BIN-501:REQ-005', null, 'specification')], issues: [] });
  assert.deepEqual(unraised.map((entry) => entry.gaps.map((g) => g.clauseId)), [['BIN-501:REQ-003', 'BIN-501:REQ-004'], ['BIN-501:REQ-005']]);
});

test('reuse is recommended only when a recorded run on unchanged code covers every clause; it records the reuse and the issue decision', () => {
  const workflow = story();
  const [item] = packetOf(workflow).items;
  assert.deepEqual(item.options.map((entry) => [entry.id, entry.recommended]),
    [['reuse', true], ['accept-risk', false], ['dismiss', false], ['return', false]]);
  const [reuse] = item.options;
  assert.deepEqual(reuse.effects, [
    { kind: 'evidence-reuse', phase: 'verification', attemptId: ATTEMPT, recordedBy: 'implementation', clauses: candidate.clauses },
    { kind: 'upstream-issue-decision', issue: 'UPI-002', issuePhase: 'implementation', outcome: 'accept-risk' }
  ]);
  assert.equal(reuse.needs.expires.default, '2026-11-18');
  assert.equal(reuse.needs.expires.latest, '2027-01-17');
  assert.ok(reuse.needs.reason.default.length >= 20);
  // No recorded run, or one that does not cover the clause: no reuse, nothing recommended.
  for (const candidates of [[], [{ ...candidate, clauses: ['BIN-501:REQ-009'] }]]) {
    const [plain] = packetOf(workflow, { candidates, reuseProblems: [{ words: 'The code changed after Implementation\'s recorded run, so that run cannot stand for it.' }] }).items;
    assert.equal(plain.options.some((entry) => entry.id === 'reuse'), false);
    assert.equal(plain.options.some((entry) => entry.recommended), false);
    assert.match(plain.why, /The code changed after Implementation's recorded run/u);
  }
  // Every item recommends at most one option; issue-only options never write another kind of record.
  for (const entry of packetOf(workflow, { testRisks: [{ phase: 'release', commandId: 'unit', attemptId: null, status: 'blocked', exitCode: 1 }] }).items) {
    assert.ok(entry.options.filter((option) => option.recommended).length <= 1);
    for (const option of entry.options.filter((candidateOption) => ISSUE_ONLY_OPTIONS.includes(candidateOption.id))) {
      assert.ok(option.effects.every((effect) => ['upstream-issue', 'upstream-issue-decision'].includes(effect.kind)), option.id);
    }
  }
  assert.deepEqual([...DECISION_LIST_CHAT_OPTIONS], [...ISSUE_ONLY_OPTIONS], 'the Copilot guard trusts the same list');
});

test('an unraised gap is reported against its owning step first, then decided by that step\'s approvers', () => {
  const workflow = story();
  const [item] = packetOf(workflow, { gaps: [gap('BIN-501:REQ-003', null)], candidates: [], endsStory: false }).items;
  const accept = item.options.find((entry) => entry.id === 'accept-risk');
  assert.deepEqual(accept.effects.map((effect) => [effect.kind, effect.phase ?? effect.issuePhase, effect.issue ?? null]),
    [['upstream-issue', 'implementation', null], ['upstream-issue-decision', 'implementation', null]]);
  assert.deepEqual(accept.decidedBy.groups, ['engineering-reviewers']);
});

test('an open issue no gap names is listed at the Story\'s end; accepting it is recommended only when a reused run covers it', () => {
  const workflow = story();
  const lonely = packetOf(workflow, { gaps: [] }).items;
  assert.equal(lonely.length, 1);
  assert.equal(lonely[0].kind, 'upstream-issue');
  assert.equal(lonely[0].title, 'REQ-001: a problem reported in Implementation');
  assert.equal(lonely[0].options.some((entry) => entry.recommended), false);
  const covered = packetOf(workflow, { gaps: [], activeReuse: [{ id: 'ERU-001', phase: 'verification', clauses: ['BIN-501:REQ-001'] }] }).items[0];
  assert.deepEqual(covered.options.map((entry) => [entry.id, entry.recommended]).slice(0, 1), [['accept-risk', true]]);
  assert.match(covered.why, /The recorded run accepted for Verification already covers it\./u);
  assert.equal(packetOf(workflow, { gaps: [], endsStory: false }).items.length, 0, 'before the end, an issue blocks nothing here');
  // Once the replacement is decided, nothing remains: the superseded original owes nothing.
  workflow.upstreamIssueDecisions.push({ issue: 'UPI-002', outcome: 'accept-risk', expiresAt: '2026-11-18T00:00:00.000Z', reason: 'x'.repeat(20) });
  assert.equal(packetOf(workflow, { gaps: [] }).items.length, 0);
});

test('who decides: an option needing a group the person lacks names only that group and the line to share', () => {
  const workflow = story({ anyone: false });
  const [item] = packetOf(workflow).items;
  const [reuse, accept] = item.options;
  assert.equal(reuse.decidedBy.allowed, false);
  assert.equal(reuse.decidedBy.words, 'The Verification reviewers decide this.');
  assert.equal(reuse.decidedBy.share, '/sf-decide BIN-501');
  assert.equal(accept.decidedBy.allowed, true);
  assert.equal(item.decidedBy.allowed, true);
  assert.match(item.decidedBy.words, /^You may choose "Accept the gap as a risk until a date"/u);
  const qa = packetOf(workflow, {}, { name: 'QA', email: 'qa@example.invalid', login: null });
  assert.equal(qa.items[0].options[0].decidedBy.allowed, true);
  assert.equal(qa.packetSha256, packetOf(workflow).packetSha256, 'the digest binds the list, not who reads it');
});

test('the digest binds the items, options, effects, defaults and the Story state they depend on', () => {
  const workflow = story();
  const first = packetOf(workflow);
  assert.equal(packetOf(workflow).packetSha256, first.packetSha256);
  assert.notEqual(packetOf(workflow, { state: { upstreamIssues: 3 } }).packetSha256, first.packetSha256);
  assert.notEqual(packetOf(workflow, { candidates: [] }).packetSha256, first.packetSha256);
  assert.notEqual(decisionPacket(workflow, facts(workflow), { authorities: workflow.resolution.approvalAuthorities, actor, at: '2026-10-20T09:00:00.000Z' }).packetSha256,
    first.packetSha256, 'a new day moves the default dates');
  assert.equal(first.record.recommended, `singularity-flow decisions record BIN-501 --choose d1=reuse --confirm ${first.packetSha256}`);
});

test('a typed reason reaches the record command as the person wrote it: a shell never expands it', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const reason = 'Costs $HOME and `date` and $(id): it\'s "fine"';
  const command = decisionRecordCommand('BIN-501', { choices: [['d1', 'dismiss']], digest, values: { reason: { d1: reason } } });
  assert.doesNotMatch(command, /"d1=/u, 'JSON double quotes are not shell quoting');
  const token = command.slice(command.indexOf('--reason ') + '--reason '.length, command.indexOf(' --confirm'));
  assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${token}`], { encoding: 'utf8' }), `d1=${reason}`);
  assert.ok(validateSflowExecutionCommand(command, { shell: 'posix' })?.copyable, 'the guard reads it as one command');
  assert.equal(decisionRecordCommand('BIN-501', { choices: [['d1', 'reuse']], digest }),
    `singularity-flow decisions record BIN-501 --choose d1=reuse --confirm ${digest}`, 'plain values stay bare');
});

test('the record plan uses the shown defaults, refuses what the person may not decide, and checks every value', () => {
  const workflow = story({ anyone: false });
  const packet = packetOf(workflow);
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=accept-risk'] }), { at: AT });
  assert.deepEqual(plan.steps.map((step) => [step.item, step.option, step.values.expires]), [['d1', 'accept-risk', '2026-11-18']]);
  assert.match(plan.steps[0].values.reason, /^Accepted as a risk until the date: REQ-001/u);
  const theirs = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=reuse'] }), { at: AT });
  assert.deepEqual(theirs.steps, []);
  assert.deepEqual(theirs.refused.map((entry) => [entry.item, entry.words, entry.share]), [['d1', 'The Verification reviewers decide this.', '/sf-decide BIN-501']]);
  const refuse = (answers, pattern) => assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers(answers), { at: AT }),
    (error) => error.code === 'DECISIONS_ANSWER_INVALID' && pattern.test(error.message));
  refuse({ choose: ['d1=approve'] }, /d1 has no option 'approve'; its options are reuse, accept-risk, dismiss, return/u);
  refuse({ choose: ['d1=accept-risk'], expires: ['d1=2027-06-01'] }, /after today and no later than 2027-01-17/u);
  refuse({ choose: ['d1=accept-risk'], reason: ['d1=too short'] }, /20 to 1000 characters/u);
  refuse({ choose: ['d1=dismiss'], expires: ['d1=2026-11-01'] }, /takes no --expires/u);
  refuse({ reason: ['d1=A reason with no choice behind it at all.'] }, /not chosen with --choose/u);
  assert.throws(() => parseDecisionAnswers({ choose: ['d1=reuse', 'd1=dismiss'] }), /names d1 twice/u);
  assert.throws(() => parseDecisionAnswers({ choose: ['UPI-002=dismiss'] }), /not an item of the list/u);
});

test('the last day an option offers is one its own record command accepts, at any time of day', () => {
  const argvSha256 = 'b'.repeat(64);
  for (const at of [AT, '2026-10-19T00:00:00.000Z', '2026-10-19T23:59:59.000Z']) {
    const workflow = story();
    const packet = decisionPacket(workflow, facts(workflow, { testRisks: [{ phase: 'release', commandId: 'unit', attemptId: null, status: 'blocked', exitCode: 1, argvSha256 }] }),
      { authorities: workflow.resolution.approvalAuthorities, actor, at });
    const gapItem = packet.items.find((item) => item.kind === 'conformance-gap');
    const riskItem = packet.items.find((item) => item.kind === 'test-run-risk');
    const accept = gapItem.options.find((entry) => entry.id === 'accept-risk');
    const risk = riskItem.options[0];
    // An accepted issue risk ends at the start of its day; a test-run risk at the end of its day.
    assert.equal(accept.needs.expires.latest, '2027-01-17', at);
    assert.equal(risk.needs.expires.latest, '2027-01-16', at);
    for (const [item, option, latest, after] of [[gapItem, accept, '2027-01-17', '2027-01-18'], [riskItem, risk, '2027-01-16', '2027-01-17']]) {
      const answers = (expires) => parseDecisionAnswers({ choose: [`${item.id}=${option.id}`], expires: [`${item.id}=${expires}`] });
      const plan = decisionRecordPlan(packet, answers(latest), { at });
      assert.equal(plan.steps.find((step) => step.item === item.id)?.values.expires, latest, `${at} ${option.id}`);
      assert.throws(() => decisionRecordPlan(packet, answers(after), { at }), new RegExp(`no later than ${latest}`, 'u'));
      assert.throws(() => decisionRecordPlan(packet, answers(at.slice(0, 10)), { at }), /after today/u, 'today is not a future day');
      assert.throws(() => decisionRecordPlan(packet, answers('2026-11-31'), { at }), /YYYY-MM-DD/u, 'a day that does not exist');
    }
    // Each writer accepts the last day the list offered for it.
    decideUpstreamIssue(structuredClone(workflow), { issue: 'UPI-002', outcome: 'accept-risk', reason: 'Accepted until the follow-up records its run.',
      expiresAt: accept.needs.expires.latest, actor: 'reviewer@example.test', authorityGroup: 'engineering-reviewers', at });
    recordTestRunRisk(structuredClone(workflow), { phaseId: 'release', attempt: null, commandId: 'unit', argvSha256,
      cause: 'The runner image has no browser.', reason: 'The tests run again at every publication and submission.',
      expires: risk.needs.expires.latest, actor: 'reviewer@example.test', authorityGroup: 'engineering-reviewers', at });
  }
});

test('a failure part way names exactly what was recorded and what remains', async () => {
  const workflow = story();
  const packet = packetOf(workflow, { gaps: [gap('BIN-501:REQ-001'), gap('BIN-501:REQ-007', null)] });
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=reuse', 'd2=accept-risk'] }), { at: AT });
  const written = [];
  const outcome = await runDecisionPlan(plan, async (effect, step, produced) => {
    if (effect.kind === 'upstream-issue-decision' && step.item === 'd1') throw Object.assign(new Error('the push failed'), { code: 'PUBLICATION_FAILED' });
    written.push([step.item, effect.kind, effect.issue ?? produced.issue ?? null]);
    return { id: effect.kind === 'evidence-reuse' ? 'ERU-001' : 'UPI-003' };
  });
  assert.deepEqual(outcome.recorded.map((entry) => [entry.item, entry.kind, entry.record.id]), [['d1', 'evidence-reuse', 'ERU-001']]);
  assert.equal(outcome.failed.item, 'd1');
  assert.equal(outcome.failed.error.code, 'PUBLICATION_FAILED');
  assert.deepEqual(outcome.remaining.map((entry) => [entry.item, entry.kind]),
    [['d1', 'upstream-issue-decision'], ['d2', 'upstream-issue'], ['d2', 'upstream-issue-decision']]);
  // Without the failure, a raised issue's ID reaches its decision.
  const clean = await runDecisionPlan({ steps: plan.steps.slice(1), refused: [] }, async (effect, step, produced) => {
    written.push([step.item, effect.kind, effect.issue ?? produced.issue ?? null]);
    return { id: 'UPI-003' };
  });
  assert.deepEqual(clean.remaining, []);
  assert.deepEqual(written.slice(-2), [['d2', 'upstream-issue', null], ['d2', 'upstream-issue-decision', 'UPI-003']]);
});

test('an interactive terminal asks item by item with defaults, shows a summary and asks y/N', async () => {
  const workflow = story();
  const packet = packetOf(workflow, { gaps: [gap('BIN-501:REQ-001'), gap('BIN-501:REQ-007', null)] });
  const input = Readable.from(['\n', '\n', 'Implementation\'s run stands for Verification on the same code.\n', '2\n', '\n', 'y\n']);
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  let shown = '';
  output.on('data', (chunk) => { shown += chunk; });
  const prompt = await promptDecisionAnswers(packet, { input, output });
  assert.deepEqual(Object.fromEntries(prompt.answers.choose), { d1: 'reuse', d2: 'dismiss' });
  assert.deepEqual(Object.fromEntries(prompt.answers.reason), { d1: 'Implementation\'s run stands for Verification on the same code.' });
  assert.equal(prompt.answers.expires.size, 0, 'Enter keeps the suggested date');
  const plan = decisionRecordPlan(packet, prompt.answers, { at: AT });
  assert.equal(plan.steps[0].values.expires, '2026-11-18');
  assert.equal(await prompt.confirm(['d1. REQ-001 is partial in the Release report: reuse.', 'd2. REQ-007: dismiss.']), true);
  prompt.close();
  assert.match(shown, /^Release can't be approved yet: 2 decisions needed\.\n/u);
  assert.match(shown, /1\. REQ-001 is partial in the Release report\n {3}The Release report marks REQ-001 partial/u);
  assert.match(shown, / {3}1\) Accept Implementation's recorded run \(33 of 33 passed\) for Verification {2}\[recommended\]\n/u);
  assert.match(shown, / {3}5\) Not now\n {3}Choose 1-5 \[1\]: /u);
  assert.match(shown, / {3}Until \(YYYY-MM-DD, at most 2027-01-17\) \[2026-11-18\]: /u);
  assert.match(shown, /\nSummary\n {2}d1\. REQ-001 is partial in the Release report: reuse\.\n {2}d2\. REQ-007: dismiss\.\nRecord these decisions\? \[y\/N\]: $/u);
  // Ending the input records nothing.
  const ended = Readable.from(['\n']);
  const quiet = new PassThrough();
  assert.equal(await promptDecisionAnswers(packet, { input: ended, output: quiet }), null);
});

test('next steps offer the decision list instead of an approval the engine would refuse', () => {
  const workflow = story();
  const commands = (options) => workflowNextSteps(workflow, options).map((entry) => [entry.timing, entry.command]);
  const held = commands({ pendingDecisions: { count: 1, headline: 'Release can\'t be approved yet: 1 decision needed.' } });
  assert.equal(held.some(([, command]) => command.startsWith('singularity-flow approve release')), false, JSON.stringify(held));
  assert.deepEqual(held.find(([timing]) => timing === 'now'), ['now', 'singularity-flow decisions BIN-501']);
  const entry = workflowNextSteps(workflow, { pendingDecisions: { count: 1, headline: 'Release can\'t be approved yet: 1 decision needed.' } })
    .find((action) => action.command === 'singularity-flow decisions BIN-501');
  assert.equal(entry.copilotCommand, '/sf-decide BIN-501');
  assert.match(entry.reason, /^Release can't be approved yet: 1 decision needed\. Decide them in one place/u);
  assert.equal(commands({ pendingDecisions: null }).find(([timing]) => timing === 'now')[1], 'singularity-flow approve release --work-id BIN-501 --fetch');
  // Without a read summary, the open replacement issue alone holds the Story's end; once it is decided, approval returns.
  assert.equal(commands({}).find(([timing]) => timing === 'now')[1], 'singularity-flow decisions BIN-501');
  workflow.upstreamIssueDecisions.push({ issue: 'UPI-002', outcome: 'dismiss', reason: 'x'.repeat(20) });
  assert.equal(commands({}).find(([timing]) => timing === 'now')[1], 'singularity-flow approve release --work-id BIN-501 --fetch',
    'the superseded original does not hold it');
  // Before submission the later approval is the list as well.
  const draft = story({ status: 'in_progress' });
  draft.phases.release.generation = 1;
  const later = workflowNextSteps(draft, { pendingDecisions: { count: 1, headline: 'Release needs 1 decision before it can be approved.' } });
  assert.equal(later.some((action) => action.command?.startsWith('singularity-flow approve release')), false);
  assert.ok(later.some((action) => action.command === 'singularity-flow decisions BIN-501'));
});

test('refusals lead with one sentence and the decision list, keeping the exact commands for scripts', () => {
  const workflow = story();
  const lead = decisionRefusalLead(workflow, 'release', { gaps: [gap('BIN-501:REQ-001')], issues: upstreamIssueStates(workflow, AT), includeAllIssues: true });
  assert.equal(lead.headline, 'Release can\'t be approved yet: 1 decision needed.');
  assert.equal(lead.route, 'Decide them in one place. Copilot: /sf-decide BIN-501 · Shell: singularity-flow decisions BIN-501');
  const error = Object.assign(new Error(`${lead.headline} ${lead.route}`), { code: 'CONFORMANCE_BLOCKING_VERDICTS', details: {
    workId: 'BIN-501', phase: 'release', nextAction: lead.nextAction,
    conformanceGaps: [{ clauseId: 'BIN-501:REQ-001', choices: [{ kind: 'decide-upstream-issue', command: 'singularity-flow upstream-issue decide UPI-002 --work-id BIN-501 --outcome accept-risk --expires <YYYY-MM-DD> --reason <why>', skill: '/sf-decide', detail: 'Decide it.' }] }] } });
  const plan = refusalRemediationPlan(error, ['approve', 'release', '--work-id', 'BIN-501']);
  assert.equal(plan.steps[0].id, 'open-decision-list');
  assert.equal(plan.steps[0].command, 'singularity-flow decisions BIN-501');
  assert.equal(plan.steps[0].copilotCommand, '/sf-decide BIN-501');
  assert.ok(plan.steps.some((step) => step.command?.startsWith('singularity-flow upstream-issue decide UPI-002')));
  assert.equal(plan.context.turn, 'current-turn', 'the list opens in the same turn');
  const message = terminalRefusalMessage('BIN-501', { blockers: ['UPI-002 about implementation (BIN-501:REQ-001) is not decided; implementation\'s approvers decide it.'],
    recovery: ['singularity-flow decisions BIN-501'], decisions: lead });
  assert.match(message, /^Release can't be approved yet: 1 decision needed\. Decide them in one place\. Copilot: \/sf-decide BIN-501/u);
});

test('a screen size coverage still lacks is one item: capturing it is the person\'s action, not applicable is the decision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-decision-visual-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const PHONE = { id: 'phone-390x844', label: 'Phone 390 × 844', width: 390, height: 844, deviceScaleFactor: 1 };
  const TABLET = { id: 'tablet-834x1194', label: 'Tablet 834 × 1194', width: 834, height: 1194, deviceScaleFactor: 1 };
  const workflow = {
    workItem: { id: 'MOB-1' }, status: 'in_progress', currentPhase: 'visual-verification',
    phaseOrder: ['implementation', 'visual-verification'],
    phases: {
      implementation: { id: 'implementation', status: 'approved', generation: 1, approvalPolicy: { authorities: ['engineering-reviewers'] } },
      'visual-verification': { id: 'visual-verification', label: 'Visual check', status: 'in_progress', generation: 1,
        requiredArtifact: { kind: 'visual-test-evidence' }, approvalPolicy: { authorities: ['design-reviewers'] } }
    },
    resolution: { workItemRoot: 'singularity/work-items', verification: { coverage: 'enforce', profiles: [PHONE, TABLET] },
      approvalAuthorities: { 'engineering-reviewers': { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] },
        'design-reviewers': { label: 'Design reviewers', allowAnyGitIdentity: false, members: [{ email: 'design@example.invalid' }] } } },
    history: []
  };
  const config = { workItemRoot: 'singularity/work-items' };
  const designer = { name: 'Designer', email: 'design@example.invalid', login: null };
  const packet = decisionPacket(workflow, await decisionListFacts(root, config, workflow, { phaseId: 'visual-verification', at: AT }),
    { authorities: workflow.resolution.approvalAuthorities, actor: designer, at: AT });
  assert.equal(packet.headline, 'Visual check needs 2 decisions before it can be approved.');
  assert.deepEqual(packet.items.map((item) => [item.kind, item.title]),
    [['visual-profile', 'No screenshot yet for Phone 390 × 844'], ['visual-profile', 'No screenshot yet for Tablet 834 × 1194']]);
  const [, tablet] = packet.items;
  assert.deepEqual(tablet.options.map((option) => [option.id, option.recordable ?? true, option.effects.map((effect) => effect.kind)]),
    [['capture', false, []], ['not-applicable', true, ['visual-profile']]]);
  assert.match(tablet.options[0].action.command, /^singularity-flow visual record --phase visual-verification --profile-id tablet-834x1194 /u);
  assert.deepEqual(tablet.options[1].decidedBy.groups, ['design-reviewers']);
  assert.equal(tablet.options[1].decidedBy.allowed, true);
  // Capturing is never recorded here; the decision records through its own command, by its own approvers.
  assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d2=capture'] }), { at: AT }),
    (error) => error.code === 'DECISIONS_OPTION_NOT_RECORDABLE' && /take the screenshot and run singularity-flow visual record/u.test(error.message));
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d2=not-applicable'] }), { at: AT });
  assert.deepEqual(plan.steps[0].effects, [{ kind: 'visual-profile', phase: 'visual-verification', profileId: TABLET.id }]);
  assert.ok(plan.steps[0].values.reason.length >= 20);
  const outsider = decisionPacket(workflow, await decisionListFacts(root, config, workflow, { phaseId: 'visual-verification', at: AT }),
    { authorities: workflow.resolution.approvalAuthorities, actor, at: AT });
  assert.equal(outsider.items[1].options[1].decidedBy.words, 'The Design reviewers decide this.');
  assert.equal(outsider.packetSha256, packet.packetSha256);
  // Once one screen size is decided, the last one can only be captured.
  workflow.visualProfileDecisions = [{ id: 'VPD-001', phase: 'visual-verification', profileId: TABLET.id, profileLabel: TABLET.label,
    disposition: 'not-applicable', reason: 'This app ships to phones only; no tablet layout.', actor: 'design@example.invalid', authorityGroup: 'design-reviewers', at: AT }];
  const last = decisionPacket(workflow, await decisionListFacts(root, config, workflow, { phaseId: 'visual-verification', at: AT }),
    { authorities: workflow.resolution.approvalAuthorities, actor: designer, at: AT });
  assert.equal(last.items.length, 1);
  assert.deepEqual(last.items[0].options.map((option) => [option.id, option.available ?? true]), [['capture', true], ['not-applicable', false]]);
  assert.throws(() => decisionRecordPlan(last, parseDecisionAnswers({ choose: ['d1=not-applicable'] }), { at: AT }),
    (error) => error.code === 'DECISIONS_OPTION_NOT_RECORDABLE' && /only screen size left to check/u.test(error.message));
});

test('an agent reading the list asks the person; a preview that needs the person\'s terminal is never run by the agent', () => {
  const packet = packetOf(story());
  assert.equal(agentAct({ data: packet }).state, 'ask-person');
  assert.equal(agentAct({ data: { ...packet, preview: { record: { command: 'singularity-flow decisions record BIN-501', recordInChat: false } } } }).state,
    'confirm-in-terminal');
  const chat = agentAct({ data: { ...packet, preview: { record: { command: 'singularity-flow decisions record BIN-501', recordInChat: true } } } });
  assert.equal(chat.state, 'confirm');
  assert.equal(chat.do, null, 'the agent asks for an explicit yes before it records');
});

// [decision list parity]: what the approval refusal asks a person to decide about evidence is on the list.
const evaluation = { rows: [
  { id: 'BIN-501:AC-001', result: 'missing',
    obligations: [{ id: 'OBL:BIN-501:verify:BIN-501:AC-001', fulfillment: 'evidence', plannedObligations: [{ fulfillment: 'evidence', expectedPaths: ['singularity/work-items/BIN-501/evidence/result.png'] }] }],
    actions: [{ kind: 'accept-risk', command: 'singularity-flow decision risk --obligation OBL:BIN-501:verify:BIN-501:AC-001 --category <category> --expires <YYYY-MM-DD> --reason "<why>"' }],
    verification: { contract: { slots: [{ slot: 'result', method: 'visual', status: 'missing' }, { slot: 'unit', method: 'test', status: 'missing' }] } } },
  { id: 'BIN-501:AC-002', result: 'satisfied', obligations: [], actions: [], verification: { contract: { slots: [{ slot: 'shot', method: 'visual', status: 'missing' }] } } }
] };

test('the evidence approval waits for is the same witness and risk the refusal names', () => {
  const entries = terminalEvidenceDecisions('BIN-501', evaluation);
  assert.equal(entries.length, 1, 'a satisfied criterion and a test slot need no person');
  const [entry] = entries;
  assert.equal(entry.criterion, 'BIN-501:AC-001');
  assert.deepEqual(entry.witnesses.map((witness) => witness.slot), ['result']);
  assert.equal(entry.witnesses[0].command, 'singularity-flow decision witness BIN-501 --criterion BIN-501:AC-001 --slot result '
    + '--file singularity/work-items/BIN-501/evidence/result.png --confirm states-the-outcome --confirm matches-the-criterion '
    + '--confirm current-for-this-change --reason "<why this exact evidence satisfies the slot>"');
  assert.deepEqual(entry.risks, [{ obligationId: 'OBL:BIN-501:verify:BIN-501:AC-001', command: evaluation.rows[0].actions[0].command }]);
  assert.ok(entry.categories.includes('deferred-verification'));
});

test('an evidence item is the person\'s own step: the list shows its commands and never records it', () => {
  const workflow = story();
  const evidence = terminalEvidenceDecisions('BIN-501', evaluation);
  const packet = packetOf(workflow, { gaps: [], issues: [], evidence });
  assert.equal(packet.status, 'decisions-needed');
  const item = packet.items.find((entry) => entry.kind === 'evidence-obligation');
  assert.ok(item, 'the obligation approval refuses on is on the list');
  assert.match(item.title, /AC-001/u);
  assert.match(item.why, /witness singularity\/work-items\/BIN-501\/evidence\/result\.png/u);
  assert.deepEqual(item.options.map((option) => option.id), ['witness-result', 'accept-obligation-risk']);
  for (const option of item.options) {
    assert.equal(option.recordable, false);
    assert.match(option.action.command, /^singularity-flow decision (?:witness|risk) /u);
  }
  assert.throws(() => decisionRecordPlan(packet, parseDecisionAnswers({ choose: [`${item.id}=witness-result`] }), { at: AT }));
  // The digest moves with the evidence: a witnessed slot is a different list.
  assert.notEqual(packetOf(workflow, { gaps: [], issues: [], evidence: [] }).packetSha256, packet.packetSha256);
});

test('evidence decisions apply at the Story\'s final step once it is submitted, and nowhere else', () => {
  // Two plain steps, no conformance report: only the evidence rule can make decisions pending.
  const plain = (build, ship) => ({ workItem: { id: 'BIN-502' }, phaseOrder: ['build', 'ship'], upstreamIssues: [], upstreamIssueDecisions: [],
    phases: { build: { id: 'build', status: build, generation: 1 }, ship: { id: 'ship', status: ship, generation: 1 } } });
  assert.equal(decisionsMayBePending(plain('approved', 'awaiting_approval'), plain('approved', 'awaiting_approval').phases.ship), true);
  assert.equal(decisionsMayBePending(plain('approved', 'in_progress'), plain('approved', 'in_progress').phases.ship), false);
  assert.equal(decisionsMayBePending(plain('awaiting_approval', 'pending'), plain('awaiting_approval', 'pending').phases.build), false);
});
