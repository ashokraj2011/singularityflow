import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  copilotChatOtelFile, copilotChatRequests, copilotChatUsageStatus, remoteKey, storyCopilotChat, syncCopilotChatUsage
} from '../src/copilot-chat-usage.mjs';

const roots = [];
async function repository(remote = 'https://git.example.invalid/acme/payments.git') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-copilot-chat-'));
  roots.push(root);
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  if (remote) spawnSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  return root;
}
test.after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const seconds = (iso) => [Math.floor(Date.parse(iso) / 1000), 0];
// The shape Copilot Chat's file exporter writes: one span per line, attributes flat.
const span = ({ trace, id, parent = null, operation, at, attributes = {}, error = false }) => JSON.stringify({
  traceId: trace, spanId: id, ...(parent ? { parentSpanContext: { traceId: trace, spanId: parent } } : {}),
  name: `${operation} span`, kind: 0, startTime: seconds(at), endTime: seconds(at), status: { code: error ? 2 : 0 },
  attributes: { 'gen_ai.operation.name': operation, ...attributes }, resource: { attributes: {} }
});
const call = (trace, id, at, usage) => span({
  trace, id, parent: `${trace}-root`, operation: 'chat', at,
  attributes: { 'gen_ai.request.model': 'gpt-5', 'gen_ai.usage.input_tokens': usage.input, 'gen_ai.usage.output_tokens': usage.output,
    'gen_ai.usage.cache_read.input_tokens': usage.cached, 'copilot_chat.copilot_usage_nano_aiu': usage.nano }
});
const request = (trace, at, { branch, remote, model = 'gpt-5' }) => span({
  trace, id: `${trace}-root`, operation: 'invoke_agent', at,
  attributes: {
    'gen_ai.request.model': model, 'gen_ai.conversation.id': 'conversation-should-not-be-kept',
    ...(branch ? { 'copilot_chat.repo.head_branch_name': branch } : {}),
    ...(remote ? { 'copilot_chat.repo.remote_url': remote } : {})
  }
});

test('remote URLs compare as host and path, whatever the scheme or credentials', () => {
  assert.equal(remoteKey('git@git.example.invalid:Acme/Payments.git'), 'git.example.invalid/acme/payments');
  assert.equal(remoteKey('https://token@git.example.invalid/acme/payments.git/'), 'git.example.invalid/acme/payments');
  assert.equal(remoteKey('ssh://git@git.example.invalid/acme/payments'), 'git.example.invalid/acme/payments');
  assert.equal(remoteKey(''), null);
});

