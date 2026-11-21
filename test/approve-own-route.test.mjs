/**
 * An approve turn is never handed its own approval back as a route [owner, 2026-11-21]. In VS Code, /sf-approve on a quick
 * fix's Verify v1 opened the approval page, then ended "approve or decline in the approval page" with /sf-approve,
 * `singularity-flow approve verify --fetch` and @sflow /approve; the person typed /sf-approve again, and that turn ended
 * the same way. Those routes came from the approval packet itself: the readiness it carries (`nextCommand`, `nextSkill`,
 * the decision list's `pending.next`) and the review's continuation each named the approval of the step being approved.
 *
 *   1. The packet without its own approval: what goes and what stays (other items, other steps, other Stories).
 *   2. A real packet for a step awaiting approval, read as an approve turn's agent view on Copilot CLI and in VS Code's
 *      terminal: no /sf-approve and no `approve <step>` anywhere in the view or its kept result; VS Code's ending names
 *      only the approval page and the person's own filled @sflow /approve line.
 *   3. VS Code's #sflowDecide in a second turn, with the approval page still open: the same page is brought forward
 *      (approval-open), never "reopen it"; a page that could not open leaves only the @sflow line.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { approvesOwnStep, withoutOwnApproval } from '../src/commands/approval-packet.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';
import { journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { vscodeHost } from './helpers/vscode-host.mjs';

const W = 'AOR-1';
// The approval of the step being approved, as Copilot (any /sf-approve: it is the skill this turn runs) and the terminal name it.
const OWN_ROUTE = /\/(?:sf|sflow)-approve\b|\b(?:singularity-flow|sflow) approve intake\b/u;
const OWN_LINE = `@sflow /approve intake --work-id ${W}`;

// ------------------------------------------------------------------------------------------- 1

test('the packet an approve turn reads loses only the routes that approve this step', () => {
  const own = { workId: W, phase: 'intake' };
  for (const route of ['/sf-approve', '/sf-approve intake --work-id AOR-1', '/sflow-approve --work-id AOR-1', 'singularity-flow approve intake --work-id AOR-1 --fetch',
    'sflow approve intake', '@sflow /approve intake --work-id AOR-1']) assert.equal(approvesOwnStep(route, own), true, route);
  for (const route of ['/sf-approve design --work-id AOR-1', 'singularity-flow approve intake --work-id OTHER-2', '@sflow /approve design --work-id AOR-1',
    '/sf-decide AOR-1', 'singularity-flow approvals AOR-1', null]) assert.equal(approvesOwnStep(route, own), false, String(route));

  const readiness = { classification: 'already-submitted', command: 'singularity-flow approve intake --work-id AOR-1 --fetch',
    nextCommand: 'singularity-flow approve intake --work-id AOR-1 --fetch', nextSkill: '/sf-approve', approvalCheck: { ready: true, holds: [] },
    pending: { open: 1, headline: 'Scope and plan has nothing left to decide; its approval is next.',
      next: { item: 'd1', kind: 'approval', title: 'Approve Scope and plan', command: 'singularity-flow decisions AOR-1',
        copilotCommand: '/sf-approve intake --work-id AOR-1', modelFreeCommand: OWN_LINE },
      items: [{ id: 'd1', kind: 'approval', title: 'Approve Scope and plan', holdsApproval: false, yours: true }],
      command: 'singularity-flow decisions AOR-1', copilotCommand: '/sf-decide AOR-1' } };
  assert.deepEqual(withoutOwnApproval(readiness, own), { classification: 'already-submitted', approvalCheck: { ready: true, holds: [] },
    pending: { open: 1, headline: readiness.pending.headline, items: readiness.pending.items } });
  // Another item on the list stays, with the list's own route; so does a route to another step.
  const signOff = { id: 'd1', kind: 'witness', title: 'Sign off the screen', holdsApproval: false, yours: true };
  const later = { timing: 'later', reason: 'Then design', skill: '/sf-phase', command: 'singularity-flow prepare design --json', copilotCommand: '/sf-phase design' };
  const kept = withoutOwnApproval({ ...readiness, pending: { ...readiness.pending, open: 2, items: [signOff, { ...readiness.pending.items[0], id: 'd2' }] }, later }, own);
  assert.deepEqual(kept.pending.items.map((item) => item.id), ['d1', 'd2']);
  assert.equal(kept.pending.copilotCommand, '/sf-decide AOR-1');
  assert.deepEqual(kept.later, later);
  // A review's continuation keeps its facts and loses its approval of this step.
  const action = { timing: 'now', reason: 'Approve it.', skill: '/sf-approve', command: 'singularity-flow approve intake --work-id AOR-1 --fetch',
    copilotCommand: '/sf-approve intake --work-id AOR-1', modelFreeCommand: OWN_LINE };
  assert.deepEqual(withoutOwnApproval({ phase: 'intake', continuation: { workId: W, phase: 'intake', automaticAdvance: false, actions: [action], nextAction: action,
    nextCommand: action.command, nextSkill: '/sf-approve', copilotCommand: action.copilotCommand, modelFreeCommand: OWN_LINE } }, own),
  { phase: 'intake', continuation: { workId: W, phase: 'intake', automaticAdvance: false, actions: [] } });
});

// ------------------------------------------------------------------------------------------- 2 and 3

/** A quick fix whose intake is written, reviewed and submitted: only its approval waits. */
async function intakeAwaitingApproval(t) {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  return story;
}

