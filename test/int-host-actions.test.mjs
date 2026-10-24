/**
 * Host actions: one allowlist, typed arguments, checked when a result leaves the kernel and again
 * where it is received. `[INT:IFC-061]` `[INT:CON-130]` `[INT:CON-131]`
 *
 * The property under test is that a host action can only ever *open a trusted view*: an action
 * that is not on the allowlist, carries an argument its schema does not accept, or carries command
 * text is dropped with a recorded reason and is never opened — and no path from a host action
 * reaches the kernel's read, plan, receipt or run machinery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  HOST_ACTIONS, HOST_ACTION_REFUSALS, argumentSchema, hostActionFromLink, hostActionSchemaId, validateHostAction
} from '../src/gateway/argument-schemas.mjs';
import { createActionExecutor, receiveHostAction } from '../src/gateway/executor.mjs';
import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { negotiatedCapabilities } from '../src/gateway/mcp-stdio.mjs';
import { impactQuick } from '../src/gateway/planners/impact-quick.mjs';
import { noEffects, sflowResult, validateSflowResult } from '../src/gateway/result.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const binding = {
  workspaceId: 'payments', repository: 'payments-api', branch: 'main', subjectKind: null, subjectId: null,
  sourceCommit: null, worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null,
  policyHash: 'sha256:policy', registryHash: 'sha256:registry', actorId: 'dev-1@example.com', hostSessionId: 'sess-host-actions'
};

/** A view link the way a planner writes one. */
const viewEntry = (id, hostAction, extra = {}) => ({
  handle: `host-action:${id}`, id, label: `Open ${id}`, rank: 0, kind: 'host-action', reasonCode: 'impact.open-impact-view',
  confirmation: 'none', interaction: 'navigation', emphasis: 'link', executable: false, hostAction,
  fallback: { label: 'Show the impact in the terminal', command: 'sflow impact' }, ...extra
});

const ceremonyEntry = (hostAction) => ({
  handle: 'ceremony:review.open:WRK-2', id: 'ceremony:review.open', label: 'Open the design review', rank: 1,
  kind: 'ceremony', reasonCode: 'review.ceremony-destination', confirmation: 'ceremony', interaction: 'ceremony',
  executable: false, hostAction, fallback: { label: 'Decide in the terminal', command: 'sflow approve design --work-id WRK-2 --fetch' }
});

/** A kernel whose one read planner returns exactly the next[] it is given. */
function kernelReturning(next, { hostCapabilities } = {}) {
  const planner = () => sflowResult({
    kind: 'read', operation: { id: 'help.explain', classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'gateway.explained', slots: {} }, effects: noEffects(),
    next, restState: 'informational'
  });
  return createGatewayKernel({
    binding, planners: new Map([['help-explain', planner]]),
    ...(hostCapabilities ? { hostCapabilities } : {})
  });
}

test('the allowlist is exactly the eleven views the specification names, each with a closed opaque schema', () => {
  // `[INT:IFC-061]`
  assert.deepEqual([...HOST_ACTIONS], [
    'vscode.selectWorkspace', 'vscode.attachRepository', 'vscode.openArtifact', 'vscode.openReviewCeremony',
    'vscode.openJourney', 'vscode.openImpact', 'vscode.openInvestigation', 'vscode.openContextReceipt',
    'vscode.openHandoff', 'vscode.openProgress', 'vscode.focusCopilot'
  ]);
  for (const id of HOST_ACTIONS) {
    const schema = argumentSchema(hostActionSchemaId(id));
    assert.ok(schema, `${id} has a typed argument schema`);
    // `[INT:CON-131]`: identifiers, enums and bounded integers only — nothing that can hold a command.
    for (const [field, spec] of Object.entries(schema.fields)) {
      assert.ok(['identifier', 'enum', 'integer'].includes(spec.type), `${id}.${field} is ${spec.type}`);
    }
  }
});

