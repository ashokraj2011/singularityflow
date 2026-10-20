#!/usr/bin/env node
/** Isolated native install/upgrade/rollback qualification. Never activates the user's engine/UI. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildReinstallBundle, reinstallSourceDigest } from '../src/reinstall.mjs';
import { installManagedRelease, installerProcess, rollbackManagedRelease } from '../runtime/install.mjs';
import resolver from '../runtime/resolve.cjs';
import { distributionFixture } from '../test/helpers/distribution-artifacts.mjs';
import { signReleaseArtifactReceipt } from '../src/release-artifact-receipt.mjs';
import { resolveWindowsBatchProcess } from '../src/platform-process.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow native managed engine ')));
const engine = path.join(directory, 'private engine');
const home = path.join(directory, 'isolated home');
await mkdir(home);
const originalPath = process.env.PATH;
process.env.NPM_CONFIG_LOGLEVEL = 'error';
const report = { platform: process.platform, arch: process.arch, hostNode: process.version, cases: [], timings: {} };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let bundle;
let releaseFixture;
try {
  const env = { ...process.env, HOME: home, USERPROFILE: home, SINGULARITY_FLOW_ENGINE_HOME: engine };
  const bootstrapStart = performance.now();
  const bootstrap = process.platform === 'win32'
    ? { executable: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(source, 'runtime', 'bootstrap.ps1')] }
    : { executable: '/bin/bash', args: [path.join(source, 'runtime', 'bootstrap.sh')] };
  const output = await installerProcess(bootstrap.executable, bootstrap.args, { env, cwd: directory, capture: true, timeoutMs: 700_000 });
  const node = output.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(path.isAbsolute(node));
  assert.equal((await installerProcess(node, ['--version'], { capture: true })).stdout.trim(), 'v26.12.0');
  report.timings.bootstrapMs = performance.now() - bootstrapStart;
  report.cases.push('pinned private Node bootstrap; global Node not required by bootstrap');
  // Repeat from the prepared runtime with a PATH that cannot resolve global node/npm.
  const nodeFreePath = path.join(directory, 'tools without node');
  await mkdir(nodeFreePath);
  let bootstrapEnvironment = { ...env };
  if (process.platform === 'win32') {
    for (const key of Object.keys(bootstrapEnvironment)) if (key.toLowerCase() === 'path') delete bootstrapEnvironment[key];
    bootstrapEnvironment.PATH = path.join(process.env.SystemRoot, 'System32');
  } else {
    for (const tool of ['uname', 'awk', 'dirname', 'mkdir', 'cat', 'stat']) {
      const located = (await installerProcess('/usr/bin/which', [tool], { capture: true })).stdout.trim();
      await symlink(located, path.join(nodeFreePath, tool));
    }
    bootstrapEnvironment.PATH = nodeFreePath;
  }
  const nodeFree = await installerProcess(bootstrap.executable, bootstrap.args, { env: bootstrapEnvironment, cwd: directory, capture: true });
  assert.equal(nodeFree.stdout.trim().split(/\r?\n/).at(-1), node);
  report.cases.push('bootstrap reuse succeeds with no global node/npm on PATH');
  // Reuse the current build toolchain only to build source artifacts; installed commands use Node 26.
  bundle = await buildReinstallBundle({ checkout: source, registry: 'https://registry.npmjs.org/',
    cliOnly: true, skipTests: true, sourceSha256: await reinstallSourceDigest(source), log: message => console.error(message) });
  const firstBytes = await readFile(bundle.tarball);
  const first = digest(firstBytes);
  const installed = await installManagedRelease({ tarball: bundle.tarball, sha256: first,
    nodeExecutable: node, root: engine, homeDirectory: home, log: message => console.error(message) });
  const selected = resolver.resolveManagedEngine({ environment: env });
  assert.equal(selected.executable, node);
  const batch = process.platform === 'win32'
    ? resolveWindowsBatchProcess(path.join(installed.bin, 'singularity-flow.cmd'), ['--version'], { environment: env }) : null;
  const command = batch ? { executable: batch.executable, args: batch.arguments, options: batch.spawnOptions }
    : { executable: path.join(installed.bin, 'singularity-flow'), args: ['--version'], options: {} };
  const commandEnv = { ...env, PATH: `${installed.bin}${path.delimiter}${originalPath}` };
  const start = performance.now();
  const value = await installerProcess(command.executable, command.args, { capture: true, env: commandEnv, cwd: directory, ...command.options });
  report.timings.firstVersionMs = performance.now() - start;
  assert.equal(value.stdout.trim(), '0.9.0');
  const about = JSON.parse((await installerProcess(node, [selected.cli, 'about', '--json'], { capture: true, env: commandEnv, cwd: directory })).stdout);
  assert.equal(about.runtime.managed, true);
  assert.equal(about.runtime.executable, node);
  assert.equal(about.runtime.node, '26.12.0');
  report.cases.push('real CLI and About use the selected private Node with spaces in installation path');
  const cache = path.join(engine, 'cache', installed.runtime, first);
  const cacheSnapshot = async () => {
    const entries = [];
    const visit = async (dir) => {
      for (const item of await readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await visit(file);
        else { const info = await lstat(file); entries.push([path.relative(cache, file), info.size, info.mtimeMs]); }
      }
    };
    await visit(cache); return entries.sort((a, b) => a[0].localeCompare(b[0]));
  };
  const before = await cacheSnapshot();
  assert.ok(before.length > 0, 'installation must prepare real cache files');
  await installerProcess(node, [selected.cli, '--build'], { capture: true, env: commandEnv, cwd: directory });
  await installerProcess(node, [selected.cli, 'about', '--json'], { capture: true, env: commandEnv, cwd: directory });
  const packageRoot = path.dirname(path.dirname(selected.cli));
  const hookEnvironment = { ...bootstrapEnvironment,
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(home, '.singularity-flow/copilot-mode.json') };
  const hook = process.platform === 'win32'
    ? { executable: bootstrap.executable, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(packageRoot, 'plugin/hook-launcher.ps1'), 'boundary-after'] }
    : { executable: '/bin/bash', args: [path.join(packageRoot, 'plugin/hook-launcher.sh'), 'boundary-after'] };
  assert.deepEqual(JSON.parse((await installerProcess(hook.executable, hook.args, { capture: true, env: hookEnvironment, cwd: directory })).stdout), {});
  assert.deepEqual(JSON.parse((await installerProcess(node, [path.join(packageRoot, 'plugin/hook-launcher.mjs'), 'boundary-after', selected.cli], { capture: true, env: hookEnvironment, cwd: directory })).stdout), {});
  assert.deepEqual(await cacheSnapshot(), before);
  report.cases.push('foreground commands do not write prepared compile-cache files');
  report.cases.push('Copilot shell/PowerShell hooks work without global Node and do not write the prepared cache');
  // Exercise the authenticated distribution route with a real engine archive and a fixture key.
  releaseFixture = await distributionFixture({ directoryPrefix: 'sflow managed (release) & fixture-', keyDirectoryPrefix: 'sflow managed (key) & fixture-' });
  const fixtureReceiptFile = path.join(releaseFixture.directory, 'ARTIFACT-RECEIPT.json');
  const unsigned = JSON.parse(await readFile(fixtureReceiptFile, 'utf8')); delete unsigned.signature;
  unsigned.artifacts.find(item => item.kind === 'cli-and-copilot-plugin').sha256 = `sha256:${first}`;
  unsigned.artifacts.find(item => item.kind === 'cli-and-copilot-plugin').sizeBytes = firstBytes.length;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signed = signReleaseArtifactReceipt(unsigned, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'managed-native-fixture');
  await writeFile(releaseFixture.publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(fixtureReceiptFile, JSON.stringify(signed));
  await writeFile(path.join(releaseFixture.directory, releaseFixture.tarballName), firstBytes);
  const manifestFile = path.join(releaseFixture.directory, 'RELEASE.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.artifactReceiptSha256 = signed.signature.payloadSha256;
  await writeFile(manifestFile, JSON.stringify(manifest));
  const sumsFile = path.join(releaseFixture.directory, 'SHA256SUMS');
  const sums = (await readFile(sumsFile, 'utf8')).split('\n').map(line => line.endsWith(`  ${releaseFixture.tarballName}`) ? `${first}  ${releaseFixture.tarballName}` : line).join('\n');
  await writeFile(sumsFile, sums);
  await installerProcess(node, [path.join(releaseFixture.directory, 'bootstrap.mjs'), 'install', '--managed-runtime',
    '--artifact-key', releaseFixture.publicKeyPath, '--cli-only', '--json'], { env, cwd: directory, capture: true, timeoutMs: 300_000 });
  assert.equal(resolver.resolveManagedEngine({ environment: env }).release, first);
  report.cases.push('signed distribution installs the exact engine without global npm or external surface changes');
  if (process.platform === 'win32') {
    const batch = resolveWindowsBatchProcess(path.join(releaseFixture.directory, 'install-managed.cmd'),
      ['--artifact-key', releaseFixture.publicKeyPath, '--cli-only', '--json'], { environment: bootstrapEnvironment });
    await installerProcess(batch.executable, batch.arguments, { capture: true, env: bootstrapEnvironment,
      cwd: directory, ...batch.spawnOptions, timeoutMs: 300_000 });
    assert.equal(resolver.resolveManagedEngine({ environment: env }).release, first);
    report.cases.push('Node-free managed CMD entry preserves quoted release/key paths through native PowerShell');
  }
  // Recompression changes artifact identity without inventing another product/build identity.
  const secondArchive = path.join(directory, 'second valid engine.tgz');
  const secondBytes = gzipSync(gunzipSync(firstBytes), { level: 1 });
  const second = digest(secondBytes); assert.notEqual(second, first);
  await writeFile(secondArchive, secondBytes);
  await installManagedRelease({ tarball: secondArchive, sha256: second, nodeExecutable: node, root: engine, homeDirectory: home });
  assert.equal(resolver.resolveManagedEngine({ environment: env }).release, second);
  await rollbackManagedRelease({ root: engine });
  assert.equal(resolver.resolveManagedEngine({ environment: env }).release, first);
  report.cases.push('real offline upgrade and rollback retain both releases and the working runtime');
  assert.equal(process.env.PATH, originalPath);
  assert.equal((await installerProcess(process.execPath, ['--version'], { capture: true })).stdout.trim(), process.version);
  report.cases.push('global/project Node and parent PATH unchanged');
  console.log(JSON.stringify({ ...report, status: 'passed', casesPassed: report.cases.length }, null, 2));
  const target = process.env.SFLOW_MANAGED_QUALIFICATION_OUTPUT;
  if (target) await writeFile(target, `${JSON.stringify({ ...report, status: 'passed', casesPassed: report.cases.length }, null, 2)}\n`);
} finally {
  if (releaseFixture) {
    await rm(releaseFixture.directory, { recursive: true, force: true });
    await rm(releaseFixture.keyDirectory, { recursive: true, force: true });
  }
  if (bundle) await rm(bundle.stagingParent, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
}
