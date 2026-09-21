import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  authenticatedRunnerReadiness, AUTHENTICATED_RUNNER_PROVIDER_TYPES,
  normalizeAuthenticatedRunnerProvider
} from '../src/delivery-modes/authenticated-runner-provider.mjs';
import { buildGdpReadiness } from '../src/delivery-modes/readiness.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { commandClass } from '../apps/vscode/src/cli/client.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'singularity-flow.mjs');
const digest = (character) => `sha256:${character.repeat(64)}`;
const opaqueId = (prefix, character) => `${prefix}_${character.repeat(64)}`;

function provider(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'cab-authenticated-runner-provider',
    providerId: opaqueId('cabp', 'a'),
    providerType: 'enterprise-ci',
    integrationId: opaqueId('cabi', 'b'),
    trustRootSha256: digest('1'),
    runnerProfileSha256: digest('2'),
    sandboxPolicySha256: digest('3'),
    trustPolicySha256: digest('4'),
    resultIngestionPolicySha256: digest('5'),
    evidencePolicySha256: digest('6'),
    acceptedIssuerDigests: [digest('7')],
    acceptedAudienceDigests: [digest('8')],
    enabled: true,
    ...overrides
  };
}

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_NO_NETWORK: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'CAB R2 Foundation Tester'
    }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, ...args) { return execute('git', args, root); }
function sflow(root, ...args) { return execute(process.execPath, [cli, ...args], root); }

test('CAB-R2 defaults to unavailable and exposes no authority or accepted evidence', () => {
  assert.deepEqual(AUTHENTICATED_RUNNER_PROVIDER_TYPES, [
    'enterprise-ci', 'independent-runner-service'
  ]);
  const readiness = authenticatedRunnerReadiness();
  assert.equal(readiness.status, 'unavailable');
  assert.equal(readiness.configured, false);
  assert.equal(readiness.enabled, false);
  assert.equal(readiness.integrationAvailable, false);
  assert.equal(readiness.verifierAvailable, false);
  assert.equal(readiness.authority, 'none');
  assert.equal(readiness.gateEligible, false);
  assert.equal(readiness.consumedByLifecycle, false);
  assert.equal(readiness.enforcementAvailable, false);
  assert.equal(readiness.assuranceUpgradeAvailable, false);
  assert.equal(readiness.provider, null);
  assert.deepEqual(readiness.acceptedEvidenceFamilies, []);
  assert.ok(readiness.gaps.includes('CAB_RUNNER_PROVIDER_NOT_CONFIGURED'));
  assert.ok(readiness.gaps.includes('CAB_RUNNER_INTEGRATION_NOT_INSTALLED'));
  assert.ok(readiness.gaps.includes('CAB_RUNNER_TRUST_AUTHORITY_NOT_APPROVED'));
  assert.ok(readiness.gaps.includes('CAB_RUNNER_SANDBOX_EVIDENCE_MISSING'));
  assert.equal(readiness.checks.find((entry) => entry.id === 'provider-configuration').status, 'missing');
});

test('the closed provider descriptor accepts only IDs and digests and still grants no authority', () => {
  const normalized = normalizeAuthenticatedRunnerProvider(provider({
    acceptedIssuerDigests: [digest('b'), digest('a')]
  }));
  assert.deepEqual(normalized.acceptedIssuerDigests, [digest('a'), digest('b')]);
  assert.doesNotMatch(JSON.stringify(normalized), /token|password|credential|endpoint|command|path/i);

  const readiness = authenticatedRunnerReadiness(normalized);
  assert.equal(readiness.configured, true);
  assert.equal(readiness.enabled, true);
  assert.equal(readiness.status, 'unavailable');
  assert.equal(readiness.authority, 'none');
  assert.equal(readiness.gateEligible, false);
  assert.equal(readiness.enforcementAvailable, false);
  assert.equal(readiness.assuranceUpgradeAvailable, false);
  assert.deepEqual(readiness.acceptedEvidenceFamilies, []);
  assert.ok(!readiness.gaps.includes('CAB_RUNNER_PROVIDER_NOT_CONFIGURED'));
  assert.ok(readiness.gaps.includes('CAB_RUNNER_INTEGRATION_NOT_INSTALLED'));
  assert.equal(readiness.checks.find((entry) => entry.id === 'provider-configuration').status, 'declared');
});

test('provider validation rejects credentials, unknown providers, malformed digests, and duplicates', () => {
  assert.throws(
    () => normalizeAuthenticatedRunnerProvider({ ...provider(), token: 'secret' }),
    (error) => error.code === 'CAB_RUNNER_PROVIDER_INVALID' && /invalid field set/.test(error.message)
  );
  assert.throws(
    () => normalizeAuthenticatedRunnerProvider(provider({ providerType: 'local-process' })),
    /providerType must be one of/
  );
  assert.throws(
    () => normalizeAuthenticatedRunnerProvider(provider({ trustRootSha256: 'not-a-digest' })),
    /trustRootSha256 must be a sha256 digest/
  );
  assert.throws(
    () => normalizeAuthenticatedRunnerProvider(provider({
      acceptedIssuerDigests: [digest('7'), digest('7')]
    })),
    /acceptedIssuerDigests contains duplicates/
  );
  assert.throws(
    () => normalizeAuthenticatedRunnerProvider(provider({ schemaVersion: 2 })),
    /configuration schema is not current/
  );
  for (const invalid of [
    { providerId: 123 },
    { providerId: ['cabp_' + 'a'.repeat(64)] },
    { integrationId: ['cabi_' + 'b'.repeat(64)] },
    { trustRootSha256: [digest('1')] },
    { acceptedIssuerDigests: [[digest('7')]] },
    { providerId: 'token:supersecret' },
    { integrationId: 'password:hunter2' }
  ]) {
    assert.throws(
      () => normalizeAuthenticatedRunnerProvider(provider(invalid)),
      (error) => error.code === 'CAB_RUNNER_PROVIDER_INVALID'
    );
  }
});

