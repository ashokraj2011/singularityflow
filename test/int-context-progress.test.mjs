import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_MODES, OMISSION_CATEGORIES,
  bannerBlockers, contextBanner, contextReceipt, contextUsageRecord, narrowContextReceipt
} from '../src/gateway/context.mjs';
import {
  CANCELLATION_SAFETY, MAX_DIAGNOSTIC_LENGTH, RESUMABILITY, STEP_STATES,
  progressUpdate, resumeBlockers, stopJob
} from '../src/gateway/progress.mjs';

const evidence = [
  { handle: 'ev:clause-1', category: 'clause', required: true },
  { handle: 'ev:clause-2', category: 'clause', required: false },
  { handle: 'ev:slice-1', category: 'sourceSlice', required: false },
  { handle: 'ev:test-1', category: 'testResult', required: false }
];

const receipt = (over = {}) => contextReceipt({
  subject: { kind: 'story', id: 'WRK-123', revision: { sourceCommit: 'a'.repeat(40) } },
  mode: 'assisted',
  route: { provider: 'host', model: 'host-default' },
  evidence,
  omitted: ['secrets', 'generated-files'],
  redactions: [{ rule: 'model-provider-key', occurrences: 2 }],
  tokens: { estimatedInput: 11_800, cacheReusable: 7_200, newlyTransmitted: 4_600, maximumOutput: 1_800 },
  tokenizer: 'cl100k-approx',
  estimationMethod: 'bytes-per-token-4.0',
  registryHash: 'sha256:registry',
  policyHash: 'sha256:policy',
  ...over
});

test('a receipt says exactly what will be shown, and derives its own counts', () => {
  const built = receipt();
  assert.equal(built.kind, 'context-receipt');
  assert.equal(built.mode, 'assisted');
  assert.deepEqual(built.selected, { clause: 2, sourceSlice: 1, testResult: 1 });
  assert.deepEqual([...built.omitted], ['generated-files', 'secrets']);
  assert.match(built.receiptHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([...CONTEXT_MODES], ['deterministic', 'assisted']);
});

test('a token estimate names its tokenizer and never claims to be a bill', () => {
  const built = receipt();
  assert.equal(built.tokens.tokenizer, 'cl100k-approx');
  assert.equal(built.tokens.estimationMethod, 'bytes-per-token-4.0');
  assert.equal(built.tokens.exact, false);

  assert.throws(() => receipt({ tokenizer: undefined }), (error) => error.code === 'CONTEXT_RECEIPT_INVALID');
  assert.throws(() => receipt({ estimationMethod: undefined }), (error) => error.code === 'CONTEXT_RECEIPT_INVALID');
  // Cached plus new must be the whole input, or the split is decoration.
  assert.throws(
    () => receipt({ tokens: { estimatedInput: 100, cacheReusable: 10, newlyTransmitted: 10, maximumOutput: 5 } }),
    (error) => error.code === 'CONTEXT_RECEIPT_INVALID' && error.message.includes('account for the whole')
  );
});

test('evidence must say whether it can be dropped, and omissions must be named categories', () => {
  assert.throws(
    () => receipt({ evidence: [{ handle: 'ev:x', category: 'clause' }] }),
    (error) => error.code === 'CONTEXT_RECEIPT_INVALID' && error.message.includes('whether it is required')
  );
  assert.throws(() => receipt({ omitted: ['whatever'] }), (error) => error.code === 'CONTEXT_RECEIPT_INVALID');
  assert.ok(OMISSION_CATEGORIES.includes('secrets'));
});

test('narrowing removes optional evidence and refuses to remove required evidence', () => {
  const narrowed = narrowContextReceipt(receipt(), {
    remove: ['ev:clause-2', 'ev:test-1'],
    tokens: { estimatedInput: 6_000, cacheReusable: 4_000, newlyTransmitted: 2_000, maximumOutput: 1_800 }
  });
  assert.deepEqual(narrowed.selected, { clause: 1, sourceSlice: 1 });
  assert.notEqual(narrowed.receiptHash, receipt().receiptHash);

  assert.throws(
    () => narrowContextReceipt(receipt(), { remove: ['ev:clause-1'] }),
    (error) => error.code === 'CONTEXT_NARROWING_REFUSED' && error.details.handles.includes('ev:clause-1')
  );
  // Removing something that is not there is a mistake worth reporting, not a no-op.
  assert.throws(
    () => narrowContextReceipt(receipt(), { remove: ['ev:absent'] }),
    (error) => error.code === 'CONTEXT_NARROWING_REFUSED'
  );
});

test('the usage record carries the receipt hash and reports absent actuals as absent', () => {
  const built = receipt();
  const usage = contextUsageRecord(built, { actual: { estimatedInput: 12_010 }, reportedByHost: true, truncated: true });
  assert.equal(usage.receiptHash, built.receiptHash);
  assert.deepEqual(usage.actual, { estimatedInput: 12_010 });
  assert.equal(usage.truncated, true);

  const silent = contextUsageRecord(built, {});
  assert.deepEqual(silent.actual, {}, 'a host that reports nothing has not reported zero');
  assert.equal(silent.reportedByHost, false);
  assert.throws(() => contextUsageRecord({ kind: 'something-else' }, {}), (error) => error.code === 'CONTEXT_USAGE_INVALID');
});

const banner = (over = {}) => contextBanner({
  actor: 'dev-1',
  authority: 'contributor',
  workspaceId: 'payments',
  subjectKind: 'story',
  subjectId: 'WRK-123',
  repositories: ['checkout-service'],
  sourceRevision: 'a'.repeat(40),
  lifecycleRevision: 'lc-7',
  ...over
});

test('an unresolved banner field blocks confirmation rather than rendering blank', () => {
  assert.deepEqual([...banner().unresolved], []);
  assert.deepEqual([...bannerBlockers(banner())], []);

  const missing = banner({ actor: undefined });
  assert.deepEqual([...missing.unresolved], ['actor']);
  assert.deepEqual([...bannerBlockers(missing)], [{ field: 'actor', reason: 'unresolved' }]);
});

test('a banner that no longer matches the world blocks, and says what moved', () => {
  const shown = banner();
  const blockers = bannerBlockers(shown, { ...shown, sourceRevision: 'b'.repeat(40) });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].field, 'sourceRevision');
  assert.equal(blockers[0].reason, 'changed');

  const providerMoved = bannerBlockers(banner({ provider: { id: 'jira', account: 'a' } }), banner({ provider: { id: 'jira', account: 'b' } }));
  assert.ok(providerMoved.some((entry) => entry.field === 'provider'));
});

