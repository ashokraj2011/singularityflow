import assert from 'node:assert/strict';
import test from 'node:test';
import { storyTestRiskCommand } from '../src/commands/story-test-risk.mjs';
import { operationCatalog, resolveOperation } from '../src/command-registry.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const reason = 'Review the unavailable validation for this exact candidate';
const acceptance = { issue: 'issue-1', reason, 'follow-up-owner': 'maintainer', remediation: 'Repair the runner before the next change' };
function fixture() {
  const calls = [];
  const workflow = { workItem: { id: 'review' }, currentPhase: 'implementation' };
  const config = {};
  const dependencies = {
    async loadAcceptedStoryExecution(...args) { calls.push(['load', ...args]); return { config, workflow }; },
    ...Object.fromEntries(['plan', 'accept', 'revoke', 'attest'].map(name => [name, async (...args) => {
      calls.push([name, ...args]); return { status: 'blocked', stateChanged: false, executed: false };
    }]))
  };
  return { calls, workflow, config, run: (action = 'risks', options = {}, positionals = []) =>
    storyTestRiskCommand({ root: '/repository', action, positionals, options }, dependencies) };
}

test('every risk route is model-free; previews are reads and only explicit apply is a mutation', () => {
  for (const action of ['risks', 'accept-risk', 'revoke-risk', 'attest-risk']) {
    for (const apply of [false, true]) {
      const op = resolveOperation({ requestedCommand: 'story', positionals: ['story', 'test-policy', action], options: { apply } });
      assert.equal(op.id, `story.test-policy.${action}${action !== 'risks' && !apply ? '.preview' : ''}`);
      assert.equal(op.classification, action === 'risks' || !apply ? 'read' : 'mutation');
      assert.equal(op.modelPolicy, 'never');
      assert.ok(operationCatalog().some(row => row.id === op.id));
    }
  }
});

test('risk inspection reads exact accepted Story only, without external configuration or tests', async () => {
  const f = fixture();
  await f.run('risks', { 'work-id': 'review', operation: 'submit', phase: 'implementation' });
  assert.deepEqual(f.calls.map(call => call[0]), ['load', 'plan']);
  assert.deepEqual(f.calls[1].slice(1), ['/repository', f.config, f.workflow, {
    phaseId: 'implementation', repositoryId: undefined, operation: 'submit'
  }]);
});

test('acceptance preview carries substantive risk scope but no approval identity', async () => {
  const f = fixture();
  await f.run('accept-risk', acceptance, ['review']);
  assert.equal(f.calls.at(-1)[0], 'plan');
  assert.equal(f.calls.at(-1).at(-1).issueId, 'issue-1');
  assert.equal(f.calls.at(-1).at(-1).followUpOwner, 'maintainer');
  assert.equal(Object.hasOwn(f.calls.at(-1).at(-1), 'confirmation'), false);
  await f.run('accept-risk', { ...acceptance, apply: true, confirm: digest });
  assert.equal(f.calls.at(-1)[0], 'accept');
  assert.equal(f.calls.at(-1).at(-1).confirmation, digest);
});

test('revocation and attestation preview exact retained hashes; agreement attestation can omit record', async () => {
  const f = fixture();
  await f.run('revoke-risk', { 'record-sha256': digest, reason });
  assert.deepEqual(f.calls.at(-1).at(-1), { recordSha256: digest, reason, apply: false });
  await f.run('attest-risk');
  assert.deepEqual(f.calls.at(-1).at(-1), { apply: false });
  await f.run('attest-risk', { 'record-sha256': digest, apply: true, confirm: digest });
  assert.deepEqual(f.calls.at(-1).at(-1), { recordSha256: digest, apply: true, confirmation: digest });
});

test('invalid scope or attempted actor/receipt injection refuses before any Story read', async () => {
  const rows = [
    ['risks', { apply: true }], ['risks', { operation: 'destroy' }], ['risks', { 'work-id': '../elsewhere' }],
    ['risks', { phase: 'code;command' }], ['risks', { repository: '--other' }],
    ['accept-risk', { ...acceptance, actor: 'admin' }], ['accept-risk', { ...acceptance, token: 'forged' }],
    ['accept-risk', { ...acceptance, confirmation: digest }], ['accept-risk', { ...acceptance, apply: true }],
    ['accept-risk', { ...acceptance, confirm: digest }], ['accept-risk', { ...acceptance, reason: 'short' }],
    ['accept-risk', { ...acceptance, 'follow-up-owner': 'person\nadmin' }], ['accept-risk', { ...acceptance, remediation: '' }],
    ['accept-risk', { ...acceptance, expires: 'tomorrow' }], ['accept-risk', { ...acceptance, issue: '' }],
    ['revoke-risk', { reason }], ['revoke-risk', { 'record-sha256': 'bad', reason }], ['attest-risk', { 'record-sha256': 'bad' }],
    ['attest-risk', { operation: 'publish' }]
  ];
  for (const [action, options] of rows) {
    const f = fixture();
    await assert.rejects(f.run(action, options), /./u);
    assert.deepEqual(f.calls, [], `${action} ${JSON.stringify(options)}`);
  }
  const f = fixture();
  await assert.rejects(f.run('risks', { 'work-id': 'other' }, ['review']), /disagree/u);
  await assert.rejects(f.run('risks', {}, ['review', 'other']), /extra positional/u);
  assert.deepEqual(f.calls, []);
});

test('wrong phase cannot authorize an old preview against a different phase', async () => {
  const f = fixture();
  await assert.rejects(f.run('accept-risk', { ...acceptance, phase: 'verification' }), { code: 'TRP_RISK_PHASE_INVALID' });
  assert.deepEqual(f.calls.map(call => call[0]), ['load']);
});

test('downstream and replay can review a published source phase without changing active phase', async () => {
  const f = fixture();
  f.workflow.currentPhase = 'verification';
  f.workflow.phases = { implementation: { generation: 1 }, specification: { generation: 0 } };
  for (const operation of ['downstream', 'replay']) {
    await f.run('accept-risk', { ...acceptance, phase: 'implementation', operation });
    assert.equal(f.calls.at(-1).at(-1).phaseId, 'implementation');
    assert.equal(f.workflow.currentPhase, 'verification');
    await assert.rejects(f.run('accept-risk', { ...acceptance, phase: 'specification', operation }), { code: 'TRP_RISK_PHASE_INVALID' });
  }
});
