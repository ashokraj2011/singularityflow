/**
 * The tool answers /sf-docs and /sf-help read, held to their CLI JSON.
 *
 * Each of those skills now names a gateway tool call beside its CLI command (the generated
 * `sflow-gateway-tools` clause picks one). That is only honest if the two answer alike, so these
 * tests drive the calls the skills name through the MCP tool layer and compare them, field by
 * field, with what the CLI command prints:
 *
 * - `sflow_explain` (and `sflow_read` of its further parts) serves `explain --json`'s exact
 *   `data.served.text`, at the CLI's 16,384-byte bound, in parts that each fit one tool answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { DEFAULT_AGENT_OUTPUT_BYTES } from '../src/agent-output.mjs';
import { DOCS_DEFAULT_PREVIEW_BYTES, loadTopics, TOPICS_DIRECTORY } from '../src/docs-topics.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { serveMcp } from '../src/gateway/mcp-stdio.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { EXPLAIN_PREVIEW_BYTES } from '../src/gateway/planners/help-explain.mjs';
import { TOOL_ANSWER_MAX_BYTES, validateSflowResult } from '../src/gateway/result.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { CLI } from './helpers/submitted-planning-story.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Copilot's side of an MCP session: each call goes through the server's own tool dispatch. */
async function mcp(createKernel, calls) {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffered = '';
  let next = 1;
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
    const id = next++;
    pending.set(id, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const served = serveMcp({ input, output, serverInfo: { name: 'sflow-test', version: '0' }, createKernel });
  await request('initialize', {});
  const tool = async (name, args) => {
    const reply = await request('tools/call', { name, arguments: args });
    // What the model reads is the text content; it is the measured answer.
    sizes.push(Buffer.byteLength(reply.result.content[0].text, 'utf8'));
    return validateSflowResult(reply.result.structuredContent);
  };
  try { return { value: await calls(tool), sizes }; } finally { input.end(); await served; }
}

/** The /sf-docs and /sf-help read: `sflow_explain`, then `sflow_read` every further part together. */
async function explainThroughTools(tool, question) {
  const first = await tool('sflow_explain', { question });
  if (first.kind !== 'read') return { first, parts: [] };
  const rest = await Promise.all((first.data.part.read ?? []).map((handle) => tool('sflow_read', { resolutionId: handle })));
  return { first, parts: [first, ...rest] };
}

function cliJson(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', timeout: childTimeout(120_000), env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  return { status: result.status, json: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

test('one tool answer holds what the CLI\'s agent view holds, for the same host rule', () => {
  assert.equal(TOOL_ANSWER_MAX_BYTES, DEFAULT_AGENT_OUTPUT_BYTES);
  // The tool serves the CLI's own bound, from the CLI's own constant.
  assert.equal(EXPLAIN_PREVIEW_BYTES, DOCS_DEFAULT_PREVIEW_BYTES);
});

test('sflow_explain serves explain --json\'s exact text, every part inside one tool answer', async () => {
  const { kernel } = createHostGateway({ root: null, hostSessionId: 'skill-reads-docs', planners: gatewayPlanners() });
  const topics = await loadTopics(TOPICS_DIRECTORY);
  const parts = new Map();
  const { sizes } = await mcp(async () => kernel, async (tool) => {
    for (const topic of topics) {
      const { first, parts: answers } = await explainThroughTools(tool, topic.id);
      assert.deepEqual([first.kind, first.operation.id, first.data.topic], ['read', 'help.explain', topic.id], topic.id);
      assert.equal(first.data.part.read?.length ?? 0, first.data.part.count - 1, `${topic.id}: one handle per further part`);
      assert.deepEqual(answers.map((answer) => answer.data.part.index), answers.map((_, index) => index + 1), topic.id);
      parts.set(topic.id, answers);
    }
  });
  // Nothing a model reads from these tools is long enough for either host to move out of line.
  assert.ok(Math.max(...sizes) <= TOOL_ANSWER_MAX_BYTES, `largest answer ${Math.max(...sizes)} bytes`);
  assert.ok([...parts.values()].some((answers) => answers.length > 1), 'long topics come in parts');

  // Field by field against the CLI, for a short topic, a long one and one past the served bound.
  const byLength = [...topics].sort((left, right) => left.body.length - right.body.length);
  for (const topic of [byLength[0], byLength[Math.floor(byLength.length / 2)], byLength.at(-1)]) {
    const cli = cliJson(process.cwd(), ['explain', topic.id, '--json']);
    assert.equal(cli.status, 0, cli.stderr);
    const answers = parts.get(topic.id);
    const [first] = answers;
    assert.equal(answers.map((answer) => answer.data.body).join(''), cli.json.data.served.text, topic.id);
    assert.deepEqual([first.data.bytes, first.data.bodySha256, first.data.truncated, first.data.expandHandle],
      [cli.json.data.served.bytes, cli.json.data.served.sha256, cli.json.data.served.truncated, cli.json.data.served.handle], topic.id);
    for (const answer of answers) assert.deepEqual([answer.data.bodySha256, answer.data.citation], [cli.json.data.served.sha256, cli.json.data.citation]);
    assert.deepEqual([first.data.citation, first.data.helpIntent, first.data.matchedBy],
      [cli.json.data.citation, cli.json.data.helpIntent, cli.json.data.resolvedBy], topic.id);
    assert.deepEqual(first.data.provenance, cli.json.data.provenance, topic.id);
    // Related topics are the next actions on both, each with the CLI's own route.
    assert.deepEqual(first.next.map((action) => [action.topic, action.fallback.command]),
      cli.json.next.map((action) => [action.topic, action.fallback.command]), topic.id);
  }
  assert.ok(byLength.at(-1).body.length > DOCS_DEFAULT_PREVIEW_BYTES && parts.get(byLength.at(-1).id)[0].data.truncated,
    'the longest topic is past the served bound on both, and both say so');
});

test('a question the documentation cannot answer, or a choice, comes back as the CLI\'s', async () => {
  const { kernel } = createHostGateway({ root: null, hostSessionId: 'skill-reads-docs-ask', planners: gatewayPlanners() });
  for (const question of ['how do I file my taxes', 'work']) {
    const { value } = await mcp(async () => kernel, (tool) => tool('sflow_explain', { question }));
    const cli = cliJson(process.cwd(), ['explain', question, '--json']);
    assert.equal(cli.status, 2, 'a refusal is a refusal at the shell too');
    assert.equal(value.kind, 'clarification');
    assert.equal(value.why[0].code, cli.json.why[0].code, question);
    // The host adds the reply name to every read it serves; the rest is the CLI's `data`.
    const { personalization: _name, ...data } = value.data;
    assert.deepEqual(data, cli.json.data, `${question}: the same query, candidates or nearest topics, and intent`);
  }
});
