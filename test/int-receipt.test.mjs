/**
 * Receipt-bound execution. `[INT:AC-006]` `[INT:AC-007]` `[INT:CON-039]` `[INT:REQ-111]` `[INT:CON-114]`
 *
 * One mutation, planned by its real planner from real records, carried out by a counting executor
 * so "never twice" is a number rather than an impression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHandleAuthority, RECEIPT_TTL_MS } from '../src/gateway/handles.mjs';
import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { effects, sflowResult } from '../src/gateway/result.mjs';
import { SFLOW_TOOLS } from '../src/gateway/tools.mjs';

const ACTOR = { login: 'dev-1', email: 'dev-1@example.com', name: 'Dev One' };

async function records(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity', 'work-items', 'WRK-1');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({
    workItem: { id: 'WRK-1', title: 'Work', workType: 'feature', branch: 'WRK-1' }, phaseOrder: ['design'], currentPhase: 'design',
    phases: { design: { status: 'in_progress', generation: 1 } },
    history: [{ event: 'work_started', phase: 'design', actor: ACTOR, at: '2026-10-20T10:00:00.000Z' }]
  }));
  return root;
}

function session(root, { hostSessionId = 'sess-receipt', delayMs = 0 } = {}) {
  const world = {
    workspaceId: 'payments', repository: 'checkout-service', branch: 'main', subjectKind: null, subjectId: null,
    sourceCommit: 'a'.repeat(40), worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null,
    policyHash: 'sha256:policy', registryHash: 'sha256:registry', actorId: ACTOR.email, hostSessionId
  };
  const clock = { at: Date.now() };
  const now = () => clock.at;
  const ran = [];
  const executor = async ({ operation, plan }) => {
    ran.push(plan.id);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return sflowResult({
      kind: 'read', operation: { id: operation.id, classification: operation.classification },
      outcome: { status: 'succeeded', messageId: 'gateway.completed', slots: {} },
      effects: effects({ contextChanged: true }), restState: 'complete'
    });
  };
  const kernel = createGatewayKernel({
    binding: () => ({ ...world }), planners: gatewayPlanners(), root, plannerContext: { actor: ACTOR },
    readOnly: false, mutationExecutors: new Map([['watch-create', executor]]),
    handles: createHandleAuthority({ now }), now
  });
  return { kernel, world, clock, ran };
}

async function planned(kernel, predicate = 'phase-changed') {
  const result = await kernel.resolve({ utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate } });
  assert.equal(result.kind, 'plan');
  return result.data.plan.handle;
}

function confirm(kernel, planId) {
  const review = kernel.planReview(planId);
  return kernel.confirmPlan({ planId, planHash: review.planHash, reviewDigest: review.review.digest });
}

const out = (receipt) => ({ confirmationReceiptId: receipt.receiptId, confirmationValue: receipt.value });

test('confirmation-is-out-of-band', async (t) => {
  const root = await records(t);
  const { kernel, ran } = session(root);
  const transcript = [];
  const tool = (name, input, output) => transcript.push(JSON.stringify({ name, input, output }));

  const resolveInput = { utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'phase-changed' } };
  const resolved = await kernel.resolve(resolveInput);
  tool('sflow_resolve', resolveInput, resolved);
  const planId = resolved.data.plan.handle;

  // The host's side channel: review, confirm, exchange. None of it is a tool call.
  const receipt = confirm(kernel, planId);
  const runInput = { planId };
  const result = await kernel.run(runInput, out(receipt));
  tool('sflow_run', runInput, result);
  assert.equal(result.outcome.status, 'succeeded');
  assert.equal(ran.length, 1);

  const seen = transcript.join('\n');
  assert.equal(seen.includes(receipt.value), false, 'the confirmation value reached a model-visible record');
  assert.equal(seen.includes(receipt.receiptId), false, 'the receipt id reached a model-visible record');

  // The tool surface has nowhere to put one, and a model that smuggles one in gains nothing.
  const run = SFLOW_TOOLS.find((entry) => entry.name === 'sflow_run');
  assert.deepEqual(Object.keys(run.inputSchema.properties), ['planId']);
  assert.equal(run.inputSchema.additionalProperties, false);
  const another = await planned(kernel, 'material-event');
  const second = confirm(kernel, another);
  const smuggled = await kernel.run({ planId: another, confirmationReceiptId: second.receiptId, confirmationValue: second.value });
  assert.deepEqual([smuggled.kind, smuggled.why[0].code], ['refusal', 'gateway.confirmation-required']);
  assert.equal(ran.length, 1);
  // A host that cannot collect a confirmation out of band gets plans to read and no receipt.
  const blind = createGatewayKernel({
    binding: () => ({ ...session(root).world }), planners: gatewayPlanners(), root, plannerContext: { actor: ACTOR },
    readOnly: false, hostCapabilities: { confirmationChannel: 'none' }
  });
  const blindPlan = await planned(blind);
  assert.throws(() => confirm(blind, blindPlan), { code: 'CONFIRMATION_CHANNEL_UNAVAILABLE' });
});

test('receipt-is-bound-and-single-use', async (t) => {
  const root = await records(t);

  // Expired: a confirmation is for now, not for a while.
  {
    const { kernel, clock, ran } = session(root);
    const planId = await planned(kernel);
    const receipt = confirm(kernel, planId);
    clock.at += RECEIPT_TTL_MS + 1;
    assert.equal((await kernel.run({ planId }, out(receipt))).why[0].code, 'gateway.confirmation-invalid');
    assert.equal(ran.length, 0);
  }
  // Reused: the second redemption is the recorded result, and nothing runs twice.
  {
    const { kernel, ran } = session(root);
    const planId = await planned(kernel);
    const receipt = confirm(kernel, planId);
    assert.equal((await kernel.run({ planId }, out(receipt))).outcome.status, 'succeeded');
    const again = await kernel.run({ planId }, out(receipt));
    assert.ok(again.warnings.some((warning) => warning.code === 'gateway.result-replayed'));
    assert.equal(ran.length, 1);
    // A fresh plan for the same act is the same act: recorded, not repeated.
    const twin = await planned(kernel);
    const replay = await kernel.run({ planId: twin }, out(confirm(kernel, twin)));
    assert.ok(replay.warnings.some((warning) => warning.code === 'gateway.result-replayed'));
    assert.equal(ran.length, 1);
  }
  // Wrong actor, wrong workspace, drifted source: the plan no longer describes this world.
  for (const [field, value] of [['actorId', 'someone-else@example.com'], ['workspaceId', 'identity'], ['sourceCommit', 'b'.repeat(40)]]) {
    const { kernel, world, ran } = session(root);
    const planId = await planned(kernel);
    const receipt = confirm(kernel, planId);
    world[field] = value;
    const refused = await kernel.run({ planId }, out(receipt));
    assert.deepEqual([refused.kind, refused.why[0].code], ['refusal', 'gateway.handle-drifted'], field);
    assert.ok(Object.values(refused.effects).every((effect) => effect === false));
    assert.equal(ran.length, 0, field);
  }
  // Wrong session: another session never issued that plan or that receipt.
  {
    const first = session(root, { hostSessionId: 'sess-a' });
    const planId = await planned(first.kernel);
    const receipt = confirm(first.kernel, planId);
    const other = session(root, { hostSessionId: 'sess-b' });
    assert.equal((await other.kernel.run({ planId }, out(receipt))).why[0].code, 'gateway.handle-unknown');
    assert.equal(other.ran.length + first.ran.length, 0);
  }
  // Simultaneous: two submissions of one receipt, one execution.
  {
    const { kernel, ran } = session(root, { delayMs: 25 });
    const planId = await planned(kernel);
    const receipt = confirm(kernel, planId);
    const [left, right] = await Promise.all([kernel.run({ planId }, out(receipt)), kernel.run({ planId }, out(receipt))]);
    assert.equal(ran.length, 1);
    const outcomes = [left, right].map((result) => result.outcome.status).sort();
    assert.deepEqual(outcomes, ['refused', 'succeeded']);
    assert.equal([left, right].find((result) => result.kind === 'refusal').why[0].code, 'gateway.run-in-progress');
  }
  // A confirmation of a different preview does not redeem this one.
  {
    const { kernel } = session(root);
    const planId = await planned(kernel);
    const review = kernel.planReview(planId);
    assert.throws(() => kernel.confirmPlan({ planId, planHash: 'f'.repeat(64), reviewDigest: review.review.digest }), { code: 'PLAN_CONFIRMATION_MISMATCH' });
  }
});
