import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  currentSchemaVersion, migrationRegistrySnapshot, readRecord, stampCurrentRecord
} from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('future-version-refuses-with-remedy', () => {
  assert.throws(
    () => readRecord('session-registry', '{"schemaVersion":999}'),
    (error) => error.code === 'SCHEMA_VERSION_FUTURE'
      && /written by a newer sflow — upgrade to read it/.test(error.message)
  );
});

test('past version below a family range refuses with the archival remedy', () => {
  assert.throws(
    () => readRecord('pending-publication', { schemaVersion: 1 }),
    (error) => error.code === 'SCHEMA_VERSION_ARCHIVED'
      && /archival reader/.test(error.message)
      && /governed republication/.test(error.message)
  );
});

test('legacy governed records migrate without inventing authority or provenance', () => {
  const knowledge = readRecord('knowledge-record', {
    schemaVersion: 1, type: 'learning', title: 'Keep the timeout bounded', detail: null,
    status: null, tags: ['runtime'], provenance: { initiativeId: 'OLD-1' }, supersedes: null,
    recordedAt: '2025-01-02T03:04:05.000Z', actor: 'legacy@example.test'
  }).record;
  assert.equal(knowledge.type, 'insight');
  assert.equal(knowledge.legacyUnverified, true);
  assert.deepEqual(knowledge.provenance, []);
  assert.deepEqual(knowledge.scope, {});

  const approval = readRecord('phase-approval', {
    schemaVersion: 1, phase: 'specification', approvedAt: '2025-01-02T03:04:05.000Z',
    approvedBy: 'Reviewer', artifacts: [{ path: 'spec.md', sha256: 'a'.repeat(64) }]
  }).record;
  assert.equal(approval.decisions[0].decision, 'approved');
  assert.deepEqual(approval.decisions[0].legacySnapshot.artifacts,
    [{ path: 'spec.md', sha256: 'a'.repeat(64) }]);
});

test('legacy prompt and agent context retain their historical verification meaning', () => {
  const prompt = readRecord('prompt-injection', {
    schemaVersion: 1, requiredViews: ['overview']
  }).record;
  assert.equal(prompt.requiredSelections, null);
  const agent = readRecord('agent-context-audit', {
    schemaVersion: 1, agent: 'developer', persona: 'legacy-copilot', files: []
  }).record;
  assert.equal(agent.nativeCopilotAgent, 'legacy-copilot');
});

test('legacy context packet telemetry gains only content-free observation defaults', () => {
  const migrated = readRecord('context-packet-telemetry', {
    schemaVersion: 1, packetId: 'ctx-123', workId: 'WRK-1', phase: 'implementation',
    includedBytes: 120, estimatedTokens: 30, omittedItems: 0, unavailableItems: 0,
    expansionRequests: 0, observationRawBytes: null, observationIncludedBytes: null,
    cacheKey: 'cache-key', providerInputTokens: null, providerCachedInputTokens: null
  }).record;
  assert.equal(migrated.schemaVersion, currentSchemaVersion('context-packet-telemetry'));
  assert.equal(migrated.estimationMethod, 'utf8-bytes-divided-by-four');
  assert.deepEqual(migrated.omissionClasses, {});
  assert.deepEqual(migrated.expansions, []);
  assert.equal(migrated.expandedBytes, null);
  assert.equal(migrated.expandedEstimatedTokens, null);
  assert.equal(migrated.contextManifestSha256, null);
  assert.equal(migrated.correlation.storyId, 'WRK-1');
  assert.deepEqual(migrated.itemUsage, []);
  assert.equal(migrated.outcome, null);
});

test('legacy observation summaries do not gain a fabricated redaction claim', () => {
  const migrated = readRecord('observation-summary', {
    schemaVersion: 1, observationId: 'obs-legacy', summary: { errors: 1 }
  }).record;
  assert.equal(migrated.schemaVersion, currentSchemaVersion('observation-summary'));
  assert.deepEqual(migrated.redaction, {
    status: 'unavailable', applied: null, occurrences: null, facts: []
  });
  assert.equal(migrated.compiler.version, null);
  assert.equal(migrated.correlation.packetId, null);
});

test('v2 observation outcomes migrate from execution metadata rather than text heuristics', () => {
  const corrected = readRecord('observation-summary', {
    schemaVersion: 2,
    status: 'failed',
    source: { exitCode: 0 },
    summary: { errors: 1 }
  }).record;
  assert.equal(corrected.schemaVersion, 3);
  assert.equal(corrected.status, 'passed');
  assert.equal(corrected.outcome.state, 'succeeded');
  assert.equal(corrected.outcome.legacyReportedStatus, 'failed');
  assert.equal(corrected.outcome.correction, 'v2-text-heuristic-discarded');
  assert.equal(corrected.summary.errorDiagnostics, 1);

  const failed = readRecord('observation-summary', {
    schemaVersion: 2, status: 'passed', source: { exitCode: 2 }, summary: { errors: 0 }
  }).record;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.outcome.exitCode, 2);

  const unknown = readRecord('observation-summary', {
    schemaVersion: 2, status: 'failed', source: {}, summary: { errors: 5 }
  }).record;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.outcome.authority, 'unavailable');
});

test('v1 model invocation audits identify their historical argv transport', () => {
  const migrated = readRecord('model-invocation-audit', {
    schemaVersion: 1, promptSha256: 'a'.repeat(64), promptBytes: 204800
  }).record;
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.promptTransport, 'legacy-argv');
  assert.equal(migrated.promptEncoding, 'utf-8');
  assert.equal(migrated.attestation, null);
});

test('readRecord migrates in memory without changing stored bytes', () => {
  const bytes = Buffer.from('{"schemaVersion":1,"marker":"frozen"}\n');
  const before = Buffer.from(bytes);
  const result = readRecord('session-registry', bytes);
  assert.equal(result.storedVersion, 1);
  assert.equal(result.record.schemaVersion, 2);
  assert.deepEqual(result.migratedThrough, [{ from: 1, to: 2 }]);
  assert.deepEqual(bytes, before);
});

test('writers stamp the registry current version', () => {
  assert.deepEqual(stampCurrentRecord('document-manifest', { schemaVersion: 1, count: 3 }), {
    schemaVersion: currentSchemaVersion('document-manifest'), count: 3
  });
});

test('migration chains are deterministic and model-free', async () => {
  const source = await readFile(path.join(root, 'src', 'schema-migrations.mjs'), 'utf8');
  assert.doesNotMatch(source, /model-runner|invokeModel|Date\.now|new Date|node:fs|\.\/git\.mjs/);
  for (const family of migrationRegistrySnapshot()) assert.equal(family.model, 'never');
});

test('the ledger declares its immutable frozen-identity policy', () => {
  const ledger = migrationRegistrySnapshot().find((family) => family.id === 'ledger-entry');
  assert.equal(ledger.immutable, true);
  assert.equal(ledger.migrationPolicy, 'frozen-identity');
  assert.equal(ledger.currentVersion, 1);
});
