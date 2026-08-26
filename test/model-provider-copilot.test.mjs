import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COPILOT_ATTACHMENT_BOOTSTRAP_PROMPT, invokeCopilotCli, modelProviderStartErrorCode
} from '../src/model-providers/copilot-cli.mjs';
import { stageModelPrompt } from '../src/model-prompt-transport.mjs';
import { prepareTelemetryLaunch, setTelemetryCapture } from '../src/telemetry-provision.mjs';
import { run } from '../src/util.mjs';

async function invoke(root, script, overrides = {}) {
  const { publicPrompt = { text: 'prompt' }, ...requestOverrides } = overrides;
  const staged = await stageModelPrompt(publicPrompt, { tempRoot: root });
  try { return await invokeCopilotCli({
    provider: 'copilot-cli', providerConfig: { executable: process.execPath, arguments: ['-e', script, '--'] },
    cwd: root,
    prompt: { file: staged.file, sha256: staged.sha256, bytes: staged.bytes, encoding: staged.encoding, staged: true },
    promptTransport: 'attachment', tools: { mode: 'none', names: [] },
    limits: { timeoutMs: 1000, outputBytes: 1024 }, ...requestOverrides
  }); } finally { await staged.cleanup(); }
}

const fakeAcpSource = `
import { createHash } from 'node:crypto';
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let cwd = null;
let pendingPrompt = null;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: process.argv.includes('--fixture-wrong-version') ? 99 : message.params.protocolVersion,
      agentCapabilities: {}, agentInfo: { name: 'fake-copilot-acp', version: '1' }
    }});
  } else if (message.method === 'session/new') {
    cwd = message.params.cwd;
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fixture-session' }});
  } else if (message.method === 'session/prompt') {
    if (process.argv.includes('--fixture-hang')) continue;
    if (process.argv.includes('--fixture-malformed')) { process.stdout.write('not-json\\n'); continue; }
    const prompt = message.params.prompt.map((item) => item.type === 'text' ? item.text : '').join('');
    const result = JSON.stringify({
      cwd, bytes: Buffer.byteLength(prompt),
      sha256: createHash('sha256').update(prompt).digest('hex'),
      argv: process.argv.slice(2),
      envLeak: Object.values(process.env).some((value) => String(value).includes('ACP_CANARY_DO_NOT_LEAK'))
    });
    if (process.argv.includes('--fixture-permission')) {
      pendingPrompt = { id: message.id, sessionId: message.params.sessionId, result };
      send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
        sessionId: message.params.sessionId,
        toolCall: { toolCallId: 'tool-1', name: 'edit', kind: 'edit', title: 'edit file' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject once', kind: 'reject_once' }
        ]
      }});
      continue;
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result }}
    }});
    send({ jsonrpc: '2.0', id: message.id, result: {
      stopReason: 'end_turn', usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4, thoughtTokens: 2 }
    }});
  } else if (message.id === 900 && pendingPrompt) {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: pendingPrompt.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: {
        type: 'text', text: JSON.stringify({ permission: message.result, prompt: JSON.parse(pendingPrompt.result) })
      }}
    }});
    send({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'end_turn' }});
    pendingPrompt = null;
  }
}
`;

