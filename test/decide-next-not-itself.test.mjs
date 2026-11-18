/**
 * "Next must never loop to the command the person is already in" [owner, 2026-11-18, office laptop, VS Code
 * Copilot chat]: inside /sf-decide the reply ended "Next — Resolve the remaining decisions: Copilot /sf-decide
 * HELLO-1 / Shell singularity-flow decisions HELLO-1 / VS Code Decide Everything This Step Waits On", beside an
 * acknowledgement only the Decide card records. A /sf-decide result never names /sf-decide for the same Story as its
 * next step: what only the card records ends on "Open the Decide card", named as such, with each host's way to it;
 * with nothing waiting on the person, the Story's own next step (test/decide-next-step.test.mjs).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentAct, nextOf } from '../src/agent-output.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { VSCODE_DECIDE_CARD } from '../src/model-free-commands.mjs';
import { decideCardNext, packetText, routesToList, waitsOnPerson, withStoryNext } from '../src/commands/decisions.mjs';

const W = 'HELLO-1';
const AT = '2026-11-18T19:50:00.000Z';
const ME = { name: 'Person', email: 'person@example.invalid' };
const AUTHORITIES = { engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] } };

function story() {
  return { workItem: { id: W, workType: 'custom' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
    history: [], resolution: { approvalAuthorities: AUTHORITIES },
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } }
    } };
}
// AMD-001 approved and changed AC-001: only the Decide card (or the person's terminal) records its acknowledgement.
const APPROVED = { id: 'AMD-001', status: 'approved', changedClauses: [`${W}:AC-001`], affectedPhases: ['implementation'], acknowledgementRequired: true, acknowledgedAt: null };

function list() {
  const workflow = story();
  return { ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', pending: { intentAmendments: [APPROVED] } },
    { authorities: AUTHORITIES, actor: ME, at: AT })), repositoryPath: '/repo' };
}

test('the incident: the list read by /sf-decide pointed at /sf-decide itself', () => {
  const packet = list();
  assert.equal(waitsOnPerson(packet), true, 'the acknowledgement is this person\'s to give');
  assert.equal(packet.next.copilotCommand, `/sf-decide ${W}`, 'the list\'s own pointer, right for every other screen');
  assert.equal(routesToList(packet.next, W), true);
});

test('a /sf-decide result never names /sf-decide for the same Story as its next step: "Open the Decide card"', () => {
  const shown = withStoryNext(list(), null);
  assert.deepEqual(shown.next, decideCardNext(W, shown.next.item));
  assert.deepEqual({ title: shown.next.title, copilot: shown.next.copilotCommand, shell: shown.next.command, vscode: shown.next.modelFreeCommand },
    { title: 'Open the Decide card', copilot: `/decide ${W}`, shell: `singularity-flow decisions record ${W}`, vscode: VSCODE_DECIDE_CARD });
  assert.equal(routesToList(shown.next, W), false);

  // The terminal's list ends on it.
  const lines = packetText(shown).trimEnd().split('\n');
  const at = lines.findIndex((line) => line.startsWith('Next:'));
  assert.ok(at >= 0, packetText(shown));
  for (const line of lines.slice(at)) assert.doesNotMatch(line, /\/sf-decide\b/u, `a Next line names the list itself: ${line}`);

  // And an agent's turn: the card, shown to the person, never /sf-decide again and never run.
  const act = agentAct(shown);
  assert.equal(act.state, 'confirm-in-terminal');
  assert.deepEqual(act.do, { reason: 'Open the Decide card', copilot: `/decide ${W}`, shell: `singularity-flow decisions record ${W}`, vscode: VSCODE_DECIDE_CARD });
  assert.match(act.said, /Never give \/sf-decide again/u);
  assert.match(nextOf(act, shown).actNext, /^confirm-in-terminal: show the person \/decide HELLO-1; never run it$/u);
});

test('another Story\'s list, or a route with more to it, is not the list itself', () => {
  assert.equal(routesToList({ copilotCommand: '/sf-decide OTHER-1' }, W), false);
  assert.equal(routesToList({ copilotCommand: `/sf-approve implementation --work-id ${W}` }, W), false);
  assert.equal(routesToList({ command: `singularity-flow decisions record ${W}` }, W), false);
  assert.equal(routesToList({ command: `singularity-flow decisions ${W}` }, W), true);
  assert.equal(routesToList({ copilotCommand: '/sf-decide' }, W), true);
});
