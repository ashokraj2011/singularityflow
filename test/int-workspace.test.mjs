/**
 * Switching a workspace changes which workspace the next question is about, and nothing governed.
 * `[INT:AC-010]` `[INT:CON-067]` `[INT:CON-068]`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostGateway } from '../src/gateway/host.mjs';
import { gatewayMutationExecutors } from '../src/gateway/planners/executors.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { readActiveWorkspaceContext } from '../src/workspace-context.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

async function twoWorkspaces(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-int-workspace-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json')
  };
  const source = path.join(base, 'source');
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.email', 'dev@example.test');
  git(source, 'config', 'user.name', 'Dev');
  await mkdir(path.join(source, 'singularity', 'work-items', 'WRK-1'), { recursive: true });
  await writeFile(path.join(source, 'singularity', 'work-items', 'WRK-1', 'workflow.json'), JSON.stringify({
    workItem: { id: 'WRK-1', title: 'Pinned work', workType: 'feature', branch: 'main' }, phaseOrder: ['design'], currentPhase: 'design',
    phases: { design: { status: 'in_progress', generation: 1 } }, history: []
  }));
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'seed');
  const sflow = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: base, env, encoding: 'utf8', timeout: 120_000 });
  for (const id of ['payments', 'identity']) {
    const created = sflow('workspace', 'create', '--local', '--id', id, '--base', path.join(base, 'ws'), '--lead', 'app',
      '--repository', `app=${source}`, '--clone', '--confirm', id, '--json');
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
  }
  assert.equal(sflow('workspace', 'use', 'payments', '--json').status, 0);
  const repository = path.join(base, 'ws', 'payments', 'repos', 'app');
  // A clone does not inherit the seed's identity, and a handle binds the actor.
  git(repository, 'config', 'user.email', 'dev@example.test');
  git(repository, 'config', 'user.name', 'Dev');
  return { base, env, repository };
}

test('switch-is-context-not-authority', { timeout: 240_000 }, async (t) => {
  const { env, repository } = await twoWorkspaces(t);
  for (const [key, value] of Object.entries(env)) if (key.startsWith('SINGULARITY_FLOW_')) process.env[key] = value;
  const governed = () => Promise.all([
    git(repository, 'for-each-ref', '--format=%(refname) %(objectname)'),
    git(repository, 'rev-parse', 'HEAD'),
    readFile(path.join(repository, 'singularity', 'work-items', 'WRK-1', 'workflow.json'), 'utf8')
  ]);
  const before = await governed();

  const host = createHostGateway({
    root: repository, hostSessionId: 'sess-workspace', workspaceId: 'local--payments', planners: gatewayPlanners(),
    mutationExecutors: gatewayMutationExecutors(), readOnly: false
  });
  // Registered IDs are site-scoped (local--…). Anything else — a name, a near miss — is refused at
  // planning; nothing is matched by similarity.
  const unknown = await host.kernel.resolve({ utterance: 'switch workspace', arguments: { workspaceId: 'paymnts' } });
  assert.deepEqual([unknown.kind, unknown.why[0].slots.code], ['refusal', 'WORKSPACE_NOT_REGISTERED']);

  const planned = await host.kernel.resolve({ utterance: 'switch workspace', arguments: { workspaceId: 'local--identity' } });
  assert.equal(planned.kind, 'plan', JSON.stringify(planned.why));
  const plan = planned.data.plan;
  assert.equal(plan.confirmation, 'host-confirm', 'switching needs an explicit host confirmation');
  assert.deepEqual(Object.entries(plan.effects).filter(([, value]) => value).map(([key]) => key), ['contextChanged']);
  assert.deepEqual(plan.review.preview.unchanged, ['approval authority', 'lifecycle state', 'pinned Story configuration', 'Git refs']);

  // Not without the host's confirmation.
  assert.equal((await host.kernel.run({ planId: plan.handle })).why[0].code, 'gateway.confirmation-required');
  const review = host.kernel.planReview(plan.handle);
  const receipt = host.kernel.confirmPlan({ planId: plan.handle, planHash: review.planHash });
  const switched = await host.kernel.run({ planId: plan.handle },
    { confirmationReceiptId: receipt.receiptId, confirmationValue: receipt.value });
  assert.equal(switched.outcome.status, 'succeeded');
  assert.deepEqual(Object.entries(switched.effects).filter(([, value]) => value).map(([key]) => key), ['contextChanged']);

  // The presentation context moved — through the same service `sflow workspace use` uses …
  const active = await readActiveWorkspaceContext(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, { refresh: false });
  assert.equal(active.workspaceId, 'local--identity');
  // … and nothing governed did: refs, HEAD and the pinned work record are byte-identical.
  assert.deepEqual(await governed(), before);

  // Back to payments, then identity again: the last switch has the first one's exact preview, and is a
  // new act all the same — it switches, rather than replaying the first switch's "succeeded".
  const activeNow = async () => (await readActiveWorkspaceContext(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE,
    env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, { refresh: false })).workspaceId;
  const digests = [];
  for (const target of ['local--payments', 'local--identity']) {
    const next = (await host.kernel.resolve({ utterance: 'switch workspace', arguments: { workspaceId: target } })).data.plan;
    digests.push(next.review.digest);
    const confirmed = host.kernel.confirmPlan({ planId: next.handle, planHash: host.kernel.planReview(next.handle).planHash });
    const ran = await host.kernel.run({ planId: next.handle }, { confirmationReceiptId: confirmed.receiptId, confirmationValue: confirmed.value });
    assert.equal(ran.warnings.some((warning) => warning.code === 'gateway.result-replayed'), false, target);
    assert.equal(await activeNow(), target);
  }
  assert.equal(digests[1], plan.review.digest);
});
