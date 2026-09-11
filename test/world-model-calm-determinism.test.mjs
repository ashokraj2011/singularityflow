import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  buildCalmProjection, createArchitectureCapabilitySnapshot,
  createArchitectureConfigurationSnapshot, explainArchitectureElement,
  validateCalmProjection, validateCalmProjectionCandidate
} from '../src/world-model/projections/calm/projection.mjs';

function fixture() {
  const capabilitySnapshot = createArchitectureCapabilitySnapshot({
    version: 2,
    capabilities: {
      commerce: { kind: 'collection', parent: null, label: 'Commerce' },
      checkout: { kind: 'delivery', parent: 'commerce', label: 'Checkout', architecture: { nodeType: 'webclient' } },
      payments: {
        kind: 'delivery', parent: 'commerce', label: 'Payments', architecture: { nodeType: 'service' },
        repositories: [{ id: 'payments-api', revision: `sha256:${'4'.repeat(64)}` }],
        dependencies: [{ capability: 'checkout', contract: 'payments-api-v2' }]
      }
    }
  });
  const configurationSnapshot = createArchitectureConfigurationSnapshot({
    approvalAuthorities: {
      'engineering-reviewers': {
        label: 'Engineering reviewers', members: ['person@example.invalid']
      }
    },
    protectedPaths: ['singularity/workflow.yml', 'singularity/capabilities.yml']
  });
  return {
    subject: { id: 'commerce-platform' },
    sourceManifestSha256: sha256('source'), scopeSha256: sha256('scope'),
    factLedger: { ledgerSha256: sha256('ledger'), facts: [] },
    capabilitySnapshot, configurationSnapshot
  };
}

test('arch.calm is byte deterministic and environment-free', () => {
  const first = buildCalmProjection(fixture());
  const second = buildCalmProjection(fixture());
  assert.equal(first.projectionBytes, second.projectionBytes);
  assert.equal(first.projectionSha256, second.projectionSha256);
  assert.equal(first.sourceMap.sourceMapSha256, second.sourceMap.sourceMapSha256);
  assert.doesNotMatch(first.projectionBytes, /person@example|\/Users\/|[A-Za-z]:\\/);
});

test('capabilities, composition, dependencies, actors, controls and provenance map deterministically', () => {
  const result = buildCalmProjection(fixture());
  assert.equal(result.projection.nodes.find((node) => node['unique-id'] === 'payments')['node-type'], 'service');
  assert.ok(result.projection.relationships.some((item) => item['relationship-type']['composed-of']));
  assert.ok(result.projection.relationships.some((item) => item['relationship-type'].connects));
  const outputElements = new Set([
    ...result.projection.nodes.map((item) => item['unique-id']),
    ...result.projection.relationships.map((item) => item['unique-id']),
    ...Object.keys(result.projection.controls)
  ]);
  assert.ok(result.sourceMap.elements.every((item) => outputElements.has(item.elementId)));
  const explained = explainArchitectureElement({
    projection: result.projection, sourceMap: result.sourceMap, elementId: 'payments'
  });
  assert.deepEqual(explained.changeAt, ['singularity/capabilities.yml']);
});

test('unknown delivery classification stays a system and records unavailability', () => {
  const input = fixture();
  input.capabilitySnapshot = createArchitectureCapabilitySnapshot({
    version: 2, capabilities: { mystery: { kind: 'delivery', parent: null, label: 'Mystery' } }
  });
  const result = buildCalmProjection(input);
  assert.equal(result.projection.nodes.find((node) => node['unique-id'] === 'mystery')['node-type'], 'system');
  assert.equal(result.factSet.unavailable[0].reason, 'explicit-classification-unavailable');
});

test('identical interface facts coalesce provenance while conflicting facts stay visible', () => {
  const input = fixture();
  const interfaceFact = (id, value, suffix) => ({
    id, factType: 'interface', subject: { kind: 'interface', id: 'checkout-api' },
    claim: JSON.stringify({ node: 'checkout', id: 'checkout-api', type: 'http', value }),
    status: 'available', assurance: 'structurally-derived', evidenceIds: [`EVIDENCE-${suffix}`],
    factSha256: sha256(`interface-${suffix}`)
  });
  input.factLedger = {
    ledgerSha256: sha256('coalesced-ledger'),
    facts: [
      interfaceFact('FACT-INTERFACE-0002', '/checkout', '2'),
      interfaceFact('FACT-INTERFACE-0001', '/checkout', '1')
    ]
  };
  const coalesced = buildCalmProjection(input);
  const contract = coalesced.factSet.interfaces.find((entry) => entry.id === 'checkout-api');
  assert.equal(contract.sources.length, 2);
  assert.deepEqual(contract.sources.map((entry) => entry.factId), [
    'FACT-INTERFACE-0001', 'FACT-INTERFACE-0002'
  ]);

  input.factLedger = {
    ledgerSha256: sha256('conflicting-ledger'),
    facts: [
      interfaceFact('FACT-INTERFACE-0001', '/checkout', '1'),
      interfaceFact('FACT-INTERFACE-0002', '/checkout-v2', '2')
    ]
  };
  const contradicted = buildCalmProjection(input);
  assert.equal(contradicted.factSet.interfaces.some((entry) => entry.id === 'checkout-api'), false);
  assert.equal(contradicted.factSet.contradictions[0].subject, 'interface:checkout-api');
  assert.deepEqual(contradicted.factSet.contradictions[0].conflictsWith, [
    'FACT-INTERFACE-0001', 'FACT-INTERFACE-0002'
  ]);
});

test('relationships cannot borrow an interface from the opposite endpoint node', () => {
  const result = buildCalmProjection(fixture());
  const projection = structuredClone(result.projection);
  projection.nodes.find((node) => node['unique-id'] === 'checkout').interfaces = [{
    'unique-id': 'checkout-api', name: 'Checkout API', description: 'Checkout API',
    'interface-type': 'http'
  }];
  const relationship = projection.relationships.find(
    (entry) => entry['relationship-type'].connects?.source?.node === 'payments'
  );
  relationship['relationship-type'].connects.source.interfaces = ['checkout-api'];
  assert.throws(
    () => validateCalmProjection(projection),
    (error) => error.code === 'WMC_CALM_SCHEMA_INVALID'
      && /outside its source node/.test(error.message)
  );
});

test('architecture element IDs are globally unambiguous for explain and provenance lookup', () => {
  const result = buildCalmProjection(fixture());
  const projection = structuredClone(result.projection);
  projection.nodes.find((node) => node['unique-id'] === 'checkout').interfaces = [{
    'unique-id': 'payments', type: 'http', value: '/checkout'
  }];
  assert.throws(
    () => validateCalmProjection(projection),
    (error) => error.code === 'WMC_ELEMENT_ID_COLLISION'
  );
});

test('the reviewed offline FINOS validator seals the exact deterministic projection', async () => {
  const built = buildCalmProjection(fixture());
  const validated = await validateCalmProjectionCandidate(built);
  assert.equal(validated.validationResult.status, 'passed');
  assert.equal(validated.validationResult.toolchainLock.validator.package, '@finos/calm-cli');
  assert.equal(validated.validationResult.toolchainLock.validator.version, '1.57.0');
  assert.equal(validated.receipt.validation.toolchainLockSha256,
    validated.validationResult.toolchainLock.lockSha256);
  assert.equal(validated.receipt.output.sha256, built.projectionSha256);
});
