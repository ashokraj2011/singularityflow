/**
 * The capability map: what the organisation builds, as a tree.
 *
 * A workspace says how code is stored; the map says what it is for, and those are different shapes.
 * The tests that matter are the ones about the distinction between the two kinds, because that
 * distinction is what makes the derived questions answerable at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityForRepository, deliveriesUnder, flattenCapabilities, validateCapabilityMap
} from '../src/capability-map.mjs';

const portfolio = {
  repositories: { api: {}, 'web-write': {}, 'web-read': {}, platform: {} }
};

const MAP = {
  version: 1,
  capabilities: [{
    id: 'commerce', name: 'Commerce', kind: 'business',
    children: [
      {
        id: 'payments', name: 'Payments', kind: 'business',
        children: [{ id: 'payments-api', name: 'Payment intents', kind: 'delivery', repository: 'api' }]
      },
      {
        id: 'storefront', name: 'Storefront', kind: 'business',
        children: [
          { id: 'storefront-write', name: 'Checkout', kind: 'delivery', repository: 'web-write' },
          { id: 'storefront-read', name: 'Confirmation', kind: 'delivery', repository: 'web-read' }
        ]
      }
    ]
  }]
};

test('the map nests to any depth, and every level keeps its own identity', () => {
  // A business describes itself as a hierarchy — Commerce contains Storefront contains a flow — and
  // flattening it to a list throws away the only structure a reader can navigate.
  const map = validateCapabilityMap(MAP, portfolio);
  const rows = flattenCapabilities(map);
  assert.deepEqual(rows.map((row) => [row.id, row.depth]), [
    ['commerce', 0],
    ['payments', 1],
    ['payments-api', 2],
    ['storefront', 1],
    ['storefront-write', 2],
    ['storefront-read', 2]
  ]);
  assert.deepEqual(rows.find((row) => row.id === 'storefront-read').ancestors, ['commerce', 'storefront']);
});

test('a business capability groups; a delivery capability ships', () => {
  // The distinction is load-bearing rather than decorative: it is what lets "what does this ship"
  // and "who owns this repository" both be answered from one file.
  assert.throws(
    () => validateCapabilityMap({
      version: 1,
      capabilities: [{ id: 'payments', kind: 'business', repository: 'api' }]
    }, portfolio),
    /groups other capabilities and cannot name a repository of its own/
  );

  assert.throws(
    () => validateCapabilityMap({
      version: 1,
      capabilities: [{
        id: 'payments-api', kind: 'delivery', repository: 'api',
        children: [{ id: 'nested', kind: 'delivery', repository: 'web-read' }]
      }]
    }, portfolio),
    /ships from a repository and cannot contain other capabilities/
  );

  assert.throws(
    () => validateCapabilityMap({ version: 1, capabilities: [{ id: 'orphan', kind: 'delivery' }] }, portfolio),
    /must name a repository/
  );
});

test('a delivery capability must name a repository the portfolio declares', () => {
  // It looks fine until something tries to clone it.
  assert.throws(
    () => validateCapabilityMap({
      version: 1,
      capabilities: [{ id: 'ghost', kind: 'delivery', repository: 'not-configured' }]
    }, portfolio),
    /which the portfolio does not declare/
  );
});

test('an identifier means one thing across the whole tree, not one thing per level', () => {
  // An identifier that means two things cannot be cited, and citing them is the point of having them.
  assert.throws(
    () => validateCapabilityMap({
      version: 1,
      capabilities: [
        { id: 'commerce', kind: 'business', children: [{ id: 'shared', kind: 'delivery', repository: 'api' }] },
        { id: 'platform', kind: 'business', children: [{ id: 'shared', kind: 'delivery', repository: 'web-read' }] }
      ]
    }, portfolio),
    /'shared' is declared more than once/
  );
});

test('what a capability ships is every delivery beneath it, at any depth', () => {
  const map = validateCapabilityMap(MAP, portfolio);
  assert.deepEqual(deliveriesUnder(map, 'commerce').map((entry) => entry.repository),
    ['api', 'web-write', 'web-read']);
  assert.deepEqual(deliveriesUnder(map, 'storefront').map((entry) => entry.repository),
    ['web-write', 'web-read']);
  // A delivery capability ships itself.
  assert.deepEqual(deliveriesUnder(map, 'payments-api').map((entry) => entry.repository), ['api']);
  assert.throws(() => deliveriesUnder(map, 'nowhere'), /Unknown capability/);
});

test('a repository can be traced back to the business that owns it', () => {
  const map = validateCapabilityMap(MAP, portfolio);
  assert.deepEqual(capabilityForRepository(map, 'web-read'),
    { id: 'storefront-read', name: 'Confirmation', ancestors: ['commerce', 'storefront'] });
  assert.equal(capabilityForRepository(map, 'platform'), null,
    'a declared repository that no capability claims is reported as unclaimed, not guessed at');
});

test('kind is inferred from whether a repository is named, so a short map stays short', () => {
  const map = validateCapabilityMap({
    version: 1,
    capabilities: [{ id: 'payments', children: [{ id: 'payments-api', repository: 'api' }] }]
  }, portfolio);
  const rows = flattenCapabilities(map);
  assert.equal(rows[0].kind, 'business');
  assert.equal(rows[1].kind, 'delivery');
});

test('a map may be validated without a portfolio, for editing before repositories exist', () => {
  const map = validateCapabilityMap({
    version: 1,
    capabilities: [{ id: 'future', kind: 'delivery', repository: 'not-yet-configured' }]
  });
  assert.deepEqual(map.repositories, ['not-yet-configured']);
});
