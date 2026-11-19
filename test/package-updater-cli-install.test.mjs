/**
 * The CLI an update replaces: an npm global install is updated in place by the npm that owns its
 * folder, the managed engine by the full-product installer, so a machine never has two SFlow CLIs.
 * Windows layouts are checked on every host through a fake filesystem. The one real npm run installs
 * into a temporary global folder with a stub Copilot CLI and a stub VS Code; nothing here touches the
 * machine's own npm folder, VS Code or Copilot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { detectCliInstall, describeCliInstall, npmGlobalPackageOf, terminalCli, updateSteps } from '../runtime/updater/cli-detect.mjs';
import { defaultVsCodeLauncher, installNpmGlobal, npmCandidates, owningNpm, vscodeCli } from '../runtime/updater/cli-install.mjs';
import { inspectPair } from '../runtime/updater/artifacts.mjs';
import { processCommand } from '../runtime/updater/process.mjs';
import { zip } from './helpers/package-updater-artifacts.mjs';

/** A fake filesystem: `files` maps a path to text (a file), 'dir', or { link: target }. */
function fakeFs(files, platform) {
  const layout = platform === 'win32' ? path.win32 : path.posix;
  const entry = file => files[layout.resolve(file)];
  return {
    kind(file) { const value = entry(file); return value === undefined ? null : value === 'dir' ? 'dir' : typeof value === 'object' ? 'link' : 'file'; },
    readlink(file) { return entry(file).link; },
    realpath(file) {
      // Resolve every link on the way, as the real realpath does, a component at a time.
      let current = layout.resolve(file);
      for (let hops = 0; hops < 16; hops++) {
        const parts = current.split(layout.sep);
        let changed = false;
        for (let index = 1; index <= parts.length && !changed; index++) {
          const prefix = parts.slice(0, index).join(layout.sep) || layout.sep;
          const value = files[prefix];
          if (value && typeof value === 'object') {
            current = layout.resolve(layout.dirname(prefix), value.link, ...parts.slice(index));
            changed = true;
          }
        }
        if (!changed) {
          if (files[current] === undefined) throw Object.assign(new Error('ENOENT ' + current), { code: 'ENOENT' });
          return current;
        }
      }
      throw new Error('link loop');
    },
    read(file) { const value = entry(file); if (typeof value !== 'string' || value === 'dir') throw new Error('ENOENT'); return value; }
  };
}
const none = () => null;

