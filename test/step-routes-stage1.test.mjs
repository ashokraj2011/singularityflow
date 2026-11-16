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

