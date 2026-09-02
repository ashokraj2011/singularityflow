import assert from 'node:assert/strict';
import {
  lstat, mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  assertMcpPhaseReadiness,
  attestMcpHost,
  mcpDoctor,
  mcpHostInventory,
  mcpServersForContext,
  mcpStatus,
  normalizeMcpServers,
  importPlaywrightAuthProfile,
  previewPlaywrightAuthImport,
  recordMcpEvidence,
  serveMcpHost,
  smokeMcpHost,
  verifyMcpHostOffline,
  warmMcpHost,
  verifyMcpEvidence,
  verifyPhaseMcpRequirements,
  renderMcpPromptPolicy,
  scaffoldPlaywrightMcp,
  validateMcpAgentTools
} from '../src/mcp.mjs';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { doctorSnapshot } from '../src/doctor.mjs';
import { canonicalJson } from '../src/records.mjs';
import { gitCommonDir } from '../src/git.mjs';
import {
  defaultNetworkProbe, rpcSmoke, verifyPlaywrightOfflineStart
} from '../src/mcp-readiness.mjs';

const configured = () => normalizeMcpServers({
  playwright: {
    label: 'Playwright', hostReference: 'playwright', agents: ['qa'], phases: ['verification'],
    tools: ['browser_navigate', 'browser_take_screenshot'], required: true, approval: 'confirm',
    evidence: { captureToolCalls: true, captureResults: true }
  }
}, { agents: ['qa'], phases: ['verification'] });

async function repository(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  return root;
}

async function warmPlaywrightFixture(root, definition, { offlineStart = null } = {}) {
  return warmMcpHost(root, definition, 'playwright', {
    network: true,
    execFileCommand: async (_command, args) => {
      const prefix = args[args.indexOf('--prefix') + 1];
      const packageDirectory = path.join(prefix, 'node_modules/@playwright/mcp');
      const transitiveDirectory = path.join(prefix, 'node_modules/playwright-mcp-fixture-dependency');
      await mkdir(packageDirectory, { recursive: true });
      await mkdir(transitiveDirectory, { recursive: true });
      await writeFile(path.join(packageDirectory, 'package.json'), `${JSON.stringify({
        name: '@playwright/mcp', version: '0.0.79', bin: { 'playwright-mcp': 'cli.js' }
      })}\n`);
      await writeFile(path.join(packageDirectory, 'cli.js'), 'process.stdout.write("fixture")\n');
      await writeFile(path.join(transitiveDirectory, 'package.json'), `${JSON.stringify({
        name: 'playwright-mcp-fixture-dependency', version: '1.0.0', main: 'index.js'
      })}\n`);
      await writeFile(path.join(transitiveDirectory, 'index.js'), 'export const fixture = true;\n');
      await writeFile(path.join(prefix, 'package-lock.json'), `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/@playwright/mcp': {
            version: '0.0.79', integrity: 'sha512-YWJjZA=='
          },
          'node_modules/playwright-mcp-fixture-dependency': {
            version: '1.0.0', integrity: 'sha512-ZGVwZW5kZW5jeQ=='
          }
        }
      })}\n`);
      return { stdout: '', stderr: '' };
    },
    offlineStart: offlineStart ?? (async () => ({
      status: 'passed', transport: 'stdio', packageResolution: 'local-install',
      npmOffline: true, protocolVersion: '2024-11-05',
      tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
    }))
  });
}