test('an npm global install is found from VS Code\'s CLI path or from PATH, on macOS, Linux and Windows', () => {
  const mac = fakeFs({
    '/opt/homebrew/bin/singularity-flow': { link: '../lib/node_modules/singularity-flow/bin/singularity-flow.mjs' },
    '/opt/homebrew/lib/node_modules/singularity-flow': 'dir',
    '/opt/homebrew/lib/node_modules/singularity-flow/package.json': '{"version":"0.9.0"}',
    '/opt/homebrew/lib/node_modules/singularity-flow/bin/singularity-flow.mjs': '//'
  }, 'darwin');
  const fromPath = detectCliInstall({ environment: { PATH: '/usr/bin:/opt/homebrew/bin' }, platform: 'darwin', fsView: mac, resolveManaged: none, homeDirectory: '/Users/p' });
  assert.deepEqual(fromPath, { route: 'npm-global', prefix: '/opt/homebrew', packageRoot: '/opt/homebrew/lib/node_modules/singularity-flow',
    cli: '/opt/homebrew/lib/node_modules/singularity-flow/bin/singularity-flow.mjs', version: '0.9.0', others: [] });
  assert.equal(describeCliInstall(fromPath), 'The SFlow CLI 0.9.0 is installed with npm in /opt/homebrew.');
  assert.match(updateSteps(fromPath)[2], /with npm, into the same place \(\/opt\/homebrew\)/);
  assert.deepEqual(updateSteps(fromPath).slice(3).map(step => step.split(' ')[0]), ['Uninstall', 'Install'], 'Copilot plugin, then the VSIX');

  const fromHost = detectCliInstall({ currentCli: '/opt/homebrew/lib/node_modules/singularity-flow/bin/singularity-flow.mjs',
    environment: { PATH: '' }, platform: 'darwin', fsView: mac, resolveManaged: none, homeDirectory: '/Users/p' });
  assert.equal(fromHost.prefix, '/opt/homebrew');

  const windows = fakeFs({
    'C:\\Users\\P\\AppData\\Roaming\\npm\\singularity-flow.cmd': '@echo off',
    'C:\\Users\\P\\AppData\\Roaming\\npm\\node_modules\\singularity-flow': 'dir',
    'C:\\Users\\P\\AppData\\Roaming\\npm\\node_modules\\singularity-flow\\package.json': '{"version":"0.9.0"}'
  }, 'win32');
  const win = detectCliInstall({ environment: { Path: 'C:\\Windows;C:\\Users\\P\\AppData\\Roaming\\npm', PATHEXT: '.EXE;.CMD' },
    platform: 'win32', fsView: windows, resolveManaged: none, homeDirectory: 'C:\\Users\\P' });
  assert.equal(win.route, 'npm-global');
  assert.equal(win.prefix, 'C:\\Users\\P\\AppData\\Roaming\\npm');
  assert.equal(win.cli, 'C:\\Users\\P\\AppData\\Roaming\\npm\\node_modules\\singularity-flow\\bin\\singularity-flow.mjs');
  // A project's own node_modules is not a global install.
  assert.equal(npmGlobalPackageOf('C:\\work\\app\\node_modules\\singularity-flow\\bin\\singularity-flow.mjs', { platform: 'win32', fsView: windows }), null);
  assert.equal(npmGlobalPackageOf('/work/app/node_modules/singularity-flow/bin/singularity-flow.mjs', { platform: 'linux', fsView: mac }), null);
});

