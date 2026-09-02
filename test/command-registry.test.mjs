import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalCommand, COMMAND_REGISTRY, operationCatalog, RESOLVER_SUBCOMMANDS, resolveOperation,
  validateCommandHandlers
} from '../src/command-registry.mjs';
import { SGOS_CLI_OPTIONS, validateSgosCliOptions } from '../src/sgos/cli-options.mjs';

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

test('every registered SGOS subcommand has a closed option contract', () => {
  for (const [command, actions] of Object.entries(SGOS_CLI_OPTIONS)) {
    assert.deepEqual(
      Object.keys(actions).sort(),
      [...RESOLVER_SUBCOMMANDS[command]].sort(),
      `${command} option contracts match its registered subcommands`
    );
    for (const action of Object.keys(actions)) {
      assert.throws(
        () => validateSgosCliOptions(command, action, { 'definitely-not-a-real-option': true }),
        (error) => error.code === 'SGOS_UNKNOWN_OPTION'
          && error.message.includes(`for '${command} ${action}'`),
        `${command} ${action} refuses an unknown option`
      );
    }
  }
});

test('SGOS option strictness does not change non-SGOS operation resolution', () => {
  assert.equal(resolveOperation({
    requestedCommand: 'status',
    positionals: ['status'],
    options: { 'definitely-not-a-real-option': true }
  }).id, 'status');
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
  assert.equal(classify('mcp', ['mcp', 'probe', 'playwright'], { network: true }), 'read');
  assert.equal(classify('mcp', ['mcp', 'serve', 'playwright']), 'read');
  assert.equal(classify('mcp', ['mcp', 'verify-offline', 'playwright']), 'mutation');
  assert.equal(classify('mcp', ['mcp', 'auth', 'status', 'playwright']), 'read');
  assert.equal(resolveOperation({
    requestedCommand: 'mcp', positionals: ['mcp', 'auth', 'import', 'playwright'], options: {}
  }).id, 'mcp.auth.import.preview');
  assert.equal(resolveOperation({
    requestedCommand: 'mcp', positionals: ['mcp', 'auth', 'import', 'playwright'],
    options: { confirm: `sha256:${'a'.repeat(64)}` }
  }).id, 'mcp.auth.import');
  assert.equal(resolveOperation({
    requestedCommand: 'mcp', positionals: ['mcp', 'auth', 'clear', 'playwright'], options: {}
  }).id, 'mcp.auth.clear.preview');
  assert.equal(resolveOperation({
    requestedCommand: 'mcp', positionals: ['mcp', 'auth', 'clear', 'playwright'],
    options: { confirm: `sha256:${'b'.repeat(64)}` }
  }).id, 'mcp.auth.clear');
  assert.equal(classify('review', ['review', 'intake']), 'read');
  assert.equal(classify('review', ['review', 'intake'], { out: 'review.md' }), 'mutation');
  assert.equal(classify('session', ['session', 'current']), 'read');
  assert.equal(classify('session', ['session', 'doctor']), 'read');
  assert.equal(classify('session', ['session', 'attach', 'CFA-STORY']), 'mutation');
  assert.equal(classify('session', ['session', 'repair-selection', 'CFA-STORY']), 'mutation');
  assert.equal(classify('process', ['process', 'run', 'PROC-1']), 'mutation');
  assert.equal(resolveOperation({
    requestedCommand: 'process', positionals: ['process', 'run', 'PROC-1'],
    options: { 'maximum-parallel': '4' }
  }).id, 'process.run');
  assert.equal(resolveOperation({
    requestedCommand: 'process', positionals: ['process', 'step', 'PROC-1'], options: {}
  }).modelPolicy, 'never');
  assert.equal(resolveOperation({
    requestedCommand: 'process', positionals: ['process', 'run', 'PROC-1'], options: {}
  }).modelPolicy, 'never');
  assert.equal(resolveOperation({
    requestedCommand: 'policy', positionals: ['policy', 'plan'], options: {}
  }).id, 'policy.plan');
  assert.equal(resolveOperation({
    requestedCommand: 'policy', positionals: ['policy', 'plan'], options: {}
  }).classification, 'read');
  assert.equal(resolveOperation({
    requestedCommand: 'policy', positionals: ['policy', 'apply'],
    options: { 'expected-revision': '0', confirm: `sha256:${'a'.repeat(64)}` }
  }).classification, 'mutation');
  const modelStep = resolveOperation({
    requestedCommand: 'process', positionals: ['process', 'step', 'PROC-1'],
    options: { 'allow-model': true }
  });
  assert.equal(modelStep.id, 'process.step.model');
  assert.equal(modelStep.modelPolicy, 'required');
  assert.deepEqual(modelStep.externalDependencies, ['copilot-cli']);
  assert.equal(resolveOperation({
    requestedCommand: 'process', positionals: ['process', 'run', 'PROC-1'],
    options: { 'allow-model': true, 'maximum-parallel': '2' }
  }).id, 'process.run.model');
  assert.equal(resolveOperation({
    requestedCommand: 'program', positionals: ['program', 'approve', 'program.json'], options: {}
  }).id, 'program.approve.plan');
  assert.equal(resolveOperation({
    requestedCommand: 'program', positionals: ['program', 'approve', 'program.json'], options: {}
  }).classification, 'read');
  assert.equal(resolveOperation({
    requestedCommand: 'program', positionals: ['program', 'approve', 'program.json'],
    options: { confirm: `sha256:${'a'.repeat(64)}`, 'approved-at': '2026-08-30T00:00:00Z' }
  }).id, 'program.approve');
  assert.equal(resolveOperation({ requestedCommand: 'workspace', positionals: ['workspace', 'impact', 'analyze'], options: { 'dry-run': 'true' } }).modelPolicy, 'never');
  assert.equal(resolveOperation({ requestedCommand: 'workspace', positionals: ['workspace', 'impact', 'analyze'], options: { 'dry-run': 'true' } }).id, 'workspace.impact.analyze.preview');
  assert.equal(resolveOperation({ requestedCommand: 'workspace', positionals: ['workspace', 'copilot'], options: { 'dry-run': true } }).id, 'workspace.copilot.preview');
  assert.equal(resolveOperation({ requestedCommand: 'copilot', positionals: ['copilot'], options: { 'dry-run': true } }).id, 'copilot.preview');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'build'], options: { depth: 'light' } }).id, 'wm.light');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'ensure'], options: { depth: 'light' } }).id, 'wm.light');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'build'], options: { depth: 'standard' } }).modelPolicy, 'required');
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
    // `auto <free-form requirement>` is an intentional shorthand for `auto plan <requirement>`.
    // An unknown second token is therefore requirement text, not a misspelled subcommand.
    if (command === 'auto') continue;
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
  assert.equal(resolveOperation({ requestedCommand: 'auto', positionals: ['auto', 'add bounded telemetry'] }).id, 'auto.plan');

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

test('every deterministic preview has its own cataloged never-model operation', () => {
  const catalog = new Map(operationCatalog().map((entry) => [entry.id, entry]));
  for (const id of [
    'copilot.preview',
    'workspace.copilot.preview',
    'workspace.impact.analyze.preview',
    'wm.light',
    'program.approve.plan',
    'task.retry.plan'
  ]) {
    assert.equal(catalog.get(id)?.modelPolicy, 'never', id);
    assert.ok(catalog.get(id)?.noModelFixture, id);
  }
});

test('model-enabled SGOS dispatch has distinct required-model catalog entries', () => {
  const catalog = new Map(operationCatalog().map((entry) => [entry.id, entry]));
  for (const id of ['process.step.model', 'process.run.model']) {
    assert.equal(catalog.get(id)?.modelPolicy, 'required', id);
    assert.deepEqual(catalog.get(id)?.externalDependencies, ['copilot-cli'], id);
  }
});
