import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  exactWorldModelPlanDetail, loadScopedWorldModelBuildConfig, runExactWorldModelBuild,
  worldModelAuthorityRefreshArguments, legacyWorldModelLightArguments,
  legacyWorldModelLightDetail, worldModelBuildCompletionMessage,
  assertWorldModelBuildConfigurationSelection, observeWorldModelBuildConfigurationSelection,
  withWorldModelBuildConfigurationBoundary, worldModelBuildConfigurationBoundary
} = await import(path.join(root, 'apps', 'vscode', 'src', 'world-model-build-model.ts'));
const { SingularityFlowClient } = await import(path.join(root, 'apps', 'vscode', 'src', 'cli', 'client.ts'));
const { WORLD_MODEL_TIMEOUT_MS } = await import(path.join(root, 'apps', 'vscode', 'src', 'cli', 'runner.ts'));

const args = Object.freeze({
  views: ['arch.contracts', 'dev.impact'], depth: 'standard', consumer: 'developer',
  composer: 'deterministic', cachePolicy: 'reuse-valid'
});

function planned() {
  return {
    kind: 'plan', operation: { id: 'world-model.build', classification: 'mutation' },
    outcome: { status: 'succeeded' }, next: [{ handle: 'pla_exact' }], why: [], warnings: [],
    data: {
      plan: {
        handle: 'pla_exact',
        review: {
          requestSha256: `sha256:${'1'.repeat(64)}`,
          planSha256: `sha256:${'2'.repeat(64)}`,
          sourceManifestSha256: `sha256:${'3'.repeat(64)}`,
          scopeManifestSha256: `sha256:${'4'.repeat(64)}`,
          effectiveViews: ['arch.contracts@4', 'dev.impact@4'],
          requestedProjections: ['arch.calm@1'],
          projectionPolicies: [{
            projectionId: 'arch.calm', projectionVersion: 1, reference: 'arch.calm@1',
            required: false, cacheStatus: 'miss', validation: { strict: true },
            profile: {
              includeGovernanceActors: true, includeControls: true, includeFlows: true,
              includeExternalDependencies: 'direct-architecture-only'
            }
          }],
          depth: 'standard', composer: 'deterministic',
          publication: {
            remote: 'origin', branch: 'state', outputDir: 'singularity/world-model',
            expectedRemoteHead: null
          }
        }
      }
    }
  };
}

test('native World Model review renders exact digests and the state CAS target', () => {
  const detail = exactWorldModelPlanDetail(planned().data.plan.review, { capabilityId: 'payments-api' });
  assert.match(detail, /Request: sha256:1{64}/);
  assert.match(detail, /Plan: sha256:2{64}/);
  assert.match(detail, /Publish target: origin\/state · singularity\/world-model/);
  assert.match(detail, /Expected target head: branch absent/);
  assert.match(detail, /Scope: payments-api · sha256:4{64}/);
  assert.match(detail, /Projections: arch\.calm@1 · optional · strict validation · actors\+controls\+flows · external direct-architecture-only · cache miss/);
  assert.match(detail, /No provider, Git ref, or repository file has been changed/);
});

test('native World Model completion reports optional CALM status and its typed refusal', () => {
  const refusalSha256 = `sha256:${'f'.repeat(64)}`;
  const message = worldModelBuildCompletionMessage({
    status: 'completed', planned: planned(), capabilityId: 'payments-api',
    result: {
      kind: 'read', outcome: { status: 'succeeded' }, why: [], warnings: [], next: [],
      data: {
        manifestSha256: `sha256:${'a'.repeat(64)}`,
        views: [{ viewId: 'arch.contracts', status: 'available' }],
        projections: [{
          projectionId: 'arch.calm', status: 'unavailable',
          projectionSha256: null, refusalSha256
        }],
        refusals: [{
          projectionId: 'arch.calm', code: 'WMC_CALM_VALIDATOR_UNAVAILABLE', refusalSha256
        }]
      }
    }
  });
  assert.match(message, /World Model published as sha256:a{12} with 1 view\./);
  assert.match(message, /arch\.calm@1=unavailable \(optional; refusal WMC_CALM_VALIDATOR_UNAVAILABLE · sha256:f{12}\)/);
});

