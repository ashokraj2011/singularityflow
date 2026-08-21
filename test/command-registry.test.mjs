import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalCommand, COMMAND_REGISTRY, operationCatalog, RESOLVER_SUBCOMMANDS, resolveOperation,
  validateCommandHandlers
} from '../src/command-registry.mjs';

test('command registry resolves compatibility aliases without duplicating handlers', () => {
  assert.equal(canonicalCommand('home'), 'home');
  assert.equal(canonicalCommand('cockpit'), 'home');
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
  assert.equal(COMMAND_REGISTRY.find((entry) => entry.name === 'start').output, 'human-or-json');
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
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'ast', 'evidence', 'reproduce'] }).id, 'wm.ast.evidence.replay');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'ast', 'evidence', 'replay'] }).id, 'wm.ast.evidence.replay');
  // Refused before any handler loads — now saying which subcommand was wrong rather than naming
  // the model-policy invariant that only a developer can act on.
  assert.throws(() => resolveOperation({ requestedCommand: 'telemetry', positionals: ['telemetry', 'surprise'] }), /'telemetry' has no subcommand 'surprise'/);
});

test('command registry detects missing and unregistered handlers', () => {
  const complete = Object.fromEntries(COMMAND_REGISTRY.map((entry) => [entry.name, () => {}]));
  assert.equal(validateCommandHandlers(complete), complete);
  const missing = { ...complete }; delete missing.ledger;
  assert.throws(() => validateCommandHandlers(missing), /Missing handlers: ledger/);
  assert.throws(() => validateCommandHandlers({ ...complete, surprise: () => {} }), /Unregistered handlers: surprise/);
});

test('a mistyped subcommand is told what it typed, what was meant, and what works', () => {
  /**
   * The resolver's last line is reached two ways: an operation registered without a model policy —
   * a mistake in `command-registry.mjs` — and a reader mistyping a subcommand. Both raised the
   * invariant written for the first, so `sflow workspace add` answered "Operation 'workspace.add'
   * has no model policy classification. Refusing to load its handler.": a concept in no
   * documentation, a fault that was not the reader's, and no mention of the word they got wrong or
   * the words that work.
   *
   * `pr` had already been patched for precisely this in isolation. It was the whole class, reached
   * from eleven call sites.
   */
  for (const [command, known] of Object.entries(RESOLVER_SUBCOMMANDS)) {
    assert.throws(
      () => resolveOperation({ requestedCommand: command, positionals: [command, 'definitely-not-real'] }),
      (error) => {
        assert.equal(error.code, 'UNKNOWN_SUBCOMMAND', `${command} still reports an internal model-policy failure`);
        assert.match(error.message, /has no subcommand 'definitely-not-real'/);
        for (const subcommand of known) {
          assert.ok(error.message.includes(subcommand), `${command} does not offer '${subcommand}'`);
        }
        return true;
      },
      `${command} does not report an unknown subcommand`
    );
  }

  // The near miss is named, the same way an unknown top-level command already does it.
  assert.throws(() => resolveOperation({ requestedCommand: 'spec', positionals: ['spec', 'analyse'] }),
    /Did you mean 'analyze'\?/);
  assert.throws(() => resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'biuld'] }),
    /Did you mean 'build'\?/);

  // Nested slots say which slot they mean rather than calling a third positional a subcommand.
  assert.throws(() => resolveOperation({ requestedCommand: 'story', positionals: ['story', 'interval', 'nope'] }),
    /'story interval' has no action 'nope'\. Available: acknowledge, checkpoint, escalate, reconcile, status\./);
  assert.throws(() => resolveOperation({ requestedCommand: 'workspace', positionals: ['workspace', 'impact', 'nope'] }),
    /'workspace impact' has no action 'nope'\. Available: analyze, list, promote, show\./);
});

test('every advertised subcommand resolves, and has an operation to run', () => {
  /**
   * The other half: a list of valid subcommands is a promise. These are the same constants the
   * resolvers branch on and the operation catalog is built from — one source, three readers — so
   * this checks the promise is kept rather than that two copies happen to match today.
   */
  const catalog = new Set(operationCatalog().map((entry) => entry.id));
  const aliased = new Map([['workspace', new Map([['switch', 'use']])]]);
  for (const [command, known] of Object.entries(RESOLVER_SUBCOMMANDS)) {
    for (const subcommand of known) {
      const resolved = resolveOperation({ requestedCommand: command, positionals: [command, subcommand] });
      assert.ok(resolved?.id, `${command} ${subcommand} is offered but resolves to nothing`);

      // A nested slot resolves to its own default action; the parent id is the prefix either way.
      const canonicalSub = aliased.get(command)?.get(subcommand) ?? subcommand;
      assert.ok(resolved.id === `${command}.${canonicalSub}` || resolved.id.startsWith(`${command}.${canonicalSub}.`),
        `${command} ${subcommand} resolved to '${resolved.id}'`);
      assert.ok(catalog.has(resolved.id), `${resolved.id} is offered and resolvable but absent from the operation catalog`);
    }
  }
});
