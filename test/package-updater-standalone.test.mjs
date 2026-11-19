import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { standaloneUpdater } from './helpers/package-updater-package.mjs';
import { reinstallHooks } from '../runtime/updater/reinstall.mjs';
import { installManagedProduct } from '../runtime/product-install.mjs';
import { runUpdate } from '../runtime/update.mjs';
import { pair } from './helpers/package-updater-artifacts.mjs';
import { STANDALONE_UPDATER_FILES } from '../scripts/build-package-updater.mjs';

const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function area(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow standalone updater '));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}
test('the extracted updater runs without a repository or node_modules, including desktop launchers', async t => {
  const directory = await area(t), root = await standaloneUpdater(directory);
  for (const file of STANDALONE_UPDATER_FILES) assert.ok(existsSync(path.join(root, file)), file);
  assert.equal(existsSync(path.join(root, '.git')), false);
  assert.equal(existsSync(path.join(root, 'node_modules')), false);
  const zip = await readFile(path.join(directory, 'distribution', 'SFlow-Updater.zip')), end = zip.length - 22;
  let offset = zip.readUInt32LE(end + 16), executable = false;
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    const length = zip.readUInt16LE(offset + 28), name = zip.toString('utf8', offset + 46, offset + 46 + length);
    assert.ok(!name.includes('\\'), 'ZIP names must use forward slashes on every build host: ' + name);
    if (name.endsWith('/Update SFlow.command')) {
      assert.equal(zip[offset + 5], 3, 'the archive declares Unix file permissions');
      assert.equal((zip.readUInt32LE(offset + 38) >>> 16) & 0o111, 0o111);
      executable = true;
    }
    offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  assert.equal(executable, true);
  const env = { ...process.env, SINGULARITY_FLOW_UPDATER_NO_PAUSE: '1' };
  const direct = await execute(process.execPath, [path.join(root, 'update-sflow.mjs'), '--help'], { cwd: directory, env });
  assert.match(direct.stdout, /SFlow updater/);
  const desktop = process.platform === 'win32'
    ? await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', '& $env:SFLOW_UPDATER_TEST_DESKTOP --help; exit $LASTEXITCODE'],
      { cwd: directory, env: { ...env, SFLOW_UPDATER_TEST_DESKTOP: path.join(root, 'Update SFlow.cmd') } })
    : await execute('/bin/bash', [path.join(root, 'Update SFlow.command'), '--help'], { cwd: directory, env });
  assert.match(desktop.stdout, /SFlow updater/);
  assert.match(await readFile(path.join(root, 'update-sflow.mjs'), 'utf8'), /reinstall: true/);
});

test('first use asks for a link once and subsequent invocations use saved settings', async t => {
  const directory = await area(t), fixture = pair(); let asked = 0, installed = 0;
  const dependencies = { environment: { SINGULARITY_FLOW_PACKAGE_UPDATER_HOME: directory }, log() {},
    detect: () => ({ route: 'managed', engineHome: '/nonexistent/engine', fresh: true, others: [] }),
    askSource: async () => { asked++; return 'https://files.sharepoint.com/public'; },
    downloader: async (source, work) => {
      assert.equal(source, 'https://files.sharepoint.com/public');
      const tarball = path.join(work, 'cli.tgz'), vsix = path.join(work, 'extension.vsix');
      await writeFile(tarball, fixture.cli); await writeFile(vsix, fixture.vsix); return { tarball, vsix };
    }, installer: async (files, options) => { assert.equal(options.reinstall, true); installed++; } };
  await runUpdate({ reinstall: true }, dependencies);
  await runUpdate({ reinstall: true }, dependencies);
  assert.equal(asked, 1); assert.equal(installed, 2);
  assert.deepEqual(await readdir(directory), ['source.json']);
});

