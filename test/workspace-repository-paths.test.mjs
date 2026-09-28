import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  previewWorkspaceConfiguration, previewWorkspaceUpdate, readWorkspace, repairWorkspace,
  rememberWorkspace, updateWorkspaceConfiguration, workspaceStatus
} from '../src/workspace.mjs';
import {
  activateWorkspaceContext, resolveWorkspaceExecutionContext, workspaceMemberContextForRepository
} from '../src/workspace-context.mjs';
import { run } from '../src/util.mjs';

const remote = 'https://example.invalid/repository.git';

function proposedWorkspace(repositories) {
  return {
    baseDirectory: path.join(os.tmpdir(), 'sflow-path-preview'),
    id: 'portable-paths',
    name: 'Portable paths',
    leadRepository: 'lead',
    repositories: Object.fromEntries(Object.entries(repositories).map(([id, repositoryPath]) => [
      id, { url: remote, defaultBranch: 'main', path: repositoryPath }
    ]))
  };
}

function rejectsPath(input, code) {
  assert.throws(() => previewWorkspaceConfiguration(input), (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function writeLegacyManifest(root, repositories) {
  await writeFile(path.join(root, 'workspace.json'), `${JSON.stringify({
    version: 1,
    id: 'legacy-paths',
    name: 'Legacy paths',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    anchor: {
      provider: 'workspace', key: 'legacy-paths', title: 'Legacy paths',
      fetchedAt: '2026-09-28T00:00:00.000Z'
    },
    leadRepository: 'lead',
    repositories: Object.fromEntries(Object.entries(repositories).map(([id, repositoryPath]) => [
      id, { url: remote, defaultBranch: 'main', path: repositoryPath }
    ]))
  }, null, 2)}\n`);
}

test('new workspace paths reject case and ancestor aliases across supported filesystems', () => {
  for (const paths of [
    { lead: 'repos/Service', other: 'repos/service' },
    { lead: 'repos/Service', other: 'repos/service/api' },
    { lead: 'repos/team/app', other: 'repos/TEAM' }
  ]) {
    rejectsPath(proposedWorkspace(paths), 'WORKSPACE_REPOSITORY_PATH_ALIAS');
  }
});

test('new workspace paths reject Windows devices and noncanonical spellings without banning custom names', () => {
  for (const repositoryPath of [
    'repos/CON.txt', 'repos/COM¹', 'repos/LPT³', 'repos/aux', 'repos/team/name.',
    'repos/team/name ', 'repos/team:name', 'repos/.git', 'repos//team',
    'repos/team/./app', 'repos\\team', '/repos/team', 'repos/cafe\u0301'
  ]) {
    rejectsPath(proposedWorkspace({ lead: repositoryPath }), 'WORKSPACE_REPOSITORY_PATH_NONPORTABLE');
  }
  const custom = previewWorkspaceConfiguration(proposedWorkspace({
    lead: 'repos/Product Team/café', other: 'repos/Analytics/reporting'
  }));
  assert.equal(custom.manifest.repositories.lead.path, 'repos/Product Team/café');
  assert.equal(custom.manifest.repositories.other.path, 'repos/Analytics/reporting');
});

test('legacy aliases remain readable and editable, but a newly added alias is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-path-'));
  await writeLegacyManifest(root, { lead: 'repos/Service', other: 'repos/service' });
  const loaded = await readWorkspace(root);
  assert.equal(loaded.repositories.other.path, 'repos/service');
  const caseAliasStatus = await workspaceStatus(root, { level: 'readiness', repositoryId: 'lead' });
  assert.equal(caseAliasStatus.repositories[0].state, 'invalid-path');
  assert.equal(caseAliasStatus.repositories[0].pathAlias.conflictingRepository, 'other');
  const preview = await previewWorkspaceUpdate(root, { name: 'Renamed legacy workspace' });
  assert.equal(preview.manifest.name, 'Renamed legacy workspace');
  assert.equal(preview.manifest.repositories.lead.path, 'repos/Service');
  const result = await updateWorkspaceConfiguration(root, { name: 'Renamed legacy workspace' }, {
    confirmation: 'legacy-paths'
  });
  assert.equal(result.updated, true);
  assert.equal((await readWorkspace(root)).name, 'Renamed legacy workspace');
  assert.equal(JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8')).repositories.other.path,
    'repos/service');

  await assert.rejects(() => previewWorkspaceUpdate(root, {
    repositories: {
      ...loaded.repositories,
      added: { url: remote, defaultBranch: 'main', path: 'repos/SERVICE' }
    }
  }), { code: 'WORKSPACE_REPOSITORY_PATH_ALIAS' });
});

