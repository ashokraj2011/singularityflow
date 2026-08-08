import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalCommand, operationCatalog, resolveOperation, validateOperationRegistry } from '../src/command-registry.mjs';

test('the public operation registry is complete, uniquely classified, and fallback-safe', () => {
  assert.equal(validateOperationRegistry(), true);
  const catalog = operationCatalog();
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length);
  assert.ok(catalog.every((item) => ['never', 'optional', 'required'].includes(item.modelPolicy)));
  assert.ok(catalog.filter((item) => item.modelPolicy === 'never').every((item) => item.noModelFixture));
  assert.ok(catalog.filter((item) => item.modelPolicy === 'optional').every((item) => (
    catalog.find((candidate) => candidate.id === item.fallback?.operationId)?.modelPolicy === 'never'
  )));
});

test('aliases resolve canonically and unknown mixed subcommands fail before handler loading', () => {
  assert.equal(canonicalCommand('home'), 'cockpit');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'build'] }).modelPolicy, 'required');
  assert.throws(
    () => resolveOperation({ requestedCommand: 'workspace', positionals: ['workspace', 'not-real'] }),
    (error) => error.code === 'MODEL_POLICY_UNCLASSIFIED'
  );
});