function successfulMcpProcess(finalUrl, onKill = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = (signal) => {
    onKill(signal);
    child.killed = true;
    child.stdout.end(); child.stderr.end(); child.stdin.end();
    setImmediate(() => child.emit('close', 0, signal));
    return true;
  };
  child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).trim().split(/\r?\n/)) {
      const request = JSON.parse(line);
      if (request.id == null) continue;
      let value = {};
      if (request.method === 'initialize') value = { protocolVersion: '2024-11-05' };
      if (request.method === 'tools/list') value = { tools: [
        { name: 'browser_navigate' }, { name: 'browser_snapshot' }, { name: 'browser_close' }
      ] };
      if (request.method === 'tools/call' && request.params.name === 'browser_snapshot') {
        value = { content: [{ type: 'text', text: `- Page URL: ${finalUrl}` }] };
      }
      setImmediate(() => child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: value
      })}\n`));
    }
  });
  return child;
}

test('MCP package readiness and smoke resolve Windows npm shims without shell mode', async () => {
  const environment = {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    SystemRoot: 'C:\\Windows'
  };
  const execCalls = [];
  const ready = await defaultNetworkProbe({
    command: 'npx', args: ['-y', '@playwright/mcp@0.0.79']
  }, {
    platform: 'win32', environment,
    platformLookupCommand(command, args, options) {
      assert.equal(command, 'C:\\Windows\\System32\\where.exe');
      assert.deepEqual(args, ['$PATH:npm.cmd']);
      assert.equal(options.shell, false);
      return {
        status: 0,
        stdout: '.\\npm.cmd\r\nC:\\Program Files\\nodejs\\npm.cmd\r\n',
        stderr: ''
      };
    },
    execFileCommand: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return { stdout: '"0.0.79"\n', stderr: '' };
    }
  });
  assert.equal(ready.status, 'reachable');
  assert.equal(execCalls[0].command, environment.ComSpec);
  assert.match(execCalls[0].args.join(' '), /Program\^ Files.*npm\.cmd/);
  assert.equal(execCalls[0].options.shell, false);
  assert.equal(execCalls[0].options.windowsVerbatimArguments, true);

  const spawnCalls = [];
  await assert.rejects(() => rpcSmoke({
    kind: 'managed-playwright',
    runtimeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    resolvedExecutable: 'C:\\workspace\\.git\\singularity-flow\\mcp\\packages\\playwright\\0.0.79\\cli.js',
    hostArguments: ['--isolated', '--headless'],
    package: {
      name: '@playwright/mcp', version: '0.0.79', integrity: 'sha512-YWJjZA==',
      closure: { sha256: `sha256:${'b'.repeat(64)}`, fileCount: 3, totalBytes: 100 }
    },
    resolvedExecutableSha256: 'a'.repeat(64)
  }, {
    url: new URL('https://example.test'), cwd: 'C:\\workspace',
    platform: 'win32', environment,
    spawnCommand(command, args, options) {
      spawnCalls.push({ command, args, options });
      throw new Error('fixture stops after launch inspection');
    }
  }), /fixture stops after launch inspection/);
  assert.equal(spawnCalls[0].command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.match(spawnCalls[0].args[0], /playwright\\0\.0\.79\\cli\.js/);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(spawnCalls[0].options.detached, false);
});

test('live Playwright smoke uses only the managed package, bounds output, and verifies process quiescence', async (context) => {
  const runtime = {
    kind: 'managed-playwright',
    runtimeExecutable: '/runtime/node',
    resolvedExecutable: '/git-local/playwright/cli.js',
    hostArguments: ['--isolated', '--headless'],
    package: {
      name: '@playwright/mcp', version: '0.0.79', integrity: 'sha512-YWJjZA==',
      closure: { sha256: `sha256:${'b'.repeat(64)}`, fileCount: 3, totalBytes: 100 }
    },
    resolvedExecutableSha256: 'a'.repeat(64)
  };

  assert.throws(() => rpcSmoke({
    command: 'npx', args: ['-y', '@playwright/mcp@0.0.79']
  }, { url: new URL('https://example.test') }), (error) => error.code === 'MCP_SMOKE_UNSUPPORTED_HOST');

  await context.test('successful direct launch and process-tree close', async () => {
    const launches = [];
    const signals = [];
    const result = await rpcSmoke(runtime, {
      url: new URL('https://example.test/health'), cwd: '/repository', platform: 'linux',
      timeoutMs: 2_000,
      spawnCommand(command, args, options) {
        launches.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.killed = false;
        child.kill = (signal) => {
          signals.push(signal);
          child.killed = true;
          child.stdout.end(); child.stderr.end(); child.stdin.end();
          setImmediate(() => child.emit('close', 0, signal));
          return true;
        };
        child.stdin.on('data', (chunk) => {
          for (const line of String(chunk).trim().split(/\r?\n/)) {
            const request = JSON.parse(line);
            if (request.id == null) continue;
            let value = {};
            if (request.method === 'initialize') value = { protocolVersion: '2024-11-05' };
            if (request.method === 'tools/list') value = { tools: [
              { name: 'browser_navigate' }, { name: 'browser_snapshot' }, { name: 'browser_close' }
            ] };
            if (request.method === 'tools/call' && request.params.name === 'browser_snapshot') {
              value = { content: [{ type: 'text', text: '- Page URL: https://example.test/health' }] };
            }
            setImmediate(() => child.stdout.write(`${JSON.stringify({
              jsonrpc: '2.0', id: request.id, result: value
            })}\n`));
          }
        });
        return child;
      }
    });
    assert.equal(result.status, 'passed');
    assert.equal(launches[0].command, '/runtime/node');
    assert.deepEqual(launches[0].args, [
      '/git-local/playwright/cli.js', '--isolated', '--headless'
    ]);
    assert.equal(launches[0].options.env.NPM_CONFIG_OFFLINE, 'true');
    assert.equal(launches[0].options.detached, true);
    assert.deepEqual(signals, ['SIGTERM']);
  });

  const hostileProcess = (output, { close = true } = {}) => () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      if (close) setImmediate(() => child.emit('close', 0, signal));
      return true;
    };
    child.stdin.once('data', () => setImmediate(() => child.stdout.write(output)));
    return child;
  };
  await context.test('cumulative output and malformed JSON fail closed', async () => {
    await assert.rejects(() => rpcSmoke(runtime, {
      url: new URL('https://example.test'), timeoutMs: 1_000,
      outputMaxBytes: 64, lineMaxBytes: 32,
      spawnCommand: hostileProcess(Buffer.alloc(65, 0x61))
    }), /exceeded the 64-byte smoke output ceiling/);
    await assert.rejects(() => rpcSmoke(runtime, {
      url: new URL('https://example.test'), timeoutMs: 1_000,
      spawnCommand: hostileProcess('not-json\n')
    }), /emitted malformed JSON during smoke/);
  });
  await context.test('unverified quiescence fails closed', async () => {
    await assert.rejects(() => rpcSmoke(runtime, {
      url: new URL('https://example.test/health'), timeoutMs: 1_000,
      terminationGraceMs: 10,
      spawnCommand: hostileProcess(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' }
      })}\n`, { close: false }),
      terminateTree: async () => true
    }), /process-tree quiescence could not be verified|timed out/);
  });
});

