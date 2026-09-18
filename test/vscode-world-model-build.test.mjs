import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  exactWorldModelPlanDetail, loadScopedWorldModelBuildConfig, runExactWorldModelBuild,
  worldModelAuthorityRefreshArguments, legacyWorldModelLightArguments,
  legacyWorldModelLightDetail
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
  assert.match(detail, /No provider, Git ref, or repository file has been changed/);
});

function capabilityChoiceRequired(ids = ['orders-api', 'payments-api']) {
  return Object.assign(new Error('choose capability'), {
    code: 'WMB_CAPABILITY_SELECTION_REQUIRED', details: { capabilityIds: ids }
  });
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
