import assert from 'node:assert/strict';
import test from 'node:test';
import { attestStoryTestCommand } from '../src/commands/story-test-attestation.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

const digest = `sha256:${'b'.repeat(64)}`;
function fixture() {
  const calls = [];
  const row = { path: 'immutable-review.json', sha256: digest, originPresent: false,
    review: { id: 'TCA-001', actor: { name: 'Reviewer', email: 'reviewer@example.test' } } };
  let sourceHead = 'a'.repeat(40);
  const dependencies = {
    async loadDefinition(_root, options) { assert.equal(options.storyBootstrap, true); calls.push('bootstrap'); return {}; },
    async resolveWorkItem() { calls.push('locate'); return { workId: 'repair' }; },
    async inspectWorkflowTestCommandReviews() { calls.push('inspect'); return { workId: 'repair', reviews: [row] }; },
    async withSubjectLock(_root, subject, action) { assert.deepEqual(subject, { kind: 'story', id: 'repair' }); calls.push('lock'); return action(); },
    head: () => sourceHead,
    workDir: () => '/repository/singularity/work-items/repair',
    testCommandReviewReattestationAuthorization(review) { assert.equal(review, row.review); return { plan: {}, action: {} }; },
    async captureTerminalActionAuthorization() { calls.push('terminal'); return { token: 'live-witness' }; },
    async reattestTestCommandReviewOrigin(_root, _workRoot, args) {
      assert.deepEqual(args, { review: row.review, token: 'live-witness' }); calls.push('reattest');
    }
  };
  const run = (options = {}, overrides = {}) => attestStoryTestCommand({ root: '/repository', options }, { ...dependencies, ...overrides });
  return { row, calls, run, move: () => { sourceHead = 'c'.repeat(40); } };
}

test('local origin recovery preview is read-only and supplies exact review action', async () => {
  const f = fixture();
  const data = await f.run();
  assert.equal(data.status, 'review-required');
  assert.equal(data.filesChanged, false);
  assert.equal(data.stateChanged, false);
  assert.ok(data.legalActions[0].args.includes(digest));
  assert.deepEqual(f.calls, ['bootstrap', 'locate', 'inspect']);
});

test('origin recovery rechecks immutable chain after terminal review and changes only local proof', async () => {
  const f = fixture();
  const data = await f.run({ apply: true, confirm: digest });
  assert.equal(data.status, 'attested');
  assert.equal(data.stateChanged, false);
  assert.equal(data.filesChanged, true);
  assert.deepEqual(f.calls, ['bootstrap', 'locate', 'lock', 'inspect', 'terminal', 'inspect', 'reattest']);
});

test('origin recovery refuses stale selection, changed HEAD, caller authority, and digest without apply', async () => {
  for (const options of [{ actor: 'Reviewer' }, { confirm: digest }, { apply: true }]) {
    const f = fixture();
    await assert.rejects(f.run(options));
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await assert.rejects(f.run({ apply: true, confirm: `sha256:${'c'.repeat(64)}` }), { code: 'TCA_ATTEST_REVIEW_STALE' });
  assert.equal(f.calls.includes('terminal'), false);
  await assert.rejects(f.run({ apply: true, confirm: digest }, {
    async captureTerminalActionAuthorization() { f.move(); return { token: 'live-witness' }; }
  }), { code: 'TCA_ATTEST_REVIEW_STALE' });
  assert.equal(f.calls.includes('reattest'), false);
});

test('already restored and cancelled origins do not report Story or local changes', async () => {
  const f = fixture();
  f.row.originPresent = true;
  const restored = await f.run({ apply: true, confirm: digest });
  assert.equal(restored.status, 'already-attested');
  assert.equal(restored.filesChanged, false);
  assert.equal(f.calls.includes('terminal'), false);
  f.row.originPresent = false;
  const cancelled = await f.run({ apply: true, confirm: digest }, { async captureTerminalActionAuthorization() { return null; } });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.filesChanged, false);
  assert.equal(f.calls.includes('reattest'), false);
});

test('origin operation is model-free and missing origin reports a concrete safe recovery', () => {
  for (const apply of [false, true]) {
    const operation = resolveOperation({ requestedCommand: 'story', positionals: ['story', 'test-policy', 'attest'], options: { apply } });
    assert.equal(operation.id, `story.test-policy.attest${apply ? '' : '.preview'}`);
    assert.equal(operation.classification, apply ? 'mutation' : 'read');
    assert.equal(operation.modelPolicy, 'never');
  }
  const plan = refusalRemediationPlan(Object.assign(new Error('No retained local review origin'),
    { code: 'TCA_AUTHORITY_ORIGIN_UNAVAILABLE' }), ['phase', 'publish', 'implementation']);
  assert.equal(plan.steps[0].command, 'singularity-flow story test-policy attest --json');
  assert.match(plan.steps[0].label, /original reviewer/);
});