test('Playwright warm acquires the exact package locally and doctor detects executable drift', async () => {
  const root = await repository('sflow-mcp-warm-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  await attestMcpHost(root, definition, 'playwright', { confirmation: 'playwright' });
  const before = await mcpDoctor(root, definition);
  assert.equal(before.servers[0].readiness, 'needs-host-setup');
  assert.equal(before.servers[0].warm.status, 'not-warmed');
  assert.match(before.servers[0].reasons.join('\n'), /mcp warm playwright --network/);

  const npmCalls = [];
  const offlineStart = async (executable, args, options) => {
    assert.match(executable, /node_modules[/\\]@playwright[/\\]mcp[/\\]cli\.js$/);
    assert.equal(args.includes('@playwright/mcp@0.0.79'), false, 'the local entry point receives host options, not an npx package request');
    assert.equal(options.cwd, root);
    return {
      status: 'passed', transport: 'stdio', packageResolution: 'local-install',
      npmOffline: true, protocolVersion: '2024-11-05',
      tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
    };
  };
  const receipt = await warmMcpHost(root, definition, 'playwright', {
    network: true,
    platform: 'linux',
    architecture: 'fixture-arch',
    runtimeExecutable: process.execPath,
    runtimeVersion: 'v20.99.0-fixture',
    execFileCommand: async (command, args, options) => {
      npmCalls.push({ command, args, options });
      const prefix = args[args.indexOf('--prefix') + 1];
      const packageDirectory = path.join(prefix, 'node_modules/@playwright/mcp');
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(path.join(packageDirectory, 'package.json'), `${JSON.stringify({
        name: '@playwright/mcp', version: '0.0.79', bin: { 'playwright-mcp': 'cli.js' }
      })}\n`);
      await writeFile(path.join(packageDirectory, 'cli.js'), 'process.stdout.write("fixture")\n');
      await writeFile(path.join(prefix, 'package-lock.json'), `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/@playwright/mcp': {
            version: '0.0.79', integrity: 'sha512-YWJjZA=='
          }
        }
      })}\n`);
      return { stdout: '', stderr: '' };
    },
    offlineStart
  });
  assert.equal(npmCalls.length, 1);
  assert.equal(npmCalls[0].command, 'npm');
  assert.equal(npmCalls[0].options.shell, false);
  assert.ok(npmCalls[0].args.includes('@playwright/mcp@0.0.79'));
  assert.equal(receipt.receiptKind, 'package-warm');
  assert.equal(receipt.package.version, '0.0.79');
  assert.equal(receipt.package.integrity, 'sha512-YWJjZA==');
  assert.equal(receipt.runtime.architecture, 'fixture-arch');
  assert.equal(receipt.offlineStart.status, 'passed');
  assert.equal(path.isAbsolute(receipt.resolvedExecutable.path), false);
  const reused = await warmMcpHost(root, definition, 'playwright', {
    network: true, platform: 'linux', architecture: 'fixture-arch',
    runtimeExecutable: process.execPath, runtimeVersion: 'v20.99.0-fixture',
    execFileCommand: async () => { throw new Error('valid local acquisition must be reused'); },
    offlineStart
  });
  assert.equal(reused.acquisition.status, 'reused');
  assert.equal(npmCalls.length, 1);

  const ready = await mcpDoctor(root, definition, {
    platform: 'linux', architecture: 'fixture-arch',
    runtimeExecutable: process.execPath, runtimeVersion: 'v20.99.0-fixture'
  });
  assert.equal(ready.servers[0].readiness, 'ready');
  assert.equal(ready.servers[0].warm.status, 'valid');
  const executable = path.join(
    execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim(),
    'singularity-flow/mcp', receipt.resolvedExecutable.path
  );
  await writeFile(executable, 'changed after verification\n');
  const stale = await mcpDoctor(root, definition, {
    platform: 'linux', architecture: 'fixture-arch',
    runtimeExecutable: process.execPath, runtimeVersion: 'v20.99.0-fixture'
  });
  assert.equal(stale.servers[0].readiness, 'needs-host-setup');
  assert.equal(stale.servers[0].warm.status, 'stale');
  assert.match(stale.servers[0].warm.reason, /executable changed/);
});

test('Playwright warm binds the production dependency closure and detects transitive tampering', async () => {
  const root = await repository('sflow-mcp-warm-transitive-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  await attestMcpHost(root, definition, 'playwright', { confirmation: 'playwright' });
  const receipt = await warmPlaywrightFixture(root, definition);
  assert.match(receipt.package.closure.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(receipt.package.closure.fileCount >= 5);
  const packageRoot = path.join(
    gitCommonDir(root), 'singularity-flow/mcp', receipt.package.directory
  );
  await writeFile(
    path.join(packageRoot, 'node_modules/playwright-mcp-fixture-dependency/index.js'),
    'export const fixture = "tampered";\n'
  );
  const stale = await mcpDoctor(root, definition);
  assert.equal(stale.servers[0].readiness, 'needs-host-setup');
  assert.equal(stale.servers[0].warm.status, 'stale');
  assert.match(stale.servers[0].warm.reason, /acquired package or its executable changed/);
  await assert.rejects(() => smokeMcpHost(root, definition, 'playwright', {
    targetUrl: 'https://example.test/health'
  }), (error) => error.code === 'MCP_WARM_REQUIRED');
});

test('Windows Playwright acquisition recursively secures the cache and re-verifies it before offline start', async () => {
  const root = await repository('sflow-mcp-windows-cache-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  const aclCalls = [];
  let staging = null;
  let offlineStarts = 0;
  const windowsAcl = async (target, options) => {
    aclCalls.push({ target, ...options });
    if (options.recursive && options.apply && path.basename(target).startsWith('.acquire-')) {
      staging = target;
    }
    return options.recursive
      ? { protected: true, principal: 'current-user', access: 'full-control', recursive: true, entries: 6 }
      : { protected: true, principal: 'current-user', access: 'full-control' };
  };
  const receipt = await warmMcpHost(root, definition, 'playwright', {
    network: true,
    platform: 'win32',
    environment: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemRoot: 'C:\\Windows'
    },
    platformLookupCommand: () => ({
      status: 0, stdout: 'C:\\Program Files\\nodejs\\npm.cmd\r\n', stderr: ''
    }),
    windowsAcl,
    execFileCommand: async () => {
      assert.ok(staging, 'the staging directory must be protected before npm starts');
      const packageDirectory = path.join(staging, 'node_modules/@playwright/mcp');
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(path.join(packageDirectory, 'package.json'), `${JSON.stringify({
        name: '@playwright/mcp', version: '0.0.79', bin: { 'playwright-mcp': 'cli.js' }
      })}\n`);
      await writeFile(path.join(packageDirectory, 'cli.js'), 'process.stdout.write("fixture")\n');
      await writeFile(path.join(staging, 'package-lock.json'), `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/@playwright/mcp': {
            version: '0.0.79', integrity: 'sha512-YWJjZA=='
          }
        }
      })}\n`);
      return { stdout: '', stderr: '' };
    },
    offlineStart: async () => {
      offlineStarts += 1;
      return {
        status: 'passed', transport: 'stdio', packageResolution: 'local-install',
        npmOffline: true, protocolVersion: '2024-11-05',
        tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
      };
    }
  });
  assert.equal(receipt.acquisition.status, 'acquired');
  assert.equal(offlineStarts, 1);
  assert.ok(aclCalls.some((call) => call.recursive === true && call.apply === true
    && call.target.endsWith(path.join('playwright', '0.0.79'))));
  assert.ok(aclCalls.some((call) => call.recursive === true && call.apply === false
    && call.target.endsWith(path.join('playwright', '0.0.79'))),
  'the exact published tree must be verified again at the launch boundary');
  const cacheRoot = path.join(gitCommonDir(root), 'singularity-flow/mcp');
  assert.ok(aclCalls.every((call) => call.target === cacheRoot
    || call.target.startsWith(`${cacheRoot}${path.sep}`)));
});

test('managed Playwright launch revalidation blocks ACL failure and verify-to-spawn replacement', async (context) => {
  await context.test('Windows ACL verification fails before any process starts', async () => {
    const root = await repository('sflow-mcp-windows-acl-refusal-');
    const definition = { mcpServers: configured() };
    await scaffoldPlaywrightMcp(root);
    await warmPlaywrightFixture(root, definition);
    let starts = 0;
    await assert.rejects(() => smokeMcpHost(root, definition, 'playwright', {
      targetUrl: 'https://example.test/health',
      platform: 'win32',
      windowsAcl: async (_target, options) => {
        if (options.recursive) {
          const error = new Error('unsafe ACL fixture');
          error.code = 'MCP_AUTH_WINDOWS_ACL_UNSAFE';
          throw error;
        }
        return { protected: true, principal: 'current-user', access: 'full-control' };
      },
      spawnCommand() { starts += 1; throw new Error('must not spawn'); }
    }), (error) => error.code === 'MCP_WARM_REQUIRED');
    assert.equal(starts, 0);
  });

  await context.test('same-byte executable replacement is rejected by launch identity', async () => {
    const root = await repository('sflow-mcp-launch-identity-');
    const definition = { mcpServers: configured() };
    await scaffoldPlaywrightMcp(root);
    await warmPlaywrightFixture(root, definition);
    let starts = 0;
    await assert.rejects(() => smokeMcpHost(root, definition, 'playwright', {
      targetUrl: 'https://example.test/health',
      beforeLaunchValidation: async ({ packageDirectory }) => {
        const executable = path.join(packageDirectory, 'node_modules/@playwright/mcp/cli.js');
        const replacement = path.join(
          packageDirectory, 'node_modules/@playwright/mcp/cli.replacement.js'
        );
        await writeFile(replacement, await readFile(executable));
        await rename(replacement, executable);
      },
      spawnCommand() { starts += 1; throw new Error('must not spawn'); }
    }), (error) => error.code === 'MCP_WARM_PACKAGE_CHANGED');
    assert.equal(starts, 0);
  });

  await context.test('offline verification rechecks the closure after runtime preparation', async () => {
    const root = await repository('sflow-mcp-offline-closure-');
    const definition = { mcpServers: configured() };
    await scaffoldPlaywrightMcp(root);
    await warmPlaywrightFixture(root, definition);
    let starts = 0;
    await assert.rejects(() => verifyMcpHostOffline(root, definition, 'playwright', {
      beforeLaunchValidation: async ({ packageDirectory }) => {
        await writeFile(
          path.join(packageDirectory, 'node_modules/playwright-mcp-fixture-dependency/index.js'),
          'export const fixture = "changed before offline start";\n'
        );
      },
      offlineStart: async () => {
        starts += 1;
        throw new Error('must not start');
      }
    }), (error) => error.code === 'MCP_WARM_PACKAGE_CHANGED');
    assert.equal(starts, 0);
  });

  await context.test('transitive closure replacement is rejected before managed serving', async () => {
    const root = await repository('sflow-mcp-serve-closure-');
    const definition = { mcpServers: configured() };
    await scaffoldPlaywrightMcp(root);
    await warmPlaywrightFixture(root, definition);
    let starts = 0;
    await assert.rejects(() => serveMcpHost(root, definition, 'playwright', {
      beforeLaunchValidation: async ({ packageDirectory }) => {
        await writeFile(
          path.join(packageDirectory, 'node_modules/playwright-mcp-fixture-dependency/index.js'),
          'export const fixture = "changed before spawn";\n'
        );
      },
      spawnCommand() { starts += 1; throw new Error('must not spawn'); }
    }), (error) => error.code === 'MCP_WARM_PACKAGE_CHANGED');
    assert.equal(starts, 0);
  });
});

test('linked worktrees use the Git-common managed package, output, and auth path for smoke and host serving', async () => {
  const root = await repository('sflow-mcp-linked-main-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  execFileSync('git', ['add', '.vscode/mcp.json'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'mcp host'], { cwd: root });
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-linked-'));
  const linked = path.join(parent, 'story');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'story-mcp', linked], { cwd: root });
  assert.equal((await lstat(path.join(linked, '.git'))).isFile(), true);

  const source = path.join(parent, 'storage-state.json');
  await writeFile(source, `${JSON.stringify({ cookies: [], origins: [] })}\n`, { mode: 0o600 });
  const authPreview = await previewPlaywrightAuthImport(linked, {
    storageState: source, profileId: 'linked-profile'
  });
  await importPlaywrightAuthProfile(linked, {
    storageState: source, profileId: 'linked-profile', confirmation: authPreview.confirmation
  });

  let warmArguments = null;
  await warmPlaywrightFixture(linked, definition, {
    offlineStart: async (_executable, args) => {
      warmArguments = args;
      return {
        status: 'passed', transport: 'stdio', packageResolution: 'local-install',
        npmOffline: true, protocolVersion: '2024-11-05',
        tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
      };
    }
  });
  const common = gitCommonDir(linked);
  const expectedOutput = path.join(common, 'singularity-flow/mcp/playwright-output');
  const expectedAuthPrefix = path.join(common, 'singularity-flow/mcp/auth/playwright/states');
  assert.equal(warmArguments[warmArguments.indexOf('--output-dir') + 1], expectedOutput);
  assert.ok(warmArguments[warmArguments.indexOf('--storage-state') + 1].startsWith(expectedAuthPrefix));

  const verified = await verifyMcpHostOffline(linked, definition, 'playwright', {
    offlineStart: async (_executable, args) => {
      assert.equal(args[args.indexOf('--output-dir') + 1], expectedOutput);
      return {
        status: 'passed', transport: 'stdio', packageResolution: 'local-install',
        npmOffline: true, protocolVersion: '2024-11-05',
        tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
      };
    }
  });
  assert.equal(verified.acquisition.status, 'reused');

  const smokeLaunches = [];
  await smokeMcpHost(linked, definition, 'playwright', {
    targetUrl: 'https://example.test/health',
    spawnCommand(command, args, options) {
      smokeLaunches.push({ command, args, options });
      return successfulMcpProcess('https://example.test/health');
    }
  });
  assert.equal(smokeLaunches[0].command, process.execPath);
  assert.equal(smokeLaunches[0].args.includes(expectedOutput), true);
  assert.equal(smokeLaunches[0].args.some((argument) => argument.startsWith(expectedAuthPrefix)), true);
  assert.equal(smokeLaunches[0].args.some((argument) => argument === 'npx'), false);

  const serveLaunches = [];
  const processControl = new EventEmitter();
  const served = await serveMcpHost(linked, definition, 'playwright', {
    processControl,
    spawnCommand(command, args, options) {
      serveLaunches.push({ command, args, options });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    }
  });
  assert.equal(served.status, 'closed');
  assert.equal(serveLaunches[0].command, process.execPath);
  assert.equal(serveLaunches[0].args.includes(expectedOutput), true);
  assert.equal(serveLaunches[0].args.some((argument) => argument.startsWith(expectedAuthPrefix)), true);
  assert.deepEqual(serveLaunches[0].options.stdio, ['inherit', 'inherit', 'inherit']);
  const trackedHost = await readFile(path.join(linked, '.vscode/mcp.json'), 'utf8');
  assert.equal(trackedHost.includes('--storage-state'), false);
  assert.equal(trackedHost.includes(source), false);
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: linked, encoding: 'utf8'
  }), '');
});