test('native World Model completion reports an available CALM projection without inventing a refusal', () => {
  const message = worldModelBuildCompletionMessage({
    status: 'completed', planned: planned(),
    result: {
      kind: 'read', outcome: { status: 'succeeded' }, why: [], warnings: [], next: [],
      data: {
        manifestSha256: `sha256:${'b'.repeat(64)}`,
        views: [{ viewId: 'arch.contracts', status: 'available' }],
        projections: [{
          projectionId: 'arch.calm', status: 'available',
          projectionSha256: `sha256:${'c'.repeat(64)}`, refusalSha256: null
        }],
        refusals: []
      }
    }
  });
  assert.match(message, /arch\.calm@1=available \(optional\)/);
  assert.doesNotMatch(message, /refusal/);
});

function capabilityChoiceRequired(ids = ['orders-api', 'payments-api']) {
  return Object.assign(new Error('choose capability'), {
    code: 'WMB_CAPABILITY_SELECTION_REQUIRED', details: { capabilityIds: ids }
  });
}

function acceptedStoryRecord(id, branch = id, workItemRoot = 'singularity/work-items') {
  return JSON.stringify({
    workItem: { id, branch }, status: 'in_progress',
    lineage: { canonicalBranch: branch, childBranches: [] },
    phases: { intake: { status: 'in_progress' } }, phaseOrder: ['intake'],
    resolution: { workItemRoot },
    workflowSnapshot: { enrollment: 'wfa' }
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function gitRepository(t, branch = 'main') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, 'init', '--initial-branch', branch);
  git(directory, 'config', 'user.name', 'SFlow Test');
  git(directory, 'config', 'user.email', 'sflow@example.invalid');
  await writeFile(path.join(directory, 'README.md'), '# fixture\n');
  git(directory, 'add', 'README.md');
  git(directory, 'commit', '-m', 'init');
  return directory;
}

test('native World Model config reloads with only the approved storyless capability choice', async () => {
  const loads = [];
  const choices = [];
  const result = await loadScopedWorldModelBuildConfig(async (capabilityId) => {
    loads.push(capabilityId);
    if (!capabilityId) throw capabilityChoiceRequired(['payments-api', 'orders-api']);
    return { repositoryCapability: { id: capabilityId }, definition: {} };
  }, async (ids) => {
    choices.push([...ids]);
    return 'payments-api';
  });
  assert.deepEqual(loads, [null, 'payments-api']);
  assert.deepEqual(choices, [['orders-api', 'payments-api']], 'choices are deterministic and bounded to approved IDs');
  assert.equal(result.capabilityId, 'payments-api');
  assert.equal(result.config.repositoryCapability.id, 'payments-api');
});

test('storyless native Build refuses a working-tree workflow draft before reading configuration', async () => {
  const calls = [];
  await assert.rejects(() => withWorldModelBuildConfigurationBoundary('approved-authority', {
    readStoryPinned: async () => { calls.push('story'); return 'wrong'; },
    withApprovedAuthority: async (read) => {
      calls.push('authority');
      return read({ kind: 'working-tree', ref: null, commit: null });
    },
    readInScope: async () => { calls.push('read'); return 'wrong'; }
  }), (error) => error.code === 'WMB_APPROVED_CONFIGURATION_REQUIRED');
  assert.deepEqual(calls, ['authority']);
});

test('storyless native Build retains one verified approved authority for its complete operation', async () => {
  const calls = [];
  const result = await withWorldModelBuildConfigurationBoundary('approved-authority', {
    readStoryPinned: async () => { calls.push('story'); return 'wrong'; },
    withApprovedAuthority: async (read) => {
      calls.push('authority:enter');
      const value = await read({ kind: 'approved-configuration-ref', ref: 'refs/remotes/origin/sflow/config', commit: 'a'.repeat(40) });
      calls.push('authority:leave');
      return value;
    },
    readInScope: async () => { calls.push('build'); return 'approved'; }
  });
  assert.equal(result, 'approved');
  assert.deepEqual(calls, ['authority:enter', 'build', 'authority:leave']);
});

test('Story native Build keeps its pinned configuration and never mounts current authority', async () => {
  const calls = [];
  const result = await withWorldModelBuildConfigurationBoundary('story-pinned', {
    readStoryPinned: async () => { calls.push('story'); return 'pinned'; },
    withApprovedAuthority: async () => { calls.push('authority'); return 'wrong'; },
    readInScope: async () => { calls.push('read'); return 'wrong'; }
  });
  assert.equal(result, 'pinned');
  assert.deepEqual(calls, ['story']);
});

test('native Build derives Story authority only from canonical WFA Story records', () => {
  const story = JSON.stringify({
    ...JSON.parse(acceptedStoryRecord('PAY-1')),
    lineage: { canonicalBranch: 'PAY-1', childBranches: [{ name: 'PAY-1-ui' }] },
    resolution: { workItemRoot: 'custom/items' }
  });
  assert.equal(worldModelBuildConfigurationBoundary('PAY-1', [
    { path: 'custom/items/PAY-1/workflow.json', content: story }
  ]), 'story-pinned');
  assert.equal(worldModelBuildConfigurationBoundary('PAY-1-ui', [
    { path: 'custom/items/PAY-1/workflow.json', content: story }
  ]), 'story-pinned');
  assert.equal(worldModelBuildConfigurationBoundary('main', [
    { path: 'custom/items/PAY-1/workflow.json', content: story }
  ]), 'approved-authority');
  assert.equal(worldModelBuildConfigurationBoundary('PAY-2', [
    { path: 'singularity/work-items/PAY-2/workflow.json', content: null }
  ]), 'approved-authority', 'unproven mutable/corrupt bytes are not Story identity');
  assert.equal(worldModelBuildConfigurationBoundary('main', [{
    path: 'app/main/workflow.json',
    content: acceptedStoryRecord('main', 'main', 'singularity/work-items')
  }]), 'approved-authority', 'an arbitrary workflow.json cannot bypass approved authority');
});

test('native Build refuses ambiguous tracked Story identity', () => {
  const record = (id) => JSON.stringify({
    ...JSON.parse(acceptedStoryRecord(id, 'shared')),
    resolution: { workItemRoot: id === 'A' ? 'singularity/work-items' : 'other/items' }
  });
  assert.throws(() => worldModelBuildConfigurationBoundary('shared', [
    { path: 'singularity/work-items/A/workflow.json', content: record('A') },
    { path: 'other/items/B/workflow.json', content: record('B') }
  ]), (error) => error.code === 'WMB_STORY_CONFIGURATION_AMBIGUOUS');
});

test('native Build reads Story identity from immutable HEAD, not staged or working-tree bytes', async (t) => {
  const repository = await gitRepository(t, 'PAY-1');
  const storyDirectory = path.join(repository, 'singularity', 'work-items', 'PAY-1');
  await mkdir(storyDirectory, { recursive: true });
  await writeFile(path.join(storyDirectory, 'workflow.json'), acceptedStoryRecord('PAY-1'));
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'accepted story');

  await writeFile(path.join(storyDirectory, 'workflow.json'), acceptedStoryRecord('OTHER', 'other'));
  git(repository, 'add', 'singularity/work-items/PAY-1/workflow.json');
  const selection = await observeWorldModelBuildConfigurationSelection(repository);
  assert.equal(selection.boundary, 'story-pinned');
  assert.equal(selection.workId, 'PAY-1');
  assert.equal(selection.workflowPath, 'singularity/work-items/PAY-1/workflow.json');
});

