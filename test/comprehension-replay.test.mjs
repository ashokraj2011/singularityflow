import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildComprehensionReplay, CMP_REPLAY_FOCUS_TYPES
} from '../src/comprehension/replay.mjs';

function workflow() {
  return {
    workItem: { id: 'CMP-REPLAY' },
    history: [
      {
        at: '2026-09-01T00:00:01.000Z', event: 'phase_generated',
        phase: 'implementation', actor: 'private@example.test',
        detail: 'MODEL TRANSCRIPT MUST NOT APPEAR'
      },
      {
        at: '2026-09-01T00:00:02.000Z', event: 'workflow_reopened',
        phase: 'planning', actor: 'private@example.test', detail: 'private reason'
      },
      {
        at: '2026-09-01T00:00:03.000Z', event: 'documents_added',
        phase: 'planning', detail: 'private document name'
      },
      {
        at: '2026-09-01T00:00:04.000Z', event: 'not_a_closed_event',
        phase: 'planning', detail: 'unregistered text'
      }
    ],
    publicationProjections: [{
      commit: 'a'.repeat(40),
      event: {
        type: 'artifact-generated', eventId: 'EV-001', sourceCommit: 'a'.repeat(40),
        createdAt: '2026-09-01T00:00:01.000Z', phaseId: 'implementation', generation: 1,
        actor: { email: 'private@example.test' }
      }
    }]
  };
}

test('comprehension replay is deterministic, content-free, and keeps source provenance explicit', () => {
  const first = buildComprehensionReplay(workflow());
  const second = buildComprehensionReplay(structuredClone(workflow()));
  assert.deepEqual(second, first);
  assert.equal(first.kind, 'comprehension-story-replay');
  assert.equal(first.authoritative, false);
  assert.equal(first.lifecycleGate, false);
  assert.equal(first.mutatesProcess, false);
  assert.equal(first.counts.matched, 3);
  assert.equal(first.events[0].provenance, 'attested-lifecycle');
  assert.equal(first.events[0].source.commit, 'a'.repeat(40));
  assert.equal(first.events[1].transition, 'lifecycle-reopen');
  assert.equal(first.events[1].causalProvenance, 'unavailable');
  assert.equal(first.events[1].provenance, 'operational-history');
  assert.ok(first.events.every((event) => /^sha256:[a-f0-9]{64}$/.test(event.eventSha256)));
  assert.doesNotMatch(JSON.stringify(first), /private|MODEL TRANSCRIPT|document name|not_a_closed_event/);
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(CMP_REPLAY_FOCUS_TYPES, ['all', 'phase', 'kind']);
});

test('comprehension replay focuses exact phases and closed event kinds without guessing', () => {
  const phase = buildComprehensionReplay(workflow(), {
    focusType: 'phase', focusValue: 'planning'
  });
  assert.deepEqual(phase.events.map((event) => event.kind), ['story.reopened', 'documents.added']);
  const kind = buildComprehensionReplay(workflow(), {
    focusType: 'kind', focusValue: 'generation.published'
  });
  assert.equal(kind.events.length, 1);
  assert.equal(kind.events[0].source.stream, 'lifecycle');
  assert.throws(
    () => buildComprehensionReplay(workflow(), { focusType: 'kind', focusValue: 'free-text' }),
    (error) => error.code === 'CMP_REPLAY_QUERY_INVALID'
  );
  assert.throws(
    () => buildComprehensionReplay(workflow(), { focusType: 'all', focusValue: 'unexpected' }),
    (error) => error.code === 'CMP_REPLAY_QUERY_INVALID'
  );
});

test('comprehension replay has a deterministic hard event ceiling', () => {
  const source = workflow();
  source.publicationProjections = [];
  const start = Date.parse('2026-09-02T00:00:00.000Z');
  source.history = Array.from({ length: 1001 }, (_, index) => ({
    at: new Date(start + index).toISOString(),
    event: 'documents_added', phase: 'intake', detail: `private-${index}`
  }));
  const replay = buildComprehensionReplay(source);
  assert.equal(replay.counts.matched, 1001);
  assert.equal(replay.counts.returned, 1000);
  assert.equal(replay.truncated, true);
  assert.doesNotMatch(JSON.stringify(replay), /private-/);
});

test('comprehension replay fails closed on malformed normalized source references', () => {
  const source = workflow();
  source.publicationProjections[0].event.sourceCommit = 'not-a-git-object\nforged';
  assert.throws(
    () => buildComprehensionReplay(source),
    (error) => error.code === 'CMP_REPLAY_SOURCE_INVALID'
  );
});
