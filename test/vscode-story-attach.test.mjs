import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectedCatalogStory, verifiedWorkspaceStoryRepository
} from '../apps/vscode/src/story-attach.ts';

const catalog = [
  { repositoryId: 'alpha', repositoryPath: '', repositoryUrl: 'file:///team/alpha.git',
    id: 'SAME', title: 'Alpha Story', status: 'in_progress', currentPhase: 'intake', branch: 'SAME' },
  { repositoryId: 'beta', repositoryPath: '', repositoryUrl: 'file:///team/beta.git',
    id: 'SAME', title: 'Beta Story', status: 'in_progress', currentPhase: 'testing', branch: 'SAME' }
];

const current = { active: true, workspaceId: 'team', workspacePath: '/work/team' };
const status = {
  workspace: { id: 'team', name: 'Team', path: '/work/team', leadRepository: 'alpha' },
  healthy: true,
  leadRepositoryPath: '/work/team/repos/alpha',
  repositories: [
    { id: 'alpha', state: 'missing', url: 'file:///team/alpha.git', absolutePath: '/work/team/repos/alpha' },
    { id: 'beta', state: 'missing', url: 'file:///team/beta.git', absolutePath: '/work/team/repos/beta' }
  ]
};

test('same-ID Stories select only the exact mapped repository', () => {
  const selected = selectedCatalogStory(catalog, { workId: 'SAME', repositoryId: 'beta' });
  assert.equal(selected.title, 'Beta Story');
  assert.deepEqual(verifiedWorkspaceStoryRepository(selected, current, status), {
    workspacePath: '/work/team', repositoryId: 'beta', repositoryPath: '/work/team/repos/beta'
  });
  assert.throws(() => selectedCatalogStory(catalog, { workId: 'SAME', repositoryId: 'gamma' }),
    /no longer listed/);
});

test('deferred attach refuses stale workspace and Git mapping before any materialization', () => {
  const selected = selectedCatalogStory(catalog, { workId: 'SAME', repositoryId: 'beta' });
  assert.throws(() => verifiedWorkspaceStoryRepository(selected,
    { ...current, workspaceId: 'other' }, status), /workspace changed/i);
  assert.throws(() => verifiedWorkspaceStoryRepository(selected, current, {
    ...status, repositories: status.repositories.map((row) => row.id === 'beta'
      ? { ...row, url: 'file:///team/replaced.git' } : row)
  }), /no longer matches the mapping/);
  assert.throws(() => verifiedWorkspaceStoryRepository(selected, current, {
    ...status, repositories: status.repositories.map((row) => row.id === 'beta'
      ? { ...row, state: 'dirty' } : row)
  }), /dirty.*No clone was started/);
});

test('conflicting duplicate discovery rows cannot select a repository ambiguously', () => {
  assert.throws(() => selectedCatalogStory([...catalog, { ...catalog[1], branch: 'OTHER' }], {
    workId: 'SAME', repositoryId: 'beta'
  }), /conflicting repository records/);
  assert.equal(selectedCatalogStory([...catalog, { ...catalog[1] }], {
    workId: 'SAME', repositoryId: 'beta'
  }).repositoryId, 'beta');
});

test('ready repository attach refuses a checkout that moved since discovery', () => {
  const ready = { ...catalog[0], repositoryPath: '/work/team/repos/alpha' };
  const readyStatus = { ...status, repositories: status.repositories.map((row) => row.id === 'alpha'
    ? { ...row, state: 'ready', absolutePath: '/work/team/repos/replaced' } : row) };
  assert.throws(() => verifiedWorkspaceStoryRepository(ready, current, readyStatus), /moved since Story discovery/);
});
