import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  requireActiveRepository,
  requireActiveWorkspace,
  requireReadyLeadRepository
} from '../apps/desktop/electron/desktop-scope.mjs';

test('desktop repository and workspace requests stay bound to the active selection', () => {
  const activeRepository = path.resolve('/tmp/project/repository');
  const activeWorkspace = { workspace: { path: path.resolve('/tmp/project/workspace') } };
  assert.equal(requireActiveRepository(activeRepository, activeRepository), activeRepository);
  assert.equal(requireActiveWorkspace(activeWorkspace, activeWorkspace.workspace.path), activeWorkspace.workspace.path);
  assert.throws(
    () => requireActiveRepository(activeRepository, '/tmp/project/other'),
    /Repository is not open/
  );
  assert.throws(
    () => requireActiveWorkspace(activeWorkspace, '/tmp/project/other-workspace'),
    /Workspace is not open/
  );
});

test('desktop opens a workspace only when its configured lead repository is ready', () => {
  const ready = {
    workspace: { leadRepository: 'platform' },
    repositories: [
      { id: 'platform', state: 'ready', absolutePath: '/tmp/workspace/repos/platform' }
    ]
  };
  assert.equal(requireReadyLeadRepository(ready), path.resolve('/tmp/workspace/repos/platform'));
  assert.throws(
    () => requireReadyLeadRepository({
      ...ready,
      repositories: [{ id: 'platform', state: 'invalid-path', absolutePath: '/tmp/workspace/repos/platform' }]
    }),
    /cannot be opened because its lead repository 'platform' is invalid-path/
  );
  assert.throws(
    () => requireReadyLeadRepository({ workspace: { leadRepository: 'missing' }, repositories: [] }),
    /does not contain its configured lead repository/
  );
});
