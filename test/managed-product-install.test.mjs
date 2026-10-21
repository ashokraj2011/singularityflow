import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installManagedProduct, resolveSetupCode } from '../runtime/product-install.mjs';
import { installManagedRelease, rollbackManagedRelease } from '../runtime/install.mjs';
import { installUserPath, managedPathProfile, windowsUserPath } from '../runtime/user-path.mjs';
import { buildDistributionOptions } from '../runtime/build-distribution.mjs';
import { assembleCandidateDistribution } from '../src/distribution-build.mjs';
import { inspectDistributionBundle } from '../src/distribution-bundle.mjs';
import { distributionFixture } from './helpers/distribution-artifacts.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow full user setup ')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'engine');
  const calls = [], messages = [];
  const tarball = path.join(home, 'engine.tgz'), vsix = path.join(home, 'extension.vsix');
  await writeFile(tarball, 'exact signed engine'); await writeFile(vsix, 'exact signed extension');
  const options = { tarball, vsix, sha256: sha(await readFile(tarball)), root, homeDirectory: home,
    environment: { ...process.env, SHELL: '/bin/zsh' }, exists: () => true, resolveCode: () => 'fixture-code',
    inspectExtension: async file => ({ version: '0.9.0', sha256: `sha256:${sha(await readFile(file))}` }),
    execute: (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: '', stderr: '' }; },
    executeNode: async (command, args, options) => { calls.push({ command, args, options }); return { stdout: '', stderr: '' }; },
    verifyExtension: async () => calls.push({ step: 'verify-vscode' }), verifyCopilot: async () => calls.push({ step: 'verify-copilot' }),
    updatePath: params => installUserPath({ ...params, platform: 'darwin' }),
    installEngine: async params => {
      calls.push({ step: 'install-engine', params });
      const packageRoot = path.join(root, 'releases', params.sha256, 'node_modules', 'singularity-flow');
      await mkdir(path.join(packageRoot, 'bin'), { recursive: true, mode: 0o700 });
      return { version: '0.9.0', executable: process.execPath, cli: path.join(packageRoot, 'bin', 'singularity-flow.mjs') };
    }, log: message => messages.push(message) };
  return { home, root, calls, messages, options };
}

test('one full setup aligns all surfaces and per-user PATH, without global npm or elevation', async t => {
  const f = await fixture(t), before = { ...process.env };
  const result = await installManagedProduct(f.options);
  assert.equal(result.status, 'complete'); assert.equal(result.adminRequired, false);
  assert.deepEqual(result.stages, { cli: 'verified', vscode: 'verified', copilot: 'verified', path: 'verified' });
  assert.ok(f.calls.some(call => call.args?.includes('--install-extension')));
  assert.ok(f.calls.some(call => call.args?.join(' ')?.endsWith('plugin install')));
  assert.ok(f.messages.some(message => message.includes('COMPLETE AND VERIFIED')));
  assert.ok(!f.calls.some(call => call.args?.includes('--global')));
  assert.deepEqual({ ...process.env }, before);
  assert.match(await readFile(path.join(f.home, '.zshrc'), 'utf8'), /SFlow managed commands/);
  assert.equal(await readFile(path.join(f.root, 'releases', f.options.sha256, 'singularity-flow.vsix'), 'utf8'), 'exact signed extension');
});

test('same setup is idempotent and does not duplicate PATH blocks or change application toolchains', async t => {
  const f = await fixture(t);
  await installManagedProduct(f.options); const profile = await readFile(path.join(f.home, '.zshrc'), 'utf8');
  await installManagedProduct(f.options);
  assert.equal(await readFile(path.join(f.home, '.zshrc'), 'utf8'), profile);
  for (const call of f.calls.filter(call => call.args?.includes('--install-extension'))) {
    const toolPath = Object.entries(call.options.env).find(([key]) => key.toLowerCase() === 'path')?.[1];
    assert.equal(toolPath, process.env.PATH);
    assert.ok(!toolPath.includes(path.join(f.root, 'runtimes')));
  }
});