const step = (over = {}) => progressUpdate({
  jobId: 'job-1',
  subject: { kind: 'workspace', id: 'payments' },
  stepId: 'clone-checkout',
  state: 'active',
  currentActivity: 'Cloning checkout-service',
  cancellationSafety: 'safe',
  resumability: 'resumable',
  ...over
});

test('a progress update comes from one step in one closed state', () => {
  const update = step();
  assert.equal(update.kind, 'job-progress');
  assert.equal(update.terminal, false);
  assert.equal(step({ state: 'completed' }).terminal, true);
  assert.deepEqual([...STEP_STATES], ['queued', 'active', 'blocked', 'completed', 'skipped', 'stopped', 'failed']);

  assert.throws(() => step({ state: 'nearly-done' }), (error) => error.code === 'JOB_PROGRESS_INVALID');
  assert.throws(() => step({ currentActivity: undefined }), (error) => error.code === 'JOB_PROGRESS_INVALID');
  assert.throws(() => step({ stepId: undefined }), (error) => error.code === 'JOB_PROGRESS_INVALID');
  assert.throws(() => step({ cancellationSafety: 'probably' }), (error) => error.code === 'JOB_PROGRESS_INVALID');
  assert.throws(() => step({ resumability: 'maybe' }), (error) => error.code === 'JOB_PROGRESS_INVALID');
  assert.deepEqual([...CANCELLATION_SAFETY], ['safe', 'retains-evidence', 'unsafe-mid-write']);
  assert.deepEqual([...RESUMABILITY], ['resumable', 'restart-required', 'not-resumable']);
});

test('a blocked step says what it is blocked on, and diagnostics are bounded', () => {
  assert.throws(() => step({ state: 'blocked' }), (error) => error.code === 'JOB_PROGRESS_INVALID' && error.message.includes('blocked on'));
  assert.ok(step({ state: 'blocked', diagnostic: 'waiting for the network' }));
  assert.throws(
    () => step({ diagnostic: 'x'.repeat(MAX_DIAGNOSTIC_LENGTH + 1) }),
    (error) => error.code === 'JOB_PROGRESS_INVALID'
  );
});

test('stopping preserves completed evidence and refuses mid-write', () => {
  const stopped = stopJob('job-1', [
    step({ stepId: 'clone-a', state: 'completed', completedEvidence: ['ev:clone-a'] }),
    step({ stepId: 'clone-b', state: 'active' }),
    step({ stepId: 'clone-c', state: 'queued' })
  ]);
  assert.deepEqual([...stopped.stoppedSteps], ['clone-b', 'clone-c']);
  assert.deepEqual([...stopped.retainedEvidence], ['ev:clone-a']);
  assert.equal(stopped.resumable, true);

  assert.throws(
    () => stopJob('job-1', [step({ stepId: 'write-index', state: 'active', cancellationSafety: 'unsafe-mid-write' })]),
    (error) => error.code === 'JOB_STOP_REFUSED' && error.details.steps.includes('write-index')
  );
  assert.equal(stopJob('job-1', [step({ state: 'queued', resumability: 'not-resumable' })]).resumable, false);
});

test('resuming revalidates the world and the steps already done', () => {
  const recorded = {
    actorId: 'dev-1', subjectId: 'payments', sourceCommit: 'a'.repeat(40), worktreeHash: null,
    policyHash: 'sha256:policy', registryHash: 'sha256:registry', providerObservation: null,
    completedSteps: [{ stepId: 'clone-a', hash: 'h1' }]
  };
  assert.equal(resumeBlockers(recorded, recorded).resumable, true);

  const moved = resumeBlockers(recorded, { ...recorded, policyHash: 'sha256:other' });
  assert.deepEqual([...moved.drifted], ['policyHash']);
  assert.equal(moved.resumable, false);

  const rewritten = resumeBlockers(recorded, { ...recorded, completedSteps: [{ stepId: 'clone-a', hash: 'h2' }] });
  assert.deepEqual([...rewritten.changedSteps], ['clone-a']);
  assert.equal(rewritten.resumable, false);
});
