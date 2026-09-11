import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  buildCalmProjection, createArchitectureCapabilitySnapshot, createArchitectureConfigurationSnapshot,
  createArchitectureIntent, explainArchitectureElement, renderPlannedArchitecture,
  verifyArchitectureIntent
} from '../src/world-model/projections/calm/projection.mjs';

test('intent fulfilment reports exact fulfilled and missing required clauses', () => {
  const base = buildCalmProjection({
    subject: { id: 'fulfilment' }, sourceManifestSha256: sha256('source'),
    scopeSha256: sha256('scope'), factLedger: { ledgerSha256: sha256('ledger'), facts: [] },
    capabilitySnapshot: createArchitectureCapabilitySnapshot({
      version: 2, capabilities: { payments: { kind: 'delivery', parent: null, architecture: { nodeType: 'service' } } }
    }), configurationSnapshot: createArchitectureConfigurationSnapshot({})
  });
  const manifestSha256 = sha256('manifest');
  const intent = createArchitectureIntent({
    workId: 'PAY-142', phase: 'planning', generation: 1,
    base: { worldModelManifestSha256: manifestSha256, calmProjectionSha256: base.projectionSha256 },
    clauses: [{ clauseId: 'PAY-142:ARCH-001', operation: 'add-node', elementId: 'cache', required: true,
      value: { 'node-type': 'database', name: 'Cache', description: 'Cache' } }]
  });
  const missing = verifyArchitectureIntent({ intent, baseAfter: base.projection, baseAfterSha256: base.projectionSha256 });
  assert.equal(missing.blocking, true);
  assert.equal(missing.clauses[0].verdict, 'missing');
  const planned = renderPlannedArchitecture({
    projection: base.projection, projectionSha256: base.projectionSha256,
    worldModelManifestSha256: manifestSha256, intent
  });
  const fulfilled = verifyArchitectureIntent({
    intent, baseAfter: planned.projection, baseAfterSha256: planned.projectionSha256
  });
  assert.equal(fulfilled.blocking, false);
  assert.equal(fulfilled.clauses[0].verdict, 'fulfilled');
});

test('changed existing elements retain base provenance in fulfilment and explanation', () => {
  const base = buildCalmProjection({
    subject: { id: 'provenance' }, sourceManifestSha256: sha256('source'),
    scopeSha256: sha256('scope'), factLedger: { ledgerSha256: sha256('ledger'), facts: [] },
    capabilitySnapshot: createArchitectureCapabilitySnapshot({
      version: 2, capabilities: {
        payments: { kind: 'delivery', parent: null, architecture: { nodeType: 'service' } }
      }
    }), configurationSnapshot: createArchitectureConfigurationSnapshot({})
  });
  const manifestSha256 = sha256('manifest');
  const intent = createArchitectureIntent({
    workId: 'PAY-143', phase: 'planning', generation: 1,
    base: { worldModelManifestSha256: manifestSha256, calmProjectionSha256: base.projectionSha256 },
    clauses: [{
      clauseId: 'PAY-143:ARCH-001', operation: 'change-node', elementId: 'payments', required: true,
      value: { name: 'Payments API' }
    }]
  });
  const planned = renderPlannedArchitecture({
    projection: base.projection, projectionSha256: base.projectionSha256,
    worldModelManifestSha256: manifestSha256, intent
  });
  const fulfilled = verifyArchitectureIntent({
    intent, baseAfter: planned.projection, baseAfterSha256: planned.projectionSha256,
    sourceMap: base.sourceMap
  });
  assert.match(fulfilled.clauses[0].sourceRefs[0], /^capability:payments@sha256:/);
  const explained = explainArchitectureElement({
    projection: base.projection, sourceMap: base.sourceMap, elementId: 'payments', intent,
    intentPath: 'singularity/work-items/PAY-143/context/architecture/architecture-intent.json'
  });
  assert.equal(explained.status, 'planned');
  assert.deepEqual(explained.sources.map((source) => source.sourceKind), [
    'architecture-intent', 'capability'
  ]);
});

test('intent fulfilment keeps not-observable evidence and unplanned architecture drift distinct', () => {
  const base = buildCalmProjection({
    subject: { id: 'drift' }, sourceManifestSha256: sha256('source'),
    scopeSha256: sha256('scope'), factLedger: { ledgerSha256: sha256('ledger'), facts: [] },
    capabilitySnapshot: createArchitectureCapabilitySnapshot({
      version: 2, capabilities: {
        payments: { kind: 'delivery', parent: null, architecture: { nodeType: 'service' } }
      }
    }), configurationSnapshot: createArchitectureConfigurationSnapshot({})
  });
  const intent = createArchitectureIntent({
    workId: 'PAY-144', phase: 'planning', generation: 1,
    base: {
      worldModelManifestSha256: sha256('manifest'),
      calmProjectionSha256: base.projectionSha256
    },
    clauses: [{
      clauseId: 'PAY-144:ARCH-001', operation: 'add-node', elementId: 'cache', required: true,
      value: { 'node-type': 'database', name: 'Cache', description: 'Cache' }
    }]
  });
  const unobservable = verifyArchitectureIntent({
    intent, baseAfter: base.projection, baseAfterSha256: base.projectionSha256,
    unavailable: [{ subject: 'node:cache', reason: 'producer-unavailable' }]
  });
  assert.equal(unobservable.clauses[0].verdict, 'not-observable');

  const after = renderPlannedArchitecture({
    projection: base.projection, projectionSha256: base.projectionSha256,
    worldModelManifestSha256: sha256('manifest'), intent
  }).projection;
  after.nodes.push({
    'unique-id': 'surprise', 'node-type': 'system', name: 'Surprise',
    description: 'Unplanned component.', interfaces: []
  });
  after.nodes.sort((left, right) => left['unique-id'].localeCompare(right['unique-id']));
  const drift = verifyArchitectureIntent({
    intent, baseBefore: base.projection, baseAfter: after,
    baseAfterSha256: sha256({ utf8: JSON.stringify(after) })
  });
  assert.equal(drift.clauses.find((clause) => clause.clauseId === 'PAY-144:ARCH-001').verdict,
    'fulfilled');
  assert.equal(drift.clauses.find((clause) => clause.verdict === 'unplanned').elementIds[0],
    'surprise');
  assert.equal(drift.blocking, true);
});
