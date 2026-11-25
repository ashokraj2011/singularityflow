/**
 * A person reads each next action as "<timing> — <label>" with its Copilot, Shell and VS Code routes, and the three do the
 * same thing (owner, 2026-11-25: "mismatches in chat window command suggested command in copilot"). A live task run showed
 * "Copilot: /clear, then /sf-code" beside "Shell: not available", the approval just run shown again as "Now" with its
 * private receipt and --for-agent, /sf-task beside a Shell route that only reads, and a review's /sf-submit beside a
 * different command than the one its turn ran.
 *
 * Every person-facing route builder, on a task's Story and a classic one, at each of their states, is held to this:
 * - a Copilot route is one real command (a `/sf-*` skill with its arguments, or a chat reset alone);
 * - a Shell route is a person's: no --for-agent, no --selection-receipt, no receipt token;
 * - Copilot and Shell are the same thing: the command crosswalk pairs them (with the reviewed /sf-task exception);
 * - a command's result never names the command that just ran as its "Now".
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { approvalAgentResult } from '../src/approval-agent-result.mjs';
import { contextBoundaryPresentation, pendingContextBoundary } from '../src/context-policy.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { attachContinuation } from '../src/narration/continuation.mjs';
import { validateCommandResult } from '../src/narration/command-result.mjs';
import { nextStepsSnapshot, nextStepsText } from '../src/nextsteps.mjs';
import { phaseContinuation } from '../src/phase-continuation.mjs';
import { safeCommandGuidance, TASK_ROUTE } from '../src/safe-command-guidance.mjs';
import { sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { stepChatCommand } from '../src/step-decision.mjs';
import { journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';

const { buildJourney } = await import('../apps/vscode/src/views/journey-model.ts');

const ONE_COMMAND = /^(?:\/sf-[a-z0-9]+(?:-[a-z0-9]+)*(?: [^\s,][^,]*)?|\/clear|\/compact)$/u;
const CHAT_RESET = /^\/(?:clear|compact)$/u;
const AGENT_ONLY = /\s--(?:for-agent|selection-receipt)(?:[\s=]|$)/u;
const RECEIPT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;

/** What is wrong with one person-facing action's routes; [] when its Copilot, Shell and VS Code routes agree. */
export function personRouteProblems(action, where) {
  if (!action || typeof action !== 'object') return [];
  const copilot = action.copilotCommand ?? action.commandGuidance?.copilotCommand ?? null;
  const shell = action.command ?? action.commandGuidance?.command ?? null;
  const problems = [];
  if (copilot != null && !ONE_COMMAND.test(copilot)) problems.push(`${where}: Copilot "${copilot}" is not one command`);
  if (shell && AGENT_ONLY.test(shell)) problems.push(`${where}: Shell "${shell}" carries an agent's own flag`);
  if (shell && RECEIPT.test(shell)) problems.push(`${where}: Shell "${shell}" carries a private receipt`);
  if (shell && copilot && !safeCommandGuidance({ command: shell, copilotCommand: copilot, ...(action.skill ? { skill: action.skill } : {}) })) {
    problems.push(`${where}: Copilot "${copilot}" and Shell "${shell}" are not the same thing`);
  }
  if (!shell && copilot && !CHAT_RESET.test(copilot)) problems.push(`${where}: Copilot "${copilot}" has no Shell route`);
  return problems;
}

/** The step words of a command (`approve intake`), for "the command that just ran". */
const words = (command) => String(command ?? '').replace(/^singularity-flow\s+/u, '').split(/\s+/u).filter((word) => !word.startsWith('-')).slice(0, 2).join(' ');

const MESSAGE = { status: 'status.reported', approve: 'approve.succeeded', submit: 'submit.succeeded' };
const result = (operation, workId, phase) => ({ operation: { id: operation, classification: operation === 'status' ? 'read' : 'mutation' }, subject: { kind: 'story', id: workId },
  outcome: { status: 'succeeded', messageId: MESSAGE[operation], slots: { phase } },
  effects: { stateChanged: true, filesChanged: true, publicationCreated: true, externalSystemsChanged: false }, why: [], next: [], restState: null, data: {} });

