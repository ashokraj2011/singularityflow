import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCommitPattern } from '../src/repository-commit-policy/pattern.mjs';
import { normalizeCommitPolicy, renderCommitMessage, validateCommitMessage } from '../src/repository-commit-policy/policy.mjs';

function policy(overrides = {}) {
  return normalizeCommitPolicy({ schemaVersion: 1, mode: 'enforce', subjectTemplate: '{trackingKey}: {summary}',
    subjectPattern: '^[A-Z][A-Z0-9]*-[0-9]+: .+$', maxSubjectBytes: 120,
    tracking: { required: true, allowedKinds: ['story'], bindings: { story: 'repository-story' } },
    validation: { adapter: 'registered-checks', profile: 'message-v1' }, ...overrides });
}
test('RCP patterns match full strings without regex backtracking or unsupported grammar', () => {
  const match = compileCommitPattern('^[A-Z]{3,7}-[0-9]{1,7}$');
  assert.equal(match('WEB-221'), true); assert.equal(match('WEB-221 extra'), false);
  assert.equal(match('WEB-12345678'), false); assert.equal(match('xWEB-221'), false);
  assert.equal(compileCommitPattern('^ab?c*$')('accc'), true);
  assert.equal(compileCommitPattern('^ab+c$')('abbc'), true);
  assert.equal(compileCommitPattern('^ab+c$')('ac'), false);
  for (const pattern of ['(a+)+', '^(a+)+$', '^a|b$', '^a{129}$', '^\\1$', 'a$', '^a']) assert.throws(() => compileCommitPattern(pattern), { code: 'RCP_PATTERN_UNSUPPORTED' });
  assert.equal(compileCommitPattern('^[a-z]*a[a-z]*b$')(`${'a'.repeat(8000)}c`), false);
});
test('different destinations render their own exact tracking key and preserve complete SFlow trailers', () => {
  const body = '\n\nSingularity-Flow-Transaction: transaction-1\nSingularity-Flow-Event-SHA256: digest';
  assert.equal(renderCommitMessage(policy(), `Add endpoint${body}`, { trackingKey: 'WEB-221' }), `WEB-221: Add endpoint${body}`);
  assert.equal(renderCommitMessage(policy({ subjectTemplate: '[{trackingKey}] {summary}', subjectPattern: '^\\[[A-Z]+-[0-9]+\\] .+$' }), 'Add endpoint', { trackingKey: 'API-814' }), '[API-814] Add endpoint');
});
test('an existing matching header is retained once; another Story key cannot be borrowed', () => {
  assert.equal(renderCommitMessage(policy(), 'WEB-221: Add endpoint', { trackingKey: 'WEB-221' }), 'WEB-221: Add endpoint');
  assert.throws(() => renderCommitMessage(policy(), 'WEB-222: Add endpoint', { trackingKey: 'WEB-221' }), { code: 'RCP_TRACKING_KEY_MISMATCH' });
});
test('team example is rendered without inventing a timestamp, type list or scope', () => {
  const p = policy({ subjectTemplate: '{type}({scope}): {trackingKey} {summary}', subjectPattern: '^[a-z]+\\([a-z]+\\): [A-Z]+-[0-9]+ .+$', types: ['fix'], scopes: ['watchlist'] });
  assert.equal(renderCommitMessage(p, 'correct balance rounding issue', { type: 'fix', scope: 'watchlist', trackingKey: 'BRBRP-7241' }), 'fix(watchlist): BRBRP-7241 correct balance rounding issue');
  assert.throws(() => renderCommitMessage(p, 'correct balance', { trackingKey: 'BRBRP-7241' }), { code: 'RCP_MESSAGE_REJECTED' });
});
test('subject injection, missing fields, UTF-8 limits and incompatible full-message trailers refuse', () => {
  assert.throws(() => renderCommitMessage(policy(), 'Change', {}), { code: 'RCP_TRACKING_KEY_REQUIRED' });
  assert.throws(() => renderCommitMessage(policy(), 'Change', { trackingKey: 'WEB-221\nOther: value' }), { code: 'RCP_TRACKING_KEY_REQUIRED' });
  assert.throws(() => renderCommitMessage(policy(), 'x\0y', { trackingKey: 'WEB-221' }), { code: 'RCP_MESSAGE_REJECTED' });
  assert.throws(() => renderCommitMessage(policy({ maxSubjectBytes: 12 }), 'ééé', { trackingKey: 'WEB-221' }), { code: 'RCP_MESSAGE_REJECTED' });
  const p = policy({ body: { requiredTrailers: ['Singularity-Flow-Transaction'] } });
  assert.throws(() => renderCommitMessage(p, 'Change', { trackingKey: 'WEB-221' }), { code: 'RCP_MESSAGE_REJECTED' });
  assert.throws(() => validateCommitMessage(p, 'WEB-221: Change\n\nSingularity-Flow-Transaction: 1\nSingularity-Flow-Transaction: 2'), { code: 'RCP_MESSAGE_REJECTED' });
});
test('unsupported authority fields, conflicting floors and unknown schemas cannot activate', () => {
  assert.throws(() => policy({ ignoreHooks: true }), { code: 'RCP_POLICY_INVALID' });
  assert.throws(() => policy({ schemaVersion: 20 }), { code: 'SCHEMA_VERSION_FUTURE' });
  assert.throws(() => policy({ organizationFloor: { signingRequired: true } }), { code: 'RCP_POLICY_CONFLICT' });
  assert.throws(() => policy({ subjectTemplate: '{modelGuess}: {summary}' }), { code: 'RCP_POLICY_INVALID' });
});
