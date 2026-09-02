import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateAutoContractRecord } from '../src/auto/auto-contract-records.mjs';
import { migrationRegistrySnapshot, readRecord } from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFile = path.join(root, 'test', 'fixtures', 'schema-migrations', 'goldens.json');
const autoContractFamilies = new Set([
  'auto-context-manifest', 'auto-agent-task-contract',
  'auto-execution-selection', 'auto-execution-event'
]);

test('all-goldens-read-to-current', async () => {
  const bytes = await readFile(fixtureFile);
  const before = Buffer.from(bytes);
  const fixtures = JSON.parse(bytes);
  const registry = migrationRegistrySnapshot();
  assert.deepEqual(Object.keys(fixtures).sort(), registry.map((entry) => entry.id).sort());
  for (const family of registry) {
    const records = fixtures[family.id];
    const versions = new Set(records.map((record) => record.schemaVersion));
    for (let version = family.minimumReadableVersion; version <= family.currentVersion; version += 1) {
      assert.ok(versions.has(version), `${family.id} is missing frozen v${version}`);
    }
    for (const record of records) {
      const source = JSON.stringify(record);
      const migrated = readRecord(family.id, source);
      assert.equal(migrated.record.schemaVersion, family.currentVersion, family.id);
      if (autoContractFamilies.has(family.id)) {
        assert.deepEqual(
          validateAutoContractRecord(family.id, source), migrated.record, family.id
        );
      }
      assert.equal(source, JSON.stringify(record), `${family.id} source changed`);
    }
  }
  assert.deepEqual(await readFile(fixtureFile), before);
});

test('previous-release durable corpus remains completely readable', async () => {
  const fixtures = JSON.parse(await readFile(fixtureFile, 'utf8'));
  for (const family of migrationRegistrySnapshot()) {
    const oldest = fixtures[family.id].find((record) => record.schemaVersion === family.minimumReadableVersion);
    assert.ok(oldest, family.id);
    assert.equal(readRecord(family.id, oldest).record.schemaVersion, family.currentVersion);
  }
});

test('legacy planned claim maps migrate without inventing a test waiver', () => {
  const migrated = readRecord('specification-claim-map', {
    schemaVersion: 1,
    kind: 'planned',
    claims: {
      'APP:REQ-001': { expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs'], deviation: null },
      'APP:CON-001': { expectedPaths: [], tests: [], deviation: null }
    }
  }).record;
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.claims['APP:REQ-001'].testDisposition, 'applicable');
  assert.equal(migrated.claims['APP:CON-001'].testDisposition, 'unspecified');
  assert.equal(migrated.claims['APP:CON-001'].testReason, null);
});

test('legacy Story convergence policy migrates to the kernel-owned deterministic producer', () => {
  const migrated = readRecord('story-workflow', {
    schemaVersion: 3,
    phaseOrder: ['convergence'],
    phases: {
      convergence: {
        id: 'convergence',
        approvalPolicy: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['convergence'] },
        generationPolicy: {
          requirement: 'required', producer: 'agent', defaultProducer: 'governed-agent',
          allowedProducers: ['governed-agent', 'human']
        }
      }
    },
    resolution: {
      approvalSecurity: { profile: 'team', allowSelfApproval: true, autoEnrollNewIdentities: true },
      approvalAuthorities: {
        'architecture-reviewers': { label: 'Architecture reviewers', members: [], allowAnyGitIdentity: true }
      },
      phases: [{
        id: 'convergence',
        approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['convergence'] },
        generation: {
          requirement: 'required', producer: 'agent', defaultProducer: 'governed-agent',
          allowedProducers: ['governed-agent', 'human']
        }
      }]
    }
  }).record;
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.phases.convergence.generationPolicy.requirement, 'required');
  assert.deepEqual(migrated.phases.convergence.generationPolicy.allowedProducers, ['deterministic']);
  assert.equal(migrated.phases.convergence.generationPolicy.defaultProducer, 'deterministic');
  assert.deepEqual(migrated.resolution.phases[0].generation.allowedProducers, ['deterministic']);
  assert.equal(migrated.resolution.phases[0].generation.requirement, 'required');
  assert.equal(migrated.phases.convergence.approvalPolicy.mode, 'required');
  assert.deepEqual(migrated.phases.convergence.approvalPolicy.authorities, ['architecture-reviewers']);
  assert.equal(migrated.phases.convergence.approvalPolicy.minimum, 1);
  assert.equal(migrated.phases.convergence.approvalPolicy.allowSelfApproval, true,
    'migrating approval:none must not strand a lone developer with its normalized false value');
  assert.equal(migrated.resolution.phases[0].approval.mode, 'required');
});