test('Playwright warm rejects a symlinked package parent before acquisition can escape Git state', async () => {
  const root = await repository('sflow-mcp-warm-link-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: root, encoding: 'utf8'
  }).trim();
  const packages = path.join(gitDirectory, 'singularity-flow/mcp/packages');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-outside-'));
  await writeFile(path.join(outside, 'sentinel'), 'unchanged\n');
  await mkdir(packages, { recursive: true });
  await symlink(outside, path.join(packages, 'playwright'), process.platform === 'win32' ? 'junction' : 'dir');
  let npmInvocations = 0;

  await assert.rejects(() => warmMcpHost(root, definition, 'playwright', {
    network: true,
    execFileCommand: async () => { npmInvocations += 1; },
    offlineStart: async () => { throw new Error('offline start must not run'); }
  }), (error) => error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE');
  assert.equal(npmInvocations, 0);
  assert.deepEqual(await readdir(outside), ['sentinel']);
});

test('MCP warm rejects a symlinked receipt directory instead of writing outside Git state', async () => {
  const root = await repository('sflow-mcp-warm-receipt-link-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: root, encoding: 'utf8'
  }).trim();
  const mcpDirectory = path.join(gitDirectory, 'singularity-flow/mcp');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-receipt-outside-'));
  await writeFile(path.join(outside, 'sentinel'), 'unchanged\n');
  await mkdir(mcpDirectory, { recursive: true });
  await symlink(outside, path.join(mcpDirectory, 'cache'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(() => warmMcpHost(root, definition, 'playwright', {
    network: true,
    acquire: async () => ({
      status: 'acquired',
      package: {
        name: '@playwright/mcp', version: '0.0.79', integrity: 'sha512-YWJjZA==',
        directory: 'packages/playwright/0.0.79'
      },
      resolvedExecutable: {
        path: 'packages/playwright/0.0.79/node_modules/@playwright/mcp/cli.js',
        sha256: 'a'.repeat(64)
      },
      absoluteExecutable: path.join(root, 'fixture-cli.js')
    }),
    revalidatePackage: async (_root, acquired) => acquired,
    offlineStart: async () => ({
      status: 'passed', packageResolution: 'local-install', npmOffline: true,
      protocolVersion: '2024-11-05',
      tools: ['browser_navigate', 'browser_snapshot', 'browser_close']
    })
  }), (error) => error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE');
  assert.deepEqual(await readdir(outside), ['sentinel']);
});

test('offline Playwright verification starts the resolved local entry point with npm offline', async () => {
  const calls = [];
  const terminationSignals = [];
  const result = await verifyPlaywrightOfflineStart('/machine-cache/playwright-cli.js', [
    '--isolated', '--headless'
  ], {
    runtimeExecutable: '/runtime/node', platform: 'linux', timeoutMs: 2_000,
    environment: { FIXTURE: 'yes' },
    spawnCommand(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.killed = false;
      child.kill = (signal) => {
        terminationSignals.push(signal);
        child.killed = true;
        child.stdout.end();
        child.stderr.end();
        child.stdin.end();
        setImmediate(() => child.emit('close', 0, signal));
        return true;
      };
      child.stdin.on('data', (chunk) => {
        for (const line of String(chunk).trim().split(/\r?\n/)) {
          const request = JSON.parse(line);
          if (request.id == null) continue;
          const resultValue = request.method === 'initialize'
            ? { protocolVersion: '2024-11-05' }
            : { tools: [
              { name: 'browser_navigate' }, { name: 'browser_snapshot' }, { name: 'browser_close' }
            ] };
          setImmediate(() => child.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0', id: request.id, result: resultValue
          })}\n`));
        }
      });
      return child;
    }
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.npmOffline, true);
  assert.equal(calls[0].command, '/runtime/node');
  assert.deepEqual(calls[0].args, [
    '/machine-cache/playwright-cli.js', '--isolated', '--headless'
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.NPM_CONFIG_OFFLINE, 'true');
  assert.equal(calls[0].options.env.npm_config_offline, 'true');
  assert.deepEqual(terminationSignals, ['SIGTERM']);
});

test('offline Playwright verification fails closed when process-tree quiescence is not observed', async () => {
  const treeSignals = [];
  const spawnCommand = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => true;
    child.stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split(/\r?\n/)) {
        const request = JSON.parse(line);
        if (request.id == null) continue;
        const response = request.method === 'initialize'
          ? { protocolVersion: '2024-11-05' }
          : { tools: [
            { name: 'browser_navigate' }, { name: 'browser_snapshot' }, { name: 'browser_close' }
          ] };
        setImmediate(() => child.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0', id: request.id, result: response
        })}\n`));
      }
    });
    return child;
  };
  await assert.rejects(() => verifyPlaywrightOfflineStart('/cache/cli.js', [], {
    runtimeExecutable: '/runtime/node', platform: 'linux', timeoutMs: 1_000,
    terminationGraceMs: 10, spawnCommand,
    terminateTree: async (_child, signal, options) => {
      treeSignals.push({ signal, platform: options.platform });
      return true;
    }
  }), /process-tree quiescence could not be verified/);
  assert.deepEqual(treeSignals, [
    { signal: 'SIGTERM', platform: 'linux' },
    { signal: 'SIGKILL', platform: 'linux' }
  ]);
});

