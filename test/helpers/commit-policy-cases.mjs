import * as policy from '../../src/repository-commit-policy/policy.mjs';
import * as profile from '../../src/repository-commit-policy/profile.mjs';
import * as pattern from '../../src/repository-commit-policy/pattern.mjs';

export const commitPolicyModules = { policy, profile, pattern };
export const registeredProfile = () => ({ schemaVersion: 1, adapter: 'registered-checks', platforms: ['darwin', 'win32', 'linux'],
  checks: [{ id: 'message', rule: 'message-envelope' }], coverage: [{ stage: 'repository-message', checks: ['message'] }] });
export const declaredPolicy = () => ({ schemaVersion: 1, mode: 'enforce', subjectTemplate: '{trackingKey}: {summary}',
  subjectPattern: '^[A-Z][A-Z0-9]*-[0-9]+: .+$', tracking: { required: true, allowedKinds: ['story'], bindings: { story: 'repository-story' } },
  validation: { adapter: 'registered-checks', profile: 'message-v1' }, profiles: { 'message-v1': registeredProfile() } });
const nativeProfile = () => ({ schemaVersion: 1, adapter: 'native-git', platforms: ['darwin'], checks: [],
  coverage: [{ stage: 'commit-msg', path: '@hooks/commit-msg', sha256: 'sha256:' + 'a'.repeat(64), checks: [] }],
  native: { context: 'original-worktree-private-git', gitDirectory: 'candidate-compatible' } });

function result(id, run) {
  try { return { id, value: run() }; }
  catch (error) { return { id, error: { name: error.name, constructor: error.constructor.name,
    message: error.message, code: error.code ?? null, exitCode: error.exitCode ?? null,
    details: error.details ?? null, cause: error.cause ? { name: error.cause.name, message: error.cause.message } : null } }; }
}

export function commitPolicyResults(api = policy) {
  const cases = [
    ['absent', () => undefined], ['null', () => null], ['ordinary', declaredPolicy],
    ['off', () => ({ schemaVersion: 1, mode: 'off' })], ['discover', () => ({ schemaVersion: 1, mode: 'discover' })],
    ['array', () => []], ['boolean', () => true], ['class', () => new (class Policy {})()],
    ['unknown', () => ({ ...declaredPolicy(), ignoreHooks: true })],
    ['missing-version', () => { const p = declaredPolicy(); delete p.schemaVersion; return p; }],
    ['future-version', () => ({ ...declaredPolicy(), schemaVersion: 2 })],
    ['invalid-mode', () => ({ ...declaredPolicy(), mode: 'accepted' })],
    ['inactive-extra', () => ({ schemaVersion: 1, mode: 'off', validation: {} })],
    ['missing-summary', () => ({ ...declaredPolicy(), subjectTemplate: '{trackingKey}' })],
    ['duplicate-summary', () => ({ ...declaredPolicy(), subjectTemplate: '{summary} {summary}' })],
    ['unknown-placeholder', () => ({ ...declaredPolicy(), subjectTemplate: '{invented}: {summary}' })],
    ['unsupported-pattern', () => ({ ...declaredPolicy(), subjectPattern: '^(a+)+$' })],
    ['zero-bytes', () => ({ ...declaredPolicy(), maxSubjectBytes: 0 })],
    ['large-bytes', () => ({ ...declaredPolicy(), maxSubjectBytes: 8193 })],
    ['tracking-without-placeholder', () => ({ ...declaredPolicy(), subjectTemplate: '{summary}' })],
    ['invalid-tracking-flag', () => ({ ...declaredPolicy(), tracking: { required: 'yes' } })],
    ['duplicate-kinds', () => ({ ...declaredPolicy(), tracking: { required: true, allowedKinds: ['story', 'story'] } })],
    ['branch-template', () => ({ ...declaredPolicy(), tracking: { required: true, branchTemplate: 'feature/{trackingKey}' } })],
    ['invalid-branch-template', () => ({ ...declaredPolicy(), tracking: { required: true, branchTemplate: 'feature/{summary}' } })],
    ['unknown-binding', () => ({ ...declaredPolicy(), tracking: { required: true, bindings: { story: 'invented' } } })],
    ['invalid-adapter', () => ({ ...declaredPolicy(), validation: { adapter: 'skip', profile: 'message-v1' } })],
    ['invalid-profile', () => ({ ...declaredPolicy(), profiles: { 'message-v1': {} } })],
    ['types', () => ({ ...declaredPolicy(), types: ['fix'], scopes: ['api'], defaults: { type: 'fix', scope: 'api' } })],
    ['duplicate-types', () => ({ ...declaredPolicy(), types: ['fix', 'fix'] })],
    ['body', () => ({ ...declaredPolicy(), body: { maxBytes: 400, requiredTrailers: ['Evidence'], pattern: '^.*$' } })],
    ['invalid-body', () => ({ ...declaredPolicy(), body: { maxBytes: 65537 } })],
    ['signing', () => ({ ...declaredPolicy(), signing: { required: true } })],
    ['floor-conflict', () => ({ ...declaredPolicy(), organizationFloor: { signingRequired: true } })],
    ['unknown-outgoing', () => ({ ...declaredPolicy(), outgoingRange: 'none' })],
    ['invalid-metadata-path', () => ({ ...declaredPolicy(), metadata: { paths: ['../outside'] } })],
    ['incomplete-metadata-scope', () => ({ ...declaredPolicy(), metadata: { mode: 'scoped-profile' } })],
    ['native-profile', () => ({ ...declaredPolicy(), validation: { adapter: 'native-git', profile: 'native-v1' }, profiles: { 'native-v1': nativeProfile() } })]
  ];
  return cases.map(([id, make]) => result(id, () => {
    const value = api.normalizeCommitPolicy(make());
    return { value, sha256: api.rcpDigest(value) };
  }));
}

