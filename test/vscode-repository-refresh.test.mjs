import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  canonicalFilesystemPath, gitRepositoryComparisonKey, repositoryRefreshCommand, repositoryRefreshTargetForPath,
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

test('Git URL maintenance collapses only proven aliases without weakening identity', () => {
  const publicGithub = ['github', 'com'].join('.');
  assert.equal(
    gitRepositoryComparisonKey('https://git.example.invalid/acme/RuleEngineUI.git/'),
    'remote:https:git.example.invalid/acme/RuleEngineUI.git'
  );
  assert.equal(sameGitRepository(
    'git@git.example.invalid:acme/RuleEngineUI.git',
    'https://git.example.invalid/acme/RuleEngineUI/'
  ), false, 'an arbitrary host may bind transport or SSH username into repository authority');
  const literalScpPath = 'git@example.test:repository.git?release#prod';
  assert.equal(sameGitRepository(literalScpPath, literalScpPath), true,
    'an admitted SCP path treats query- and fragment-shaped bytes as literal repository identity');
  const ipv6Scp = 'git@[2001:db8::1]:team/repository.git';
  assert.equal(sameGitRepository(ipv6Scp, ipv6Scp), true,
    'an exact admitted bracketed-IPv6 SCP authority remains reflexive');
  assert.equal(sameGitRepository(
    'git@example.test:repositories/platform.git',
    'git@example.test:/repositories/platform.git'
  ), false, 'SCP home-relative and absolute repository paths are distinct authorities');
  assert.notEqual(
    gitRepositoryComparisonKey('git@example.test:repositories/platform.git'),
    gitRepositoryComparisonKey('git@example.test:/repositories/platform.git')
  );
  assert.equal(sameGitRepository(
    'https://git.example.invalid/acme/RuleEngineUI.git',
    'https://git.example.invalid/acme/another.git'
  ), false);
  assert.equal(gitRepositoryComparisonKey('https://token@git.example.invalid/acme/RuleEngineUI.git'), null);
  assert.equal(sameGitRepository(
    'https://token@git.example.invalid/acme/RuleEngineUI.git',
    'https://token@git.example.invalid/acme/RuleEngineUI.git'
  ), false, 'exact equality never bypasses credential-free remote validation');
  assert.equal(sameGitRepository(
    'user:password@git.example.invalid:acme/RuleEngineUI.git',
    'user:password@git.example.invalid:acme/RuleEngineUI.git'
  ), false, 'password-shaped SCP user information is never an identity proof');
  assert.equal(sameGitRepository('ext::opaque', 'ext::opaque'), false,
    'external remote helpers are outside the closed comparison boundary');
  assert.equal(gitRepositoryComparisonKey('https://git.example.invalid/acme/RuleEngineUI.git?token=secret'), null);
  assert.equal(
    gitRepositoryComparisonKey('C:\\Work\\RuleEngineUI.git'),
    'local:c:/work/ruleengineui.git'
  );
  assert.equal(sameGitRepository(
    'file:///C:/Work/RuleEngineUI.git',
    'C:\\Work\\RuleEngineUI'
  ), false, 'a local bare repo ending in .git may be distinct from its sibling directory');
  assert.equal(sameGitRepository(
    'C:\\Work\\RuleEngineUI\\.git\\',
    'c:\\work\\ruleengineui'
  ), true, 'a local Git-directory spelling has no trailing identity component');
  assert.equal(sameGitRepository(
    '/srv/work/RuleEngineUI/.git/',
    '/srv/work/RuleEngineUI'
  ), true, 'a POSIX Git-directory spelling has no trailing identity component');
  assert.equal(sameGitRepository(
    'C:\\Work\\RuleEngineUI',
    'c:\\work\\RuleEngineUI'
  ), true, 'Windows local repository identity is case-insensitive');
  assert.equal(sameGitRepository(
    'file://build-server/Share/RuleEngineUI.git',
    '\\\\build-server\\Share\\RuleEngineUI'
  ), false, 'a UNC bare repo ending in .git may be distinct from its sibling directory');
  assert.equal(sameGitRepository(
    'file://build-server/Share/RuleEngineUI/.git',
    '\\\\build-server\\Share\\RuleEngineUI'
  ), true, 'a UNC Git-directory spelling resolves to its containing worktree');
  assert.equal(sameGitRepository(
    'file://build-server/Share/RuleEngineUI.git',
    'file://another-server/Share/RuleEngineUI.git'
  ), false, 'UNC authority remains part of repository identity');
  assert.equal(sameGitRepository(
    `https://${publicGithub}/Acme/RuleEngineUI.git`,
    `git@${publicGithub}:acme/ruleengineui`
  ), true, 'public GitHub repository paths are case-insensitive');
  assert.equal(sameGitRepository(
    `https://${publicGithub}/Acme/Rule%45ngineUI.git`,
    `ssh://git@ssh.${publicGithub}:443/acme/ruleengineui`
  ), true, 'documented GitHub SSH and unreserved percent-encoded aliases share one authority');
  assert.equal(sameGitRepository(
    'ssh://deploy@git.example.invalid/acme/RuleEngineUI',
    'ssh://git@git.example.invalid/acme/RuleEngineUI'
  ), false, 'arbitrary SSH usernames remain distinct authority identities');
  assert.equal(sameGitRepository(
    'C:\\Work\\RuleEngineUI.\\sub\\..',
    'c:\\work\\ruleengineui'
  ), true, 'Windows dot/space and parent aliases normalize before comparison');
  assert.equal(sameGitRepository(
    'https://git.example.invalid/Acme/RuleEngineUI.git',
    'git@git.example.invalid:acme/ruleengineui'
  ), false, 'unknown Git hosts retain case-sensitive repository identity');
});