test('a failed SFlow reinstall resumes inside the product lease and preserves user data', async t => {
  const home = await area(t), root = path.join(home, 'engine'), calls = [];
  const tarball = path.join(home, 'engine.tgz'), vsix = path.join(home, 'extension.vsix');
  await writeFile(tarball, 'candidate engine'); await writeFile(vsix, 'candidate extension');
  const workspace = path.join(home, 'workspace'), personal = path.join(home, 'personal-skill.md');
  await mkdir(workspace); await writeFile(path.join(workspace, 'story.txt'), 'retained story');
  await writeFile(personal, 'personal instructions');
  const extensions = new Set(['singularityflow.singularity-flow-vscode', 'other.publisher']);
  let plugin = true, failInstall = true;
  const owners = { log() {},
    runProcess(command, args) {
      assert.ok(existsSync(path.join(root, '.product-lock')), 'removal must be inside the existing product lease');
      calls.push(args[0]);
      if (args[0] === '--uninstall-extension') extensions.delete(args[1]);
      if (args[0] === '--install-extension') extensions.add('singularityflow.singularity-flow-vscode');
      return { status: 0, stdout: args[0] === '--list-extensions' ? [...extensions].join('\n') : '' };
    },
    async runNode(command, args) {
      assert.ok(existsSync(path.join(root, '.product-lock')));
      calls.push(args[2]);
      if (args[2] === 'uninstall') plugin = false;
      if (args[2] === 'install') {
        if (failInstall) { failInstall = false; throw new Error('RETAINED_COPILOT_INSTALL_FAILURE'); }
        plugin = true;
      }
      return { stdout: '', stderr: '' };
    }
  };
  const options = { tarball, vsix, sha256: sha(await readFile(tarball)), root, homeDirectory: home,
    environment: {}, exists: () => true, resolveCode: () => 'code', log() {},
    inspectExtension: async () => ({ version: '0.9.0', sha256: 'sha256:' + sha(await readFile(vsix)) }),
    installEngine: async () => {
      const packageRoot = path.join(root, 'releases', options.sha256, 'node_modules', 'singularity-flow');
      const skills = path.join(packageRoot, 'plugin', 'skills', 'sflow-fixture');
      await mkdir(skills, { recursive: true });
      await writeFile(path.join(skills, 'SKILL.md'), '---\nname: sflow-fixture\ndescription: fixture\n---\nFixture');
      return { version: '0.9.0', executable: process.execPath, cli: path.join(packageRoot, 'cli.mjs') };
    }, verifyExtension: async () => assert.ok(extensions.has('singularityflow.singularity-flow-vscode')),
    verifyCopilot: async () => { assert.equal(plugin, true); }, updatePath: async () => ({}) };
  const first = reinstallHooks(owners);
  await assert.rejects(installManagedProduct({ ...options, execute: first.execute, executeNode: first.executeNode }), /RETAINED_COPILOT_INSTALL_FAILURE/);
  const receiptPath = path.join(root, 'product-install.json'), prior = JSON.parse(await readFile(receiptPath));
  assert.equal(prior.status, 'needs-retry'); assert.equal(plugin, false);
  const second = reinstallHooks(owners);
  const result = await installManagedProduct({ ...options, execute: second.execute, executeNode: second.executeNode });
  second.verify();
  assert.equal(result.status, 'complete'); assert.equal(result.operationId, prior.operationId);
  assert.ok(calls.indexOf('--uninstall-extension') < calls.indexOf('--install-extension'));
  assert.ok(calls.indexOf('uninstall') < calls.indexOf('install'));
  assert.ok(extensions.has('other.publisher'));
  assert.equal(await readFile(personal, 'utf8'), 'personal instructions');
  assert.equal(await readFile(path.join(workspace, 'story.txt'), 'utf8'), 'retained story');
});

test('failed extension removal stops before installation and an ignored hook cannot claim clean reinstall', async () => {
  const calls = [];
  const hooks = reinstallHooks({ log() {}, runNode: async () => assert.fail('No plugin may change'),
    runProcess(command, args) {
      calls.push(args[0]);
      return args[0] === '--list-extensions' ? { status: 0, stdout: 'singularityflow.singularity-flow-vscode' }
        : { status: 9, stderr: 'EXACT_EXTENSION_LOCK_ERROR' };
    } });
  assert.throws(() => hooks.execute('code', ['--install-extension', 'candidate.vsix'], {}), /EXACT_EXTENSION_LOCK_ERROR/);
  assert.deepEqual(calls, ['--list-extensions', '--uninstall-extension']);
  assert.throws(() => hooks.verify(), /did not perform/);
});
