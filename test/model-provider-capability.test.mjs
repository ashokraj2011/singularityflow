import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearModelPromptTransportProbeCache, probeModelPromptTransport
} from '../src/model-provider-capability.mjs';
import { resolveModelProviderLaunch } from '../src/model-provider-launch.mjs';

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

test('Windows Copilot launch prefers an executable and safely wraps a cmd shim without shell mode', () => {
  const executable = resolveModelProviderLaunch('copilot', {
    platform: 'win32',
    resolvedExecutable: 'C:\\Tools\\copilot.exe',
    environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  });
  assert.equal(executable.command, 'C:\\Tools\\copilot.exe');
  assert.deepEqual(executable.arguments(['--acp']), ['--acp']);
  assert.deepEqual(executable.spawnOptions, { shell: false });

  const shim = resolveModelProviderLaunch('copilot', {
    platform: 'win32',
    resolvedExecutable: 'C:\\Program Files\\Copilot & Tools\\copilot.cmd',
    environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  });
  assert.equal(shim.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(shim.spawnOptions.shell, false);
  assert.equal(shim.spawnOptions.windowsVerbatimArguments, true);
  const args = shim.arguments(['--acp', '--add-dir', 'C:\\Work & Demo']);
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(args[3], /copilot\.cmd/);
  assert.match(args[3], /\^&/, 'cmd metacharacters are escaped inside the one verbatim command');
});

test('Windows cmd-shim quoting is exact for quotes, trailing slashes, and expansion metacharacters', () => {
  const shim = resolveModelProviderLaunch('copilot', {
    platform: 'win32',
    resolvedExecutable: 'C:\\Program Files\\Copilot & Tools\\copilot.cmd',
    environment: { ComSpec: 'cmd.exe' }
  });
  const commandLine = shim.arguments([
    '--arg', 'say "hello"', 'C:\\ends\\', 'x&y|z<q>(r)^s%T%!U!'
  ])[3];
  // This is the established cmd.exe /d /s /c double-escape contract used by mature spawn
  // wrappers. An exact vector catches removal of either escaping pass, quote/backslash collapse,
  // and command concatenation; a regex checking only one ampersand would not.
  assert.equal(commandLine, String.raw`"C:\Program^ Files\Copilot^ ^&^ Tools\copilot.cmd ^^^"--arg^^^" ^^^"say^^^ \^^^"hello\^^^"^^^" ^^^"C:\ends\\^^^" ^^^"x^^^&y^^^|z^^^<q^^^>^^^(r^^^)^^^^s^^^%T^^^%^^^!U^^^!^^^""`);
  assert.throws(() => shim.arguments(['line\nbreak']), /control characters/);
});

test('Windows automatic transport probe uses the same resolved cmd launch contract as ACP execution', () => {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'where.exe' && args[0] === 'copilot.exe') return { status: 1, stdout: '', stderr: '' };
    if (command === 'where.exe') {
      return { status: 0, stdout: 'C:\\Tools\\copilot.cmd\r\n', stderr: '' };
    }
    assert.equal(command, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(options.shell, false);
    assert.equal(options.windowsVerbatimArguments, true);
    return { status: 0, stdout: 'Usage: copilot --acp\r\n', stderr: '' };
  };
  clearModelPromptTransportProbeCache();
  const result = probeModelPromptTransport({
    type: 'copilot-cli', executable: 'copilot', platform: 'win32',
    environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, spawnSyncImpl
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.transport, 'acp-stdio');
  assert.equal(calls.at(-1).command, 'C:\\Windows\\System32\\cmd.exe');
  assert.match(calls.at(-1).args[3], /copilot\.cmd.*--help/);
});