test('offline Playwright verification bounds output and refuses malformed NDJSON', async (context) => {
  const hostileProcess = (output) => () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
      setImmediate(() => child.emit('close', 0, signal));
      return true;
    };
    child.stdin.once('data', () => setImmediate(() => child.stdout.write(output)));
    return child;
  };

  await context.test('cumulative output ceiling', async () => {
    await assert.rejects(() => verifyPlaywrightOfflineStart('/cache/cli.js', [], {
      runtimeExecutable: '/runtime/node', platform: 'linux', timeoutMs: 1_000,
      outputMaxBytes: 64, lineMaxBytes: 32,
      spawnCommand: hostileProcess(Buffer.alloc(65, 0x61))
    }), /exceeded the 64-byte verification output ceiling/);
  });

  await context.test('malformed protocol line', async () => {
    await assert.rejects(() => verifyPlaywrightOfflineStart('/cache/cli.js', [], {
      runtimeExecutable: '/runtime/node', platform: 'linux', timeoutMs: 1_000,
      spawnCommand: hostileProcess('not-json\n')
    }), /emitted malformed JSON during offline verification/);
  });
});

test('MCP registry validates agent, phase, tool, approval, and evidence declarations', () => {
  const result = configured();
  assert.deepEqual(result.playwright.tools, ['browser_navigate', 'browser_take_screenshot']);
  assert.equal(result.playwright.evidence.captureResults, true);
  assert.throws(() => normalizeMcpServers({ bad: { agents: ['missing'] } }, { agents: ['qa'] }), /unknown governed agent/);
  assert.throws(() => normalizeMcpServers({ bad: { phases: ['missing'] } }, { phases: ['verification'] }), /unknown phase/);
  assert.throws(() => normalizeMcpServers({ bad: { tools: ['playwright\/browser_navigate'] } }), /unqualified MCP tool name/);
  assert.throws(() => normalizeMcpServers({ bad: { approval: 'never' } }), /confirm or host/);
});

