import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDefinition } from '../src/config.mjs';
import { gitCommonDir } from '../src/git.mjs';
import {
  assertMcpPhaseReadiness, attestMcpHost, clearPlaywrightAuthProfile,
  importPlaywrightAuthProfile, mcpDoctor,
  normalizeMcpServers, PLAYWRIGHT_MCP_HOST_ARGUMENTS, playwrightAuthProfileStatus,
  previewPlaywrightAuthImport,
  previewClearPlaywrightAuthProfile, probeMcpHost, removePlaywrightAuthProfile,
  resolvePlaywrightAuthRuntime, secureWindowsAuthAcl,
  scaffoldPlaywrightMcp, smokeMcpHost, warmMcpHost
} from '../src/mcp.mjs';

const SECRET = 'private-session-cookie-do-not-log';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(packageRoot, 'bin/singularity-flow.mjs');

async function repository(prefix = 'sflow-mcp-auth-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  return root;
}

function storageState(secret = SECRET, origin = 'https://example.test') {
  return {
    cookies: [{
      name: 'session', value: secret, domain: 'example.test', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax'
    }],
    origins: [{
      origin,
      localStorage: [{ name: 'access_token', value: secret }],
      indexedDB: [{ name: 'auth', data: [{ key: 'subject', value: secret }] }]
    }]
  };
}

async function sourceFile(secret = SECRET) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-storage-state-source-'));
  const file = path.join(directory, 'state.json');
  await writeFile(file, `${JSON.stringify(storageState(secret))}\n`, { mode: 0o600 });
  return file;
}

function definition() {
  return {
    mcpServers: normalizeMcpServers({
      playwright: {
        label: 'Playwright', hostReference: 'playwright', agents: ['qa'], phases: ['verification'],
        tools: ['browser_navigate', 'browser_snapshot', 'browser_close'], required: true,
        approval: 'confirm', evidence: { captureToolCalls: true, captureResults: true }
      }
    }, { agents: ['qa'], phases: ['verification'] })
  };
}

test('Playwright auth import previews without mutation and stores only a private Git-local copy', async () => {
  const root = await repository();
  const source = await sourceFile();
  const before = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: root, encoding: 'utf8' });
  const preview = await previewPlaywrightAuthImport(root, {
    storageState: source, profileId: 'poc-test-account'
  });
  assert.equal(preview.status, 'create');
  assert.match(preview.storageStateSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(preview).includes(SECRET), false);
  assert.equal(JSON.stringify(preview).includes(source), false);
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: root, encoding: 'utf8' }), before);

  const imported = await importPlaywrightAuthProfile(root, {
    storageState: source, profileId: 'poc-test-account', confirmation: preview.confirmation
  });
  assert.equal(imported.status, 'configured');
  const status = await playwrightAuthProfileStatus(root);
  assert.deepEqual(status, {
    status: 'configured', serverId: 'playwright', profileId: 'poc-test-account',
    storageStateSha256: preview.storageStateSha256
  });
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.equal(JSON.stringify(status).includes(source), false);
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: root, encoding: 'utf8' }), before);

  const authDirectory = path.join(gitCommonDir(root), 'singularity-flow/mcp/auth/playwright');
  const descriptor = JSON.parse(await readFile(path.join(authDirectory, 'active.json'), 'utf8'));
  assert.deepEqual(Object.keys(descriptor).sort(), [
    'profileId', 'schemaVersion', 'serverId', 'storageStateSha256'
  ]);
  assert.equal(JSON.stringify(descriptor).includes(SECRET), false);
  assert.equal(JSON.stringify(descriptor).includes(source), false);
  const copied = path.join(authDirectory, 'states', `poc-test-account-${preview.storageStateSha256.slice(7)}.json`);
  assert.equal(JSON.parse(await readFile(copied, 'utf8')).cookies[0].value, SECRET);
  if (process.platform !== 'win32') {
    assert.equal((await stat(authDirectory)).mode & 0o077, 0);
    assert.equal((await stat(copied)).mode & 0o077, 0);
    await chmod(copied, 0o644);
    const exposed = await playwrightAuthProfileStatus(root);
    assert.equal(exposed.status, 'invalid');
    assert.equal(exposed.reason, 'MCP_AUTH_PROFILE_PERMISSIONS');
    await chmod(copied, 0o600);
  }

  const baseEntry = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.79', '--isolated'] };
  const runtime = await resolvePlaywrightAuthRuntime(root, baseEntry);
  assert.deepEqual(baseEntry.args, ['-y', '@playwright/mcp@0.0.79', '--isolated']);
  assert.equal(runtime.entry.args.at(-2), '--storage-state');
  assert.equal(runtime.entry.args.at(-1), copied);
  assert.deepEqual(runtime.authProfile, {
    profileId: 'poc-test-account', storageStateSha256: preview.storageStateSha256
  });
  await assert.rejects(() => resolvePlaywrightAuthRuntime(root, {
    command: 'npx', args: ['-y', '@playwright/mcp@0.0.79', '--storage-state', '/unmanaged/state.json']
  }), (error) => error.code === 'MCP_AUTH_HOST_CONFLICT');
});

