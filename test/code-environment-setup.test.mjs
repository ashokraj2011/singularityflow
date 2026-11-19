/**
 * SFlow prepares a Story checkout's code environment itself [owner, 2026-11-19, "SFlow prepares the code environment"].
 *
 * On the owner's laptop `/sf-code` stopped twice: "Dependencies are absent (npm ci is needed)", and ".nvmrc requests
 * Node 22, while this checkout has Node 26.12.0; pinning Node 26 requires your /sf-decide choice". Here: the install the
 * lock file implies (or a copy of the main checkout's), one line saying so, a failure in plain words with the command for
 * the person's terminal; a Node settled by running the tests when several would do; and a `.nvmrc` naming a Node not
 * installed here answered for this Story without changing the file. Installs are stubs, or a real offline `npm ci` of a
 * local package; the Nodes are small scripts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeInstalledNodes } from '../src/node-version-settle.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { testExecutionHandoff } from '../src/test-execution-handoff.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { NODE_OVERRIDES_FILE, nodeInstallCommand, nodeVersionNote, requestedNodeVersion } from '../src/project-node-version.mjs';
import { installFailure, installFolder, prepareRepositoryDependencies, resetDependencySetupAttempts } from '../src/repository-dependency-setup.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const posix = { skip: process.platform === 'win32' ? 'the fake Nodes are shell scripts' : false };

async function folder(t, prefix = 'sflow-code-env-') {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function files(root, entries) {
  for (const [relative, contents] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

/** A committed repository whose package asks for one dependency, with `node_modules/` ignored. */
async function repository(t, { lock = { 'package-lock.json': '{"lockfileVersion":3}\n' }, ignore = 'node_modules/\n', manifest = null } = {}) {
  const base = await folder(t);
  const root = path.join(base, 'repo');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Env Test'); git(root, 'config', 'user.email', 'env@example.invalid');
  await files(root, { 'package.json': manifest ?? { name: 'app', private: true, dependencies: { 'left-pad': '1.3.0' } }, ...lock, ...(ignore ? { '.gitignore': ignore } : {}) });
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  return { base, root };
}

/** A stand-in install: records what ran and leaves what that install leaves. */
function stubInstall({ status = 0, stderr = '', error = null, leaves = 'node_modules/.package-lock.json' } = {}) {
  const calls = [];
  const run = async (argv, options) => {
    calls.push({ argv, cwd: options.cwd, timeoutMs: options.timeoutMs });
    if (status === 0 && leaves) await files(options.cwd, { [leaves]: '{}' });
    return { status, stdout: '', stderr, error, timedOut: false };
  };
  return { run, calls };
}

