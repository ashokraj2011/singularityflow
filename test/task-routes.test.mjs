/**
 * ITW:REQ-008 [docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md]: a task's Story is carried on by `/sf-task`, typed in the same chat.
 *
 * A real VS Code run of a fix task ended its intake with "Next — /sf-approve intake --work-id TASK-1", nextsteps' act.do
 * named the same, the approval ended "the one next step is /clear, then /sf-code", the code step's submission said "Run
 * this in a new chat", and VS Code's status bar said "Next: /sf-phase". Every person-facing next action whose turn
 * /sf-task takes now names /sf-task as its Copilot route, in the same chat; its skill (the turn it needs), Shell and
 * model-free routes stay its own. A classic Story is unchanged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { approvalAgentResult } from '../src/approval-agent-result.mjs';
import { nextAfterStep } from '../src/cli-steps.mjs';
import { contextBoundaryHandoff, pendingContextBoundary, storyContextPolicy } from '../src/context-policy.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { attachContinuation } from '../src/narration/continuation.mjs';
import { validateCommandResult } from '../src/narration/command-result.mjs';
import { nextStepsSnapshot, nextStepsText } from '../src/nextsteps.mjs';
import { phaseContinuation } from '../src/phase-continuation.mjs';
import { isTaskStory, safeCommandGuidance, taskTakesTurn, TASK_ROUTE, withTaskRoute, withTaskRoutes } from '../src/safe-command-guidance.mjs';
import { stepChatCommand } from '../src/step-decision.mjs';
import { taskTurnSkillFor } from '../src/task-turn.mjs';
import { journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';

const APPROVE = 'singularity-flow approve intake --work-id TASK-1 --fetch';
const TASK = Object.freeze({ workItem: { id: 'TASK-1', workType: 'task-fix' }, resolution: { composition: { kind: 'fix', steps: [] } } });
const CLASSIC = Object.freeze({ workItem: { id: 'S-1', workType: 'quick-fix' }, resolution: {} });

test('the reviewed exception: /sf-task stands beside a command whose turn it takes, and nowhere else', () => {
  const approve = safeCommandGuidance({ command: APPROVE, skill: '/sf-approve', copilotCommand: TASK_ROUTE });
  assert.equal(approve.copilotCommand, TASK_ROUTE);
  assert.equal(approve.skill, '/sf-approve', 'the skill stays the turn the command needs');
  assert.equal(approve.command, APPROVE, 'the Shell route stays the exact command');
  assert.equal(approve.modelFreeCommand, safeCommandGuidance(APPROVE).modelFreeCommand, 'so does the model-free route');
  assert.equal(safeCommandGuidance({ command: APPROVE, copilotCommand: TASK_ROUTE })?.copilotCommand, TASK_ROUTE, 'with the command\'s own skill');
  for (const [command, skill] of [['singularity-flow prepare implementation', '/sf-code'], ['singularity-flow prepare intake', '/sf-phase'],
    ['singularity-flow submit intake --work-id TASK-1', '/sf-submit'], ['singularity-flow phase prepublish implementation --for-agent --json --publish-if-ready', '/sf-code']]) {
    assert.equal(safeCommandGuidance({ command, skill, copilotCommand: TASK_ROUTE })?.copilotCommand, TASK_ROUTE, command);
  }
  // A decision, a return, a cancellation, a read and a reviewed value keep their own route; so does a classic Story's approval.
  const digest = `sha256:${'a'.repeat(64)}`;
  for (const refused of [
    { command: 'singularity-flow decisions TASK-1', skill: '/sf-decide', copilotCommand: TASK_ROUTE },
    { command: 'singularity-flow reject intake --work-id TASK-1 --fetch --to intake --reason <reason>', skill: '/sf-reject', copilotCommand: TASK_ROUTE },
    { command: 'singularity-flow cancel TASK-1 --reason <reason> --confirm TASK-1', copilotCommand: TASK_ROUTE },
    { command: 'singularity-flow workspace list', copilotCommand: TASK_ROUTE },
    { command: `singularity-flow story advance --work-id TASK-1 --confirm ${digest}`, skill: '/sf-submit', copilotCommand: TASK_ROUTE },
    { command: APPROVE, skill: '/sf-approve', copilotCommand: `${TASK_ROUTE} intake` },
    { command: APPROVE, skill: TASK_ROUTE, copilotCommand: TASK_ROUTE }
  ]) assert.equal(safeCommandGuidance(refused), null, JSON.stringify(refused));
  assert.equal(safeCommandGuidance({ command: APPROVE, skill: '/sf-approve' }).copilotCommand, '/sf-approve intake --work-id TASK-1');
  assert.deepEqual(['/sf-approve', '/sf-next', '/sf-code', '/sflow-phase', '/sf-publish', '/sf-submit', '/sf-design'].map(taskTakesTurn), [true, true, true, true, true, true, true]);
  assert.deepEqual(['/sf-decide', '/sf-reject', '/sf-confirm', '/sf-recover', '/sf-review-source', '/sf-cancel', null].map(taskTakesTurn), [false, false, false, false, false, false, false]);
});

test('a task\'s Story names /sf-task for the turns it takes; offers, decisions, returns and every classic Story keep theirs', () => {
  const approve = { skill: '/sf-approve', command: APPROVE, copilotCommand: '/sf-approve intake --work-id TASK-1' };
  assert.equal(withTaskRoute(TASK, approve).copilotCommand, TASK_ROUTE);
  assert.equal(withTaskRoute(TASK, approve).skill, '/sf-approve');
  assert.equal(withTaskRoute(CLASSIC, approve), approve, 'a classic Story is unchanged');
  // A route a step's decision carries is renamed inside its guidance too.
  const nested = withTaskRoute(TASK, { skill: '/sf-code', command: 'singularity-flow prepare implementation', commandGuidance: { copilotCommand: '/sf-code', command: 'singularity-flow prepare implementation' } });
  assert.deepEqual([nested.copilotCommand, nested.commandGuidance.copilotCommand, nested.commandGuidance.command], [TASK_ROUTE, TASK_ROUTE, 'singularity-flow prepare implementation']);
  for (const kept of [
    { ...approve, optional: true }, { ...approve, timing: 'alternative' }, { ...approve, rank: 'LATER' },
    { skill: '/sf-decide', command: 'singularity-flow decisions TASK-1', copilotCommand: '/sf-decide TASK-1' },
    { skill: '/sf-reject', command: 'singularity-flow reject intake --work-id TASK-1 --fetch --to intake --reason <reason>', copilotCommand: '/sf-reject' },
    { skill: '/sf-submit', command: 'singularity-flow story advance --work-id TASK-1 --confirm x', copilotCommand: '/sf-confirm K7Q2-M8DX' },
    { skill: '/sf-code', command: 'singularity-flow phase prepublish implementation', copilotCommand: null }
  ]) assert.equal(withTaskRoute(TASK, kept), kept, JSON.stringify(kept));
  assert.equal(Object.isFrozen(withTaskRoute(TASK, Object.freeze({ ...approve }))), true);
  assert.deepEqual(withTaskRoutes(CLASSIC, [approve]), [approve]);
  // A team's `use` rule runs a task as its own workflow: still a task's Story, by its recorded composition.
  assert.equal(isTaskStory({ workItem: { workType: 'standard' }, resolution: { composition: { kind: 'fix', uses: 'standard', steps: [{ id: 'intake' }] } } }), true);
  assert.equal(isTaskStory(CLASSIC), false);
  assert.equal(isTaskStory(null), false);
});

test('a task keeps its chat: no /clear or new chat between its steps, and the approval names /sf-task in this chat', () => {
  const pinned = { onApproval: 'new', onRejection: 'keep', phaseOverrides: {} };
  const task = { ...TASK, resolution: { ...TASK.resolution, contextPolicy: pinned } };
  const classic = { ...CLASSIC, resolution: { contextPolicy: pinned } };
  assert.equal(storyContextPolicy(classic), pinned);
  assert.deepEqual(contextBoundaryHandoff(storyContextPolicy(classic), 'intake', { nextPhase: 'implementation', nextSkill: '/sf-code' }).commands, ['/clear', '/sf-code']);
  const handoff = contextBoundaryHandoff(storyContextPolicy(task), 'intake', { nextPhase: 'implementation', nextSkill: TASK_ROUTE });
  assert.deepEqual([handoff.mode, handoff.commands], ['keep', [TASK_ROUTE]]);
  const approved = (contextBoundary) => agentAct(approvalAgentResult({ operation: { id: 'approve' }, subject: { kind: 'story', id: 'TASK-1' },
    outcome: { status: 'succeeded' }, effects: {}, data: { contextBoundary } }));
  const said = approved(handoff).said;
  assert.match(said, /Name the next step for the person: \/sf-task \(implementation\), typed in this chat\. Offer no other route\./u);
  assert.doesNotMatch(said, /\/clear|new chat/u);
  assert.match(approved(contextBoundaryHandoff(pinned, 'intake', { nextPhase: 'implementation', nextSkill: '/sf-code' })).said,
    /the one next step is \/clear, then \/sf-code \(implementation\)/u, 'a classic Story keeps its pinned reset');
  // After a step's submission: /sf-task in this chat, never "a new chat"; a classic approval keeps its fresh-chat advice.
  const after = (copilotCommand) => nextAfterStep({ continuation: { copilotCommand, nextCommand: APPROVE, nextAction: { reason: 'Approve it.' } } }, 'Submitted.').instruction;
  assert.match(after(TASK_ROUTE), /Say the person types \/sf-task in this chat to carry the task on\./u);
  assert.doesNotMatch(after(TASK_ROUTE), /new chat/u);
  assert.match(after('/sf-approve intake --work-id S-1'), /Say to run it in a new chat: it needs nothing from this one\./u);
});

test('ITW REQ-008: a real task Story names /sf-task at every turn, with each step\'s exact Shell route; a classic Story keeps its skills', async (t) => {
  const story = await journeyRepository(t);
  story.cli('work', 'fix the value module so it returns 2', '--start', '--json');
  Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
  const record = storyRecord(story);
  assert.equal(isTaskStory(record), true);
  // nextsteps --for-agent: act.do names /sf-task beside the intake's own command, and the action keeps its skill.
  const agent = JSON.parse(story.raw(['nextsteps', 'TASK-1', '--for-agent', '--json']).stdout);
  assert.equal(agent.act.do.copilot, TASK_ROUTE, JSON.stringify(agent.act));
  assert.match(agent.act.do.shell, /^singularity-flow (?:prepare|phase (?:enter|begin)) intake\b/u, JSON.stringify(agent.act));
  // The intake submitted: its approval is the person's, by /sf-task; the return keeps /sf-reject; /sf-task takes the approval turn.
  const waiting = structuredClone(record);
  waiting.phases.intake.status = 'awaiting_approval';
  const guide = workflowGuide(waiting);
  const [approve, ...rest] = guide.nextActions;
  assert.deepEqual([approve.skill, approve.copilotCommand, approve.command], ['/sf-approve', TASK_ROUTE, APPROVE]);
  assert.ok(rest.filter((entry) => entry.skill === '/sf-reject').every((entry) => entry.copilotCommand !== TASK_ROUTE));
  assert.equal(taskTurnSkillFor(waiting, guide), 'sf-approve', 'the turn /sf-task takes is still read from the skill');
  const snapshot = nextStepsSnapshot({ workflow: waiting });
  assert.deepEqual([snapshot.actions[0].copilotCommand, snapshot.actions[0].command], [TASK_ROUTE, APPROVE]);
  const text = nextStepsText(snapshot);
  assert.match(text, /Now — Approve the Intake\n\s*- Copilot: \/sf-task\n\s*- Shell: singularity-flow approve intake --work-id TASK-1 --fetch\n\s*- VS Code \(model-free\): @sflow \/approve intake --work-id TASK-1\n/u);
  assert.match(text, /Or — Return the Intake for correction\n\s*- Copilot: \/sf-reject\n/u);
  assert.equal(phaseContinuation(waiting).copilotCommand, TASK_ROUTE, 'phase show\'s continuation, which a submission ends on');
  // A command's result names its next steps from the same planner, and the result still validates.
  const result = attachContinuation({ operation: { id: 'submit', classification: 'mutation' }, subject: { kind: 'story', id: 'TASK-1' },
    outcome: { status: 'succeeded', messageId: 'submit.succeeded', slots: { phase: 'intake' } },
    effects: { stateChanged: true, filesChanged: true, publicationCreated: true, externalSystemsChanged: false }, why: [], next: [], restState: null, data: {} },
  { postState: waiting });
  validateCommandResult(result);
  assert.deepEqual([result.next[0].copilotCommand, result.next[0].command, result.next[0].skill], [TASK_ROUTE, APPROVE, '/sf-approve']);
  // The intake approved: the code step is next, by /sf-task in the same chat; nothing asks for /clear.
  const coding = structuredClone(record);
  Object.assign(coding.phases.intake, { status: 'approved' });
  coding.currentPhase = coding.phaseOrder[1];
  coding.phases[coding.currentPhase].status = 'in_progress';
  assert.equal(stepChatCommand(coding), TASK_ROUTE);
  assert.equal(pendingContextBoundary(coding, stepChatCommand), null);
  const classicCoding = { ...structuredClone(coding), workItem: { ...coding.workItem, workType: 'quick-fix' },
    resolution: { ...coding.resolution, composition: undefined, contextPolicy: { onApproval: 'new', onRejection: 'keep', phaseOverrides: {} } } };
  assert.deepEqual(pendingContextBoundary(classicCoding, stepChatCommand)?.commands, ['/clear', stepChatCommand(classicCoding)]);
  assert.notEqual(stepChatCommand(classicCoding), TASK_ROUTE);

  // A classic Story in its own repository: every route is its step's own skill, as before.
  const classic = await journeyRepository(t);
  startStory(classic, 'S-1', { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  const classicRecord = storyRecord(classic);
  assert.equal(isTaskStory(classicRecord), false);
  const classicAgent = JSON.parse(classic.raw(['nextsteps', 'S-1', '--for-agent', '--json']).stdout);
  assert.notEqual(classicAgent.act.do.copilot, TASK_ROUTE, JSON.stringify(classicAgent.act));
  assert.match(classicAgent.act.do.copilot ?? '', /^\/sf-/u, JSON.stringify(classicAgent.act));
  const classicWaiting = structuredClone(classicRecord);
  classicWaiting.phases[classicWaiting.currentPhase].status = 'awaiting_approval';
  const classicApprove = workflowGuide(classicWaiting).nextActions[0];
  assert.equal(classicApprove.copilotCommand, `/sf-approve ${classicWaiting.currentPhase} --work-id S-1`);
  assert.equal(nextStepsSnapshot({ workflow: classicWaiting }).actions[0].copilotCommand, `/sf-approve ${classicWaiting.currentPhase} --work-id S-1`);
});
