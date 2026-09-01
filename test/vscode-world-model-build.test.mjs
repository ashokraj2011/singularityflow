import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  exactWorldModelPlanDetail, runExactWorldModelBuild
} = await import(path.join(root, 'apps', 'vscode', 'src', 'world-model-build-model.ts'));

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
  const detail = exactWorldModelPlanDetail(planned().data.plan.review);
  assert.match(detail, /Request: sha256:1{64}/);
  assert.match(detail, /Plan: sha256:2{64}/);
  assert.match(detail, /Publish target: origin\/state · singularity\/world-model/);
  assert.match(detail, /Expected target head: branch absent/);
  assert.match(detail, /No provider, Git ref, or repository file has been changed/);
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
