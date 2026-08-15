import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDeveloperHomeChoices, validateDeveloperHomeHandle } from '../src/developer-home.mjs';

const actor = { name: 'Developer', email: 'developer@example.test' };
const now = '2026-08-15T10:00:00.000Z';

function choices(count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    id: `choice-${index}`,
    operation: index ? 'work.continue' : 'recover.publication',
    goalId: index ? 'continue-governed-work' : 'recover-publication',
    target: { workId: `WORK-${index}` },
    label: `Choice ${index}`,
    detail: 'Deterministic action',
    fallbackCommand: `singularity-flow story return WORK-${index}`,
    navigationTarget: 'lifecycle'
  }));
}

test('developer home returns at most six opaque revision-bound choices', () => {
  const bound = bindDeveloperHomeChoices(choices(), {
    subjectRevision: 'revision-a', actor, hostSession: 'host-a', now
  });
  assert.equal(bound.length, 6);
  assert.match(bound[0].handle, /^sfh_[a-f0-9]{32}$/);
  assert.equal(bound[0].subjectRevision, 'revision-a');
  assert.equal(bound[0].actor, actor.email);
  assert.equal(bound[0].hostSession, 'host-a');
  assert.equal(bound[0].expiresAt, '2026-08-15T10:15:00.000Z');
  assert.equal(validateDeveloperHomeHandle(bound[0], {
    subjectRevision: 'revision-a', actor, hostSession: 'host-a', now: '2026-08-15T10:14:59.999Z'
  }), true);
});

test('developer home refuses stale, expired, cross-actor, and cross-host handles', () => {
  const [choice] = bindDeveloperHomeChoices(choices(1), {
    subjectRevision: 'revision-a', actor, hostSession: 'host-a', now
  });
  assert.equal(validateDeveloperHomeHandle(choice, {
    subjectRevision: 'revision-b', actor, hostSession: 'host-a', now
  }), false);
  assert.equal(validateDeveloperHomeHandle(choice, {
    subjectRevision: 'revision-a', actor: { email: 'other@example.test' }, hostSession: 'host-a', now
  }), false);
  assert.equal(validateDeveloperHomeHandle(choice, {
    subjectRevision: 'revision-a', actor, hostSession: 'host-b', now
  }), false);
  assert.equal(validateDeveloperHomeHandle(choice, {
    subjectRevision: 'revision-a', actor, hostSession: 'host-a', now: '2026-08-15T10:15:00.000Z'
  }), false);
});