/** The Story at its states: writing its first step, that step awaiting approval, the next step after it, and closed. */
function states(record) {
  const [first, second] = record.phaseOrder;
  const awaiting = structuredClone(record);
  awaiting.phases[first].status = 'awaiting_approval';
  const next = structuredClone(record);
  next.phases[first].status = 'approved';
  next.currentPhase = second;
  next.phases[second].status = 'in_progress';
  next.resolution.contextPolicy = { onApproval: 'new', onRejection: 'keep', phaseOverrides: {} };
  const closed = structuredClone(record);
  for (const id of closed.phaseOrder) closed.phases[id].status = 'approved';
  Object.assign(closed, { currentPhase: null, status: 'closed' });
  return { writing: record, awaiting, next, closed, first, second };
}

function everyRoute(workflow, label) {
  const problems = [];
  const check = (list, where) => (list ?? []).forEach((action, index) => problems.push(...personRouteProblems(action, `${label} ${where}[${index}]`)));
  check(workflowGuide(workflow).nextActions, 'guide');
  check(nextStepsSnapshot({ workflow }).actions, 'nextsteps');
  check(phaseContinuation(workflow).actions, 'phase show');
  const phase = workflow.phases?.[workflow.currentPhase] ?? workflow.phases?.[workflow.phaseOrder.at(-1)];
  if (phase) check(sourceReviewContinuation(workflow, phase).actions, 'review continuation');
  const attached = attachContinuation(result('status', workflow.workItem.id, phase?.id), { postState: workflow });
  validateCommandResult(attached);
  check(attached.next, 'result next');
  const boundary = contextBoundaryPresentation(pendingContextBoundary(workflow, stepChatCommand));
  if (boundary) problems.push(...personRouteProblems(boundary.commandGuidance, `${label} context boundary`));
  return problems;
}

/** A command's result never names that command as its "Now" (the approval just run, shown again with its receipt). */
function notAgainNow(workflow, operation, ran, label) {
  const attached = attachContinuation(result(operation, workflow.workItem.id, ran.split(' ')[1]), { postState: workflow });
  return attached.next.filter((entry) => entry.rank === 'NOW' && words(entry.command) === ran).map((entry) => `${label}: ${operation} names ${entry.command} as Now`);
}

