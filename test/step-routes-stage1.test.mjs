/**
 * SPEC-OSA Stage 1: the routes a step's state gives agree, and none sends a healthy step round recover [owner,
 * 2026-11-16]. A real Story's code step was told "write now" by its entry and "no edits, recover" by its edit
 * permission in one reply, and went round recover, the documents view, review and /sf-phase back to itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { deriveMutationContract, mutationContractPresentation } from '../src/phase-mutation-contract.mjs';
import { phaseAuthoringEntry } from '../src/phase-authoring-entry.mjs';
import { phaseAuthoringProgress } from '../src/phase-authoring-progress.mjs';
import { stepBeingWritten } from '../src/phase-generation-need.mjs';

const RECORD = { path: 'singularity/work-items/OSA-2/publications/x.json', sha256: `sha256:${'b'.repeat(64)}` };

/** A Story at its code step, published at version 1. */
function codeStory(changes = {}) {
  const phase = { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact',
    generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/implement/summary.md', kind: 'implementation-summary' },
    generationIntent: { status: 'consumed', generation: 1 }, generationPublications: [{ generation: 1, record: RECORD }],
    approvalPolicy: { mode: 'required' }, ...changes };
  return { workItem: { id: 'OSA-2' }, status: 'in_progress', currentPhase: 'implement', phaseOrder: ['implement'],
    phases: { implement: phase }, history: [], resolution: {} };
}

// ------------------------------------------------------------------------------------------- item 2: act and permission

test('the entry says author only when its edit permission grants an edit; otherwise its act is the permission\'s next [OSA:REQ-010, C7]', () => {
  const next = [{ command: 'singularity-flow phase begin implement --json', commandGuidance: { command: 'singularity-flow phase begin implement --json', copilotCommand: '/sf-code implement' },
    detail: 'Open the exact code generation before application edits.' }];
  const entry = (mutationContract) => ({ resultType: 'sflow-phase-entry', status: 'authoring-entry', phase: 'implement', mutationContract });
  // Nothing granted: the act is the permission's own next, never `author`.
  const held = agentAct(entry({ artifacts: [], applicationEdits: false, summary: 'No edits yet.', next }));
  assert.equal(held.state, 'next');
  assert.equal(held.do.shell, 'singularity-flow phase begin implement --json');
  assert.match(held.do.copilot, /^\/sf-code\b/u);
  // The step's files granted: `author`.
  assert.equal(agentAct(entry({ artifacts: ['singularity/work-items/OSA-2/artifacts/implement/'], applicationEdits: false, next })).state, 'author');
  assert.equal(agentAct(entry({ artifacts: [], applicationEdits: true, next })).state, 'author');
});

test('a code step returned for rework is written in its own entry: author, with the permission and one command [OSA:REQ-010, C13]', () => {
  const workflow = codeStory({ reworkRevalidation: { generation: 1, invalidatedAt: '2026-11-16T09:00:00.000Z' } });
  const phase = workflow.phases.implement;
  assert.equal(phaseAuthoringEntry(workflow, phase).status, 'authoring-entry');
  const contract = deriveMutationContract({ definition: {}, workflow });
  assert.ok(contract.allow.artifacts.length, 'the step\'s files are granted');
  const progress = phaseAuthoringProgress(workflow, phase);
  // One command for the step: the permission's next and the task's next are the same `phase begin`.
  assert.equal(progress.next.command, 'singularity-flow phase begin implement --json');
  assert.equal(contract.next[0].command, progress.next.command);
  assert.equal(contract.next[0].copilotCommand.split(' ')[0], '/sf-code');
});

// ------------------------------------------------------------------------------------------- item 3: no recover fallback

