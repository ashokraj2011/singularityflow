import test from 'node:test';
import assert from 'node:assert/strict';

import { compositeHomeEnvelope } from '../src/commands/home.mjs';
import { homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';

function home() {
  const active = {
    kind: 'initiative', id: 'SHARED-1', title: 'Typed work', phase: 'plan', group: 'active',
    blockers: [], nextAction: { operation: 'work.continue', reasonCode: 'work.resume-phase' }, rail: []
  };
  return homeOverviewResult({
    workspace: { id: 'workspace-1', name: 'Workspace One' },
    records: { items: [active], groups: { active: [active] } },
    current: { workId: active.id, workKind: active.kind, repositoryScoped: true }
  });
}

test('a conversational Home answer preserves orientation and one typed selection', () => {
  const homeEnvelope = home();
  const answer = {
    ...homeEnvelope,
    operation: { id: 'work.readiness', classification: 'read' },
    data: { ready: false },
    next: [homeEnvelope.next[0]]
  };
  const composite = compositeHomeEnvelope(homeEnvelope, answer, { route: { operationId: 'work.readiness' } });

  assert.equal(composite.operation.id, 'work.readiness');
  assert.equal(composite.data.home.activeWork.id, 'SHARED-1');
  assert.deepEqual(composite.data.answer, { ready: false });
  assert.deepEqual(composite.data.selectedSubject, { kind: 'initiative', id: 'SHARED-1' });
  assert.equal(composite.next.length, 1, 'the routed answer is the only top-level action set');
});

test('a routed subject miss is disclosed as stale without discarding Home', () => {
  const homeEnvelope = home();
  const refusal = {
    ...homeEnvelope,
    kind: 'refusal',
    operation: { id: 'work.continue', classification: 'read' },
    why: [{ code: 'work.not-in-this-repository' }],
    data: { reason: 'missing' },
    next: []
  };
  const composite = compositeHomeEnvelope(homeEnvelope, refusal, null);
  assert.equal(composite.data.selectionStale.code, 'HOME_SELECTION_STALE');
  assert.equal(composite.data.home.activeWork.id, 'SHARED-1');
  assert.deepEqual(composite.data.selectedSubject, { kind: 'initiative', id: 'SHARED-1' });
});