test('MCP evidence integrity detects changed captured output', async () => {
  const root = await repository('sflow-mcp-integrity-');
  const output = path.join(root, 'singularity/work-items/WORK-1/artifacts/verification/browser.txt');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, 'observed\n');
  const workflow = {
    workItem: { id: 'WORK-1' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: { generation: 0, status: 'in_progress' } },
    resolution: { mcpServers: configured() }
  };
  await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa',
    outputPath: path.relative(root, output)
  });
  const valid = await verifyMcpEvidence(root, workflow);
  assert.equal(valid.errors.length, 0);
  assert.match(valid.passes.join('\n'), /MCP evidence integrity: 1 record/);
  const recordedOutput = path.join(root, 'singularity/work-items/WORK-1', valid.records[0].output.path);
  await writeFile(recordedOutput, 'changed\n');
  const changed = await verifyMcpEvidence(root, workflow);
  assert.match(changed.errors.join('\n'), /output changed after capture/);
});

test('MCP routing composes only the active agent and phase tool policy', () => {
  const definition = { mcpServers: configured() };
  assert.equal(mcpServersForContext(definition, { agent: 'qa', phase: 'verification' }).length, 1);
  assert.equal(mcpServersForContext(definition, { agent: 'developer', phase: 'verification' }).length, 0);
  assert.equal(mcpServersForContext(definition, { agent: 'qa', phase: 'implementation' }).length, 0);
  const prompt = renderMcpPromptPolicy(definition, { agent: 'qa', phase: 'verification' });
  assert.match(prompt, /# Governed MCP tools/);
  assert.match(prompt, /`playwright\/browser_navigate`/);
  assert.match(prompt, /Never copy credentials/);
});

test('MCP assignments require matching custom-agent tool namespaces', () => {
  const definition = { mcpServers: configured(), agentCatalog: [{ id: 'qa', tools: ['read', 'playwright/*'] }] };
  assert.doesNotThrow(() => validateMcpAgentTools(definition));
  definition.agentCatalog[0].tools = ['read'];
  assert.throws(() => validateMcpAgentTools(definition), /Agent Markdown tools do not allow/);
});

test('MCP host inventory discovers workspace and user files without reading secret values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-home-'));
  await mkdir(path.join(root, '.vscode'), { recursive: true });
  await mkdir(path.join(home, '.copilot'), { recursive: true });
  await writeFile(path.join(root, '.vscode/mcp.json'), JSON.stringify({ servers: { playwright: { command: 'npx', env: { SECRET: 'do-not-return' } } } }));
  await writeFile(path.join(home, '.copilot/mcp-config.json'), JSON.stringify({ mcpServers: { corporate: { url: 'https://example.invalid', token: 'do-not-return' } } }));
  const inventory = await mcpHostInventory(root, { home });
  assert.deepEqual(inventory.map((row) => row.name).sort(), ['corporate', 'playwright']);
  assert.equal(JSON.stringify(inventory).includes('do-not-return'), false);
  const status = await mcpStatus(root, { mcpServers: configured() }, { home });
  assert.equal(status.servers[0].configured, true);
  assert.deepEqual(status.servers[0].sources, ['vscode-workspace']);
});

test('Playwright scaffold is explicit and never replaces host configuration silently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-scaffold-'));
  const result = await scaffoldPlaywrightMcp(root);
  assert.equal(result.path, '.vscode/mcp.json');
  const text = await readFile(path.join(root, result.path), 'utf8');
  assert.match(text, /@playwright\/mcp@0\.0\.79/);
  const playwright = JSON.parse(text).servers.playwright;
  assert.equal(playwright.command, 'singularity-flow');
  assert.deepEqual(playwright.args.slice(0, 5), [
    'mcp', 'serve', 'playwright', '--package', '@playwright/mcp@0.0.79'
  ]);
  assert.equal(playwright.args.includes('--storage-state'), false);
  for (const option of ['--isolated', '--headless', '--output-dir', '--output-max-size', '--viewport-size', '--timeout-action', '--timeout-navigation']) {
    assert.ok(playwright.args.includes(option), `${option} is missing from deterministic scaffold`);
  }
  const unchanged = await scaffoldPlaywrightMcp(root);
  assert.equal(unchanged.changed, false);
  const document = JSON.parse(text);
  document.servers.corporate = { type: 'http', url: 'https://mcp.example.test' };
  await writeFile(path.join(root, result.path), `${JSON.stringify(document, null, 2)}\n`);
  const merged = await scaffoldPlaywrightMcp(root);
  assert.equal(merged.changed, false);
  assert.ok(JSON.parse(await readFile(path.join(root, result.path))).servers.corporate);
});

