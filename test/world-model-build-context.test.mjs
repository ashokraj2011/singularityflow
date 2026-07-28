import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isWorldModelBuildContext } from '../src/cli.mjs';

const tmp = path.sep === '/' ? '/private/var/folders/xx/T' : 'C:\\Temp';

test('detects the builder worktree by its resolved root path', () => {
  const root = path.join(tmp, 'singularity-flow-world-model-CiJz3O', 'repository');
  assert.equal(isWorldModelBuildContext(root, {}), true);
});

test('detects the branch-target builder worktree path', () => {
  const root = path.join(tmp, 'singularity-flow-world-model-branch-abc123', 'repository');
  assert.equal(isWorldModelBuildContext(root, {}), true);
});

test('detects via payload.cwd even when the resolved root is elsewhere', () => {
  const cwd = path.join(tmp, 'singularity-flow-world-model-XYZ', 'repository');
  assert.equal(isWorldModelBuildContext('/some/real/repo', { cwd }), true);
});

test('detects via the environment marker regardless of path', () => {
  const prior = process.env.SINGULARITY_FLOW_WORLD_MODEL_BUILD;
  process.env.SINGULARITY_FLOW_WORLD_MODEL_BUILD = '1';
  try {
    assert.equal(isWorldModelBuildContext('/some/real/repo', { cwd: '/some/real/repo' }), true);
  } finally {
    if (prior === undefined) delete process.env.SINGULARITY_FLOW_WORLD_MODEL_BUILD;
    else process.env.SINGULARITY_FLOW_WORLD_MODEL_BUILD = prior;
  }
});

test('does not exempt a normal contributor repository', () => {
  const prior = process.env.SINGULARITY_FLOW_WORLD_MODEL_BUILD;
  delete process.env.SINGULARITY_FLOW_WORLD_MODEL_BUILD;
  try {
    const root = path.join(tmp, 'my-project');
    assert.equal(isWorldModelBuildContext(root, { cwd: root }), false);
    // A repo that merely mentions the phrase in a deeper file path is not the temp worktree.
    assert.equal(isWorldModelBuildContext('/home/dev/notes/singularity-flow-world-model-ideas.md', {}), false);
  } finally {
    if (prior !== undefined) process.env.SINGULARITY_FLOW_WORLD_MODEL_BUILD = prior;
  }
});
