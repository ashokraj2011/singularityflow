import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  archiveWorkspace, createWorkspace, createWorkspaceConfiguration, fetchWorkspace, forgetWorkspace, listWorkspaceDocuments,
  normalizeWorkspaceAnchor, previewWorkspace, previewWorkspaceConfiguration, readWorkspace, readWorkspaceRegistry,
  rememberWorkspace, resolveWorkspaceDocument, restoreWorkspace, saveWorkspaceConfiguration, stageWorkspaceDocuments,
  updateWorkspaceConfiguration, validateWorkspaceManifest, workspaceStatus
} from '../src/workspace.mjs';
import {
  activateWorkspaceContext, buildWorkspaceContext, readActiveWorkspaceContext, resolveWorkspaceReference,
  workspacePromptLabel
} from '../src/workspace-context.mjs';
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

test('workspace configuration is independent from Jira hierarchy and pins repository routing metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-config-'));
  const preview = previewWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'payments-platform',
    name: 'Payments platform',
    leadRepository: 'experience',
    repositories: {
      experience: {
        url: path.join(root, 'experience.git'),
        defaultBranch: 'main',
        role: 'participant',
        jira: { board: 'PAY Experience' },
        metadata: { appId: 'APP-1001', name: 'Customer experience', owner: 'Digital' }
      },
      services: {
        url: path.join(root, 'services.git'),
        defaultBranch: 'main',
        role: 'lead',
        jira: { board: 'PAY-SVC' },
        metadata: { appId: 'APP-1002', name: 'Payment services' }
      }
    }
  });
  assert.equal(preview.manifest.anchor.provider, 'workspace');
  assert.equal(preview.manifest.anchor.issueTypeName, 'Workspace');
  assert.equal(preview.manifest.repositories.experience.role, 'lead');
  assert.equal(preview.manifest.repositories.services.role, 'participant');
  assert.equal(preview.manifest.repositories.experience.jira.board, 'PAY Experience');
  assert.equal(preview.manifest.repositories.experience.metadata.appId, 'APP-1001');
  await assert.rejects(
    () => createWorkspaceConfiguration({
      baseDirectory: path.join(root, 'workspaces'),
      id: 'payments-platform',
      name: 'Payments platform',
      leadRepository: 'experience',
      repositories: preview.manifest.repositories
    }, { confirmation: 'wrong', clone: false }),
    /exact workspace-ID confirmation/
  );
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'payments-platform',
    name: 'Payments platform',
    leadRepository: 'experience',
    repositories: preview.manifest.repositories
  }, { confirmation: 'payments-platform', clone: false });
  assert.equal(created.workspace.name, 'Payments platform');
  assert.equal(created.workspace.leadRepository, 'experience');
  assert.equal(created.workspace.repositories.services.jira.board, 'PAY-SVC');
});

test('workspace Jira project routing is optional and can be added later', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-optional-jira-'));
  const remote = await remoteRepository(root, 'platform');
  const created = await saveWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'optional-jira',
    name: 'Optional Jira',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'main',
        jira: {},
        metadata: { appId: 'APP-PLATFORM', name: 'Platform' }
      }
    }
  }, { confirmation: 'optional-jira' });
  assert.equal(created.workspace.repositories.platform.jira.board, null);

  const updated = await updateWorkspaceConfiguration(created.workspace.path, {
    name: created.workspace.name,
    leadRepository: 'platform',
    repositories: {
      platform: {
        ...created.workspace.repositories.platform,
        jira: { board: 'KAN' }
      }
    }
  }, { confirmation: 'optional-jira' });
  assert.equal(updated.workspace.repositories.platform.jira.board, 'KAN');
});

