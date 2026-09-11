import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  buildCalmProjection, createArchitectureCapabilitySnapshot, createArchitectureConfigurationSnapshot
} from '../src/world-model/projections/calm/projection.mjs';
import { configuredWorldModelV4ProjectionSelections } from '../src/world-model/commands.mjs';

test('heuristic and model-advisory facts cannot create CALM elements', () => {
  const capabilitySnapshot = createArchitectureCapabilitySnapshot({
    version: 2,
    capabilities: {
      source: { kind: 'delivery', parent: null, architecture: { nodeType: 'service' } },
      target: { kind: 'delivery', parent: null, architecture: { nodeType: 'database' } }
    }
  });
  const configurationSnapshot = createArchitectureConfigurationSnapshot({});
  const facts = ['heuristic', 'model-advisory'].map((assurance, index) => ({
    id: `FACT-${String(index + 1).repeat(16)}`, factType: 'dependency-edge',
    subject: { kind: 'dependency-edge', id: `edge-${index}` },
    claim: JSON.stringify({ source: 'source', destination: 'target' }),
    status: 'available', assurance, evidenceIds: [], factSha256: sha256(`fact-${index}`)
  }));
  const result = buildCalmProjection({
    subject: { id: 'assurance' }, sourceManifestSha256: sha256('source'),
    scopeSha256: sha256('scope'), factLedger: { ledgerSha256: sha256('ledger'), facts },
    capabilitySnapshot, configurationSnapshot
  });
  assert.equal(result.projection.relationships.length, 0);
});

test("--projections all refuses an empty approved projection catalog", () => {
  assert.throws(
    () => configuredWorldModelV4ProjectionSelections({ definition: { worldModel: {} } }, { projections: 'all' }),
    (error) => error.code === 'WMC_PROJECTION_NOT_CONFIGURED'
      && /requires at least one projection/.test(error.message)
  );
});
