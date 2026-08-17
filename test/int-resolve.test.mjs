import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandleAuthority } from '../src/gateway/handles.mjs';
import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { DEFAULT_GATEWAY_POLICY, resolveGatewayPolicy } from '../src/gateway/policy.mjs';
import { resolveIntent } from '../src/gateway/resolve.mjs';
import { noEffects, sflowResult, validateSflowResult } from '../src/gateway/result.mjs';

const binding = {
  workspaceId: 'payments',
  repository: 'payments-api',
  branch: 'main',
  subjectKind: null,
  subjectId: null,
  sourceCommit: null,
  worktreeHash: null,
  lifecycleRevision: null,
  policyHash: 'sha256:policy',
  registryHash: 'sha256:registry',
  actorId: 'dev-1',
  hostSessionId: 'sess-1'
};

const setup = (over = {}) => {
  const registry = gatewayRegistry();
  return {
    registry,
    policy: resolveGatewayPolicy(),
    handles: createHandleAuthority(),
    binding,
    ...over
  };
};

const resolve = (request, over = {}) => resolveIntent(request, setup(over));

test('an exact phrase resolves to one operation and a usable read handle', () => {
  const result = resolve({ utterance: 'What am I working on?' });
  assert.equal(result.kind, 'read');
  assert.equal(result.operation.id, 'work.list');
  assert.equal(result.next[0].executable, true);
  assert.equal(result.why.some((entry) => entry.code === 'resolution.matched.phrase'), true);
  // Resolution computes; it has not done anything yet.
  assert.deepEqual({ ...result.effects }, noEffects());
  validateSflowResult(result);
});

test('ordinary language selects a read planner without executing a mutation', () => {
  const readiness = resolve({
    utterance: 'Could you show what is blocking this Story?',
    arguments: { workId: 'WRK-123' }
  });
  assert.equal(readiness.kind, 'read');
  assert.equal(readiness.operation.id, 'work.readiness');
  assert.equal(readiness.why[0].code, 'resolution.matched.conversation');
  assert.equal(readiness.next[0].reasonCode, 'resolution.matched.conversation');

  const start = resolve({ utterance: 'Please start a new bug fix' });
  assert.equal(start.kind, 'read');
  assert.equal(start.operation.id, 'work.start.intake');

  const generate = resolve({ utterance: 'Generate the active phase', arguments: { workId: 'WRK-123' } });
  assert.equal(generate.kind, 'read');
  assert.equal(generate.operation.id, 'work.continue');
  assert.deepEqual({ ...generate.effects }, noEffects());
});

test('ambiguous conversational actions require clarification', () => {
  const result = resolve({ utterance: 'Generate and submit the current phase' });
  assert.equal(result.kind, 'clarification');
  assert.equal(result.next.every((entry) => entry.executable === false), true);
  assert.equal(result.why[0].code, 'resolution.no-match');
});

test('a goal hint alone may narrow to a write, and may never choose one', () => {
  // `[INT:CON-036]`. One survivor is still returned as a candidate, so the user's click selects it.
  const context = setup();
  const result = resolveIntent({ goalHint: 'workspace.switch', arguments: { workspaceId: 'billing' } }, context);
  assert.equal(result.kind, 'candidates');
  const why = result.why.map((entry) => entry.code);
  assert.ok(why.includes('resolution.goal-alone-cannot-write'));
  assert.equal(result.next.every((entry) => entry.executable === false), true);
  assert.match(result.next[0].handle, /^sel_/);
});

test('a goal hint may resolve a read outright', () => {
  const result = resolve({ goalHint: 'work.list' });
  assert.equal(result.kind, 'read');
  assert.equal(result.operation.id, 'work.list');
});