test('workspace creation claims an empty repository folder and clones the configured branch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-empty-clone-'));
  const remote = await remoteRepository(root, 'platform');
  const source = path.join(root, 'platform-source');
  run('git', ['switch', '-c', 'release/2026.07'], { cwd: source });
  await writeFile(path.join(source, 'BRANCH.txt'), 'configured branch\n');
  run('git', ['add', 'BRANCH.txt'], { cwd: source });
  run('git', ['commit', '-m', 'add release branch marker'], { cwd: source });
  run('git', ['push', remote, 'release/2026.07'], { cwd: source });

  const options = {
    baseDirectory: path.join(root, 'workspaces'),
    id: 'branch-workspace',
    name: 'Branch workspace',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'release/2026.07',
        required: true,
        metadata: { appId: 'APP-PLATFORM', name: 'Platform' }
      }
    }
  };
  const reserved = await createWorkspaceConfiguration(options, {
    confirmation: 'branch-workspace',
    clone: false
  });
  const target = path.join(reserved.workspace.path, 'repos/platform');
  await mkdir(target);

  const saved = await saveWorkspaceConfiguration(options, { confirmation: 'branch-workspace' });
  assert.equal(saved.status.healthy, true);
  assert.equal(saved.status.repositories[0].branch, 'release/2026.07');
  assert.equal(await readFile(path.join(target, 'BRANCH.txt'), 'utf8'), 'configured branch\n');
  assert.equal(saved.status.repositories[0].worldModel.state, 'missing');
  assert.equal(saved.status.warnings[0].code, 'world-model-missing');
  assert.match(saved.status.warnings[0].message, /No repository world model was found/);
});

test('workspace health recognizes an existing repository world model without warning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-world-model-'));
  const remote = await remoteRepository(root, 'platform');
  const source = path.join(root, 'platform-source');
  await mkdir(path.join(source, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(source, 'singularity/world-model/manifest.json'), JSON.stringify({
    generated_at: '2026-07-28T04:30:00.000Z'
  }));
  run('git', ['add', 'singularity/world-model/manifest.json'], { cwd: source });
  run('git', ['commit', '-m', 'add repository world model'], { cwd: source });
  run('git', ['push', remote, 'main'], { cwd: source });

  const saved = await saveWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'grounded-workspace',
    name: 'Grounded workspace',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'main',
        required: true,
        metadata: { appId: 'APP-PLATFORM', name: 'Platform' }
      }
    }
  }, { confirmation: 'grounded-workspace' });

  assert.equal(saved.status.repositories[0].worldModel.state, 'available');
  assert.equal(saved.status.repositories[0].worldModel.generatedAt, '2026-07-28T04:30:00.000Z');
  assert.equal(saved.status.counts.worldModels, 1);
  assert.deepEqual(saved.status.warnings, []);
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
  const platformSource = path.join(root, 'platform-source');
  run('git', ['switch', '-c', 'KAN-8'], { cwd: platformSource });
  await writeFile(path.join(platformSource, 'KAN-8.md'), '# Governed Epic\n');
  run('git', ['add', '.'], { cwd: platformSource });
  run('git', ['commit', '-m', 'Add governed Epic branch'], { cwd: platformSource });
  run('git', ['push', platform, 'KAN-8'], { cwd: platformSource });
  run('git', ['switch', 'main'], { cwd: platformSource });
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
  assert.equal(
    run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/KAN-8'], { cwd: lead, allowFailure: true }).status,
    0,
    'workspace clones must retain remote governed branches'
  );
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

test('active workspace context resolves friendly references and adds governed Story identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-context-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active.json');
  const platform = await remoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);

  const lead = created.status.leadRepositoryPath;
  run('git', ['checkout', '-b', 'feature/mobile-ui'], { cwd: lead });
  await mkdir(path.join(lead, 'singularity', 'work-items', 'MOB-123'), { recursive: true });
  await writeFile(path.join(lead, 'singularity', 'work-items', 'MOB-123', 'workflow.json'), JSON.stringify({
    schemaVersion: 2,
    workItem: { id: 'MOB-123', branch: 'MOB-123-mobile', title: 'Mobile Story' },
    lineage: { canonicalBranch: 'MOB-123-mobile', childBranches: [{ name: 'feature/mobile-ui' }] },
    phaseOrder: [],
    phases: {}
  }));

  const byKey = await resolveWorkspaceReference(registry, 'pay-100');
  assert.equal(byKey.id, created.workspace.id);
  const preview = await buildWorkspaceContext(registry, created.workspace.name);
  assert.equal(preview.repositoryId, 'platform');
  assert.equal(preview.storyId, 'MOB-123');
  assert.equal(workspacePromptLabel(preview), `${created.workspace.name} / MOB-123 >`);

  const active = await activateWorkspaceContext(registry, selection, created.workspace.id, { storyId: 'MOB-999' });
  assert.equal(active.storyId, 'MOB-999');
  assert.equal((await readActiveWorkspaceContext(selection, registry)).prompt, `${created.workspace.name} / MOB-999 >`);
  await assert.rejects(() => buildWorkspaceContext(registry, created.workspace.id, { repositoryId: 'missing' }), /not part of workspace/);
});

