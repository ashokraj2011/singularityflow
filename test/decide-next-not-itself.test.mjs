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

// `signed`: a Story SF Guard signs, where the acknowledgement stays the card's (or the person's terminal), never a chat's yes.
function list({ signed = false } = {}) {
  const workflow = story();
  if (signed) workflow.resolution.presence = { status: 'on' };
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
  // Terminal-to-card (ceremony-decisions, owner 2026-11-19): without SF Guard the acknowledgement is a yes or no this
  // /sf-decide turn asks, so its act asks the person here and routes nowhere, least of all to /sf-decide.
  const asked = agentAct(withStoryNext(list(), null));
  assert.equal(asked.state, 'ask-person');
  assert.equal(asked.do, null);
  // Under SF Guard only the card (or the person's terminal) records it, as in the incident.
  const shown = withStoryNext(list({ signed: true }), null);
  assert.deepEqual(shown.next, decideCardNext(W, shown.next.item));
  assert.deepEqual({ title: shown.next.title, copilot: shown.next.copilotCommand, shell: shown.next.command, vscode: shown.next.modelFreeCommand, vscodeChat: shown.next.vscodeChat },
    { title: 'Open the Decide card', copilot: `/decide ${W}`, shell: `singularity-flow decisions record ${W}`, vscode: VSCODE_DECIDE_CARD, vscodeChat: `#sflowDecide ${W}` });
  assert.equal(routesToList(shown.next, W), false);

  // The terminal's list ends on it.
  const lines = packetText(shown).trimEnd().split('\n');
  const at = lines.findIndex((line) => line.startsWith('Next:'));
  assert.ok(at >= 0, packetText(shown));
  for (const line of lines.slice(at)) assert.doesNotMatch(line, /\/sf-decide\b/u, `a Next line names the list itself: ${line}`);

  // And an agent's turn: the card, shown to the person, never /sf-decide again and never run.
  const act = agentAct(shown);
  assert.equal(act.state, 'confirm-in-terminal');
  assert.deepEqual(act.do, { reason: 'Open the Decide card', copilot: `/decide ${W}`, shell: `singularity-flow decisions record ${W}`, vscode: VSCODE_DECIDE_CARD,
    vscodeChat: `#sflowDecide ${W}` });
  assert.match(act.said, /Never give \/sf-decide again/u);
  // VS Code's chat has no /decide: its way to the card is #sflowDecide, called once, never again after it answered [hardening C, F3].
  assert.match(act.said, /In VS Code's own chat, which has no \/decide, the card is do\.vscodeChat: call that tool once with workId only, unless it already answered in this turn/u);
  assert.match(nextOf(act, shown).actNext, /^confirm-in-terminal: show the person \/decide HELLO-1; never run it$/u);
});

test('another Story\'s list, or a route with more to it, is not the list itself', () => {
  assert.equal(routesToList({ copilotCommand: '/sf-decide OTHER-1' }, W), false);
  assert.equal(routesToList({ copilotCommand: `/sf-approve implementation --work-id ${W}` }, W), false);
  assert.equal(routesToList({ command: `singularity-flow decisions record ${W}` }, W), false);
  assert.equal(routesToList({ command: `singularity-flow decisions ${W}` }, W), true);
  assert.equal(routesToList({ copilotCommand: '/sf-decide' }, W), true);
});

test('the Decide card\'s /decide is named as Copilot CLI\'s own, with VS Code\'s Command Palette entry beside it', async () => {
  // [owner, 2026-11-19, loop 8] /decide exists only in Copilot CLI; VS Code's chat has no such command.
  const { formatCommandRouteLines } = await import('../src/model-free-commands.mjs');
  assert.deepEqual(formatCommandRouteLines(decideCardNext(W)), [`- Copilot CLI: /decide ${W}`, `- Shell: singularity-flow decisions record ${W}`, `- VS Code (model-free): ${VSCODE_DECIDE_CARD}`]);
  assert.equal(formatCommandRouteLines({ command: `singularity-flow decisions ${W}`, copilotCommand: `/sf-decide ${W}` })[0], `- Copilot: /sf-decide ${W}`);
});