test('missing IDE or Copilot is diagnosed before engine activation, with no false completion', async t => {
  const f = await fixture(t);
  await assert.rejects(installManagedProduct({ ...f.options, exists: () => false }), /Copilot CLI is unavailable/);
  assert.equal(f.calls.length, 0); assert.equal(f.messages.length, 0);
  assert.throws(() => resolveSetupCode({ environment: {}, exists: () => false, fileExists: () => false }), /VS Code is not installed/);
});

test('VS Code is discovered in its per-user install without code on PATH', () => {
  const selected = resolveSetupCode({ environment: {}, homeDirectory: '/example/user', platform: 'darwin',
    exists: () => false, fileExists: file => file.startsWith('/example/user/Applications/') });
  assert.match(selected, /Applications\/Visual Studio Code.app/);
});

test('a failed surface retains an honest partial receipt; the same command resumes exact retained bytes', async t => {
  const f = await fixture(t); let failed = false;
  await assert.rejects(installManagedProduct({ ...f.options, execute: () => {
    failed = true; return { status: 9, stdout: '', stderr: 'fixture VS Code failure' };
  } }), /fixture VS Code failure/);
  assert.equal(failed, true);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'product-install.json'))).status, 'needs-retry');
  const operation = JSON.parse(await readFile(path.join(f.root, 'product-install.json'))).operationId;
  assert.ok(!f.messages.some(message => message.includes('COMPLETE AND VERIFIED')));
  await installManagedProduct(f.options);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'product-install.json'))).status, 'complete');
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'product-install.json'))).operationId, operation);
  assert.equal(f.calls.filter(call => call.step === 'install-engine').length, 2, 'one failed attempt and one resumed attempt, never a redundant second install');
  assert.ok(f.messages.some(message => message.includes('Resuming the exact retained')));
});

test('changed pending artifact cannot execute, and an engine-only command cannot bypass partial product setup', async t => {
  const f = await fixture(t);
  await assert.rejects(installManagedProduct({ ...f.options, verifyExtension: async () => { throw new Error('interrupted UI verification'); } }));
  await assert.rejects(installManagedRelease({ ...f.options }), /full SFlow installation is unfinished/);
  await assert.rejects(rollbackManagedRelease({ root: f.root }), /full SFlow installation is unfinished/);
  const before = f.calls.length;
  await writeFile(path.join(f.root, 'product-artifacts', f.options.sha256, 'singularity-flow.vsix'), 'changed');
  await assert.rejects(installManagedProduct(f.options), /artifact integrity failed/);
  assert.equal(f.calls.length, before);
});

test('Copilot verification failure is not reported as successful full installation', async t => {
  const f = await fixture(t);
  await assert.rejects(installManagedProduct({ ...f.options, verifyCopilot: async () => { throw new Error('stale skill bytes'); } }), /stale skill bytes/);
  const receipt = JSON.parse(await readFile(path.join(f.root, 'product-install.json')));
  assert.equal(receipt.stages.vscode, 'verified'); assert.equal(receipt.stages.copilot, undefined);
  assert.equal(receipt.status, 'needs-retry');
});

test('concurrent full installer and malformed receipts are refused without overwriting recovery', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.product-lock'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(f.root, '.product-lock', 'owner.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(installManagedProduct(f.options), /still running/); assert.equal(f.calls.length, 0);
  await rm(path.join(f.root, '.product-lock'), { recursive: true });
  await writeFile(path.join(f.root, 'product-install.json'), '{"status":"unknown"}');
  await assert.rejects(installManagedProduct(f.options), /receipt is invalid/);
  assert.equal(await readFile(path.join(f.root, 'product-install.json'), 'utf8'), '{"status":"unknown"}');
});

test('explicitly supplied verified public key is retained outside the release for one-command updates', async t => {
  const f = await fixture(t);
  await installManagedProduct({ ...f.options, trustedPublicKeyPem: Buffer.from('verified upstream public key') });
  assert.equal(await readFile(path.join(f.home, '.singularity-flow', 'trust', 'artifact-builder-public.pem'), 'utf8'), 'verified upstream public key');
});

