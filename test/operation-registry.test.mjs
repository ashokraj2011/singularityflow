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
  assert.equal(canonicalCommand('home'), 'home');
  assert.equal(canonicalCommand('cockpit'), 'home');
  // registered-v4: a deterministic build is model-free; only a model composer requires a model.
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'build'] }).modelPolicy, 'never');
  assert.equal(resolveOperation({
    requestedCommand: 'wm', positionals: ['wm', 'build'], options: { composer: 'model-required' }
  }).modelPolicy, 'required');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'ensure'] }).modelPolicy, 'never');
  assert.equal(resolveOperation({ requestedCommand: 'next', positionals: ['next'] }).modelPolicy, 'optional');
  assert.throws(
    () => resolveOperation({ requestedCommand: 'workspace', positionals: ['workspace', 'not-real'] }),
    (error) => error.code === 'UNKNOWN_SUBCOMMAND'
  );
});
