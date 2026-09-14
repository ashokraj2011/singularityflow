import test from 'node:test';
import assert from 'node:assert/strict';
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
    capabilityAuthority: { url: 'https://github.com/example/platform.git' }
  },
  healthy: true,
  leadRepositoryPath: '/clones/ui',
  repositories: [
    {
      id: 'ui', role: 'lead', absolutePath: '/clones/ui', state: 'ready',
      url: 'https://github.com/example/RuleEngineUI.git'
    },
    {
      id: 'api', absolutePath: '/clones/api', state: 'missing',
      url: 'ssh://git@github.com/example/RuleEngineAPI'
    }
  ]
};

test('Git URL maintenance matches ordinary HTTPS and SSH spellings without weakening identity', () => {
  assert.equal(
    gitRepositoryComparisonKey('https://github.com/example/RuleEngineUI.git/'),
    'remote:github.com/example/RuleEngineUI'
  );
  assert.equal(sameGitRepository(
    'git@github.com:example/RuleEngineUI.git',
    'https://github.com/example/RuleEngineUI/'
  ), true);
  assert.equal(sameGitRepository(
    'https://github.com/example/RuleEngineUI.git',
    'https://github.com/example/another.git'
  ), false);
  assert.equal(gitRepositoryComparisonKey('https://token@github.com/example/RuleEngineUI.git'), null);
  assert.equal(gitRepositoryComparisonKey('https://github.com/example/RuleEngineUI.git?token=secret'), null);
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
    'git@github.com:example/RuleEngineUI.git', observations
  ), [{
    workspaceId: 'payments',
    workspaceName: 'Payments',
    workspacePath: '/work/payments',
    repositoryId: 'ui',
    repositoryPath: '/clones/ui',
    repositoryUrl: 'https://github.com/example/RuleEngineUI.git',
    repositoryState: 'ready'
  }]);
  assert.deepEqual(repositoryRefreshTargets(
    'https://github.com/example/not-registered.git', observations
  ), []);
});

test('a local handoff must still belong to the exact registered workspace snapshot', () => {
  const observations = [{ workspace, status, error: null }];
  assert.equal(
    repositoryRefreshTargetForPath('/clones/ui', '/work/elsewhere', observations),
    null
  );
  assert.deepEqual(
    repositoryRefreshTargetForPath('/clones/ui', '/work/payments', observations),
    {
      workspaceId: 'payments', workspaceName: 'Payments', workspacePath: '/work/payments',
      repositoryId: 'ui', repositoryPath: '/clones/ui',
      repositoryUrl: 'https://github.com/example/RuleEngineUI.git', repositoryState: 'ready'
    }
  );
});

test('each reviewed maintenance choice has one bounded existing command route', () => {
  const [target] = repositoryRefreshTargets(
    'https://github.com/example/RuleEngineUI.git', [{ workspace, status, error: null }]
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
