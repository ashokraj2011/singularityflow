import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  buildCalmProjection, createArchitectureCapabilitySnapshot, createArchitectureConfigurationSnapshot,
  createArchitectureIntent, renderPlannedArchitecture
} from '../src/world-model/projections/calm/projection.mjs';

function base() {
  return buildCalmProjection({
    subject: { id: 'intent-demo' }, sourceManifestSha256: sha256('source'),
    scopeSha256: sha256('scope'), factLedger: { ledgerSha256: sha256('ledger'), facts: [] },
    capabilitySnapshot: createArchitectureCapabilitySnapshot({
      version: 2, capabilities: { payments: { kind: 'delivery', parent: null, architecture: { nodeType: 'service' } } }
    }),
    configurationSnapshot: createArchitectureConfigurationSnapshot({})
  });
}

test('Story intent creates a planned-only projection bound to the exact base', () => {
  const current = base();
  const manifestSha256 = sha256('manifest');
  const intent = createArchitectureIntent({
    workId: 'PAY-142', phase: 'planning', generation: 1,
    base: { worldModelManifestSha256: manifestSha256, calmProjectionSha256: current.projectionSha256 },
    clauses: [{
      clauseId: 'PAY-142:ARCH-001', operation: 'add-node', elementId: 'payment-cache', required: true,
      value: { 'node-type': 'database', name: 'Payment Cache', description: 'Short-lived cache.' }
    }]
  });
  const planned = renderPlannedArchitecture({
    projection: current.projection, projectionSha256: current.projectionSha256,
    worldModelManifestSha256: manifestSha256, intent
  });
  assert.equal(current.projection.nodes.some((node) => node['unique-id'] === 'payment-cache'), false);
  assert.equal(planned.projection.nodes.find((node) => node['unique-id'] === 'payment-cache')
    .metadata.sflow.status, 'planned');
  assert.throws(() => renderPlannedArchitecture({
    projection: current.projection, projectionSha256: current.projectionSha256,
    worldModelManifestSha256: sha256('moved'), intent
  }), (error) => error.code === 'WMC_INTENT_BASE_STALE');
});