test('the managed engine wins and names any npm copy it leaves alone; links, strangers and nothing are handled', () => {
  const machine = fakeFs({
    '/usr/local/bin/singularity-flow': { link: '../lib/node_modules/singularity-flow/bin/singularity-flow.mjs' },
    '/usr/local/lib/node_modules/singularity-flow': 'dir',
    '/usr/local/lib/node_modules/singularity-flow/package.json': '{"version":"0.8.0"}',
    '/usr/local/lib/node_modules/singularity-flow/bin/singularity-flow.mjs': '//',
    '/home/p/.singularity-flow/engine/releases/abc/node_modules/singularity-flow/package.json': '{"version":"0.9.0"}'
  }, 'linux');
  const managed = detectCliInstall({ environment: { PATH: '/usr/local/bin' }, platform: 'linux', fsView: machine, homeDirectory: '/home/p',
    resolveManaged: () => ({ cli: '/home/p/.singularity-flow/engine/releases/abc/node_modules/singularity-flow/bin/singularity-flow.mjs' }) });
  assert.deepEqual([managed.route, managed.version, managed.engineHome, managed.others],
    ['managed', '0.9.0', '/home/p/.singularity-flow/engine', ['/usr/local/lib/node_modules/singularity-flow']]);
  assert.equal(updateSteps(managed)[2], 'Install the CLI from the .tgz into SFlow\'s own folder (/home/p/.singularity-flow/engine).');

  const linked = fakeFs({
    '/opt/n/bin/singularity-flow': { link: '../lib/node_modules/singularity-flow/bin/singularity-flow.mjs' },
    '/opt/n/lib/node_modules/singularity-flow': { link: '/src/checkout' },
    '/src/checkout': 'dir', '/src/checkout/bin/singularity-flow.mjs': '//'
  }, 'darwin');
  const refused = detectCliInstall({ environment: { PATH: '/opt/n/bin' }, platform: 'darwin', fsView: linked, resolveManaged: none, homeDirectory: '/Users/p' });
  assert.equal(refused.route, 'unsupported'); assert.match(refused.reason, /linked to a source checkout/);

  const stranger = fakeFs({ '/opt/tools/singularity-flow': '#!/bin/sh' }, 'darwin');
  assert.equal(terminalCli({ environment: { PATH: '/opt/tools' }, platform: 'darwin', fsView: stranger }).kind, 'other');
  assert.match(detectCliInstall({ environment: { PATH: '/opt/tools' }, platform: 'darwin', fsView: stranger, resolveManaged: none, homeDirectory: '/Users/p' }).reason,
    /not installed with npm or with SFlow's installer/);

  const fresh = detectCliInstall({ environment: { PATH: '' }, platform: 'darwin', fsView: fakeFs({}, 'darwin'), resolveManaged: none, homeDirectory: '/Users/p' });
  assert.deepEqual([fresh.route, fresh.fresh], ['managed', true]);
  assert.match(describeCliInstall(fresh), /No SFlow CLI is installed for terminals yet/);
});

test('the npm that owns the folder is asked, not assumed; Windows npm runs as node npm-cli.js', async () => {
  const windows = fakeFs({
    'C:\\Program Files\\nodejs\\npm.cmd': '@echo off', 'C:\\Program Files\\nodejs\\node.exe': 'MZ',
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js': '//',
    'C:\\Tools\\npm.cmd': '@echo off', 'C:\\Tools\\node.exe': 'MZ', 'C:\\Tools\\node_modules\\npm\\bin\\npm-cli.js': '//'
  }, 'win32');
  const candidates = npmCandidates('C:\\Users\\P\\AppData\\Roaming\\npm', { environment: { Path: 'C:\\Tools;C:\\Program Files\\nodejs' }, platform: 'win32', fsView: windows });
  assert.deepEqual(candidates, [
    { node: 'C:\\Tools\\node.exe', npmCli: 'C:\\Tools\\node_modules\\npm\\bin\\npm-cli.js' },
    { node: 'C:\\Program Files\\nodejs\\node.exe', npmCli: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' }]);
  const asked = [];
  const chosen = await owningNpm('C:\\Users\\P\\AppData\\Roaming\\npm', { environment: { Path: 'C:\\Tools;C:\\Program Files\\nodejs' }, platform: 'win32', fsView: windows,
    execute: async (command, args) => { asked.push(command); return { stdout: command.startsWith('C:\\Tools') ? 'C:\\Tools\n' : 'c:\\users\\p\\appdata\\roaming\\npm\r\n' }; } });
  assert.equal(chosen.node, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(asked, ['C:\\Tools\\node.exe', 'C:\\Program Files\\nodejs\\node.exe']);
  await assert.rejects(owningNpm('D:\\elsewhere', { environment: { Path: 'C:\\Tools' }, platform: 'win32', fsView: windows,
    execute: async () => ({ stdout: 'C:\\Tools\n' }) }), /Could not find the npm that installed SFlow in D:\\elsewhere[\s\S]*Nothing|was not touched/);

  const mac = fakeFs({
    '/opt/homebrew/bin/npm': { link: '../lib/node_modules/npm/bin/npm-cli.js' }, '/opt/homebrew/bin/node': 'bin',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js': '//'
  }, 'darwin');
  assert.deepEqual(npmCandidates('/opt/homebrew', { environment: { PATH: '/opt/homebrew/bin' }, platform: 'darwin', fsView: mac }),
    [{ node: '/opt/homebrew/bin/node', npmCli: '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js' }]);
});

test('VS Code\'s own launcher: code.cmd on Windows runs its runtime with cli.js; extensions folder by VSCODE_EXTENSIONS', () => {
  const launcher = 'C:\\Users\\P\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd';
  const windows = fakeFs({ [launcher]: '@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code - Insiders.exe" "%~dp0..\\a1b2c3\\resources\\app\\out\\cli.js" %*\r\nendlocal\r\n' }, 'win32');
  assert.deepEqual(vscodeCli(launcher, { platform: 'win32', fsView: windows, extensionsDirectory: 'D:\\ext' }), {
    command: 'C:\\Users\\P\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe',
    args: ['C:\\Users\\P\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\a1b2c3\\resources\\app\\out\\cli.js'],
    env: { VSCODE_EXTENSIONS: 'D:\\ext', ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: undefined }, launcher });
  assert.deepEqual(vscodeCli('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', { platform: 'darwin' }),
    { command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', args: [], env: {}, launcher: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' });
  assert.throws(() => vscodeCli('C:\\x\\bin\\code.cmd', { platform: 'win32', fsView: fakeFs({ 'C:\\x\\bin\\code.cmd': 'start code' }, 'win32') }), /unexpected form/);
  const found = defaultVsCodeLauncher({ environment: { LOCALAPPDATA: 'C:\\Users\\P\\AppData\\Local', Path: '' }, platform: 'win32', homeDirectory: 'C:\\Users\\P',
    fsView: fakeFs({ 'C:\\Users\\P\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd': '@echo off' }, 'win32') });
  assert.equal(found, 'C:\\Users\\P\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd');
});

// --- one real npm global update, in a temporary global folder ---------------------------------------
function tar(files) {
  const chunks = [];
  for (const [name, text] of files) {
    const bytes = Buffer.from(text), h = Buffer.alloc(512);
    h.write(name); h.write((name.includes('/bin/') ? '0000755' : '0000644') + '\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h[156] = 48; h.write('ustar\0', 257); h.write('00', 263);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function installablePair(version) {
  const versionSource = "export const VERSION = '" + version + "';\n";
  const build = "export const BUILD_INFO = {commit:'" + 'b'.repeat(40) + "',version:'" + version + "'};\n";
  // The CLI a test installs only records which plugin commands it was asked to run.
  const cli = "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.SFLOW_FIXTURE_CALLS, 'cli " + version + " ' + process.argv.slice(2).join(' ') + '\\n');\n";
  return {
    cli: tar(new Map([
      ['package/package.json', JSON.stringify({ name: 'singularity-flow', version, type: 'module', bin: { 'singularity-flow': 'bin/singularity-flow.mjs' } })],
      ['package/bin/singularity-flow.mjs', cli], ['package/src/version.mjs', versionSource], ['package/src/build-info.mjs', build],
      ['package/plugin/plugin.json', JSON.stringify({ name: 'singularity-flow', version })]
    ])),
    vsix: zip(new Map([
      ['extension/package.json', Buffer.from(JSON.stringify({ publisher: 'singularityflow', name: 'singularity-flow-vscode', version }))],
      ['extension/cli/src/version.mjs', Buffer.from(versionSource)], ['extension/cli/src/build-info.mjs', Buffer.from(build)]
    ]))
  };
}

test('npm global route: npm install -g of the checked .tgz into the same folder, Copilot reinstalled, then the VSIX',
  { timeout: 240_000, skip: process.platform === 'win32' && 'the stub Copilot and VS Code here are POSIX scripts; Windows paths are checked above' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow npm global '));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const prefix = path.join(directory, 'global'), fakeBin = path.join(directory, 'fake-bin'), work = path.join(directory, 'work');
  const extensions = path.join(directory, 'extensions'), calls = path.join(directory, 'calls.log');
  for (const folder of [prefix, fakeBin, work, extensions]) await mkdir(folder, { recursive: true });
  await writeFile(calls, '');
  // A stub Copilot CLI on PATH (only its presence is checked here) and a stub VS Code command-line tool.
  await writeFile(path.join(fakeBin, 'copilot'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(fakeBin, 'copilot'), 0o755);
  const fakeCode = path.join(directory, 'fake-code.mjs');
  await writeFile(fakeCode, `import { appendFileSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const args = process.argv.slice(2), home = process.env.VSCODE_EXTENSIONS, record = path.join(home, 'installed.json');
appendFileSync(process.env.SFLOW_FIXTURE_CALLS, 'code ' + args[0] + '\\n');
if (args[0] === '--install-extension') {
  const target = path.join(home, 'singularityflow.singularity-flow-vscode');
  mkdirSync(target, { recursive: true });
  execFileSync('/usr/bin/unzip', ['-o', '-q', args[1], 'extension/*', '-d', target]);
  writeFileSync(record, readFileSync(path.join(target, 'extension', 'package.json')));
} else if (args[0] === '--list-extensions') {
  if (existsSync(record)) console.log('singularityflow.singularity-flow-vscode@' + JSON.parse(readFileSync(record, 'utf8')).version);
} else if (args[0] === '--locate-extension') console.log(path.join(home, 'singularityflow.singularity-flow-vscode', 'extension'));
`);
  const nodeDirectory = path.dirname(await realpath(process.execPath));
  const userConfig = path.join(directory, 'npmrc'); await writeFile(userConfig, '');
  const environment = { PATH: [fakeBin, path.join(prefix, 'bin'), nodeDirectory, '/usr/bin', '/bin'].join(path.delimiter), HOME: process.env.HOME,
    NPM_CONFIG_PREFIX: prefix, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_CACHE: path.join(directory, 'npm-cache'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false', SFLOW_FIXTURE_CALLS: calls, TMPDIR: process.env.TMPDIR ?? os.tmpdir() };
  if (!npmCandidates(prefix, { environment }).length) return t.skip('no npm beside this Node');

  // The office laptop: SFlow 0.9.0 installed with `npm install -g`.
  const old = installablePair('0.9.0'), oldTarball = path.join(directory, 'old.tgz');
  await writeFile(oldTarball, old.cli);
  const npm = (await npmCandidates(prefix, { environment }))[0];
  await processCommand(npm.node, [npm.npmCli, 'install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', oldTarball],
    { capture: true, env: environment, cwd: directory, timeoutMs: 120_000 });
  const plan = detectCliInstall({ environment, homeDirectory: directory, resolveManaged: none });
  assert.deepEqual([plan.route, await realpath(plan.prefix), plan.version], ['npm-global', await realpath(prefix), '0.9.0']);

  const next = installablePair('0.9.1');
  const tarball = path.join(work, 'singularity-flow.tgz'), vsix = path.join(work, 'singularity-flow.vsix');
  await writeFile(tarball, next.cli); await writeFile(vsix, next.vsix);
  const inspected = await inspectPair(tarball, vsix);
  const lines = [];
  const result = await installNpmGlobal({ tarball, vsix, version: inspected.version, buildInfoSource: inspected.buildInfoSource }, {
    plan, work, environment, homeDirectory: directory, log: line => lines.push(line),
    code: { command: process.execPath, args: [fakeCode], env: { VSCODE_EXTENSIONS: extensions }, launcher: fakeCode } });
  assert.equal(result.version, '0.9.1');
  assert.equal(JSON.parse(await readFile(path.join(plan.packageRoot, 'package.json'), 'utf8')).version, '0.9.1');
  assert.equal(existsSync(path.join(prefix, 'bin', 'singularity-flow')), true, 'the same command on PATH, now the new build');
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), [
    'cli 0.9.1 plugin uninstall', 'cli 0.9.1 plugin install', 'code --install-extension', 'code --list-extensions', 'code --locate-extension']);
  assert.match(lines.join('\n'), /with npm into .*global[\s\S]*Uninstalling the SFlow Copilot plugin[\s\S]*Installing the SFlow VS Code extension 0\.9\.1/);

  // A wrong build in the folder: npm finished, but the result is refused, never claimed.
  const sha = createHash('sha256').update(next.cli).digest('hex');
  await assert.rejects(installNpmGlobal({ tarball, vsix, version: '0.9.1', buildInfoSource: 'another build', cliSha256: sha }, {
    plan, work, environment, homeDirectory: directory, log() {},
    code: { command: process.execPath, args: [fakeCode], env: { VSCODE_EXTENSIONS: extensions }, launcher: fakeCode } }), /does not hold the SFlow 0\.9\.1 build/);
  // No Copilot CLI: refused before npm runs.
  await assert.rejects(installNpmGlobal({ tarball, vsix, version: '0.9.1', buildInfoSource: inspected.buildInfoSource }, {
    plan, work, environment: { ...environment, PATH: [path.join(prefix, 'bin'), nodeDirectory].join(path.delimiter) }, homeDirectory: directory, log() {},
    execute: () => assert.fail('nothing runs without Copilot CLI') }), /Copilot CLI is not installed[\s\S]*Nothing was changed/);
});
