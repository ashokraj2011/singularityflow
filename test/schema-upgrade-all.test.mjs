import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { schemaCensus } from '../src/schema-census.mjs';
import { auditAllWorkspaceSchemas } from '../src/schema-upgrade-all.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-schema-upgrade-all-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, 'workspace-one');
  const checkoutPath = path.join(workspacePath, 'repos', 'app');
  await mkdir(checkoutPath, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: checkoutPath });
  execFileSync('git', ['config', 'user.name', 'Schema Audit Test'], { cwd: checkoutPath });
  execFileSync('git', ['config', 'user.email', 'schema-audit@example.test'], { cwd: checkoutPath });
  await writeFile(path.join(checkoutPath, 'README.md'), '# Fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: checkoutPath });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: checkoutPath });
  const statePath = path.join(checkoutPath, '.git', 'singularity-flow', 'session.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  const manifest = (id, container, repository = {}) => ({
    version: 1,
    id,
    name: id,
    path: container,
    anchor: { provider: 'workspace', key: id, title: id },
    leadRepository: 'app',
    repositories: {
      app: {
        id: 'app', url: 'https://example.test/app.git', defaultBranch: 'main',
        required: true, path: 'repos/app', role: 'lead', capabilities: [], ...repository
      }
    }
  });
  const addWorkspace = async (id, container = workspacePath, repository = {}) => {
    await mkdir(container, { recursive: true });
    await writeFile(path.join(container, 'workspace.json'),
      `${JSON.stringify(manifest(id, container, repository))}\n`);
    return { id, path: container, name: id, openedAt: '2026-09-01T00:00:00.000Z' };
  };
  const first = await addWorkspace('workspace-one');
  const registryFile = path.join(root, 'workspaces.json');
  const saveRegistry = async (entries) => writeFile(registryFile, `${JSON.stringify(entries)}\n`);
  await saveRegistry([first]);
  return { root, workspacePath, checkoutPath, statePath, registryFile, first, addWorkspace, saveRegistry };
}

test('audits every active checkout through read-time migrations without changing stored bytes', async (t) => {
  const example = await fixture(t);
  const stored = '{"schemaVersion":1,"sessions":{}}\n';
  await writeFile(example.statePath, stored);
  await example.saveRegistry([
    example.first,
    {
      id: 'archived-workspace', path: path.join(example.root, 'archived'),
      name: 'archived-workspace', openedAt: '2026-09-01T00:00:00.000Z',
      archivedAt: '2026-09-02T00:00:00.000Z'
    }
  ]);
  const registryBefore = await readFile(example.registryFile);
  const manifestBefore = await readFile(path.join(example.workspacePath, 'workspace.json'));
  const calls = [];
  const result = await auditAllWorkspaceSchemas({ registryFile: example.registryFile }, {
    schemaCensus: async (root, options) => {
      calls.push({ root, options });
      return schemaCensus(root, options);
    }
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.registryValidation, 'passed');
  assert.deepEqual(result.coverage.manifestValidation, { passed: 1, failed: 0 });
  assert.equal(result.coverage.activeWorkspaces, 1);
  assert.equal(result.coverage.archivedWorkspaces, 1);
  assert.equal(result.coverage.uniqueCheckouts, 1);
  assert.equal(result.coverage.scannedCheckouts, 1);
  assert.equal(result.totals.migratedRecords, 1);
  assert.equal(result.totals.migrationSteps, 1);
  assert.deepEqual(result.repositories[0].migrations.map((item) => item.family), ['session-registry']);
  assert.deepEqual(calls, [{ root: await realpath(example.checkoutPath), options: { includeLifecycleRefs: true } }]);
  assert.equal(result.policy.storedRecordsRewritten, 0);
  assert.equal(result.skipped[0].code, 'WORKSPACE_ARCHIVED');
  assert.equal(await readFile(example.statePath, 'utf8'), stored);
  assert.deepEqual(await readFile(example.registryFile), registryBefore);
  assert.deepEqual(await readFile(path.join(example.workspacePath, 'workspace.json')), manifestBefore);
});

test('deduplicates a shared checkout and blocks versions outside the readable range', async (t) => {
  const example = await fixture(t);
  await writeFile(example.statePath, '{"schemaVersion":999,"sessions":{}}\n');
  const secondPath = path.join(example.root, 'workspace-two');
  const second = await example.addWorkspace('workspace-two', secondPath, {
    adoption: {
      mode: 'existing-clone', canonicalPath: example.checkoutPath,
      proofHash: `sha256:${'a'.repeat(64)}`,
      reviewedAt: '2026-09-01T00:00:00.000Z'
    }
  });
  await example.saveRegistry([example.first, second]);
  let scans = 0;
  const result = await auditAllWorkspaceSchemas({ registryFile: example.registryFile }, {
    schemaCensus: async (root, options) => {
      scans += 1;
      return schemaCensus(root, options);
    }
  });

  assert.equal(scans, 1);
  assert.equal(result.status, 'blocked');
  assert.equal(result.coverage.activeWorkspaces, 2);
  assert.equal(result.coverage.declaredRepositories, 2);
  assert.equal(result.coverage.uniqueCheckouts, 1);
  assert.equal(result.repositories[0].memberships.length, 2);
  assert.equal(result.totals.outsideRange, 1);
  assert.ok(result.blocked.some((item) => item.code === 'SCHEMA_VERSION_OUTSIDE_RANGE'));
  assert.deepEqual(result.repositories[0].findings, [{
    category: 'outside-range', path: '$git/session.json',
    family: 'session-registry', storedVersion: 999, code: 'SCHEMA_VERSION_FUTURE'
  }]);
  assert.equal(result.blocked.find((item) => item.code === 'SCHEMA_VERSION_OUTSIDE_RANGE')
    .findings[0].path, '$git/session.json');
});

test('reports unavailable workspace and checkout coverage as partial', async (t) => {
  const example = await fixture(t);
  await rm(example.checkoutPath, { recursive: true, force: true });
  await example.saveRegistry([
    example.first,
    {
      id: 'missing-manifest', path: path.join(example.root, 'missing-manifest'),
      name: 'missing-manifest', openedAt: '2026-09-02T00:00:00.000Z'
    }
  ]);
  const result = await auditAllWorkspaceSchemas({ registryFile: example.registryFile });

  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.manifestValidation.failed, 1);
  assert.equal(result.coverage.skippedCheckouts, 1);
  assert.equal(result.coverage.scannedCheckouts, 0);
  assert.ok(result.blocked.some((item) => item.code === 'WORKSPACE_MANIFEST_UNREADABLE'));
  assert.ok(result.skipped.some((item) => item.code === 'CHECKOUT_UNAVAILABLE'));
});