test('workspace Copilot launcher dry-run uses the selected repository and session name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-copilot-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active.json');
  const platform = await remoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection
  };

  let result = spawnSync(process.execPath, [cli, 'workspace', 'use', 'PAY-100', '--story', 'MOB-321', '--json'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).storyId, 'MOB-321');

  result = spawnSync(process.execPath, [cli, 'workspace', 'copilot', '--mode', 'plan', '--dry-run'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const launch = JSON.parse(result.stdout);
  assert.equal(launch.cwd, created.status.leadRepositoryPath);
  assert.deepEqual(launch.args.slice(0, 2), ['-C', created.status.leadRepositoryPath]);
  assert.ok(launch.args.includes('--name'));
  assert.deepEqual(launch.args.slice(-2), ['--mode', 'plan']);
  assert.equal(launch.prompt, `${created.workspace.name} / MOB-321 >`);
});

test('workspace editing updates Jira routing and metadata while archive remains recoverable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-edit-'));
  const registry = path.join(root, 'registry.json');
  const remote = await remoteRepository(root, 'platform');
  const created = await saveWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'payments-platform',
    name: 'Payments platform',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'main',
        required: true,
        path: 'repos/platform',
        jira: { board: 'PAY' },
        metadata: { appId: 'APP-1', name: 'Payments platform' }
      }
    }
  }, { confirmation: 'payments-platform' });
  await rememberWorkspace(registry, created.workspace, created.status);
  const updated = await updateWorkspaceConfiguration(created.workspace.path, {
    name: 'Payments delivery',
    leadRepository: 'platform',
    repositories: {
      platform: {
        ...created.workspace.repositories.platform,
        jira: { board: 'KAN' },
        metadata: { appId: 'APP-2', name: 'Payments API', owner: 'Digital' }
      }
    }
  }, { confirmation: 'payments-platform' });
  assert.equal(updated.workspace.name, 'Payments delivery');
  assert.equal(updated.workspace.repositories.platform.jira.board, 'KAN');
  assert.equal(updated.workspace.repositories.platform.metadata.owner, 'Digital');
  await assert.rejects(() => updateWorkspaceConfiguration(created.workspace.path, {
    name: 'Invalid',
    leadRepository: 'platform',
    repositories: {
      platform: { ...created.workspace.repositories.platform, url: 'https://example.com/replacement.git' }
    }
  }, { confirmation: 'payments-platform' }), /cannot change url/);

  await archiveWorkspace(registry, created.workspace.path, { confirmation: 'payments-platform' });
  assert.ok((await readWorkspaceRegistry(registry))[0].archivedAt);
  assert.equal(await stat(path.join(created.workspace.path, 'workspace.json')).then(() => true), true);
  await restoreWorkspace(registry, created.workspace.path);
  assert.equal((await readWorkspaceRegistry(registry))[0].archivedAt, null);
});

test('concurrent workspace registry updates preserve every workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-registry-concurrent-'));
  const registry = path.join(root, 'registry.json');
  const firstInput = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: path.join(root, 'first.git'), defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const secondInput = structuredClone(firstInput);
  secondInput.anchor.key = 'PAY-200';
  secondInput.anchor.title = 'Merchant modernization';
  const [first, second] = await Promise.all([
    createWorkspace(firstInput, { confirmation: 'PAY-100', clone: false }),
    createWorkspace(secondInput, { confirmation: 'PAY-200', clone: false })
  ]);

  await Promise.all([
    rememberWorkspace(registry, first.workspace, first.status),
    rememberWorkspace(registry, second.workspace, second.status)
  ]);

  const entries = await readWorkspaceRegistry(registry);
  assert.deepEqual(new Set(entries.map((entry) => entry.anchorKey)), new Set(['PAY-100', 'PAY-200']));
});

