import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine-sdk/index.mjs';
import { assertRejectionComment, rejectionTarget } from '../src/kernel/approval-policy.mjs';
import { SingularityFlowError } from '../src/foundation/failures.mjs';

function fixture(hook = () => {}) {
  const workflow = { workItem: { id: 'CUSTOM-1' }, currentPhase: 'security-review', phaseOrder: ['design','security-review','delivery'],
    phases: { design: { id: 'design', generation: 1 }, 'security-review': { id: 'security-review', generation: 3,
      approvalPolicy: { mode: 'human', rejectTo: ['design'], changeRequests: { commentRequired: true } } }, delivery: { id: 'delivery', generation: 0 } } };
  const facts = { workId: 'CUSTOM-1', phase: 'security-review', generation: 3, revision: 'opaque-revision', pushed: true,
    currentPhase: 'design', changeRequest: { id: 'CR-004', status: 'open', sourcePhase: 'security-review', sourceGeneration: 3,
      targetPhase: 'design', clauseIds: ['REQ-1'], members: ['design.md'], reason: 'Clarify the boundary.',
      actorId: 'reviewer', authorityGroup: 'security', reviewPacket: null }, repairBudget: { consumed: 1, maximum: 2 } };
  const calls = [], publication = { sha: 'opaque-revision', pushed: true };
  const rejection = Object.fromEntries(['load','prepare','commit','finish'].map(stage => [stage, async (...args) => {
    calls.push(stage); await hook(stage, args);
    return stage === 'load' ? { workflow, subject: { kind: 'story', id: 'CUSTOM-1' } }
      : stage === 'prepare' ? {} : stage === 'commit' ? publication : facts;
  }]));
  return { engine: createEngine({ ports: { rejection } }), workflow, facts, publication, calls };
}
const inputs = () => ({ workId: 'CUSTOM-1', phaseId: 'security-review', target: 'design', reason: '  Clarify the boundary. ', clauseIds: ['REQ-1','REQ-1'], members: ['design.md'] });

test('custom phases retain correction targets, comment requirements and earlier-owner return semantics', () => {
  const { workflow } = fixture(), phase = workflow.phases['security-review'];
  assert.deepEqual(rejectionTarget(workflow, phase, 'design'), { targetId: 'design', targetIndex: 0 });
  assert.deepEqual(rejectionTarget(workflow, phase), { targetId: 'security-review', targetIndex: 1 });
  assert.throws(() => rejectionTarget(workflow, phase, 'delivery'), /cannot be rejected/);
  assert.throws(() => rejectionTarget(workflow, phase, 'security-review', { id: 'UPI-1' }), { code: 'UPSTREAM_ISSUE_NOT_EARLIER' });
  assert.throws(() => assertRejectionComment(phase, ' ', null), /comment is required/);
  phase.approvalPolicy.changeRequests.commentRequired = false;
  assert.doesNotThrow(() => assertRejectionComment(phase, null, null));
  assert.throws(() => assertRejectionComment(phase, null, {}), /comment is required/);
});

test('rejection uses one registered stage sequence and binds a committed change request to its exact source and target', async () => {
  const f = fixture(), result = await f.engine.rejectPhase(inputs());
  assert.deepEqual(f.calls, ['load','prepare','commit','finish']);
  assert.equal(result.operation, 'phase.reject'); assert.equal(result.status, 'recorded');
  assert.equal(result.generation, 3); assert.equal(result.currentPhase, 'design');
  assert.deepEqual(result.changeRequest.clauseIds, ['REQ-1']); assert.equal(result.effects.committed, true);
  assert.deepEqual(result.repairBudget, { consumed: 1, maximum: 2 });
});

test('legacy numeric generation metadata projects without changing the retained workflow, and member keys stay bound', async () => {
  const f = fixture(); f.workflow.phases['security-review'].generation = '3';
  const result = await f.engine.rejectPhase({ ...inputs(), members: [' design.md ', 'design.md'] });
  assert.equal(result.generation, 3); assert.equal(result.changeRequest.sourceGeneration, 3);
  assert.equal(f.workflow.phases['security-review'].generation, '3', 'Read binding must not rewrite retained metadata.');
  assert.deepEqual(result.changeRequest.members, ['design.md']);
});

test('public rejection input cannot supply actor authority, callbacks, presence or native rework exceptions', async () => {
  const f = fixture();
  for (const extra of [{ actor: { login: 'admin' } }, { presence: {} }, { convergenceRework: {} }, { upstreamIssue: {} },
    { root: '/elsewhere' }, { testingRepairPlan: {} }, { repair: 'true' }, { clauseIds: 'REQ-1' }, { members: [1] }]) {
    await assert.rejects(f.engine.rejectPhase({ ...inputs(), ...extra }), { code: 'ENGINE_INPUT_INVALID' });
  }
  assert.deepEqual(f.calls, []);
});

test('cancellation stops before acceptance but never hides an acknowledged committed rejection', async () => {
  for (const cancelAt of ['before-start','load','prepare','commit']) {
    const controller = new AbortController(), f = fixture(stage => { if (stage === cancelAt) controller.abort(); });
    if (cancelAt === 'before-start') controller.abort();
    if (cancelAt === 'commit') assert.equal((await f.engine.rejectPhase(inputs(), { signal: controller.signal })).status, 'recorded');
    else {
      await assert.rejects(f.engine.rejectPhase(inputs(), { signal: controller.signal }), { code: 'ENGINE_OPERATION_CANCELLED' });
      assert.equal(f.calls.includes('commit'), false);
    }
  }
});

test('native refusals retain their exact error and uncertain publication metadata', async () => {
  const cause = Object.assign(new Error('actual transport timeout'), { code: 'ETIMEDOUT' });
  const error = new SingularityFlowError('Publication outcome unknown.', { code: 'TRANSPORT_INDETERMINATE', cause });
  error.publicationCommit = 'retained-commit'; error.details = { nextAction: 'original recovery' };
  const f = fixture(stage => { if (stage === 'commit') throw error; });
  await assert.rejects(f.engine.rejectPhase(inputs()), actual => actual === error && actual.cause === cause && actual.publicationCommit === 'retained-commit');
  assert.equal(f.calls.includes('finish'), false);
});

test('differently bound acknowledgements fail with the actual accepted publication still attached', async () => {
  for (const field of ['sourcePhase','sourceGeneration','targetPhase','clauseIds','members','reason']) {
    const f = fixture(); f.facts.changeRequest[field] = field === 'sourceGeneration' ? 2 : ['clauseIds','members'].includes(field) ? [] : 'another';
    await assert.rejects(f.engine.rejectPhase(inputs()), error => error.code === 'ENGINE_PORT_RESULT_INVALID' && error.enginePublication === f.publication);
  }
  const original = Object.freeze(new Error('immutable host failure')), f = fixture(stage => { if (stage === 'finish') throw original; });
  await assert.rejects(f.engine.rejectPhase(inputs()), error => error === original);
});
