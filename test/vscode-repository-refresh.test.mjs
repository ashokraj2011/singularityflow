import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  gitRepositoryComparisonKey, repositoryRefreshCommand, repositoryRefreshTargetForPath,
  repositoryRefreshTargets, sameGitRepository
} = await import(path.join(root, 'apps/vscode/src/repository-refresh-model.ts'));

const workspace = { id: 'payments', name: 'Payments', path: '/work/payments', anchorKey: 'PAY' };
const status = {
  workspace: {
    id: 'payments', name: 'Payments', path: '/work/payments', leadRepository: 'ui',
    capabilityAuthority: { url: 'https://git.example.invalid/acme/platform.git' }
  },
  healthy: true,
  leadRepositoryPath: '/clones/ui',
  repositories: [
    {
      id: 'ui', role: 'lead', absolutePath: '/clones/ui', state: 'ready',
      url: 'https://git.example.invalid/acme/RuleEngineUI.git'
    },
    {
      id: 'api', absolutePath: '/clones/api', state: 'missing',
      url: 'ssh://git@git.example.invalid/acme/RuleEngineAPI'
    }
  ]
};

test('Git URL maintenance matches ordinary HTTPS and SSH spellings without weakening identity', () => {
  assert.equal(
    gitRepositoryComparisonKey('https://git.example.invalid/acme/RuleEngineUI.git/'),
    'remote:git.example.invalid/acme/RuleEngineUI'
  );
  assert.equal(sameGitRepository(
    'git@git.example.invalid:acme/RuleEngineUI.git',
    'https://git.example.invalid/acme/RuleEngineUI/'
  ), true);
  assert.equal(sameGitRepository(
    'https://git.example.invalid/acme/RuleEngineUI.git',
    'https://git.example.invalid/acme/another.git'
  ), false);
  assert.equal(gitRepositoryComparisonKey('https://token@git.example.invalid/acme/RuleEngineUI.git'), null);
  assert.equal(gitRepositoryComparisonKey('https://git.example.invalid/acme/RuleEngineUI.git?token=secret'), null);
  assert.equal(
    gitRepositoryComparisonKey('C:\\Work\\RuleEngineUI.git'),
    'local:c:/Work/RuleEngineUI'
  );
  assert.equal(sameGitRepository(
    'file:///C:/Work/RuleEngineUI.git',
    'C:\\Work\\RuleEngineUI'
  ), true);
  assert.equal(sameGitRepository(
    'C:\\Work\\RuleEngineUI',
    'c:\\work\\RuleEngineUI'
  ), false, 'case-only path identity is not inferred without filesystem proof');
  assert.equal(sameGitRepository(
    'file://build-server/Share/RuleEngineUI.git',
    '\\\\build-server\\Share\\RuleEngineUI'
  ), true);
  assert.equal(sameGitRepository(
    'file://build-server/Share/RuleEngineUI.git',
    'file://another-server/Share/RuleEngineUI.git'
  ), false, 'UNC authority remains part of repository identity');
});

test('Git URL maintenance resolves only exact repositories in readable registered workspaces', () => {
  const observations = [
    { workspace, status, error: null },
    {
      workspace: { id: 'broken', name: 'Broken', path: '/work/broken', anchorKey: 'BROKEN' },
      status: null,
      error: 'workspace.json is unreadable'
    }
  ];
  assert.deepEqual(repositoryRefreshTargets(
    'git@git.example.invalid:acme/RuleEngineUI.git', observations
  ), [{
    workspaceId: 'payments',
    workspaceName: 'Payments',
    workspacePath: '/work/payments',
    repositoryId: 'ui',
    repositoryPath: '/clones/ui',
    repositoryUrl: 'https://git.example.invalid/acme/RuleEngineUI.git',
    repositoryState: 'ready'
  }]);
  assert.deepEqual(repositoryRefreshTargets(
    'https://git.example.invalid/acme/not-registered.git', observations
  ), []);
});

test('a local handoff must still belong to the exact registered workspace snapshot', async () => {
  const observations = [{ workspace, status, error: null }];
  assert.equal(
    await repositoryRefreshTargetForPath('/clones/ui', '/work/elsewhere', observations),
    null
  );
  assert.deepEqual(
    await repositoryRefreshTargetForPath('/clones/ui', '/work/payments', observations),
    {
      workspaceId: 'payments', workspaceName: 'Payments', workspacePath: '/work/payments',
      repositoryId: 'ui', repositoryPath: '/clones/ui',
      repositoryUrl: 'https://git.example.invalid/acme/RuleEngineUI.git', repositoryState: 'ready'
    }
  );
});

test('a local refresh handoff compares filesystem identity instead of symlink spelling', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actualWorkspace = path.join(root, 'actual-workspace');
  const actualRepository = path.join(actualWorkspace, 'repos', 'ui');
  const workspaceAlias = path.join(root, 'workspace-alias');
  const repositoryAlias = path.join(root, 'repository-alias');
  await mkdir(actualRepository, { recursive: true });
  await symlink(actualWorkspace, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(actualRepository, repositoryAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedStatus = {
    ...status,
    workspace: { ...status.workspace, path: workspaceAlias },
    repositories: [{ ...status.repositories[0], absolutePath: repositoryAlias }]
  };
  const result = await repositoryRefreshTargetForPath(
    actualRepository, actualWorkspace, [{ workspace: { ...workspace, path: workspaceAlias }, status: aliasedStatus }]
  );
  assert.equal(result?.repositoryPath, repositoryAlias);
});

test('each reviewed maintenance choice has one bounded existing command route', () => {
  const [target] = repositoryRefreshTargets(
    'https://git.example.invalid/acme/RuleEngineUI.git', [{ workspace, status, error: null }]
  );
  assert.ok(target);
  assert.deepEqual(repositoryRefreshCommand('refresh', target), {
    command: 'singularityFlow.openWorkspaces',
    args: [{ upgradeScope: 'selected', workspacePath: '/work/payments', repositoryId: 'ui' }]
  });
  assert.deepEqual(repositoryRefreshCommand('authority', target), {
    command: 'singularityFlow.refreshAuthorityPin', args: ['/clones/ui']
  });
  assert.deepEqual(repositoryRefreshCommand('reinitialize', target), {
    command: 'singularityFlow.reinitialize', args: ['/clones/ui']
  });
  assert.equal(repositoryRefreshCommand('refresh', { ...target, workspacePath: null }), null,
    'an open repository without a registered workspace cannot become an all-workspaces refresh');
  assert.equal(repositoryRefreshCommand('refresh', { ...target, repositoryId: 'Rule Engine UI' }), null,
    'a damaged legacy identifier cannot be interpreted as a repository selector');
});