test('Playwright auth import rejects traversal, symbolic links, malformed state, and unsafe private ancestors', async () => {
  const root = await repository();
  const source = await sourceFile();
  await assert.rejects(() => previewPlaywrightAuthImport(root, {
    storageState: source, profileId: '../escape'
  }), (error) => error.code === 'MCP_AUTH_PROFILE_INVALID');

  const linked = `${source}.link`;
  await symlink(source, linked);
  await assert.rejects(() => previewPlaywrightAuthImport(root, {
    storageState: linked, profileId: 'safe-profile'
  }), (error) => error.code === 'MCP_AUTH_STORAGE_STATE_UNSAFE');

  const malformed = `${source}.malformed`;
  await writeFile(malformed, JSON.stringify({ cookies: {}, origins: [] }));
  await assert.rejects(() => previewPlaywrightAuthImport(root, {
    storageState: malformed, profileId: 'safe-profile'
  }), (error) => error.code === 'MCP_AUTH_STORAGE_STATE_INVALID');

  const preview = await previewPlaywrightAuthImport(root, {
    storageState: source, profileId: 'safe-profile'
  });
  await assert.rejects(() => importPlaywrightAuthProfile(root, {
    storageState: source, profileId: 'safe-profile', confirmation: 'safe-profile'
  }), (error) => error.code === 'MCP_AUTH_CONFIRMATION_REQUIRED');
  const oversized = `${source}.oversized`;
  await writeFile(oversized, Buffer.alloc((2 * 1024 * 1024) + 1, 0x20));
  await assert.rejects(() => previewPlaywrightAuthImport(root, {
    storageState: oversized, profileId: 'safe-profile'
  }), (error) => error.code === 'MCP_AUTH_STORAGE_STATE_LIMIT');
  const mcpDirectory = path.join(gitCommonDir(root), 'singularity-flow/mcp');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-auth-outside-'));
  await mkdir(mcpDirectory, { recursive: true });
  await symlink(outside, path.join(mcpDirectory, 'auth'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => importPlaywrightAuthProfile(root, {
    storageState: source, profileId: 'safe-profile', confirmation: preview.confirmation
  }), (error) => error.code === 'PRIVATE_SIDECAR_PATH_UNSAFE');
  assert.equal((await lstat(path.join(mcpDirectory, 'auth'))).isSymbolicLink(), true);
});

test('Windows auth ACL applies and verifies one current-user principal and fails closed otherwise', async (context) => {
  const sid = 'S-1-5-21-1000-2000-3000-1001';
  const environment = { SystemRoot: 'C:\\Windows' };
  function executor({ rules = [{ sid, type: 'Allow', inherited: false, rights: 2_032_127 }],
    failCommand = null, calls = [] } = {}) {
    return async (command, args, options) => {
      calls.push({ command, args, options });
      const executableName = path.win32.basename(command).toLowerCase();
      if (executableName === failCommand) throw new Error('fixture command failed');
      if (executableName === 'whoami.exe') return { stdout: `"OFFICE\\user","${sid}"\r\n`, stderr: '' };
      if (executableName === 'icacls.exe') return { stdout: 'Successfully processed 1 files\r\n', stderr: '' };
      if (executableName === 'powershell.exe') {
        return { stdout: JSON.stringify({ protected: true, rules }), stderr: '' };
      }
      throw new Error(`unexpected fixture command ${command}`);
    };
  }

  await context.test('applies and verifies without a shell', async () => {
    const calls = [];
    const result = await secureWindowsAuthAcl('C:\\private\\state.json', {
      directory: false, execFileCommand: executor({ calls }), environment
    });
    assert.deepEqual(result, { protected: true, principal: 'current-user', access: 'full-control' });
    assert.deepEqual(calls.map((call) => path.win32.basename(call.command).toLowerCase()), [
      'whoami.exe', 'icacls.exe', 'powershell.exe'
    ]);
    assert.ok(calls.every((call) => path.win32.isAbsolute(call.command)));
    assert.ok(calls[1].args.includes(`*${sid}:(F)`));
    assert.ok(calls.every((call) => call.options.shell === false));
  });

  for (const [label, rules] of [
    ['an inherited rule', [{ sid, type: 'Allow', inherited: true, rights: 2_032_127 }]],
    ['an extra principal', [
      { sid, type: 'Allow', inherited: false, rights: 2_032_127 },
      { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 2_032_127 }
    ]]
  ]) {
    await context.test(`refuses ${label}`, async () => {
      await assert.rejects(() => secureWindowsAuthAcl('C:\\private\\state.json', {
        apply: false, execFileCommand: executor({ rules }), environment
      }), (error) => error.code === 'MCP_AUTH_WINDOWS_ACL_UNSAFE');
    });
  }

  await context.test('refuses ACL command failure without disclosing its target', async () => {
    await assert.rejects(() => secureWindowsAuthAcl('C:\\private\\secret-state.json', {
      execFileCommand: executor({ failCommand: 'icacls.exe' }), environment
    }), (error) => {
      assert.equal(error.code, 'MCP_AUTH_WINDOWS_ACL_FAILED');
      assert.equal(error.message.includes('secret-state.json'), false);
      return true;
    });
  });

  await context.test('refuses non-local and ambiguous Windows system roots before execution', async () => {
    for (const unsafeEnvironment of [
      { SystemRoot: '\\Windows' },
      { SystemRoot: '\\\\server\\share\\Windows' },
      { SystemRoot: '\\\\?\\C:\\Windows' },
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    ]) {
      let executed = false;
      await assert.rejects(() => secureWindowsAuthAcl('C:\\private\\state.json', {
        execFileCommand: async () => { executed = true; return { stdout: '' }; },
        environment: unsafeEnvironment
      }), (error) => error.code === 'MCP_AUTH_WINDOWS_ACL_FAILED');
      assert.equal(executed, false);
    }
  });
});

test('Windows ACL protects and verifies a complete private MCP tree in one bounded traversal', async () => {
  const sid = 'S-1-5-21-1000-2000-3000-1001';
  const calls = [];
  const result = await secureWindowsAuthAcl('C:\\private\\mcp-package', {
    directory: true,
    recursive: true,
    environment: { SystemRoot: 'C:\\Windows' },
    execFileCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (path.win32.basename(command).toLowerCase() === 'whoami.exe') {
        return { stdout: `"OFFICE\\\\user","${sid}"\r\n`, stderr: '' };
      }
      if (path.win32.basename(command).toLowerCase() === 'powershell.exe') {
        assert.ok(args.includes('C:\\private\\mcp-package'));
        assert.ok(args.includes(sid));
        assert.ok(args.includes('apply'));
        return {
          stdout: JSON.stringify({ protected: true, entries: 37, unsafe: 0 }),
          stderr: ''
        };
      }
      throw new Error(`unexpected fixture command ${command}`);
    }
  });
  assert.deepEqual(result, {
    protected: true, principal: 'current-user', access: 'full-control',
    recursive: true, entries: 37
  });
  assert.deepEqual(calls.map((call) => path.win32.basename(call.command).toLowerCase()), [
    'whoami.exe', 'powershell.exe'
  ]);
  assert.ok(calls.every((call) => path.win32.isAbsolute(call.command)));
  assert.ok(calls.every((call) => call.options.shell === false));

  await assert.rejects(() => secureWindowsAuthAcl('C:\\private\\mcp-package', {
    directory: true,
    recursive: true,
    apply: false,
    environment: { SystemRoot: 'C:\\Windows' },
    execFileCommand: async (command) => path.win32.basename(command).toLowerCase() === 'whoami.exe'
      ? { stdout: `"OFFICE\\\\user","${sid}"\r\n`, stderr: '' }
      : { stdout: JSON.stringify({ protected: false, entries: 37, unsafe: 1 }), stderr: '' }
  }), (error) => error.code === 'MCP_AUTH_WINDOWS_ACL_UNSAFE');
});