test('phase readiness requires a hash-bound live smoke receipt when configured', async () => {
  const root = await repository('sflow-mcp-smoke-readiness-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  await attestMcpHost(root, definition, 'playwright', { confirmation: 'playwright' });
  const phase = { id: 'verification', mcp: { requiredServers: ['playwright'], requireSmoke: true, evidence: [] } };
  const workflow = {
    resolution: { mcpServers: definition.mcpServers },
    mcpAuthorizations: {
      playwright: { schemaVersion: 1, origins: ['https://example.test'], source: 'story-intake', pinnedAt: new Date().toISOString() }
    }
  };
  await assert.rejects(() => assertMcpPhaseReadiness(root, workflow, phase), /no valid exact-package warm proof/);
  await warmPlaywrightFixture(root, definition);
  await assert.rejects(() => assertMcpPhaseReadiness(root, workflow, phase), /no successful live smoke receipt/);
  const receipt = await smokeMcpHost(root, definition, 'playwright', {
    targetUrl: 'https://example.test/health',
    probe: async (_entry, { url }) => ({
      status: 'passed', tools: ['browser_navigate', 'browser_snapshot', 'browser_close'],
      finalUrl: url.toString(), finalOrigin: url.origin
    })
  });
  assert.equal(receipt.authorizedOrigin, 'https://example.test');
  await assert.doesNotReject(() => assertMcpPhaseReadiness(root, workflow, phase));
  const wrongOrigin = structuredClone(workflow);
  wrongOrigin.mcpAuthorizations.playwright.origins = ['https://staging.example.test'];
  await assert.rejects(() => assertMcpPhaseReadiness(root, wrongOrigin, phase), /not authorized for this Story/);
  await writeFile(receipt.path, `${JSON.stringify({ ...receipt, checkedAt: '2020-01-01T00:00:00.000Z' }, null, 2)}\n`);
  await assert.rejects(() => assertMcpPhaseReadiness(root, workflow, phase), /older than 24 hours/);
  await writeFile(receipt.path, `${JSON.stringify({
    ...receipt,
    result: { status: 'passed', tools: ['browser_navigate'] }
  }, null, 2)}\n`);
  await assert.rejects(() => assertMcpPhaseReadiness(root, workflow, phase), /receipt structure or server identity is invalid/);
  await assert.rejects(() => smokeMcpHost(root, definition, 'playwright', {
    targetUrl: 'https://example.test',
    probe: async () => ({
      status: 'passed', tools: ['browser_navigate', 'browser_snapshot', 'browser_close'],
      finalUrl: 'https://redirect.example.test/landing', finalOrigin: 'https://redirect.example.test'
    })
  }), /ended outside the authorized origin/);
  await assert.rejects(() => smokeMcpHost(root, definition, 'playwright', {
    targetUrl: 'https://user:secret@example.test/health', probe: async () => ({ status: 'passed' })
  }), /must not contain credentials/);
});

test('browser navigation evidence is bound to the Story-authorized origin', async () => {
  const root = await repository('sflow-mcp-origin-evidence-');
  await scaffoldPlaywrightMcp(root);
  const workflow = {
    workItem: { id: 'WORK-ORIGIN' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: {
      id: 'verification', generation: 0, status: 'in_progress',
      mcp: { evidence: [{ server: 'playwright', tool: 'browser_navigate', minimum: 1, outputRequired: false }] }
    } },
    resolution: { mcpServers: configured() },
    mcpAuthorizations: {
      playwright: { schemaVersion: 1, origins: ['https://staging.example.test'], source: 'story-intake', pinnedAt: new Date().toISOString() }
    }
  };
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa'
  }), /requires --target-url/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa',
    targetUrl: 'https://production.example.test'
  }), /outside this Story's authorization/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa',
    targetUrl: 'https://staging.example.test/checkout'
  }), /must come from a live Playwright MCP observation/);
  const smoke = await smokeMcpHost(root, { mcpServers: configured() }, 'playwright', {
    targetUrl: 'https://staging.example.test/checkout',
    evidence: { workflow, phase: 'verification', agent: 'qa' },
    probe: async (_entry, { url }) => ({
      status: 'passed', tools: ['browser_navigate', 'browser_snapshot', 'browser_close'],
      finalUrl: url.toString(), finalOrigin: url.origin,
      snapshotResult: {
        content: [{ type: 'text', text: `- Page URL: ${url.toString()}\n- heading "Checkout"` }]
      }
    })
  });
  assert.equal(smoke.evidence.navigation.targetOrigin, 'https://staging.example.test');
  assert.equal(smoke.evidence.snapshot.captureSource, 'observed-by-mcp-host');
  assert.equal(smoke.evidence.snapshot.observedFinalOrigin, 'https://staging.example.test');
  assert.equal(smoke.evidence.navigation.captureId, smoke.evidence.snapshot.captureId);
  const managedSnapshot = path.join(
    root, 'singularity/work-items/WORK-ORIGIN', smoke.evidence.snapshot.output.path
  );
  const exactBytes = await readFile(managedSnapshot, 'utf8');
  assert.equal(exactBytes, canonicalJson({
    content: [{ type: 'text', text: '- Page URL: https://staging.example.test/checkout\n- heading "Checkout"' }]
  }));
  assert.equal(JSON.stringify(smoke).includes('/checkout'), false, 'receipts must not persist target URL paths or query strings');
  const integrity = await verifyMcpEvidence(root, workflow);
  assert.equal(integrity.errors.length, 0, integrity.errors.join('\n'));
  assert.equal((await verifyPhaseMcpRequirements(root, workflow, workflow.phases.verification)).errors.length, 0);
  await writeFile(managedSnapshot, `${exactBytes} `);
  assert.match((await verifyMcpEvidence(root, workflow)).errors.join('\n'), /output changed after capture/);
  await writeFile(managedSnapshot, exactBytes);
  workflow.phases.verification.generation = 1;
  assert.match(
    (await verifyPhaseMcpRequirements(root, workflow, workflow.phases.verification)).errors.join('\n'),
    /generation 2 requires a live, host-observed navigation receipt/
  );
  const recordsDir = path.join(root, 'singularity/work-items/WORK-ORIGIN/context/mcp/records');
  await writeFile(path.join(recordsDir, `${smoke.evidence.navigation.id}-replay.json`),
    `${JSON.stringify({ ...smoke.evidence.navigation, id: `${smoke.evidence.navigation.id}-replay` }, null, 2)}\n`);
  assert.match(
    (await verifyMcpEvidence(root, workflow)).errors.join('\n'),
    /MCP_EVIDENCE_RECEIPT_REPLAYED/
  );
});

test('agent-supplied browser snapshots remain audit evidence but cannot establish origin', async () => {
  const root = await repository('sflow-mcp-snapshot-origin-');
  await mkdir(path.join(root, 'singularity/work-items/WORK-SNAPSHOT'), { recursive: true });
  const workflow = {
    workItem: { id: 'WORK-SNAPSHOT' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: {
      id: 'verification', generation: 0, status: 'in_progress',
      mcp: { evidence: [{ server: 'playwright', tool: 'browser_snapshot', minimum: 1, outputRequired: true }] }
    } },
    resolution: { mcpServers: normalizeMcpServers({
      playwright: {
        hostReference: 'playwright', agents: ['qa'], phases: ['verification'],
        tools: ['browser_snapshot'], evidence: { captureToolCalls: true, captureResults: true }
      }
    }, { agents: ['qa'], phases: ['verification'] }) },
    mcpAuthorizations: {
      playwright: { schemaVersion: 1, origins: ['https://staging.example.test'], source: 'story-intake', pinnedAt: new Date().toISOString() }
    }
  };
  await writeFile(path.join(root, 'wrong-snapshot.txt'), '- Page URL: https://production.example.test/checkout\n');
  const wrong = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_snapshot', phase: 'verification', agent: 'qa',
    outputPath: 'wrong-snapshot.txt'
  });
  assert.equal(wrong.record.captureSource, 'declared-by-agent');
  assert.equal(wrong.gateSatisfying, false);
  assert.equal(wrong.noticeCode, 'mcp.evidence-observation-required');
  assert.deepEqual(wrong.diagnosticCodes, ['MCP_EVIDENCE_OBSERVATION_REQUIRED']);
  assert.equal(await readFile(path.join(root, 'wrong-snapshot.txt'), 'utf8'), '- Page URL: https://production.example.test/checkout\n');
  await writeFile(path.join(root, 'right-snapshot.txt'), '- Page URL: https://staging.example.test/checkout?state=ready\n');
  const recorded = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_snapshot', phase: 'verification', agent: 'qa',
    outputPath: 'right-snapshot.txt'
  });
  assert.equal(recorded.record.captureSource, 'declared-by-agent');
  assert.equal(recorded.record.observedFinalOrigin, null);
  const verified = await verifyMcpEvidence(root, workflow);
  assert.equal(verified.errors.length, 0);
  assert.match(verified.warnings.join('\n'), /audit only/);
  assert.match(
    (await verifyPhaseMcpRequirements(root, workflow, workflow.phases.verification)).errors.join('\n'),
    /requires a live, host-observed navigation receipt/
  );
});

