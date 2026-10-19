import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applicationStartCommandSha256, capabilityTree, foldCapabilityPolicy, normalizeCapabilityApplication,
  resolveCapabilityPolicy, resolveExplicitCapability, validateCapabilities
} from '../src/capabilities.mjs';

const start = (overrides = {}) => ({
  id: 'web', argv: ['npm', 'run', 'dev', '--', '--host', '127.0.0.1'], workingDirectory: 'apps/web',
  url: 'http://127.0.0.1:5173/', ready: { http: '/', timeoutMs: 90_000 }, ...overrides
});
const map = (capability, extra = {}) => ({
  version: 1,
  capabilities: { 'payments-web': { kind: 'delivery', repository: 'payments-web', ...capability }, ...extra }
});
const refused = (definition, pattern, code = 'CAPABILITY_APPLICATION_INVALID') => assert.throws(
  () => validateCapabilities(definition),
  (error) => error.code === code && pattern.test(error.message)
);

test('a delivery capability declares how its application starts and which commands are its tests', () => {
  const definition = validateCapabilities(map({
    application: {
      start: [start({ environments: ['dev', 'qa'] })],
      tests: [{ use: 'module-tests' }, { use: 'integration-tests', environments: ['dev', 'qa'] }]
    },
    policy: { localIntegrationEvidence: 'allowed' }
  }));
  const application = normalizeCapabilityApplication('payments-web', definition.capabilities['payments-web']);
  assert.deepEqual(application, {
    start: [{
      id: 'web', repository: 'payments-web', argv: ['npm', 'run', 'dev', '--', '--host', '127.0.0.1'],
      workingDirectory: 'apps/web', url: 'http://127.0.0.1:5173/', ready: { http: '/', timeoutMs: 90_000 },
      environments: ['dev', 'qa']
    }],
    tests: [{ use: 'module-tests', environments: [] }, { use: 'integration-tests', environments: ['dev', 'qa'] }]
  });
  // The confirmation identity changes with what runs and where, not with its readiness probe.
  const sha = applicationStartCommandSha256(application.start[0]);
  assert.match(sha, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(applicationStartCommandSha256({ ...application.start[0], ready: { log: 'ready', timeoutMs: 1000 } }), sha);
  assert.notEqual(applicationStartCommandSha256({ ...application.start[0], argv: ['npm', 'start'] }), sha);
  // A log readiness entry and the default timeout.
  const logReady = normalizeCapabilityApplication('payments-web', {
    kind: 'delivery', repository: 'payments-web', application: { start: [start({ ready: { log: 'ready in' } })] }
  });
  assert.deepEqual(logReady.start[0].ready, { log: 'ready in', timeoutMs: 60_000 });
});

test('start entries refuse shell strings, non-loopback URLs, both readiness kinds and loose paths', () => {
  refused(map({ application: { start: [start({ argv: 'npm run dev' })] } }), /not a shell string/u);
  refused(map({ application: { start: [start({ argv: [] })] } }), /non-empty list/u);
  refused(map({ application: { start: [start({ argv: ['npm', 'run\ndev'] })] } }), /control characters/u);
  refused(map({ application: { start: [start({ url: 'http://example.com:5173/' })] } }), /loopback host/u);
  refused(map({ application: { start: [start({ url: 'http://10.0.0.5/' })] } }), /loopback host/u);
  refused(map({ application: { start: [start({ url: 'ftp://127.0.0.1/' })] } }), /http or https/u);
  refused(map({ application: { start: [start({ url: 'http://user:pw@127.0.0.1/' })] } }), /credentials, a query or a fragment/u);
  refused(map({ application: { start: [start({ url: 'http://127.0.0.1/?debug=1' })] } }), /query/u);
  refused(map({ application: { start: [start({ ready: { http: '/', log: 'ready' } })] } }), /either http or log, never both/u);
  refused(map({ application: { start: [start({ ready: {} })] } }), /never neither/u);
  refused(map({ application: { start: [start({ ready: { http: '//evil.example/' } })] } }), /single \//u);
  refused(map({ application: { start: [start({ ready: { log: 'x'.repeat(201) } })] } }), /1 to 200 characters/u);
  refused(map({ application: { start: [start({ ready: { http: '/', timeoutMs: 999 } })] } }), /1000 to 600000/u);
  refused(map({ application: { start: [start({ ready: { http: '/', timeoutMs: 600_001 } })] } }), /1000 to 600000/u);
  refused(map({ application: { start: [start({ workingDirectory: '../elsewhere' })] } }), /without '\.\.'/u);
  refused(map({ application: { start: [start({ workingDirectory: '/abs' })] } }), /repository-relative/u);
  refused(map({ application: { start: [start({ id: 'Web' })] } }), /lower-kebab-case/u);
  refused(map({ application: { start: [start(), start()] } }), /more than once/u);
  refused(map({ application: { start: [start({ environment: 'qa' })] } }), /unsupported field\(s\): environment\. Use environments/u);
  refused(map({ application: { start: [start({ environments: ['qa', 'qa'] })] } }), /more than once/u);
  refused(map({ application: { start: [start({ environments: [] })] } }), /between 1 and 16/u);
  refused(map({ application: { start: [start({ environments: ['QA'] })] } }), /lower-kebab-case environment IDs/u);
  refused(map({ application: { tests: [{ use: 'module-tests' }, { use: 'module-tests' }] } }), /more than once/u);
  refused(map({ application: { tests: [{ run: 'npm test' }] } }), /unsupported field/u);
  refused(map({ application: { launch: [] } }), /unsupported field\(s\): launch/u);
});

test('a start entry names its repository when the capability ships from several', () => {
  refused(map({ repository: undefined, repositories: ['payments-web', 'payments-api'], application: { start: [start()] } }),
    /repository is required because this capability ships from several repositories/u);
  refused(map({ application: { start: [start({ repository: 'other' })] } }), /one of this capability's repositories/u);
  const definition = validateCapabilities(map({ repository: undefined, repositories: ['payments-web', 'payments-api'],
    application: { start: [start({ repository: 'payments-api' })] } }));
  assert.equal(normalizeCapabilityApplication('payments-web', definition.capabilities['payments-web']).start[0].repository, 'payments-api');
  refused({ version: 1, capabilities: { group: { kind: 'collection', application: { start: [] } } } }, /delivery capability/u);
});

test('local integration evidence folds parent to child and never loosens under an off parent', () => {
  assert.equal(foldCapabilityPolicy({ localIntegrationEvidence: 'allowed' }, { localIntegrationEvidence: 'off' }).localIntegrationEvidence, 'off');
  assert.equal(foldCapabilityPolicy({ localIntegrationEvidence: 'allowed' }, {}).localIntegrationEvidence, 'allowed');
  assert.equal(foldCapabilityPolicy({}, { localIntegrationEvidence: 'allowed' }).localIntegrationEvidence, 'allowed');
  assert.equal(Object.hasOwn(foldCapabilityPolicy({}, {}), 'localIntegrationEvidence'), false);
  assert.throws(() => foldCapabilityPolicy({ localIntegrationEvidence: 'off' }, { localIntegrationEvidence: 'allowed' }),
    (error) => error.code === 'CAPABILITY_POLICY_LOOSENED');
  assert.throws(() => foldCapabilityPolicy({}, { localIntegrationEvidence: 'yes' }), (error) => error.code === 'CAPABILITY_POLICY_INVALID');
  const tree = (rootPolicy, middlePolicy, leafPolicy) => ({
    version: 1,
    capabilities: {
      enterprise: { kind: 'collection', policy: rootPolicy },
      product: { kind: 'collection', parent: 'enterprise', policy: middlePolicy },
      web: { kind: 'delivery', parent: 'product', repository: 'web', policy: leafPolicy }
    }
  });
  assert.throws(() => validateCapabilities(tree({ localIntegrationEvidence: 'off' }, {}, { localIntegrationEvidence: 'allowed' })),
    (error) => error.code === 'CAPABILITY_POLICY_LOOSENED' && /'web'.*'enterprise'/u.test(error.message));
  assert.throws(() => validateCapabilities(tree({ localIntegrationEvidence: 'allowed' }, { localIntegrationEvidence: 'off' },
    { localIntegrationEvidence: 'allowed' })), (error) => error.code === 'CAPABILITY_POLICY_LOOSENED' && /'product'/u.test(error.message));
  const allowed = tree({ localIntegrationEvidence: 'allowed' }, {}, {});
  assert.equal(resolveCapabilityPolicy(validateCapabilities(allowed), 'web').policy.localIntegrationEvidence, 'allowed');
  const narrowed = tree({ localIntegrationEvidence: 'allowed' }, {}, { localIntegrationEvidence: 'off' });
  assert.equal(resolveCapabilityPolicy(validateCapabilities(narrowed), 'web').policy.localIntegrationEvidence, 'off');
  // Unset everywhere means off, and an unset policy leaves every existing policy digest unchanged.
  const pinned = (policy) => resolveExplicitCapability({
    repositoryId: 'web', repositoryIdentitySha256: `sha256:${'a'.repeat(64)}`, capabilityStateSha256: `sha256:${'b'.repeat(64)}`,
    capabilityId: 'web', policy
  }).policySha256;
  assert.equal(pinned(resolveCapabilityPolicy(validateCapabilities(tree({}, {}, {})), 'web').policy), pinned({}));
});

test('compatibility: an application block and unknown capability fields are accepted; unknown policy keys still refused', () => {
  // Older engines ignore capability fields they do not know; this engine keeps doing so for fields
  // outside the closed application and policy shapes, so a newer map stays readable here.
  const definition = validateCapabilities(map({ application: { start: [start()] }, futureField: { anything: true } }));
  assert.ok(definition.capabilities['payments-web'].application);
  const [row] = capabilityTree(definition);
  assert.equal(row.id, 'payments-web');
  assert.equal(Object.hasOwn(row, 'application'), false);
  assert.throws(() => validateCapabilities(map({ policy: { futurePolicy: true } })), /unknown key 'futurePolicy'/u);
});
