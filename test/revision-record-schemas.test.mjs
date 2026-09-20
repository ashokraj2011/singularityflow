import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migrationRegistrySnapshot } from '../src/schema-migrations.mjs';

const FAMILIES = Object.freeze({
  'revision-loop': [
    'schemaVersion', 'kind', 'subject', 'workflow', 'initialCandidateId',
    'headCandidateId', 'headIntervalId', 'state', 'revision', 'segments',
    'producer', 'loopSha256'
  ],
  'revision-interval': [
    'schemaVersion', 'kind', 'intervalId', 'sequence', 'subject', 'trigger',
    'parentCandidate', 'resultCandidate', 'packetSha256', 'criteriaBindingSha256',
    'specificationDispositionSha256', 'executionAttempts', 'hunkClaimSetSha256',
    'startedAt', 'endedAt', 'producer', 'precheckSha256', 'status', 'intervalSha256'
  ],
  'revision-hunk-claim-set': [
    'schemaVersion', 'kind', 'subject', 'parentCandidateId', 'resultCandidateId',
    'claims', 'unexplained', 'producer', 'claimSetSha256'
  ],
  'revision-precheck': [
    'schemaVersion', 'kind', 'subject', 'candidateId', 'candidateSha256',
    'candidateRefSha256', 'candidateTree', 'headSnapshotSha256', 'headRevision',
    'headTransitionSha256', 'phaseGeneration', 'workflowSha256', 'configSha256',
    'proofProfile', 'proofProfileSha256', 'editorDiskIndexBaselineSha256',
    'criteriaBindingSha256', 'specificationDispositionSha256', 'hunkClaimSetSha256',
    'precheckInputsSha256', 'criteria', 'owed', 'unexplainedHunks', 'refusalSummary',
    'deterministicChecks', 'remainingObligations', 'precheckPassed',
    'publicationEligible', 'producer', 'precheckSha256'
  ]
});

async function schema(family) {
  return JSON.parse(await readFile(
    new URL(`../schemas/${family}.schema.json`, import.meta.url), 'utf8'
  ));
}

function assertInlineObjectsClosed(value, location) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'object') {
    assert.equal(value.additionalProperties, false, `${location} is not closed`);
    assert.ok(value.properties && typeof value.properties === 'object',
      `${location} has no property declaration`);
    assert.deepEqual(
      [...value.required ?? []].sort(), Object.keys(value.properties).sort(),
      `${location} has optional or undeclared authority fields`
    );
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'properties' && key !== '$defs' && key !== 'items' && key !== 'oneOf') continue;
    if (Array.isArray(child)) {
      child.forEach((entry, index) => assertInlineObjectsClosed(entry, `${location}.${key}[${index}]`));
    } else if (key === 'properties' || key === '$defs') {
      for (const [name, entry] of Object.entries(child ?? {})) {
        assertInlineObjectsClosed(entry, `${location}.${key}.${name}`);
      }
    } else {
      assertInlineObjectsClosed(child, `${location}.${key}`);
    }
  }
}

test('REV loop, interval, hunk-claim, and precheck schemas freeze their complete v1 shapes', async () => {
  for (const [family, fields] of Object.entries(FAMILIES)) {
    const contract = await schema(family);
    assert.equal(contract.$schema, 'https://json-schema.org/draft/2020-12/schema', family);
    assert.equal(contract.properties.schemaVersion.const, 1, family);
    assert.equal(contract.properties.kind.const, family, family);
    assert.deepEqual([...contract.required].sort(), [...fields].sort(), `${family}.required`);
    assert.deepEqual(Object.keys(contract.properties).sort(), [...fields].sort(),
      `${family}.properties`);
    assertInlineObjectsClosed(contract, family);
  }
});

test('the four REV schema families are immutable frozen identities with migration goldens', async () => {
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  const goldens = JSON.parse(await readFile(
    new URL('./fixtures/schema-migrations/goldens.json', import.meta.url), 'utf8'
  ));
  for (const family of Object.keys(FAMILIES)) {
    assert.equal(registry.get(family)?.currentVersion, 1, family);
    assert.equal(registry.get(family)?.minimumReadableVersion, 1, family);
    assert.equal(registry.get(family)?.immutable, true, family);
    assert.equal(registry.get(family)?.migrationPolicy, 'frozen-identity', family);
    assert.deepEqual(goldens[family], [{ schemaVersion: 1 }], family);
  }
});

test('revision-loop remains a local open-or-abandoned projection with closed segment digests', async () => {
  const contract = await schema('revision-loop');
  assert.deepEqual(contract.properties.state.enum, ['open', 'abandoned']);
  assert.equal(contract.properties.segments.items.additionalProperties, false);
  assert.equal(contract.properties.headIntervalId.oneOf.some((entry) => entry.type === 'null'), true);
});
