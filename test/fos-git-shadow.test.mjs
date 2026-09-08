import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  runFosGitShadowRead, summarizeFosGitShadowObservations
} from '../src/fos-git-shadow.mjs';
import { rememberWorkspace, workspaceStatus } from '../src/workspace.mjs';
import { activateWorkspaceContext } from '../src/workspace-context.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('FOS Git reference mode never executes the candidate reader', async () => {
  let candidateCalls = 0;
  const result = await runFosGitShadowRead({
    operation: 'workspace.repository-status',
    reference: async () => ({ status: 'ready' }),
    candidate: async () => { candidateCalls += 1; return { status: 'ready' }; }
  });
  assert.deepEqual(result.value, { status: 'ready' });
  assert.equal(result.observation, null);
  assert.equal(candidateCalls, 0);
});

test('FOS Git shadow observations are content-free and never replace the reference verdict', async () => {
  const records = [];
  const result = await runFosGitShadowRead({
    operation: 'workspace.repository-status',
    mode: 'shadow',
    reference: async () => ({ branch: 'private-branch', remote: 'private-remote' }),
    candidate: async () => ({ branch: 'different-branch', remote: 'different-remote' }),
    record: async (value) => { records.push(value); }
  });
  assert.deepEqual(result.value, { branch: 'private-branch', remote: 'private-remote' });
  assert.equal(result.observation.outcome, 'semantic-mismatch');
  assert.equal(records.length, 1);
  const serialized = JSON.stringify(records[0]);
  for (const secret of ['private-branch', 'private-remote', 'different-branch', 'different-remote']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(summarizeFosGitShadowObservations(records), {
    mode: 'shadow', authoritativePath: 'reference', comparisons: 1,
    equivalent: 0, semanticMismatch: 1, candidateError: 0, valuesRecorded: false
  });
});

test('FOS Git shadow candidate and recorder failures cannot block the reference read', async () => {
  const result = await runFosGitShadowRead({
    operation: 'workspace.repository-status',
    mode: 'shadow',
    reference: async () => ({ healthy: true }),
    candidate: async () => {
      const error = new Error('/private/repository/path');
      error.code = 'GIT_QUERY_FAILED';
      throw error;
    },
    record: async () => { throw new Error('metrics destination unavailable'); }
  });
  assert.deepEqual(result.value, { healthy: true });
  assert.equal(result.observation.outcome, 'candidate-error');
  assert.equal(result.observation.errorCode, 'GIT_QUERY_FAILED');
  assert.equal(JSON.stringify(result.observation).includes('/private/repository/path'), false);
});

test('workspace Git shadow comparison matches the legacy projection for a real repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-workspace-shadow-'));
  const checkout = path.join(root, 'repos', 'api');
  await mkdir(checkout, { recursive: true });
  git(['init', '-q', '-b', 'main'], checkout);
  git(['config', 'user.name', 'FOS Shadow'], checkout);
  git(['config', 'user.email', 'shadow@example.com'], checkout);
  git(['remote', 'add', 'origin', 'https://example.test/api.git'], checkout);
  await writeFile(path.join(checkout, 'tracked.txt'), 'tracked\n');
  git(['add', '.'], checkout);
  git(['commit', '-qm', 'initial'], checkout);
  await writeFile(path.join(checkout, 'untracked.txt'), 'untracked\n');
  await writeFile(path.join(root, 'workspace.json'), `${JSON.stringify({
    version: 1,
    id: 'shadow-workspace',
    name: 'Shadow workspace',
    anchor: { provider: 'workspace', key: 'shadow-workspace', title: 'Shadow workspace' },
    leadRepository: 'api',
    capabilities: [],
    repositories: {
      api: {
        url: 'https://example.test/api.git', defaultBranch: 'main',
        path: 'repos/api', capabilities: []
      }
    }
  }, null, 2)}\n`);

  const reference = await workspaceStatus(root, { level: 'summary' });
  const observations = [];
  const shadow = await workspaceStatus(root, {
    level: 'summary',
    gitReadMode: 'shadow',
    onGitShadowComparison(value) { observations.push(value); }
  });
  assert.deepEqual(shadow.repositories, reference.repositories,
    'shadow mode must return the reference repository projection');
  assert.deepEqual(shadow.counts, reference.counts,
    'shadow mode must not change workspace readiness counts');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].outcome, 'equivalent');
  assert.equal(observations[0].valuesRecorded, false);

  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active-workspace.json');
  await rememberWorkspace(registry, reference.workspace, reference);
  await activateWorkspaceContext(registry, selection, reference.workspace.id);
  const output = JSON.parse(execFileSync(process.execPath, [
    cli, 'workspace', 'current', '--git-shadow', '--json'
  ], {
    cwd: checkout,
    encoding: 'utf8',
    env: {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection
    }
  }));
  assert.equal(output.active, true);
  assert.deepEqual(output.gitShadow, {
    mode: 'shadow', authoritativePath: 'reference', comparisons: 1,
    equivalent: 1, semanticMismatch: 0, candidateError: 0, valuesRecorded: false
  });
});

test('FOS Git shadow refuses unreviewed operations and modes', async () => {
  const readers = { reference: async () => ({}), candidate: async () => ({}) };
  await assert.rejects(() => runFosGitShadowRead({ operation: 'git.anything', ...readers }),
    (error) => error.code === 'FOS_GIT_SHADOW_OPERATION_INVALID');
  await assert.rejects(() => runFosGitShadowRead({
    operation: 'workspace.repository-status', mode: 'optimized', ...readers
  }), (error) => error.code === 'FOS_GIT_SHADOW_MODE_INVALID');
});
