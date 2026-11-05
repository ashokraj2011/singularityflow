import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  nodeInstallRoots, nodeVersionMatches, parseNodeVersionRequest, requestedNodeVersion, withRequestedNode
} from '../src/project-node-version.mjs';
import { classifyTestRunCause } from '../src/test-run-cause.mjs';
import { testRunEnvironmentRecord } from '../src/test-run-environment.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { cli, repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

/**
 * A repository's commands run on the Node it asks for [TCE:REQ-035]. The Nodes here are small
 * scripts that answer --version as a Node would and run the real one for anything else, so a test
 * can see which one a run got: only a script sets FAKE_NODE, and each script's own version is unique.
 */
const posix = { skip: process.platform === 'win32' ? 'the fake Nodes are shell scripts' : false };

async function fakeNode(directory, version, { works = true, log = null } = {}) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'node');
  await writeFile(file, works
    ? `#!/bin/sh\n${log ? `echo called >> '${log}'\n` : ''}if [ "$1" = --version ]; then echo v${version}; exit 0; fi\nFAKE_NODE=${version} exec '${process.execPath}' "$@"\n`
    : '#!/bin/sh\nexit 1\n');
  await chmod(file, 0o755);
  return directory;
}

/** A repository root, a home with the given nvm versions, and a PATH whose node is `onPath`. */
async function machine(t, { nvm = [], onPath = '26.1.0', log = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-version-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  for (const version of nvm) await fakeNode(path.join(home, '.nvm', 'versions', 'node', `v${version}`, 'bin'), version);
  const bin = onPath ? await fakeNode(path.join(base, 'bin'), onPath, { log }) : path.join(base, 'empty');
  return { base, root, home, bin, environment: { HOME: home, PATH: bin, KEPT: 'yes' } };
}

const requested = (context, overrides = {}) => withRequestedNode(context.environment, {
  cwd: context.root, root: context.root, home: context.home, homebrewPrefixes: [], report: () => {}, ...overrides
});

test('a version file is read as a version or not at all, whatever it holds', () => {
  for (const [text, parts] of [
    ['22\n', [22, null, null]], ['v22.14\n', [22, 14, null]], ['22.14.0', [22, 14, 0]], ['# pinned for CI\n\n  v20.11.1  # LTS\n', [20, 11, 1]],
    ['20.x', [20, null, null]], ['\r\n18.20.4\r\n', [18, 20, 4]]
  ]) assert.deepEqual(parseNodeVersionRequest(text).parts, parts, JSON.stringify(text));
  assert.equal(parseNodeVersionRequest('lts/iron').major, 20);
  assert.equal(parseNodeVersionRequest('LTS/*').lts, '*');
  assert.equal(parseNodeVersionRequest('lts/unheardof').major, null);
  assert.equal(parseNodeVersionRequest('stable').any, true);
  for (const text of ['', '   \n', '# only a comment\n', '../../bin/evil', '/usr/bin/node', '$(touch /tmp/x)', '22; rm -rf /', '`id`', '>=20', 'lts/../../x', 'iojs-3', '22.1.2.3', 'v']) {
    assert.equal(parseNodeVersionRequest(text), null, JSON.stringify(text));
  }
});

test('a request accepts the versions it names and no others', () => {
  const accepts = (text, version) => nodeVersionMatches(parseNodeVersionRequest(text), version);
  assert.ok(accepts('22', '22.14.0'));
  assert.ok(!accepts('22', '23.0.0'));
  assert.ok(accepts('22.14', '22.14.9'));
  assert.ok(!accepts('22.14', '22.15.0'));
  assert.ok(accepts('v22.14.0', '22.14.0'));
  assert.ok(!accepts('22.14.0', '22.14.1'));
  assert.ok(accepts('lts/iron', '20.1.0'));
  assert.ok(!accepts('lts/iron', '22.1.0'));
  assert.ok(accepts('lts/*', '26.0.0'));
  assert.ok(!accepts('lts/*', '23.0.0'));
  assert.ok(accepts('node', '23.0.0'));
  assert.ok(!accepts('lts/unheardof', '26.0.0'));
  assert.ok(!accepts('22', 'not a version'));
});

test('with no version file nothing runs and the environment is the same object', posix, async (t) => {
  const log = path.join(os.tmpdir(), `sflow-node-version-log-${process.pid}`);
  t.after(() => rm(log, { force: true }));
  const context = await machine(t, { nvm: ['22.1.0'], log });
  const result = await requested(context);
  assert.equal(result.environment, context.environment);
  assert.equal(result.nodeVersion, null);
  assert.equal(result.explained({ status: 1, stderr: 'boom' }), 'boom');
  await assert.rejects(stat(log), { code: 'ENOENT' }, 'no Node was asked for its version');
});

test('the nearest file wins, .nvmrc before .node-version, and the search stops at the repository root', posix, async (t) => {
  const context = await machine(t, { nvm: ['18.1.0', '20.1.0', '22.1.0'] });
  const packageFolder = path.join(context.root, 'packages', 'app');
  await mkdir(packageFolder, { recursive: true });
  // Above the repository: another project's choice, never this one's.
  await writeFile(path.join(context.base, '.nvmrc'), '18\n');
  assert.equal((await requested(context, { cwd: packageFolder })).nodeVersion, null);

  await writeFile(path.join(context.root, '.nvmrc'), '20\n');
  await writeFile(path.join(context.root, '.node-version'), '18\n');
  let found = (await requested(context, { cwd: packageFolder })).nodeVersion;
  assert.deepEqual([found.file, found.wanted, found.node], ['.nvmrc', '20', '20.1.0']);

  await writeFile(path.join(packageFolder, '.node-version'), '22\n');
  found = (await requested(context, { cwd: packageFolder })).nodeVersion;
  assert.deepEqual([found.file, found.wanted, found.node], ['packages/app/.node-version', '22', '22.1.0']);

  // A root reached through a symbolic link is the same root, as /tmp is on macOS.
  const link = path.join(context.base, 'link');
  await symlink(context.root, link);
  found = (await requested(context, { cwd: path.join(link, 'packages'), root: context.root })).nodeVersion;
  assert.equal(found.wanted, '20');
});

test('a node on PATH that already matches changes nothing, and a shim answers for this folder', posix, async (t) => {
  const context = await machine(t, { nvm: ['22.9.0'], onPath: '22.1.0' });
  await writeFile(path.join(context.root, '.nvmrc'), '22\n');
  const notes = [];
  const result = await requested(context, { report: (line) => notes.push(line) });
  assert.equal(result.environment, context.environment, 'PATH already gives a Node 22');
  assert.deepEqual(result.nodeVersion, { file: '.nvmrc', wanted: '22', status: 'current', node: '22.1.0' });
  assert.deepEqual(notes, []);
});

test('the highest matching installed Node goes first on PATH, and the record names no folder of this machine', posix, async (t) => {
  const context = await machine(t, { nvm: ['18.1.0', '22.1.0', '22.9.0', '23.0.0'] });
  await writeFile(path.join(context.root, '.nvmrc'), '22\n');
  const notes = [];
  const before = { ...context.environment };
  const result = await requested(context, { report: (line) => notes.push(line) });
  const selected = path.join(context.home, '.nvm', 'versions', 'node', 'v22.9.0', 'bin');
  assert.equal(result.environment.PATH, `${selected}:${context.bin}`);
  assert.equal(result.environment.KEPT, 'yes');
  assert.deepEqual(context.environment, before, 'the caller\'s environment is not changed');
  assert.deepEqual(result.nodeVersion, { file: '.nvmrc', wanted: '22', status: 'selected', node: '22.9.0', manager: 'nvm' });
  assert.ok(!JSON.stringify(result.nodeVersion).includes(context.base));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Using Node 22\.9\.0 from nvm for this run: \.nvmrc asks for 22\./u);
  assert.equal(result.explained({ status: 1, stderr: 'boom' }), 'boom', 'a selected Node needs no excuse');
  const ran = spawnSync('node', ['-p', 'process.env.FAKE_NODE'], { env: result.environment, encoding: 'utf8' });
  assert.equal(ran.stdout.trim(), '22.9.0', 'a run starting `node` finds it');
});

