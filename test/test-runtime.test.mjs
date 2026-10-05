import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTestRuntime, testRuntimeEnvironment, testRuntimeIdentity } from '../src/test-runtime.mjs';
import { normalizeRepositoryReadinessPolicy, resolveWorkType } from '../src/config.mjs';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

test('approved runtime is closed, test-only, idempotent and never mutates ambient environment', () => {
  assert.deepEqual(normalizeTestRuntime(), { nodeOptions: [] });
  for (const value of [null, [], { nodeOptions: null }, { env: { SECRET: 'value' } }, { nodeOptions: ['--require=unreviewed-code'] }, { nodeOptions: '--no-experimental-webstorage' }]) {
    assert.throws(() => normalizeTestRuntime(value), /supports only/);
  }
  assert.throws(() => normalizeRepositoryReadinessPolicy({ baselinePolicy: 'skip' }), /required or choice/);
  assert.throws(() => normalizeRepositoryReadinessPolicy({ baselinePolicy: null }), /required or choice/);
  const profile = { nodeOptions: ['--no-experimental-webstorage'] };
  const ambient = Object.freeze({ NODE_OPTIONS: '--trace-warnings', SECRET: 'never published' });
  if (!process.allowedNodeEnvironmentFlags.has(profile.nodeOptions[0])) {
    assert.throws(() => testRuntimeEnvironment(profile, ambient), /does not support/);
    return;
  }
  const actual = testRuntimeEnvironment(profile, ambient);
  assert.equal(actual.NODE_OPTIONS, '--trace-warnings --no-experimental-webstorage');
  assert.deepEqual(testRuntimeEnvironment(profile, actual), actual);
  assert.equal(ambient.NODE_OPTIONS, '--trace-warnings');
  const identity = testRuntimeIdentity(profile, ambient);
  assert.ok(!JSON.stringify(identity).includes('never published'));
  assert.ok(!JSON.stringify(identity).includes('--trace-warnings'));
  assert.notEqual(identity.sha256, testRuntimeIdentity(profile, { NODE_OPTIONS: '--trace-uncaught' }).sha256);
});

test('the approved test runtime is pinned once in workflow resolution for later phases', async () => {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  definition.repositoryReadiness.testRuntime = { nodeOptions: ['--no-experimental-webstorage'] };
  definition.agentCatalog = Object.keys(definition.phases).map(id => ({ id: `agent-${id}`, defaultFor: [id] }));
  definition.agents = Object.fromEntries(definition.agentCatalog.map(agent => [agent.id, { id: agent.id }]));
  const resolved = resolveWorkType(definition, 'feature');
  definition.repositoryReadiness.testRuntime.nodeOptions.length = 0;
  assert.deepEqual(resolved.testRuntime.nodeOptions, ['--no-experimental-webstorage']);
});
