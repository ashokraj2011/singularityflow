/**
 * The guide never becomes authority. `[INT:AC-002]` `[INT:CON-024]` `[INT:CON-113]`
 *
 * Every way a conversation could approach a verdict — a goal hint, ordinary words, the exact
 * phrase, a forged handle, a policy layer — ends at a ceremony destination or a refusal, and the
 * governed record is byte-for-byte unchanged afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createActionExecutor } from '../src/gateway/executor.mjs';
import { createHandleAuthority } from '../src/gateway/handles.mjs';
import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { DEFAULT_GATEWAY_POLICY, operationPermission, resolveGatewayPolicy } from '../src/gateway/policy.mjs';
import { noEffects } from '../src/gateway/result.mjs';

const ACTOR = { login: 'dev-1', email: 'dev-1@example.com', name: 'Dev One' };
const OTHER = { login: 'dev-2', email: 'dev-2@example.com', name: 'Dev Two' };
const binding = {
  workspaceId: 'payments', repository: 'checkout-service', branch: 'main', subjectKind: null, subjectId: null,
  sourceCommit: null, worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null,
  policyHash: 'sha256:policy', registryHash: 'sha256:registry', actorId: ACTOR.email, hostSessionId: 'sess-authority'
};

async function awaitingApproval(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'singularity', 'work-items', 'WRK-2', 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    workItem: { id: 'WRK-2', title: 'Idempotent checkout', workType: 'feature', branch: 'WRK-2' },
    phaseOrder: ['design'], currentPhase: 'design',
    phases: { design: { status: 'awaiting_approval', generation: 1,
      approvalPolicy: { authorities: ['developers'], minimum: 1, allowSelfApproval: false } } },
    history: [{ event: 'phase_submitted', phase: 'design', actor: OTHER, at: '2026-10-20T10:00:00.000Z' }],
    resolution: { approvalAuthorities: { developers: { label: 'Developers', allowAnyGitIdentity: false, githubTeams: [],
      members: [{ name: ACTOR.name, email: ACTOR.email, githubLogin: ACTOR.login }] } } }
  }));
  return { root, file };
}

test('guide-never-becomes-authority', async (t) => {
  const { root, file } = await awaitingApproval(t);
  const before = await readFile(file, 'utf8');
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners(), root, plannerContext: { actor: ACTOR } });
  const host = { kernel, binding: () => binding };
  const executor = createActionExecutor({ gateway: host });

  // A model's goal hint alone narrows to the approval and still cannot choose it.
  const hinted = await kernel.resolve({ utterance: 'ship it', goalHint: 'review.open', arguments: { workId: 'WRK-2' } });
  assert.ok(['candidates', 'ceremony', 'clarification'].includes(hinted.kind));
  assert.ok(hinted.next.every((action) => action.executable === false));
  assert.equal(hinted.data?.plan, undefined);

  // Ordinary words that name the verdict reach a read of the work, never the approval.
  const spoken = await kernel.resolve({ utterance: 'approve WRK-2', arguments: { workId: 'WRK-2' } });
  assert.notEqual(spoken.operation.id, 'review.open');
  assert.ok(spoken.next.every((action) => action.interaction !== 'ceremony' || action.executable === false));

  // The exact phrase reaches the ceremony destination: a place to decide, with the terminal route.
  const destination = await kernel.resolve({ utterance: 'take me to the approval', arguments: { workId: 'WRK-2' } });
  assert.equal(destination.kind, 'ceremony');
  assert.deepEqual(destination.next.map((action) => [action.executable, action.confirmation]), [[false, 'ceremony']]);
  assert.equal(destination.next[0].fallback.command, 'sflow approve design --work-id WRK-2 --fetch');

  // A host that dispatches the ceremony action is handed the destination, not an execution.
  assert.equal((await executor.execute(destination.next[0])).outcome, 'ceremony');
  // Its handle is not a handle the kernel issued, so it can neither be read nor run.
  assert.equal((await kernel.read({ resolutionId: destination.next[0].handle })).kind, 'refusal');
  assert.equal((await kernel.run({ planId: destination.next[0].handle })).kind, 'refusal');
  // No authority signs an authorization as a plan.
  assert.throws(() => createHandleAuthority().issuePlan({
    operationId: 'review.open', classification: 'authorization', confirmation: 'ceremony',
    effects: noEffects(), idempotencyKey: 'x', binding
  }), { code: 'PLAN_FORBIDDEN' });
  // And no policy layer can lower the ceremony: the weaker rule is dropped and reported.
  const lowered = resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY, { layer: 'repository', confirmation: { 'review.open': 'none' } }]);
  assert.equal(operationPermission(lowered, 'review.open').confirmation, 'ceremony');
  assert.equal(operationPermission(lowered, 'review.open').executable, false);
  assert.ok(lowered.problems.some((problem) => problem.code === 'POLICY_WEAKENING_IGNORED'));

  // Nothing above recorded a verdict.
  assert.equal(await readFile(file, 'utf8'), before);
});
