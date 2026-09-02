import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAutoPolicy, parseAutoPace, parseAutoStopSelector, selectAutoProfile
} from '../src/auto/auto-policy.mjs';

test('Story is the dependency-free default Auto profile', () => {
  const policy = normalizeAutoPolicy({ enabled: true });
  assert.deepEqual(policy.profile, { default: 'story', allowed: ['story'] });
  assert.deepEqual(selectAutoProfile(policy), {
    requested: 'story', resolved: 'story', selectionReason: 'explicit'
  });
  assert.deepEqual(selectAutoProfile(policy, 'auto-select'), {
    requested: 'auto-select', resolved: 'story', selectionReason: 'core-fallback'
  });
});

test('an unavailable SGOS profile never blocks ordinary Story Auto', () => {
  const policy = normalizeAutoPolicy({
    enabled: true, profile: { default: 'story', allowed: ['story', 'sgos'] }
  });
  assert.equal(selectAutoProfile(policy, 'story').resolved, 'story');
  assert.throws(
    () => selectAutoProfile(policy, 'sgos'),
    (error) => error.code === 'AUTO_PROFILE_UNAVAILABLE' && error.details.fallback === 'story'
  );
});

test('step is a real bounded pacing mode', () => {
  assert.deepEqual(parseAutoPace('step'), { mode: 'step', intervalMs: null, source: 'step' });
});

test('a bare phase endpoint is normalized only against the selected Story rail', () => {
  assert.deepEqual(parseAutoStopSelector('verification', [
    'specification', 'implementation', 'verification'
  ]), {
    kind: 'phase-complete', phase: 'verification', source: 'verification'
  });
  assert.throws(
    () => parseAutoStopSelector('not-a-phase', ['implementation']),
    (error) => error.code === 'AUTO_PLAN_INVALID'
      && /Use a phase name \(implementation\)/.test(error.message)
  );
});

test('machine-actionable repair is bounded to exactly one attempt and adequate ceilings', () => {
  assert.deepEqual(normalizeAutoPolicy({
    enabled: true,
    repair: { policy: 'auto-on-machine-actionable', maximumAttempts: 1 }
  }).repair, { policy: 'auto-on-machine-actionable', maximumAttempts: 1 });
  assert.throws(() => normalizeAutoPolicy({
    enabled: true,
    repair: { policy: 'auto-on-machine-actionable', maximumAttempts: 0 }
  }), (error) => error.code === 'AUTO_PLAN_INVALID' && /exactly one/.test(error.message));
  assert.throws(() => normalizeAutoPolicy({
    enabled: true,
    repair: { policy: 'auto-on-machine-actionable', maximumAttempts: 1 },
    ceilings: { maximumAuthoringAttemptsPerPhase: 1 }
  }), (error) => error.code === 'AUTO_PLAN_INVALID' && /one initial and one repair/.test(error.message));
  assert.deepEqual(
    normalizeAutoPolicy({ enabled: true, repair: { policy: 'ask', maximumAttempts: 1 } }).repair,
    { policy: 'ask', maximumAttempts: 1 }
  );
});
