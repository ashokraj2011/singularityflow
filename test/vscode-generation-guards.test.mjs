import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  storyCheckoutIssue, unsavedRepositoryPaths
} from '../apps/vscode/src/generation-guards.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('only unsaved file-backed buffers inside the governed repository block publication', () => {
  const repository = path.join(path.sep, 'workspace', 'story');
  assert.deepEqual(unsavedRepositoryPaths([
    { isDirty: true, uri: { scheme: 'file', fsPath: path.join(repository, 'src', 'app.ts') } },
    { isDirty: true, uri: { scheme: 'file', fsPath: path.join(repository, 'src', 'app.ts') } },
    { isDirty: false, uri: { scheme: 'file', fsPath: path.join(repository, 'saved.ts') } },
    { isDirty: true, uri: { scheme: 'untitled', fsPath: path.join(repository, 'new.ts') } },
    { isDirty: true, uri: { scheme: 'file', fsPath: path.join(path.sep, 'other', 'file.ts') } }
  ], repository), ['src/app.ts']);
});

test('Story publication names a stale repository or unregistered branch before invoking the CLI', () => {
  const workflow = {
    workItem: { id: 'IDE-1', branch: 'IDE-1' },
    lineage: { canonicalBranch: 'IDE-1', childBranches: [{ name: 'feature/IDE-1-ui' }] }
  };
  assert.equal(storyCheckoutIssue('/workspace/story', {
    repository: { root: '/workspace/story', branch: 'feature/IDE-1-ui' }
  }, workflow), null);
  assert.equal(storyCheckoutIssue('/workspace/story', {
    repository: { root: '/workspace/base', branch: 'IDE-1' }
  }, workflow).code, 'repository-mismatch');
  assert.equal(storyCheckoutIssue('/workspace/story', {
    repository: { root: '/workspace/story', branch: 'main' }
  }, workflow).code, 'branch-mismatch');
});

test('the publication command saves and rechecks dirty buffers before it reaches the kernel', async () => {
  const source = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  const guard = source.indexOf("argv[0] === 'phase' && argv[1] === 'publish'");
  const invocation = source.indexOf('const ran = await runGovernedAction', guard);
  assert.ok(guard > 0 && invocation > guard);
  const protectedBlock = source.slice(guard, invocation);
  assert.match(protectedBlock, /storyCheckoutIssue/);
  assert.match(protectedBlock, /unsavedRepositoryPaths/);
  assert.match(protectedBlock, /workbench\.action\.files\.saveAll/);
  assert.ok((protectedBlock.match(/unsavedRepositoryPaths/g) ?? []).length >= 2,
    'dirty buffers are rechecked after Save All');
});

test('a consumed generation refusal offers the engine-planned digest rollover instead of a dead end', async () => {
  const source = await readFile(path.join(root, 'apps/vscode/src/actions.ts'), 'utf8');
  assert.match(source, /generationRolloverPhase/);
  assert.match(source, /\['phase', 'rollover', rolloverPhase, '--json'\]/);
  assert.match(source, /Start new generation/);
  assert.match(source, /'phase', 'rollover', rolloverPhase, '--confirm', preview\.confirmation/);
});
