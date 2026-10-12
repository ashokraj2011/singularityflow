/**
 * A conversation that did not see an approval still learns the context boundary it owes.
 *
 * An approval made in the CLI, the VS Code approvals view or by another person returns its boundary
 * only there. Agent entries for the next phase repeat it until that phase is prepared, so a stale
 * conversation can ask for `/clear` instead of carrying every earlier phase into each model call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pendingContextBoundary } from '../src/context-policy.mjs';
import { nextStepsSnapshot, nextStepsText } from '../src/nextsteps.mjs';
import { agentNextSteps } from '../src/commands/nextsteps.mjs';
import { phaseContinuation, phaseContinuationLines } from '../src/phase-continuation.mjs';
import { approvalAgentResult } from '../src/approval-agent-result.mjs';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { resolveWorkType } from '../src/config.mjs';

function story({ onApproval = 'new', previous = 'approved', current = 'in_progress', artifacts = [], phaseOverrides } = {}) {
  return {
    workItem: { id: 'BOUNDARY-1', branch: 'BOUNDARY-1' }, status: 'in_progress',
    currentPhase: 'implementation', phaseOrder: ['intake', 'implementation', 'testing'],
    resolution: { contextPolicy: { onApproval, ...(phaseOverrides ? { phaseOverrides } : {}) } },
    phases: {
      intake: { id: 'intake', status: previous },
      implementation: { id: 'implementation', label: 'Implementation', status: current, artifacts, generation: 0 },
      testing: { id: 'testing', status: 'not_started' }
    }
  };
}

test('the approval that opened an unprepared phase is repeated with its commands', () => {
  const boundary = pendingContextBoundary(story());
  assert.equal(boundary.mode, 'new');
  assert.equal(boundary.phase, 'intake');
  assert.equal(boundary.nextPhase, 'implementation');
  assert.deepEqual(boundary.commands, ['/clear', '/sf-next']);
  assert.match(boundary.instruction, /already worked on an earlier phase.*\/clear, then \/sf-next.*A conversation that starts here continues/u);
  assert.deepEqual(pendingContextBoundary(story({ onApproval: 'compact' })).commands, ['/compact', '/sf-next']);
  assert.equal(pendingContextBoundary(story({ onApproval: 'keep', phaseOverrides: { intake: 'new' } })).mode, 'new',
    'a phase override names the boundary of that approval');
});

test('approval, nextsteps, compact routing and phase continuation agree before authoring', () => {
  for (const onApproval of ['new', 'compact']) {
    const workflow = story({ onApproval });
    const snapshot = nextStepsSnapshot({ workflow });
    const boundary = snapshot.contextBoundary;
    assert.deepEqual(boundary.commands, [onApproval === 'new' ? '/clear' : '/compact', '/sf-next']);
    assert.equal(boundary.condition, 'conversation-worked-on-earlier-phase');
    assert.equal(boundary.commandGuidance.command, null, 'a chat reset is never an executable shell command');
    assert.equal(boundary.commandGuidance.modelFreeCommand, null);
    assert.equal(agentNextSteps(snapshot).contextBoundary, boundary);
    assert.ok(snapshot.actions.filter(entry => entry.timing === 'now')
      .every(entry => entry.copilotTiming === 'after-context-boundary'));
    const text = nextStepsText(snapshot);
    assert.ok(text.indexOf(boundary.commands[0]) < text.indexOf('singularity-flow prepare'));
    const continuation = phaseContinuation(workflow);
    assert.deepEqual(continuation.contextBoundary, boundary);
    const continuationText = phaseContinuationLines(continuation).join('\n');
    assert.ok(continuationText.includes(boundary.commands.join(', then ')));
    assert.ok(continuationText.includes('singularity-flow prepare'), 'fresh chats still receive an actionable authoring command');
    assert.ok(continuationText.indexOf(boundary.commands[0]) < continuationText.indexOf('singularity-flow prepare'));
    const approved = approvalAgentResult({ operation: { id: 'approve' }, data: { contextBoundary: pendingContextBoundary(workflow) } });
    assert.deepEqual(approved.contextBoundary.commands, boundary.commands);
    assert.match(approved.instruction, /clear|compact/);
    assert.match(boundary.instruction, /A conversation that starts here continues/);
    assert.ok(snapshot.actions.some(entry => entry.timing === 'now' && entry.argv[0] === 'prepare'),
      'fresh chats and model-free/shell consumers must not acquire an artificial lifecycle gate');
  }
});

test('boundary presentation never hides publication, recovery or required after-step work', () => {
  for (const options of [{ publicationPending: true }, { recovery: { requiresRecovery: true } },
    { stepActionHold: { missing: ['delivery'], nextAction: 'singularity-flow integrations status' } }]) {
    const snapshot = nextStepsSnapshot({ workflow: story(), ...options });
    assert.equal(snapshot.contextBoundary, undefined);
    assert.equal(snapshot.actions[0].timing, 'now');
  }
  assert.equal(nextStepsSnapshot({ workflow: story({ onApproval: 'keep' }) }).contextBoundary, undefined);
});

test('all seeded, copied and future-named phase boundaries share the pending handoff rule', () => {
  let checked = 0;
  for (const file of ['../templates/workflow.yml', '../examples/workflow-with-quality-gates.yml']) {
    const definition = YAML.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const workType of Object.keys(definition.workTypes)) {
      const resolved = resolveWorkType(definition, workType);
      for (let index = 1; index < resolved.phases.length; index++) {
        const phases = resolved.phases.map((entry, i) => ({ ...entry, generationPolicy: entry.generation, status: i < index ? 'approved' : i === index ? 'in_progress' : 'not_started', generation: 0, artifacts: [] }));
        const workflow = { workItem: { id: 'MATRIX' }, status: 'in_progress',
          currentPhase: phases[index].id, phaseOrder: phases.map(entry => entry.id),
          phases: Object.fromEntries(phases.map(entry => [entry.id, entry])), resolution: { contextPolicy: { onApproval: 'new' } } };
        assert.equal(nextStepsSnapshot({ workflow }).contextBoundary.nextPhase, phases[index].id);
        checked++;
      }
    }
  }
  assert.ok(checked > 30);
  const workflow = story();
  workflow.phases['team-future-step'] = { ...workflow.phases.implementation, id: 'team-future-step' };
  delete workflow.phases.implementation;
  workflow.phaseOrder[1] = workflow.currentPhase = 'team-future-step';
  assert.equal(nextStepsSnapshot({ workflow }).contextBoundary.nextPhase, 'team-future-step');
});

test('no boundary is repeated once it no longer applies', () => {
  assert.equal(pendingContextBoundary(story({ onApproval: 'keep' })), null, 'keep asks for nothing');
  assert.equal(pendingContextBoundary(story({ artifacts: [{ path: 'a.md' }] })), null, 'the phase has registered artifacts');
  const prepared = story(); prepared.phases.implementation.authoringBaseline = { generation: 1 };
  assert.equal(pendingContextBoundary(prepared), null, 'preparation opened the next generation');
  const rendered = story(); rendered.phases.implementation.inputContext = { generation: 1 };
  assert.equal(pendingContextBoundary(rendered), null, 'its inputs were rendered for the next generation');
  assert.equal(pendingContextBoundary(story({ previous: 'awaiting_approval' })), null, 'the earlier phase is not approved');
  assert.equal(pendingContextBoundary(story({ current: 'awaiting_approval' })), null, 'the phase is past authoring');
  assert.equal(pendingContextBoundary({ ...story(), currentPhase: 'intake' }), null, 'the first phase follows no approval');
  assert.equal(pendingContextBoundary({ ...story(), resolution: {} }), null, 'a Story without a policy keeps');
});
