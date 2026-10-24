/**
 * A paused SFlow answers the five model-facing tools before the kernel. `[pause]`
 *
 * `singularity-flow pause on` turns SFlow's Copilot guidance off on this machine: every CLI read
 * entry checks it before Git, and a paused skill answers as native Copilot. The five gateway tools
 * are the same guidance by another door, so a read skill that answers through them must not walk
 * around the pause. Both model-facing hosts make one shared check first (`pausedToolAnswer` in
 * src/gateway/host.mjs): `gateway serve` in its tool dispatch, VS Code's language-model tools
 * through their gateway session (vscode-host.test.mjs holds that host).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { setCopilotPaused } from '../src/copilot-mode.mjs';
import { createHostGateway, pausedToolAnswer } from '../src/gateway/host.mjs';
import { serveMcp } from '../src/gateway/mcp-stdio.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { SFLOW_TOOL_NAMES } from '../src/gateway/tools.mjs';

/** This test's own pause preference, never the machine's. */
async function isolatedMode(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sflow-tool-pause-'));
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'copilot-mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
}

/** One MCP session; `calls` gets each tool call as Copilot makes it, through the server's dispatch. */
async function mcp(createKernel, calls) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map();
  let buffered = '';
  let next = 1;
  output.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      pending.get(reply.id)?.(reply);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const served = serveMcp({ input, output, serverInfo: { name: 'sflow-test', version: '0' }, createKernel });
  await request('initialize', {});
  const tool = async (name, args) => validateSflowResult((await request('tools/call', { name, arguments: args })).result.structuredContent);
  try { return await calls(tool); } finally { input.end(); await served; }
}

const CALLS = Object.freeze({
  sflow_resolve: { utterance: 'what should I do next' }, sflow_read: { resolutionId: 'rea_x' },
  sflow_next: { scope: 'home' }, sflow_run: { planId: 'pln_x' }, sflow_explain: { question: 'why is my Story blocked?' }
});

test('the shared check: nothing while guidance is on, the paused answer for each of the five while it is off', async (t) => {
  await isolatedMode(t);
  for (const name of SFLOW_TOOL_NAMES) assert.equal(pausedToolAnswer(name), null, name);
  await setCopilotPaused(true);
  for (const name of SFLOW_TOOL_NAMES) {
    const paused = validateSflowResult(pausedToolAnswer(name));
    assert.deepEqual([paused.kind, paused.outcome.status, paused.why[0].code, paused.restState],
      ['refusal', 'refused', 'gateway.copilot-paused', 'blocked'], name);
    assert.ok(Object.values(paused.effects).every((value) => value === false));
    assert.deepEqual(paused.preserved.map((entry) => [entry.code, entry.scope]), [['gateway.nothing-was-carried-out', 'all']]);
    // What a paused skill already does with `pause status`: answer as native Copilot, offer only /sf-pause off.
    assert.deepEqual([paused.data.paused, paused.data.nativeCopilot], [true, true]);
    assert.match(paused.data.agentInstruction, /answer as native Copilot/u);
    assert.match(paused.data.agentInstruction, /only offer `\/sf-pause off`; never resume implicitly/u);
    assert.deepEqual({ ...paused.data.commandGuidance }, { command: 'singularity-flow pause off --json', copilotCommand: '/sf-pause off' });
  }
  assert.deepEqual(SFLOW_TOOL_NAMES.map((name) => pausedToolAnswer(name).operation.id),
    ['gateway.resolve', 'gateway.read', 'gateway.next', 'gateway.run', 'help.explain']);
});

test('over MCP a paused SFlow never reaches the kernel, and the same session answers once it is resumed', async (t) => {
  await isolatedMode(t);
  // A kernel that fails loudly if anything reaches it while paused.
  const asked = [];
  const tripwire = new Proxy({}, { get: (_target, method) => method === 'then' ? undefined
    : () => { asked.push(String(method)); throw new Error(`kernel.${String(method)} called while paused`); } });
  await setCopilotPaused(true);
  const refused = await mcp(async () => tripwire, (tool) => Promise.all(SFLOW_TOOL_NAMES.map((name) => tool(name, CALLS[name]))));
  assert.deepEqual(refused.map((answer) => answer.why[0].code), Array(5).fill('gateway.copilot-paused'));
  assert.deepEqual(asked, []);

  // One live session across `/sf-pause` and `/sf-pause off`: paused, answered, paused again.
  const { kernel } = createHostGateway({ root: null, hostSessionId: 'tool-pause-live', planners: gatewayPlanners() });
  await setCopilotPaused(false);
  await mcp(async () => kernel, async (tool) => {
    assert.equal((await tool('sflow_explain', { question: 'approvals', topic: 'approvals' })).why[0].code, 'explain.cited');
    await setCopilotPaused(true);
    assert.equal((await tool('sflow_explain', { question: 'approvals', topic: 'approvals' })).why[0].code, 'gateway.copilot-paused');
    assert.equal((await tool('sflow_resolve', { utterance: 'home' })).why[0].code, 'gateway.copilot-paused');
    await setCopilotPaused(false);
    const resolved = await tool('sflow_resolve', { utterance: 'home' });
    assert.deepEqual([resolved.kind, resolved.operation.id], ['read', 'home.overview']);
  });
});

test('an unreadable pause preference pauses the tools, as it pauses every other SFlow entry', async (t) => {
  await isolatedMode(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE, 'not json');
  const paused = pausedToolAnswer('sflow_next');
  assert.equal(paused.why[0].code, 'gateway.copilot-paused');
  assert.equal(paused.data.stateAvailable, false);
});