test('a disabled declaration remains explicit and cannot disappear into not-configured', () => {
  const readiness = authenticatedRunnerReadiness(provider({ enabled: false }));
  assert.equal(readiness.configured, true);
  assert.equal(readiness.enabled, false);
  assert.ok(readiness.gaps.includes('CAB_RUNNER_PROVIDER_DISABLED'));
  assert.equal(readiness.checks.find((entry) => entry.id === 'provider-configuration').status, 'disabled');
});

test('GDP readiness includes CAB-R2 diagnostics without changing its hard-coded non-GA result', () => {
  const report = buildGdpReadiness({ runnerProviderConfiguration: provider() });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.status, 'not-ready');
  assert.equal(report.gaReady, false);
  assert.equal(report.authority, 'report-only');
  assert.equal(report.authenticatedRunner.configured, true);
  assert.equal(report.authenticatedRunner.status, 'unavailable');
  assert.equal(report.authenticatedRunner.authority, 'none');
  assert.ok(report.blockers.some(
    (entry) => entry.code === 'GDP_GA_AUTHENTICATED_RUNNER_INTEGRATION_UNAVAILABLE'
  ));
  assert.equal(report.supportMatrix.assuranceProfiles.find(
    (entry) => entry.id === 'high-assurance-enforce'
  ).status, 'unavailable');
  assert.ok(report.prohibitions.includes('DO_NOT_ENABLE_HIGH_ASSURANCE_ENFORCEMENT'));
});

test('CAB-R2 status is registered as a deterministic read operation', () => {
  const operation = resolveOperation({
    requestedCommand: 'delivery',
    positionals: ['delivery', 'authenticated-runner-status'],
    options: { json: true }
  });
  assert.equal(operation.id, 'delivery.authenticated-runner-status');
  assert.equal(operation.classification, 'read');
  assert.equal(operation.modelPolicy, 'never');
  assert.equal(commandClass(['delivery', 'authenticated-runner-status']), 'read');
});

test('CAB-R2 schemas freeze the configuration and fail-closed readiness surfaces', async () => {
  const providerSchema = JSON.parse(await readFile(path.join(
    repositoryRoot, 'schemas', 'cab-authenticated-runner-provider.schema.json'
  ), 'utf8'));
  const readinessSchema = JSON.parse(await readFile(path.join(
    repositoryRoot, 'schemas', 'cab-authenticated-runner-readiness.schema.json'
  ), 'utf8'));
  assert.equal(providerSchema.additionalProperties, false);
  assert.deepEqual(providerSchema.properties.providerType.enum, [
    'enterprise-ci', 'independent-runner-service'
  ]);
  assert.equal(providerSchema.$defs.providerId.pattern, '^cabp_[a-f0-9]{64}$');
  assert.equal(providerSchema.$defs.integrationId.pattern, '^cabi_[a-f0-9]{64}$');
  assert.equal(readinessSchema.properties.status.const, 'unavailable');
  assert.equal(readinessSchema.properties.authority.const, 'none');
  assert.equal(readinessSchema.properties.gateEligible.const, false);
  assert.equal(readinessSchema.properties.consumedByLifecycle.const, false);
  assert.equal(readinessSchema.properties.enforcementAvailable.const, false);
  assert.equal(readinessSchema.properties.assuranceUpgradeAvailable.const, false);
  assert.deepEqual(readinessSchema.properties.acceptedEvidenceFamilies.const, []);
  assert.equal(readinessSchema.$defs.providerId.pattern, '^cabp_[a-f0-9]{64}$');
  assert.equal(readinessSchema.$defs.integrationId.pattern, '^cabi_[a-f0-9]{64}$');
  assert.equal(readinessSchema.additionalProperties, false);
});

test('CLI doctor and GDP readiness are read-only and remain unavailable with a valid descriptor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cab-r2-foundation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'CAB R2 Tester');
  git(root, 'config', 'user.email', 'cab-r2@example.com');
  sflow(root, 'init');
  await writeFile(path.join(root, 'runner-provider.json'), `${JSON.stringify(provider(), null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize CAB R2 diagnostic fixture');
  const before = git(root, 'rev-parse', 'HEAD').stdout.trim();

  const absent = JSON.parse(sflow(
    root, 'delivery', 'authenticated-runner-status', '--json'
  ).stdout);
  assert.equal(absent.data.configured, false);
  assert.equal(absent.data.status, 'unavailable');
  assert.equal(absent.effects.stateChanged, false);

  const configured = JSON.parse(sflow(
    root, 'delivery', 'authenticated-runner-status',
    '--runner-provider-file', 'runner-provider.json', '--json'
  ).stdout);
  assert.equal(configured.data.configured, true);
  assert.equal(configured.data.status, 'unavailable');
  assert.equal(configured.data.authority, 'none');
  assert.equal(configured.data.gateEligible, false);
  assert.equal(configured.data.consumedByLifecycle, false);
  assert.equal(configured.effects.stateChanged, false);

  const readiness = JSON.parse(sflow(
    root, 'delivery', 'readiness', '--runner-provider-file', 'runner-provider.json', '--json'
  ).stdout);
  assert.equal(readiness.data.schemaVersion, 2);
  assert.equal(readiness.data.gaReady, false);
  assert.equal(readiness.data.authenticatedRunner.configured, true);
  assert.equal(readiness.data.authenticatedRunner.status, 'unavailable');
  assert.equal(readiness.effects.stateChanged, false);
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), before);
  assert.equal(git(root, 'status', '--porcelain').stdout, '');
});
