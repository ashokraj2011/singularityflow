import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import resolver from '../runtime/resolve.cjs';
import { installManagedRelease, installerProcess, managedLauncher, recoverManagedActivation, rollbackManagedRelease } from '../runtime/install.mjs';
import { observeProductSurfaces, planProductAlignment, applyProductAlignment } from '../src/product-alignment.mjs';
import { stampBuildInfo } from '../src/build-info-stamp.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeId = `node-v26.12.0-${process.platform}-${process.arch}`;

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-managed-engine-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'engine');
  const runtime = path.join(root, 'runtimes', runtimeId);
  const node = path.join(runtime, ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
  await mkdir(path.dirname(node), { recursive: true, mode: 0o700 });
  await writeFile(node, 'fixture-node', { mode: 0o700 });
  const calls = [];
  const execute = async (executable, args, options = {}) => {
    calls.push({ executable, args, options });
    if (args.length === 1 && args[0] === '--version') return { stdout: 'v26.12.0\n' };
    if (args[1] === 'install') {
      const destination = args[args.indexOf('--prefix') + 1];
      const pkg = path.join(destination, 'node_modules', 'singularity-flow');
      await mkdir(path.join(pkg, 'bin'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'singularity-flow', version: '0.9.0', bin: { 'singularity-flow': 'bin/singularity-flow.mjs' } }), { mode: 0o600 });
      await writeFile(path.join(pkg, 'bin', 'singularity-flow.mjs'), '// fixture', { mode: 0o600 });
      return { stdout: '' };
    }
    if (args[1] === '--version') return { stdout: '0.9.0\n' };
    if (args[1] === '--build') return { stdout: '0.9.0 (fixture-build)\n' };
    if (args[1] === '--warm-runtime') return { stdout: '{"prepared":true}\n' };
    throw new Error(`Unexpected process: ${executable} ${args.join(' ')}`);
  };
  let archiveNumber = 0;
  const archive = async () => {
    const bytes = Buffer.from(`reviewed fixture ${archiveNumber++}`);
    const tarball = path.join(home, `candidate-${archiveNumber}.tgz`);
    await writeFile(tarball, bytes);
    return { tarball, sha256: sha(bytes), nodeExecutable: node, root, execute };
  };
  return { root, home, node, runtime, archive, calls, execute };
}

test('managed resolution is optional when no engine has been installed', async t => {
  const f = await fixture(t);
  assert.equal(resolver.resolveManagedEngine({ environment: { SINGULARITY_FLOW_ENGINE_HOME: f.root } }), null);
});

test('activation binds the exact runtime/release and does not use global npm or mutate the application PATH', async t => {
  const f = await fixture(t);
  const before = { ...process.env };
  const options = await f.archive();
  const result = await installManagedRelease(options);
  assert.equal(result.installed, true);
  assert.equal(result.previousRetained, false);
  assert.deepEqual({ ...process.env }, before);
  const selected = resolver.resolveManagedEngine({ environment: { SINGULARITY_FLOW_ENGINE_HOME: f.root } });
  assert.equal(selected.executable, f.node);
  assert.equal(selected.release, options.sha256);
  const npm = f.calls.find(call => call.args[1] === 'install');
  assert.equal(npm.executable, f.node);
  assert.ok(npm.args.includes('--offline'));
  assert.ok(npm.args.includes('--ignore-scripts'));
  assert.ok(!npm.args.includes('--global'));
  assert.ok(npm.options.env.PATH.startsWith(path.dirname(f.node)));
  assert.equal(f.calls.find(call => call.args[1] === '--build').options.env.PATH, before.PATH);
  assert.equal(await readFile(path.join(f.root, 'active'), 'utf8'), `1|${runtimeId}|${options.sha256}\n`);
});

test('upgrades retain the prior release and rollback switches the pair without downloads', async t => {
  const f = await fixture(t);
  const first = await f.archive(); await installManagedRelease(first);
  const original = await readFile(path.join(f.root, 'active'), 'utf8');
  const second = await f.archive(); const result = await installManagedRelease(second);
  assert.equal(result.previousRetained, true);
  const before = f.calls.length;
  assert.deepEqual(await rollbackManagedRelease({ root: f.root, execute: f.execute }), { rolledBack: true });
  assert.equal(await readFile(path.join(f.root, 'active'), 'utf8'), original);
  assert.equal(f.calls.length, before + 1);
  assert.equal((await lstat(path.join(f.root, 'releases', second.sha256))).isDirectory(), true);
});

test('reinstalling the same engine preserves the previous rollback selection', async t => {
  const f = await fixture(t);
  const first = await f.archive(); await installManagedRelease(first);
  const second = await f.archive(); await installManagedRelease(second);
  const before = await readFile(path.join(f.root, 'last-install.json'), 'utf8');
  await installManagedRelease(second);
  assert.equal(await readFile(path.join(f.root, 'last-install.json'), 'utf8'), before);
});