test('a step not being written is never sent to recover by its edit permission; its next is the step\'s own way on [OSA:REQ-011, C1]', () => {
  const states = {
    'published, no review owed': codeStory(),
    'submitted': codeStory({ status: 'awaiting_approval' }),
    'published document': (() => { const w = codeStory({ generationPolicy: { requirement: 'required', task: 'document' }, writeScope: 'artifact-only' });
      delete w.phases.implement.generationIntent; return w; })()
  };
  for (const [name, workflow] of Object.entries(states)) {
    const phase = workflow.phases.implement;
    assert.equal(stepBeingWritten(workflow, phase), false, name);
    // With no handoff given (the edit guard), the planner's list; with the Story's next action (the entry), that action.
    const bare = deriveMutationContract({ definition: {}, workflow });
    assert.doesNotMatch(JSON.stringify(bare.next), /\brecover\b|\/sf-recover/u, name);
    assert.equal(bare.next[0].command, 'singularity-flow nextsteps --json', name);
    const handed = deriveMutationContract({ definition: {}, workflow,
      handoff: [{ skill: '/sflow-submit', command: 'singularity-flow submit implement --work-id OSA-2', reason: 'Submit published implement.' }] });
    assert.equal(handed.next[0].command, 'singularity-flow submit implement --work-id OSA-2', name);
    assert.match(handed.summary, /not being written/u, name);
    // Nothing to wait for before editing a step that is not being written.
    assert.equal(mutationContractPresentation(handed).sourceEditPrerequisite, null, name);
  }
});

test('recover stays only where something is damaged: a consumed intent that is not the published version\'s [OSA:REQ-003, D4]', () => {
  // Being written (returned for rework), with a consumed intent of another version than the published one.
  const workflow = codeStory({ generation: 2, generationIntent: { status: 'consumed', generation: 1 }, reworkRevalidation: { generation: 2 } });
  const contract = deriveMutationContract({ definition: {}, workflow });
  assert.equal(contract.policy.editable, true);
  assert.match(contract.next[0].command, /^singularity-flow recover OSA-2 --phase implement\b/u);
});

test('phase show\'s continuation never names recover when the readiness read fails: it gives the planner\'s own next action [OSA:REQ-011, C1]', async () => {
  const { reviewContinuation } = await import('../src/review-continuation.mjs');
  const workflow = codeStory();
  // A checkout that does not exist: every read here fails, which shows nothing damaged.
  const continuation = await reviewContinuation('/nonexistent/osa-stage-1', { workItemRoot: 'singularity/work-items' }, workflow, workflow.phases.implement);
  assert.ok(continuation.nextCommand, JSON.stringify(continuation).slice(0, 800));
  assert.doesNotMatch(JSON.stringify(continuation.actions), /singularity-flow recover\b|\/sf-recover/u);
});

// ------------------------------------------------------------------------------------------- item 4: the step's work command

test('a step\'s own commands take its work command: `phase begin` is /sf-code\'s, and `phase enter` accepts the step\'s skill [OSA:REQ-021, C4]', async () => {
  const { skillForCommandLine } = await import('../src/command-skills.mjs');
  const { safeCommandGuidance } = await import('../src/safe-command-guidance.mjs');
  assert.equal(skillForCommandLine('singularity-flow phase begin implement --json'), 'sf-code');
  const entry = safeCommandGuidance({ argv: ['phase', 'enter', 'implement', '--compose', '--for-agent', '--json'], skill: '/sflow-code' });
  assert.ok(entry, 'the code step\'s entry by its own work command is a valid route');
  assert.match(entry.copilotCommand, /^\/sf-code\b/u);
});

test('the refusals that name writing a code step carry its work command, never /sf-phase or recover [OSA:REQ-021, C4, C11]', async () => {
  const { requireOpenGenerationIntent } = await import('../src/generation-boundary.mjs');
  const { refusalRemediationPlan } = await import('../src/refusal-remediation.mjs');
  const workflow = codeStory({ generation: 0, generationIntent: undefined, generationPublications: [] });
  let refused = null;
  try { requireOpenGenerationIntent(workflow, workflow.phases.implement); } catch (error) { refused = error; }
  assert.equal(refused?.code, 'GENERATION_INTENT_REQUIRED');
  assert.equal(refused.details.nextAction.skill, '/sflow-code');
  const [first] = refusalRemediationPlan(refused, ['phase', 'publish', 'implement']).steps;
  assert.equal(first.command, 'singularity-flow phase begin implement --json');
  assert.match(first.copilotCommand, /^\/sf-code\b/u);
  // The task a resumed chat is given for a code step names its work command too.
  const { workflowTaskResume } = await import('../src/workflow-task.mjs');
  const open = codeStory({ generation: 1, generationIntent: { status: 'open', generation: 2 } });
  const resume = workflowTaskResume(open, open.phases.implement, { published: false });
  assert.match(resume?.nextAction?.copilotCommand ?? '', /^\/sf-code\b/u, JSON.stringify(resume?.nextAction ?? resume));
});

