import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSidebarNavigation } from '../src/views/sidebar-navigation-model.ts';

const selectedWorkspace = {
  id: 'my-workspace', path: '/work/my-workspace', name: 'My Workspace', anchorKey: 'ABC',
  leadRepositoryPath: '/work/my-workspace/repos/catalog', active: '2026-09-26',
  repositoryState: 'ready'
};

const snapshot = (overrides = {}) => ({
  workItems: [], initiatives: [], selectedWorkId: null, selectedInitiativeId: null,
  initiative: null, workflow: null,
  repository: { root: '/work/my-workspace/repos/catalog' },
  ...overrides
});

test('no selected workspace chooses an existing workspace before offering guided start', () => {
  assert.deepEqual(deriveSidebarNavigation([], null), {
    workspace: null,
    next: {
      label: 'Guided start', description: 'Map a capability and create a workspace.',
      actionId: 'setup-wizard'
    }
  });
  assert.deepEqual(deriveSidebarNavigation([{ ...selectedWorkspace, active: '' }], snapshot()).next, {
    label: 'Choose a workspace', description: 'Resume a workspace already on this machine.',
    actionId: 'workspace-switch'
  });
});

test('selected workspace identifies the repository and offers intake only after a lifecycle read', () => {
  const view = deriveSidebarNavigation([selectedWorkspace], snapshot());
  assert.deepEqual(view.workspace, { name: 'My Workspace', repository: 'catalog' });
  assert.deepEqual(view.next, {
    label: 'Start new work',
    description: 'Begin the first governed work item in this workspace.',
    actionId: 'work-start'
  });
  assert.equal(deriveSidebarNavigation([selectedWorkspace], null, { loading: true }).next, null);
  assert.equal(deriveSidebarNavigation([selectedWorkspace], snapshot({ included: ['configuration'] })).next, null);
});

test('active Story or Epic leads to My Work', () => {
  assert.deepEqual(deriveSidebarNavigation([selectedWorkspace], snapshot({
    workflow: { workItem: { id: 'STORY-1' } }
  })).next, {
    label: 'Continue current work', description: 'Story STORY-1', actionId: 'my-work'
  });
  assert.equal(deriveSidebarNavigation([selectedWorkspace], snapshot({ initiative: { state: {} } }))
    .next?.actionId, 'my-work');
});

test('unavailable or ambiguous state never offers a work action', () => {
  assert.equal(deriveSidebarNavigation([{ ...selectedWorkspace, repositoryState: 'missing' }],
    snapshot()).next, null);
  assert.equal(deriveSidebarNavigation([selectedWorkspace], snapshot({ selectedWorkId: 'STORY-1' }))
    .next, null);
  assert.deepEqual(deriveSidebarNavigation([selectedWorkspace, {
    ...selectedWorkspace, id: 'other', path: '/work/other', name: 'Other'
  }], snapshot()), { workspace: null, next: null });
});

test('repository label supports Windows paths and falls back to the registered lead checkout', () => {
  const view = deriveSidebarNavigation([{
    ...selectedWorkspace, leadRepositoryPath: 'C:\\work\\my-workspace\\repos\\engine\\'
  }], snapshot({ repository: undefined }));
  assert.deepEqual(view.workspace, { name: 'My Workspace', repository: 'engine' });
});