test('a sync records this repository\'s Copilot Chat requests, content-free, once each', async () => {
  const root = await repository();
  const file = path.join(root, '..', `${path.basename(root)}-chat.jsonl`);
  roots.push(file);
  await writeFile(file, [
    call('aaaa', 'a1', '2026-07-01T10:00:00Z', { input: 1000, output: 50, cached: 800, nano: 1_000_000_000 }),
    call('aaaa', 'a2', '2026-07-01T10:00:05Z', { input: 1200, output: 60, cached: 1100, nano: 500_000_000 }),
    span({ trace: 'aaaa', id: 'a3', parent: 'aaaa-root', operation: 'invoke_agent', at: '2026-07-01T10:00:02Z' }),
    request('aaaa', '2026-07-01T09:59:59Z', { branch: 'ENG-9', remote: 'git@git.example.invalid:acme/payments.git' }),
    call('bbbb', 'b1', '2026-07-01T10:01:00Z', { input: 10, output: 1, cached: 0, nano: 1 }),
    request('bbbb', '2026-07-01T10:01:00Z', { branch: 'ENG-9', remote: 'https://git.example.invalid/acme/other.git' }),
    request('cccc', '2026-07-01T10:02:00Z', { branch: 'main', remote: 'https://git.example.invalid/acme/payments' }),
    JSON.stringify({ body: 'a log record', attributes: { 'event.name': 'copilot_chat.session.start' } }),
    JSON.stringify({ resourceMetrics: [] }),
    call('dddd', 'd1', '2026-07-01T10:03:00Z', { input: 5, output: 5, cached: 0, nano: 2 }),
    ''
  ].join('\n'));
  await appendFile(file, request('dddd', '2026-07-01T10:02:59Z', { branch: 'ENG-9', remote: 'https://git.example.invalid/acme/payments.git' }).slice(0, 40));

  const first = await syncCopilotChatUsage(root, { file, now: Date.parse('2026-07-01T11:00:00Z') });
  assert.equal(first.added, 2, 'ENG-9 and main; the other repository is not ours');
  const story = await copilotChatRequests(root, 'ENG-9');
  assert.equal(story.since, '2026-07-01T11:00:00.000Z');
  assert.deepEqual(story.requests.map(({ trace, ...rest }) => rest), [{
    at: '2026-07-01T09:59:59.000Z', model: 'gpt-5', modelCalls: 2, inputTokens: 2200, outputTokens: 110,
    cachedInputTokens: 1900, cacheWriteInputTokens: null, nanoAiu: 1_500_000_000, failed: false
  }]);
  assert.match(story.requests[0].trace, /^[0-9a-f]{16}$/u, 'the trace is kept only as a short hash');
  const stored = (await Promise.all((await readdir(path.join(root, '.git', 'singularity-flow', 'copilot-chat', 'branches')))
    .map((name) => readFile(path.join(root, '.git', 'singularity-flow', 'copilot-chat', 'branches', name), 'utf8')))).join('');
  assert.doesNotMatch(stored, /conversation|aaaa/u, 'no conversation identifier or raw trace is kept');
  assert.equal((await copilotChatRequests(root, 'main')).requests.length, 1);

  // The unfinished last line is read once it is complete; the earlier model call joins it.
  await appendFile(file, `${request('dddd', '2026-07-01T10:02:59Z', { branch: 'ENG-9', remote: 'https://git.example.invalid/acme/payments.git' }).slice(40)}\n`);
  const second = await syncCopilotChatUsage(root, { file, now: Date.parse('2026-07-01T11:05:00Z') });
  assert.equal(second.added, 1);
  assert.equal((await copilotChatRequests(root, 'ENG-9')).requests.at(-1).modelCalls, 1);
  assert.equal((await syncCopilotChatUsage(root, { file })).added, 0, 'a repeated sync adds nothing');

  // A replaced file is read from the start without counting a request twice.
  const copy = `${file}.copy`;
  roots.push(copy);
  await writeFile(copy, await readFile(file));
  await rm(file);
  await writeFile(file, await readFile(copy));
  assert.equal((await syncCopilotChatUsage(root, { file })).added, 0);
  assert.equal((await copilotChatRequests(root, 'ENG-9')).requests.length, 2);
  const status = await copilotChatUsageStatus(root, { file });
  assert.equal(status.following, true);
  assert.equal(status.unreadBytes, 0);
});

test('without a remote, only requests from a window with no remote either are ours', async () => {
  const root = await repository(null);
  const file = path.join(root, '..', `${path.basename(root)}-chat.jsonl`);
  roots.push(file);
  await writeFile(file, `${[
    request('eeee', '2026-07-01T10:00:00Z', { branch: 'ENG-1' }),
    request('ffff', '2026-07-01T10:00:00Z', { branch: 'ENG-1', remote: 'https://git.example.invalid/acme/payments.git' }),
    request('9999', '2026-07-01T10:00:00Z', { remote: 'https://git.example.invalid/acme/payments.git' })
  ].join('\n')}\n`);
  assert.equal((await syncCopilotChatUsage(root, { file })).added, 1);
});

test('nothing is counted until Copilot Chat has written its file, and a report never fails for it', async () => {
  const root = await repository();
  const file = path.join(root, '..', `${path.basename(root)}-missing.jsonl`);
  assert.equal((await syncCopilotChatUsage(root, { file })).status, 'no-file');
  assert.equal(await copilotChatRequests(root, 'ENG-9'), null, 'never followed: not counted, rather than zero');
  assert.equal(await storyCopilotChat(root, { workItem: { id: 'ENG-9' } }), null);
  assert.equal(copilotChatOtelFile({ SINGULARITY_FLOW_COPILOT_CHAT_OTEL_FILE: file }), file);
  assert.equal(copilotChatOtelFile({}), path.join(os.homedir(), '.singularity-flow', 'copilot-chat-otel.jsonl'));
});
