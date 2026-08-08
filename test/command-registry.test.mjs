import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCommand, COMMAND_REGISTRY, validateCommandHandlers } from '../src/command-registry.mjs';

test('command registry resolves compatibility aliases without duplicating handlers', () => {
  assert.equal(canonicalCommand('home'), 'cockpit');
  assert.equal(canonicalCommand('next-steps'), 'nextsteps');
  assert.equal(canonicalCommand('ledger'), 'ledger');
  assert.throws(() => canonicalCommand('not-a-command'), /Unknown command/);
  assert.equal(new Set(COMMAND_REGISTRY.map((entry) => entry.name)).size, COMMAND_REGISTRY.length);
  for (const entry of COMMAND_REGISTRY) {
    assert.match(entry.modulePath, /^\.\//);
    assert.ok(['read', 'mutation'].includes(entry.classification));
    assert.ok(['none', 'optional', 'required'].includes(entry.modelPolicy));
    assert.ok(['human', 'human-or-json', 'json'].includes(entry.output));
  }
  assert.equal(COMMAND_REGISTRY.find((entry) => entry.name === 'snapshot').classification, 'read');
  assert.equal(COMMAND_REGISTRY.find((entry) => entry.name === 'wm').modelPolicy, 'optional');
});

test('command registry detects missing and unregistered handlers', () => {
  const complete = Object.fromEntries(COMMAND_REGISTRY.map((entry) => [entry.name, () => {}]));
  assert.equal(validateCommandHandlers(complete), complete);
  const missing = { ...complete }; delete missing.ledger;
  assert.throws(() => validateCommandHandlers(missing), /Missing handlers: ledger/);
  assert.throws(() => validateCommandHandlers({ ...complete, surprise: () => {} }), /Unregistered handlers: surprise/);
});