test('a changed retained rollback package cannot execute or replace the current engine', async t => {
  const f = await fixture(t);
  const first = await f.archive(); await installManagedRelease(first);
  const second = await f.archive(); await installManagedRelease(second);
  await writeFile(path.join(f.root, 'releases', first.sha256, 'node_modules', 'singularity-flow', 'bin', 'singularity-flow.mjs'), 'changed');
  const before = f.calls.length;
  await assert.rejects(rollbackManagedRelease({ root: f.root, execute: f.execute }), /Rollback package changed/);
  assert.equal(f.calls.length, before);
  assert.match(await readFile(path.join(f.root, 'active'), 'utf8'), new RegExp(second.sha256));
});

test('a redirected runtime parent is refused before any executable is launched', async t => {
  const f = await fixture(t);
  const original = `${f.runtime}.retained`;
  await rename(f.runtime, original);
  await symlink(original, f.runtime, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installManagedRelease(await f.archive()), /Unsafe SFlow/);
  assert.equal(f.calls.length, 0);
});

test('rollback refuses a redirected retained runtime before executing or changing the active pair', async t => {
  const f = await fixture(t);
  await installManagedRelease(await f.archive());
  await installManagedRelease(await f.archive());
  const selected = await readFile(path.join(f.root, 'active'), 'utf8');
  const retained = `${f.runtime}.retained`;
  await rename(f.runtime, retained);
  await symlink(retained, f.runtime, process.platform === 'win32' ? 'junction' : 'dir');
  const before = f.calls.length;
  await assert.rejects(rollbackManagedRelease({ root: f.root, execute: f.execute }), /Unsafe SFlow/);
  assert.equal(f.calls.length, before);
  assert.equal(await readFile(path.join(f.root, 'active'), 'utf8'), selected);
});

test('an archive integrity failure preserves the current engine and creates no release', async t => {
  const f = await fixture(t);
  await installManagedRelease(await f.archive());
  const original = await readFile(path.join(f.root, 'active'), 'utf8');
  const candidate = await f.archive();
  await writeFile(candidate.tarball, 'changed');
  await assert.rejects(installManagedRelease(candidate), /digest changed/);
  assert.equal(await readFile(path.join(f.root, 'active'), 'utf8'), original);
  await assert.rejects(lstat(path.join(f.root, 'releases', candidate.sha256)), { code: 'ENOENT' });
});

test('a failed never-activated npm stage is preserved and automatically restaged on retry', async t => {
  const f = await fixture(t);
  const candidate = await f.archive();
  await assert.rejects(installManagedRelease({ ...candidate, execute: async (exe, args, options) => {
    if (args[1] === 'install') throw new Error('interrupted npm stage');
    return f.execute(exe, args, options);
  } }), /interrupted npm stage/);
  await assert.rejects(lstat(path.join(f.root, 'active')), { code: 'ENOENT' });
  const notices = [];
  assert.equal((await installManagedRelease({ ...candidate, log: value => notices.push(value) })).installed, true);
  assert.ok(notices.some(value => /never-activated/.test(value)));
  assert.ok((await readdir(path.join(f.root, 'releases'))).some(name => name.startsWith(`${candidate.sha256}.failed-`)));
});

test('smoke failures preserve the selected engine and failed candidate for inspection', async t => {
  const f = await fixture(t);
  await installManagedRelease(await f.archive());
  const original = await readFile(path.join(f.root, 'active'), 'utf8');
  const candidate = await f.archive();
  candidate.execute = async (exe, args, options) => {
    if (args[1] === '--version') return { stdout: 'wrong-build\n' };
    return f.execute(exe, args, options);
  };
  await assert.rejects(installManagedRelease(candidate), /smoke check/);
  assert.equal(await readFile(path.join(f.root, 'active'), 'utf8'), original);
  assert.ok(await lstat(path.join(f.root, 'releases', candidate.sha256)));
});

test('cache preparation failure is advisory and does not block a valid engine', async t => {
  const f = await fixture(t);
  const candidate = await f.archive();
  const notices = [];
  candidate.log = value => notices.push(value);
  candidate.execute = async (exe, args, options) => {
    if (args[1] === '--warm-runtime') throw new Error('cache unavailable');
    return f.execute(exe, args, options);
  };
  assert.equal((await installManagedRelease(candidate)).installed, true);
  assert.match(notices.join(' '), /Optional cache preparation/);
});

test('managed resolver rejects malformed selection rather than falling back to a stale engine', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'active'), '1|../../node|invalid\n', { mode: 0o600 });
  assert.throws(() => resolver.resolveManagedEngine({ environment: { SINGULARITY_FLOW_ENGINE_HOME: f.root } }), /selection is invalid/);
});

test('managed resolver rejects selections from another host', async t => {
  const f = await fixture(t);
  await installManagedRelease(await f.archive());
  assert.throws(() => resolver.resolveManagedEngine({ environment: { SINGULARITY_FLOW_ENGINE_HOME: f.root }, arch: 'unsupported' }), /does not match this host/);
});

test('managed engine homes must be absolute', () => {
  assert.throws(() => resolver.engineHome({ environment: { SINGULARITY_FLOW_ENGINE_HOME: '../repository' } }), /must be absolute/);
});