test('does not report completion when the registry has no active workspaces', async (t) => {
  const example = await fixture(t);
  await example.saveRegistry([]);
  const result = await auditAllWorkspaceSchemas({ registryFile: example.registryFile });

  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.activeWorkspaces, 0);
  assert.equal(result.coverage.scannedCheckouts, 0);
  assert.ok(result.blocked.some((item) => item.code === 'NO_ACTIVE_WORKSPACES'));
});

test('redacts malformed manifest content from coverage failures', async (t) => {
  const example = await fixture(t);
  await writeFile(path.join(example.workspacePath, 'workspace.json'),
    '{"apiKey":"must-not-appear",broken}\n');

  const result = await auditAllWorkspaceSchemas({ registryFile: example.registryFile });
  assert.equal(result.status, 'partial');
  assert.ok(result.blocked.some((item) => item.code === 'WORKSPACE_MANIFEST_UNREADABLE'));
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear|SyntaxError/);
});

test('refuses an invalid registry without exposing its content', async (t) => {
  const example = await fixture(t);
  await writeFile(example.registryFile, '{"apiKey":"must-not-appear",broken}\n');

  await assert.rejects(
    auditAllWorkspaceSchemas({ registryFile: example.registryFile }),
    (error) => error.code === 'WORKSPACE_REGISTRY_INVALID'
      && !/must-not-appear|SyntaxError/.test(error.message)
  );
});

test('bounds record findings while preserving the full blocked count', async (t) => {
  const example = await fixture(t);
  const result = await auditAllWorkspaceSchemas({ registryFile: example.registryFile }, {
    schemaCensus: async () => ({
      healthy: true, truncated: false, scannedFiles: 25, families: [], unreadable: [],
      unregistered: Array.from({ length: 25 }, (_, index) => ({
        path: index === 0 ? '/private/must-not-appear.json'
          : `singularity/unknown-${index}.json`, schemaVersion: 1
      })),
      totals: {
        registeredRecords: 0, validatedRecords: 0, readTimeMigrationRecords: 0,
        readTimeMigrationSteps: 0, observedFamilies: 0, outsideRange: 0,
        unreadable: 0, unregistered: 25
      }
    })
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.totals.unregistered, 25);
  assert.equal(result.repositories[0].findings.length, 20);
  assert.equal(result.repositories[0].findingsOmitted, 5);
  assert.equal(result.repositories[0].findings[0].path, '[unsafe path withheld]');
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear/);
});
