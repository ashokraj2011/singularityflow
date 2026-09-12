import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  buildCalmProjection, createArchitectureCapabilitySnapshot, createArchitectureConfigurationSnapshot,
  createArchitectureIntent, renderPlannedArchitecture
} from '../src/world-model/projections/calm/projection.mjs';
import {
  architectureIntentTargetGeneration, normalizeArchitectureIntentCandidate,
  validateArchitectureIntentLifecyclePolicy
} from '../src/commands/architecture.mjs';

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

test('architecture intent authoring targets the next accepted publication without generation zero', () => {
  const workflow = {
    currentPhase: 'planning',
    phaseOrder: ['planning', 'implementation', 'verification'],
    phases: {
      planning: { id: 'planning', status: 'in_progress', generation: 0 },
      implementation: { id: 'implementation', status: 'not_started', generation: 0 },
      verification: { id: 'verification', status: 'not_started', generation: 0 }
    }
  };
  const policy = {
    enabled: true, allowedPhases: ['planning'], blockRequiredUnfulfilledAt: ['verification']
  };
  assert.equal(architectureIntentTargetGeneration(workflow, 'planning'), 1);
  assert.deepEqual(
    normalizeArchitectureIntentCandidate({ phase: 'planning', clauses: [] }, workflow, policy),
    { phase: 'planning', generation: 1, clauses: [] }
  );
  assert.equal(normalizeArchitectureIntentCandidate({
    phase: 'planning', generation: 1, clauses: []
  }, workflow, policy).generation, 1);
  assert.equal(workflow.phases.planning.generation, 0);

  for (const generation of [0, 2, '1', 1.5]) {
    assert.throws(
      () => normalizeArchitectureIntentCandidate({
        phase: 'planning', generation, clauses: []
      }, workflow, policy),
      (error) => error.code === 'WMC_INTENT_GENERATION_STALE'
        && error.details.expectedGeneration === 1
    );
  }
});

test('architecture intent policy refuses owner/enforcement cycles before draft creation', () => {
  const workflow = {
    currentPhase: 'planning', phaseOrder: ['planning', 'verification'],
    phases: {
      planning: { id: 'planning', status: 'in_progress', generation: 1 },
      verification: { id: 'verification', status: 'not_started', generation: 0 }
    }
  };
  assert.equal(validateArchitectureIntentLifecyclePolicy(workflow, {
    allowedPhases: ['planning'], blockRequiredUnfulfilledAt: ['verification']
  }, 'planning'), true);
  assert.throws(() => validateArchitectureIntentLifecyclePolicy(workflow, {
    allowedPhases: ['planning'], blockRequiredUnfulfilledAt: ['planning']
  }, 'planning'), (error) => error.code === 'WMC_INTENT_POLICY_INVALID');
  assert.throws(() => normalizeArchitectureIntentCandidate({
    phase: 'verification', clauses: []
  }, workflow, {
    allowedPhases: ['planning'], blockRequiredUnfulfilledAt: []
  }), (error) => error.code === 'WMC_INTENT_PHASE_INVALID');
});
