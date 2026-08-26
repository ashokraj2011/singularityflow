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
import { access } from 'node:fs/promises';
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
    const modelIndex = process.argv.indexOf('--model');
    const requestedModel = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'auto';
    const selectedModel = process.argv.includes('--fixture-model-mismatch')
      ? 'fallback-model'
      : process.argv.includes('--fixture-auto-select') && requestedModel === 'auto'
        ? 'provider-choice-model' : requestedModel;
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'fixture-session',
      configOptions: [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: selectedModel, options: [] }]
    }});
  } else if (message.method === 'session/prompt') {
    if (process.argv.includes('--fixture-hang')) continue;
    if (process.argv.includes('--fixture-malformed')) { process.stdout.write('not-json\\n'); continue; }
    const prompt = message.params.prompt.map((item) => item.type === 'text' ? item.text : '').join('');
    let result = JSON.stringify({
      cwd, bytes: Buffer.byteLength(prompt),
      sha256: createHash('sha256').update(prompt).digest('hex'),
      argv: process.argv.slice(2),
      envLeak: Object.values(process.env).some((value) => String(value).includes('ACP_CANARY_DO_NOT_LEAK'))
    });
    if (process.argv.includes('--fixture-large-output')) result = 'x'.repeat(2048);
    if (process.argv.includes('--fixture-create-target')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: 'tool_call', toolCallId: 'create-target', title: 'create output',
          name: 'edit', kind: 'edit', status: 'in_progress', rawInput: { path: prompt }
        }
      }});
      await new Promise((resolve) => setTimeout(resolve, 30));
      const created = await access(prompt).then(() => true, () => false);
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'create-target',
          name: 'edit', kind: 'edit', status: 'completed', rawOutput: { bytes: 0 }
        }
      }});
      result = JSON.stringify({ created });
    }
    if (process.argv.includes('--fixture-tool-failure')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'failed-read', title: 'read fixture', name: 'view', kind: 'read', status: 'failed', rawOutput: { code: 'NOT_FOUND' } }
      }});
    }
    if (process.argv.includes('--fixture-tool-truncated')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'truncated-read', title: 'read fixture', name: 'view', kind: 'read', status: 'completed', rawOutput: { truncated: true, bytes: 4096 } }
      }});
    }
    if (process.argv.includes('--fixture-many-tools')) {
      for (let index = 0; index < 4; index += 1) {
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 'tool-' + index, title: 'search fixture', name: 'grep', kind: 'search', status: 'completed', rawOutput: { matches: index } }
        }});
      }
    }
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
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'final', content: {
        type: 'text', text: process.argv.includes('--fixture-whitespace') ? '  result  \\n' : result
      }}
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
  assert.equal(observed.argv[observed.argv.indexOf('--model') + 1], 'auto');
  assert.equal(observed.argv[observed.argv.indexOf('--max-ai-credits') + 1], '30');
  assert.doesNotMatch(JSON.stringify(observed.argv), /ACP_CANARY_DO_NOT_LEAK/);
  assert.equal(observed.envLeak, false);
  assert.equal(result.promptTransport, 'acp-stdio');
  assert.equal(result.promptProtocolVersion, 1);
  assert.equal(result.modelSelection.policy, 'provider-auto');
  assert.equal(result.modelSelection.providerSelectedModel, 'auto');
  assert.deepEqual(result.usage, {
    status: 'exact', assurance: 'provider-reported', totalTokens: 12,
    inputTokens: 8, outputTokens: 4, reasoningTokens: 2
  });
});

test('the Copilot provider enforces its current minimum AI-credit limit before process start', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-credits-'));
  await assert.rejects(() => invokeAcp(root, {
    limits: { timeoutMs: 2000, outputBytes: 64 * 1024, maxAiCredits: 8 }
  }), (error) => error.code === 'MODEL_AI_CREDIT_LIMIT_UNSUPPORTED'
    && error.details?.minimum === 30
    && error.details?.requested === 8);
});

test('ACP records exact normalized output and fails closed on response and token budgets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-budgets-'));
  await t.test('normalized output receipt', async () => {
    const result = await invokeAcp(root, { fixtureArguments: ['--fixture-whitespace'] });
    assert.equal(result.output, 'result');
    assert.equal(result.outputBytes, Buffer.byteLength(result.output));
    assert.ok(result.streamedOutputBytes > result.outputBytes);
  });
  await t.test('assistant response overflow', async () => {
    await assert.rejects(() => invokeAcp(root, {
      fixtureArguments: ['--fixture-large-output'], limits: { timeoutMs: 2000, outputBytes: 64 }
    }), (error) => error.code === 'MODEL_OUTPUT_LIMIT');
  });
  await t.test('aggregate token budget', async () => {
    await assert.rejects(() => invokeAcp(root, {
      limits: { timeoutMs: 2000, outputBytes: 64 * 1024, maxTotalTokens: 10 }
    }), (error) => error.code === 'MODEL_TOKEN_BUDGET_EXCEEDED');
  });
});

