import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorldModelAvailabilityError } from '../src/world-model-availability.mjs';

test('World-Model availability classification never overrides a typed integrity error', () => {
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('missing'), {
    code: 'ENOENT'
  })), true);
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('wrapped transport'), {
    cause: Object.assign(new Error('missing'), { code: 'ENOENT' })
  })), true);
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('invalid pinned core'), {
    code: 'WMB_PINNED_CORE_INVALID',
    cause: Object.assign(new Error('missing'), { code: 'ENOENT' })
  })), false);
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('ambiguous authority'), {
    code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
    details: { classification: 'ambiguous-remote' }
  })), false);
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('office authentication'), {
    code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
    details: { classification: 'authentication-required' }
  })), true);
  for (const classification of [
    'credential-helper-unavailable', 'git-unavailable', 'sso-authorization-required',
    'working-directory-unavailable'
  ]) {
    assert.equal(isWorldModelAvailabilityError(Object.assign(new Error(classification), {
      code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED', details: { classification }
    })), true, `${classification} is optional remote-context unavailability, not integrity failure`);
  }
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('tracking ref race'), {
    code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
    details: { classification: 'tracking-ref-raced' }
  })), false);
});

