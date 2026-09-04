import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildGdpReadiness } from '../src/delivery-modes/readiness.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'singularity-flow.mjs');
const digest = (character) => `sha256:${character.repeat(64)}`;

function provider() {
  return {
    schemaVersion: 1, kind: 'gdp-provenance-provider', providerId: 'office-ci',
    providerType: 'enterprise-ci', trustRootSha256: digest('1'),
    verifierId: 'detached-signature-v1', acceptedIssuerDigests: [digest('2')],
    acceptedAudienceDigests: [digest('3')], enabled: true
  };
}
function execute(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_NETWORK: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'GDP M11 Tester'
    }
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result;
}
function git(root, ...args) { return execute('git', args, root); }
function sflow(root, ...args) { return execute(process.execPath, [cli, ...args], root); }

test('M11 readiness reports implemented scope without converting partial work into GA', () => {
  const report = buildGdpReadiness({ platform: 'darwin', architecture: 'arm64', nodeVersion: 'v22.1.0' });
  assert.equal(report.status, 'not-ready');
  assert.equal(report.gaReady, false);
  assert.equal(report.authority, 'report-only');
  assert.equal(report.implementation.length, 12);
  assert.deepEqual(report.implementation.slice(0, 9).map((entry) => entry.status), Array(9).fill('implemented'));
  assert.deepEqual(report.implementation.slice(9).map((entry) => entry.status), Array(3).fill('partial'));
  assert.equal(report.supportMatrix.assuranceProfiles.find(
    (entry) => entry.id === 'high-assurance-enforce'
  ).status, 'unavailable');
  assert.ok(report.blockers.length >= 7);
  assert.ok(report.prohibitions.includes('DO_NOT_CLAIM_GA_FROM_LOCAL_TESTS'));
  assert.equal(report.observedRuntime.assurance, 'runtime-label-only-not-a-platform-receipt');
});

test('M11 remains not-ready when a descriptor exists but its verifier and pilots do not', () => {
  const report = buildGdpReadiness({ providerConfiguration: provider() });
  assert.equal(report.gaReady, false);
  assert.equal(report.provenance.configured, true);
  assert.equal(report.provenance.verifierAvailable, false);
  assert.ok(report.blockers.some((entry) => entry.code === 'GDP_GA_PROVENANCE_VERIFIER_UNAVAILABLE'));
  assert.ok(report.blockers.some((entry) => entry.code === 'GDP_GA_PROVIDER_PILOTS_MISSING'));
  assert.ok(report.blockers.some((entry) => entry.code === 'GDP_GA_OBSERVATION_WINDOW_INCOMPLETE'));
});

test('M11 readiness schema hard-codes the non-GA result', async () => {
  const schema = JSON.parse(await readFile(path.join(
    repositoryRoot, 'schemas', 'gdp-readiness-report.schema.json'
  ), 'utf8'));
  assert.equal(schema.properties.status.const, 'not-ready');
  assert.equal(schema.properties.gaReady.const, false);
  assert.equal(schema.properties.authority.const, 'report-only');
  assert.equal(schema.additionalProperties, false);
});

test('M11 CLI is read-only and reports the exact external blockers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m11-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GDP M11 Tester');
  git(root, 'config', 'user.email', 'gdp-m11@example.com');
  sflow(root, 'init');
  await writeFile(path.join(root, 'provider.json'), `${JSON.stringify(provider(), null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize GDP M11 fixture');
  const before = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const output = JSON.parse(sflow(
    root, 'delivery', 'readiness', '--provider-file', 'provider.json', '--json'
  ).stdout);
  assert.equal(output.data.status, 'not-ready');
  assert.equal(output.data.gaReady, false);
  assert.equal(output.effects.stateChanged, false);
  assert.ok(output.data.blockers.some((entry) => entry.code === 'GDP_GA_PLATFORM_RELEASE_RECEIPTS_MISSING'));
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), before);
  assert.equal(git(root, 'status', '--porcelain').stdout, '');
});
