import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createWorkspace, fetchWorkspace, forgetWorkspace, listWorkspaceDocuments,
  normalizeWorkspaceAnchor, previewWorkspace, readWorkspace, readWorkspaceRegistry,
  rememberWorkspace, resolveWorkspaceDocument, stageWorkspaceDocuments,
  validateWorkspaceManifest, workspaceStatus
} from '../src/workspace.mjs';
import { run } from '../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function remoteRepository(base, name) {
  const source = path.join(base, `${name}-source`);
  const bare = path.join(base, `${name}.git`);
  run('git', ['init', '-b', 'main', source], { cwd: base });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), `# ${name}\n`);
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'initial'], { cwd: source });
  run('git', ['clone', '--bare', source, bare], { cwd: base });
  return bare;
}

function workspaceInput(baseDirectory, repositories) {
  return {
    baseDirectory,
    anchor: {
      provider: 'jira',
      baseUrl: 'https://office.atlassian.net',
      key: 'PAY-100',
      issueTypeId: '10000',
      issueTypeName: 'Business Initiative',
      hierarchyLevel: 2,
      title: 'Payments modernization'
    },
    leadRepository: 'platform',
    repositories
  };
}

test('workspace anchors follow Jira hierarchy levels without hard-coded Initiative naming', () => {
  const anchor = normalizeWorkspaceAnchor({
    baseUrl: 'https://office.atlassian.net',
    key: 'pay-100',
    issueTypeName: 'Portfolio Goal',
    hierarchyLevel: 3,
    title: 'Payments'
  });
  assert.equal(anchor.key, 'PAY-100');
  assert.equal(anchor.siteId, 'office.atlassian.net');
  assert.equal(anchor.issueTypeName, 'Portfolio Goal');
  assert.throws(() => normalizeWorkspaceAnchor({
    baseUrl: 'https://office.atlassian.net',
    key: 'PAY-101',
    issueTypeName: 'Story',
    hierarchyLevel: 0
  }), /below Epic/);
});

test('workspace manifest keeps repositories isolated below repos and requires a lead', () => {
  const base = {
    version: 1,
    id: 'office--PAY-100',
    anchor: {
      siteId: 'office',
      key: 'PAY-100',
      issueTypeName: 'Epic',
      hierarchyLevel: 1
    },
    leadRepository: 'mobile',
    repositories: {
      mobile: { url: 'git@example/mobile.git', path: 'repos/mobile', defaultBranch: 'main' }
    }
  };
  assert.equal(validateWorkspaceManifest(base).repositories.mobile.role, 'lead');
  const escaped = structuredClone(base);
  escaped.repositories.mobile.path = '../mobile';
  assert.throws(() => validateWorkspaceManifest(escaped), /inside the workspace/);
  const missing = structuredClone(base);
  missing.leadRepository = 'api';
  assert.throws(() => validateWorkspaceManifest(missing), /not in the workspace registry/);
  const unsafeLogs = structuredClone(base);
  unsafeLogs.directories = { logs: 'documents/logs' };
  assert.throws(() => validateWorkspaceManifest(unsafeLogs), /must be logs/);
  const unsafeClone = structuredClone(base);
  unsafeClone.repositories.mobile.url = '--upload-pack=malicious';
  assert.throws(() => validateWorkspaceManifest(unsafeClone), /unsafe clone URL/);
});

test('workspace creates isolated clones, stages ungoverned documents, and can be reconstructed from its manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-'));
  const mobile = await remoteRepository(root, 'mobile');
  const platform = await remoteRepository(root, 'platform');
  const baseDirectory = path.join(root, 'workspaces');
  const input = workspaceInput(baseDirectory, {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform', metadata: { appId: 'APP-PLATFORM', name: 'Shared platform' } },
    mobile: { url: mobile, defaultBranch: 'main', required: true, path: 'repos/mobile', metadata: { appId: 'APP-MOBILE', owner: 'Digital' } }
  });
  const preview = previewWorkspace(input);
  assert.match(preview.root, /PAY-100--payments-modernization$/);
  assert.equal(preview.operations.length, 2);
  await assert.rejects(() => createWorkspace(input, { confirmation: 'WRONG' }), /exact Jira-key confirmation/);

  const created = await createWorkspace(input, { confirmation: 'PAY-100' });
  assert.equal(created.created, true);
  assert.equal(created.status.healthy, true);
  assert.notEqual(created.status.repositories[0].absolutePath, created.status.repositories[1].absolutePath);
  const loaded = await readWorkspace(created.workspace.path);
  assert.equal(loaded.anchor.issueTypeName, 'Business Initiative');
  assert.equal(loaded.localOnly, true);
  assert.deepEqual(loaded.repositories.platform.metadata, { appId: 'APP-PLATFORM', name: 'Shared platform' });
  assert.deepEqual(loaded.repositories.mobile.metadata, { appId: 'APP-MOBILE', owner: 'Digital' });

  const requirement = path.join(root, 'requirement.pdf');
  await writeFile(requirement, 'pinned requirement');
  const staged = await stageWorkspaceDocuments(created.workspace.path, [requirement]);
  assert.equal(staged.added[0].status, 'staged-not-governed');
  assert.match(staged.warning, /not governed/);
  assert.equal((await listWorkspaceDocuments(created.workspace.path)).length, 1);
  const resolved = await resolveWorkspaceDocument(created.workspace.path, staged.added[0].path);
  assert.equal(resolved.absolutePath, path.join(created.workspace.path, staged.added[0].path));
  await assert.rejects(
    () => resolveWorkspaceDocument(created.workspace.path, 'documents/inbox/missing.pdf'),
    /not in the staged-document inbox/
  );

  const lead = created.status.leadRepositoryPath;
  await writeFile(path.join(lead, 'local.txt'), 'dirty');
  const fetched = await fetchWorkspace(created.workspace.path);
  assert.equal(fetched.results.find((item) => item.repository === 'platform').reason, 'dirty');
});