test('a host action is accepted only as an allowlisted id with exactly the arguments its schema types', () => {
  // `[INT:CON-130]` `[INT:CON-131]`
  assert.deepEqual(validateHostAction({ id: 'vscode.openReviewCeremony', arguments: { workId: 'WRK-2', phase: 'design', generation: 3 } }),
    { ok: true, hostAction: { id: 'vscode.openReviewCeremony', arguments: { workId: 'WRK-2', phase: 'design', generation: 3 } } });
  assert.deepEqual(validateHostAction({ id: 'vscode.focusCopilot' }), { ok: true, hostAction: { id: 'vscode.focusCopilot', arguments: {} } });

  const refused = (candidate) => { const checked = validateHostAction(candidate); assert.equal(checked.ok, false); return checked; };
  assert.equal(refused({ id: 'vscode.runTerminal' }).reason, 'not-allowlisted');
  assert.equal(refused({ id: 'workbench.action.terminal.sendSequence' }).reason, 'not-allowlisted');
  assert.equal(refused({ id: 'vscode.openJourney', arguments: { workId: 'WRK-1', branch: 'main' } }).reason, 'argument-unknown');
  assert.equal(refused({ id: 'vscode.openHandoff', arguments: {} }).reason, 'argument-missing');
  assert.equal(refused({ id: 'vscode.openReviewCeremony', arguments: { workId: 'WRK-2', generation: '3' } }).reason, 'argument-invalid');
  assert.equal(refused({ id: 'vscode.openJourney', arguments: { workKind: 'epic' } }).reason, 'argument-invalid');
  for (const text of ['WRK-1; rm -rf ~', 'command:workbench.action.terminal.new', '$(touch /tmp/x)', '--upload-pack=evil',
    'sflow approve design --work-id WRK-1', 'https://example.com/x', '`id`']) {
    const checked = refused({ id: 'vscode.openJourney', arguments: { workId: text } });
    assert.deepEqual([checked.reason, checked.field], ['command-text', 'workId'], text);
    assert.ok(!JSON.stringify(checked).includes(text), 'the refusal never repeats the payload');
  }
  assert.equal(refused({ id: 'vscode.openImpact', arguments: {}, command: 'rm -rf ~' }).reason, 'malformed');
  assert.equal(refused('vscode.openImpact').reason, 'malformed');
  assert.equal(refused({ id: 'vscode.openImpact', arguments: ['WRK-1'] }).reason, 'malformed');
  assert.equal(refused({ id: 'vscode.open Impact; whoami' }).action, 'unknown', 'a tampered name is not echoed');
  for (const reason of ['malformed', 'not-allowlisted', 'argument-unknown', 'argument-missing', 'argument-invalid', 'command-text']) {
    assert.ok(HOST_ACTION_REFUSALS.includes(reason));
  }
});

test('a deep link is parsed into identifiers and then validated like any other host action', () => {
  // `[INT:CON-131]`
  const link = hostActionFromLink('action=vscode.openReviewCeremony&workId=WRK-2&phase=design&generation=4');
  assert.deepEqual(link, { id: 'vscode.openReviewCeremony', arguments: { workId: 'WRK-2', phase: 'design', generation: 4 } });
  assert.equal(validateHostAction(link).ok, true);
  assert.equal(validateHostAction(hostActionFromLink('action=vscode.openJourney&workId=WRK-1%3Bwhoami')).reason, 'command-text');
  assert.equal(validateHostAction(hostActionFromLink('action=vscode.openJourney&action=vscode.openImpact')).reason, 'malformed');
  assert.equal(validateHostAction(hostActionFromLink('workId=WRK-1')).reason, 'malformed');
  // Only a schema integer is converted; the same digits elsewhere stay the string they arrived as.
  assert.deepEqual(hostActionFromLink('action=vscode.openJourney&workId=123').arguments, { workId: '123' });
});

