import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probePromptAttachmentCapability } from '../src/model-provider-capability.mjs';

test('provider capability probe blocks missing attachment support with structured diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-'));
  const supported = path.join(root, 'supported.mjs');
  const unsupported = path.join(root, 'unsupported.mjs');
  await writeFile(supported, 'console.log("Usage: fixture --attachment <path>")\n');
  await writeFile(unsupported, 'console.log("Usage: fixture --prompt <text>")\n');
  assert.deepEqual(probePromptAttachmentCapability({ type: 'copilot-cli', executable: process.execPath }), {
    state: 'blocked', code: 'MODEL_PROVIDER_CAPABILITY_MISSING',
    capability: 'prompt-attachment', executable: process.execPath
  });
  const missing = probePromptAttachmentCapability({
    type: 'copilot-cli', executable: path.join(root, 'does-not-exist')
  });
  assert.equal(missing.state, 'blocked');
  assert.equal(missing.code, 'MODEL_PROVIDER_UNAVAILABLE');
  // Non-Copilot adapters are not falsely judged by the Copilot CLI help contract.
  assert.equal(probePromptAttachmentCapability({ type: 'fixture-provider', executable: supported }).state, 'not-applicable');
  assert.equal(probePromptAttachmentCapability({ type: 'copilot-cli', executable: unsupported }).state, 'blocked');
});

test('provider capability probe recognizes attachment help', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-ready-'));
  const executable = path.join(root, 'copilot-fixture');
  await writeFile(executable, '#!/bin/sh\nprintf "Usage: copilot --attachment <path>\\n"\n');
  await chmod(executable, 0o700);
  assert.deepEqual(probePromptAttachmentCapability({ type: 'copilot-cli', executable }), {
    state: 'ready', code: null, capability: 'prompt-attachment', executable
  });
});