test('workspace registry is local, bounded, and forget never deletes workspace files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-registry-'));
  const registry = path.join(root, 'registry.json');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: path.join(root, 'uncloned.git'), defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  await rememberWorkspace(registry, created.workspace, created.status);
  let entries = await readWorkspaceRegistry(registry);
  assert.equal(entries[0].anchorKey, 'PAY-100');
  await forgetWorkspace(registry, created.workspace.path);
  entries = await readWorkspaceRegistry(registry);
  assert.deepEqual(entries, []);
  assert.equal(JSON.parse(await readFile(path.join(created.workspace.path, 'workspace.json'), 'utf8')).anchor.key, 'PAY-100');
});

test('workspace repository and document roots cannot escape through symlinked directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-boundary-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: path.join(root, 'outside.git'), defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  const outsideRepositories = path.join(root, 'outside-repositories');
  const outsideDocuments = path.join(root, 'outside-documents');
  await mkdir(path.join(outsideRepositories, 'platform', '.git'), { recursive: true });
  await mkdir(outsideDocuments, { recursive: true });
  await writeFile(path.join(outsideDocuments, 'secret.md'), '# outside\n');

  await rm(path.join(created.workspace.path, 'repos'), { recursive: true });
  await symlink(outsideRepositories, path.join(created.workspace.path, 'repos'), 'dir');
  const status = await workspaceStatus(created.workspace.path);
  assert.equal(status.healthy, false);
  assert.equal(status.repositories[0].state, 'invalid-path');
  assert.match(status.repositories[0].error, /outside its configured root/);
  const fetched = await fetchWorkspace(created.workspace.path);
  assert.deepEqual(fetched.results, [{ repository: 'platform', status: 'skipped', reason: 'invalid-path' }]);

  const inbox = path.join(created.workspace.path, 'documents', 'inbox');
  await rm(inbox, { recursive: true });
  await symlink(outsideDocuments, inbox, 'dir');
  await assert.rejects(() => listWorkspaceDocuments(created.workspace.path), /outside its configured root/);
  const source = path.join(root, 'new-requirement.md');
  await writeFile(source, '# new\n');
  await assert.rejects(() => stageWorkspaceDocuments(created.workspace.path, [source]), /outside its configured root/);
  assert.equal(await readFile(path.join(outsideDocuments, 'secret.md'), 'utf8'), '# outside\n');
});

test('workspace CLI can provision an approved offline clone plan outside a Git repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-cli-'));
  const registry = path.join(root, 'registry.json');
  const result = spawnSync(process.execPath, [
    cli, 'workspace', 'create',
    '--jira', 'APP-42',
    '--jira-url', 'https://office.atlassian.net',
    '--hierarchy-level', '1',
    '--issue-type', 'Epic',
    '--title', 'Offline workspace',
    '--base', path.join(root, 'workspaces'),
    '--lead', 'lead',
    '--repository', `lead=${path.join(root, 'lead.git')}`,
    '--confirm', 'APP-42',
    '--no-clone',
    '--json'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }
  });
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout);
  assert.equal(created.workspace.anchor.key, 'APP-42');
  assert.equal(created.status.repositories[0].state, 'missing');
  const listed = spawnSync(process.execPath, [cli, 'workspace', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }
  });
  assert.equal(JSON.parse(listed.stdout)[0].anchorKey, 'APP-42');
  const status = spawnSync(process.execPath, [cli, 'workspace', 'status', created.workspace.path], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`Lead repository: ${created.status.leadRepositoryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(status.stdout, /Lead repository: undefined/);
});
