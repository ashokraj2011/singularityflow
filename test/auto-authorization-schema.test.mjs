import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  currentSchemaVersion, migrationRegistrySnapshot, readRecord
} from '../src/schema-migrations.mjs';
import { recordSha256 } from '../src/records.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confirmationFields = [
  'confirmationProtocol', 'confirmedSha256', 'packetSha256', 'validationSha256'
];

async function authorizationSchema() {
  return JSON.parse(await readFile(
    path.join(root, 'schemas', 'auto-authorization.schema.json'), 'utf8'
  ));
}

async function schema(name) {
  return JSON.parse(await readFile(path.join(root, 'schemas', `${name}.schema.json`), 'utf8'));
}

function flightCheckpointSha256(state) {
  return `sha256:${recordSha256({
    flightId: state.flightId,
    planSha256: state.planSha256,
    status: state.status,
    workId: state.story.workId,
    phase: state.story.phase,
    position: state.position,
    counters: state.counters,
    checkpointSequence: state.checkpointSequence,
    stopReason: state.stopReason,
    stopRequested: state.stopRequested ?? null
  })}`;
}

function sealedLegacyFlight(status = 'paused') {
  const state = {
    schemaVersion: 1,
    kind: 'auto-flight-state',
    mode: 'auto',
    flightId: 'AFL-AAAAAAAAAAAAAAAAAAAAAAAAAA',
    planId: 'APL-BBBBBBBBBBBBBBBBBBBBBBBBBB',
    planSha256: `sha256:${'c'.repeat(64)}`,
    capabilityId: null,
    status,
    story: { workId: 'AUT-LEGACY', branch: 'AUT-LEGACY', phase: 'implement' },
    worktree: '/tmp/sflow-auto-legacy',
    scopePrediction: [],
    configuration: null,
    repositories: [],
    operations: [],
    evidence: {},
    lastSuccessfulStoryRevision: null,
    position: 'story-created',
    execution: { pace: { mode: 'phase' }, until: { kind: 'first-human-boundary' }, ceilings: {} },
    counters: {
      modelInvocations: 0, authoringAttempts: {}, phasesCompleted: 0,
      touchedPaths: 0, touchedChanges: 0, totalTokens: 0, activeMilliseconds: 0
    },
    stopRequested: null,
    checkpointSequence: 1,
    checkpointSha256: null,
    stopReason: 'story-created',
    nextAction: 'Review the legacy flight.',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    recordSha256: null
  };
  state.checkpointSha256 = flightCheckpointSha256(state);
  const record = structuredClone(state);
  delete record.recordSha256;
  state.recordSha256 = recordSha256(record);
  return state;
}

test('the mutable Auto authorization family has one packaged closed schema contract', async () => {
  const schema = await authorizationSchema();
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const checkSource = await readFile(path.join(root, 'scripts', 'check.mjs'), 'utf8');
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schemaVersion.const, currentSchemaVersion('auto-authorization'));
  assert.equal(registry.get('auto-authorization')?.immutable, false);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.ok(packageJson.files.includes('schemas/'));
  assert.match(checkSource, /schemas\/auto-authorization\.schema\.json/);
  for (const required of schema.required) {
    assert.ok(Object.hasOwn(schema.properties, required), `required property '${required}' is undeclared`);
  }
  for (const forbidden of ['recovery', 'command', 'argv', 'remoteUrl', 'credential']) {
    assert.equal(schema.properties[forbidden], undefined, `private authorization exposes '${forbidden}'`);
  }
});

test('packet confirmation fields are all-or-none and packet-v1 requires the complete set', async () => {
  const schema = await authorizationSchema();
  for (const field of confirmationFields) {
    assert.ok(schema.required.includes(field), `${field} is optional`);
  }
  assert.equal(schema.properties.confirmationProtocol.const, 'packet-v1');
  const packetRule = schema.allOf.find((entry) => /cross-property equality/.test(entry.$comment ?? ''));
  assert.ok(packetRule);
  for (const term of ['runtime', 'confirmedSha256', 'packetSha256']) {
    assert.match(packetRule.$comment, new RegExp(term, 'i'));
  }
});

