/**
 * No tool answer longer than one tool result reaches the model (`TOOL_ANSWER_MAX_BYTES`).
 *
 * Both Copilot hosts move a longer result out of the conversation, where a skill turn cannot read
 * it, so both ask `boundedToolAnswer` (host.mjs) last: an answer that fits is the kernel's as it
 * is, one that does not is sent as its tool view, and one that still does not fit is refused, so
 * the skill runs its CLI command, whose agent view is bounded. Whole, the read /sf-recommend,
 * /sf-home and /sf-advise make is about 15 KB on an approved Story; its view keeps every field
 * those steps report.
 *
 * Also held here: a host's own model mode names the routes an in-process read offers when no CLI
 * run serves it (VS Code's `singularityFlow.modelMode`; vscode-host.test.mjs drives the setting).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { boundedToolAnswer, createHostGateway } from '../src/gateway/host.mjs';
import { serveMcp } from '../src/gateway/mcp-stdio.mjs';
import { message } from '../src/gateway/messages.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { noEffects, sflowResult, TOOL_ANSWER_MAX_BYTES, validateSflowResult } from '../src/gateway/result.mjs';
import { approvedSpecificationStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'HEX-4103';
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function action(index, extra = {}) {
  return { handle: `rea_${String(index).padStart(32, '0')}`, id: `test:action-${index}`, label: `Action ${index}`, kind: 'read',
    reasonCode: 'home.work-summary', confirmation: 'none', interaction: 'navigation', emphasis: 'secondary',
    slots: { work: 'HEX-1', note: 'x'.repeat(120) }, effect: { summaryMessageId: 'home.work-summary', target: 'status' },
    fallback: { label: `Action ${index}`, command: 'singularity-flow status', skill: '/sf-status', copilotCommand: '/sf-status', copyable: true },
    ...extra };
}

function answer({ operationId = 'work.list', next = [], data = {}, effects = noEffects() } = {}) {
  return sflowResult({
    kind: 'read', operation: { id: operationId, classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: {} }, effects,
    why: [{ code: 'work.from-governed-records', source: 'lifecycle', reference: null, slots: {} }],
    next, restState: 'informational', data
  });
}

test('an answer that fits is the kernel\'s as it is; a run, and an answer that records an effect, are never cut', () => {
  const small = answer({ next: [action(1)] });
  assert.equal(boundedToolAnswer('sflow_read', small), small);
  const large = answer({ data: { text: 'x'.repeat(TOOL_ANSWER_MAX_BYTES) } });
  assert.equal(boundedToolAnswer('sflow_run', large), large);
  const changed = answer({ data: large.data, effects: { ...noEffects(), stateChanged: true } });
  assert.equal(boundedToolAnswer('sflow_read', changed), changed);
});

test('too long even as its view, an answer is refused with its size, and the refusal fits', () => {
  const large = answer({ data: { text: 'x'.repeat(TOOL_ANSWER_MAX_BYTES) } });
  const refused = validateSflowResult(boundedToolAnswer('sflow_read', large));
  assert.deepEqual([refused.kind, refused.operation.id, refused.restState], ['refusal', 'work.list', 'blocked']);
  assert.equal(refused.why[0].code, 'gateway.tool-answer-too-long');
  assert.equal(refused.why[0].slots.limit, String(TOOL_ANSWER_MAX_BYTES));
  assert.ok(Number(refused.why[0].slots.bytes) > TOOL_ANSWER_MAX_BYTES);
  assert.deepEqual(refused.effects, noEffects());
  assert.ok(bytes(refused) <= TOOL_ANSWER_MAX_BYTES);
  assert.match(message('gateway.tool-answer-too-long', refused.why[0].slots).detail, /^It is \d+ bytes and a tool answer holds 7500; run this step's CLI command/u);
});

test('a next action keeps what a model follows and stays a valid one; what only a card draws is left out', () => {
  const next = Array.from({ length: 18 }, (_, index) => action(index));
  const whole = answer({ next });
  assert.ok(bytes(whole) > TOOL_ANSWER_MAX_BYTES);
  const view = boundedToolAnswer('sflow_next', whole);
  assert.equal(validateSflowResult(view).kind, 'read');
  assert.ok(bytes(view) <= TOOL_ANSWER_MAX_BYTES);
  assert.deepEqual(view.next.map((entry) => entry.handle), whole.next.map((entry) => entry.handle));
  for (const entry of view.next) {
    assert.deepEqual(Object.keys(entry), ['handle', 'id', 'label', 'kind', 'reasonCode', 'confirmation', 'interaction', 'emphasis', 'fallback']);
    assert.deepEqual(entry.fallback, { label: entry.label, command: 'singularity-flow status', skill: '/sf-status', copilotCommand: '/sf-status' });
  }
});

/** The two-call read the switched skills name, through the MCP tool layer; also every answer's size. */
async function throughMcp(kernel, utterances) {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffered = '';
  let id = 0;
  const pending = new Map();
  const sizes = [];
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
    pending.set(++id, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const served = serveMcp({ input, output, serverInfo: { name: 'sflow-test', version: '0' }, createKernel: async () => kernel });
  await request('initialize', {});
  const tool = async (name, args) => {
    const reply = await request('tools/call', { name, arguments: args });
    sizes.push(Buffer.byteLength(reply.result.content[0].text, 'utf8'));
    // What the model reads is the text; it is still a valid result.
    return validateSflowResult(JSON.parse(reply.result.content[0].text));
  };
  try {
    const answers = {};
    for (const utterance of utterances) {
      const resolved = await tool('sflow_resolve', { utterance });
      answers[utterance] = await tool('sflow_read', { resolutionId: resolved.next[0].handle });
    }
    // A choice the view offers is taken as the kernel offered it.
    const choice = answers[utterances[0]].next[1];
    answers.followed = await tool('sflow_resolve', { utterance: choice.label, selectionHandle: choice.handle });
    return { answers, sizes };
  } finally { input.end(); await served; }
}

test('on an approved Story the recommendation and Home fit one tool answer, with every field the skills report', { timeout: 300_000 }, async (t) => {
  const { root } = await approvedSpecificationStory(t, WORK);
  const { kernel } = createHostGateway({ root, hostSessionId: 'tool-bound-mcp', planners: gatewayPlanners() });
  const read = async (utterance) => kernel.read({ resolutionId: (await kernel.resolve({ utterance })).next[0].handle });
  const whole = await read('what should I do next');
  const wholeHome = await read('home');
  // The case this exists for: whole, neither fits.
  assert.ok(bytes(whole) > TOOL_ANSWER_MAX_BYTES && bytes(wholeHome) > TOOL_ANSWER_MAX_BYTES, `${bytes(whole)}, ${bytes(wholeHome)}`);

  const { answers, sizes } = await throughMcp(kernel, ['what should I do next', 'home']);
  assert.ok(Math.max(...sizes) <= TOOL_ANSWER_MAX_BYTES, `largest answer ${Math.max(...sizes)} bytes`);
  const next = answers['what should I do next'];
  assert.deepEqual([next.kind, next.operation.id], ['read', 'developer.next']);

  // /sf-recommend and /sf-advise: the guidance, reply name and the recommendation, as the kernel made them.
  const { guidance } = next.data;
  for (const field of ['state', 'workId', 'currentPhase', 'recommendation', 'evidence', 'preflight', 'requiredInputs', 'unavailableReason']) {
    assert.deepEqual(guidance[field], whole.data.guidance[field], `data.guidance.${field}`);
  }
  assert.deepEqual(next.data.personalization, whole.data.personalization);
  // Steps a person can take from here, each with its three routes; the rest counted and named.
  const actionable = whole.data.guidance.actions.filter((entry) => ['now', 'blocked', 'alternative'].includes(entry.timing));
  assert.ok(actionable.some((entry) => entry.timing === 'now'));
  assert.deepEqual(guidance.actions.map((entry) => [entry.timing, entry.command, entry.copilotCommand, entry.modelFreeCommand, entry.reason]),
    actionable.map((entry) => [entry.timing, entry.command, entry.copilotCommand, entry.modelFreeCommand, entry.reason]));
  assert.ok(guidance.actions.every((entry) => !('argv' in entry) && !('platformCommands' in entry)));
  assert.deepEqual(guidance.moreActions, { count: whole.data.guidance.actions.length - actionable.length, read: '/sf-nextsteps' });

  // The primary and secondary actions keep their handles and routes; a handle from the view is followed.
  // A handle is issued per read, so the two reads share ids and labels, each with handles of its own.
  assert.deepEqual(next.next.map((entry) => [entry.id, entry.label]), whole.next.map((entry) => [entry.id, entry.label]));
  assert.ok(next.next.every((entry) => /^sel_/u.test(entry.handle)));
  assert.deepEqual(next.next.map((entry) => entry.fallback.command), whole.next.map((entry) => entry.fallback.command));
  assert.equal(next.next[0].fallback.command, guidance.recommendation.command);
  assert.notEqual(answers.followed.kind, 'refusal', JSON.stringify(answers.followed.why));

  // /sf-home: its `data.home` fields are the view's `data`, as the kernel made them.
  for (const field of ['workspace', 'repository', 'currentWork', 'attentionWork', 'personalization', 'today', 'yesterday', 'counts']) {
    assert.deepEqual(next.data[field], whole.data[field], `data.${field}`);
  }
  assert.deepEqual(next.data.toolView, { leftOut: ['data.latestReceipt', 'data.rail'], whole: 'singularity-flow recommend --json' });

  const home = answers.home;
  assert.deepEqual([home.kind, home.operation.id], ['read', 'home.overview']);
  assert.deepEqual(Object.keys(home.data.homeProjection), ['resultType', 'schemaVersion', 'asOf', 'sources', 'health']);
  assert.deepEqual(home.data.homeProjection.sources, wholeHome.data.homeProjection.sources);
  assert.equal(home.data.toolView.whole, 'singularity-flow home --json');

  await t.test('a host\'s model mode names the routes a read offers when no CLI run serves it', async () => {
    const routes = async (routeModelMode) => {
      const host = createHostGateway({ root, hostSessionId: `tool-bound-mode-${routeModelMode().enabled}`, planners: gatewayPlanners(), routeModelMode });
      // The whole read lists every step to the end of the workflow, the publication route among them.
      const resolved = await host.kernel.resolve({ utterance: 'what should I do next' });
      return JSON.stringify((await host.kernel.read({ resolutionId: resolved.next[0].handle })).data.guidance.actions);
    };
    const off = await routes(() => ({ enabled: false, source: 'environment' }));
    const on = await routes(() => ({ enabled: true, source: 'default' }));
    assert.match(on, /--authored governed-agent --channel copilot-host/u);
    assert.doesNotMatch(on, /--no-model/u);
    assert.match(off, /--no-model/u);
    assert.doesNotMatch(off, /--authored governed-agent/u);
  });
});
