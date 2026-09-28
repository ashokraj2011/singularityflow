import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

test('one schema migration command reports incomplete empty scope without writing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-schema-upgrade-cli-'));
  try {
    const env = {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'active.json')
    };
    const result = spawnSync(process.execPath, [cli, 'workspace', 'migrate-schemas', '--json'], {
      cwd: directory, env, encoding: 'utf8'
    });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.resultType, 'schema-upgrade-all');
    assert.equal(report.status, 'partial');
    assert.equal(report.policy.mode, 'read-time');
    assert.equal(report.policy.storedRecordsRewritten, 0);
    assert.equal(report.coverage.complete, false);
    assert.equal(report.blocked[0].code, 'NO_ACTIVE_WORKSPACES');

    const extra = spawnSync(process.execPath, [cli, 'workspace', 'migrate-schemas', 'unreviewed', '--json'], {
      cwd: directory, env, encoding: 'utf8'
    });
    assert.equal(extra.status, 1, extra.stderr || extra.stdout);
    assert.equal(JSON.parse(extra.stderr || extra.stdout).error.code, 'SCHEMA_UPGRADE_OPTIONS_INVALID');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