for (const kind of ['task', 'classic']) {
  test(`every route a person reads on a ${kind} Story is one real command, a person's Shell route, and the same thing on both`, async (t) => {
    const story = await journeyRepository(t);
    if (kind === 'task') {
      const started = JSON.parse(story.cli('work', 'fix the value module so it returns 2', '--start', '--json'));
      Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
      // The start's own next: /sf-task beside the first step's own command, never beside a read (`work status`).
      const [first] = started.next ?? [];
      assert.equal(first?.copilotCommand, TASK_ROUTE, JSON.stringify(started.next));
      assert.doesNotMatch(first.command, /^singularity-flow work status\b/u, 'the Shell route does what /sf-task does');
      assert.deepEqual((started.next ?? []).flatMap((action, index) => personRouteProblems(action, `start next[${index}]`)), []);
    } else startStory(story, 'S-1', { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
    const record = storyRecord(story);
    const { writing, awaiting, next, closed, first } = states(record);
    for (const [name, workflow] of Object.entries({ writing, awaiting, next, closed })) {
      assert.deepEqual(everyRoute(workflow, `${kind} ${name}`), [], `${kind} ${name}`);
    }
    // The approval and the submission just run are never their own result's "Now".
    assert.deepEqual([...notAgainNow(next, 'approve', `approve ${first}`, kind), ...notAgainNow(awaiting, 'submit', `submit ${first}`, kind)], []);
    // An approval in chat ends on the next step, never on itself: the approval result's own next is not an approve.
    const approved = approvalAgentResult({ operation: { id: 'approve' }, subject: { kind: 'story', id: record.workItem.id }, outcome: { status: 'succeeded' },
      effects: {}, data: { contextBoundary: pendingContextBoundary(next, stepChatCommand) } });
    assert.deepEqual(approved.next.flatMap((action, index) => personRouteProblems(action, `approval next[${index}]`)), []);
    assert.ok(approved.next.every((action) => words(action.command) !== `approve ${first}`));
    if (approved.contextBoundary) assert.deepEqual(personRouteProblems(approved.contextBoundary.commandGuidance, 'approval boundary'), []);
    // The guided router line names /sf-task on a task's Story too; a classic Story keeps /sf-next.
    assert.match(nextStepsText(nextStepsSnapshot({ workflow: writing })), kind === 'task'
      ? /Guided router:\n- Copilot: \/sf-task\n- Shell: singularity-flow next\n/u : /Guided router:\n- Copilot: \/sf-next\n- Shell: singularity-flow next\n/u);
    // VS Code's Journey: its route list and its Generate button name /sf-task for every turn /sf-task takes, with the step's
    // own Shell route and skill; a classic Story keeps the step's own skill.
    for (const [name, readiness, generation] of [
      ['generate', { classification: 'generation-required', reasonCode: 'PHASE_GENERATION_REQUIRED', nextSkill: '/sf-phase', nextCommand: `singularity-flow prepare ${first}` }, 0],
      ['submit', { lifecycleReady: true, publicationRecorded: true, publishedGeneration: 1, currentGeneration: 1, classification: 'ready-to-attempt',
        reasonCode: 'SUBMISSION_READY', nextSkill: '/sf-submit', nextCommand: `singularity-flow submit ${first} --work-id ${record.workItem.id}` }, 1]
    ]) {
      const workflow = structuredClone(writing);
      workflow.phases[first].generation = generation;
      const next = buildJourney({ included: ['repository', 'lifecycle'], workflow,
        submissionReadiness: { draftExists: false, draftModified: false, publicationRecorded: false, currentGeneration: 0, publishedGeneration: null, phaseId: first, ...readiness } }).nextAction;
      assert.equal(next?.command, readiness.nextCommand, `${kind} journey ${name}`);
      assert.equal(next.skill, readiness.nextSkill, 'the turn it needs stays its own');
      assert.equal(next.copilotCommand, kind === 'task' ? TASK_ROUTE : safeCommandGuidance({ command: readiness.nextCommand, skill: readiness.nextSkill }).copilotCommand, `${kind} journey ${name}`);
      assert.deepEqual(personRouteProblems(next, `${kind} journey ${name}`), []);
    }
    // A closed task's one next action is its last message; a classic Story keeps its own routes.
    const done = nextStepsSnapshot({ workflow: closed }).actions.find((action) => action.timing === 'now');
    if (kind === 'task') {
      assert.deepEqual([done?.copilotCommand, done?.command], [TASK_ROUTE, 'singularity-flow work status TASK-1']);
      const read = phaseContinuation(closed, { reviewedPhaseId: closed.phaseOrder.at(-1) });
      assert.deepEqual([read.copilotCommand, read.nextCommand], [TASK_ROUTE, 'singularity-flow work status TASK-1'], 'never /sf-nextsteps');
    } else {
      assert.notEqual(done?.copilotCommand, TASK_ROUTE);
      assert.equal(phaseContinuation(closed, { reviewedPhaseId: closed.phaseOrder.at(-1) }).copilotCommand, '/sf-nextsteps');
    }
  });
}

test('the check itself refuses each mismatch the live run showed', () => {
  assert.deepEqual(personRouteProblems({ copilotCommand: '/clear, then /sf-code', command: null }, 'boundary'),
    ['boundary: Copilot "/clear, then /sf-code" is not one command', 'boundary: Copilot "/clear, then /sf-code" has no Shell route']);
  const receipt = ['0b6f7c1e', '2d3a', '4b5c', '8d9e', '0f1a2b3c4d5e'].join('-');
  assert.equal(personRouteProblems({ copilotCommand: '/sf-approve intake --work-id TASK-1',
    command: `singularity-flow approve intake --work-id TASK-1 --fetch --selection-receipt ${receipt} --for-agent --json` }, 'approval').length, 3);
  assert.deepEqual(personRouteProblems({ copilotCommand: '/sf-submit', command: 'singularity-flow decisions TASK-1' }, 'review'),
    ['review: Copilot "/sf-submit" and Shell "singularity-flow decisions TASK-1" are not the same thing']);
  assert.deepEqual(personRouteProblems({ copilotCommand: TASK_ROUTE, command: 'singularity-flow approve intake --work-id TASK-1 --fetch', skill: '/sf-approve' }, 'task'), []);
  assert.deepEqual(personRouteProblems({ copilotCommand: '/clear', command: null }, 'reset'), []);
});

test('the Journey\'s Generate button fills the route its list names: /sf-task on a task\'s Story, the step\'s skill otherwise', async () => {
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /id: 'story:journey:generate'[^]{0,200}prefill: journey\.nextAction\.copilotCommand === TASK_ROUTE \? TASK_ROUTE : journey\.nextAction\.skill/u);
});
