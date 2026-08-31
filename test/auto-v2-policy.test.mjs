import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAutoPolicy, parseAutoPace, selectAutoProfile
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
