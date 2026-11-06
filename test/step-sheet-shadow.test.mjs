/**
 * The step sheet says what the older fields say [study 6.6, S3]. It sits beside them until every
 * surface has moved, and this is the safety net for that: on every hold the check can name, for each
 * kind of person looking, and on real Stories through the real CLI, old and new must agree on who
 * clears what, how, what comes next and whether approving would record. A difference is read and
 * named here (SHEET_ON_PURPOSE), never hidden.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { APPROVAL_HOLD_OWNERS, approvalHold } from '../src/approval-check.mjs';
import { approvalRequirementsMet } from '../src/approval-authority.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { commandWithFills, stepSheet } from '../src/step-sheet.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { CLI, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const AT = '2026-11-06T00:00:00.000Z';
const ME = { name: 'Reviewer', email: 'reviewer@example.test' };
const OTHER = { name: 'Other', email: 'other@example.test' };
const NOBODY = { email: 'nobody@example.test' };
const AUTHORITIES = {
  engineering: { label: 'Engineering reviewers', members: [ME, OTHER] },
  planners: { label: 'Plan approvers', members: [ME] },
  risk: { label: 'Risk reviewers', members: [OTHER] }
};
const VIEWERS = [ME, OTHER, NOBODY];
/**
 * Where the sheet differs from the list on purpose, each read and kept:
 * - `next` differs when the first hold is someone else's and the viewer can clear a later one: the
 *   list's `next` is the first hold whoever looks; the sheet's is the viewer's own first (rule 3).
 * - `copilot` differs when the list's route is one turn for all its items and this item's own step is
 *   the person's terminal: the sheet says so of that step, where the list says /sf-decide for all.
 */
const SHEET_ON_PURPOSE = Object.freeze(['next-prefers-the-viewers-hold', 'copilot-names-this-steps-route']);

