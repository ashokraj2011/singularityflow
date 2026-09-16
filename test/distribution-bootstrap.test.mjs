import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  resolveWindowsBatchProcess, resolveWindowsSystemTool
} from '../src/platform-process.mjs';
import { distributionFixture, fileSha256 } from './helpers/distribution-artifacts.mjs';

function canonicalWindowsPath(value) {
  return path.win32.normalize(String(value)).toLowerCase();
}

function windowsEnvironmentValue(environment, name) {
  const entry = Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? null;
}

function cleanWindowsEnvironment(environment, replacements) {
  const replaced = new Set(Object.keys(replacements).map((key) => key.toLowerCase()));
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !replaced.has(key.toLowerCase()))),
    ...replacements
  };
}

async function windowsNpmHarness(t) {
  const tools = await mkdtemp(path.join(os.tmpdir(), 'sflow Windows npm (fixture) & tools-'));
  const output = path.join(tools, 'npm invocations.jsonl');
  const sentinel = path.join(tools, 'late descendant.txt');
  const capture = path.join(tools, 'capture npm.cjs');
  await writeFile(capture, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawn } = require("node:child_process");',
    'const record = {',
    '  cwd: process.cwd(),',
    '  canonicalCwd: fs.realpathSync(process.cwd()),',
    '  args: process.argv.slice(2),',
    '  cache: process.env.NPM_CONFIG_CACHE,',
    '  canonicalCacheParent: fs.realpathSync(path.dirname(process.env.NPM_CONFIG_CACHE)),',
    '  releaseDirectory: process.env.SINGULARITY_FLOW_DISTRIBUTION_RELEASE_DIR,',
    '  originRelease: process.env.SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_RELEASE_DIR,',
    '  originKey: process.env.SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_ARTIFACT_KEY,',
    '  entrypoint: process.env.SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT ?? null',
    '};',
    'fs.appendFileSync(process.env.SFLOW_BOOTSTRAP_TEST_OUT, `${JSON.stringify(record)}\\n`);',
    'if (process.env.SFLOW_BOOTSTRAP_TEST_HANG === "1") {',
    '  const code = "setTimeout(() => require(\\"node:fs\\").writeFileSync(process.argv[1], \\"survived\\"), 1200)";',
    '  const child = spawn(process.execPath, ["-e", code, process.env.SFLOW_BOOTSTRAP_TEST_SENTINEL], { stdio: "ignore" });',
    '  child.unref();',
    '  setInterval(() => {}, 1000);',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(tools, 'npm.cmd'), [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    '"%SFLOW_BOOTSTRAP_TEST_NODE%" "%~dp0capture npm.cjs" %*',
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n'));
  t.after(() => rm(tools, { recursive: true, force: true }));
  return { tools, output, sentinel };
}

async function readJsonLines(file) {
  const text = await readFile(file, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

test('distribution bootstrap executes npm only from a private verified snapshot', {
  skip: process.platform === 'win32' ? 'POSIX fake npm harness' : false
}, async (t) => {
  const release = await distributionFixture();
  const tools = await mkdtemp(path.join(os.tmpdir(), 'sflow-bootstrap-tools-'));
  const output = path.join(tools, 'invocation.json');
  t.after(() => Promise.all([
    rm(release.directory, { recursive: true, force: true }),
    rm(release.keyDirectory, { recursive: true, force: true }),
    rm(tools, { recursive: true, force: true })
  ]));
  const npm = path.join(tools, 'npm');
  const originalRelease = path.join(release.directory, 'RELEASE.json');
  const originalTarball = path.join(release.directory, release.tarballName);
  const [expectedRelease, expectedKey, expectedTarball] = await Promise.all([
    readFile(originalRelease), readFile(release.publicKeyPath), readFile(originalTarball)
  ]);
  await writeFile(npm, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const crypto = require("node:crypto");',
    'const args = process.argv.slice(2);',
    'const packagePath = args[args.indexOf("--package") + 1];',
    'const separator = args.indexOf("--");',
    'const runnerArgs = args.slice(separator + 2);',
    'const releasePath = runnerArgs[runnerArgs.indexOf("--release-dir") + 1];',
    'const keyPath = runnerArgs[runnerArgs.indexOf("--artifact-key") + 1];',
    '// Simulate the distributed folder and external trust file changing after snapshot admission.',
    'fs.writeFileSync(process.env.SFLOW_ORIGINAL_RELEASE, "{\\"tampered\\":true}\\n");',
    'fs.writeFileSync(process.env.SFLOW_ORIGINAL_KEY, "tampered key\\n");',
    'fs.writeFileSync(process.env.SFLOW_ORIGINAL_TARBALL, "tampered tarball\\n");',
    'fs.writeFileSync(process.env.SFLOW_BOOTSTRAP_TEST_OUT, JSON.stringify({',
    '  cwd: process.cwd(),',
    '  canonicalCwd: fs.realpathSync(process.cwd()),',
    '  args, packagePath, releasePath, keyPath,',
    '  releaseBytes: fs.readFileSync(path.join(releasePath, "RELEASE.json")).toString("base64"),',
    '  keyBytes: fs.readFileSync(keyPath).toString("base64"),',
    '  packageSha256: crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex"),',
    '  cache: process.env.NPM_CONFIG_CACHE,',
    '  canonicalCacheParent: fs.realpathSync(path.dirname(process.env.NPM_CONFIG_CACHE)),',
    '  environmentRelease: process.env.SINGULARITY_FLOW_DISTRIBUTION_RELEASE_DIR,',
    '  environmentKey: process.env.SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY,',
    '  originRelease: process.env.SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_RELEASE_DIR,',
    '  originKey: process.env.SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_ARTIFACT_KEY',
    '}));',
    ''
  ].join('\n'));
  await chmod(npm, 0o755);
  const result = spawnSync(process.execPath, [
    path.join(release.directory, 'bootstrap.mjs'),
    'install', '--artifact-key', release.publicKeyPath, '--dry-run'
  ], {
    cwd: release.directory,
    env: {
      ...process.env,
      PATH: `${tools}${path.delimiter}${process.env.PATH ?? ''}`,
      SFLOW_BOOTSTRAP_TEST_OUT: output,
      SFLOW_ORIGINAL_RELEASE: originalRelease,
      SFLOW_ORIGINAL_KEY: release.publicKeyPath,
      SFLOW_ORIGINAL_TARBALL: originalTarball
    },
    encoding: 'utf8',
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr);
  const invocation = JSON.parse(await readFile(output, 'utf8'));
  assert.notEqual(path.resolve(invocation.cwd), path.resolve(release.directory));
  assert.match(path.basename(invocation.cwd), /^sflow-distribution-bootstrap-/u);
  assert.equal(invocation.canonicalCacheParent, invocation.canonicalCwd);
  assert.deepEqual(invocation.args.slice(0, 4), ['exec', '--yes', '--offline', '--package']);
  assert.ok(invocation.args.includes('sf-install'));
  assert.ok(invocation.args.includes('--artifact-key'));
  assert.notEqual(path.resolve(invocation.releasePath), path.resolve(release.directory));
  assert.notEqual(path.resolve(invocation.keyPath), path.resolve(release.publicKeyPath));
  assert.equal(path.basename(path.dirname(invocation.releasePath)), path.basename(invocation.cwd));
  assert.equal(
    path.basename(path.dirname(path.dirname(invocation.keyPath))), path.basename(invocation.cwd)
  );
  assert.equal(invocation.environmentRelease, invocation.releasePath);
  assert.equal(invocation.environmentKey, invocation.keyPath);
  assert.equal(invocation.originRelease, await realpath(release.directory));
  assert.equal(invocation.originKey, await realpath(release.publicKeyPath));
  assert.deepEqual(Buffer.from(invocation.releaseBytes, 'base64'), expectedRelease);
  assert.deepEqual(Buffer.from(invocation.keyBytes, 'base64'), expectedKey);
  assert.equal(invocation.packageSha256, fileSha256(expectedTarball));
});

test('distribution bootstrap and Windows wrappers preserve reviewed argv through real cmd and where', {
  skip: process.platform === 'win32' ? false : 'Windows-native bootstrap coverage'
}, async (t) => {
  const release = await distributionFixture({
    directoryPrefix: 'sflow Windows (release) & fixture-',
    keyDirectoryPrefix: 'sflow Windows (trusted key) & fixture-'
  });
  const harness = await windowsNpmHarness(t);
  t.after(() => Promise.all([
    rm(release.directory, { recursive: true, force: true }),
    rm(release.keyDirectory, { recursive: true, force: true })
  ]));

  const systemRoot = windowsEnvironmentValue(process.env, 'SystemRoot')
    ?? windowsEnvironmentValue(process.env, 'WINDIR');
  assert.ok(systemRoot, 'Windows test host must provide SystemRoot or WINDIR');
  const system32 = path.win32.join(systemRoot, 'System32');
  const environment = cleanWindowsEnvironment(process.env, {
    SystemRoot: systemRoot,
    ComSpec: path.win32.join(system32, 'cmd.exe'),
    PATH: [harness.tools, path.dirname(process.execPath), system32].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SFLOW_BOOTSTRAP_TEST_NODE: process.execPath,
    SFLOW_BOOTSTRAP_TEST_OUT: harness.output,
    SFLOW_BOOTSTRAP_TEST_SENTINEL: harness.sentinel
  });
  const marker = 'spaces & (round) [square] ^ caret "quoted", semi; star* question?';
  const common = ['--artifact-key', release.publicKeyPath, '--dry-run'];
  const bootstrap = path.join(release.directory, 'bootstrap.mjs');

  const direct = spawnSync(process.execPath, [
    bootstrap, 'install', ...common, '--marker', marker
  ], { cwd: release.directory, env: environment, encoding: 'utf8', timeout: 30_000 });
  assert.equal(direct.status, 0, direct.stderr || direct.error?.message);

  for (const [script, runner] of [
    ['install.cmd', 'sf-install'], ['uninstall.cmd', 'sf-uninstall']
  ]) {
    const scriptPath = path.join(release.directory, script);
    const launch = resolveWindowsBatchProcess(scriptPath, [
      ...common, '--marker', `${script}: ${marker}`
    ], { environment });
    const result = spawnSync(launch.executable, launch.arguments, {
      cwd: release.directory, env: environment, encoding: 'utf8', timeout: 30_000,
      ...launch.spawnOptions
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr || result.error?.message}`);
    const records = await readJsonLines(harness.output);
    const record = records.at(-1);
    assert.ok(record.args.includes(runner), `${script} must dispatch ${runner}`);
    assert.equal(record.entrypoint && canonicalWindowsPath(record.entrypoint),
      canonicalWindowsPath(scriptPath));
    assert.deepEqual(record.args.slice(-2), ['--marker', `${script}: ${marker}`]);
  }

  const powershell = path.win32.join(
    systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  for (const [script, runner] of [
    ['install.ps1', 'sf-install'], ['uninstall.ps1', 'sf-uninstall']
  ]) {
    const scriptPath = path.join(release.directory, script);
    const result = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, ...common, '--marker', `${script}: ${marker}`
    ], { cwd: release.directory, env: environment, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${script}: ${result.stderr || result.error?.message}`);
    const records = await readJsonLines(harness.output);
    const record = records.at(-1);
    assert.ok(record.args.includes(runner), `${script} must dispatch ${runner}`);
    assert.equal(record.entrypoint && canonicalWindowsPath(record.entrypoint),
      canonicalWindowsPath(scriptPath));
    assert.deepEqual(record.args.slice(-2), ['--marker', `${script}: ${marker}`]);
  }

  const records = await readJsonLines(harness.output);
  assert.equal(records.length, 5);
  for (const record of records) {
    assert.notEqual(canonicalWindowsPath(record.cwd), canonicalWindowsPath(release.directory));
    assert.match(path.win32.basename(record.cwd), /^sflow-distribution-bootstrap-/u);
    assert.equal(canonicalWindowsPath(record.canonicalCacheParent),
      canonicalWindowsPath(record.canonicalCwd));
    assert.equal(canonicalWindowsPath(record.originRelease),
      canonicalWindowsPath(release.directory));
    assert.equal(canonicalWindowsPath(record.originKey),
      canonicalWindowsPath(release.publicKeyPath));
    assert.deepEqual(record.args.slice(0, 4), ['exec', '--yes', '--offline', '--package']);
    if (record.args.includes('sf-install')) {
      assert.equal(canonicalWindowsPath(path.win32.dirname(record.releaseDirectory)),
        canonicalWindowsPath(record.canonicalCwd));
    } else {
      assert.equal(canonicalWindowsPath(record.releaseDirectory),
        canonicalWindowsPath(release.directory));
    }
  }
  assert.deepEqual(records[0].args.slice(-2), ['--marker', marker]);
  assert.equal(records[0].entrypoint, null);

  const unsafe = spawnSync(process.execPath, [
    bootstrap, 'install', ...common, '--marker', '%PATH%'
  ], { cwd: release.directory, env: environment, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /cannot contain controls, percent signs, or exclamation marks/u);
  assert.equal((await readJsonLines(harness.output)).length, 5,
    'unsafe cmd expansion bytes must be refused before npm executes');
});

test('distribution bootstrap Windows timeout terminates the npm descendant tree', {
  skip: process.platform === 'win32' ? false : 'Windows-native timeout coverage'
}, async (t) => {
  const release = await distributionFixture({
    directoryPrefix: 'sflow Windows timeout (release) & fixture-',
    keyDirectoryPrefix: 'sflow Windows timeout (key) & fixture-'
  });
  const harness = await windowsNpmHarness(t);
  t.after(() => Promise.all([
    rm(release.directory, { recursive: true, force: true }),
    rm(release.keyDirectory, { recursive: true, force: true })
  ]));
  const systemRoot = windowsEnvironmentValue(process.env, 'SystemRoot')
    ?? windowsEnvironmentValue(process.env, 'WINDIR');
  assert.ok(systemRoot, 'Windows test host must provide SystemRoot or WINDIR');
  const system32 = path.win32.join(systemRoot, 'System32');
  const environment = cleanWindowsEnvironment(process.env, {
    SystemRoot: systemRoot,
    ComSpec: resolveWindowsSystemTool({ SystemRoot: systemRoot }, 'cmd.exe'),
    PATH: [harness.tools, path.dirname(process.execPath), system32].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SFLOW_BOOTSTRAP_TEST_NODE: process.execPath,
    SFLOW_BOOTSTRAP_TEST_OUT: harness.output,
    SFLOW_BOOTSTRAP_TEST_SENTINEL: harness.sentinel,
    SFLOW_BOOTSTRAP_TEST_HANG: '1',
    SINGULARITY_FLOW_DISTRIBUTION_RUNNER_TIMEOUT_MS: '300'
  });
  const result = spawnSync(process.execPath, [
    path.join(release.directory, 'bootstrap.mjs'), 'install',
    '--artifact-key', release.publicKeyPath, '--dry-run'
  ], { cwd: release.directory, env: environment, encoding: 'utf8', timeout: 15_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm runner exceeded its 300ms operation deadline/u);
  assert.equal((await readJsonLines(harness.output)).length, 1);
  await delay(1_700);
  await assert.rejects(readFile(harness.sentinel), { code: 'ENOENT' },
    'taskkill /T /F must terminate the npm descendant before it can write the sentinel');
});