test('attach-existing authority identity is portable but never broadens to another repository', () => {
  const publicGithub = ['github', 'com'].join('.');
  assert.equal(sameGitRepository(
    'C:\\Work\\RuleEngineUI',
    'c:/work/ruleengineui/'
  ), true, 'Windows drive case and separator spelling do not create another authority');
  assert.equal(sameGitRepository(
    '/srv/work/RuleEngineUI/.git/',
    '/srv/work/RuleEngineUI'
  ), true, 'a worktree and its Git-directory spelling identify one local authority');
  assert.equal(sameGitRepository(
    `https://${publicGithub}/Acme/RuleEngineUI.git`,
    `git@${publicGithub}:acme/ruleengineui`
  ), true, 'the documented GitHub HTTPS/SSH transports identify one hosted authority');
  assert.equal(sameGitRepository(
    `https://${publicGithub}/acme/RuleEngineUI.git`,
    `https://${publicGithub}/acme/RuleEngineAPI.git`
  ), false, 'a neighboring repository can never satisfy the inspected authority lease');
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
    'https://git.example.invalid/acme/RuleEngineUI.git', observations
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
    'git@git.example.invalid:acme/RuleEngineUI.git', observations
  ), [], 'an arbitrary cross-transport spelling is not assumed to be the same authority');
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

test('canonical repository matching treats equivalent Windows path spelling as one checkout', async () => {
  const noFilesystemLookup = async (candidate) => candidate;
  assert.equal(
    await canonicalFilesystemPath('C:\\Work\\RuleEngineUI', {
      platform: 'win32', canonicalize: noFilesystemLookup
    }),
    await canonicalFilesystemPath('c:/work/ruleengineui/.', {
      platform: 'win32', canonicalize: noFilesystemLookup
    })
  );
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
    command: 'singularityFlow.openWorkspaces',
    args: [{ upgradeScope: 'selected', workspacePath: '/work/payments', repositoryId: 'ui' }]
  }, 'normal reinitialize uses the seeded-only reviewed workspace refresh');
  assert.deepEqual(repositoryRefreshCommand('factory-reset', target), {
    command: 'singularityFlow.factoryReset', args: ['/clones/ui']
  });
  assert.equal(repositoryRefreshCommand('reinitialize', { ...target, workspacePath: null }), null,
    'seeded-only reinitialize requires a registered workspace authority');
  assert.equal(repositoryRefreshCommand('refresh', { ...target, workspacePath: null }), null,
    'an open repository without a registered workspace cannot become an all-workspaces refresh');
  assert.equal(repositoryRefreshCommand('refresh', { ...target, repositoryId: 'Rule Engine UI' }), null,
    'a damaged legacy identifier cannot be interpreted as a repository selector');
});