export function commitProfileResults(api = profile) {
  const cases = [
    ['registered', registeredProfile, 'registered-checks'], ['native', nativeProfile, 'native-git'],
    ['mismatched', registeredProfile, 'native-git'], ['missing-version', () => ({ ...registeredProfile(), schemaVersion: undefined }), 'registered-checks'],
    ['future-version', () => ({ ...registeredProfile(), schemaVersion: 2 }), 'registered-checks'],
    ['no-platforms', () => ({ ...registeredProfile(), platforms: [] }), 'registered-checks'],
    ['unknown-platform', () => ({ ...registeredProfile(), platforms: ['other'] }), 'registered-checks'],
    ['unknown-check', () => ({ ...registeredProfile(), checks: [{ id: 'm', rule: 'unknown' }] }), 'registered-checks'],
    ['duplicate-check', () => ({ ...registeredProfile(), checks: Array(2).fill({ id: 'm', rule: 'message-envelope' }) }), 'registered-checks'],
    ['invalid-path', () => ({ ...registeredProfile(), inputs: [{ path: '../file', sha256: 'sha256:' + 'a'.repeat(64) }] }), 'registered-checks'],
    ['unbound-input', () => ({ ...registeredProfile(), inputs: [{ path: 'settings.json', sha256: 'bad' }] }), 'registered-checks'],
    ['unknown-stage', () => ({ ...registeredProfile(), coverage: [{ stage: 'invented', checks: ['message'] }] }), 'registered-checks'],
    ['unbound-hook', () => ({ ...registeredProfile(), coverage: [{ stage: 'commit-msg', path: 'hook', checks: ['message'] }] }), 'registered-checks'],
    ['unknown-coverage-check', () => ({ ...registeredProfile(), coverage: [{ stage: 'commit-msg', checks: ['missing'] }] }), 'registered-checks'],
    ['empty-required-checks', () => ({ ...registeredProfile(), coverage: [{ stage: 'commit-msg', checks: [] }] }), 'registered-checks'],
    ['normalization', () => ({ ...registeredProfile(), normalization: { steps: [{ rule: 'ensure-final-newline', paths: ['src/file.js'] }] } }), 'registered-checks'],
    ['invalid-normalization', () => ({ ...registeredProfile(), normalization: { maximumChangedAttempts: 11, steps: [] } }), 'registered-checks'],
    ['unsupported-normalizer', () => ({ ...registeredProfile(), normalization: { steps: [{ rule: 'invented', paths: ['file'] }] } }), 'registered-checks'],
    ['native-claim', () => ({ ...registeredProfile(), native: {} }), 'registered-checks'],
    ['wrong-native-context', () => ({ ...nativeProfile(), native: { context: 'other' } }), 'native-git'],
    ['native-limits', () => ({ ...nativeProfile(), native: { ...nativeProfile().native, timeoutMs: 600001 } }), 'native-git'],
    ['native-transform', () => ({ ...nativeProfile(), native: { ...nativeProfile().native, messageTransform: { producer: 'commit-msg', placement: 'subject-suffix', delimiter: ' ', prefix: 'timestamp=', encoding: 'unix-seconds', maximumClockSkewSeconds: 10 } } }), 'native-git']
  ];
  const results = cases.map(([id, make, adapter]) => result(id, () => api.normalizeCommitProfile(make(), adapter)));
  for (const value of ['src/file.js', '', '/outside', '../outside', '.git/config', 'a\\b', 'a\0b', 'src//file', 'con.js'])
    results.push(result('path-' + results.length, () => api.policyPath(value)));
  return results;
}

