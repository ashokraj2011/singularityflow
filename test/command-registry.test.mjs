import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCommand, COMMAND_REGISTRY, validateCommandHandlers } from '../src/command-registry.mjs';

test('command registry resolves compatibility aliases without duplicating handlers', () => {
  assert.equal(canonicalCommand('home'), 'cockpit');
  assert.equal(canonicalCommand('next-steps'), 'nextsteps');
  assert.equal(canonicalCommand('ledger'), 'ledger');
  assert.throws(() => canonicalCommand('not-a-command'), /Unknown command/);
  assert.equal(new Set(COMMAND_REGISTRY.map((entry) => entry.name)).size, COMMAND_REGISTRY.length);
});

test('command registry detects missing and unregistered handlers', () => {
  const complete = Object.fromEntries(COMMAND_REGISTRY.map((entry) => [entry.name, () => {}]));
  assert.equal(validateCommandHandlers(complete), complete);
  const missing = { ...complete }; delete missing.ledger;
  assert.throws(() => validateCommandHandlers(missing), /Missing handlers: ledger/);
  assert.throws(() => validateCommandHandlers({ ...complete, surprise: () => {} }), /Unregistered handlers: surprise/);
});