test('an unknown goal is refused, and an unmatched utterance is a question', () => {
  const refused = resolve({ goalHint: 'make.coffee' });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'resolution.goal.unknown');

  // `[INT:REQ-150]`: nearest safe goals plus an explicit help fallback, never a guessed mutation.
  const asked = resolve({ utterance: 'please just sort it out' });
  assert.equal(asked.kind, 'clarification');
  assert.ok(asked.next.length);
  assert.equal(asked.next.every((entry) => entry.executable === false), true);
  assert.equal(asked.next[0].fallback.command, 'sflow explain');
});

test('a missing argument is a question; a wrong one is a refusal', () => {
  const asked = resolve({ utterance: 'show me the review packet' });
  assert.equal(asked.kind, 'clarification');
  assert.equal(asked.operation.id, 'review.packet');
  assert.equal(asked.outcome.slots.missing, 'workId');

  const refused = resolve({ utterance: 'show me the review packet', arguments: { workId: 'not a valid id!' } });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'resolution.arguments.invalid');
});

test('an approval resolves to a ceremony that no host can execute', () => {
  const result = resolve({ utterance: 'take me to the approval', arguments: { workId: 'WRK-123' } });
  assert.equal(result.kind, 'ceremony');
  assert.equal(result.operation.classification, 'authorization');
  assert.equal(result.next[0].executable, false);
  assert.equal(result.next[0].confirmation, 'ceremony');
  // No handle is issued for a ceremony; the next action is a destination.
  assert.match(result.next[0].handle, /^ceremony:/);
});

test('ambiguity returns signed choices rather than a silent pick', () => {
  // `[INT:REQ-151]` `[INT:REQ-033]`: `watch` reaches a read and two writes, and none is chosen here.
  const result = resolve({ goalHint: 'watch' });
  assert.equal(result.kind, 'read');
  assert.equal(result.operation.id, 'watch.list', 'with no arguments only the list can type-check');

  const withSubject = resolve({ goalHint: 'watch', arguments: { subjectId: 'WRK-1', predicate: 'phase-advanced' } });
  assert.equal(withSubject.kind, 'candidates');
  assert.ok(withSubject.next.length >= 1);
  assert.equal(withSubject.why.some((entry) => entry.code === 'resolution.matched.goal'), true);
});

test('a selection handle is honoured once and cannot be replayed', () => {
  const context = setup();
  const offered = resolveIntent({ goalHint: 'workspace.switch', arguments: { workspaceId: 'billing' } }, context);
  const chosen = offered.next[0].handle;

  const second = resolveIntent({ selectionHandle: chosen, arguments: { workspaceId: 'billing' } }, context);
  assert.equal(second.kind, 'plan');
  assert.equal(second.operation.id, 'workspace.switch');
  assert.equal(second.why[0].code, 'resolution.matched.selection-handle');

  const replay = resolveIntent({ selectionHandle: chosen, arguments: { workspaceId: 'billing' } }, context);
  assert.equal(replay.kind, 'refusal');
  assert.equal(replay.why[0].code, 'resolution.selection-handle.invalid');
  assert.ok(replay.next.length, 'a refused handle still offers a way forward');
});

test('legality is the last word, and an absent legal set is not permission', () => {
  const legal = resolve({ utterance: 'what am I working on' }, { legalActions: ['work.continue'] });
  assert.equal(legal.kind, 'refusal');
  assert.equal(legal.why[0].code, 'resolution.not-legal-now');
  assert.equal(legal.why[0].source, 'lifecycle');

  const permitted = resolve({ utterance: 'what am I working on' }, { legalActions: ['work.list'] });
  assert.equal(permitted.kind, 'read');
});

test('policy denial removes an operation from resolution entirely', () => {
  const policy = resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY, { layer: 'workspace', denied: ['work.list'] }]);
  const result = resolve({ utterance: 'what am I working on' }, { policy });
  assert.equal(result.kind, 'clarification', 'a denied operation is not matchable, not a refusal that names it');
});

// ---------------------------------------------------------------------------------------------

const readResult = ({ operation }) => sflowResult({
  kind: 'read',
  operation: { id: operation.id, classification: operation.classification },
  outcome: { status: 'succeeded', messageId: 'gateway.read' },
  effects: noEffects(),
  restState: 'informational'
});

