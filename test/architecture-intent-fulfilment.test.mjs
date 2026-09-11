import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  buildCalmProjection, createArchitectureCapabilitySnapshot, createArchitectureConfigurationSnapshot,
  createArchitectureIntent, renderPlannedArchitecture, verifyArchitectureIntent
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
