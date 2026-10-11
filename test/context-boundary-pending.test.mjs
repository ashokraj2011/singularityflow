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

function story({ onApproval = 'new', previous = 'approved', current = 'in_progress', artifacts = [], phaseOverrides } = {}) {
  return {
    currentPhase: 'implementation', phaseOrder: ['intake', 'implementation', 'testing'],
    resolution: { contextPolicy: { onApproval, ...(phaseOverrides ? { phaseOverrides } : {}) } },
    phases: {
      intake: { status: previous },
      implementation: { status: current, artifacts },
      testing: { status: 'not_started' }
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
