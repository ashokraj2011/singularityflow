/**
 * The registered machine-local healers: a registry projection that drifted from its manifest, and
 * clone staging an interrupted clone left behind. Each heals only what it can prove, and leaves
 * everything it cannot prove exactly as it was.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { versionLine } from '../src/build-info.mjs';
import { firstRunPass } from '../src/first-run-pass.mjs';
import { firstRunPassDue } from '../src/product-alignment-gate.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import {
  healOrphanCloneStaging, healStaleWorkspaceRegistry, orphanCloneStagingRoots, readWorkspace,
  readWorkspaceRegistry, rememberWorkspace, staleWorkspaceRegistryEntries
} from '../src/workspace.mjs';

const HOUR = 60 * 60 * 1000;

async function machine(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-local-healers-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, registry: path.join(base, 'machine', 'workspaces.json'), bootstrapRoot: path.join(base, 'machine', 'bootstrap') };
}

async function workspace(item, id, { name = `Workspace ${id}`, repositories = { app: 'repos/app' } } = {}) {
  const root = path.join(item.base, id);
  await mkdir(root, { recursive: true });
  await writeManifest(root, { id, name, repositories });
  await rememberWorkspace(item.registry, await readWorkspace(root));
  return root;
}

async function writeManifest(root, { id, name, repositories }) {
  await writeFile(path.join(root, 'workspace.json'), `${JSON.stringify({
    version: 1, id, name,
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
    anchor: { provider: 'workspace', key: id, title: name, fetchedAt: '2026-09-28T00:00:00.000Z' },
    leadRepository: Object.keys(repositories)[0],
    repositories: Object.fromEntries(Object.entries(repositories).map(([repository, relative]) => [
      repository, { url: 'https://example.invalid/repository.git', defaultBranch: 'main', path: relative }
    ]))
  }, null, 2)}\n`);
}

async function staging(root, { repositoryId = 'app', bootstrapId = 'workspace-alpha', ageMs = 7 * HOUR, extra = null } = {}) {
  const parent = path.join(root, 'repos');
  await mkdir(parent, { recursive: true });
  const directory = path.join(parent, `.sflow-clone-${randomUUID().slice(0, 6)}`);
  await mkdir(path.join(directory, 'repository', '.git'), { recursive: true });
  await writeFile(path.join(directory, 'repository', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(directory, '.sflow-bootstrap-owner.json'), `${JSON.stringify({
    schemaVersion: currentSchemaVersion('workspace-bootstrap-owner'),
    bootstrapId, repositoryId,
    canonicalPath: directory,
    targetPath: path.join(parent, repositoryId),
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    nonce: randomUUID()
  }, null, 2)}\n`);
  if (extra) await writeFile(path.join(directory, extra), 'not session-owned\n');
  return directory;
}

const exists = (file) => lstat(file).then(() => true, () => false);

test('a registry projection that drifted from its manifest is rewritten from it, and nothing else is', async (t) => {
  const item = await machine(t);
  const renamed = await workspace(item, 'alpha', { name: 'Original' });
  const missing = await workspace(item, 'beta');
  const archivedRoot = await workspace(item, 'gamma', { name: 'Archived original' });
  const before = await readWorkspaceRegistry(item.registry);
  // Archive one entry directly, the way archive leaves it.
  await writeFile(item.registry, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('workspace-registry'),
    workspaces: before.map((entry) => (entry.path === archivedRoot ? { ...entry, archivedAt: '2026-09-28T01:00:00.000Z' } : entry))
  }, null, 2)}\n`);
  await writeManifest(renamed, { id: 'alpha', name: 'Renamed', repositories: { app: 'repos/app' } });
  await writeManifest(archivedRoot, { id: 'gamma', name: 'Renamed while archived', repositories: { app: 'repos/app' } });
  await rm(missing, { recursive: true, force: true });

  const stale = await staleWorkspaceRegistryEntries(item.registry);
  assert.deepEqual(stale.map((entry) => [entry.path, entry.fields]), [[renamed, ['name']]]);

  const { result, receipt } = await healStaleWorkspaceRegistry(item.registry);
  assert.equal(receipt.id, 'stale-workspace-registry');
  assert.deepEqual(receipt.postconditions.map((entry) => [entry.id, entry.status]), [['registry-resolves-workspace', 'pass']]);
  assert.deepEqual(result.healed, [{ path: renamed, fields: ['name'] }]);
  const after = await readWorkspaceRegistry(item.registry);
  const entry = (root) => after.find((candidate) => candidate.path === root);
  assert.equal(entry(renamed).name, 'Renamed');
  assert.equal(entry(renamed).openedAt, before.find((candidate) => candidate.path === renamed).openedAt,
    'healing keeps when the workspace was last opened');
  assert.ok(entry(missing), 'a workspace whose directory is gone keeps its registration');
  assert.equal(entry(archivedRoot).name, 'Archived original', 'archived history is never rewritten');
  assert.deepEqual(await staleWorkspaceRegistryEntries(item.registry), []);
  assert.deepEqual((await healStaleWorkspaceRegistry(item.registry)).result.healed, [], 'a second pass has nothing to do');
});

test('clone staging an interrupted clone left behind is removed only when every ownership check holds', async (t) => {
  const item = await machine(t);
  const root = await workspace(item, 'alpha');
  const orphan = await staging(root);
  const young = await staging(root, { ageMs: HOUR });
  const foreign = await staging(root, { extra: 'notes.txt' });
  const leased = await staging(root, { bootstrapId: 'bst_0123456789abcdef0123' });
  await mkdir(path.join(item.bootstrapRoot, 'leases'), { recursive: true });
  await writeFile(path.join(item.bootstrapRoot, 'leases', 'bst_0123456789abcdef0123.lock'), '{}\n');
  const copied = await staging(root);
  const moved = path.join(root, 'repos', '.sflow-clone-copied');
  await import('node:fs/promises').then(({ rename }) => rename(copied, moved));
  const outside = await mkdtemp(path.join(item.base, 'outside-'));
  await symlink(outside, path.join(root, 'repos', '.sflow-clone-link'));

  const found = await orphanCloneStagingRoots(item.registry, { bootstrapRoot: item.bootstrapRoot });
  assert.deepEqual(found.map((entry) => entry.path), [orphan],
    'young, foreign-content, leased, moved and symlinked staging are all left alone');

  const { result, receipt } = await healOrphanCloneStaging(item.registry, { bootstrapRoot: item.bootstrapRoot });
  assert.equal(receipt.id, 'orphan-bootstrap-staging');
  assert.deepEqual(receipt.postconditions.map((entry) => [entry.id, entry.status]), [['staging-directory-absent', 'pass']]);
  assert.deepEqual(result.removed.map((entry) => entry.path), [orphan]);
  assert.equal(await exists(orphan), false);
  for (const kept of [young, foreign, leased, moved, outside]) assert.equal(await exists(kept), true, kept);

  // A lease that is no longer fresh no longer protects its staging.
  const stale = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(path.join(item.bootstrapRoot, 'leases', 'bst_0123456789abcdef0123.lock'), stale, stale);
  assert.deepEqual((await orphanCloneStagingRoots(item.registry, { bootstrapRoot: item.bootstrapRoot }))
    .map((entry) => entry.path), [leased]);
});

test('a clone the workspace journal shows running is never treated as an orphan', async (t) => {
  const item = await machine(t);
  const root = await workspace(item, 'alpha');
  const inFlight = await staging(root);
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await writeFile(path.join(root, 'logs', 'workspace-materialization.json'), `${JSON.stringify({
    operations: [{ repository: 'app', status: 'running', startedAt: new Date(Date.now() - HOUR).toISOString() }]
  })}\n`);
  assert.deepEqual(await orphanCloneStagingRoots(item.registry, { bootstrapRoot: item.bootstrapRoot }), []);
  const { result } = await healOrphanCloneStaging(item.registry, { bootstrapRoot: item.bootstrapRoot });
  assert.deepEqual(result.removed, []);
  assert.equal(await exists(inFlight), true);
  assert.match(await readFile(path.join(inFlight, 'repository', '.git', 'HEAD'), 'utf8'), /refs\/heads\/main/u);
});

const STAMPED = Object.freeze({
  commit: 'c'.repeat(40), sourceSha256: null, branch: null, dirty: false, builtAt: '2026-09-28T00:00:00.000Z'
});

test('a new build\'s first run repairs machine-local state once, and records it', async (t) => {
  const item = await machine(t);
  const home = path.join(item.base, 'home');
  const root = await workspace(item, 'alpha', { name: 'Original' });
  await writeManifest(root, { id: 'alpha', name: 'Renamed', repositories: { app: 'repos/app' } });
  const orphan = await staging(root);
  const environment = {
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: item.registry, SINGULARITY_FLOW_BOOTSTRAP_STATE: item.bootstrapRoot
  };
  const lines = [];
  const spawned = [];
  const reviews = [];
  const outcome = await firstRunPass({
    runningBuild: versionLine(STAMPED), argv: ['next'], homeDirectory: home, environment,
    execute: (...call) => { spawned.push(call); throw new Error('no subprocess is expected'); },
    exists: () => false, write: (entry) => lines.push(entry),
    startReviews: async (options) => { reviews.push(options); return { status: 'started', pid: 1 }; }
  });
  assert.equal(outcome.status, 'no-receipt');
  assert.deepEqual(reviews.map((entry) => entry.runningBuild), [versionLine(STAMPED)],
    'the pass starts this build\'s background configuration reviews once');
  assert.equal(outcome.configurationReviews, 'started');
  assert.ok(lines.some((entry) => /packaged configuration against your registered repositories in the background/u.test(entry)));
  assert.deepEqual(outcome.healers.map((entry) => [entry.id, entry.outcome, entry.count]), [
    ['stale-workspace-registry', 'healed', 1], ['orphan-bootstrap-staging', 'healed', 1]
  ]);
  assert.deepEqual(spawned, [], 'with no installation receipt there is no product inventory to spawn');
  assert.equal((await readWorkspaceRegistry(item.registry)).find((entry) => entry.path === root).name, 'Renamed');
  assert.equal(await exists(orphan), false);
  assert.equal(lines.filter((entry) => /repaired 1 item/u.test(entry)).length, 2);
  assert.equal(await firstRunPassDue({
    command: 'next', classification: 'mutation', homeDirectory: home, environment: {}, info: STAMPED
  }), null, 'the build does not run its pass twice');
});

test('a healer that cannot run is reported and never fails the command', async (t) => {
  const item = await machine(t);
  const home = path.join(item.base, 'home');
  await mkdir(path.dirname(item.registry), { recursive: true });
  await writeFile(item.registry, '{ not json');
  const lines = [];
  const outcome = await firstRunPass({
    runningBuild: versionLine(STAMPED), argv: ['next'], homeDirectory: home,
    environment: { SINGULARITY_FLOW_WORKSPACE_REGISTRY: item.registry, SINGULARITY_FLOW_BOOTSTRAP_STATE: item.bootstrapRoot },
    execute: () => { throw new Error('no subprocess is expected'); }, exists: () => false,
    write: (entry) => lines.push(entry), startReviews: async () => ({ status: 'no-workspaces' })
  });
  assert.deepEqual(outcome.healers.map((entry) => [entry.id, entry.outcome, entry.code]), [
    ['stale-workspace-registry', 'failed', 'WORKSPACE_REGISTRY_INVALID'],
    ['orphan-bootstrap-staging', 'failed', 'WORKSPACE_REGISTRY_INVALID']
  ]);
  assert.ok(lines.some((entry) => /could not repair machine-local state \(stale-workspace-registry\)/u.test(entry)));
  assert.equal(await readFile(item.registry, 'utf8'), '{ not json', 'an unreadable registry is never rewritten');
});