test('the kernel takes every capability as an argument', () => {
  const kernel = createGatewayKernel({ binding });
  assert.equal(kernel.registryHash, gatewayRegistry().contentHash);
  assert.equal(kernel.policy.degraded, false);
});

test('a read handle round-trips through the kernel to its planner', async () => {
  const planners = new Map([['work-list', readResult]]);
  const kernel = createGatewayKernel({ binding, planners });
  const resolved = kernel.resolve({ utterance: 'what am I working on' });
  const read = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(read.kind, 'read');
  assert.equal(read.operation.id, 'work.list');
});

test('a declared planner this build does not have refuses, and says which', async () => {
  const kernel = createGatewayKernel({ binding });
  const resolved = kernel.resolve({ utterance: 'what am I working on' });
  const read = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(read.kind, 'refusal');
  assert.equal(read.why[0].code, 'gateway.planner-unavailable');
  assert.equal(read.why[0].source, 'unavailable');
  assert.equal(read.why[0].slots.planner, 'work-list');
});

test('a planner that returns something off-contract does not reach the host', async () => {
  const kernel = createGatewayKernel({ binding, planners: new Map([['work-list', () => ({ ok: true })]]) });
  const resolved = kernel.resolve({ utterance: 'what am I working on' });
  await assert.rejects(() => kernel.read({ resolutionId: resolved.next[0].handle }), (error) => error.code === 'SFLOW_RESULT_INVALID');
});

test('an unknown, expired or foreign handle is refreshed rather than carried', async () => {
  const kernel = createGatewayKernel({ binding });
  const refused = await kernel.read({ resolutionId: 'rea_nothing' });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'gateway.handle-unknown');
});

test('next computes legal actions and offers none of them as executable', () => {
  const kernel = createGatewayKernel({ binding, legalActions: () => ['work.list', 'review.open'] });
  const result = kernel.next({ scope: 'home' });
  assert.equal(result.kind, 'read');
  assert.equal(result.next.length, 2);
  assert.equal(result.next.every((entry) => entry.executable === false), true);
  assert.match(result.next.find((entry) => entry.id === 'legal:work.list').handle, /^sel_/);
  assert.equal(result.next.find((entry) => entry.id === 'legal:review.open').kind, 'ceremony');
  assert.deepEqual({ ...result.effects }, noEffects());
});

test('a legal-next navigation choice is authority-issued and reaches its planner', async () => {
  const planners = new Map([['work-list', readResult]]);
  const kernel = createGatewayKernel({ binding, planners, legalActions: () => ['work.list'] });
  const offered = kernel.next({ scope: 'home' }).next[0];
  assert.match(offered.handle, /^sel_/);

  const selected = kernel.resolve({ selectionHandle: offered.handle });
  assert.equal(selected.operation.id, 'work.list');
  const read = await kernel.read({ resolutionId: selected.next[0].handle });
  assert.equal(read.operation.id, 'work.list');
});

test('next with nothing legal is an answer, not a dead end', () => {
  const kernel = createGatewayKernel({ binding, legalActions: () => [] });
  const result = kernel.next({ scope: 'subject' });
  assert.equal(result.next.length, 0);
  assert.equal(result.restState, 'informational');
});

test('run is refused while the gateway is read-only', async () => {
  const kernel = createGatewayKernel({ binding });
  const refused = await kernel.run({ planId: 'plan_1' });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'gateway.read-only');

  const opened = createGatewayKernel({ binding, readOnly: false });
  assert.equal((await opened.run({ planId: 'plan_1' })).why[0].code, 'gateway.not-implemented');
});

test('explain routes to its planner and stays a read', async () => {
  const kernel = createGatewayKernel({ binding, planners: new Map([['help-explain', readResult]]) });
  const explained = await kernel.explain({ question: 'what is a work interval?' });
  assert.equal(explained.kind, 'read');
  assert.equal(explained.operation.id, 'help.explain');
});