/** Undo a sheet command's blanks to compare it with the older text, where a blank was a `<...>`. */
const withoutBlanks = (command) => String(command).replace(/(["']?)(?:<[^<>\n]+>|\{[a-z0-9-]+\})\1/gu, '_');

/** What the old fields and the sheet do not agree on, in words a failure can show. */
function disagreements(workflow, packet, check, sheet) {
  const out = [];
  const phase = workflow.phases[packet.phase];
  const awaiting = phase.status === 'awaiting_approval';
  const say = (what, old, now) => { if (JSON.stringify(old) !== JSON.stringify(now)) out.push(`${what}: old ${JSON.stringify(old)}, sheet ${JSON.stringify(now)}`); };
  const holdsOld = awaiting ? check?.holds ?? [] : [];
  const items = packet.items;
  const approval = items.find((item) => item.kind === 'approval');

  // Every refusal the check names is on the sheet, in its order, and nothing is lost to a list item.
  say('every check hold is on the sheet', holdsOld.map((hold) => hold.code).sort(), sheet.holds.flatMap((hold) => hold.codes).sort());
  // Every item that holds the approval is one hold, and every other open item owed later.
  const held = items.filter((item) => item.kind !== 'approval' && (item.holdsApproval || (!awaiting && item.kind !== 'owed-decision')));
  say('holding items', held.map((item) => item.id), sheet.holds.filter((hold) => hold.item).map((hold) => hold.item));
  say('counted as holding', items.filter((item) => item.holdsApproval).length, sheet.holds.filter((hold) => hold.item && awaiting).length);
  say('owed later', items.filter((item) => item.kind !== 'approval' && !item.machine && !held.includes(item)).map((item) => item.id), sheet.owedLater.map((hold) => hold.item));

  // Who clears each: the list's own words, groups and whether the person looking is one of them.
  for (const hold of [...sheet.holds, ...sheet.owedLater].filter((entry) => entry.item)) {
    const item = items.find((entry) => entry.id === hold.item);
    say(`${hold.key} words`, item.decidedBy.words, hold.clearedBy.words);
    say(`${hold.key} viewer`, item.decidedBy.allowed === true, hold.clearedBy.includesViewer);
    say(`${hold.key} groups`, item.decidedBy.groups, hold.clearedBy.groups.map((group) => group.id));
    say(`${hold.key} title`, item.title, hold.title);
    say(`${hold.key} why`, item.why, hold.why);
    // How: each option is a step, and the command is the option's, blanks declared.
    say(`${hold.key} steps`, item.options.map((option) => option.id), hold.steps.map((step) => step.id));
    for (const [index, step] of hold.steps.entries()) {
      const option = item.options[index];
      const command = option.chat?.command ?? option.action?.command;
      if (command) say(`${hold.key} ${step.id} command`, withoutBlanks(command.replaceAll('<WORK-ID>', workflow.workItem.id)), withoutBlanks(step.command));
      else assert.match(step.command, new RegExp(`--choose ${item.id}=${option.id}`, 'u'));
    }
  }

  // Whether approving would record: `ready` on the check, with no item holding, and an approver looking.
  const blocking = sheet.holds.filter((hold) => hold.clearedBy.kind !== 'viewer-form' && hold.code !== 'PSS_CARD_NOT_SHOWN');
  if (awaiting) {
    const checkReady = check ? check.ready : true;
    say('ready', checkReady && !items.some((item) => item.holdsApproval), !blocking.length);
    say('may approve', checkReady && !items.some((item) => item.holdsApproval) && approval?.decidedBy?.allowed === true, sheet.approval.mayApproveNow);
  } else say('may approve while it does not await approval', false, sheet.approval.mayApproveNow);

  // The approval's own numbers.
  say('needed', Number(phase.approvalPolicy?.minimum ?? 1), sheet.approval.needed);
  const active = (phase.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved');
  if (approval) say('recorded', approval.details.approvals, sheet.approval.recorded.length);
  say('reached', approvalRequirementsMet(phase.approvalPolicy ?? {}, active), sheet.approval.reached);

  // What comes next. `mayApproveNow`: the approval, as the list says; another's approval: who to ask.
  if (sheet.next && packet.next) {
    const first = items.find((item) => item.id === packet.next.item);
    const expected = sheet.next.effect === 'approves' && packet.next.kind === 'approval' ? packet.next.command : null;
    if (expected) say('next command', withoutBlanks(expected), withoutBlanks(sheet.next.command));
    // The hold it names is the list's own first when that hold is this person's.
    if (first?.decidedBy?.allowed === true && first.kind !== 'approval' && first.options[0]?.available !== false) {
      const option = first.options.find((entry) => entry.available !== false);
      const command = option?.chat?.command ?? option?.action?.command;
      if (command) say('next is the first hold that is this person\'s', withoutBlanks(command.replaceAll('<WORK-ID>', workflow.workItem.id)), withoutBlanks(sheet.next.command));
    }
  }
  if (awaiting && !sheet.next) out.push('a step awaiting approval has no next');
  if (sheet.waitingFor && sheet.waitingFor.includesViewer) out.push('waiting for the person looking');

  // The rules no old field held: a party on every hold, no blank in a command, one digest.
  for (const hold of [...sheet.holds, ...sheet.owedLater]) {
    if (!hold.clearedBy?.kind || typeof hold.clearedBy.words !== 'string') out.push(`${hold.key} says nothing of who`);
    if (!hold.steps.length && !['viewer-form', 'viewer-terminal'].includes(hold.clearedBy.kind)) out.push(`${hold.key} has no way through and does not say why`);
    for (const step of hold.steps) {
      if (/<[^<>\n]*>/u.test(step.command)) out.push(`${hold.key} ${step.id} has a blank in its command: ${step.command}`);
      const named = [...step.command.matchAll(/\{([a-z0-9-]+)\}/gu)].map((match) => match[1]).sort();
      if (JSON.stringify(named) !== JSON.stringify(step.fills.map((fill) => fill.name).sort())) out.push(`${hold.key} ${step.id} declares ${JSON.stringify(step.fills)} for ${step.command}`);
      if (!step.where || step.where.terminal !== true) out.push(`${hold.key} ${step.id} says nothing of where`);
    }
  }
  return out;
}

/** Implementation awaits approval, planning and release have their own groups. */
function story({ status = 'awaiting_approval', approvalPolicy = {}, approvals = [] } = {}) {
  const step = (id, label, stepStatus, policy) => ({ id, label, status: stepStatus, generation: 1, approvals: id === 'implementation' ? approvals : [],
    approvalPolicy: { authorities: policy, minimum: 1, ...(id === 'implementation' ? approvalPolicy : {}) } });
  return { workItem: { id: 'W-1' }, currentPhase: 'implementation', phaseOrder: ['planning', 'implementation', 'release'],
    phases: { planning: step('planning', 'Planning', 'approved', ['planners']), implementation: step('implementation', 'Implementation', status, ['engineering']),
      release: step('release', 'Release', 'pending', ['engineering']) },
    resolution: { approvalAuthorities: AUTHORITIES, testRecovery: { riskAuthorities: ['risk'] } } };
}

/** The refusal details that change who clears a code, on top of each code bare. */
const SHAPES = Object.freeze([
  ['PHASE_VALIDATION_FAILED', { testRunRiskRenewals: [{ phase: 'implementation', command: 'singularity-flow decision test-risk W-1' }], nextAction: { command: 'singularity-flow decision test-risk W-1' } }],
  ['SPEC_COVERAGE_INCOMPLETE', { upstreamDecision: { complete: true, issues: [{ id: 'UPI-001', phase: 'planning', clauses: ['W-1:AC-001'] }] }, nextAction: { command: 'singularity-flow decisions W-1 --json', label: 'Decide UPI-001.' } }],
  ['SPEC_COVERAGE_INCOMPLETE', { coverage: { unclaimedChangedPaths: ['src/a.mjs'], unimplemented: [], withdrawnButClaimed: [], invalidEvidence: [] }, planRows: [{ clauseId: 'W-1:REQ-001', result: 'It works' }],
    nextAction: { command: 'singularity-flow decision plan W-1 --fetch --add-location <clause>=src/a.mjs --reason "<why>"' } }],
  ['APPROVAL_INTENT_AMENDMENT_PENDING', { scopePhase: 'planning', pendingIntentAmendments: [{ id: 'AMD-001' }], nextAction: { command: 'singularity-flow story intent-amendment status --work-id W-1 --json', label: 'See it.' } }],
  ['APPROVAL_IDENTITY_NOT_AUTHORIZED', { authorities: ['engineering'], eligibleApprovers: [ME.email, OTHER.email] }],
  ['APPROVAL_IDENTITY_ALREADY_RECORDED', { authorities: ['engineering'], eligibleApprovers: [OTHER.email] }],
  ['APPROVAL_SELF_APPROVAL_PROHIBITED', { authorities: ['engineering'], eligibleApprovers: [] }],
  ['STORY_REVIEW_INTERVENING_COMMIT', { blockingCommits: [{ commit: 'abc1234', subject: 'x' }], pendingIntentAmendments: [{ id: 'AMD-001' }], scopePhase: 'planning' }],
  ['STORY_COMPLETION_REFUSED', { blockers: ['one'], recoveryCommands: ['singularity-flow evidence matrix W-1 --json'] }],
  ['A_REFUSAL_NOBODY_KNOWS', {}]
]);

test('old and new agree on every hold the check can name, for every kind of person looking', () => {
  const shapes = [...Object.keys(APPROVAL_HOLD_OWNERS).map((code) => [code, {}]), ...SHAPES];
  assert.ok(shapes.length > 60, String(shapes.length));
  const seen = new Set();
  for (const [code, details] of shapes) {
    for (const actor of VIEWERS) {
      const workflow = story();
      const hold = approvalHold(new SingularityFlowError(`${code} refused.`, { code, details }), workflow, workflow.phases.implementation);
      const check = { ready: hold.owner === 'you-decide', holds: [hold] };
      const packet = decisionPacket(workflow, { phaseId: 'implementation', pending: {}, approvalCheck: check }, { authorities: AUTHORITIES, actor, at: AT });
      const sheet = stepSheet(workflow, packet, { approvalCheck: check, authorities: AUTHORITIES, actor });
      assert.deepEqual(disagreements(workflow, packet, check, sheet), [], `${code} as ${actor.email}`);
      seen.add(sheet.holds[0].clearedBy.kind);
    }
  }
  assert.deepEqual([...seen].sort(), ['anyone', 'approvers', 'author', 'checkout', 'listed', 'nobody', 'sflow', 'viewer-form', 'viewer-terminal']);
});

test('old and new agree on every kind of item the list builds, for every kind of person looking', () => {
  const facts = () => ({ phaseId: 'implementation', endsStory: false, gaps: [], issues: [], evidence: [], visual: [], testRisks: [], testCommands: [], scopePhase: 'planning',
    approvalCheck: { ready: false, holds: [
      { code: 'APPROVAL_INTENT_AMENDMENT_PENDING', owner: 'someone-decides', who: 'An approver of Planning decides', summary: 'Approving implementation waits for intent amendment AMD-002 to be decided.', clearedBy: { kind: 'approvers', steps: ['planning'] } },
      { code: 'TRP_PHASE_GATE_BLOCKED', owner: 'someone-decides', who: 'A risk reviewer of this Story decides', summary: 'The test and recovery agreement blocks it.', clearedBy: { kind: 'approvers', groups: ['risk'], riskReview: true } },
      { code: 'APPROVAL_CHECKLIST_INCOMPLETE', owner: 'you-decide', who: 'You decide', summary: 'Answer the approval checklist.', clearedBy: { kind: 'viewer-form' } }
    ] },
    pending: { publication: { commit: null, cause: 'Its publication did not land.' },
      routing: { key: 'route-1', decision: 'route', label: 'Ship or rework', after: 'planning', by: ['planners'], options: [{ id: 'ship', label: 'Ship', to: 'implementation' }, { id: 'rework', label: 'Rework', to: 'planning' }] },
      intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: ['W-1:AC-001'], acknowledgedAt: null }, { id: 'AMD-002', status: 'proposed', changedClauses: ['W-1:REQ-002'] }],
      forwardAmendments: [{ code: 'FORWARD_AMENDMENT_PENDING', amendment: 'FAM-001', phase: 'planning', message: 'FAM-001 proposes a correction.', command: 'singularity-flow upstream-issue decide-amendment FAM-001 --work-id W-1 --decision <approve|reject> --reason "<why>" --confirm FAM-001' }],
      appeals: [{ id: 'APL-001', phaseId: 'implementation', status: 'needs-human', command: 'singularity-flow appeal show APL-001 --json' }],
      owed: [{ kind: 'witness', clauseId: 'W-1:AC-001', slot: 'visual-1', method: 'visual', files: ['shots/home.png'], owners: ['planning'], available: false, command: 'singularity-flow decision witness --work-id W-1 --criterion W-1:AC-001 --slot visual-1' },
        { kind: 'scope', id: 'SRI-1', text: 'Keep it', groups: ['planners'], command: 'singularity-flow decision scope W-1 --item SRI-1 --as <DISPOSITION> --reason "<why>"' }],
      transport: [{ intentId: 'psh_0001', status: 'needs-user', cause: 'Git refused it.' }] }, state: null });
  for (const actor of VIEWERS) {
    for (const status of ['awaiting_approval', 'in_progress']) {
      const workflow = story({ status });
      const value = facts();
      const packet = decisionPacket(workflow, value, { authorities: AUTHORITIES, actor, at: AT });
      const sheet = stepSheet(workflow, packet, { approvalCheck: value.approvalCheck, authorities: AUTHORITIES, actor });
      assert.deepEqual(disagreements(workflow, packet, value.approvalCheck, sheet), [], `${status} as ${actor.email}`);
      assert.ok(sheet.owedLater.length || status === 'in_progress');
    }
  }
});

test('next: a hold you can clear, else who to ask and what to share, else the approval, else what is owed later', () => {
  const hold = (code, party, owner = 'someone-decides') => ({ code, owner, who: 'x', summary: `${code} refused.`, clearedBy: party, action: { label: code, command: `singularity-flow recover W-1 --json` } });
  const sheetFor = (holds, actor, overrides = {}) => {
    const workflow = story(overrides);
    const check = { ready: !holds.length, holds };
    const packet = decisionPacket(workflow, { phaseId: 'implementation', pending: {}, approvalCheck: check }, { authorities: AUTHORITIES, actor, at: AT });
    return { sheet: stepSheet(workflow, packet, { approvalCheck: check, authorities: AUTHORITIES, actor }), packet };
  };
  const theirs = hold('TRP_PHASE_GATE_BLOCKED', { kind: 'approvers', groups: ['risk'], riskReview: true });
  const yours = hold('PHASE_VALIDATION_FAILED', { kind: 'approvers', steps: ['planning'] });
  // The list's next is the first hold; the sheet's is the first this person can clear [SHEET_ON_PURPOSE].
  const both = sheetFor([theirs, yours], ME);
  assert.equal(both.packet.next.title.startsWith('TRP_PHASE_GATE_BLOCKED'), true);
  assert.equal(both.sheet.next.command, 'singularity-flow recover W-1 --json');
  assert.equal(both.sheet.waitingFor, null);
  assert.ok(SHEET_ON_PURPOSE.includes('next-prefers-the-viewers-hold'));
  // Only others: who to ask, with the line to share; nothing the person cannot do is offered as theirs.
  const only = sheetFor([theirs], ME).sheet;
  assert.match(only.waitingFor.words, /^The Risk reviewers \(Other\) decide this/u);
  assert.deepEqual([only.next.id, only.next.effect, only.next.where.copilot], ['share', 'reads', '/sf-decide W-1']);
  assert.equal(only.approval.mayApproveNow, false);
  // Nothing held: the approval, for someone who may give it; and whose it is for someone who may not.
  const clear = sheetFor([], ME).sheet;
  assert.deepEqual([clear.next.effect, clear.next.command, clear.next.where.copilot, clear.approval.mayApproveNow],
    ['approves', 'singularity-flow approve implementation --work-id W-1 --fetch', '/sf-approve implementation --work-id W-1', true]);
  const outsider = sheetFor([], NOBODY).sheet;
  assert.deepEqual([outsider.next.id, outsider.approval.mayApproveNow], ['share', false]);
  assert.match(outsider.waitingFor.words, /^The Engineering reviewers \(Reviewer and Other\) decide this/u);
  assert.match(outsider.approval.whyNot.words, /^The Engineering reviewers/u);
  // An answer the form takes, and a signature in the person's terminal, are part of approving.
  const form = hold('APPROVAL_CHECKLIST_INCOMPLETE', { kind: 'viewer-form' }, 'you-decide');
  const card = hold('PSS_CARD_NOT_SHOWN', { kind: 'viewer-terminal' }, 'you-decide');
  const asked = sheetFor([form, card], ME).sheet;
  assert.deepEqual([asked.approval.mayApproveNow, asked.next.effect], [true, 'approves']);
  assert.deepEqual(asked.holds.map((entry) => [entry.code, entry.source, entry.clearedBy.kind]), [['APPROVAL_CHECKLIST_INCOMPLETE', 'gate', 'viewer-form'], ['PSS_CARD_NOT_SHOWN', 'door', 'viewer-terminal']]);
  // A second approver still owed: the numbers say so, and a recorded one counts once.
  const two = sheetFor([], OTHER, { approvalPolicy: { minimum: 2 }, approvals: [{ decision: 'approved', actor: ME, authorityGroup: 'engineering', at: AT }] }).sheet;
  assert.deepEqual([two.approval.needed, two.approval.recorded.length, two.approval.reached], [2, 1, false]);
  // SF Guard's count: an unsigned record is on the sheet and does not count.
  const unsigned = stepSheet(story({ approvals: [{ decision: 'approved', actor: ME, at: AT }] }), { phase: 'implementation', phaseLabel: 'Implementation', items: [] }, { counts: () => false, authorities: AUTHORITIES, actor: OTHER });
  assert.deepEqual([unsigned.approval.recorded[0].counts, unsigned.approval.reached], [false, false]);
  assert.ok(SHEET_ON_PURPOSE.includes('copilot-names-this-steps-route'));
});

test('a blank is declared, with its limits and choices, and a value the system knows is filled', () => {
  assert.deepEqual(commandWithFills('singularity-flow decision plan W-1 --add-location <clause>=src/a.mjs --reason "<why>"',
    { needs: { reason: { minimum: 20, maximum: 1000 } }, choices: { clause: [{ id: 'W-1:REQ-001' }] } }), {
    command: 'singularity-flow decision plan W-1 --add-location {clause}=src/a.mjs --reason {reason}',
    fills: [{ name: 'clause', kind: 'choice', options: [{ id: 'W-1:REQ-001' }] }, { name: 'reason', kind: 'text', min: 20, max: 1000 }] });
  assert.deepEqual(commandWithFills('singularity-flow story intent-amendment decide AMD-1 --decision <approve|reject> --work-id <WORK-ID>', { known: { 'WORK-ID': 'W-1' } }), {
    command: 'singularity-flow story intent-amendment decide AMD-1 --decision {decision} --work-id W-1',
    fills: [{ name: 'decision', kind: 'choice', options: [{ id: 'approve' }, { id: 'reject' }] }] });
});

test('real Stories through the real CLI: every surface carries one sheet, it agrees with the old fields, and approve does what it said', async (t) => {
  const WORK = 'SHEET-1';
  const { git, cli } = await submittedPlanningStory(t, WORK);
  const root = git('rev-parse', '--show-toplevel');
  const json = (...args) => JSON.parse(cli(...args).stdout);
  const surfaces = () => ({ readiness: json('status', WORK, '--submission-readiness', '--json'), review: json('phase', 'show', 'planning', '--json'),
    list: json('decisions', WORK, '--json').data, next: json('nextsteps', WORK, '--json') });
  // What approve really does, with the sheet's answer beside it; no surface is asked to agree with itself.
  const attemptApprove = () => {
    const attempt = spawnSync(process.execPath, [CLI, '--no-model', 'approve', 'planning', '--yes', '--json'], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
      env: { ...process.env, NODE_ENV: 'test' } });
    const parsed = (() => { try { return JSON.parse(attempt.stdout); } catch { return null; } })();
    return { status: attempt.status, code: parsed?.error?.code ?? /[A-Z][A-Z0-9_]{8,}/u.exec(attempt.stderr)?.[0] ?? null, output: attempt.stdout + attempt.stderr };
  };
  const compare = async (label) => {
    const seen = surfaces();
    const sheet = seen.list.sheet;
    assert.equal(sheet.schema, 'sflow-step-sheet/v1', label);
    // One read model: the same digest on every surface, so none can say otherwise.
    assert.deepEqual([seen.readiness.sheet?.digest, seen.review.sheet?.digest, seen.next.sheet?.digest], [sheet.digest, sheet.digest, sheet.digest], label);
    const { workflow } = await loadAcceptedStoryExecution(root, WORK);
    assert.deepEqual(disagreements(workflow, seen.list, seen.readiness.approvalCheck, sheet), [], label);
    // nextsteps' first action is the sheet's approval, or a way through one of its holds.
    const now = withoutBlanks(seen.next.actions.find((action) => action.timing === 'now')?.command ?? '');
    const ways = [...sheet.holds.flatMap((hold) => hold.steps.map((step) => withoutBlanks(step.command))), ...(sheet.next ? [withoutBlanks(sheet.next.command)] : [])];
    assert.ok(!sheet.next || ways.includes(now) || (sheet.holds.length && /^singularity-flow (?:decisions|phase show)/u.test(now)), `${label}: nextsteps ${now}; the sheet ${JSON.stringify(ways)}`);
    // The older fields say the same in their own words.
    assert.equal(seen.readiness.pending.open, seen.list.open, label);
    assert.deepEqual(seen.readiness.approvalCheck.holds.map((hold) => hold.code), seen.review.approvalCheck.holds.map((hold) => hold.code), label);
    return { ...seen, sheet };
  };

  // Clean: the approval is next, and it would record.
  const clean = await compare('clean');
  assert.deepEqual([clean.sheet.approval.mayApproveNow, clean.sheet.next.effect, clean.sheet.holds.length], [true, 'approves', 0]);
  assert.equal(clean.next.actions.find((action) => action.timing === 'now').command.startsWith('singularity-flow approve planning '), true, 'nextsteps says the same');
  assert.equal(clean.sheet.next.command, clean.list.next.command);
  assert.match(clean.sheet.step.packetSha256, /^[a-f0-9]{64}$/u);
  // No agent reads it yet, so no agent's view pays for it; the JSON a script or VS Code reads carries it.
  for (const [name, view] of Object.entries({ nextsteps: json('nextsteps', WORK, '--for-agent', '--json'), review: json('phase', 'show', 'planning', '--for-agent', '--json'),
    list: json('decisions', WORK, '--for-agent', '--json').data })) assert.equal(view.sheet?.digest, undefined, name);

  // A stray file: the door's refusal comes first on every surface, with its route.
  const stray = path.join(root, 'stray.txt');
  await writeFile(stray, 'stray\n');
  const dirty = await compare('dirty');
  assert.deepEqual([dirty.sheet.holds[0].code, dirty.sheet.holds[0].source, dirty.sheet.holds[0].clearedBy.kind, dirty.sheet.approval.mayApproveNow],
    ['LIFECYCLE_WORKTREE_REVIEW_REQUIRED', 'door', 'checkout', false]);
  assert.equal(attemptApprove().code, 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED', 'the door refuses with what the sheet said');
  await rm(stray);

  // Application source committed during review: the gate's own refusals, and recording refuses with the first.
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  git('add', 'src/value.mjs');
  git('commit', '-qm', 'Implement the value during the planning review');
  const held = await compare('held');
  assert.ok(held.sheet.holds.length >= 1);
  assert.equal(held.sheet.approval.mayApproveNow, false);
  assert.ok(held.readiness.approvalContinuation, 'the older route');
  const first = held.readiness.approvalCheck.holds[0].code;
  assert.ok(held.sheet.holds.some((hold) => hold.codes.includes(first)), first);
  assert.equal(attemptApprove().code, first, 'recording refuses with the first hold');

  // Back to the clean submission: approve records, as the sheet said it would, and the next step's sheet stands.
  git('reset', '-q', '--hard', 'HEAD~1');
  const again = await compare('clean again');
  assert.equal(again.sheet.approval.mayApproveNow, true);
  const approved = attemptApprove();
  assert.equal(approved.status, 0, approved.output);
  const after = json('decisions', WORK, '--json').data;
  const { workflow } = await loadAcceptedStoryExecution(root, WORK);
  assert.notEqual(workflow.currentPhase, 'planning');
  assert.equal(after.sheet.step.id, workflow.currentPhase);
  assert.equal(after.sheet.approval.mayApproveNow, false, 'the next step does not await approval');
  assert.deepEqual(disagreements(workflow, after, null, after.sheet), []);
});