test('phase MCP evidence requirements are generation-bound and require durable outputs', async () => {
  const root = await repository('sflow-mcp-required-evidence-');
  const output = path.join(root, 'snapshot.txt');
  await mkdir(path.join(root, 'singularity/work-items/STORY-1'), { recursive: true });
  await writeFile(output, 'accessible page snapshot\n');
  const servers = normalizeMcpServers({
    playwright: {
      agents: ['qa'], phases: ['verification'], tools: ['browser_snapshot'],
      evidence: { captureToolCalls: true, captureResults: true }
    }
  }, { agents: ['qa'], phases: ['verification'] });
  const phase = {
    id: 'verification', generation: 0, status: 'in_progress',
    mcp: { evidence: [{ server: 'playwright', tool: 'browser_snapshot', minimum: 1, outputRequired: true }] }
  };
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: phase }, resolution: { mcpServers: servers }
  };
  const missing = await verifyPhaseMcpRequirements(root, workflow, phase);
  assert.match(missing.errors.join('\n'), /requires 1 MCP evidence/);
  await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_snapshot', phase: 'verification', agent: 'qa', outputPath: 'snapshot.txt'
  });
  const ready = await verifyPhaseMcpRequirements(root, workflow, phase);
  assert.equal(ready.errors.length, 0);
});

test('preflight-readiness-lines: MCP doctor requires a current machine-local host readiness attestation', async () => {
  const root = await repository('sflow-mcp-readiness-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  const before = await mcpDoctor(root, definition);
  assert.equal(before.servers[0].readiness, 'needs-host-setup');
  assert.match(before.servers[0].reasons.join('\n'), /not been attested/);

  await assert.rejects(
    () => attestMcpHost(root, definition, 'playwright', { confirmation: 'wrong' }),
    /--confirm playwright/
  );
  await attestMcpHost(root, definition, 'playwright', { confirmation: 'playwright' });
  const waitingForWarm = await mcpDoctor(root, definition);
  assert.equal(waitingForWarm.servers[0].readiness, 'needs-host-setup');
  assert.match(waitingForWarm.servers[0].reasons.join('\n'), /warm proof is not-warmed/);
  await warmPlaywrightFixture(root, definition);
  const ready = await mcpDoctor(root, definition);
  assert.equal(ready.servers[0].readiness, 'ready');

  const changedDefinition = structuredClone(definition);
  changedDefinition.mcpServers.playwright.label = 'Playwright browser';
  const stale = await mcpDoctor(root, changedDefinition);
  assert.equal(stale.servers[0].readiness, 'needs-host-setup');
  assert.match(stale.servers[0].reasons.join('\n'), /attestation is stale/);
});

test('platform doctor reports static MCP preflight readiness without contacting the network', async () => {
  const root = await repository('sflow-mcp-platform-doctor-');
  await initializeDefinition(root);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initialize'], { cwd: root });
  const definition = await loadDefinition(root);
  const report = await doctorSnapshot(root, { offline: true });
  for (const id of Object.keys(definition.mcpServers)) {
    const check = report.checks.find((entry) => entry.id === `mcp-${id}`);
    assert.ok(check, `doctor should include ${id}`);
    assert.match(check.message, new RegExp(`MCP ${id}: (ready|needs-host-setup|misconfigured)`));
  }
});

test('MCP provenance records only governed tools and hash-bound work-item outputs', async () => {
  const root = await repository('sflow-mcp-evidence-');
  const output = path.join(root, 'singularity/work-items/STORY-1/artifacts/verification/screenshot.png');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, 'image bytes');
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification',
    phaseOrder: ['verification'], phases: { verification: { generation: 1, status: 'in_progress' } },
    resolution: { mcpServers: configured() }
  };
  const result = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_take_screenshot', outputPath: path.relative(root, output), note: 'final screen', agent: 'qa'
  });
  assert.match(result.file, /^singularity\/work-items\/STORY-1\/context\/mcp\/records\//);
  assert.equal(result.record.targetGeneration, 2);
  assert.equal(result.record.output.sha256.length, 64);
  await assert.rejects(() => recordMcpEvidence(root, workflow, { server: 'playwright', tool: 'browser_install', agent: 'qa' }), /not allowed/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, { server: 'playwright', tool: 'browser_navigate', agent: 'developer' }), /requires one of these governed agents/);
});

test('MCP evidence rejects symbolic-link sources and credential-bearing URLs', async () => {
  const root = await repository('sflow-mcp-boundaries-');
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-outside-')), 'secret.txt');
  const linked = path.join(root, 'linked-output.txt');
  await writeFile(outside, 'outside repository evidence\n');
  await symlink(outside, linked);
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification',
    phaseOrder: ['verification'], phases: { verification: { generation: 0, status: 'in_progress' } },
    resolution: { mcpServers: configured() }
  };

  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', agent: 'qa', outputPath: 'linked-output.txt'
  }), /symbolic|outside the repository|regular/i);
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', agent: 'qa',
    outputUrl: 'https://user:secret@example.test/evidence.txt'
  }), /must not contain credentials/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', agent: 'qa', note: 'Authorization: bearer private'
  }), /must not contain credentials or secrets/);
});

test('MCP evidence honors an immutable custom work-item root', async () => {
  const root = await repository('sflow-mcp-custom-root-');
  const output = path.join(root, 'verification-output.txt');
  await mkdir(path.join(root, 'governed/story-state/STORY-1'), { recursive: true });
  await writeFile(output, 'verified from custom root\n');
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification',
    phaseOrder: ['verification'], phases: { verification: { generation: 0, status: 'in_progress' } },
    resolution: { workItemRoot: 'governed/story-state', mcpServers: configured() }
  };

  const result = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', agent: 'qa', outputPath: 'verification-output.txt'
  });
  assert.match(result.file, /^governed\/story-state\/STORY-1\/context\/mcp\/records\//);
  const verified = await verifyMcpEvidence(root, workflow);
  assert.equal(verified.errors.length, 0);
  assert.equal(verified.records.length, 1);
});