test('reopening an incomplete workspace resumes missing clones and refreshes its materialization journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-resume-'));
  const platform = await remoteRepository(root, 'platform');
  const mobile = await remoteRepository(root, 'mobile');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' },
    mobile: { url: mobile, defaultBranch: 'main', required: true, path: 'repos/mobile' }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  assert.equal(created.status.healthy, false);
  const planned = JSON.parse(await readFile(path.join(created.workspace.path, 'logs', 'workspace-materialization.json'), 'utf8'));
  assert.deepEqual(planned.operations.map((operation) => operation.status), ['planned', 'planned']);

  const resumed = await createWorkspace(input, { confirmation: 'PAY-100' });
  assert.equal(resumed.created, false);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.status.healthy, true);
  assert.deepEqual(resumed.repair.map((operation) => operation.status), ['cloned', 'cloned']);

  const journal = JSON.parse(await readFile(path.join(created.workspace.path, 'logs', 'workspace-materialization.json'), 'utf8'));
  assert.ok(journal.completedAt);
  assert.deepEqual(journal.operations.map((operation) => operation.status), ['complete', 'complete']);
  assert.ok(journal.operations.every((operation) => operation.completedAt));
});

test('workspace recovery rejects a different repository materialization plan at the same target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-drift-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: {
      url: path.join(root, 'platform.git'),
      defaultBranch: 'main',
      required: true,
      path: 'repos/platform',
      metadata: { appId: 'APP-1' }
    }
  });
  await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  const changed = structuredClone(input);
  changed.repositories.platform.url = path.join(root, 'replacement.git');
  await assert.rejects(
    () => createWorkspace(changed, { confirmation: 'PAY-100', clone: false }),
    /different repository materialization plan/
  );
});

test('a failed clone leaves no partial repository and can resume when the remote becomes available', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-clone-retry-'));
  const futureRemote = path.join(root, 'later.git');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: futureRemote, defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const preview = previewWorkspace(input);
  await assert.rejects(
    () => createWorkspace(input, { confirmation: 'PAY-100' }),
    /retained for repair/
  );
  assert.deepEqual(await readdir(path.join(preview.root, 'repos')), []);

  assert.equal(await remoteRepository(root, 'later'), futureRemote);
  const resumed = await createWorkspace(input, { confirmation: 'PAY-100' });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.status.healthy, true);
});

test('workspace configuration stays saved when repository materialization fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-save-before-clone-'));
  const baseDirectory = path.join(root, 'workspaces');
  const unavailableRemote = path.join(root, 'unavailable.git');
  const options = {
    baseDirectory,
    id: 'payments-platform',
    name: 'Payments platform',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: unavailableRemote,
        defaultBranch: 'main',
        required: true,
        path: 'repos/platform',
        jira: { board: 'PAY' },
        metadata: { appId: 'APP-1', name: 'Payments platform' }
      }
    }
  };

  const saved = await saveWorkspaceConfiguration(options, { confirmation: 'payments-platform' });
  assert.equal(saved.created, true);
  assert.equal(saved.status.healthy, false);
  assert.equal(saved.status.repositories[0].state, 'missing');
  assert.match(saved.materializationError, /could not be repaired/);
  assert.equal((await readWorkspace(saved.workspace.path)).name, 'Payments platform');

  await remoteRepository(root, 'unavailable');
  const resumed = await saveWorkspaceConfiguration(options, { confirmation: 'payments-platform' });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.status.healthy, true);
  assert.equal(resumed.materializationError, null);
});

test('workspace paths are canonicalized and linked manifests are rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-canonical-'));
  const registry = path.join(root, 'registry.json');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: path.join(root, 'platform.git'), defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  const alias = path.join(root, 'workspace-alias');
  await symlink(created.workspace.path, alias, 'dir');

  const loaded = await readWorkspace(alias);
  assert.equal(loaded.path, created.workspace.path);
  await rememberWorkspace(registry, { ...loaded, path: alias });
  assert.equal((await readWorkspaceRegistry(registry))[0].path, created.workspace.path);
  await forgetWorkspace(registry, alias);
  assert.deepEqual(await readWorkspaceRegistry(registry), []);

  const manifestFile = path.join(created.workspace.path, 'workspace.json');
  const outsideManifest = path.join(root, 'outside-workspace.json');
  await writeFile(outsideManifest, await readFile(manifestFile));
  await rm(manifestFile);
  await symlink(outsideManifest, manifestFile);
  await assert.rejects(() => readWorkspace(created.workspace.path), /symbolic link/);
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