test('native Build never treats an unrelated committed workflow.json as Story authority', async (t) => {
  const repository = await gitRepository(t);
  const unrelated = path.join(repository, 'app', 'main');
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, 'workflow.json'), acceptedStoryRecord('main', 'main'));
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'application workflow');

  const selection = await observeWorldModelBuildConfigurationSelection(repository);
  assert.equal(selection.boundary, 'approved-authority');
  assert.equal(selection.workId, null);
  assert.equal(selection.workflowPath, null);
});

test('native Build safely preserves a detached accepted Story only with an exact branch-ref proof', async (t) => {
  const repository = await gitRepository(t, 'PAY-1');
  const storyDirectory = path.join(repository, 'singularity', 'work-items', 'PAY-1');
  await mkdir(storyDirectory, { recursive: true });
  await writeFile(path.join(storyDirectory, 'workflow.json'), acceptedStoryRecord('PAY-1'));
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'accepted story');
  git(repository, 'checkout', '--detach');

  const proven = await observeWorldModelBuildConfigurationSelection(repository);
  assert.equal(proven.branch, 'HEAD');
  assert.equal(proven.boundary, 'story-pinned');
  assert.equal(proven.workId, 'PAY-1');

  git(repository, 'branch', '-D', 'PAY-1');
  await assert.rejects(
    () => observeWorldModelBuildConfigurationSelection(repository),
    (error) => error.code === 'WMB_DETACHED_STORY_IDENTITY_REQUIRED'
  );
});

