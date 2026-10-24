/**
 * The same corpus through the editor's gateway session and the stdio MCP server. `[INT:AC-016]`
 * `[INT:IFC-062]` `[INT:IFC-063]` `[INT:CON-133]` `[INT:REQ-130]` `[INT:CON-163]`
 *
 * Parity is semantic, not schematic: outcomes, effects, reasons, warnings, evidence and next-action
 * identities must agree. Handles differ — each session signs its own — and nothing else may.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { readGatewayEvents } from '../src/gateway/audit.mjs';
import { serveMcp } from '../src/gateway/mcp-stdio.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const runtime = fileURLToPath(new URL('../apps/vscode/dist/gateway-runtime.cjs', import.meta.url));
const ACTOR = { email: 'dev@example.test', name: 'Dev' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-int-parity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', ACTOR.email);
  git(root, 'config', 'user.name', ACTOR.name);
  const story = (id, status, approval = false) => ({
    workItem: { id, title: `Work ${id}`, workType: 'feature', branch: 'main' }, phaseOrder: ['design'], currentPhase: 'design',
    phases: { design: { status, generation: 1, ...(approval ? { approvalPolicy: { authorities: ['developers'], minimum: 1, allowSelfApproval: false } } : {}) } },
    history: [{ event: approval ? 'phase_submitted' : 'work_started', phase: 'design', actor: { email: 'other@example.test' }, at: '2026-10-20T10:00:00.000Z' }],
    ...(approval ? { resolution: { approvalAuthorities: { developers: { label: 'Developers', allowAnyGitIdentity: false, githubTeams: [],
      members: [{ name: ACTOR.name, email: ACTOR.email }] } } } } : {})
  });
  for (const [id, status, approval] of [['WRK-1', 'in_progress', false], ['WRK-2', 'awaiting_approval', true]]) {
    await mkdir(path.join(root, 'singularity', 'work-items', id), { recursive: true });
    await writeFile(path.join(root, 'singularity', 'work-items', id, 'workflow.json'), JSON.stringify(story(id, status, approval)));
  }
  await writeFile(path.join(root, 'checkout.mjs'), 'export function postal() { return true; }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

/** A minimal MCP client over the server's stdio; it answers elicitations with `elicit`. */
function mcpClient(root, { elicitation = true, elicit = () => ({ action: 'decline' }) } = {}) {
  const child = spawn(process.execPath, [cli, 'gateway', 'serve', '--transport', 'stdio'], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let id = 0;
  const waiting = new Map();
  const elicitations = [];
  const exited = new Promise((resolve) => child.on('close', resolve));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === 'elicitation/create') {
        elicitations.push(message.params);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: elicit(message.params) })}\n`);
      } else waiting.get(message.id)?.(message);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const own = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    waiting.set(own, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: own, method, params })}\n`);
  });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args })).result.structuredContent;
  return {
    elicitations,
    async start() {
      const init = await call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'parity-test' },
        capabilities: elicitation ? { elicitation: {} } : {} });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return init.result;
    },
    call, tool,
    close: () => { child.stdin.end(); return exited; }
  };
}

/** What two hosts must agree on. Handles, timestamps and session-bound IDs are left out by design. */
const semantics = (result) => ({
  kind: result.kind, operation: result.operation, outcome: { status: result.outcome.status, messageId: result.outcome.messageId },
  effects: result.effects, why: result.why.map((entry) => [entry.code, entry.source]),
  warnings: result.warnings.map((entry) => entry.code), preserved: result.preserved.map((entry) => [entry.code, entry.scope]),
  next: result.next.map((action) => [action.id, action.kind, action.confirmation, action.executable, action.fallback?.command ?? null]),
  restState: result.restState, evidence: result.data?.evidenceHandle ?? null
});

const CORPUS = [
  { utterance: 'home' },
  { utterance: 'my work' },
  { utterance: 'explain this to me', arguments: { question: 'approvals' } },
  { utterance: 'pick up where I left off', arguments: { workId: 'WRK-1' } },
  { utterance: 'show repository history', arguments: { query: 'log', max: 5 } },
  { utterance: 'search this repository', arguments: { query: 'search', text: 'postal' } },
  { utterance: 'take me to the approval', arguments: { workId: 'WRK-2' } },
  { utterance: 'zzz nothing matches this' }
];