test('repair does not materialize an ambiguous legacy checkout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-repair-'));
  await writeLegacyManifest(root, { lead: 'repos/Service', other: 'repos/service' });
  let cloneCalls = 0;
  await assert.rejects(() => repairWorkspace(root, {
    cloneOperation: async () => { cloneCalls += 1; return { status: 0 }; }
  }), { code: 'WORKSPACE_REPOSITORY_PATH_ALIAS' });
  assert.equal(cloneCalls, 0);
});

test('legacy Windows-reserved path can be read but cannot be newly materialized', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-device-'));
  await writeLegacyManifest(root, { lead: 'repos/CON.txt' });
  assert.equal((await readWorkspace(root)).repositories.lead.path, 'repos/CON.txt');
  assert.equal((await previewWorkspaceUpdate(root, { name: 'Still readable' })).manifest.name,
    'Still readable');
  await assert.rejects(() => repairWorkspace(root, {
    cloneOperation: async () => { throw new Error('unexpected clone'); }
  }), { code: 'WORKSPACE_REPOSITORY_PATH_NONPORTABLE' });
});

test('legacy ready checkout overlaps remain readable but cannot route or repair twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-ready-alias-'));
  const lead = path.join(root, 'repos', 'Service');
  const nested = path.join(lead, 'sub');
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'selection.json');
  await mkdir(nested, { recursive: true });
  for (const checkout of [lead, nested]) {
    run('git', ['init', '-b', 'main'], { cwd: checkout });
    run('git', ['remote', 'add', 'origin', remote], { cwd: checkout });
  }
  await writeLegacyManifest(root, { lead: 'repos/Service' });
  await rememberWorkspace(registry, await readWorkspace(root));
  await activateWorkspaceContext(registry, selection, 'legacy-paths', { detectStory: false });

  // This legacy spelling can name two Git checkouts on a case-sensitive host. Both would pass
  // repositoryStatus's origin check; portability still requires their shared namespace to fail.
  await writeLegacyManifest(root, { lead: 'repos/Service', other: 'repos/Service/sub' });
  assert.deepEqual(Object.keys((await readWorkspace(root)).repositories), ['lead', 'other']);
  const status = await workspaceStatus(root, { level: 'readiness' });
  assert.equal(status.healthy, false);
  assert.deepEqual(status.repositories.map((repository) => repository.state), [
    'invalid-path', 'invalid-path'
  ]);
  assert.equal(status.warnings.filter((warning) => warning.code === 'repository-path-alias').length, 2);
  const selected = await workspaceStatus(root, { level: 'readiness', repositoryId: 'lead' });
  assert.equal(selected.repositories[0].state, 'invalid-path');
  assert.equal(selected.repositories[0].pathAlias.conflictingRepository, 'other');

  await assert.rejects(() => resolveWorkspaceExecutionContext(selection, registry, { cwd: root }), {
    code: 'ACTIVE_WORKSPACE_REPOSITORY_PATH_ALIAS'
  });
  await assert.rejects(() => workspaceMemberContextForRepository(lead, selection, registry, {
    strict: true
  }), { code: 'ACTIVE_WORKSPACE_REPOSITORY_PATH_ALIAS' });
  let cloneCalls = 0;
  await assert.rejects(() => repairWorkspace(root, {
    cloneOperation: async () => { cloneCalls += 1; return { status: 0 }; }
  }), { code: 'WORKSPACE_REPOSITORY_PATH_ALIAS' });
  assert.equal(cloneCalls, 0);
});