test('managed engine maintenance cannot silently mutate legacy global npm or delete its own runtime', () => {
  assert.throws(() => resolver.assertLegacyInstallerAllowed(path.join(path.parse(process.cwd()).root, 'private', 'releases', 'a'.repeat(64), 'node_modules', 'singularity-flow')), /Legacy global npm/);
  assert.doesNotThrow(() => resolver.assertLegacyInstallerAllowed(path.resolve('source checkout')));
});

test('managed product/first-mutation alignment never inventories or repairs global npm', async t => {
  const f = await fixture(t);
  const candidate = await f.archive(); await installManagedRelease(candidate);
  const pkg = path.join(f.root, 'releases', candidate.sha256, 'node_modules', 'singularity-flow');
  await mkdir(path.join(pkg, 'src'));
  await writeFile(path.join(pkg, 'src/version.mjs'), "export const VERSION = '0.9.0';\n");
  const source = await readFile(new URL('../src/build-info.mjs', import.meta.url), 'utf8');
  await writeFile(path.join(pkg, 'src/build-info.mjs'), stampBuildInfo(source, { commit: 'a'.repeat(40), sourceSha256: null,
    branch: null, dirty: false, builtAt: '2026-10-21T00:00:00.000Z' }));
  const options = { homeDirectory: f.home, environment: { ...process.env, SINGULARITY_FLOW_ENGINE_HOME: f.root },
    exists: () => false, execute: () => { throw new Error('No global command should run'); },
    inspectProduct: () => { throw new Error('Global npm inventory must not run'); } };
  const observed = await observeProductSurfaces(options);
  const plan = planProductAlignment(observed);
  assert.equal(plan.managed, true);
  assert.equal(plan.verdict, 'aligned');
  assert.deepEqual(plan.actions, []);
  const result = await applyProductAlignment({ ...options, runningBuild: '0.9.0 (managed-fixture)' });
  assert.equal(result.status, 'aligned');
  assert.equal(result.plan.managed, true);
});

test('legacy recovery is preserved and must finish before a managed activation', async t => {
  const f = await fixture(t);
  const legacy = path.join(f.home, 'installations');
  await mkdir(legacy);
  const record = JSON.stringify({ status: 'rolling-back' });
  await writeFile(path.join(legacy, 'activation-current.json'), record);
  await assert.rejects(installManagedRelease(await f.archive()), /existing installation recovery/);
  assert.equal(await readFile(path.join(legacy, 'activation-current.json'), 'utf8'), record);
});

test('a live installer lease cannot be recovered or bypassed by rollback', async t => {
  const f = await fixture(t);
  const lock = path.join(f.root, '.activation-lock');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(recoverManagedActivation({ root: f.root }), /still running/);
  await assert.rejects(rollbackManagedRelease({ root: f.root }), /needs --recover/);
  assert.ok(await lstat(lock));
});

test('dead-lease recovery preserves the selected engine and all candidate bytes', async t => {
  const f = await fixture(t);
  await installManagedRelease(await f.archive());
  const original = await readFile(path.join(f.root, 'active'), 'utf8');
  const lock = path.join(f.root, '.activation-lock');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  assert.equal((await recoverManagedActivation({ root: f.root })).recovered, true);
  assert.equal(await readFile(path.join(f.root, 'active'), 'utf8'), original);
});

test('stable launchers reference the active pair, quote paths and do not export a private application PATH', () => {
  for (const windows of [false, true]) {
    const body = managedLauncher('singularity-flow', { windows });
    assert.match(body, /active/);
    assert.doesNotMatch(body, /set.*PATH=|export PATH=/i);
    assert.match(body, windows ? /%\*/ : /"\$@"/);
  }
  assert.throws(() => managedLauncher('../node'), /Unsupported/);
});

test('managed installer deadlines retain timeout details and stop the owned process tree', async t => {
  const f = await fixture(t);
  const sentinel = path.join(f.home, 'late child');
  const childCode = 'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"late"),1200)';
  const code = `const {spawn}=require("node:child_process"); spawn(process.execPath,["-e", ${JSON.stringify(childCode)}, process.argv[1]], {stdio:"inherit"}); setInterval(()=>{},1000)`;
  await assert.rejects(installerProcess(process.execPath, ['-e', code, sentinel], { capture: true, timeoutMs: 400 }), /deadline 400ms/);
  await new Promise(resolve => setTimeout(resolve, 1300));
  await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
});

test('distribution runtime assets match the reviewed source bootstrap exactly', async () => {
  for (const [source, distributed] of [['bootstrap.sh', 'node-bootstrap.sh'], ['bootstrap.ps1', 'node-bootstrap.ps1'], ['node-runtime.lock', 'node-runtime.lock']]) {
    assert.equal(await readFile(new URL(`../runtime/${source}`, import.meta.url), 'utf8'), await readFile(new URL(`../distribution/${distributed}`, import.meta.url), 'utf8'));
  }
});