test('claim lifecycle conditions distinguish idle, active, and consumed authorizations', async () => {
  const schema = await authorizationSchema();
  const active = schema.allOf.find((entry) => (
    entry.if?.properties?.claimedAt?.type === 'string'
      && entry.if?.properties?.consumedAt?.type === 'null'
  ));
  assert.deepEqual(
    [...active.then.required].sort(),
    ['claimExpiresAt', 'claimId', 'claimOwner', 'flightId']
  );
  assert.equal(active.then.properties.claimOwner.$ref, '#/$defs/claimOwner');

  const consumed = schema.allOf.find(
    (entry) => entry.if?.properties?.consumedAt?.type === 'string'
  );
  assert.deepEqual([...consumed.then.required].sort(), ['claimExpiresAt', 'claimedAt', 'flightId']);
  assert.equal(consumed.then.properties.claimExpiresAt.type, 'null');

  const idle = schema.allOf.find(
    (entry) => entry.if?.properties?.claimedAt?.type === 'null'
  );
  for (const field of ['consumedAt', 'flightId', 'claimExpiresAt', 'claimId', 'claimOwner']) {
    assert.equal(idle.then.properties[field].type, 'null', `idle authorization permits '${field}'`);
  }
  assert.equal(schema.$defs.actor.additionalProperties, false);
  assert.equal(schema.$defs.claimOwner.additionalProperties, false);
});

test('pre-packet Auto authority v1 records remain archival and cannot be reinterpreted as v2', async () => {
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  const fixturePath = path.join(
    root, 'test', 'fixtures', 'schema-migrations', 'archived-auto-v1.json'
  );
  const bytes = await readFile(fixturePath);
  const before = Buffer.from(bytes);
  const fixtures = JSON.parse(bytes);

  for (const family of ['auto-plan-ratification', 'auto-authorization']) {
    assert.equal(registry.get(family)?.currentVersion, 2);
    assert.equal(registry.get(family)?.minimumReadableVersion, 2);
    assert.equal((await schema(family)).properties.schemaVersion.const, 2);
    assert.throws(
      () => readRecord(family, fixtures[family]),
      (error) => error.code === 'SCHEMA_VERSION_ARCHIVED'
    );
  }
  assert.deepEqual(await readFile(fixturePath), before);
});

test('every legacy Auto flight status migrates to v2 without changing its meaning', async () => {
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  const family = registry.get('auto-flight-state');
  assert.equal(family?.currentVersion, 2);
  assert.equal(family?.minimumReadableVersion, 1);
  assert.equal((await schema('auto-flight-state')).properties.schemaVersion.const, 2);

  for (const status of ['running', 'paused', 'waiting-human', 'halted', 'completed', 'discarded']) {
    const source = sealedLegacyFlight(status);
    const before = structuredClone(source);
    const migrated = readRecord('auto-flight-state', source);
    assert.equal(migrated.storedVersion, 1);
    assert.deepEqual(migrated.migratedThrough, [{ from: 1, to: 2 }]);
    assert.equal(migrated.record.schemaVersion, 2);
    assert.equal(migrated.record.status, status);
    assert.equal(migrated.record.checkpointSha256, flightCheckpointSha256(migrated.record));
    const resealed = structuredClone(migrated.record);
    delete resealed.recordSha256;
    assert.equal(migrated.record.recordSha256, recordSha256(resealed));
    assert.deepEqual(source, before);
  }

  const tampered = sealedLegacyFlight('paused');
  tampered.status = 'running';
  assert.throws(
    () => readRecord('auto-flight-state', tampered),
    (error) => error.code === 'SCHEMA_MIGRATION_SOURCE_CORRUPT'
  );

  for (const status of ['manual-takeover', 'recovery-required']) {
    const current = readRecord('auto-flight-state', { schemaVersion: 2, status });
    assert.equal(current.storedVersion, 2);
    assert.deepEqual(current.migratedThrough, []);
    assert.equal(current.record.status, status);
  }
});
