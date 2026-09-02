import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  currentSchemaVersion, migrationRegistrySnapshot, readRecord, stampCurrentRecord
} from '../src/schema-migrations.mjs';
import { recordSha256 } from '../src/records.mjs';

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

  const execution = readRecord('test-execution', {
    schemaVersion: 1,
    assurance: 'module-executed',
    testcaseExecutionProven: false,
    // Unknown in v1: matching a future field name must not manufacture v2 observation authority.
    testcaseObservation: { status: 'observed', assurance: 'externally-attested' },
    candidate: { sha256: 'b'.repeat(64) }
  }).record;
  assert.equal(execution.testcaseObservation.status, 'unavailable');
  assert.equal(execution.testcaseObservation.assurance, 'unavailable');
  assert.equal(execution.candidate, null);
  assert.equal(execution.assurance, 'module-executed');
  assert.equal(execution.testcaseExecutionProven, false);

  const packet = readRecord('story-submission-packet', {
    schemaVersion: 1,
    witnessReview: {
      enrollmentClassification: 'enrolled',
      clauseMappings: [{ status: 'reviewed' }]
    }
  }).record;
  assert.equal(packet.witnessReview.enrollmentClassification, 'legacy');
  assert.equal(packet.witnessReview.enrollment, null);
  assert.deepEqual(packet.witnessReview.clauseMappings, []);
});

test('legacy prompt and agent context retain their historical verification meaning', () => {
  const prompt = readRecord('prompt-injection', {
    schemaVersion: 1, requiredViews: ['overview']
  }).record;
  assert.equal(prompt.requiredSelections, null);
  assert.deepEqual(prompt.groundingAvailability, {
    status: 'legacy-unverified', reasonCode: null
  });
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
  assert.equal(migrated.knowledge.status, 'unavailable');
  assert.deepEqual(migrated.knowledge.selected, []);
  assert.deepEqual(migrated.knowledge.omitted, []);
  assert.equal(migrated.knowledge.omissions.detail, null);
  assert.equal(migrated.knowledge.omissions.omittedSetSha256, null);
  assert.equal(migrated.knowledge.manifestSha256, null);
  assert.equal(migrated.outcome, null);
});

test('legacy Evidence Packet integrity remains bound to raw v2 bytes before additive migration', () => {
  const unsigned = {
    schemaVersion: 2,
    kind: 'evidence-packet',
    packetId: 'ctx-0123456789abcdefabcd',
    compilerVersion: 2,
    binding: { workId: 'OLD-1' },
    items: [], omissions: [], unavailable: [],
    integrity: null
  };
  const stored = { ...unsigned, integrity: { sha256: recordSha256(unsigned) } };
  const rawBytes = Buffer.from(JSON.stringify(stored));
  const parsedRaw = JSON.parse(rawBytes);
  assert.equal(recordSha256({ ...parsedRaw, integrity: null }), parsedRaw.integrity.sha256);

  const migrated = readRecord('evidence-packet', rawBytes);
  assert.equal(migrated.storedVersion, 2);
  assert.deepEqual(migrated.migratedThrough, [{ from: 2, to: 3 }]);
  assert.equal(migrated.record.integrity.sha256, stored.integrity.sha256);
  assert.equal(migrated.record.knowledge, null);
  assert.deepEqual(rawBytes, Buffer.from(JSON.stringify(stored)));
});

test('legacy context manifests preserve their exact regions and cache identities', () => {
  const stored = {
    schemaVersion: 2,
    stablePrefix: [{ kind: 'kernel-contract', sha256: 'a'.repeat(64) }],
    sessionStable: [{ kind: 'flight-plan', sha256: 'b'.repeat(64) }],
    variable: [{ kind: 'current-observation', sha256: 'c'.repeat(64) }],
    mutableTail: [
      { kind: 'flight-plan', sha256: 'b'.repeat(64) },
      { kind: 'current-observation', sha256: 'c'.repeat(64) }
    ],
    cacheKey: 'legacy-cache-key',
    sessionCacheKey: 'legacy-session-key',
    cacheManifestId: 'legacy-manifest-id'
  };
  const migrated = readRecord('context-manifest', stored).record;
  assert.deepEqual(migrated.stablePrefix, stored.stablePrefix);
  assert.deepEqual(migrated.sessionStable, stored.sessionStable);
  assert.deepEqual(migrated.variable, stored.variable);
  assert.deepEqual(migrated.mutableTail, stored.mutableTail);
  assert.equal(migrated.cacheKey, stored.cacheKey);
  assert.equal(migrated.sessionCacheKey, stored.sessionCacheKey);
  assert.equal(migrated.cacheManifestId, stored.cacheManifestId);
  assert.equal(migrated.knowledge, null);
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
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.promptTransport, 'legacy-argv');
  assert.equal(migrated.promptEncoding, 'utf-8');
  assert.equal(migrated.attestation, null);
  assert.equal(migrated.promptProtocolVersion, null);
  assert.equal(migrated.requestedModel, null);
  assert.equal(migrated.modelSelection, null);
  assert.equal(migrated.toolObservation, null);
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