async function through(kernel, request) {
  const resolved = await kernel.resolve(request);
  const readable = resolved.kind === 'read' && /^rea_/.test(resolved.next[0]?.handle ?? '');
  return { resolved, read: readable ? await kernel.read({ resolutionId: resolved.next[0].handle }) : null };
}

test('hosts-share-semantics', { timeout: 300_000 }, async (t) => {
  const root = await fixture(t);
  if (!existsSync(runtime)) return t.skip('build apps/vscode/dist first (node apps/vscode/esbuild.mjs)');
  const editor = createRequire(import.meta.url)(runtime).gatewaySession({
    root, workspaceId: null, workspaceName: null, repositoryId: null, origin: 'test'
  });
  const mcp = mcpClient(root);
  t.after(() => mcp.close());
  const initialized = await mcp.start();
  assert.deepEqual((await mcp.call('tools/list', {})).result.tools.map((tool) => tool.name),
    ['sflow_resolve', 'sflow_read', 'sflow_next', 'sflow_run', 'sflow_explain']);
  assert.equal(initialized.protocolVersion, '2025-06-18');

  const remote = {
    resolve: (request) => mcp.tool('sflow_resolve', request),
    read: (request) => mcp.tool('sflow_read', request)
  };
  for (const request of CORPUS) {
    const [inEditor, overMcp] = [await through(editor.kernel, request), await through(remote, request)];
    assert.deepEqual(semantics(overMcp.resolved), semantics(inEditor.resolved), `resolve ${request.utterance}`);
    if (inEditor.read || overMcp.read) {
      assert.deepEqual(semantics(overMcp.read), semantics(inEditor.read), `read ${request.utterance}`);
    }
  }

  // Authority is identical too `[INT:AC-002]`: an approval over MCP is a ceremony destination, and
  // its handle runs nowhere.
  const approval = await mcp.tool('sflow_resolve', { utterance: 'take me to the approval', arguments: { workId: 'WRK-2' } });
  assert.deepEqual([approval.kind, approval.next[0].executable], ['ceremony', false]);
  assert.equal((await mcp.tool('sflow_run', { planId: approval.next[0].handle })).kind, 'refusal');
});

test('a plan over MCP is confirmed in the client UI, and refused where there is none', { timeout: 300_000 }, async (t) => {
  const root = await fixture(t);
  // A client with elicitation: the person types the subject; the model never sees the receipt.
  const confirming = mcpClient(root, { elicit: (params) => ({ action: 'accept', content: { confirm: params.requestedSchema.properties.confirm.type === 'boolean' ? true : 'WRK-1' } }) });
  t.after(() => confirming.close());
  await confirming.start();
  const planned = await confirming.tool('sflow_resolve', { utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'phase-changed' } });
  assert.equal(planned.kind, 'plan');
  const ran = await confirming.tool('sflow_run', { planId: planned.data.plan.handle });
  assert.equal(ran.outcome.status, 'succeeded', JSON.stringify(ran.why));
  assert.equal(confirming.elicitations.length, 1);
  assert.match(confirming.elicitations[0].message, /create watch/);
  assert.equal(JSON.stringify(ran).includes('rcp_'), false, 'a receipt reached the tool result');

  // A client without elicitation: the plan is readable, and running it is refused with nothing done.
  const blind = mcpClient(root, { elicitation: false });
  t.after(() => blind.close());
  await blind.start();
  const shown = await blind.tool('sflow_resolve', { utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'material-event' } });
  assert.equal(shown.kind, 'plan');
  const refused = await blind.tool('sflow_run', { planId: shown.data.plan.handle });
  assert.deepEqual([refused.kind, refused.why[0].code], ['refusal', 'gateway.confirmation-channel-unavailable']);
  assert.ok(Object.values(refused.effects).every((value) => value === false));
  // And a declined confirmation is a refusal too.
  const declining = mcpClient(root);
  t.after(() => declining.close());
  await declining.start();
  const offered = await declining.tool('sflow_resolve', { utterance: 'watch this', arguments: { subjectId: 'WRK-2', predicate: 'phase-changed' } });
  assert.equal((await declining.tool('sflow_run', { planId: offered.data.plan.handle })).why[0].code, 'gateway.confirmation-declined');
});