async function invokeAcp(root, overrides = {}) {
  const { publicPrompt = { text: 'ACP prompt' }, fixtureArguments = [], ...requestOverrides } = overrides;
  const fixture = path.join(root, `fake-acp-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(fixture, fakeAcpSource);
  const staged = await stageModelPrompt(publicPrompt, { tempRoot: root });
  try {
    return await invokeCopilotCli({
      provider: 'copilot-cli',
      providerConfig: { executable: process.execPath, arguments: [fixture, ...fixtureArguments] },
      cwd: root,
      prompt: { file: staged.file, sha256: staged.sha256, bytes: staged.bytes, encoding: staged.encoding, staged: true },
      promptTransport: 'acp-stdio', tools: { mode: 'none', names: [] },
      limits: { timeoutMs: 2000, outputBytes: 64 * 1024 }, ...requestOverrides
    });
  } finally { await staged.cleanup(); }
}

test('the Copilot provider sends verified prompt bytes over ACP stdio without argv or environment leakage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-'));
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-output-'));
  const prompt = `ACP_CANARY_DO_NOT_LEAK_${'नमस्ते'.repeat(1000)}`;
  const result = await invokeAcp(root, {
    publicPrompt: { text: prompt },
    allowedRoots: [root, outputRoot],
    tools: { mode: 'allowlist', names: ['read_file', 'search'] }
  });
  const observed = JSON.parse(result.output);
  assert.equal(observed.cwd, root);
  assert.equal(observed.bytes, Buffer.byteLength(prompt));
  assert.equal(observed.sha256, createHash('sha256').update(prompt).digest('hex'));
  assert.ok(observed.argv.includes('--acp'));
  assert.ok(observed.argv.includes('--available-tools=view,grep'));
  assert.equal(observed.argv[observed.argv.indexOf('--add-dir') + 1], outputRoot);
  assert.ok(observed.argv.includes('--disable-builtin-mcps'));
  assert.ok(observed.argv.includes('--no-custom-instructions'));
  assert.ok(!observed.argv.includes('--attachment'));
  assert.ok(!observed.argv.includes('-p'));
  assert.doesNotMatch(JSON.stringify(observed.argv), /ACP_CANARY_DO_NOT_LEAK/);
  assert.equal(observed.envLeak, false);
  assert.equal(result.promptTransport, 'acp-stdio');
  assert.equal(result.promptProtocolVersion, 1);
  assert.deepEqual(result.usage, {
    status: 'exact', assurance: 'provider-reported', totalTokens: 12,
    inputTokens: 8, outputTokens: 4, reasoningTokens: 2
  });
});

test('ACP permission requests are bounded by the normalized SFlow tool policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-permission-'));
  const allowed = JSON.parse((await invokeAcp(root, {
    fixtureArguments: ['--fixture-permission'],
    tools: { mode: 'allowlist', names: ['edit_file'] }
  })).output);
  assert.deepEqual(allowed.permission, { outcome: { outcome: 'selected', optionId: 'allow' } });
  const denied = JSON.parse((await invokeAcp(root, {
    fixtureArguments: ['--fixture-permission'], tools: { mode: 'none', names: [] }
  })).output);
  assert.deepEqual(denied.permission, { outcome: { outcome: 'cancelled' } });
});

test('ACP fails closed on unsupported protocol, malformed NDJSON, timeout, and cancellation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-failures-'));
  await t.test('protocol', async () => {
    await assert.rejects(() => invokeAcp(root, { fixtureArguments: ['--fixture-wrong-version'] }),
      (error) => error.code === 'MODEL_PROVIDER_PROTOCOL_UNSUPPORTED');
  });
  await t.test('malformed', async () => {
    await assert.rejects(() => invokeAcp(root, { fixtureArguments: ['--fixture-malformed'] }),
      (error) => error.code === 'MODEL_PROVIDER_PROTOCOL_FAILED');
  });
  await t.test('timeout', async () => {
    await assert.rejects(() => invokeAcp(root, {
      fixtureArguments: ['--fixture-hang'], limits: { timeoutMs: 50, outputBytes: 1024 }
    }), (error) => error.code === 'MODEL_TIMEOUT');
  });
  await t.test('cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => invokeAcp(root, {
      fixtureArguments: ['--fixture-hang'], signal: controller.signal
    }), (error) => error.code === 'MODEL_CANCELLED');
  });
});

test('the Copilot provider uses structured argv and captures bounded output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-'));
  const result = await invoke(root, 'process.stdout.write("provider output")');
  assert.equal(result.output, 'provider output');
});

test('the Copilot provider preserves UTF-8 characters split across process chunks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-utf8-'));
  const result = await invoke(root, 'const b=Buffer.from("नमस्ते 🌍"); process.stdout.write(b.subarray(0,5)); setTimeout(() => process.stdout.write(b.subarray(5)), 10)');
  assert.equal(result.output, 'नमस्ते 🌍');
});

test('the Copilot provider enforces none, allowlist, and all tool policies in argv', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-tools-'));
  const argvScript = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const none = JSON.parse((await invoke(root, argvScript)).output);
  assert.ok(none.includes('--available-tools='));
  assert.ok(!none.includes('--allow-all-tools'));

  const allowlist = JSON.parse((await invoke(root, argvScript, {
    tools: { mode: 'allowlist', names: ['read_file', 'search'] }
  })).output);
  assert.ok(allowlist.includes('--available-tools=view,grep'));
  assert.ok(!allowlist.some((entry) => entry.startsWith('--allow-tool=')));

  const writable = JSON.parse((await invoke(root, argvScript, {
    tools: { mode: 'allowlist', names: ['read_file', 'search', 'edit_file', 'create_file'] }
  })).output);
  assert.ok(writable.includes('--available-tools=view,grep,edit'));
  assert.ok(writable.includes('--allow-tool=write'));

  const all = JSON.parse((await invoke(root, argvScript, {
    tools: { mode: 'all', names: [] }
  })).output);
  assert.ok(all.includes('--allow-all-tools'));

  await assert.rejects(() => invoke(root, argvScript, {
    tools: { mode: 'allowlist', names: ['unreviewed_tool'] }
  }), (error) => error.code === 'MODEL_TOOL_UNSUPPORTED');
});

test('the Copilot provider accepts only trusted metadata-only telemetry injection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-telemetry-'));
  run('git', ['init', '-q'], { cwd: root });
  const preference = path.join(root, 'telemetry-preferences.json');
  const baseEnv = { PATH: process.env.PATH, SINGULARITY_FLOW_TELEMETRY_PREFERENCES: preference };
  await setTelemetryCapture(true, { acceptDisclosure: true, env: baseEnv });
  const telemetry = await prepareTelemetryLaunch({ root, story: 'PAY-1', baseEnv });
  const script = 'process.stdout.write(JSON.stringify({enabled:process.env.COPILOT_OTEL_ENABLED, exporter:process.env.COPILOT_OTEL_EXPORTER_TYPE, content:process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT, file:Boolean(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH)}))';
  const result = await invoke(root, script, { telemetry });
  assert.deepEqual(JSON.parse(result.output), { enabled: 'true', exporter: 'file', content: 'false', file: true });

  const existing = await prepareTelemetryLaunch({
    root,
    baseEnv: {
      ...baseEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test/v1/traces',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=private-value'
    }
  });
  assert.equal(existing.captureStatus, 'conflict');
  const preserved = await invoke(root,
    'process.stdout.write(JSON.stringify({endpoint:process.env.OTEL_EXPORTER_OTLP_ENDPOINT === "https://collector.example.test/v1/traces",header:Boolean(process.env.OTEL_EXPORTER_OTLP_HEADERS),sflowFile:Boolean(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH)}))',
    { telemetry: existing });
  assert.deepEqual(JSON.parse(preserved.output), { endpoint: true, header: true, sflowFile: false });
  assert.doesNotMatch(JSON.stringify(existing.launch), /private-value|collector\.example/);

  await assert.rejects(() => invoke(root, script, {
    env: { COPILOT_OTEL_ENABLED: 'true' }
  }), (error) => error.code === 'MODEL_REQUEST_INVALID');
});

test('the Copilot provider reports unavailable executable, timeout, output limit, and cancellation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-errors-'));
  await t.test('unavailable', async () => {
    await assert.rejects(() => invoke(root, '', {
      providerConfig: { executable: path.join(root, 'missing-copilot') }
    }), (error) => error.code === 'MODEL_PROVIDER_UNAVAILABLE');
  });
  await t.test('timeout', async () => {
    await assert.rejects(() => invoke(root, 'setTimeout(() => {}, 10000)', {
      limits: { timeoutMs: 25, outputBytes: 1024 }
    }), (error) => error.code === 'MODEL_TIMEOUT');
  });
  await t.test('timeout terminates a provider that ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
    const pidFile = path.join(root, 'provider.pid');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    await assert.rejects(() => invoke(root, script, {
      // Leave enough startup headroom for the deliberately process-heavy full suite.
      limits: { timeoutMs: 1000, outputBytes: 1024 }
    }), (error) => error.code === 'MODEL_TIMEOUT');
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
  await t.test('output limit', async () => {
    await assert.rejects(() => invoke(root, 'process.stdout.write("x".repeat(2048))', {
      limits: { timeoutMs: 1000, outputBytes: 64 }
    }), (error) => error.code === 'MODEL_OUTPUT_LIMIT');
  });
  await t.test('unavailable model retains a bounded provider diagnostic', async () => {
    await assert.rejects(() => invoke(root, 'process.stderr.write(\'Error: Model "retired-model" from --model flag is not available.\'); process.exit(1)', {
      model: 'retired-model'
    }), (error) => error.code === 'MODEL_NOT_AVAILABLE'
      && /retired-model.*not available/i.test(error.message)
      && error.details?.diagnostic === 'Error: Model "retired-model" from --model flag is not available.');
  });
  await t.test('zero-exit unavailable model diagnostics are not accepted as empty success', async () => {
    await assert.rejects(() => invoke(root, 'process.stderr.write(\'Error: Model "retired-model" from --model flag is not available.\')', {
      model: 'retired-model'
    }), (error) => error.code === 'MODEL_NOT_AVAILABLE');
  });
  await t.test('cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => invoke(root, 'setTimeout(() => {}, 10000)', {
      signal: controller.signal
    }), (error) => error.code === 'MODEL_CANCELLED');
  });
});

test('the Copilot provider transports large prompts only through the attachment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-large-prompt-'));
  const canary = 'CGR_CANARY_DO_NOT_LEAK';
  const prompt = `${canary}${'x'.repeat(200 * 1024)}${canary}`;
  const script = [
    'const fs=require("node:fs")',
    'const argv=process.argv.slice(1)',
    'const file=argv[argv.indexOf("--attachment")+1]',
    'const body=fs.readFileSync(file)',
    `const envLeak=Object.values(process.env).some(v=>String(v).includes(${JSON.stringify(canary)}))`,
    'process.stdout.write(JSON.stringify({argv,bytes:body.length,body:body.toString("utf8"),envLeak}))'
  ].join(';');
  const result = JSON.parse((await invoke(root, script, {
    publicPrompt: { text: prompt }, limits: { timeoutMs: 1000, outputBytes: 512 * 1024 }
  })).output);
  assert.equal(result.bytes, Buffer.byteLength(prompt));
  assert.equal(result.body, prompt);
  assert.equal(result.argv[result.argv.indexOf('-p') + 1], COPILOT_ATTACHMENT_BOOTSTRAP_PROMPT);
  assert.ok(result.argv.includes('--attachment'));
  assert.doesNotMatch(JSON.stringify(result.argv), new RegExp(canary));
  assert.equal(result.envLeak, false);
});

test('the attachment transport preserves larger bounded UTF-8 and file-source prompts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-bounded-'));
  const fileValue = 'file source\n'.repeat(90_000);
  const source = path.join(root, 'prompt with spaces नमस्ते.md');
  await writeFile(source, fileValue);
  const cases = [
    { text: 'a'.repeat(1024 * 1024) },
    { text: 'é'.repeat(512 * 1024) },
    { file: source }
  ];
  const script = 'const fs=require("node:fs"),c=require("node:crypto"),a=process.argv.slice(1),f=a[a.indexOf("--attachment")+1],b=fs.readFileSync(f);process.stdout.write(JSON.stringify({bytes:b.length,sha256:c.createHash("sha256").update(b).digest("hex")}))';
  for (const publicPrompt of cases) {
    const expected = publicPrompt.text ?? await readFile(publicPrompt.file, 'utf8');
    const result = JSON.parse((await invoke(root, script, { publicPrompt })).output);
    assert.equal(result.bytes, Buffer.byteLength(expected));
    assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'));
  }
});

test('the Copilot provider rejects adapter-owned configured flags and unstaged prompts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-reserved-'));
  for (const option of [
    '-p', '-pother', '--prompt=value', '--attachment', '--acp', '--stdio', '-C', '-C/tmp',
    '--model=x', '--available-tools=x', '--allow-tool=x', '--allow-all-tools', '--allow-all',
    '--allow-all-paths', '--add-dir=/tmp', '--yolo', '--additional-mcp-config={}', '--plugin-dir=/tmp'
  ]) {
    await assert.rejects(() => invoke(root, '', {
      providerConfig: { executable: process.execPath, arguments: [option] }
    }), (error) => error.code === 'MODEL_REQUEST_INVALID' && error.details?.option != null);
  }
  await assert.rejects(() => invokeCopilotCli({
    provider: 'copilot-cli', providerConfig: { executable: process.execPath }, cwd: root,
    prompt: { text: 'unsafe' }, tools: { mode: 'none', names: [] },
    limits: { timeoutMs: 1000, outputBytes: 1024 }
  }), (error) => error.code === 'MODEL_REQUEST_INVALID');
});

test('provider startup errors retain their native failure taxonomy', () => {
  assert.equal(modelProviderStartErrorCode('ENOENT'), 'MODEL_PROVIDER_UNAVAILABLE');
  assert.equal(modelProviderStartErrorCode('EACCES'), 'MODEL_PROVIDER_NOT_EXECUTABLE');
  assert.equal(modelProviderStartErrorCode('EPERM'), 'MODEL_PROVIDER_NOT_EXECUTABLE');
  assert.equal(modelProviderStartErrorCode('E2BIG'), 'MODEL_PROVIDER_ARGUMENT_LIMIT');
  assert.equal(modelProviderStartErrorCode('EIO'), 'MODEL_PROVIDER_START_FAILED');
});
