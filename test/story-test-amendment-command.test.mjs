import assert from 'node:assert/strict';
import test from 'node:test';
import { amendStoryTestCommand, publicTestAmendment } from '../src/commands/story-test-amendment.mjs';
import { operationCatalog, resolveOperation } from '../src/command-registry.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
function fixture() {
  const calls = [];
  const workflow = { workItem: { id: 'repair' }, currentPhase: 'implementation',
    resolution: { configurationSource: { repository: 'https://ghe.example.test/team/service.git' } } };
  const config = {};
  const snapshot = { sourceCommit: 'b'.repeat(40) };
  const dependencies = {
    async loadAcceptedStoryExecution(root, id) { calls.push(['load', root, id]); return { config, workflow }; },
    async resolveNewStoryConfigurationAuthority(root, options) { calls.push(['authority', root, options]); return { id: 'original' }; },
    async loadStoryConfigurationSnapshot(authority) { calls.push(['snapshot', authority]); return snapshot; },
    async preview(...args) { calls.push(['preview', ...args]); return { status: 'ready', stateChanged: false }; },
    async apply(...args) { calls.push(['apply', ...args]); return { status: 'cancelled', stateChanged: false }; }
  };
  const run = (options = {}, positionals = []) => amendStoryTestCommand({ root: '/repository', positionals,
    options: { reason: 'Correct the pinned unit-test invocation', ...options } }, dependencies);
  return { calls, workflow, config, snapshot, run };
}

test('test amendment defaults to a model-free read and apply requires explicit mutation classification', () => {
  for (const apply of [false, true]) {
    const operation = resolveOperation({ requestedCommand: 'story', positionals: ['story', 'test-policy', 'amend'],
      options: { apply, confirm: digest } });
    assert.equal(operation.id, `story.test-policy.amend${apply ? '' : '.preview'}`);
    assert.equal(operation.classification, apply ? 'mutation' : 'read');
    assert.equal(operation.modelPolicy, 'never');
    assert.ok(operationCatalog().some(entry => entry.id === operation.id));
  }
});

test('test amendment preview reads only the exact Story original configuration authority', async () => {
  const f = fixture();
  await f.run({ 'work-id': 'repair' });
  assert.deepEqual(f.calls.map(call => call[0]), ['load', 'authority', 'snapshot', 'preview']);
  assert.deepEqual(f.calls[1][2], { pinnedRemote: f.workflow.resolution.configurationSource.repository });
  assert.deepEqual(f.calls[3].slice(1), ['/repository', f.config, f.workflow, {
    reason: 'Correct the pinned unit-test invocation', approvedConfigurationSnapshot: f.snapshot
  }]);
});

test('test amendment passes review selection to runtime without treating it as approval', async () => {
  const f = fixture();
  const result = await f.run({ apply: true, confirm: digest });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stateChanged, false);
  assert.equal(f.calls.at(-1)[0], 'apply');
  assert.equal(f.calls.at(-1).at(-1).confirm, digest);
  assert.equal(Object.hasOwn(f.calls.at(-1).at(-1), 'actor'), false);
});

test('invalid CLI inputs refuse before reading Story or fetching configuration', async () => {
  for (const [options, positionals, code] of [
    [{ apply: true }, [], 'TCA_CONFIRMATION_REQUIRED'],
    [{ confirm: digest }, [], 'TCA_ARGUMENT_INVALID'],
    [{ actor: 'admin' }, [], 'TCA_ARGUMENT_INVALID'],
    [{ approvals: ['admin'] }, [], 'TCA_ARGUMENT_INVALID'],
    [{ reason: '' }, [], 'TCA_REASON_REQUIRED'],
    [{ reason: 'x'.repeat(4097) }, [], 'TCA_REASON_REQUIRED'],
    [{ 'work-id': 'other' }, ['repair'], 'TCA_ARGUMENT_INVALID'],
    [{}, ['repair', 'other'], 'TCA_ARGUMENT_INVALID']
  ]) {
    const f = fixture();
    await assert.rejects(f.run(options, positionals), { code });
    assert.deepEqual(f.calls, []);
  }
});

test('wrong phase and missing retained authority refuse without candidate lookup', async () => {
  const f = fixture();
  await assert.rejects(f.run({ phase: 'verification' }), { code: 'TCA_PHASE_INVALID' });
  assert.deepEqual(f.calls.map(call => call[0]), ['load']);
  delete f.workflow.resolution.configurationSource.repository;
  f.calls.length = 0;
  await assert.rejects(f.run(), { code: 'TCA_AUTHORITY_REQUIRED' });
  assert.deepEqual(f.calls.map(call => call[0]), ['load']);
});

test('public amendment output redacts nested credentials without altering the original binding', () => {
  const raw = { argv: ['https://person:private-secret@ghe.example.test/team/service?token=secret'],
    review: { token: 'live-token', secret: 'private-key' }, planSha256: digest };
  const output = publicTestAmendment(raw);
  assert.equal(output.planSha256, digest);
  assert.equal(output.review.token, '[REDACTED]');
  assert.equal(JSON.stringify(output).includes('private-secret'), false);
  assert.equal(JSON.stringify(output).includes('private-key'), false);
  assert.equal(raw.review.token, 'live-token');
});

test('attestation presentation redacts paired argv and opaque environment values in both command inventories', () => {
  const command = { kind: 'test', argv: ['runner', '--token', 'opaque-secret-value', '--api-key=other-private-value'],
    env: { CUSTOM_CREDENTIAL: 'environment-secret-value', NORMAL_CONFIG: 'also-private' } };
  const raw = { reviews: [{ previousCommands: [command], adoptedCommands: [{ ...command, argv: [...command.argv, '--verbose'] }] }] };
  const output = JSON.stringify(publicTestAmendment(raw));
  for (const secret of ['opaque-secret-value', 'other-private-value', 'environment-secret-value', 'also-private']) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /REDACTED/);
  assert.equal(raw.reviews[0].previousCommands[0].argv[2], 'opaque-secret-value');
});
