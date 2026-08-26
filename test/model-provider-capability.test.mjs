import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearModelPromptTransportProbeCache, probeModelPromptTransport
} from '../src/model-provider-capability.mjs';

test('provider capability probe blocks missing ACP support with structured diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-'));
  const missing = probeModelPromptTransport({
    type: 'copilot-cli', executable: path.join(root, 'does-not-exist')
  });
  assert.equal(missing.state, 'blocked');
  assert.equal(missing.code, 'MODEL_PROVIDER_UNAVAILABLE');
  // Non-Copilot adapters are not falsely judged by the Copilot CLI help contract.
  assert.equal(probeModelPromptTransport({ type: 'fixture-provider', executable: process.execPath }).state, 'not-applicable');
  const blocked = probeModelPromptTransport({ type: 'copilot-cli', executable: process.execPath });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.code, 'MODEL_PROMPT_TRANSPORT_UNSUPPORTED');
  assert.equal(blocked.capability, 'model-prompt-transport');
});

test('provider capability probe selects ACP and keeps attachment as explicit legacy opt-in', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-ready-'));
  const executable = path.join(root, 'copilot-fixture');
  await writeFile(executable, '#!/bin/sh\nprintf "Usage: copilot --acp --attachment <path>\\n"\n');
  await chmod(executable, 0o700);
  clearModelPromptTransportProbeCache();
  const automatic = probeModelPromptTransport({ type: 'copilot-cli', executable });
  assert.equal(automatic.state, 'ready');
  assert.equal(automatic.transport, 'acp-stdio');
  assert.equal(automatic.capability, 'model-prompt-transport');
  const legacy = probeModelPromptTransport({
    type: 'copilot-cli', executable: process.execPath, promptTransport: 'attachment'
  });
  assert.equal(legacy.state, 'ready');
  assert.equal(legacy.transport, 'attachment');
  assert.equal(legacy.reason, 'explicit-legacy-opt-in');
});