test('native Build rechecks branch and commit identity before executing a reviewed Plan', async (t) => {
  const repository = await gitRepository(t);
  const selection = await observeWorldModelBuildConfigurationSelection(repository);
  await writeFile(path.join(repository, 'after-review.txt'), 'changed\n');
  git(repository, 'add', 'after-review.txt');
  git(repository, 'commit', '-m', 'move reviewed source');
  await assert.rejects(
    () => assertWorldModelBuildConfigurationSelection(repository, selection),
    (error) => error.code === 'WMB_CONFIGURATION_BOUNDARY_STALE'
  );
});

test('native Build wiring mounts approved authority only for storyless work', async () => {
  const source = await readFile(path.join(root, 'apps/vscode/src/world-model-build.ts'), 'utf8');
  assert.match(source, /withApprovedConfigurationRead\([\s\S]{0,160}preferAuthority: true/u);
  assert.match(source, /observeWorldModelBuildConfigurationSelection\(active\.root\)/u);
  assert.match(source, /withWorldModelBuildConfigurationBoundary\(selection\.boundary/u);
  assert.match(source, /workId: configurationSelection\.workId/u);
  assert.ok((source.match(/assertWorldModelBuildConfigurationSelection\(active\.root/g) ?? []).length >= 2);
});

test('cancelling the storyless capability picker performs no reload or build-side action', async () => {
  const calls = [];
  const result = await loadScopedWorldModelBuildConfig(async (capabilityId) => {
    calls.push(`load:${capabilityId}`);
    throw capabilityChoiceRequired();
  }, async (ids) => {
    calls.push(`choose:${ids.join(',')}`);
    return null;
  });
  assert.equal(result, null);
  assert.deepEqual(calls, ['load:null', 'choose:orders-api,payments-api']);
});

test('native World Model capability selection refuses values outside the approved diagnostic set', async () => {
  let reloads = 0;
  await assert.rejects(() => loadScopedWorldModelBuildConfig(async (capabilityId) => {
    if (!capabilityId) throw capabilityChoiceRequired();
    reloads += 1;
    return { repositoryCapability: { id: capabilityId } };
  }, async () => 'unreviewed-api'), (error) => error.code === 'WMB_CAPABILITY_SELECTION_INVALID');
  assert.equal(reloads, 0);
});

test('native World Model authority refresh and retry preserve the exact approved capability', async () => {
  const loads = [];
  const scoped = await loadScopedWorldModelBuildConfig(async (capabilityId) => {
    loads.push(capabilityId);
    return { repositoryCapability: { id: capabilityId } };
  }, async () => {
    throw new Error('a preserved retry must not reopen the capability picker');
  }, 'payments-api');
  assert.equal(scoped.capabilityId, 'payments-api');
  assert.deepEqual(loads, ['payments-api']);
  assert.deepEqual(worldModelAuthorityRefreshArguments(scoped.capabilityId), [
    'wm', 'refresh-authority', '--format', 'registered-v4', '--capability', 'payments-api'
  ]);
  assert.deepEqual(worldModelAuthorityRefreshArguments(), [
    'wm', 'refresh-authority', '--format', 'registered-v4'
  ]);
  assert.throws(
    () => worldModelAuthorityRefreshArguments('payments api'),
    (error) => error.code === 'WMB_CAPABILITY_SELECTION_INVALID'
  );
});

test('legacy light build is exact, state-only, deterministic, and pinned to source', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(legacyWorldModelLightArguments('payments-api', digest), [
    'wm', 'light', '--format', 'legacy-v3', '--views', 'all', '--state-only',
    '--expected-source-tree-sha256', digest, '--capability', 'payments-api'
  ]);
  assert.deepEqual(legacyWorldModelLightArguments(null, digest), [
    'wm', 'light', '--format', 'legacy-v3', '--views', 'all', '--state-only',
    '--expected-source-tree-sha256', digest
  ]);
  const detail = legacyWorldModelLightDetail({
    repository: '/repo', branch: 'STORY-1', sourceCommit: 'a'.repeat(40),
    sourceTreeSha256: digest, views: ['architecture', 'testing'], remote: 'origin',
    stateBranch: 'state', outputDir: 'singularity/world-model', capabilityId: 'payments-api'
  });
  assert.match(detail, /Effective format: legacy-v3/);
  assert.match(detail, /Concrete views: architecture, testing/);
  assert.match(detail, /Only publication target: origin\/state/);
  assert.match(detail, /Current branch: STORY-1 · no model installation, commit, or push/);
  assert.match(detail, /zero model calls/);
  assert.match(detail, /wm light --format legacy-v3 --views all --state-only --expected-source-tree-sha256 sha256:a{64} --capability payments-api/);
  assert.throws(() => legacyWorldModelLightArguments(null, 'bad'), (error) => error.code === 'WMB_SOURCE_SNAPSHOT_INVALID');
  assert.throws(() => legacyWorldModelLightArguments('payments api', digest), (error) => error.code === 'WMB_CAPABILITY_SELECTION_INVALID');
});

test('legacy light uses the bounded World Model deadline, not the ordinary CLI deadline', () => {
  const client = new SingularityFlowClient({ repository: '/repo', location: { command: 'singularity-flow', args: [] } });
  assert.equal(client.timeoutFor(['wm', 'light', '--format', 'legacy-v3']), WORLD_MODEL_TIMEOUT_MS);
});

test('cancelling native review never creates or redeems a confirmation receipt', async () => {
  const calls = [];
  const kernel = {
    resolve: async () => { calls.push('resolve'); return planned(); },
    confirmPlan: () => { calls.push('confirm'); throw new Error('must not confirm'); },
    run: async () => { calls.push('run'); throw new Error('must not run'); }
  };
  const outcome = await runExactWorldModelBuild(kernel, args, async () => {
    calls.push('review'); return false;
  });
  assert.equal(outcome.status, 'cancelled');
  assert.deepEqual(calls, ['resolve', 'review']);
});

test('accepted native review keeps the one-time receipt out of plan and tool arguments', async () => {
  const calls = [];
  const plan = planned();
  const kernel = {
    resolve: async ({ arguments: received }) => {
      calls.push('resolve'); assert.deepEqual(received, args); return plan;
    },
    confirmPlan: (received) => {
      calls.push('confirm');
      assert.deepEqual(received, {
        planId: 'pla_exact',
        requestSha256: plan.data.plan.review.requestSha256,
        planSha256: plan.data.plan.review.planSha256
      });
      return { receiptId: 'rcp_private', value: 'secret-private-value' };
    },
    run: async (toolArguments, hostConfirmation) => {
      calls.push('run');
      assert.deepEqual(toolArguments, { planId: 'pla_exact' });
      assert.deepEqual(hostConfirmation, {
        confirmationReceiptId: 'rcp_private', confirmationValue: 'secret-private-value'
      });
      return {
        kind: 'read', outcome: { status: 'succeeded' }, why: [], warnings: [], next: [],
        data: { manifestSha256: `sha256:${'a'.repeat(64)}` }
      };
    }
  };
  const outcome = await runExactWorldModelBuild(
    kernel, args,
    async (review) => {
      calls.push('review');
      assert.equal(JSON.stringify(review).includes('secret-private-value'), false);
      return true;
    },
    async (operation) => { calls.push('progress'); return operation(); }
  );
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(calls, ['resolve', 'review', 'confirm', 'progress', 'run']);
});

test('a planning refusal never reaches review or confirmation', async () => {
  const refusal = {
    kind: 'refusal', outcome: { status: 'refused' }, why: [{ code: 'gateway.plan-invalid' }],
    warnings: [], next: [], data: {}
  };
  let reviews = 0;
  const outcome = await runExactWorldModelBuild({
    resolve: async () => refusal,
    confirmPlan: () => { throw new Error('must not confirm'); },
    run: async () => { throw new Error('must not run'); }
  }, args, async () => { reviews += 1; return true; });
  assert.equal(outcome.status, 'refused');
  assert.equal(reviews, 0);
  assert.equal(outcome.result, refusal);
});