test('Windows auth import uses injected user-only ACL protection', async () => {
  const root = await repository();
  const source = await sourceFile();
  const calls = [];
  const windowsAcl = async (target, options) => {
    calls.push({ target, ...options });
    return { protected: true, principal: 'current-user', access: 'full-control' };
  };
  const preview = await previewPlaywrightAuthImport(root, {
    storageState: source, profileId: 'windows-profile', platform: 'win32', windowsAcl
  });
  assert.equal(calls.length, 0, 'a new-profile preview does not create or protect private state');
  await importPlaywrightAuthProfile(root, {
    storageState: source, profileId: 'windows-profile', confirmation: preview.confirmation,
    platform: 'win32', windowsAcl
  });
  assert.equal(calls.filter((call) => call.apply === true && call.directory).length, 2);
  assert.equal(calls.filter((call) => call.apply === true && !call.directory).length, 2);
  assert.equal((await playwrightAuthProfileStatus(root, {
    platform: 'win32', windowsAcl
  })).status, 'configured');
  assert.ok(calls.some((call) => call.apply === false && call.directory));
  assert.ok(calls.some((call) => call.apply === false && !call.directory));
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: root, encoding: 'utf8'
  }), '');
});

test('corrupt private auth state has an exact-confirmation clear path', async () => {
  const root = await repository();
  const source = await sourceFile();

  const preview = await previewPlaywrightAuthImport(root, {
    storageState: source, profileId: 'recovery-profile'
  });
  await importPlaywrightAuthProfile(root, {
    storageState: source, profileId: 'recovery-profile', confirmation: preview.confirmation
  });
  const authDirectory = path.join(gitCommonDir(root), 'singularity-flow/mcp/auth/playwright');
  await writeFile(path.join(authDirectory, 'active.json'), '{broken-json', { mode: 0o600 });
  assert.equal((await playwrightAuthProfileStatus(root)).status, 'invalid');
  await assert.rejects(() => removePlaywrightAuthProfile(root, {
    profileId: 'recovery-profile', confirmation: preview.storageStateSha256
  }));
  const clearPreview = await previewClearPlaywrightAuthProfile(root);
  assert.equal(clearPreview.status, 'clear');
  assert.equal(clearPreview.stateFileCount, 1);
  assert.match(clearPreview.confirmation, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(() => clearPlaywrightAuthProfile(root, {
    confirmation: preview.storageStateSha256
  }), (error) => error.code === 'MCP_AUTH_CONFIRMATION_REQUIRED');
  const cleared = await clearPlaywrightAuthProfile(root, {
    confirmation: clearPreview.confirmation
  });
  assert.deepEqual(cleared, {
    status: 'cleared', serverId: 'playwright', removedStateFiles: 1
  });
  assert.equal((await playwrightAuthProfileStatus(root)).status, 'none');
  assert.equal(JSON.stringify(clearPreview).includes(SECRET), false);
});

test('auth replacement and removal stale host, warm, and smoke receipts without disclosing secrets', async () => {
  const root = await repository();
  const config = definition();
  await scaffoldPlaywrightMcp(root);
  const firstSource = await sourceFile('first-secret');
  const firstPreview = await previewPlaywrightAuthImport(root, {
    storageState: firstSource, profileId: 'first-profile'
  });
  await importPlaywrightAuthProfile(root, {
    storageState: firstSource, profileId: 'first-profile', confirmation: firstPreview.confirmation
  });
  await attestMcpHost(root, config, 'playwright', { confirmation: 'playwright' });
  assert.equal((await mcpDoctor(root, config)).servers[0].readiness, 'needs-host-setup');

  let runtimeStorageState = null;
  await warmMcpHost(root, config, 'playwright', {
    network: true,
    acquire: async () => ({
      status: 'reused', absoluteExecutable: '/machine/playwright-mcp.js',
      package: { name: '@playwright/mcp', version: '0.0.79', integrity: 'sha512-YWJjZA==', directory: 'packages/playwright/0.0.79' },
      resolvedExecutable: { path: 'packages/playwright/0.0.79/node_modules/@playwright/mcp/cli.js', sha256: 'a'.repeat(64) }
    }),
    revalidatePackage: async (_root, acquired) => acquired,
    offlineStart: async (_executable, args) => {
      runtimeStorageState = args[args.indexOf('--storage-state') + 1];
      return {
        status: 'passed', transport: 'stdio', packageResolution: 'local-install', npmOffline: true,
        protocolVersion: '2024-11-05', tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
      };
    }
  });
  assert.match(runtimeStorageState, /singularity-flow[/\\]mcp[/\\]auth[/\\]playwright[/\\]states/);

  await smokeMcpHost(root, config, 'playwright', {
    targetUrl: 'https://example.test/health',
    probe: async (entry, { url }) => {
      assert.equal(entry.args[entry.args.indexOf('--storage-state') + 1], runtimeStorageState);
      return {
        status: 'passed', finalUrl: url.toString(), finalOrigin: url.origin,
        tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
      };
    }
  });

  const secondSource = await sourceFile('second-secret');
  const secondPreview = await previewPlaywrightAuthImport(root, {
    storageState: secondSource, profileId: 'second-profile'
  });
  await importPlaywrightAuthProfile(root, {
    storageState: secondSource, profileId: 'second-profile', confirmation: secondPreview.confirmation
  });
  let report = await mcpDoctor(root, config);
  assert.equal(report.servers[0].readiness, 'needs-host-setup');
  assert.equal(report.servers[0].warm.status, 'stale');
  assert.equal(JSON.stringify(report).includes('first-secret'), false);
  assert.equal(JSON.stringify(report).includes('second-secret'), false);

  await attestMcpHost(root, config, 'playwright', { confirmation: 'playwright' });
  const workflow = {
    resolution: { mcpServers: config.mcpServers },
    mcpAuthorizations: {
      playwright: { origins: ['https://example.test'] }
    }
  };
  const phase = {
    id: 'verification',
    mcp: { requiredServers: ['playwright'], requireSmoke: true, evidence: [] }
  };
  await assert.rejects(() => assertMcpPhaseReadiness(root, workflow, phase), /live smoke receipt is stale/);

  await assert.rejects(() => removePlaywrightAuthProfile(root, {
    profileId: 'second-profile', confirmation: 'second-profile'
  }), (error) => error.code === 'MCP_AUTH_CONFIRMATION_REQUIRED');
  const removed = await removePlaywrightAuthProfile(root, {
    profileId: 'second-profile', confirmation: secondPreview.storageStateSha256
  });
  assert.equal(removed.status, 'removed');
  assert.equal((await playwrightAuthProfileStatus(root)).status, 'none');
  report = await mcpDoctor(root, config);
  assert.equal(report.servers[0].readiness, 'needs-host-setup');
});

test('managed authentication makes a raw npx host explicitly misconfigured', async () => {
  const root = await repository();
  const config = definition();
  await mkdir(path.join(root, '.vscode'), { recursive: true });
  await writeFile(path.join(root, '.vscode/mcp.json'), `${JSON.stringify({
    servers: {
      playwright: {
        type: 'stdio', command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.79', ...PLAYWRIGHT_MCP_HOST_ARGUMENTS]
      }
    }
  }, null, 2)}\n`);
  const source = await sourceFile();
  const preview = await previewPlaywrightAuthImport(root, {
    storageState: source, profileId: 'managed-profile'
  });
  await importPlaywrightAuthProfile(root, {
    storageState: source, profileId: 'managed-profile', confirmation: preview.confirmation
  });
  const report = await mcpDoctor(root, config);
  assert.equal(report.servers[0].readiness, 'misconfigured');
  assert.match(report.servers[0].reasons.join('\n'), /requires the SFlow host wrapper/);
});

test('authenticated smoke preserves the final-origin refusal', async () => {
  const root = await repository();
  const config = definition();
  await scaffoldPlaywrightMcp(root);
  const source = await sourceFile();
  const preview = await previewPlaywrightAuthImport(root, {
    storageState: source, profileId: 'origin-profile'
  });
  await importPlaywrightAuthProfile(root, {
    storageState: source, profileId: 'origin-profile', confirmation: preview.confirmation
  });
  await assert.rejects(() => smokeMcpHost(root, config, 'playwright', {
    targetUrl: 'https://example.test/health',
    probe: async (entry) => {
      assert.ok(entry.args.includes('--storage-state'));
      return {
        status: 'passed', finalUrl: 'https://login.example.test/', finalOrigin: 'https://login.example.test',
        tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
      };
    }
  }), (error) => error.code === 'MCP_SMOKE_ORIGIN_DRIFT');
});

test('MCP probe requires consent, performs only reachability, and writes no receipt', async () => {
  const root = await repository();
  const config = definition();
  await scaffoldPlaywrightMcp(root);
  await assert.rejects(() => probeMcpHost(root, config, 'playwright'),
    (error) => error.code === 'MCP_NETWORK_CONSENT_REQUIRED');
  const before = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: root, encoding: 'utf8' });
  const result = await probeMcpHost(root, config, 'playwright', {
    network: true,
    probe: async () => ({
      status: 'reachable', package: '@playwright/mcp', requestedVersion: '0.0.79', resolvedVersion: '0.0.79'
    })
  });
  assert.equal(result.network.status, 'reachable');
  await assert.rejects(() => probeMcpHost(root, config, 'playwright', {
    network: true, probe: async () => ({ status: 'not-probed', reason: 'unsupported-transport' })
  }), (error) => error.code === 'MCP_NETWORK_PROBE_FAILED');
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: root, encoding: 'utf8' }), before);
  const localMcp = path.join(gitCommonDir(root), 'singularity-flow/mcp');
  await assert.rejects(() => stat(localMcp), (error) => error.code === 'ENOENT');
});