test('the kernel withholds an invalid host action when it emits a result, and records why', async () => {
  // `[INT:CON-130]`: dropped with a recorded reason, never executed and never a failed read.
  const kernel = kernelReturning([
    viewEntry('view:valid', { id: 'vscode.openImpact', arguments: {} }),
    viewEntry('view:unknown', { id: 'vscode.runTerminal', arguments: { text: 'rm -rf ~' } }),
    viewEntry('view:typed', { id: 'vscode.openJourney', arguments: { workId: 'WRK-1 && curl evil' } }),
    ceremonyEntry({ id: 'vscode.openReviewCeremony', arguments: { workId: 'WRK-2', extra: 'x' } })
  ]);
  const resolved = await kernel.explain({ question: 'what can I open' });
  validateSflowResult(resolved);
  assert.deepEqual(resolved.next.map((action) => action.id), ['view:valid', 'ceremony:review.open'],
    'a view link that failed is gone; the ceremony stays with its terminal fallback');
  assert.deepEqual(resolved.next[0].hostAction, { id: 'vscode.openImpact', arguments: {} });
  assert.equal(resolved.next[0].executable, false, 'a host action is never executable through a tool');
  assert.equal(resolved.next[1].hostAction, undefined);
  assert.equal(resolved.next[1].fallback.command, 'sflow approve design --work-id WRK-2 --fetch');
  const dropped = resolved.warnings.filter((entry) => entry.code === 'gateway.host-action-dropped');
  assert.deepEqual(dropped.map((entry) => [entry.reference, entry.slots.action, entry.slots.reason]), [
    ['view:unknown', 'vscode.runTerminal', 'not-allowlisted'],
    ['view:typed', 'vscode.openJourney', 'command-text'],
    ['ceremony:review.open', 'vscode.openReviewCeremony', 'argument-unknown']
  ]);
  assert.ok(!JSON.stringify(resolved).includes('curl evil') && !JSON.stringify(resolved).includes('rm -rf'),
    'no withheld payload survives in the emitted result');
});

test('a host that declares no views keeps the terminal continuation and the same answer', async () => {
  // `[INT:IFC-063]` `[INT:REQ-130]`: MCP declares no host actions; only the link is withheld, so the
  // outcome, reasons, warnings and next actions match the editor's.
  assert.deepEqual(negotiatedCapabilities({ capabilities: {} }).hostActions, []);
  const kernel = kernelReturning([viewEntry('view:impact', { id: 'vscode.openImpact', arguments: {} })], {
    hostCapabilities: negotiatedCapabilities({ capabilities: {} })
  });
  const resolved = await kernel.explain({ question: 'what can I open' });
  assert.equal(resolved.next.length, 1);
  assert.equal(resolved.next[0].hostAction, undefined);
  assert.equal(resolved.next[0].fallback.command, 'sflow impact');
  assert.deepEqual(resolved.warnings, [], 'a capability gap is degraded, not reported as a fault');

  // A view link with nowhere to go where it cannot open is invalid for every host `[INT:IFC-001]`.
  const bare = await kernelReturning([viewEntry('view:bare', { id: 'vscode.openImpact', arguments: {} }, { fallback: null })])
    .explain({ question: 'what can I open' });
  assert.deepEqual(bare.next, []);
  assert.deepEqual(bare.warnings.map((entry) => entry.slots.reason), ['fallback-missing']);
});

test('a host action never enters the kernel: the executor hands it back untouched', async () => {
  // `[INT:CON-130]`: no read, resolve, plan review, confirmation or run is reachable from one.
  const touched = [];
  const kernel = new Proxy({}, { get: (_target, name) => { touched.push(String(name)); throw new Error(`kernel.${String(name)} was reached`); } });
  const executor = createActionExecutor({ gateway: { kernel } });
  touched.length = 0;
  const view = viewEntry('view:impact', { id: 'vscode.openImpact', arguments: {} });
  assert.deepEqual(await executor.execute(view), { outcome: 'host-action', action: view });
  const ceremony = ceremonyEntry({ id: 'vscode.openReviewCeremony', arguments: { workId: 'WRK-2' } });
  assert.equal((await executor.execute(ceremony)).outcome, 'ceremony');
  assert.deepEqual(touched, [], 'nothing on the kernel was read');

  // And the placeholder handle a view link carries is nothing the kernel will run.
  const real = createGatewayKernel({ binding, readOnly: false, mutationExecutors: new Map([['x', () => { throw new Error('ran'); }]]) });
  const ran = await real.run({ planId: view.handle });
  assert.equal(ran.kind, 'refusal');
  assert.ok(Object.values(ran.effects).every((value) => value === false));
});

