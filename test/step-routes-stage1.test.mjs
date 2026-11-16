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

test('a code step returned for rework asks the person in its own entry, with the permission and one command [OSA:REQ-010, REQ-030, C13]', () => {
  const workflow = codeStory({ reworkRevalidation: { generation: 1, invalidatedAt: '2026-11-16T09:00:00.000Z' } });
  const phase = workflow.phases.implement;
  // Stage 2: a successor, even one a person's return asked for, opens only on the person's yes [D3]; the entry asks it.
  const entry = phaseAuthoringEntry(workflow, phase);
  assert.equal(entry.status, 'successor-confirmation-required');
  assert.equal(entry.reason, 'rework');
  assert.match(entry.successor.question, /^Start version 2 of Implement\? Published version 1 will stay unchanged\.$/u);
  const contract = deriveMutationContract({ definition: {}, workflow });
  assert.deepEqual(contract.allow.artifacts, [], 'nothing of the step is writable before the opening');
  assert.equal(contract.allow.application, false);
  const progress = phaseAuthoringProgress(workflow, phase);
  // One command for the step: the permission's next, the task's next and the entry's preview are the same rollover.
  assert.equal(progress.next.command, 'singularity-flow phase rollover implement --json');
  assert.equal(contract.next[0].command, progress.next.command);
  assert.equal(entry.successor.preview.command, progress.next.command);
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
    // The edit guard and the entry derive one permission from one decision: the same next, with no handoff only the entry
    // passed (Stage 0 finding 1: the guard said `nextsteps`, the entry the Story's next) [OSA:REQ-010, AC-001].
    const contract = deriveMutationContract({ definition: {}, workflow });
    assert.doesNotMatch(JSON.stringify(contract.next), /\brecover\b|\/sf-recover/u, name);
    const expected = workflow.phases.implement.status === 'awaiting_approval'
      ? 'singularity-flow approve implement --work-id OSA-2 --fetch' : 'singularity-flow status OSA-2 --submission-readiness --json';
    assert.equal(contract.next[0].command, expected, name);
    assert.match(contract.summary, /not being written/u, name);
    // Nothing to wait for before editing a step that is not being written.
    assert.equal(mutationContractPresentation(contract).sourceEditPrerequisite, null, name);
  }
});

test('recover stays only where something is damaged: a consumed intent that is not the published version\'s [OSA:REQ-003, D4]', () => {
  // Being written (returned for rework), with a consumed intent of another version than the published one.
  const workflow = codeStory({ generation: 2, generationIntent: { status: 'consumed', generation: 1 }, reworkRevalidation: { generation: 2 } });
  const contract = deriveMutationContract({ definition: {}, workflow });
  assert.equal(contract.policy.editable, true);
  assert.equal(contract.policy.step.state, 'damaged');
  assert.match(contract.next[0].command, /^singularity-flow recover OSA-2 --phase implement\b/u);
  // Damage preserves the affected work: nothing of the step is writable until recovery reconciles it [OSA:REQ-014].
  assert.deepEqual([contract.allow.artifacts, contract.allow.application], [[], false]);
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

// ------------------------------------------------------------------------------------------- item 5: no containment

test('a refusal whose own route writes the step adds no recover or phase show; others keep their containment [OSA:REQ-022, C3]', async () => {
  const { refusalRemediationPlan } = await import('../src/refusal-remediation.mjs');
  const { SingularityFlowError } = await import('../src/util.mjs');
  const writing = new SingularityFlowError('Version 2 of implement is being written; review it after it is published.', {
    code: 'SOURCE_REVIEW_SUCCESSOR_OPEN', details: { nextAction: { command: 'singularity-flow prepare implement', skill: '/sflow-code',
      label: 'Write version 2 of implement, then publish it' }, phase: 'implement', version: 2 } });
  const plan = refusalRemediationPlan(writing, ['review-source', 'context', 'implement']);
  assert.equal(plan.steps[0].command, 'singularity-flow prepare implement');
  assert.match(plan.steps[0].copilotCommand, /^\/sf-code\b/u);
  assert.doesNotMatch(JSON.stringify(plan.steps), /singularity-flow recover\b|phase show\b/u);
  assert.equal(plan.steps.at(-1).command, 'singularity-flow nextsteps --json');
  // A published version changed only by its next one: the rollover its work command asks about, no recover beside it.
  const consumed = new SingularityFlowError('Version 1 of implement is already published.', { code: 'GENERATION_INTENT_ALREADY_CONSUMED',
    details: { nextAction: { command: 'singularity-flow phase rollover implement --json', skill: '/sf-code', label: 'Start version 2 of implement to change it' } } });
  const rolled = refusalRemediationPlan(consumed, ['prepare', 'implement']);
  assert.equal(rolled.steps[0].command, 'singularity-flow phase rollover implement --json');
  assert.doesNotMatch(JSON.stringify(rolled.steps), /singularity-flow recover\b|\/sf-recover/u);
  // A refusal whose own route is not the step's writing keeps a containment: the step's own next-step read, which names
  // recovery only for a damaged step, never recovery itself or a document view (Stage 3 completion) [D4, OSA:REQ-011].
  const other = new SingularityFlowError('The phase artifact is missing.', { code: 'ARTIFACT_MISSING_FOR_TEST', details: { phase: 'implement' } });
  const contained = refusalRemediationPlan(other, ['phase', 'publish', 'implement']).steps;
  assert.deepEqual(contained.map((entry) => [entry.id, entry.command]), [['inspect-current-phase', 'singularity-flow nextsteps --json']]);
  assert.doesNotMatch(JSON.stringify(contained), /singularity-flow recover\b|\/sf-recover|phase show\b/u);
});
