/**
 * After an approval, the reply and VS Code's chat prefill name the same command (owner, 2026-11-17).
 *
 * The owner approved a Convergence step in VS Code Copilot Chat: the reply said "/clear, then /sf-next" and the chat box
 * held /sf-phase, the next step's own work command. Both work (/sf-next does the step's own work, D2), but two commands
 * confuse. The approval's clean-chat item now names the next step's own command from its kernel route, the route
 * submission readiness gives the prefill: /sf-phase for a document step, /sf-code for a code step.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

import { resolveWorkType } from '../src/config.mjs';
import { contextBoundaryHandoff, formatContextBoundaryHandoff, pendingContextBoundary } from '../src/context-policy.mjs';
import { stepChatCommand } from '../src/step-decision.mjs';
import { approvalAgentResult } from '../src/approval-agent-result.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { submissionReadinessSnapshot } from '../src/submission-readiness.mjs';
import { nextStepsSnapshot } from '../src/nextsteps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { nextChatPrefill } = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'chat-prefill.ts')).href);

/** A classic-delivery Story whose step before `stepId` was just approved: `stepId` is current and nothing is written yet. */
function approvedUpTo(stepId) {
  const definition = YAML.parse(readFileSync(path.join(root, 'templates', 'workflow.yml'), 'utf8'));
  const resolved = resolveWorkType(definition, 'classic-delivery');
  const index = resolved.phases.findIndex((entry) => entry.id === stepId);
  assert.ok(index > 0, `${stepId} follows another step`);
  const phases = resolved.phases.map((entry, i) => ({ ...entry, generationPolicy: entry.generation, approvals: [],
    status: i < index ? 'approved' : i === index ? 'in_progress' : 'not_started', generation: 0, artifacts: [] }));
  return { previous: phases[index - 1].id, workflow: {
    workItem: { id: 'NEXT-CMD-1', title: 'Next command', branch: 'NEXT-CMD-1', workType: 'classic-delivery' }, status: 'in_progress',
    currentPhase: stepId, phaseOrder: phases.map((entry) => entry.id), phases: Object.fromEntries(phases.map((entry) => [entry.id, entry])),
    resolution: { contextPolicy: { onApproval: 'new' } } } };
}

/** What VS Code puts in the chat box for this Story: the snapshot's submission readiness, through the journey. */
function prefillOf(workflow) {
  const submissionReadiness = submissionReadinessSnapshot(workflow);
  return { readiness: submissionReadiness, prefill: nextChatPrefill({ included: ['repository', 'lifecycle'], workflow, submissionReadiness }) };
}

/** The approval's result as state.mjs approvePhase builds its boundary and the CLI hands it to the agent. */
function approvalReceipt(workflow, previous) {
  const contextBoundary = contextBoundaryHandoff(workflow.resolution.contextPolicy, previous, {
    nextPhase: workflow.currentPhase, nextSkill: stepChatCommand(workflow), complete: false });
  return { handoff: contextBoundary, receipt: approvalAgentResult({ operation: { id: 'approve', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id }, outcome: { status: 'succeeded' }, effects: {}, data: { contextBoundary } }) };
}

for (const [stepId, kind, command] of [['testing', 'a document step', '/sf-phase'], ['implementation', 'a code step', '/sf-code']]) {
  test(`after an approval, the clean-chat item names the command the chat prefill puts in: ${kind}`, () => {
    const { workflow, previous } = approvedUpTo(stepId);
    const { readiness, prefill } = prefillOf(workflow);
    assert.equal(prefill?.command, command, `VS Code fills ${command} for ${kind}`);
    assert.equal(readiness.nextSkill, command, 'the prefill reads submission readiness');

    const { handoff, receipt } = approvalReceipt(workflow, previous);
    assert.deepEqual(handoff.commands, ['/clear', prefill.command]);
    assert.deepEqual(receipt.contextBoundary.commands, ['/clear', prefill.command]);
    // Its one route is the reset itself: "/clear, then /sf-code" is no command (owner, 2026-11-25).
    assert.equal(receipt.contextBoundary.commandGuidance.copilotCommand, '/clear');
    assert.match(receipt.instruction, new RegExp(`Run /clear, then ${prefill.command} before next-phase authoring`, 'u'));
    const act = agentAct({ ...receipt, resultType: 'sflow-approval-agent-result', outcome: { status: 'succeeded' }, turnBoundary: 'end' });
    assert.match(act.said, new RegExp(`the one next step is /clear, then ${prefill.command} \\(${stepId}\\)`, 'u'));
    assert.doesNotMatch(JSON.stringify(receipt), /\/sf-next\b/u, 'no second command beside the prefilled one');
    // The reset has no Shell form, and the approval turn never carries the next step's work command (sequence.test.mjs).
    assert.equal(receipt.contextBoundary.commandGuidance.command, null);
    assert.equal(receipt.contextBoundary.commandGuidance.modelFreeCommand, null);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(`prepare ${stepId}|phase begin ${stepId}`, 'u'));
    // The person's terminal output names the same command, each in its own route block.
    assert.match(formatContextBoundaryHandoff(handoff).join('\n'), new RegExp(`- Copilot: /clear\\n[\\s\\S]*?\\nThen ${prefill.command} in that chat: `, 'u'));
    assert.doesNotMatch(formatContextBoundaryHandoff(handoff).join('\n'), new RegExp(`- Copilot: ${prefill.command}\\n`, 'u'), 'never a route with no Shell');
  });
}

test('a boundary owed in a chat that did not see the approval names the same command as the prefill and the step\'s action', () => {
  for (const stepId of ['implementation', 'testing']) {
    const { workflow } = approvedUpTo(stepId);
    const { prefill } = prefillOf(workflow);
    const snapshot = nextStepsSnapshot({ workflow });
    assert.deepEqual(snapshot.contextBoundary.commands, ['/clear', prefill.command], stepId);
    assert.equal(snapshot.actions.find((entry) => entry.timing === 'now')?.copilotCommand, prefill.command,
      'the step\'s own action after the boundary is the same command');
    assert.deepEqual(pendingContextBoundary(workflow, stepChatCommand).commands, ['/clear', prefill.command]);
  }
});

test('with no route for the step that follows, the boundary keeps /sf-next', () => {
  const { workflow, previous } = approvedUpTo('testing');
  assert.equal(stepChatCommand(workflow), '/sf-phase', 'the current step by default');
  assert.equal(stepChatCommand(workflow, 'implementation'), undefined, 'a step that is not current has no route here');
  assert.equal(stepChatCommand(workflow, null), undefined);
  assert.equal(stepChatCommand(null, 'testing'), undefined);
  assert.deepEqual(contextBoundaryHandoff(workflow.resolution.contextPolicy, previous, { nextPhase: 'testing', nextSkill: stepChatCommand(workflow, 'implementation') }).commands,
    ['/clear', '/sf-next']);
  assert.deepEqual(pendingContextBoundary(workflow).commands, ['/clear', '/sf-next'], 'a caller with no command source');
  assert.deepEqual(contextBoundaryHandoff(workflow.resolution.contextPolicy, previous, { complete: true, nextSkill: '/sf-phase' }).commands,
    ['/clear'], 'a closed Story names only the cleanup');
});
