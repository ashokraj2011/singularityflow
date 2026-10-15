import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workflowIntentCapabilities } from '../src/workflow-intent-capabilities.mjs';

test('explicit designer capabilities prove the current compiler without granting host or group authority', async () => {
  const result = await workflowIntentCapabilities();
  assert.equal(result.protocol, 1);
  assert.deepEqual(result.grammarVersions, [2]);
  assert.equal(result.cli.compile, true);
  assert.equal(result.cli.documentation, true);
  assert.deepEqual(result.cli.docs.map(topic => topic.id), ['workflow-intent', 'workflow-markup']);
  assert.equal(result.permissionEffect, 'none');
  assert.match(result.engine.sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.meaning, /exposure.*membership.*approval.*not established/u);
});

test('installed preflight is model-free and supplies a bound catalog and exact group choices', () => {
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--no-model', 'workflow', 'intent', 'preflight', '--source', 'installed', '--json'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.resultType, 'workflow-intent-preflight');
  assert.equal(packet.sourceSha256, packet.catalog.sourceSha256);
  assert.ok(packet.approvalAuthorities.length);
  assert.ok(packet.approvalAuthorities.every(group => typeof group.id === 'string'));
  assert.equal(packet.approvalRecorded, false);
  assert.equal(packet.capabilities.cli.compile, true);
  const stale = spawnSync(process.execPath, [cli, 'workflow', 'intent', 'preflight', '--source', 'installed', '--expected-source', 'sha256:' + '0'.repeat(64), '--json'], {
    encoding: 'utf8', timeout: 30_000
  });
  assert.notEqual(stale.status, 0); assert.match(stale.stdout, /WORKFLOW_INTENT_CATALOG_STALE/u);
});
