import test from 'node:test';
import assert from 'node:assert/strict';

import { operationCatalog } from '../src/command-registry.mjs';
import { gatewayRegistry, isGatewayReachable } from '../src/gateway/operations.mjs';
import {
  DEFAULT_GATEWAY_POLICY, POLICY_LAYERS, operationPermission, resolveGatewayPolicy
} from '../src/gateway/policy.mjs';

const problem = (policy, code) => policy.problems.filter((entry) => entry.code === code);

test('the default policy resolves and covers every reachable operation', () => {
  const policy = resolveGatewayPolicy();
  assert.equal(policy.degraded, false);
  assert.equal(policy.modelRouting, 'enabled');
  assert.deepEqual(policy.problems.filter((entry) => entry.code === 'POLICY_UNKNOWN_OPERATION'), []);
  for (const operation of gatewayRegistry().operations) {
    assert.ok(policy.confirmation[operation.id], `${operation.id} has no resolved confirmation class`);
  }
});

test('a later layer may narrow and may not loosen', () => {
  // `[INT:CON-120]` `[INT:CON-121]`.
  const narrowed = resolveGatewayPolicy([
    DEFAULT_GATEWAY_POLICY,
    { layer: 'repository', confirmation: { 'work.list': 'host-confirm' } }
  ]);
  assert.equal(narrowed.confirmation['work.list'], 'host-confirm');

  const loosened = resolveGatewayPolicy([
    DEFAULT_GATEWAY_POLICY,
    { layer: 'repository', confirmation: { 'work.start': 'none' } }
  ]);
  assert.equal(loosened.confirmation['work.start'], 'exact-confirm');
  assert.equal(problem(loosened, 'POLICY_WEAKENING_IGNORED').length, 1);
  assert.equal(problem(loosened, 'POLICY_WEAKENING_IGNORED')[0].attempted, 'none');
});

test('layer order is authority order, not the order the files were read', () => {
  const shuffled = resolveGatewayPolicy([
    { layer: 'workspace', confirmation: { 'work.list': 'none' } },
    { layer: 'central', confirmation: { 'work.list': 'exact-confirm' } }
  ]);
  assert.equal(shuffled.confirmation['work.list'], 'exact-confirm');
  assert.deepEqual([...shuffled.layers], ['central', 'workspace']);
  assert.deepEqual([...POLICY_LAYERS].slice(0, 2), ['central', 'machine']);
});

test('the registry confirmation class is a floor a policy file cannot lower', () => {
  const policy = resolveGatewayPolicy([{ layer: 'central', confirmation: { 'review.open': 'host-confirm' } }]);
  assert.equal(policy.confirmation['review.open'], 'ceremony');
  assert.equal(problem(policy, 'POLICY_WEAKENING_IGNORED').length, 1);
});

test('a missing or unusable policy degrades to deterministic reads, and does not throw', () => {
  // `[INT:CON-122]`.
  for (const input of [[], null, [{ layer: 'nonsense' }], ['not an object']]) {
    const policy = resolveGatewayPolicy(input);
    assert.equal(policy.degraded, true);
    assert.equal(policy.modelRouting, 'disabled');
    assert.equal(policy.confirmation['work.list'], 'none');
    assert.equal(policy.confirmation['work.start'], 'explicit-only');
    assert.equal(policy.confirmation['impact.quick.assisted'], 'explicit-only');
    assert.ok(policy.problems.length);
  }
});

test('a rule for an operation that does not exist is reported, not silently kept', () => {
  const policy = resolveGatewayPolicy([
    DEFAULT_GATEWAY_POLICY,
    { layer: 'organization', confirmation: { 'documents.list': 'host-confirm' }, denied: ['build.read'] }
  ]);
  assert.equal(problem(policy, 'POLICY_UNKNOWN_OPERATION').length, 2);
  assert.deepEqual([...policy.denied], []);
});

test('an invalid confirmation class is dropped and reported', () => {
  const policy = resolveGatewayPolicy([
    DEFAULT_GATEWAY_POLICY,
    { layer: 'machine', confirmation: { 'work.list': 'ask-nicely' } }
  ]);
  assert.equal(problem(policy, 'POLICY_CONFIRMATION_INVALID').length, 1);
  assert.equal(policy.confirmation['work.list'], 'none');
});

test('permission answers reachable, executable and why not', () => {
  const policy = resolveGatewayPolicy();
  const read = operationPermission(policy, 'work.list');
  assert.deepEqual(read, { reachable: true, reason: null, confirmation: 'none', executable: true });

  const ceremony = operationPermission(policy, 'review.open');
  assert.equal(ceremony.confirmation, 'ceremony');
  assert.equal(ceremony.executable, false);

  assert.equal(operationPermission(policy, 'wm.build').reachable, false);
  assert.equal(operationPermission(policy, 'wm.build').reason, 'not-registered');

  const denied = resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY, { layer: 'workspace', denied: ['compare'] }]);
  assert.deepEqual(operationPermission(denied, 'compare'), {
    reachable: false, reason: 'denied-by-policy', executable: false, confirmation: null
  });
});

test('explicit-only is reachable to describe and never executable by an ambient tool', () => {
  const policy = resolveGatewayPolicy([
    DEFAULT_GATEWAY_POLICY,
    { layer: 'organization', confirmation: { 'workspace.materialize': 'explicit-only' } }
  ]);
  const permission = operationPermission(policy, 'workspace.materialize');
  assert.equal(permission.reachable, true);
  assert.equal(permission.executable, false);
});

test('the destructive operations are unreachable because they are not declared at all', () => {
  // `[INT:CON-123]`. The strongest form of "must remain unreachable" is "was never registered".
  for (const id of ['factory-reset', 'reset-all', 'local-reset', 'reinstall', 'cancel', 'secrets.protect']) {
    assert.ok(operationCatalog().some((entry) => entry.id === id), `${id} should exist in the kernel`);
    assert.equal(isGatewayReachable(id), false, `${id} is reachable from the gateway`);
  }
});
