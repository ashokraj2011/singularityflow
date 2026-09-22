import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import {
  effectiveEnvironmentQualityCommandCatalog, environmentQualityCommandBlock
} from '../src/state.mjs';
import {
  parseEnvironmentDeclaration, validateEnvironmentQualityCommandCatalog
} from '../src/environment-declaration.mjs';

const sourceIdentity = {
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  sourceTreeSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  startedAt: '2026-09-22T00:00:00.000Z'
};

test('a bound quality environment remains blocked until an approved isolated runner owns materialization', async () => {
  let resolverCalls = 0;
  const privateValue = 'super-secret-runtime-value';
  const policy = normalizeExternalCommand({
    id: 'browser-tests',
    kind: 'test',
    argv: ['npm', 'run', 'browser-tests'],
    modelPolicy: 'never',
    environment: 'qa-shared'
  });
  const check = await environmentQualityCommandBlock('/not-used', policy, {
    ...sourceIdentity,
    resolver: async (_root, environment, options) => {
      resolverCalls += 1;
      assert.equal(environment, 'qa-shared');
      assert.deepEqual(options, { commandId: 'browser-tests' });
      return {
        status: 'bound',
        environment: {
          name: 'qa-shared',
          declarationSha256: `sha256:${'a'.repeat(64)}`,
          fingerprintSha256: `sha256:${'b'.repeat(64)}`,
          boundNames: ['API_TOKEN'],
          endpointsSha256: `sha256:${'c'.repeat(64)}`,
          secretsPresent: ['API_TOKEN'],
          source: 'private-binding+declaration-defaults',
          bindingRevision: 'envb_00000000-0000-4000-8000-000000000001'
        },
        // The execution boundary must ignore this private resolver field completely.
        processEnvironment: { API_TOKEN: privateValue }
      };
    }
  });

  assert.equal(resolverCalls, 1);
  assert.equal(check.status, 'blocked');
  assert.equal(check.requirement, 'required');
  assert.equal(check.errorCode, 'ENVIRONMENT_ISOLATED_RUNNER_REQUIRED');
  assert.deepEqual(check.environment, {
    name: 'qa-shared',
    declarationSha256: `sha256:${'a'.repeat(64)}`,
    boundNames: ['API_TOKEN'],
    endpointsSha256: `sha256:${'c'.repeat(64)}`,
    secretsPresent: ['API_TOKEN'],
    source: 'private-binding+declaration-defaults',
    bindingRevision: 'envb_00000000-0000-4000-8000-000000000001',
    fingerprintSha256: `sha256:${'b'.repeat(64)}`
  });
  assert.match(check.stderr, /approved isolated runner/);
  const durable = JSON.stringify(check);
  const privateDigest = createHash('sha256').update(privateValue).digest('hex');
  assert.match(durable, /API_TOKEN/);
  assert.doesNotMatch(durable, new RegExp(`${privateValue}|${privateDigest}|processEnvironment`));
  assert.match(check.environment.endpointsSha256, /^sha256:[a-f0-9]{64}$/);
});

test('an unavailable environment creates a required blocked check without relaying resolver diagnostics', async () => {
  const policy = normalizeExternalCommand({
    id: 'integration-tests',
    argv: ['npm', 'test'],
    modelPolicy: 'never',
    requirement: 'advisory',
    environment: 'integration'
  });
  const check = await environmentQualityCommandBlock('/not-used', policy, {
    ...sourceIdentity,
    resolver: async () => {
      throw new Error('provider response accidentally included secret=do-not-relay');
    }
  });

  assert.equal(check.status, 'blocked');
  assert.equal(check.requirement, 'required');
  assert.equal(check.errorCode, 'ENVIRONMENT_BINDING_UNAVAILABLE');
  assert.deepEqual(check.environment, {
    name: 'integration', declarationSha256: null, boundNames: [], endpointsSha256: null,
    secretsPresent: [], source: 'none', bindingRevision: null, fingerprintSha256: null
  });
  assert.doesNotMatch(JSON.stringify(check), /do-not-relay|provider response/);
});

test('ordinary quality commands continue when no declaration check mapping exists', async () => {
  const policy = normalizeExternalCommand({
    id: 'unit-tests', argv: ['npm', 'test'], modelPolicy: 'never'
  });
  const result = await environmentQualityCommandBlock('/not-used', policy, {
    ...sourceIdentity,
    resolver: async () => ({ status: 'unbound', environment: null, missing: [] })
  });
  assert.equal(result, null);
});

test('quality command environment identifiers are normalized before durable use', () => {
  const policy = normalizeExternalCommand({
    id: 'browser-tests', argv: ['npm', 'test'], modelPolicy: 'never', environment: '  qa-shared  '
  });
  assert.equal(policy.environment, 'qa-shared');
});

