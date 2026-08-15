import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDLE_KINDS, HANDLE_TTL_MS, RECEIPT_TTL_MS,
  createHandleAuthority, issueConfirmationReceipt, redeemConfirmationReceipt
} from '../src/gateway/handles.mjs';
import { noEffects } from '../src/gateway/result.mjs';

const binding = (over = {}) => ({
  workspaceId: 'payments',
  subjectKind: 'story',
  subjectId: 'WRK-123',
  sourceCommit: 'a'.repeat(40),
  worktreeHash: null,
  lifecycleRevision: 'lc-7',
  policyHash: 'sha256:policy',
  registryHash: 'sha256:registry',
  actorId: 'dev-1',
  hostSessionId: 'sess-1',
  ...over
});

const clock = (start = 1_000) => {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
};

const plan = (over = {}) => ({
  operationId: 'work.start',
  classification: 'mutation',
  arguments: { intakeId: 'intake-1' },
  binding: binding(),
  effects: { ...noEffects(), stateChanged: true, gitRefsChanged: true },
  confirmation: 'exact-confirm',
  idempotencyKey: 'idem-1',
  externalTargets: [],
  ...over
});

test('the model is handed an ID and an expiry, and nothing it could substitute', () => {
  const authority = createHandleAuthority();
  const { reference, record } = authority.issueRead({
    operationId: 'work.list', classification: 'read', binding: binding()
  });
  assert.deepEqual(Object.keys(reference).sort(), ['expiresAt', 'id', 'kind']);
  assert.equal(reference.kind, 'read');
  assert.match(reference.id, /^rea_[0-9a-f]{32}$/);
  // The operation name stays kernel-side.
  assert.ok(!JSON.stringify(reference).includes('work.list'));
  assert.equal(record.operationId, 'work.list');
  assert.deepEqual([...HANDLE_KINDS], ['selection', 'read', 'plan']);
});

test('a handle binds the whole world, and every field must be declared', () => {
  const authority = createHandleAuthority();
  const incomplete = binding();
  delete incomplete.worktreeHash;
  assert.throws(
    () => authority.issueRead({ operationId: 'work.list', classification: 'read', binding: incomplete }),
    (error) => error.code === 'HANDLE_BINDING_INVALID' && error.message.includes('worktreeHash')
  );
  for (const field of ['policyHash', 'registryHash', 'actorId', 'hostSessionId']) {
    assert.throws(
      () => authority.issueRead({ operationId: 'work.list', classification: 'read', binding: binding({ [field]: null }) }),
      (error) => error.code === 'HANDLE_BINDING_INVALID',
      `${field} should be required`
    );
  }
});

test('a caller cannot smuggle in its own expiry', () => {
  const time = clock();
  const authority = createHandleAuthority({ now: time.now });
  const { record } = authority.issueRead({
    operationId: 'work.list', classification: 'read', binding: binding(), expiresAt: Number.MAX_SAFE_INTEGER
  });
  assert.equal(record.expiresAt, time.now() + HANDLE_TTL_MS.read);
});

test('verification fails when the world moved under the handle', () => {
  const authority = createHandleAuthority();
  const { reference } = authority.issueRead({ operationId: 'work.list', classification: 'read', binding: binding() });

  assert.ok(authority.verify(reference, { kind: 'read', binding: binding() }));
  assert.throws(
    () => authority.verify(reference, { kind: 'read', binding: binding({ sourceCommit: 'b'.repeat(40) }) }),
    (error) => error.code === 'HANDLE_DRIFTED' && error.details.drifted.includes('sourceCommit')
  );
  assert.throws(
    () => authority.verify(reference, { kind: 'read', binding: binding({ actorId: 'someone-else' }) }),
    (error) => error.code === 'HANDLE_DRIFTED'
  );
  assert.throws(() => authority.verify(reference, { kind: 'plan' }), (error) => error.code === 'HANDLE_KIND_MISMATCH');
  assert.throws(() => authority.verify({ id: 'rea_nope' }), (error) => error.code === 'HANDLE_UNKNOWN');
});

test('a handle from another session is not a handle', () => {
  const mine = createHandleAuthority();
  const theirs = createHandleAuthority();
  const { reference } = theirs.issueRead({ operationId: 'work.list', classification: 'read', binding: binding() });
  assert.throws(() => mine.verify(reference), (error) => error.code === 'HANDLE_UNKNOWN');
});