const HOSTS = Object.freeze({
  'Copilot CLI': (env) => { const { TERM_PROGRAM: _program, TERM_PROGRAM_VERSION: _version, ...rest } = env; return rest; },
  // VS Code's own terminal, where its chat runs the skill's commands.
  'VS Code': (env) => ({ ...env, TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.141.0' })
});

test('a real approval packet, read as an approve turn\'s agent view on both hosts, never routes to its own approval', { timeout: 300_000 }, async (t) => {
  const story = await intakeAwaitingApproval(t);
  // Two turns on each host, as the owner's were: the second /sf-approve reads a fresh packet on the same state.
  for (const [host, environment] of Object.entries(HOSTS)) {
    for (const turn of [1, 2]) {
      const ran = story.raw(['choices', 'begin', 'approve', W, '--fetch', '--for-agent', '--json', '--review-packet'], { environment: environment(story.env) });
      assert.equal(ran.status, 0, `${host} turn ${turn}: ${ran.stdout.slice(-2000)}${ran.stderr.slice(-2000)}`);
      const view = JSON.parse(ran.stdout);
      // The whole result the view was cut from, as the turn reads it (agentOutput.read); a view that fits is its own.
      const kept = view.agentOutput?.path ? JSON.parse(readFileSync(view.agentOutput.path, 'utf8')) : view;
      const where = `${host} turn ${turn}`;
      assert.equal(view.act.state, 'ask-person', where);
      assert.equal(view.act.do, null, where);
      assert.equal(kept.approvalPacket.readiness.classification, 'already-submitted', where);
      assert.deepEqual(kept.approvalPacket.readiness.pending.items.map((item) => item.kind), ['approval'], `${where}: the list's items stay`);
      for (const [name, value] of [['view', view], ['kept result', kept]]) {
        const text = JSON.stringify(value);
        assert.doesNotMatch(text, OWN_ROUTE, `${where}, ${name}: ${text.match(new RegExp(`.{0,200}${OWN_ROUTE.source}.{0,80}`, 'u'))?.[0]}`);
      }
      for (const [name, value] of [['view', view], ['kept result', kept]]) {
        // The person's own @sflow line is said once, in VS Code's ending, filled; never as a route of the packet.
        const { how, ...ask } = value.act.ask;
        assert.ok(how.includes(`approve on the approval page that is open, or type \`${OWN_LINE}\` in the chat box`), `${where}, ${name}: ${how}`);
        assert.doesNotMatch(JSON.stringify({ ...value, act: { ...value.act, ask } }), /@sflow \/approve/u, `${where}, ${name}`);
      }
    }
  }
});

test('VS Code: #sflowDecide in a second turn brings the open approval page forward, and a page that cannot open leaves only the @sflow line', { timeout: 300_000 }, async (t) => {
  const story = await intakeAwaitingApproval(t);
  const vscode = await vscodeHost(story);
  const { ApprovalsPanel } = vscode.pages.approvals;
  // The real approval page, on a store that shows this window's Story.
  const store = { current: { snapshot: { workflow: storyRecord(story), documents: [], identities: {} }, error: null, stale: false },
    onDidChange: () => ({ dispose() {} }), acquireSlices: async () => ({ dispose() {} }) };
  const stubbed = vscode.command.bind(vscode);
  let opens = 'page';
  vscode.command = async (id, ...args) => {
    if (id !== 'singularityFlow.openApprovals') return stubbed(id, ...args);
    vscode.executed.push([id, ...args]);
    if (opens === 'refused') throw new Error('No SFlow repository is ready in this window.');
    return ApprovalsPanel.show({ extensionUri: {} }, store, () => {}, null, args[0]);
  };
  const approvalPages = () => vscode.panels.filter((panel) => panel.viewType === 'singularityFlow.approvals');
  t.after(() => { for (const panel of approvalPages()) panel.dispose(); });
  const next = { kind: 'approve-in-chat', title: 'Approve Scope and plan v1 yourself: type this in the chat box', command: null, copilotCommand: null, modelFreeCommand: OWN_LINE };

  const first = await vscode.callTool('singularityFlow_decide', { workId: W });
  const second = await vscode.callTool('singularityFlow_decide', { workId: W });
  for (const [turn, answer] of [['first', first], ['second', second]]) {
    assert.equal(answer.status, 'approval-open', `${turn}: ${JSON.stringify(answer)}`);
    assert.match(answer.message, /^The approval page is open for Scope and plan v1 with its documents\./u, turn);
    assert.doesNotMatch(answer.message, /reopen/iu, turn);
    assert.deepEqual(answer.next, next, turn);
    assert.doesNotMatch(JSON.stringify(answer), OWN_ROUTE, turn);
  }
  assert.equal(approvalPages().length, 1, 'one approval page: the second turn brought it forward');
  assert.equal(approvalPages()[0].revealed, 1, 'the second turn revealed the page the first opened');
  assert.match(approvalPages()[0].webview.html, /data-focus/u, 'the page marks this Story\'s step');
  for (const panel of approvalPages()) panel.dispose();

  opens = 'refused';
  const closed = await vscode.callTool('singularityFlow_decide', { workId: W });
  assert.equal(closed.message, `The approval page for Scope and plan v1 could not open here. The person approves by typing ${OWN_LINE} in the chat box; this chat records nothing.`);
  assert.deepEqual(closed.next, next);
  assert.doesNotMatch(JSON.stringify(closed), /Singularity Flow: Approvals|reopen/iu);
});