test('a declaration resolution failure blocks an otherwise unmapped command without leaking diagnostics', async () => {
  const policy = normalizeExternalCommand({
    id: 'unit-tests', argv: ['npm', 'test'], modelPolicy: 'never'
  });
  const check = await environmentQualityCommandBlock('/not-used', policy, {
    ...sourceIdentity,
    resolver: async () => {
      throw new Error('invalid declaration included secret=do-not-relay');
    }
  });
  assert.equal(check.status, 'blocked');
  assert.equal(check.errorCode, 'ENVIRONMENT_BINDING_UNAVAILABLE');
  assert.equal(check.environment, null);
  assert.match(check.stderr, /could not be resolved safely/);
  assert.doesNotMatch(JSON.stringify(check), /do-not-relay|invalid declaration/);
});

test('a declaration check mapping applies an environment without duplicating it on the command', async () => {
  const policy = normalizeExternalCommand({
    id: 'mapped-tests', argv: ['npm', 'test'], modelPolicy: 'never'
  });
  const check = await environmentQualityCommandBlock('/not-used', policy, {
    ...sourceIdentity,
    resolver: async (root, environment, options) => {
      assert.equal(root, '/not-used');
      assert.equal(environment, null);
      assert.deepEqual(options, { commandId: 'mapped-tests' });
      return {
        status: 'unbound', missing: ['API_TOKEN'],
        environment: {
          name: 'qa', declarationSha256: `sha256:${'d'.repeat(64)}`,
          boundNames: [], endpointsSha256: null, secretsPresent: [],
          source: 'none', bindingRevision: null, fingerprintSha256: `sha256:${'e'.repeat(64)}`
        }
      };
    }
  });
  assert.equal(check.status, 'blocked');
  assert.equal(check.environment.name, 'qa');
  assert.equal(check.errorCode, 'ENVIRONMENT_BINDING_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(check), /API_TOKEN/);
});

test('a declaration mapping cannot turn a shell command into an environment-bound execution', async () => {
  const policy = normalizeExternalCommand({
    id: 'mapped-shell', command: 'npm test', modelPolicy: 'never'
  });
  const check = await environmentQualityCommandBlock('/not-used', policy, {
    ...sourceIdentity,
    resolver: async () => ({
      status: 'bound', missing: [],
      environment: {
        name: 'qa', declarationSha256: `sha256:${'a'.repeat(64)}`,
        boundNames: ['TOKEN'], endpointsSha256: null, secretsPresent: ['TOKEN'],
        source: 'private-binding', bindingRevision: 'envb_00000000-0000-4000-8000-000000000001',
        fingerprintSha256: `sha256:${'f'.repeat(64)}`
      },
      processEnvironment: { TOKEN: 'never-use-this' }
    })
  });
  assert.equal(check.status, 'blocked');
  assert.equal(check.errorCode, 'ENVIRONMENT_ARGV_REQUIRED');
  assert.match(check.stderr, /exact argv declaration/);
  assert.doesNotMatch(JSON.stringify(check), /never-use-this/);
});

test('runtime environment validation uses inferred current commands plus every other pinned phase', () => {
  const declaration = parseEnvironmentDeclaration(Buffer.from(`schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_TOKEN
        kind: secret
    localFiles: []
checks:
  shared-tests:
    environment: qa
neverCommit: []
`));
  const phase = {
    id: 'implementation',
    qualityCommands: [{ id: 'shared-tests', argv: ['npm', 'test'], modelPolicy: 'never' }]
  };
  const workflow = { resolution: { phases: [
    phase,
    {
      id: 'verification',
      qualityCommands: [{ id: 'shared-tests', argv: ['npm', 'run', 'verify'], modelPolicy: 'never' }]
    }
  ] } };
  const inferred = [{
    id: 'shared-tests', kind: 'test', argv: ['npm', 'run', 'inferred-tests'],
    modelPolicy: 'never'
  }];
  const catalog = effectiveEnvironmentQualityCommandCatalog(phase, workflow, inferred);
  assert.deepEqual(catalog.map((entry) => entry.argv), [
    ['npm', 'run', 'verify'], ['npm', 'run', 'inferred-tests']
  ]);
  assert.throws(
    () => validateEnvironmentQualityCommandCatalog(declaration, catalog),
    /ambiguous quality command ID.*shared-tests/i
  );

  // The accepted current-phase definition is replaced by its effective inferred command instead
  // of being compared as a stale duplicate of itself.
  const currentOnly = effectiveEnvironmentQualityCommandCatalog(phase, {
    resolution: { phases: [phase] }
  }, inferred);
  assert.doesNotThrow(() => validateEnvironmentQualityCommandCatalog(declaration, currentOnly));
});
