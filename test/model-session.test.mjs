/**
 * Model sessions: several prompts share one provider process and conversation, so Copilot reads the
 * session's earlier text from its cache instead of each prompt paying for its own ~11,400-token
 * session. Each prompt is still audited and checked as its own invocation.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createModelSession, invokeModel, listModelInvocationAudits, listModelInvocations } from '../src/model-runner.mjs';
import { acpTurnUsage } from '../src/model-providers/copilot-cli.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { run } from '../src/util.mjs';

// A Copilot stand-in over ACP: it logs each process start, counts the prompts its session has seen,
// and reports usage as running totals the way Copilot does. A prompt containing FAIL is refused.
const FAKE_ACP = `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], 'start ' + process.pid + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let prompts = 0; let input = 0; let output = 0; let cachedRead = 0; let cachedWrite = 0;
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'shared', configOptions: [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'auto', options: [] }] } });
  else if (message.method === 'session/prompt') {
    prompts += 1;
    const text = message.params.prompt[0].text;
    input += 1000 + text.length; output += 3; cachedWrite += 1000; if (prompts > 1) cachedRead += 1000;
    const usage = { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedReadTokens: cachedRead, cachedWriteTokens: cachedWrite };
    if (text.includes('FAIL')) { send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'refusal', usage } }); continue; }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'shared', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm' + prompts, content: { type: 'text', text: 'prompt ' + prompts + ' of this session' } } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', usage } });
  }
}
`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  const agent = path.join(root, 'fake-acp.mjs');
  const starts = path.join(root, 'starts.log');
  await writeFile(agent, FAKE_ACP);
  await writeFile(starts, '');
  const request = (text, overrides = {}) => ({
    provider: 'copilot-cli',
    providerConfig: { executable: process.execPath, arguments: [agent, starts], promptTransport: 'acp-stdio' },
    cwd: root, allowedRoots: [root], auditRoot: root, channel: 'test', prompt: { text },
    tools: { mode: 'none', names: [] }, limits: { timeoutMs: 10000, outputBytes: 64 * 1024 },
    ...overrides
  });
  const inContext = (work) => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, work);
  const processes = async () => (await readFile(starts, 'utf8')).split('\n').filter(Boolean).length;
  return { root, request, inContext, processes };
}

test('a turn\'s usage is the difference from the previous turn, since Copilot reports running totals', () => {
  assert.deepEqual(acpTurnUsage(
    { inputTokens: 23210, outputTokens: 10, totalTokens: 23220, cachedReadTokens: 11580, cachedWriteTokens: 11624 },
    { inputTokens: 11583, outputTokens: 5, totalTokens: 11588, cachedReadTokens: 0, cachedWriteTokens: 11580 }
  ), { inputTokens: 11627, outputTokens: 5, totalTokens: 11632, cachedReadTokens: 11580, cachedWriteTokens: 44 });
  const alone = { inputTokens: 900, outputTokens: 4, totalTokens: 904 };
  assert.deepEqual(acpTurnUsage(alone, { inputTokens: 11583, outputTokens: 5, totalTokens: 11588 }), alone, 'a figure that went down was this turn alone');
  assert.equal(acpTurnUsage(alone, null), alone);
});

test('prompts in one session share one provider process and conversation, each audited as its own turn', async (t) => {
  const { root, request, inContext, processes } = await fixture(t);
  const session = createModelSession();
  let first; let second;
  try {
    first = await inContext(() => invokeModel(request('first prompt', { session })));
    second = await inContext(() => invokeModel(request('second prompt', { session })));
  } finally {
    await session.close();
  }
  assert.equal(first.output, 'prompt 1 of this session');
  assert.equal(second.output, 'prompt 2 of this session', 'the second prompt continued the same conversation');
  assert.equal(await processes(), 1, 'one provider process for both prompts');
  assert.deepEqual([first.usage.inputTokens, second.usage.inputTokens], [1000 + 'first prompt'.length, 1000 + 'second prompt'.length], 'each turn records its own tokens');
  assert.equal(second.usage.cachedInputTokens, 1000);
  const audits = (await listModelInvocations(root)).sort((a, b) => a.session.turn - b.session.turn);
  assert.deepEqual(audits.map((audit) => [audit.status, audit.session.id, audit.session.turn]), [['completed', session.id, 1], ['completed', session.id, 2]]);
  assert.equal(session.turns, 2);
  assert.equal(session.closed, true);
});

test('without a session every prompt starts its own provider process', async (t) => {
  const { request, inContext, processes } = await fixture(t);
  const first = await inContext(() => invokeModel(request('first prompt')));
  const second = await inContext(() => invokeModel(request('second prompt')));
  assert.deepEqual([first.output, second.output], ['prompt 1 of this session', 'prompt 1 of this session']);
  assert.equal(await processes(), 2);
});

test('a prompt with another folder or tool policy, or past the turn limit, is refused before anything is recorded', async (t) => {
  const { root, request, inContext } = await fixture(t);
  const session = createModelSession({ maxTurns: 2 });
  try {
    await inContext(() => invokeModel(request('first prompt', { session })));
    await assert.rejects(() => inContext(() => invokeModel(request('read files', { session, tools: { mode: 'allowlist', names: ['read_file'] } }))),
      { code: 'MODEL_SESSION_INCOMPATIBLE' });
    await inContext(() => invokeModel(request('second prompt', { session })));
    await assert.rejects(() => inContext(() => invokeModel(request('third prompt', { session }))), { code: 'MODEL_SESSION_TURN_LIMIT' });
  } finally {
    await session.close();
  }
  assert.equal((await listModelInvocations(root)).length, 2, 'refused prompts leave no invocation record');
  await assert.rejects(() => inContext(() => invokeModel(request('after close', { session }))), { code: 'MODEL_SESSION_CLOSED' });
  assert.throws(() => createModelSession({ maxTurns: 0 }), { code: 'MODEL_REQUEST_INVALID' });
  await assert.rejects(() => inContext(() => invokeModel(request('forged', { session: { id: 'x' } }))), { code: 'MODEL_REQUEST_INVALID' });
});

test('a failed prompt ends the session, so the next prompt starts over in a new one', async (t) => {
  const { root, request, inContext, processes } = await fixture(t);
  const session = createModelSession();
  await inContext(() => invokeModel(request('first prompt', { session })));
  await assert.rejects(() => inContext(() => invokeModel(request('please FAIL', { session }))), { code: 'MODEL_PROVIDER_FAILED' });
  assert.equal(session.closed, true);
  await assert.rejects(() => inContext(() => invokeModel(request('after failure', { session }))), { code: 'MODEL_SESSION_CLOSED' });
  const fresh = createModelSession();
  try {
    const retried = await inContext(() => invokeModel(request('retry', { session: fresh })));
    assert.equal(retried.output, 'prompt 1 of this session');
  } finally {
    await fresh.close();
  }
  assert.equal(await processes(), 2);
  const statuses = (await listModelInvocationAudits(root)).map((audit) => audit.status).sort();
  assert.deepEqual(statuses, ['completed', 'completed', 'failed']);
});

test('a provider transport without sessions runs each prompt on its own and records no session', async (t) => {
  const { root, request, inContext } = await fixture(t);
  const session = createModelSession();
  const attachment = { executable: process.execPath, arguments: ['-e', 'process.stdout.write("alone")', '--'], promptTransport: 'attachment' };
  const result = await inContext(() => invokeModel(request('attachment prompt', { session, providerConfig: attachment })));
  await session.close();
  assert.equal(result.output, 'alone');
  const [audit] = await listModelInvocations(root);
  assert.equal(audit.session, undefined);
  assert.equal(session.turns, 0);
});
