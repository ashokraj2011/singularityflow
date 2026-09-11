import assert from 'node:assert/strict';
import test from 'node:test';

import {
  architectureProjectionDiff, createArchitectureExportPlan
} from '../src/commands/architecture.mjs';
import { sha256 } from '../src/world-model/canonicalize.mjs';

test('architecture export confirmation binds exact target, bytes, and planned status', () => {
  const input = {
    target: 'dist/architecture/system.json',
    projectionSha256: sha256('projection'),
    planned: false
  };
  const first = createArchitectureExportPlan(input);
  assert.deepEqual(first, createArchitectureExportPlan(input));
  assert.notEqual(first.planSha256, createArchitectureExportPlan({
    ...input, target: 'dist/architecture/other.json'
  }).planSha256);
  assert.notEqual(first.planSha256, createArchitectureExportPlan({
    ...input, planned: true
  }).planSha256);
  assert.deepEqual(first.effects, [
    'create-one-repository-file', 'leave-world-model-authority-unchanged'
  ]);
});

test('architecture diff reports stable element-level additions and changes', () => {
  const projection = {
    $schema: 'https://calm.finos.org/release/1.2/meta/calm.json',
    $id: 'urn:test:architecture', nodes: [{
      'unique-id': 'api', 'node-type': 'service', name: 'API', description: 'API', interfaces: []
    }], relationships: [], controls: {}, flows: [], adrs: []
  };
  const after = structuredClone(projection);
  after.nodes[0].name = 'Public API';
  after.nodes.push({
    'unique-id': 'db', 'node-type': 'database', name: 'Database', description: 'Database', interfaces: []
  });
  assert.deepEqual(architectureProjectionDiff(projection, after), {
    identical: false,
    added: [{ kind: 'node', id: 'db' }],
    removed: [],
    changed: [{ kind: 'node', id: 'api' }]
  });
});
