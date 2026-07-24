import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  firstUsableRepository,
  inspectWorkspaceSelection
} from '../apps/desktop/electron/workspace-selection.mjs';

async function workspace(root, name) {
  const target = path.join(root, name);
  await mkdir(target);
  await writeFile(path.join(target, 'workspace.json'), '{}');
  return target;
}

test('desktop workspace selection opens a direct or sole nested managed workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-picker-'));
  const managed = await workspace(root, 'MOB-100');
  const canonicalRoot = await realpath(root);
  const canonicalManaged = await realpath(managed);
  assert.deepEqual(await inspectWorkspaceSelection(managed), {
    directory: canonicalManaged,
    mode: 'open',
    workspaces: [canonicalManaged]
  });
  assert.deepEqual(await inspectWorkspaceSelection(root), {
    directory: canonicalRoot,
    mode: 'open',
    workspaces: [canonicalManaged]
  });
});

test('desktop workspace selection routes an empty home to creation and explains ambiguous homes', async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-empty-'));
  const canonicalEmpty = await realpath(empty);
  assert.deepEqual(await inspectWorkspaceSelection(empty), {
    directory: canonicalEmpty,
    mode: 'create',
    workspaces: []
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-many-'));
  const first = await workspace(root, 'MOB-100');
  const second = await workspace(root, 'MOB-200');
  const canonicalRoot = await realpath(root);
  assert.deepEqual(await inspectWorkspaceSelection(root), {
    directory: canonicalRoot,
    mode: 'choose-specific',
    workspaces: [await realpath(first), await realpath(second)]
  });
});

test('desktop workspace selection ignores linked manifests and skips stale lead repositories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-links-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-outside-'));
  await writeFile(path.join(outside, 'workspace.json'), '{}');
  await symlink(path.join(outside, 'workspace.json'), path.join(root, 'workspace.json'));
  assert.equal((await inspectWorkspaceSelection(root)).mode, 'create');

  const attempts = [];
  const selected = await firstUsableRepository(
    [{ path: '/missing' }, { path: '/ready' }],
    async (candidate) => {
      attempts.push(candidate);
      if (candidate.endsWith('missing')) throw new Error('stale');
      return candidate;
    }
  );
  assert.deepEqual(attempts, [path.resolve('/missing'), path.resolve('/ready')]);
  assert.equal(selected, path.resolve('/ready'));
});