export function commitPatternResults(api = pattern) {
  const cases = ['^[A-Z]{3,7}-[0-9]{1,7}$', '^ab?c*$', '^ab+c$', '^.*$', '^\\w+\\s\\d+$', '^[^x]+$', '^a{0,3}$',
    '(a+)+', '^(a+)+$', '^a|b$', '^a{129}$', '^\\1$', 'a$', '^a', '^a{3,2}$', '^[z-a]$', '^[]$', null, 123];
  const inputs = ['', 'WEB-221', 'WEB-221 extra', 'WEB-12345678', 'xWEB-221', 'accc', 'abbc', 'abc', 'text 1', 'x', 'yyy', null, 123];
  return cases.map((source, index) => result(String(index), () => {
    const match = api.compileCommitPattern(source);
    return inputs.map(value => match(value));
  }));
}

export function commitMessageResults(api = policy) {
  const results = [];
  for (const [id, draft, context, overrides = {}] of [
    ['ordinary', 'Add endpoint\n\nEvidence: ready', { trackingKey: 'WEB-221' }],
    ['retained', 'WEB-221: Add endpoint', { trackingKey: 'WEB-221' }],
    ['other-story', 'WEB-222: Add endpoint', { trackingKey: 'WEB-221' }],
    ['missing-key', 'Change', {}], ['injected-key', 'Change', { trackingKey: 'WEB-221\nOther: value' }],
    ['invalid-message', 'x\0y', { trackingKey: 'WEB-221' }],
    ['utf8-overflow', 'ééé', { trackingKey: 'WEB-221' }, { maxSubjectBytes: 12 }],
    ['required-trailer', 'Change', { trackingKey: 'WEB-221' }, { body: { requiredTrailers: ['Evidence'] } }],
    ['duplicate-trailer', 'Change\n\nEvidence: one\nEvidence: two', { trackingKey: 'WEB-221' }, { body: { requiredTrailers: ['Evidence'] } }],
    ['types', 'Change', { trackingKey: 'WEB-221' }, { types: ['fix'] }],
    ['bad-draft-type', {}, { trackingKey: 'WEB-221' }]
  ]) results.push(result(id, () => api.renderCommitMessage(api.normalizeCommitPolicy({ ...declaredPolicy(), ...overrides }), draft, context)));
  for (const value of [null, {}, [], { b: 2, a: 1 }, ['é', '🧭'], new Date(0), undefined, Symbol('input'), () => true])
    results.push(result('digest-' + results.length, () => api.rcpDigest(value)));
  return results;
}