test('the receiving host refuses what the kernel would, and a view this build does not have', () => {
  // `[INT:CON-131]`: reauthorized where received, with a refusal card rather than silence.
  const accepted = receiveHostAction({ id: 'vscode.openImpact', arguments: {} }, { available: ['vscode.openImpact'] });
  assert.deepEqual(accepted, { accepted: true, hostAction: { id: 'vscode.openImpact', arguments: {} } });

  const tampered = receiveHostAction({ id: 'vscode.openImpact', arguments: { workId: 'x;whoami' } });
  assert.equal(tampered.accepted, false);
  assert.equal(tampered.reason, 'command-text');
  validateSflowResult(tampered.result);
  assert.deepEqual([tampered.result.kind, tampered.result.operation.id, tampered.result.why[0].code],
    ['refusal', 'gateway.host-action', 'gateway.host-action-refused']);
  assert.ok(Object.values(tampered.result.effects).every((value) => value === false), 'nothing was opened or changed');
  assert.equal(tampered.result.restState, 'blocked', 'a refused link is not something another surface can do instead');

  const absent = receiveHostAction({ id: 'vscode.openInvestigation', arguments: {} }, {
    available: ['vscode.openImpact'], fallback: { label: 'Investigate in the terminal', command: 'sflow explain' }
  });
  assert.equal(absent.accepted, false);
  assert.deepEqual(absent.result.why[0].slots, { action: 'vscode.openInvestigation', reason: 'not-available-in-this-build' });
  assert.equal(absent.result.next[0].fallback.command, 'sflow explain', 'the explicit fallback is the way forward');
  assert.equal(absent.result.next[0].executable, false);
  const bare = receiveHostAction({ id: 'vscode.openProgress' }, { available: [] });
  assert.equal(bare.result.restState, 'unavailable', 'a view this build lacks is unavailable here');
});

test('quick impact offers the Impact view as a typed host action with its terminal equivalent', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'sflow-host-action-impact-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await mkdir(path.join(repo, 'singularity', 'work-items'), { recursive: true });
  const result = await impactQuick({ root: repo, context: { workspace: { repositories: {} }, changedPaths: ['src/pay.ts'] } });
  const open = result.next.find((action) => action.id === 'impact:open-view');
  assert.deepEqual(open.hostAction, { id: 'vscode.openImpact', arguments: {} });
  assert.deepEqual([open.kind, open.executable, open.fallback.command], ['host-action', false, 'sflow impact']);
  assert.equal(validateHostAction(open.hostAction).ok, true);
  // The view reads more than this range's paths, so it is offered for an empty range too.
  const empty = await impactQuick({ root: repo, context: { workspace: { repositories: {} }, changedPaths: [] } });
  assert.deepEqual(empty.next.map((action) => action.id), ['impact:open-view']);
});

test('the editor names a view for every allowlisted action, or refuses it as not available here', async () => {
  // `[INT:IFC-060]` `[INT:IFC-063]`: the editor's own map, checked against the shared allowlist.
  const editor = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts')).href);
  assert.deepEqual(Object.keys(editor.EDITOR_HOST_ACTION_COMMANDS), [...HOST_ACTIONS]);
  const session = editor.gatewaySession({
    root: null, workspaceId: null, workspaceName: null, repositoryId: null, origin: 'test'
  });
  assert.deepEqual([...session.kernel.hostCapabilities.hostActions],
    HOST_ACTIONS.filter((id) => editor.EDITOR_HOST_ACTION_COMMANDS[id]), 'only views this build has are declared');
  const opened = session.hostActions.receive({ id: 'vscode.openReviewCeremony', arguments: { workId: 'WRK-2' } });
  assert.deepEqual([opened.accepted, opened.command], [true, 'singularityFlow.openApprovals']);
  for (const id of ['vscode.openInvestigation', 'vscode.openContextReceipt', 'vscode.openHandoff', 'vscode.openProgress']) {
    const refused = session.hostActions.receive({ id, arguments: id === 'vscode.openHandoff' ? { workId: 'WRK-2' } : {} });
    assert.deepEqual([refused.accepted, refused.reason], [false, 'not-available-in-this-build'], id);
  }
  const link = session.hostActions.receive(session.hostActions.fromLink('action=vscode.focusCopilot&prompt=approve%20it'));
  assert.deepEqual([link.accepted, link.reason], [false, 'command-text']);
  editor.resetGatewaySession();
});