test('the install comes from the lock file and the package manager the package names', async (t) => {
  const root = await folder(t);
  const at = async (entries, directory = '.') => {
    const here = path.join(root, String(Math.random()).slice(2));
    await files(here, entries);
    return installFolder(here, directory);
  };
  const manifest = (fields = {}) => JSON.stringify({ name: 'x', ...fields });
  assert.deepEqual((await at({ 'package.json': manifest(), 'package-lock.json': '{}' })).argv, ['npm', 'ci', '--no-audit', '--no-fund']);
  assert.equal((await at({ 'package.json': manifest(), 'package-lock.json': '{}' })).words, 'npm ci');
  assert.equal((await at({ 'package.json': manifest(), 'npm-shrinkwrap.json': '{}' })).words, 'npm ci');
  assert.equal((await at({ 'package.json': manifest(), 'pnpm-lock.yaml': '' })).words, 'pnpm install --frozen-lockfile');
  assert.equal((await at({ 'package.json': manifest(), 'yarn.lock': '' })).words, 'yarn install --frozen-lockfile');
  assert.equal((await at({ 'package.json': manifest(), 'bun.lock': '' })).words, 'bun install --frozen-lockfile');
  // Yarn 2 and later: immutable, and Plug'n'Play unless the settings ask for node_modules.
  const berry = await at({ 'package.json': manifest({ packageManager: 'yarn@4.1.0' }), 'yarn.lock': '' });
  assert.deepEqual([berry.words, berry.target], ['yarn install --immutable', '.pnp.cjs']);
  const linked = await at({ 'package.json': manifest(), 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' });
  assert.deepEqual([linked.words, linked.target], ['yarn install --immutable', 'node_modules']);
  // packageManager decides between lock files; else the first found.
  assert.equal((await at({ 'package.json': manifest({ packageManager: 'pnpm@9.1.0' }), 'pnpm-lock.yaml': '', 'package-lock.json': '{}' })).manager, 'pnpm');
  // A workspace package installs where its lock file is.
  const nested = await at({ 'package.json': manifest({ workspaces: ['packages/*'] }), 'package-lock.json': '{}', 'packages/a/package.json': manifest() }, 'packages/a');
  assert.equal(nested.directory, '.');
  assert.equal(await at({ 'package.json': manifest() }), null, 'no lock file: npm install would write one, so it stays the person\'s');
});

test('a Story checkout with no node_modules gets the lock file\'s install, said in one line, once', async (t) => {
  resetDependencySetupAttempts();
  const { root } = await repository(t);
  const { run, calls } = stubInstall();
  const lines = [];
  const prepared = await prepareRepositoryDependencies(root, { run, source: null, say: (line) => lines.push(line) });
  assert.equal(prepared.status, 'ready');
  assert.deepEqual(prepared.folders, [{ directory: '.', command: 'npm ci', how: 'installed' }]);
  assert.deepEqual(calls.map((call) => [call.argv.join(' '), call.cwd]), [['npm ci --no-audit --no-fund', root]]);
  assert.equal(calls[0].timeoutMs, 15 * 60_000);
  assert.deepEqual(lines, ['Installing dependencies (npm ci)…']);
  // Installed: nothing more runs, and nothing more is said.
  assert.equal((await prepareRepositoryDependencies(root, { run, source: null, say: (line) => lines.push(line) })).folders[0].how, 'present');
  assert.equal(calls.length, 1);
  assert.equal(lines.length, 1);
  // A test command's folder resolves to the package folder that holds the lock file.
  assert.equal((await prepareRepositoryDependencies(root, { run, source: null, directories: ['src/deep'], say: () => {} })).folders[0].directory, '.');
});

test('off for the repository or this machine, nothing to install, or a node_modules Git would commit: nothing runs, and the last says why', async (t) => {
  resetDependencySetupAttempts();
  const { root } = await repository(t);
  const { run, calls } = stubInstall();
  assert.equal((await prepareRepositoryDependencies(root, { run, source: null, config: { repositoryReadiness: { dependencyHydration: 'off' } } })).status, 'off');
  assert.equal((await prepareRepositoryDependencies(root, { run, source: null, environment: { ...process.env, SINGULARITY_FLOW_DEPENDENCY_SETUP: 'off' } })).status, 'off');
  const empty = await repository(t, { manifest: { name: 'app', private: true, scripts: { test: 'node --test' } } });
  assert.equal((await prepareRepositoryDependencies(empty.root, { run, source: null, say: () => {} })).folders[0].how, 'nothing-to-install');
  const unlocked = await repository(t, { lock: {} });
  assert.deepEqual((await prepareRepositoryDependencies(unlocked.root, { run, source: null, say: () => {} })).folders, []);
  assert.equal(calls.length, 0);

  const exposed = await repository(t, { ignore: null });
  const lines = [];
  const refused = await prepareRepositoryDependencies(exposed.root, { run, source: null, say: (line) => lines.push(line) });
  assert.equal(calls.length, 0, 'never installs what the change would then hold');
  assert.equal(refused.status, 'failed');
  assert.equal(refused.failure.words, 'Dependencies in the repository root were not installed: node_modules is not in .gitignore here, so installing would add it to your change. '
    + 'Adding it to .gitignore is a change to name in the plan.');
  assert.deepEqual([refused.failure.nextAction.command, refused.failure.nextAction.workingDirectory], ['npm ci', exposed.root]);
  assert.equal(refused.failure.nextAction.label, `Add node_modules/ to .gitignore, or run npm ci in ${exposed.root} yourself.`);
});

test('a failed install says why in a developer\'s words, with one command for their own terminal, and is not run again', async (t) => {
  resetDependencySetupAttempts();
  const folderOf = (manager = 'npm', words = 'npm ci') => ({ directory: '.', lockFile: manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json', manager, argv: words.split(' '), words });
  const cwd = '/work/app';
  const offline = installFailure(folderOf(), { status: 1, stderr: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' }, { cwd, words: 'npm ci' });
  assert.equal(offline.words, 'Dependencies in the repository root were not installed: the package registry could not be reached from this run.');
  assert.deepEqual(offline.nextAction, { label: 'Run npm ci in /work/app yourself, then run the tests again.', command: 'npm ci', workingDirectory: cwd });
  const drift = installFailure(folderOf(), { status: 1, stderr: 'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.' }, { cwd, words: 'npm ci' });
  assert.equal(drift.reason, 'package-lock.json does not match package.json, so npm ci will not install from it');
  assert.equal(drift.nextAction.command, 'npm install');
  assert.equal(drift.nextAction.label, 'Run npm install in /work/app to update package-lock.json.');
  assert.match(drift.words, /Updating it is a change to name in the plan\.$/u);
  const missing = installFailure(folderOf('pnpm', 'pnpm install --frozen-lockfile'), { status: null, error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) }, { cwd, words: 'pnpm install --frozen-lockfile' });
  assert.equal(missing.reason, 'pnpm is not installed on this machine');
  assert.equal(missing.nextAction.command, 'corepack enable && pnpm install --frozen-lockfile');
  const onWindows = installFailure(folderOf('pnpm', 'pnpm install --frozen-lockfile'), { status: null, error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) },
    { cwd: 'C:\\work\\app', words: 'pnpm install --frozen-lockfile', platform: 'win32' });
  assert.equal(onWindows.nextAction.command, 'pnpm install --frozen-lockfile', 'Windows PowerShell 5 has no &&');
  assert.match(onWindows.nextAction.label, /^Install pnpm \(corepack enable\), then run pnpm install --frozen-lockfile in C:\\work\\app/u);
  assert.equal(installFailure(folderOf(), { status: 1, stderr: 'npm error code E401\nnpm error Unable to authenticate' }, { cwd, words: 'npm ci' }).reason, 'the package registry refused the credentials this run had');
  assert.equal(installFailure(folderOf(), { status: null, timedOut: true }, { cwd, words: 'npm ci' }).reason, 'npm ci did not finish within 15 minutes');
  assert.equal(installFailure(folderOf(), { status: 2, stderr: 'npm error something odd\n' }, { cwd, words: 'npm ci' }).reason, 'npm ci ended with exit 2: npm error something odd');

  const { root } = await repository(t);
  const { run, calls } = stubInstall({ status: 1, stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org' });
  const lines = [];
  const failed = await prepareRepositoryDependencies(root, { run, source: null, say: (line) => lines.push(line) });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(lines, ['Installing dependencies (npm ci)…',
    `Dependencies in the repository root were not installed: the package registry could not be reached from this run. Run npm ci in ${root} yourself, then run the tests again.`]);
  // The same process never runs an unchanged failing install twice; the next run, after the person's, finds node_modules.
  assert.equal((await prepareRepositoryDependencies(root, { run, source: null, say: () => {} })).status, 'failed');
  assert.equal(calls.length, 1);
});

test('a failed gate whose dependencies were not ready leads with the person\'s command, before any repair of the code', () => {
  const dependencySetup = { directory: '.', words: 'Dependencies in the repository root were not installed: the package registry could not be reached from this run.',
    reason: 'the package registry could not be reached from this run', nextAction: { label: 'Run npm ci in /work/app yourself, then run the tests again.', command: 'npm ci', workingDirectory: '/work/app' } };
  const envelope = refusalEnvelope(new SingularityFlowError('Required test command \'tests\' failed (exit 127).', { code: 'CODE_TEST_FAILED',
    details: { workId: 'S-1', dependencySetup } }), ['phase', 'publish', 'implementation']);
  const [first] = envelope.remediationPlan.steps;
  assert.equal(first.id, 'make-dependencies-ready');
  assert.equal(first.command, null, 'the person\'s own terminal: no agent route');
  assert.match(first.label ?? first.reason, /^Dependencies in the repository root were not installed: .* Run npm ci in \/work\/app yourself, then run the tests again\.$/u);
  assert.deepEqual(envelope.error.details.dependencySetup, { words: dependencySetup.words, directory: '.', nextAction: dependencySetup.nextAction });
});

test('a Story checkout gets a copy of the main checkout\'s dependencies when its lock file is the same and installed since; otherwise the install', async (t) => {
  resetDependencySetupAttempts();
  const { base, root } = await repository(t);
  await files(root, { 'node_modules/left-pad/index.js': 'module.exports = 1;\n', 'node_modules/.package-lock.json': '{}' });
  const past = new Date(Date.now() - 60_000);
  await utimes(path.join(root, 'package-lock.json'), past, past);
  const story = path.join(base, 'story');
  git(root, 'worktree', 'add', '-q', '-b', 'story', story);
  const { run, calls } = stubInstall();
  const lines = [];
  const copied = await prepareRepositoryDependencies(story, { run, say: (line) => lines.push(line) });
  assert.deepEqual(copied.folders, [{ directory: '.', command: 'npm ci', how: 'copied', from: 'main checkout' }]);
  assert.equal(calls.length, 0);
  assert.deepEqual(lines, ['Copying installed dependencies into the repository root from the main checkout (same package-lock.json)…']);
  assert.equal(await readFile(path.join(story, 'node_modules/left-pad/index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal((await lstat(path.join(story, 'node_modules'))).isSymbolicLink(), false, 'its own copy: nothing either checkout does reaches the other');
  assert.equal(git(story, 'status', '--porcelain'), '', 'ignored, so the change holds nothing new');

  // A lock file this Story changed: the install, not the copy.
  const changed = path.join(base, 'changed');
  git(root, 'worktree', 'add', '-q', '-b', 'changed', changed);
  await writeFile(path.join(changed, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  assert.equal((await prepareRepositoryDependencies(changed, { run, say: () => {} })).folders[0].how, 'installed');
  // The main checkout installed before its lock file last changed: stale, so the install too.
  const stale = path.join(base, 'stale');
  git(root, 'worktree', 'add', '-q', '-b', 'stale', stale);
  const older = new Date(Date.now() - 3_600_000);
  await utimes(path.join(root, 'node_modules/.package-lock.json'), older, older);
  await utimes(path.join(root, 'package-lock.json'), new Date(), new Date());
  assert.equal((await prepareRepositoryDependencies(stale, { run, say: () => {} })).folders[0].how, 'installed');
  assert.deepEqual(calls.map((call) => call.cwd), [changed, stale]);
});

test('a real npm ci, offline, of a local package: install scripts run as a developer\'s own install would, and the lock file stays', slowLane({ timeout: 240_000 }), async (t) => {
  resetDependencySetupAttempts();
  const lock = { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'local-dep': 'file:vendor/local-dep' } },
    'node_modules/local-dep': { resolved: 'vendor/local-dep', link: true }, 'vendor/local-dep': { name: 'local-dep', version: '1.0.0' } } };
  const { base, root } = await repository(t, {
    manifest: { name: 'app', version: '1.0.0', private: true, dependencies: { 'local-dep': 'file:vendor/local-dep' },
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('node_modules/.postinstall-ran','yes')\"" } },
    lock: { 'package-lock.json': `${JSON.stringify(lock)}\n`, 'vendor/local-dep/package.json': { name: 'local-dep', version: '1.0.0' }, 'vendor/local-dep/index.js': 'module.exports = 42;\n' } });
  const before = await readFile(path.join(root, 'package-lock.json'), 'utf8');
  const environment = { ...process.env, npm_config_offline: 'true', npm_config_cache: path.join(base, 'npm-cache'), npm_config_update_notifier: 'false' };
  const lines = [];
  const prepared = await prepareRepositoryDependencies(root, { environment, source: null, say: (line) => lines.push(line) });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.folders[0].how, 'installed');
  assert.equal(await readFile(path.join(root, 'node_modules/.postinstall-ran'), 'utf8'), 'yes');
  assert.equal(await readFile(path.join(root, 'node_modules/local-dep/index.js'), 'utf8'), 'module.exports = 42;\n');
  assert.equal(await readFile(path.join(root, 'package-lock.json'), 'utf8'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.ok(lines.includes('Installing dependencies (npm ci)…'), lines.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// Node

async function fakeNode(directory, version) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'node');
  await writeFile(file, `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nFAKE_NODE=${version} exec '${process.execPath}' "$@"\n`);
  await chmod(file, 0o755);
  return directory;
}

test('a .nvmrc naming a Node not installed here runs on the Node SFlow settled for the Story\'s branch, and its detached runs; the file is untouched', posix, async (t) => {
  const { base, root } = await repository(t, { lock: { '.nvmrc': '18\n' } });
  const home = path.join(base, 'home');
  await fakeNode(path.join(home, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), '22.14.0');
  const bin = await fakeNode(path.join(base, 'bin'), '26.1.0');
  const environment = { HOME: home, PATH: bin };
  const ask = (cwd = root) => requestedNodeVersion({ cwd, root: cwd, environment, home, homebrewPrefixes: [] });
  assert.equal((await ask()).status, 'not-installed');
  const kept = path.join(root, '.git', ...NODE_OVERRIDES_FILE);
  await mkdir(path.dirname(kept), { recursive: true });
  await writeFile(kept, JSON.stringify({ schemaVersion: 1, overrides: [{ file: '.nvmrc', wanted: '18', version: '22', workId: 'S-1', branch: 'main', at: 'now' }] }));
  const settled = await ask();
  assert.deepEqual([settled.status, settled.node, settled.manager, settled.settled], ['settled', '22.14.0', 'nvm', '22']);
  assert.equal(settled.directory, path.join(home, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'));
  assert.equal(nodeVersionNote(settled), 'Using Node 22.14.0 from nvm for this Story\'s tests: .nvmrc asks for Node 18, which is not installed here. SFlow settled it; undo it on the decisions card to choose another.');
  assert.equal(await readFile(path.join(root, '.nvmrc'), 'utf8'), '18\n');
  // Another branch is another Story's: the file counts as it is there.
  git(root, 'checkout', '-q', '-b', 'other');
  assert.equal((await ask()).status, 'not-installed');
  // A detached checkout of the repository (an isolated or base run SFlow made) counts it.
  const detached = path.join(base, 'detached');
  git(root, 'worktree', 'add', '-q', '--detach', detached, 'main');
  assert.equal((await ask(detached)).status, 'settled');
  // Settled on the Node PATH already runs: nothing moves on PATH.
  await writeFile(kept, JSON.stringify({ schemaVersion: 1, overrides: [{ file: '.nvmrc', wanted: '18', version: '26', workId: 'S-1', branch: 'main', at: 'now' }] }));
  const onPath = await ask(detached);
  assert.deepEqual([onPath.status, onPath.node, onPath.directory], ['settled', '26.1.0', undefined]);
  // Another wanted version is not this settlement's.
  await writeFile(path.join(detached, '.nvmrc'), '20\n');
  assert.equal((await ask(detached)).status, 'not-installed');
});

test('how to install a Node is the command of the version manager found here', async (t) => {
  const home = await folder(t, 'sflow-node-install-');
  const none = { platform: 'darwin', home, homebrewPrefixes: [] };
  assert.deepEqual(await nodeInstallCommand('22', {}, none), { manager: null, command: null });
  await mkdir(path.join(home, '.nvm'));
  assert.deepEqual(await nodeInstallCommand('22', {}, none), { manager: 'nvm', command: 'nvm install 22' });
  assert.equal((await nodeInstallCommand('lts/iron', {}, none)).command, 'nvm install lts/iron');
  await rm(path.join(home, '.nvm'), { recursive: true });
  await mkdir(path.join(home, '.volta', 'tools', 'image', 'node'), { recursive: true });
  assert.deepEqual(await nodeInstallCommand('22.14', {}, none), { manager: 'volta', command: 'volta install node@22' });
  await rm(path.join(home, '.volta'), { recursive: true });
  const brew = path.join(home, 'brew');
  await files(brew, { 'bin/brew': '' });
  assert.deepEqual(await nodeInstallCommand('lts/iron', {}, { ...none, homebrewPrefixes: [brew] }), { manager: 'Homebrew', command: 'brew install node@20' });
  // nvm for Windows keeps its own folder.
  const windows = path.join(home, 'nvm-windows');
  await mkdir(windows);
  assert.deepEqual(await nodeInstallCommand('22', { NVM_HOME: windows }, { platform: 'win32', home, homebrewPrefixes: [] }), { manager: 'nvm', command: 'nvm install 22' });
  assert.deepEqual(await nodeInstallCommand('node', {}, none), { manager: null, command: null }, 'no version: nothing to install');
});

test('several installed Nodes: the tests are run on each, newest first, and the first they pass on wins; a check that cannot finish decides nothing', async (t) => {
  const root = await folder(t);
  const workflow = { workItem: { id: 'S-1' } };
  const phase = { id: 'implementation', label: 'Implementation' };
  const nodes = { 26: '26.1.0', 24: '24.1.0', 22: '22.14.0' };
  const probing = (passes, status = 'failed') => {
    const calls = [];
    return { calls, probe: async (_root, options) => {
      calls.push(options.node);
      assert.equal(options.within, '120');
      return { node: nodes[options.node], results: [{ commandId: 'tests', status: options.node === passes ? 'passed' : status, tests: { discovered: 3, passed: options.node === passes ? 3 : 1 } }] };
    } };
  };
  const lines = [];
  const one = probing('24');
  const found = await probeInstalledNodes(root, {}, workflow, phase, ['26.1.0', '24.1.0', '22.14.0'], { probe: one.probe, say: (line) => lines.push(line) });
  assert.deepEqual(found, { status: 'passed', version: '24', node: '24.1.0', words: 'It passes on Node 24.1.0 (3 of 3 passed), on a throwaway copy of this checkout' });
  assert.deepEqual(one.calls, ['26', '24']);
  assert.equal(lines[0], 'Checking which installed Node Implementation\'s tests pass on: Node 26.1.0 (up to 120 seconds; nothing is recorded)…');
  const none = probing(null);
  assert.deepEqual(await probeInstalledNodes(root, {}, workflow, phase, ['26.1.0', '24.1.0', '22.14.0'], { probe: none.probe, say: () => {} }), { status: 'failed' });
  assert.equal(none.calls.length, 3);
  const cut = probing(null, 'not-run');
  assert.deepEqual(await probeInstalledNodes(root, {}, workflow, phase, ['26.1.0', '24.1.0'], { probe: cut.probe, say: () => {} }), { status: 'unknown' });
  assert.deepEqual(cut.calls, ['26'], 'stops: an unknown answer is no answer for the next Node either');
});

test('the code step\'s handoff sends no Node SFlow settles to /sf-decide; a person\'s own choice still goes there', () => {
  const handoff = (pin) => testExecutionHandoff({ status: 'not-run', commands: [{ id: 'tests', availability: 'ready' }],
    earlyChecks: [{ id: 'node-version', words: '.nvmrc asks for Node 22, and no installed Node matches.', action: 'Nothing to do.', pin }] }).guidance;
  const settled = handoff({ file: '.nvmrc', version: '26', node: '26.12.0', replaces: '22', by: 'sflow' });
  assert.doesNotMatch(settled, /\/sf-decide|One has a choice/u);
  assert.match(settled, /SFlow settles which Node the tests run on itself before they run, with an undo on the decisions card: nothing to ask\./u);
  assert.match(handoff({ file: '.nvmrc', version: '26', node: '26.12.0', replaces: '22' }), /One has a choice for them: Pin Node 26, on \/sf-decide\./u);
});
