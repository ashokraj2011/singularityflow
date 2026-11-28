/**
 * A conversation that did not see an approval owes no chat reset: every Story keeps its chat between steps (owner,
 * 2026-11-28, reversing the 11-19 decision to keep /clear). Each step's prompt is composed fresh by SFlow from the Story's
 * records, so going on depends on nothing said earlier; the boundary machinery stays for a policy that still asks one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pendingContextBoundary } from '../src/context-policy.mjs';
import { stepChatCommand } from '../src/step-decision.mjs';
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

test('no Story owes a chat reset between its steps, whatever its workflow pinned (owner, 2026-11-28)', () => {
  // Every Story carries on like a task: its steps run one after another in one chat, each prompt composed fresh by SFlow.
  for (const options of [{}, { onApproval: 'compact' }, { onApproval: 'keep', phaseOverrides: { intake: 'new' } }]) {
    assert.equal(pendingContextBoundary(story(options)), null, JSON.stringify(options));
    assert.equal(pendingContextBoundary(story(options), stepChatCommand), null, JSON.stringify(options));
  }
});

test('approval, nextsteps and phase continuation agree before authoring: no reset, the step\'s own command first', () => {
  for (const onApproval of ['new', 'compact']) {
    const workflow = story({ onApproval });
    const snapshot = nextStepsSnapshot({ workflow });
    assert.equal(snapshot.contextBoundary, undefined);
    const own = snapshot.actions.find(entry => entry.timing === 'now');
    assert.equal(own.copilotCommand, '/sf-phase');
    assert.equal(own.copilotTiming, undefined, 'nothing comes before the step\'s own action');
    assert.equal(agentNextSteps(snapshot).contextBoundary, undefined);
    assert.doesNotMatch(nextStepsText(snapshot), /\/clear|\/compact/u);
    const continuation = phaseContinuation(workflow);
    assert.equal(continuation.contextBoundary ?? null, null);
    assert.ok(phaseContinuationLines(continuation).join('\n').includes('singularity-flow prepare'), 'an actionable authoring command');
    const approved = approvalAgentResult({ operation: { id: 'approve' }, data: { contextBoundary: pendingContextBoundary(workflow, stepChatCommand) } });
    assert.equal(approved.contextBoundary, undefined);
    assert.ok(snapshot.actions.some(entry => entry.timing === 'now' && entry.argv[0] === 'prepare'));
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

test('all seeded, copied and future-named steps go on in the same chat', () => {
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
        assert.equal(nextStepsSnapshot({ workflow }).contextBoundary, undefined);
        checked++;
      }
    }
  }
  assert.ok(checked > 30);
  const workflow = story();
  workflow.phases['team-future-step'] = { ...workflow.phases.implementation, id: 'team-future-step' };
  delete workflow.phases.implementation;
  workflow.phaseOrder[1] = workflow.currentPhase = 'team-future-step';
  assert.equal(nextStepsSnapshot({ workflow }).contextBoundary, undefined);
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