test('profile update preserves personal content, supports spaces/apostrophes, replaces only its own block', () => {
  const root = "/example/SFlow user's engine";
  const once = managedPathProfile('export PROJECT_NODE=custom\n', root);
  assert.equal(managedPathProfile(once, root), once); assert.ok(once.startsWith('export PROJECT_NODE=custom\n'));
  assert.ok(once.includes("user'\\''s")); assert.ok(!once.includes('/runtimes/'));
  assert.throws(() => managedPathProfile('# >>> SFlow managed commands >>>\n', root), /incomplete/);
});

test('profile symlinks are preserved and not followed', async t => {
  const f = await fixture(t), other = path.join(f.home, 'personal-profile');
  await mkdir(other); await writeFile(path.join(other, 'settings'), 'personal settings');
  await symlink(other, path.join(f.home, '.zprofile'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installUserPath({ root: f.root, homeDirectory: f.home, environment: { SHELL: '/bin/zsh' }, platform: 'darwin' }), /ordinary file/);
  assert.equal(await readFile(path.join(other, 'settings'), 'utf8'), 'personal settings');
});

test('Windows PATH adapter uses only current-user registry with literal encoded data and a bounded system tool', async () => {
  const calls = [];
  await windowsUserPath({ root: 'C:\\Users\\Example User\\engine', environment: { SystemRoot: 'C:\\Windows' },
    execute: async (...args) => { calls.push(args); return { stdout: '' }; } });
  const [exe, args, options] = calls[0];
  assert.match(exe, /powershell.exe$/u); assert.equal(options.timeoutMs, 30_000);
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Registry\]::CurrentUser/); assert.doesNotMatch(script, /LocalMachine|RunAs|setx/);
  assert.match(script, /DoNotExpandEnvironmentNames/); assert.match(script, /changed concurrently/);
  const payload = JSON.parse(Buffer.from(options.env.SFLOW_USER_PATH_PAYLOAD, 'base64'));
  assert.equal(payload.root, 'C:\\Users\\Example User\\engine');
});

test('build options provide zero-argument defaults and explicit safe overrides', () => {
  const options = buildDistributionOptions([], { environment: {}, homeDirectory: '/example/user', repository: '/example/source' });
  assert.equal(options.identity, 'local-distribution-builder'); assert.equal(options.skipTests, false);
  assert.equal(options.outDirectory, path.resolve('/example/source/dist'));
  assert.throws(() => buildDistributionOptions(['--signing-key'], { repository: '/example' }), /requires a value/);
  assert.throws(() => buildDistributionOptions(['--approve'], { repository: '/example' }), /Unknown/);
});

test('one-command candidate assembly keeps signatures and all setup assets, without inventing production certification', async t => {
  const f = await distributionFixture();
  t.after(() => Promise.all([rm(f.directory, { recursive: true, force: true }), rm(f.keyDirectory, { recursive: true, force: true })]));
  const destination = path.join(f.keyDirectory, 'distribution');
  const receipt = JSON.parse(await readFile(path.join(f.directory, 'ARTIFACT-RECEIPT.json')));
  const result = await assembleCandidateDistribution({ artifactReceipt: receipt,
    packagePath: path.join(f.directory, f.tarballName), vsixPath: path.join(f.directory, f.vsixName),
    trustedPublicKeyPem: await readFile(f.publicKeyPath), destination });
  assert.equal(result.status, 'candidate-not-release-certified');
  const bundle = await inspectDistributionBundle(destination, { trustedPublicKeyPem: await readFile(f.publicKeyPath) });
  assert.ok(bundle.operatorScripts.some(item => item.name === 'setup.cmd'));
  assert.equal(bundle.release.distributionStatus, 'candidate-not-release-certified');
  await assert.rejects(lstat(path.join(destination, 'VERIFICATION-RECEIPT.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(destination, 'RELEASE-CHANNEL.json')), { code: 'ENOENT' });
});
