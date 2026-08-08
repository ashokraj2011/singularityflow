import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { invokeCopilotCli } from '../src/model-providers/copilot-cli.mjs';

function request(root, script, overrides = {}) {
  return {
    provider: 'copilot-cli', providerConfig: { executable: process.execPath, arguments: ['-e', script, '--'] },
    cwd: root, prompt: { text: 'prompt' }, tools: { mode: 'none', names: [] },
    limits: { timeoutMs: 1000, outputBytes: 1024 }, ...overrides
  };
}

test('the Copilot provider uses structured argv and captures bounded output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-'));
  const result = await invokeCopilotCli(request(root, 'process.stdout.write("provider output")'));
  assert.equal(result.output, 'provider output');
});

test('the Copilot provider enforces none, allowlist, and all tool policies in argv', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-tools-'));
  const argvScript = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const none = JSON.parse((await invokeCopilotCli(request(root, argvScript))).output);
  assert.ok(none.includes('--available-tools='));
  assert.ok(!none.includes('--allow-all-tools'));

  const allowlist = JSON.parse((await invokeCopilotCli(request(root, argvScript, {
    tools: { mode: 'allowlist', names: ['read_file', 'search'] }
  }))).output);
  assert.ok(allowlist.includes('--available-tools=read_file,search'));
  assert.ok(allowlist.includes('--allow-tool=read_file,search'));

  const all = JSON.parse((await invokeCopilotCli(request(root, argvScript, {
    tools: { mode: 'all', names: [] }
  }))).output);
  assert.ok(all.includes('--allow-all-tools'));
});

test('the Copilot provider reports unavailable executable, timeout, output limit, and cancellation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-provider-errors-'));
  await t.test('unavailable', async () => {
    await assert.rejects(() => invokeCopilotCli({
      ...request(root, ''), providerConfig: { executable: path.join(root, 'missing-copilot') }
    }), (error) => error.code === 'MODEL_PROVIDER_UNAVAILABLE');
  });
  await t.test('timeout', async () => {
    await assert.rejects(() => invokeCopilotCli(request(root, 'setTimeout(() => {}, 10000)', {
      limits: { timeoutMs: 25, outputBytes: 1024 }
    })), (error) => error.code === 'MODEL_TIMEOUT');
  });
  await t.test('timeout terminates a provider that ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
    const pidFile = path.join(root, 'provider.pid');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    await assert.rejects(() => invokeCopilotCli(request(root, script, {
      // Leave enough startup headroom for the deliberately process-heavy full suite.
      limits: { timeoutMs: 1000, outputBytes: 1024 }
    })), (error) => error.code === 'MODEL_TIMEOUT');
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
  await t.test('output limit', async () => {
    await assert.rejects(() => invokeCopilotCli(request(root, 'process.stdout.write("x".repeat(2048))', {
      limits: { timeoutMs: 1000, outputBytes: 64 }
    })), (error) => error.code === 'MODEL_OUTPUT_LIMIT');
  });
  await t.test('cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => invokeCopilotCli(request(root, 'setTimeout(() => {}, 10000)', {
      signal: controller.signal
    })), (error) => error.code === 'MODEL_CANCELLED');
  });
});