test('ACP audits tool outcomes and rejects failed, truncated, excessive-call, and excessive-turn sessions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-tool-outcomes-'));
  const tools = { mode: 'allowlist', names: ['read_file'], requireSuccessful: true, rejectTruncated: true };
  await t.test('failed tool', async () => {
    await assert.rejects(() => invokeAcp(root, { fixtureArguments: ['--fixture-tool-failure'], tools }),
      (error) => error.code === 'MODEL_TOOL_EXECUTION_FAILED'
        && error.details?.toolObservation?.failedCalls === 1
        && !JSON.stringify(error.details).includes('NOT_FOUND'));
  });
  await t.test('truncated tool', async () => {
    await assert.rejects(() => invokeAcp(root, { fixtureArguments: ['--fixture-tool-truncated'], tools }),
      (error) => error.code === 'MODEL_TOOL_RESULT_TRUNCATED'
        && error.details?.toolObservation?.truncatedCalls === 1);
  });
  await t.test('tool-call budget', async () => {
    await assert.rejects(() => invokeAcp(root, {
      fixtureArguments: ['--fixture-many-tools'], tools,
      limits: { timeoutMs: 2000, outputBytes: 64 * 1024, maxToolCalls: 2, maxTurns: 16 }
    }), (error) => error.code === 'MODEL_TOOL_CALL_LIMIT');
  });
  await t.test('turn budget', async () => {
    await assert.rejects(() => invokeAcp(root, {
      fixtureArguments: ['--fixture-many-tools'], tools,
      limits: { timeoutMs: 2000, outputBytes: 64 * 1024, maxToolCalls: 8, maxTurns: 2 }
    }), (error) => error.code === 'MODEL_TURN_LIMIT');
  });
});

test('ACP refuses a concrete model substitution before sending the prompt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-model-selection-'));
  await assert.rejects(() => invokeAcp(root, {
    fixtureArguments: ['--fixture-model-mismatch'], model: 'required-model'
  }), (error) => error.code === 'MODEL_NOT_AVAILABLE'
    && error.details?.requestedModel === 'required-model'
    && error.details?.providerSelectedModel === 'fallback-model');
});

test('ACP accepts and records the concrete model selected by Copilot auto routing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-auto-model-'));
  const result = await invokeAcp(root, {
    fixtureArguments: ['--fixture-auto-select']
  });
  assert.equal(result.requestedModel, 'auto');
  assert.equal(result.model, 'provider-choice-model');
  assert.deepEqual(result.modelSelection, {
    policy: 'provider-auto', requestedModel: 'auto',
    providerSelectedModel: 'provider-choice-model', resolvedModels: [],
    assurance: 'acp-session'
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

test('ACP supplies create_file semantics only inside admitted roots and only when authorized', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-create-'));
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-acp-create-output-'));
  const target = path.join(outputRoot, 'nested', 'packet.md');
  const createdResult = await invokeAcp(root, {
    fixtureArguments: ['--fixture-create-target'], publicPrompt: { text: target },
    allowedRoots: [root, outputRoot], tools: { mode: 'allowlist', names: ['create_file'] }
  });
  const created = JSON.parse(createdResult.output);
  assert.equal(created.created, true);
  assert.equal(await readFile(target, 'utf8'), '');
  assert.equal(createdResult.toolObservation.totalCalls, 1);
  assert.deepEqual(createdResult.toolObservation.calls[0], {
    sequence: 1, name: 'edit', kind: 'edit', status: 'completed',
    outputBytes: 11, truncated: false, preparationFailed: false
  });
  assert.doesNotMatch(JSON.stringify(createdResult.toolObservation), /packet\.md|nested/);

  const editOnlyTarget = path.join(outputRoot, 'edit-only.md');
  const editOnly = JSON.parse((await invokeAcp(root, {
    fixtureArguments: ['--fixture-create-target'], publicPrompt: { text: editOnlyTarget },
    allowedRoots: [root, outputRoot], tools: { mode: 'allowlist', names: ['edit_file'] }
  })).output);
  assert.equal(editOnly.created, false);

  const outsideTarget = path.join(os.tmpdir(), `sflow-provider-acp-outside-${Date.now()}.md`);
  const outside = JSON.parse((await invokeAcp(root, {
    fixtureArguments: ['--fixture-create-target'], publicPrompt: { text: outsideTarget },
    allowedRoots: [root, outputRoot], tools: { mode: 'allowlist', names: ['create_file'] }
  })).output);
  assert.equal(outside.created, false);
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