test('handles expire, and a plan is used once', () => {
  const time = clock();
  const authority = createHandleAuthority({ now: time.now });
  const { reference } = authority.issueRead({ operationId: 'work.list', classification: 'read', binding: binding() });
  assert.equal(authority.status(reference), 'live');
  time.advance(HANDLE_TTL_MS.read);
  assert.equal(authority.status(reference), 'expired');
  assert.throws(() => authority.verify(reference), (error) => error.code === 'HANDLE_EXPIRED');

  const { reference: planRef } = authority.issuePlan(plan());
  authority.verify(planRef, { kind: 'plan', consume: true });
  assert.equal(authority.status(planRef), 'consumed');
  assert.throws(() => authority.verify(planRef, { kind: 'plan' }), (error) => error.code === 'HANDLE_CONSUMED');
});

test('a plan previews every effect and carries what execution needs to revalidate', () => {
  const authority = createHandleAuthority();
  const { plan: record, planHash } = authority.issuePlan(plan());
  assert.equal(record.effects.stateChanged, true);
  assert.equal(record.effects.externalSystemsChanged, false);
  assert.equal(record.idempotencyKey, 'idem-1');
  assert.equal(record.confirmation, 'exact-confirm');
  assert.equal(planHash, record.signature);
  assert.match(planHash, /^[0-9a-f]{64}$/);

  assert.throws(
    () => authority.issuePlan(plan({ effects: { stateChanged: true } })),
    (error) => error.code === 'PLAN_EFFECTS_INVALID'
  );
  assert.throws(() => authority.issuePlan(plan({ confirmation: 'none' })), (error) => error.code === 'PLAN_INVALID');
  assert.throws(() => authority.issuePlan(plan({ idempotencyKey: null })), (error) => error.code === 'PLAN_INVALID');
});

test('an authorization has no executable plan at all', () => {
  // `[INT:CON-113]`. Not "a plan a host should decline to run" — no plan.
  const authority = createHandleAuthority();
  assert.throws(
    () => authority.issuePlan(plan({ operationId: 'review.open', classification: 'authorization', confirmation: 'ceremony' })),
    (error) => error.code === 'PLAN_FORBIDDEN'
  );
});

test('the plan hash moves when anything the user was shown moves', () => {
  const authority = createHandleAuthority({ secret: Buffer.alloc(32, 7), now: () => 1_000 });
  const other = createHandleAuthority({ secret: Buffer.alloc(32, 7), now: () => 1_000 });
  // Same secret, same clock: only the random plan ID differs, so hashes must differ per issuance.
  assert.notEqual(authority.issuePlan(plan()).planHash, other.issuePlan(plan()).planHash);
});

test('a receipt is stored as a hash, so the record cannot replay it', () => {
  const { value, record } = issueConfirmationReceipt({
    planHash: 'sha256:plan', actorId: 'dev-1', hostSessionId: 'sess-1', audience: 'vscode'
  });
  assert.ok(value.length >= 32);
  assert.ok(!JSON.stringify(record).includes(value), 'the receipt value must not survive in the stored record');
  assert.equal(record.redeemedAt, null);

  for (const missing of ['planHash', 'actorId', 'hostSessionId', 'audience']) {
    const input = { planHash: 'p', actorId: 'a', hostSessionId: 's', audience: 'v', [missing]: undefined };
    assert.throws(() => issueConfirmationReceipt(input), (error) => error.code === 'RECEIPT_INVALID');
  }
});

test('a receipt is single-use and bound to exactly one plan, actor, session and audience', () => {
  const bindings = { planHash: 'sha256:plan', actorId: 'dev-1', hostSessionId: 'sess-1', audience: 'vscode' };
  const { value, record } = issueConfirmationReceipt(bindings);

  const redeemed = redeemConfirmationReceipt(record, value, bindings);
  assert.ok(redeemed.redeemedAt);
  assert.throws(() => redeemConfirmationReceipt(redeemed, value, bindings), (error) => error.code === 'RECEIPT_SPENT');

  for (const field of ['planHash', 'actorId', 'hostSessionId', 'audience']) {
    assert.throws(
      () => redeemConfirmationReceipt(record, value, { ...bindings, [field]: 'elsewhere' }),
      (error) => error.code === 'RECEIPT_MISBOUND' && error.details.field === field
    );
  }
  assert.throws(() => redeemConfirmationReceipt(record, 'guessed', bindings), (error) => error.code === 'RECEIPT_INVALID');
});

test('a receipt expires unused', () => {
  const time = clock();
  const bindings = { planHash: 'sha256:plan', actorId: 'dev-1', hostSessionId: 'sess-1', audience: 'vscode' };
  const { value, record } = issueConfirmationReceipt({ ...bindings, now: time.now });
  time.advance(RECEIPT_TTL_MS);
  assert.throws(
    () => redeemConfirmationReceipt(record, value, { ...bindings, now: time.now }),
    (error) => error.code === 'RECEIPT_EXPIRED'
  );
});
