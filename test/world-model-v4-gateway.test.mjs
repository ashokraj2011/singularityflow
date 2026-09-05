import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateArguments } from '../src/gateway/argument-schemas.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { worldModelGatewayCapabilities } from '../src/gateway/planners/world-model-run.mjs';
import { SFLOW_TOOLS } from '../src/gateway/tools.mjs';
import { publishToStateBranch } from '../src/ledger.mjs';
import { run } from '../src/util.mjs';
import { sha256 } from '../src/world-model/canonicalize.mjs';
import { buildAndPublishWorldModelV4 } from '../src/world-model/service.mjs';
import { refreshWorldModelV4Authority } from '../src/world-model/authority-refresh.mjs';

const LEDGER = Object.freeze({
  enabled: true,
  branch: 'state',
  remote: 'origin',
  behind: 'block',
  enforcement: 'shadow',
  signing: 'off',
  trustTier: 'T0',
  maxRetries: 3
});

function git(root, ...args) {
  return run('git', args, { cwd: root });
}

async function repository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-gateway-'));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  t.after(() => rm(parent, { recursive: true, force: true }));
  run('git', ['init', '--bare', remote]);
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WMB Gateway Tests');
  git(root, 'config', 'user.email', 'wmb-gateway@example.invalid');
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const answer = 42;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'application source');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  return root;
}

function capabilities(root, { selectedCapabilityId = null } = {}) {
  return worldModelGatewayCapabilities({
    defaults: {
      outputDir: 'singularity/world-model',
      ledgerConfig: LEDGER,
      capabilityId: 'gateway-fixture',
      allowedPaths: ['src/**'],
      excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**'],
      policySnapshotSha256: sha256({ fixture: 'wmb-gateway-policy' }),
      selectedCapabilityId,
      generatedAt: '2026-09-01T00:00:00.000Z'
    }
  });
}

function buildOptions(overrides = {}) {
  return {
    outputDir: 'singularity/world-model',
    ledgerConfig: LEDGER,
    capabilityId: 'gateway-fixture',
    allowedPaths: ['src/**'],
    excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**'],
    policySnapshotSha256: sha256({ fixture: 'wmb-gateway-policy' }),
    generatedAt: '2026-09-01T00:00:00.000Z',
    composer: 'deterministic',
    ...overrides
  };
}

test('the five-tool surface keeps WMB run handle-only and validates closed build arguments', () => {
  assert.equal(SFLOW_TOOLS.length, 5);
  const runTool = SFLOW_TOOLS.find((entry) => entry.name === 'sflow_run');
  assert.deepEqual(Object.keys(runTool.inputSchema.properties), ['planId']);
  assert.deepEqual(validateArguments('world-model-build-v1', {
    views: ['dev.impact@4', 'arch.contracts', 'dev.impact@4'],
    depth: 'standard', composer: 'deterministic'
  }), {
    views: ['arch.contracts', 'dev.impact@4'], depth: 'standard', composer: 'deterministic'
  });
  assert.throws(
    () => validateArguments('world-model-build-v1', { views: 'dev.impact' }),
    (error) => error.code === 'INVALID_OPERATION_ARGUMENT'
  );
  assert.throws(
    () => validateArguments('world-model-build-v1', {
      views: Array.from({ length: 33 }, (_value, index) => `view.item-${index + 1}`)
    }),
    (error) => error.code === 'INVALID_OPERATION_ARGUMENT'
  );
  assert.throws(
    () => validateArguments('world-model-build-v1', {
      views: ['dev.impact'], command: 'git push --force'
    }),
    (error) => error.code === 'UNKNOWN_OPERATION_ARGUMENT'
  );
});

