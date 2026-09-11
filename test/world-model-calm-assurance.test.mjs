import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  buildCalmProjection, createArchitectureCapabilitySnapshot, createArchitectureConfigurationSnapshot
} from '../src/world-model/projections/calm/projection.mjs';
import { configuredWorldModelV4ProjectionSelections } from '../src/world-model/commands.mjs';
import { resolveWorldModelV4ReusableIdentity } from '../src/world-model/plan.mjs';
import { validateCalmWithOfficialToolchain } from '../src/world-model/projections/calm/validator.mjs';

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

test('CALM profile, budget, authority snapshots and toolchain are part of reusable identity', () => {
  const selection = (profile = {}, budgets = {}) => configuredWorldModelV4ProjectionSelections({
    definition: { worldModel: { projections: { 'arch.calm': {
      enabled: true,
      profile: {
        includeGovernanceActors: true, includeControls: true, includeFlows: true,
        includeExternalDependencies: 'direct-architecture-only', ...profile
      },
      budgets
    } } } }
  });
  const projection = selection();
  const identity = (overrides = {}) => resolveWorldModelV4ReusableIdentity({
    views: ['dev.impact'], capabilityId: 'payments', projections: projection,
    capabilitySnapshotSha256: sha256('capabilities'),
    configurationSnapshotSha256: sha256('configuration'),
    toolchainLockSha256: sha256('toolchain'),
    ...overrides
  }).identity;
  const baseline = identity();
  assert.equal(baseline.requestedProjections[0].profile.includeControls, true);
  assert.equal(baseline.capabilitySnapshotSha256, sha256('capabilities'));
  assert.notDeepEqual(baseline, identity({ capabilitySnapshotSha256: sha256('moved') }));
  assert.notDeepEqual(baseline, identity({ configurationSnapshotSha256: sha256('moved') }));
  assert.notDeepEqual(baseline, identity({ toolchainLockSha256: sha256('moved') }));
  assert.notDeepEqual(baseline, identity({ projections: selection({ includeControls: false }) }));
  assert.notDeepEqual(baseline, identity({ projections: selection({}, { maximumNodes: 9 }) }));
});

test('the CALM validator subprocess receives no ambient credentials and strips terminal escapes', async () => {
  const capabilitySnapshot = createArchitectureCapabilitySnapshot({
    version: 2,
    capabilities: { source: { kind: 'delivery', parent: null, architecture: { nodeType: 'service' } } }
  });
  const projection = buildCalmProjection({
    subject: { id: 'isolated-validator' }, sourceManifestSha256: sha256('source'),
    scopeSha256: sha256('scope'), factLedger: { ledgerSha256: sha256('ledger'), facts: [] },
    capabilitySnapshot, configurationSnapshot: createArchitectureConfigurationSnapshot({})
  }).projection;
  let execution;
  process.env.SFLOW_WMC_TEST_SECRET = 'must-not-cross';
  try {
    const result = await validateCalmWithOfficialToolchain(projection, {
      runCommand: async (_command, _args, options) => {
        execution = options;
        return {
          status: 0, stdout: JSON.stringify({ hasErrors: false, diagnostic: '\u001b[31mwarning\u001b[0m' }),
          stderr: '', timedOut: false, aborted: false, error: null
        };
      }
    });
    assert.equal(execution.env.SFLOW_WMC_TEST_SECRET, undefined);
    assert.equal(execution.env.HTTPS_PROXY, '');
    assert.equal(execution.env.NO_COLOR, '1');
    assert.equal(result.normalizedResult.diagnostic, 'warning');
  } finally {
    delete process.env.SFLOW_WMC_TEST_SECRET;
  }
});