test('audit-is-useful-without-private-reasoning', { timeout: 300_000 }, async (t) => {
  // `[INT:AC-021]` `[INT:IFC-070]` `[INT:CON-140]` `[INT:REQ-140]`.
  const root = await fixture(t);
  const secret = 'customer-ssn-123-45-6789 private-marker';
  const client = mcpClient(root, { elicit: () => ({ action: 'accept', content: { confirm: true } }) });
  t.after(() => client.close());
  await client.start();
  await client.tool('sflow_resolve', { utterance: `home ${secret}` });
  const home = await client.tool('sflow_resolve', { utterance: 'home' });
  await client.tool('sflow_read', { resolutionId: home.next[0].handle });
  const planned = await client.tool('sflow_resolve', { utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'needs-my-decision' } });
  await client.tool('sflow_run', { planId: planned.data.plan.handle });
  await client.close();

  const events = await readGatewayEvents({ host: 'mcp' });
  assert.ok(events.length >= 5);
  for (const event of events) {
    for (const field of ['at', 'correlationId', 'tool', 'host', 'modelSelected', 'operation', 'kind', 'hashes', 'effects', 'outcome', 'durationMs']) {
      assert.ok(field in event, `${field} missing from a gateway event`);
    }
    assert.equal(event.modelSelected, true);
  }
  const text = JSON.stringify(events);
  assert.equal(text.includes('private-marker'), false, 'an utterance reached the audit log');
  assert.equal(text.includes('123-45-6789'), false);
  assert.equal(/rcp_[0-9a-f]{8}/.test(text), false, 'a receipt reached the audit log');
  const withIntent = events.find((event) => event.intent);
  assert.match(withIntent.intent.keyedHash, /^[0-9a-f]{64}$/);
  // The newest of each, since the earlier tests in this file wrote events to the same machine log.
  const run = events.filter((event) => event.tool === 'sflow_run').at(-1);
  assert.equal(run.operation, 'watch.create');
  assert.equal(run.effects.contextChanged, true);
  assert.equal(events.filter((event) => event.tool === 'sflow_resolve' && event.kind === 'plan').at(-1).planId, planned.data.plan.handle);
  // The local key behind the keyed hash is private to this machine.
  const keyFile = path.join(path.dirname(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE), 'gateway-intent.key');
  assert.ok((await readFile(keyFile, 'utf8')).trim().length > 20);
});

test('the stdio server answers malformed, batched and oversized input with JSON-RPC errors and keeps serving', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  let buffered = '';
  output.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffered.slice(0, at))); buffered = buffered.slice(at + 1); }
  });
  const served = serveMcp({ input, output, serverInfo: { name: 'sflow-test', version: '0' }, createKernel: async () => ({}) });
  const lines = [
    'null', '42', '"words"', 'true', '[]',
    JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
    JSON.stringify({ jsonrpc: '2.0', id: { nested: true }, method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 5 }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: null }),
    JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping', params: 'loose' }),
    // A response to nothing this server asked is dropped; answering a response would start a loop.
    JSON.stringify({ jsonrpc: '2.0', id: 'sflow-999', result: {} }),
    '{"jsonrpc":"2.0","id":6,',
    // One line far past the cap is refused as a whole, and the line after it still parses.
    `{"jsonrpc":"2.0","id":7,"method":"ping","params":{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}}`,
    JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' })
  ];
  for (const line of lines) input.write(`${line}\r\n`);
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }));
  await served;
  const codes = replies.map((reply) => [reply.id, reply.error?.code ?? 'ok']);
  assert.deepEqual(codes, [
    [null, -32600], [null, -32600], [null, -32600], [null, -32600], [null, -32600], [null, -32600], [null, -32600],
    [3, -32600], [4, -32600], [5, -32600], [null, -32700], [null, -32600], [8, 'ok'], [9, 'ok']
  ]);
  assert.match(replies[5].error.message, /batch/i);
  assert.match(replies[11].error.message, /too large/i);
  assert.ok(replies.every((reply) => reply.jsonrpc === '2.0'));
});
