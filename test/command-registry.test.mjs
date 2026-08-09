import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCommand, COMMAND_REGISTRY, resolveOperation, validateCommandHandlers } from '../src/command-registry.mjs';

test('command registry resolves compatibility aliases without duplicating handlers', () => {
  assert.equal(canonicalCommand('home'), 'cockpit');
  assert.equal(canonicalCommand('next-steps'), 'nextsteps');
  assert.equal(canonicalCommand('ledger'), 'ledger');
  assert.throws(() => canonicalCommand('not-a-command'), /Unknown command/);
  assert.equal(new Set(COMMAND_REGISTRY.map((entry) => entry.name)).size, COMMAND_REGISTRY.length);
  for (const entry of COMMAND_REGISTRY) {
    assert.match(entry.modulePath, /^\.\//);
    assert.ok(['read', 'mutation'].includes(entry.classification));
    assert.ok(['never', 'optional', 'required', 'mixed'].includes(entry.modelPolicy));
    assert.ok(['human', 'human-or-json', 'json'].includes(entry.output));
  }
  assert.equal(COMMAND_REGISTRY.find((entry) => entry.name === 'snapshot').classification, 'read');
  assert.equal(COMMAND_REGISTRY.find((entry) => entry.name === 'wm').modelPolicy, 'mixed');
});

test('mixed deterministic commands classify their actual operation rather than their top-level name', () => {
  const classify = (requestedCommand, positionals, options = {}) => resolveOperation({ requestedCommand, positionals, options }).classification;
  assert.equal(classify('report', ['report']), 'read');
  assert.equal(classify('report', ['report'], { out: 'report.html' }), 'mutation');
  assert.equal(classify('report', ['report'], { out: false }), 'read');
  assert.equal(classify('telemetry', ['telemetry', 'status']), 'read');
  assert.equal(classify('telemetry', ['telemetry', 'reconcile']), 'mutation');
  assert.equal(classify('inputs', ['inputs']), 'mutation');
  assert.equal(classify('inputs', ['inputs'], { 'dry-run': true }), 'read');
  assert.equal(classify('inputs', ['inputs'], { 'dry-run': 'true' }), 'read');
  assert.equal(classify('inputs', ['inputs'], { 'dry-run': 'false' }), 'mutation');
  assert.equal(classify('spec', ['spec', 'trace']), 'read');
  assert.equal(classify('spec', ['spec', 'coverage']), 'read');
  assert.equal(classify('spec', ['spec', 'claims']), 'mutation');
  assert.equal(classify('spec', ['spec', 'index'], { 'dry-run': true }), 'read');
  assert.equal(classify('spec', ['spec', 'acceptance']), 'mutation');
  assert.equal(classify('visual', ['visual', 'status']), 'read');
  assert.equal(classify('visual', ['visual', 'compare']), 'mutation');
  assert.equal(classify('review', ['review', 'intake']), 'read');
  assert.equal(classify('review', ['review', 'intake'], { out: 'review.md' }), 'mutation');
  assert.equal(resolveOperation({ requestedCommand: 'workspace', positionals: ['workspace', 'impact', 'analyze'], options: { 'dry-run': 'true' } }).modelPolicy, 'never');
  assert.equal(resolveOperation({ requestedCommand: 'pr', positionals: ['pr', 'describe'], options: { polish: 'true' } }).modelPolicy, 'optional');
  assert.throws(() => resolveOperation({ requestedCommand: 'telemetry', positionals: ['telemetry', 'surprise'] }), /no model policy classification/i);
});

test('command registry detects missing and unregistered handlers', () => {
  const complete = Object.fromEntries(COMMAND_REGISTRY.map((entry) => [entry.name, () => {}]));
  assert.equal(validateCommandHandlers(complete), complete);
  const missing = { ...complete }; delete missing.ledger;
  assert.throws(() => validateCommandHandlers(missing), /Missing handlers: ledger/);
  assert.throws(() => validateCommandHandlers({ ...complete, surprise: () => {} }), /Unregistered handlers: surprise/);
});