test('an exact reviewed WMB Plan requires an out-of-band one-time confirmation and publishes', async (t) => {
  const root = await repository(t);
  await publishToStateBranch(root, LEDGER, {
    'singularity/existing.json': '{"existing":true}\n'
  }, '[test] establish state authority');
  const refsBeforePlan = git(root, 'for-each-ref', '--format=%(refname) %(objectname)').stdout;
  const wired = capabilities(root);
  const { kernel } = createHostGateway({
    root,
    hostSessionId: 'wmb-gateway-session',
    planners: gatewayPlanners(),
    readOnly: false,
    ...wired
  });
  const planned = kernel.resolve({
    utterance: 'build and publish registered world model',
    arguments: {
      views: ['dev.impact'], depth: 'standard', consumer: 'developer',
      composer: 'deterministic', cachePolicy: 'reuse-valid'
    }
  });
  assert.equal(planned.kind, 'plan', JSON.stringify(planned, null, 2));
  assert.equal(planned.operation.id, 'world-model.build');
  assert.match(planned.next[0].handle, /^pla_/);
  assert.match(planned.data.plan.review.requestSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(planned.data.plan.review.planSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(planned.data.plan.review.publication.atomic, true);
  assert.equal(planned.data.plan.review.publication.expectedRemoteHead?.length, 40);
  assert.equal(planned.data.plan.review.publication.endpoint.configuredUrl, undefined);
  assert.equal(planned.data.plan.review.publication.endpoint.effectiveUrl, undefined);
  assert.equal(JSON.stringify(planned.data.plan.review).includes(path.dirname(root)), false,
    'review exposes endpoint hashes, never raw local or credentialed URLs');
  assert.equal(git(root, 'for-each-ref', '--format=%(refname) %(objectname)').stdout, refsBeforePlan,
    'planning observes the remote without fetching or changing any Git ref');
  assert.equal(planned.data.plan.confirmation, 'exact-confirm');

  const unconfirmed = await kernel.run({ planId: planned.next[0].handle });
  assert.equal(unconfirmed.why[0].code, 'gateway.confirmation-required');
  assert.throws(
    () => kernel.confirmPlan({
      planId: planned.next[0].handle,
      requestSha256: planned.data.plan.review.requestSha256,
      planSha256: sha256({ wrong: true })
    }),
    (error) => error.code === 'PLAN_CONFIRMATION_MISMATCH'
  );

  const confirmation = kernel.confirmPlan({
    planId: planned.next[0].handle,
    requestSha256: planned.data.plan.review.requestSha256,
    planSha256: planned.data.plan.review.planSha256
  });
  const invalid = await kernel.run(
    { planId: planned.next[0].handle },
    { confirmationReceiptId: confirmation.receiptId, confirmationValue: 'invented' }
  );
  assert.equal(invalid.why[0].code, 'gateway.confirmation-invalid');

  // A failed redemption does not burn the host-owned receipt or the exact reviewed Plan.
  const completed = await kernel.run(
    { planId: planned.next[0].handle },
    { confirmationReceiptId: confirmation.receiptId, confirmationValue: confirmation.value }
  );
  assert.equal(completed.operation.id, 'world-model.build');
  assert.equal(completed.operation.classification, 'mutation');
  assert.equal(completed.outcome.status, 'succeeded');
  assert.equal(completed.data.requestSha256, planned.data.plan.review.requestSha256);
  assert.equal(completed.data.planSha256, planned.data.plan.review.planSha256);
  assert.equal(completed.effects.publicationCreated, true);

  const replay = await kernel.run(
    { planId: planned.next[0].handle },
    { confirmationReceiptId: confirmation.receiptId, confirmationValue: confirmation.value }
  );
  assert.equal(replay.why[0].code, 'gateway.handle-consumed');

  const approval = kernel.resolve({
    utterance: 'take me to the approval', arguments: { workId: 'WRK-1' }
  });
  assert.equal(approval.kind, 'ceremony');
  assert.equal(approval.operation.classification, 'authorization');
  assert.match(approval.next[0].handle, /^ceremony:/);
});

test('confirmed WMB target and state CAS authority cannot be redirected or advanced', async (t) => {
  const root = await repository(t);
  await publishToStateBranch(root, LEDGER, {
    'singularity/existing.json': '{"existing":true}\n'
  }, '[test] establish state authority');
  const wired = capabilities(root);
  const newGateway = (session) => createHostGateway({
    root, hostSessionId: session, planners: gatewayPlanners(), readOnly: false, ...wired
  }).kernel;

  const redirected = newGateway('wmb-endpoint-drift');
  const endpointPlan = redirected.resolve({
    utterance: 'build and publish registered world model',
    arguments: { views: ['dev.impact'], composer: 'deterministic' }
  });
  assert.equal(endpointPlan.kind, 'plan', JSON.stringify(endpointPlan, null, 2));
  const endpointReceipt = redirected.confirmPlan({
    planId: endpointPlan.next[0].handle,
    requestSha256: endpointPlan.data.plan.review.requestSha256,
    planSha256: endpointPlan.data.plan.review.planSha256
  });
  const alternate = path.join(path.dirname(root), 'alternate.git');
  run('git', ['init', '--bare', alternate]);
  git(root, 'remote', 'set-url', '--push', 'origin', alternate);
  await assert.rejects(
    redirected.run(
      { planId: endpointPlan.next[0].handle },
      {
        confirmationReceiptId: endpointReceipt.receiptId,
        confirmationValue: endpointReceipt.value
      }
    ),
    (error) => error.code === 'WMB_GATEWAY_PLAN_DRIFTED'
  );
  assert.equal(run('git', ['--git-dir', alternate, 'branch', '--list', 'state']).stdout.trim(), '');

  git(root, 'remote', 'set-url', '--push', 'origin', git(root, 'remote', 'get-url', 'origin').stdout.trim());
  const advanced = newGateway('wmb-cas-drift');
  const casPlan = advanced.resolve({
    utterance: 'build and publish registered world model',
    arguments: { views: ['dev.impact'], composer: 'deterministic' }
  });
  assert.equal(casPlan.kind, 'plan', JSON.stringify(casPlan, null, 2));
  const casReceipt = advanced.confirmPlan({
    planId: casPlan.next[0].handle,
    requestSha256: casPlan.data.plan.review.requestSha256,
    planSha256: casPlan.data.plan.review.planSha256
  });
  await publishToStateBranch(root, LEDGER, {
    'singularity/concurrent.json': '{"concurrent":true}\n'
  }, '[test] concurrent state advance');
  await assert.rejects(
    advanced.run(
      { planId: casPlan.next[0].handle },
      { confirmationReceiptId: casReceipt.receiptId, confirmationValue: casReceipt.value }
    ),
    (error) => error.code === 'WMB_GATEWAY_PLAN_DRIFTED'
  );
});

test('gateway planning refuses an unmaterialized remote view set and preserves it after explicit refresh', async (t) => {
  const firstClone = await repository(t);
  const remote = git(firstClone, 'remote', 'get-url', 'origin').stdout.trim();
  await buildAndPublishWorldModelV4(firstClone, buildOptions({
    views: ['dev.impact'], generatedAt: '2026-09-01T00:10:00.000Z'
  }));

  const secondClone = path.join(path.dirname(remote), 'clone-b', 'repo');
  await mkdir(path.dirname(secondClone), { recursive: true });
  run('git', ['clone', '-q', '--branch', 'main', remote, secondClone]);
  git(secondClone, 'config', 'user.name', 'WMB Gateway Tests B');
  git(secondClone, 'config', 'user.email', 'wmb-gateway-b@example.invalid');
  await buildAndPublishWorldModelV4(secondClone, buildOptions({
    views: ['biz.rules'], generatedAt: '2026-09-01T00:10:01.000Z'
  }));

  const staleTip = git(firstClone, 'rev-parse', 'refs/remotes/origin/state').stdout.trim();
  const remoteTip = git(
    firstClone, 'ls-remote', '--heads', 'origin', 'refs/heads/state'
  ).stdout.trim().split(/\s+/)[0];
  assert.notEqual(staleTip, remoteTip);
  const refsBefore = git(
    firstClone, 'for-each-ref', '--format=%(refname) %(objectname)'
  ).stdout;

  // Model both choices from a two-capability repository. The gateway receives only the approved
  // selection, and a retry command must retain that exact selection without leaking the other.
  for (const capabilityId of ['payments-api', 'orders-api']) {
    const selected = capabilities(firstClone, { selectedCapabilityId: capabilityId });
    const { kernel: selectedKernel } = createHostGateway({
      root: firstClone,
      hostSessionId: `wmb-stale-authority-${capabilityId}`,
      planners: gatewayPlanners(),
      readOnly: false,
      ...selected
    });
    const selectedRefusal = await selectedKernel.resolve({
      utterance: 'build and publish registered world model',
      arguments: { views: ['arch.contracts'], composer: 'deterministic' }
    });
    assert.equal(selectedRefusal.kind, 'refusal');
    assert.equal(
      selectedRefusal.why[0].slots.nextAction,
      `singularity-flow wm refresh-authority --format registered-v4 --capability ${capabilityId}`
    );
  }

  const wired = capabilities(firstClone, { selectedCapabilityId: 'payments-api' });
  const { kernel } = createHostGateway({
    root: firstClone,
    hostSessionId: 'wmb-stale-authority-session',
    planners: gatewayPlanners(),
    readOnly: false,
    ...wired
  });
  const refused = await kernel.resolve({
    utterance: 'build and publish registered world model',
    arguments: { views: ['arch.contracts'], composer: 'deterministic' }
  });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'gateway.plan-invalid');
  assert.equal(refused.why[0].slots.code, 'WMB_GATEWAY_STATE_AUTHORITY_REFRESH_REQUIRED');
  assert.equal(
    refused.why[0].slots.nextAction,
    'singularity-flow wm refresh-authority --format registered-v4 --capability payments-api'
  );
  assert.equal(git(
    firstClone, 'for-each-ref', '--format=%(refname) %(objectname)'
  ).stdout, refsBefore, 'read-only planning must not fetch or mutate refs');

  const refreshed = await refreshWorldModelV4Authority(firstClone, {
    outputDir: 'singularity/world-model', stateBranch: 'state', remote: 'origin',
    definition: { ledger: LEDGER }
  });
  assert.equal(refreshed.status, 'refreshed');
  const planned = kernel.resolve({
    utterance: 'build and publish registered world model',
    arguments: { views: ['arch.contracts'], composer: 'deterministic' }
  });
  assert.equal(planned.kind, 'plan', JSON.stringify(planned, null, 2));
  assert.deepEqual(planned.data.plan.review.effectiveViews
    .map((entry) => entry.replace(/@\d+$/, '')), [
    'arch.contracts', 'biz.rules', 'dev.impact'
  ]);
  const confirmation = kernel.confirmPlan({
    planId: planned.next[0].handle,
    requestSha256: planned.data.plan.review.requestSha256,
    planSha256: planned.data.plan.review.planSha256
  });
  const completed = await kernel.run(
    { planId: planned.next[0].handle },
    {
      confirmationReceiptId: confirmation.receiptId,
      confirmationValue: confirmation.value
    }
  );
  assert.equal(completed.outcome.status, 'succeeded');

  const manifest = JSON.parse(run('git', [
    `--git-dir=${remote}`, 'show', 'refs/heads/state:singularity/world-model/manifest.json'
  ]).stdout);
  assert.deepEqual(manifest.views.map((entry) => entry.viewId), [
    'arch.contracts', 'biz.rules', 'dev.impact'
  ]);
});

test('source drift after confirmation refuses the Plan before execution', async (t) => {
  const root = await repository(t);
  const wired = capabilities(root);
  const { kernel } = createHostGateway({
    root, hostSessionId: 'wmb-drift-session', planners: gatewayPlanners(), readOnly: false, ...wired
  });
  const planned = kernel.resolve({
    utterance: 'generate registered world model views',
    arguments: { views: ['dev.impact'], composer: 'deterministic' }
  });
  assert.equal(planned.kind, 'plan', JSON.stringify(planned, null, 2));
  const confirmation = kernel.confirmPlan({
    planId: planned.next[0].handle,
    requestSha256: planned.data.plan.review.requestSha256,
    planSha256: planned.data.plan.review.planSha256
  });
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const answer = 43;\n');
  const refused = await kernel.run(
    { planId: planned.next[0].handle },
    { confirmationReceiptId: confirmation.receiptId, confirmationValue: confirmation.value }
  );
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'gateway.handle-drifted');
  assert.equal(git(root, 'branch', '--list', 'state').stdout.trim(), '');
});

test('model-backed WMB planning fails closed when gateway model routing is disabled', async (t) => {
  const root = await repository(t);
  const wired = capabilities(root);
  const { kernel } = createHostGateway({
    root,
    hostSessionId: 'wmb-no-model-session',
    planners: gatewayPlanners(),
    readOnly: false,
    policyLayers: [
      {
        layer: 'central',
        modelRouting: 'enabled',
        confirmation: { 'world-model.build': 'exact-confirm' },
        denied: []
      },
      { layer: 'host-capability', modelRouting: 'disabled', confirmation: {}, denied: [] }
    ],
    ...wired
  });
  const refused = kernel.resolve({
    utterance: 'build and publish registered world model',
    arguments: { views: ['dev.impact'], composer: 'model' }
  });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.operation.classification, 'mutation');
  assert.equal(refused.why[0].code, 'gateway.plan-invalid');
  assert.equal(refused.why[0].slots.code, 'WMB_GATEWAY_MODEL_ROUTING_DISABLED');
  assert.equal(git(root, 'branch', '--list', 'state').stdout.trim(), '');
});