test('CLI auth preview and status remain structured and redact source path and secret values', async () => {
  const root = await repository();
  await initializeDefinition(root);
  const source = await sourceFile();
  const previewRun = spawnSync(process.execPath, [
    executable, 'mcp', 'auth', 'import', 'playwright', '--storage-state', source,
    '--profile', 'cli-profile', '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(previewRun.status, 0, previewRun.stderr);
  const preview = JSON.parse(previewRun.stdout);
  assert.equal(preview.status, 'create');
  assert.equal(`${previewRun.stdout}${previewRun.stderr}`.includes(SECRET), false);
  assert.equal(`${previewRun.stdout}${previewRun.stderr}`.includes(source), false);

  const refusedRun = spawnSync(process.execPath, [
    executable, 'mcp', 'auth', 'import', 'playwright', '--storage-state', source,
    '--profile', 'cli-profile', '--confirm', 'cli-profile', '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(refusedRun.status, 0);
  assert.equal(`${refusedRun.stdout}${refusedRun.stderr}`.includes(SECRET), false);
  assert.equal(`${refusedRun.stdout}${refusedRun.stderr}`.includes(source), false);

  const importRun = spawnSync(process.execPath, [
    executable, 'mcp', 'auth', 'import', 'playwright', '--storage-state', source,
    '--profile', 'cli-profile', '--confirm', preview.storageStateSha256, '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(importRun.status, 0, importRun.stderr);
  assert.equal(`${importRun.stdout}${importRun.stderr}`.includes(SECRET), false);
  assert.equal(`${importRun.stdout}${importRun.stderr}`.includes(source), false);

  const statusRun = spawnSync(process.execPath, [
    executable, 'mcp', 'auth', 'status', 'playwright', '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(statusRun.status, 0, statusRun.stderr);
  assert.deepEqual(JSON.parse(statusRun.stdout), {
    status: 'configured', serverId: 'playwright', profileId: 'cli-profile',
    storageStateSha256: preview.storageStateSha256
  });
});
