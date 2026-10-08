import test from 'node:test';
import assert from 'node:assert/strict';
import { planWorldModelConfigurationMigration } from '../src/world-model/migration/configuration.mjs';
import { BUILTIN_VIEW_REFERENCES } from '../src/world-model/registry/views.mjs';

test('migration changes the catalog and bridge together without weakening custom policy', () => {
  const definition = {
    worldModel: { views: ['architecture', 'testing'], grounding: 'enforce',
      outputDir: 'custom/model', historyDir: 'custom/history', sourceRoots: ['apps/api'],
      v4: { composer: 'model-optional', totalMaximumOutputTokens: 1000 } },
    phases: { build: { worldModel: { views: ['testing'] }, approvals: ['engineers'] } }
  };
  const before = structuredClone(definition);
  const result = planWorldModelConfigurationMigration(definition);
  assert.deepEqual(definition, before, 'pure preview must not normalize its source');
  assert.equal(result.definition.worldModel.format, 'registered-v4');
  assert.deepEqual(result.definition.worldModel.views, BUILTIN_VIEW_REFERENCES);
  assert.equal(result.definition.worldModel.v4.legacyAssignments, 'inherit-configured');
  assert.equal(result.definition.worldModel.v4.composer, 'model-optional');
  for (const field of ['grounding', 'outputDir', 'historyDir', 'sourceRoots']) {
    assert.deepEqual(result.definition.worldModel[field], before.worldModel[field]);
  }
  assert.deepEqual(result.definition.phases, before.phases);
  assert.equal(result.report.historicalArtifacts, 'preserved');
  assert.equal(result.report.storiesRepinned, false);
  assert.equal(result.report.rebuildRequired, true);
});

test('capability migration changes only closed legacy view obligations, including inherited parents', () => {
  const capabilities = { version: 2, management: { mode: 'sflow-cli' }, capabilities: {
    parent: { kind: 'collection', policy: { requiredWorldModelViews: ['security'], approvalMinimum: 2 } },
    web: { kind: 'delivery', parent: 'parent', title: 'Web', repositories: ['web-ui'],
      sourceRoots: ['apps/web'], policy: { requiredWorldModelViews: ['testing', 'development'], gateSeverity: 'enforce' } },
    empty: { kind: 'collection', policy: { requiredWorldModelViews: [] } }
  } };
  const before = structuredClone(capabilities);
  const result = planWorldModelConfigurationMigration({}, capabilities);
  assert.deepEqual(capabilities, before);
  assert.equal(result.capabilities.version, 2);
  assert.deepEqual(result.report.capabilityAssignments.map(entry => entry.capability), ['parent', 'web']);
  for (const id of ['parent', 'web']) {
    const expected = structuredClone(before.capabilities[id]);
    expected.policy.requiredWorldModelViews = result.report.views.map(view => view.split('@')[0]);
    assert.deepEqual(result.capabilities.capabilities[id], expected);
  }
  assert.deepEqual(result.capabilities.capabilities.empty, before.capabilities.empty);
});

test('registered custom catalogs and strict policy are preserved and repeated migration is a no-op', () => {
  const current = { worldModel: { format: 'registered-v4', views: ['dev.impact@4'],
    v4: { legacyAssignments: 'strict', composer: 'model-required' } } };
  const result = planWorldModelConfigurationMigration(current);
  assert.deepEqual(result.definition, current);
  assert.equal(result.report.rebuildRequired, false);
  const first = planWorldModelConfigurationMigration({});
  assert.deepEqual(planWorldModelConfigurationMigration(first.definition).definition, first.definition);
});

for (const [views, code] of [
  [[], 'WMB_MIGRATION_CATALOG_INVALID'],
  [['testing', 'testing'], 'WMB_MIGRATION_CATALOG_INVALID'],
  [['testing', 'dev.impact@4'], 'WMB_VIEW_ASSIGNMENT_MIXED'],
  [['typo'], 'WMB_VIEW_UNKNOWN'],
  [['dev.impact@99'], 'WMB_VIEW_VERSION_UNSUPPORTED']
]) test(`migration refuses unreviewable catalog ${JSON.stringify(views)}`, () => {
  assert.throws(() => planWorldModelConfigurationMigration({ worldModel: { views } }),
    error => error.code === code);
});

test('unknown, mixed or undeclared capability assignments are refused, not dropped', () => {
  for (const views of [['testing', 'dev.impact'], ['typo'], ['arch.contracts@4']]) {
    assert.throws(() => planWorldModelConfigurationMigration({ worldModel: {
      format: 'registered-v4', views: ['dev.impact@4']
    } }, { capabilities: { web: { policy: { requiredWorldModelViews: views } } } }));
  }
});
