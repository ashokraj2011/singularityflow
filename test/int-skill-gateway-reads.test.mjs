/**
 * The tool answers /sf-docs, /sf-help, /sf-progress and /sf-nextsteps read, held to their CLI JSON.
 *
 * Each of those skills now names a gateway tool call beside its CLI command (the generated
 * `sflow-gateway-tools` clause picks one). That is only honest if the two answer alike, so these
 * tests drive the calls the skills name through the MCP tool layer and compare them, field by
 * field, with what the CLI command prints:
 *
 * - `sflow_explain` (and `sflow_read` of its further parts) serves `explain --json`'s exact
 *   `data.served.text`, at the CLI's 16,384-byte bound, in parts that each fit one tool answer.
 * - `sflow_resolve` "show story progress" then `sflow_read` is `progress --json`.
 * - `sflow_resolve` "show story next steps" then `sflow_read` is `nextsteps --json` through the
 *   agent entry's own rule (`nextsteps --for-agent`): `contextBoundary`, the one pending list and
 *   the ordered actions, with the governed agent's routes when the model is on.
 *
 * /sf-status stays on its CLI read: its answer is the whole Story record (tens of kilobytes), and
 * no tool answer that size reaches the model whole (see `TOOL_ANSWER_MAX_BYTES`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { DEFAULT_AGENT_OUTPUT_BYTES, completeAgentResult } from '../src/agent-output.mjs';
import { agentPacketPresentation } from '../src/agent-packet-presentation.mjs';
import { agentNextSteps, agentNextStepsView } from '../src/commands/nextsteps.mjs';
import { DOCS_DEFAULT_PREVIEW_BYTES, loadTopics, TOPICS_DIRECTORY } from '../src/docs-topics.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { serveMcp } from '../src/gateway/mcp-stdio.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { EXPLAIN_PREVIEW_BYTES } from '../src/gateway/planners/help-explain.mjs';
import { TOOL_ANSWER_MAX_BYTES, validateSflowResult } from '../src/gateway/result.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { CLI, approvedSpecificationStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'HEX-4101';
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
  // A shell result is cut sooner by older terminals, so the CLI's view is at most 4 KB; a tool answer
  // keeps the hosts' 8,192-character rule. Either fits in one tool answer.
  assert.ok(DEFAULT_AGENT_OUTPUT_BYTES <= TOOL_ANSWER_MAX_BYTES);
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

// The first `now` action, repeated in `taskResume`, took a plain nextsteps answer over the tool limit (4f7fe7329).
test('the agent view says the next step once, and keeps a different one the resume state names', () => {
  const now = { timing: 'now', command: 'singularity-flow prepare planning' };
  const view = (nextAction) => agentNextStepsView({ workId: 'W', actions: [now], taskResume: { operationId: 'WT-1', nextAction } }).taskResume;
  assert.deepEqual(view({ ...now }), { operationId: 'WT-1' });
  const inspect = { timing: 'now', command: 'singularity-flow phase draft-check planning' };
  assert.deepEqual(view(inspect), { operationId: 'WT-1', nextAction: inspect }, 'an interrupted operation is inspected first');
  assert.equal(agentNextStepsView({ workId: 'W', actions: [now] }).taskResume, undefined);
});

test('/sf-progress and /sf-nextsteps read their CLI JSON through the tools, field by field', async (t) => {
  const { root } = await approvedSpecificationStory(t, WORK);
  const { kernel } = createHostGateway({ root, hostSessionId: 'skill-reads-story', planners: gatewayPlanners() });
  const registry = gatewayRegistry();
  const phraseOf = (id) => registry.operations.find((entry) => entry.id === id).gateway.aliases.en.phrases[0];
  assert.deepEqual([phraseOf('work.progress'), phraseOf('work.nextsteps')], ['show story progress', 'show story next steps'],
    'the utterances the skills name are the operations\' own registered phrases');

  // The two calls the switched steps name, with and without the Work ID.
  const read = (tool, utterance, workId) => tool('sflow_resolve', { utterance, ...(workId ? { arguments: { workId } } : {}) })
    .then((resolved) => {
      assert.deepEqual([resolved.kind, resolved.next.length], ['read', 1], utterance);
      assert.match(resolved.next[0].handle, /^rea_/u);
      return tool('sflow_read', { resolutionId: resolved.next[0].handle });
    });
  const { value: answers, sizes } = await mcp(async () => kernel, async (tool) => ({
    progress: await read(tool, 'show story progress', WORK),
    progressHere: await read(tool, 'show story progress'),
    nextsteps: await read(tool, 'show story next steps', WORK),
    nextstepsHere: await read(tool, 'show story next steps')
  }));
  assert.ok(Math.max(...sizes) <= TOOL_ANSWER_MAX_BYTES, `largest answer ${Math.max(...sizes)} bytes`);
  const { personalization: _p1, ...progress } = answers.progress.data;
  const { personalization: _p2, ...nextsteps } = answers.nextsteps.data;
  assert.deepEqual([answers.progress.operation.id, answers.nextsteps.operation.id], ['work.progress', 'work.nextsteps']);

  // progress: the CLI's JSON exactly, and with no ID the Story checked out here, as the command picks.
  const cliProgress = cliJson(root, ['progress', WORK, '--json']);
  assert.equal(cliProgress.status, 0, cliProgress.stderr);
  assert.deepEqual(progress, cliProgress.json);
  const { personalization: _p3, ...progressHere } = answers.progressHere.data;
  assert.deepEqual(progressHere, cliJson(root, ['progress', '--json']).json);
  for (const field of ['workType', 'currentPhase', 'percentage', 'approvedPhases', 'totalPhases', 'tokens', 'phases']) {
    assert.ok(Object.hasOwn(progress, field), field);
  }

  // nextsteps: `nextsteps --json` (model on) seen through the agent entry's rule and presentation.
  // `repositoryChecks` reports how old this process's cached check is, so it is compared by what it
  // names, not by its age.
  const cliNext = cliJson(root, ['nextsteps', WORK, '--json']);
  assert.equal(cliNext.status, 0, cliNext.stderr);
  assert.equal(cliNext.json.modelMode, 'auto');
  const checks = ({ repositoryChecks, ...rest }) => [rest, [repositoryChecks?.scope, repositoryChecks?.mode, repositoryChecks?.refresh]];
  const asAgent = agentPacketPresentation(agentNextStepsView(agentNextSteps(cliNext.json)));
  assert.deepEqual(checks(nextsteps), checks(asAgent));
  assert.ok(nextsteps.contextBoundary?.commands?.length, 'the chat reset the skill reads first');
  assert.deepEqual(nextsteps.contextBoundary, agentPacketPresentation(cliNext.json.contextBoundary));
  assert.deepEqual(nextsteps.pending, agentPacketPresentation(cliNext.json.pending), 'the one pending list (SPEC-OAP M3)');
  assert.ok(nextsteps.actions.length && nextsteps.actions.every((action) => action.timing !== 'then'));
  // Model on, the governed agent's route, never the model-free one the planner's own mode implies.
  assert.ok(cliNext.json.actions.some((action) => /--authored governed-agent --channel copilot-host/u.test(action.command)));
  assert.equal(JSON.stringify(nextsteps).includes('--no-model'), false);
  const { personalization: _p4, ...nextstepsHere } = answers.nextstepsHere.data;
  assert.deepEqual(checks(nextstepsHere), checks(nextsteps), 'with no ID, the Story checked out here');

  // The skill's own CLI read lists the same actions in the same order, with the same boundary and list.
  const entry = cliJson(root, ['nextsteps', WORK, '--utility-entry', '--for-agent', '--json']);
  assert.equal(entry.status, 0, entry.stderr);
  const agent = completeAgentResult(entry.json).data;
  // The agent view adds `--for-agent` to SFlow routes that take it; everything else is the same.
  const plain = (value) => JSON.parse(JSON.stringify(value ?? null).replaceAll(' --for-agent', ''));
  assert.deepEqual(plain(nextsteps.actions), plain(agent.actions));
  for (const field of Object.keys(nextsteps).filter((key) => key !== 'repositoryChecks')) {
    assert.deepEqual(plain(nextsteps[field]), plain(agent[field]), field);
  }
});

test('a Story read too long for one tool answer is refused, and the refusal names the CLI read', async () => {
  const { workProgress } = await import('../src/gateway/planners/developer-next.mjs');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-skill-reads-long-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'LONG-1', directory]);
    const item = path.join(directory, 'singularity', 'work-items', 'LONG-1');
    await mkdir(item, { recursive: true });
    const phaseOrder = Array.from({ length: 60 }, (_, index) => `phase-${index + 1}`);
    await writeFile(path.join(item, 'workflow.json'), JSON.stringify({
      workItem: { id: 'LONG-1', title: 'Long', workType: 'feature', branch: 'LONG-1' }, status: 'in_progress',
      phaseOrder, currentPhase: phaseOrder[0],
      phases: Object.fromEntries(phaseOrder.map((id) => [id, { id, label: `A long label for ${id}`, status: 'not_started', generation: 0,
        approvals: [], approvalPolicy: { minimum: 1 } }])),
      history: []
    }));
    spawnSync('git', ['-C', directory, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'add', '-A']);
    spawnSync('git', ['-C', directory, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-qm', 'long']);
    const answer = await workProgress({ arguments: { workId: 'LONG-1' }, root: directory });
    assert.equal(answer.kind, 'refusal');
    assert.equal(answer.why[0].code, 'gateway.answer-too-long');
    assert.equal(answer.why[0].slots.command, 'singularity-flow progress LONG-1 --utility-entry --for-agent --json');
    assert.ok(Number(answer.why[0].slots.bytes) > TOOL_ANSWER_MAX_BYTES);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