test('a PATH variable keeps its own spelling, and an absent PATH becomes the Node alone', posix, async (t) => {
  const context = await machine(t, { nvm: ['22.1.0'] });
  await writeFile(path.join(context.root, '.nvmrc'), '22\n');
  const selected = path.join(context.home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin');
  const spelled = await withRequestedNode({ HOME: context.home, Path: context.bin }, { cwd: context.root, home: context.home, homebrewPrefixes: [], report: () => {} });
  assert.equal(spelled.environment.Path, `${selected}:${context.bin}`);
  assert.equal(spelled.environment.PATH, undefined);
  const absent = await withRequestedNode({ HOME: context.home }, { cwd: context.root, home: context.home, homebrewPrefixes: [], report: () => {} });
  assert.equal(absent.environment.PATH, selected);
  assert.equal(absent.nodeVersion.status, 'selected');
});

test('LTS names resolve from the table and from nvm\'s own aliases; a broken install is passed over', posix, async (t) => {
  const context = await machine(t, { nvm: ['20.1.0', '22.1.0', '24.2.0', '25.0.0'] });
  const ask = async (text) => {
    await writeFile(path.join(context.root, '.nvmrc'), `${text}\n`);
    return (await requested(context)).nodeVersion;
  };
  assert.equal((await ask('lts/iron')).node, '20.1.0');
  assert.equal((await ask('lts/*')).node, '26.1.0', 'the Node on PATH is an LTS already');
  assert.equal((await ask('lts/unheardof')).status, 'not-installed');
  await mkdir(path.join(context.home, '.nvm', 'alias', 'lts'), { recursive: true });
  await writeFile(path.join(context.home, '.nvm', 'alias', 'lts', 'unheardof'), 'v24.0.0\n');
  assert.equal((await ask('lts/unheardof')).node, '24.2.0');

  await fakeNode(path.join(context.home, '.nvm', 'versions', 'node', 'v20.9.0', 'bin'), '20.9.0', { works: false });
  assert.equal((await ask('20')).node, '20.1.0', 'its folder says 20.9.0, but it does not run');
});

test('with nothing installed that matches, the run goes ahead, says so once, and a failed run is read as the toolchain', posix, async (t) => {
  const context = await machine(t, { nvm: ['22.1.0'] });
  await writeFile(path.join(context.root, '.nvmrc'), '18\n');
  const notes = [];
  const report = (line) => notes.push(line);
  const result = await requested(context, { report });
  await requested(context, { report });
  assert.equal(result.environment, context.environment, 'the run keeps the Node PATH finds');
  assert.deepEqual(result.nodeVersion, { file: '.nvmrc', wanted: '18', status: 'not-installed', node: '26.1.0' });
  assert.equal(notes.length, 1, 'once per process, however many commands run');
  assert.match(notes[0], /\.nvmrc asks for Node 18, and no installed Node matches\. This run used Node 26\.1\.0\. .*nvm install 18/u);
  assert.equal(result.explained({ status: 0, stderr: 'quiet' }), 'quiet');
  const stderr = result.explained({ status: 1, stderr: 'TypeError: nope' });
  assert.ok(stderr.startsWith(notes[0]) && stderr.endsWith('TypeError: nope'));
  const cause = classifyTestRunCause({ check: { status: 'failed', exitCode: 1, stdout: '', stderr } });
  assert.deepEqual([cause.category, cause.class], ['environment', 'toolchain-version']);
  const code = classifyTestRunCause({ check: { status: 'failed', exitCode: 2, stdout: '', stderr: result.explained({ status: 2, stderr: 'src/a.ts(1,1): error TS2322: nope' }) } });
  assert.equal(code.category, 'code', 'the wrong Node never excuses a compile error');

  const noNode = await machine(t, { nvm: [], onPath: null });
  await writeFile(path.join(noNode.root, '.nvmrc'), '18\n');
  const none = await requested(noNode, { report });
  assert.deepEqual([none.nodeVersion.status, none.nodeVersion.node], ['not-installed', null]);
  assert.match(notes.at(-1), /No Node was found for this run\./u);
});

test('a file that names no version leaves the run alone and shows nothing of what it holds', posix, async (t) => {
  const context = await machine(t, { nvm: ['22.1.0'] });
  const marker = path.join(context.base, 'ran');
  for (const text of ['../../bin/evil\n', `$(touch '${marker}')\n`, `22; touch '${marker}'\n`, 'x'.repeat(4096)]) {
    await writeFile(path.join(context.root, '.nvmrc'), text);
    const notes = [];
    const result = await requested(context, { report: (line) => notes.push(line) });
    assert.equal(result.environment, context.environment);
    assert.deepEqual(result.nodeVersion, { file: '.nvmrc', wanted: null, status: 'not-a-version', node: '26.1.0' });
    for (const shown of [...notes, JSON.stringify(result.nodeVersion), result.explained({ status: 1, stderr: '' })]) {
      assert.ok(!/evil|touch|xxxx/u.test(shown), shown);
    }
  }
  await assert.rejects(stat(marker), { code: 'ENOENT' }, 'its text was never run');
  // A folder of that name, or an unreadable path, is no version file.
  await rm(path.join(context.root, '.nvmrc'));
  await mkdir(path.join(context.root, '.nvmrc'));
  assert.equal((await requested(context)).nodeVersion, null);
});

test('Homebrew\'s keg-only Nodes are found by their real folder, and a keg that names no version is not', posix, async (t) => {
  const context = await machine(t, {});
  const prefix = path.join(context.base, 'brew');
  await fakeNode(path.join(prefix, 'Cellar', 'node@22', '22.14.0', 'bin'), '22.14.0');
  await mkdir(path.join(prefix, 'opt'), { recursive: true });
  await symlink(path.join(prefix, 'Cellar', 'node@22', '22.14.0'), path.join(prefix, 'opt', 'node@22'));
  await fakeNode(path.join(prefix, 'opt', 'node@20', 'bin'), '20.1.0');
  await writeFile(path.join(context.root, '.nvmrc'), '22\n');
  const result = await requested(context, { homebrewPrefixes: [prefix] });
  assert.deepEqual(result.nodeVersion, { file: '.nvmrc', wanted: '22', status: 'selected', node: '22.14.0', manager: 'Homebrew' });
  assert.equal(result.environment.PATH.split(':')[0], path.join(prefix, 'opt', 'node@22', 'bin'));
  await writeFile(path.join(context.root, '.nvmrc'), '20\n');
  assert.equal((await requested(context, { homebrewPrefixes: [prefix] })).nodeVersion.status, 'not-installed');
});

test('each version manager is looked for where it keeps its Nodes, on POSIX and on Windows', async (t) => {
  const roots = (environment, options) => Object.fromEntries(nodeInstallRoots(environment, options).map(({ manager, root, executable }) => [manager, path.posix.join(root.replaceAll('\\', '/'), '<version>', ...executable)]));
  assert.deepEqual(roots({}, { platform: 'linux', home: '/h' }), {
    nvm: '/h/.nvm/versions/node/<version>/bin/node',
    fnm: '/h/.local/share/fnm/node-versions/<version>/installation/bin/node',
    volta: '/h/.volta/tools/image/node/<version>/bin/node',
    asdf: '/h/.asdf/installs/nodejs/<version>/bin/node',
    mise: '/h/.local/share/mise/installs/node/<version>/bin/node',
    nodenv: '/h/.nodenv/versions/<version>/bin/node',
    n: '/usr/local/n/versions/node/<version>/bin/node'
  });
  assert.equal(roots({}, { platform: 'darwin', home: '/h' }).fnm, '/h/Library/Application Support/fnm/node-versions/<version>/installation/bin/node');
  const moved = roots({ NVM_DIR: '/n', FNM_DIR: '/f', VOLTA_HOME: '/v', ASDF_DATA_DIR: '/a', MISE_DATA_DIR: '/m', NODENV_ROOT: '/o', N_PREFIX: '/p' }, { platform: 'linux', home: '/h' });
  assert.deepEqual(Object.values(moved).map((file) => file.split('/')[1]), ['n', 'f', 'v', 'a', 'm', 'o', 'p']);
  assert.deepEqual(roots({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, { platform: 'win32', home: 'C:\\Users\\u' }), {
    nvm: 'C:/Users/u/AppData/Roaming/nvm/<version>/node.exe',
    fnm: 'C:/Users/u/AppData/Roaming/fnm/node-versions/<version>/installation/node.exe',
    volta: 'C:/Users/u/AppData/Local/Volta/tools/image/node/<version>/node.exe'
  });
  assert.equal(roots({ NVM_HOME: 'D:\\nvm' }, { platform: 'win32', home: 'C:\\Users\\u' }).nvm, 'D:/nvm/<version>/node.exe');
});

test('an attempt records the Node the file asked for only when there is a file', posix, async (t) => {
  const context = await machine(t, { nvm: ['22.1.0'] });
  const command = { argv: ['node', '--test'], result: { adapter: 'node-tap' } };
  const without = await testRunEnvironmentRecord(command, { cwd: context.root, environment: context.environment });
  assert.equal(Object.hasOwn(without, 'nodeVersion'), false, 'a repository with no file keeps its earlier digest');
  await writeFile(path.join(context.root, '.nvmrc'), '22\n');
  const { environment, nodeVersion } = await requested(context);
  const record = await testRunEnvironmentRecord(command, { cwd: context.root, environment, nodeVersion });
  assert.deepEqual(record.nodeVersion, nodeVersion);
  assert.equal(record.toolchain.node, '22.1.0', 'the toolchain is what the run found');
});

test('a build and a test at a gate, and tests run, get the Node .nvmrc asks for', slowLane({ ...posix, timeout: 480_000 }), async (t) => {
  // The build leaves word of the Node it ran on, so a gate that never ran it cannot pass here.
  const build = "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.BUILD_SEEN, String(process.env.FAKE_NODE));\n";
  const repo = await repository(t, {
    files: { '.nvmrc': '99.1\n', 'tools/build.mjs': build },
    implementQualityCommands: [{ id: 'build', kind: 'compile', argv: ['node', 'tools/build.mjs'], workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never' }]
  });
  const { root, sflow } = repo;
  await fakeNode(path.join(repo.base, 'home', '.nvm', 'versions', 'node', 'v99.1.0', 'bin'), '99.1.0');
  await startQuickFix(repo);
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + `import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n\ntest('the Node the repository asks for', () => assert.equal(process.env.FAKE_NODE, '99.1.0'));\n`);
  sflow('prepare', 'implement');
  const seen = path.join(repo.base, 'build-seen');
  const env = { ...repo.env, NVM_DIR: path.join(repo.base, 'home', '.nvm'), BUILD_SEEN: seen };
  const run = (...args) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env, encoding: 'utf8', timeout: childTimeout(240_000) });
  const local = run('tests', 'run', '--work-id', 'QF-1', '--json');
  assert.equal(local.status, 0, local.stdout + local.stderr);
  assert.match(local.stderr, /Using Node 99\.1\.0 from nvm for this run: \.nvmrc asks for 99\.1\./u);
  const published = run('phase', 'publish', 'implement');
  assert.equal(published.status, 0, published.stdout + published.stderr);
  const submitted = run('submit', 'implement');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  assert.equal(await readFile(seen, 'utf8'), '99.1.0', 'the build ran on it');
  const directory = path.join(root, 'singularity/work-items/QF-1/context/code-delivery/tests/attempts/implement');
  const attempts = await Promise.all((await readdir(directory)).map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  assert.ok(attempts.length >= 2, 'a local run and a gate run');
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'passed', attempt.purpose);
    assert.deepEqual(attempt.environment.nodeVersion, { file: '.nvmrc', wanted: '99.1', status: 'selected', node: '99.1.0', manager: 'nvm' }, attempt.purpose);
    assert.equal(attempt.environment.toolchain.node, '99.1.0', attempt.purpose);
    assert.ok(!JSON.stringify(attempt.environment).includes(repo.base), 'a committed attempt names no folder of this machine');
  }
});
