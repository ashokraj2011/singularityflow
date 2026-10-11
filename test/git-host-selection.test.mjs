import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  APPLE_GIT_UNAVAILABLE_MESSAGE, gitDeveloperToolsUnavailable, gitHostChildEnvironment, gitHostSearchDirectories,
  isAppleDeveloperGit
} from '../src/git-host-selection.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import { createGitRuntime } from '../src/git-access.mjs';
import { enterpriseGitEnvironment } from '../src/git-enterprise-environment.mjs';
import { gitReadOutput, run } from '../src/util.mjs';
import { resolvePosixGitExecutable } from '../apps/vscode/src/cli/runner.ts';

const license = 'You have not agreed to the Xcode license agreements. Please run sudo xcodebuild -license';
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const file = { isFile: () => true, mode: 0o755 };
function filesystem(available, links = new Map()) {
  const canonicalize = (candidate) => links.get(candidate) ?? candidate;
  const stat = (candidate) => available.has(candidate) ? file : missing();
  return { canonicalize, stat };
}
function resolve(platform, available, environment, links) {
  const fs = filesystem(available, links);
  return resolvePlatformProcess('git', ['rev-parse', '--git-common-dir'], {
    platform, environment, cwd: '/work/story',
    realpathSyncCommand: fs.canonicalize, lstatSyncCommand: fs.stat,
    spawnSyncCommand() { throw new Error('selection must not launch Xcode, probes, or mutations'); }
  }).executable;
}

test('macOS engine and VS Code prefer standalone Git even when Apple Git is first on PATH', async () => {
  const available = new Set(['/usr/bin/git', '/opt/homebrew/bin/git']);
  for (const environment of [{ PATH: '/usr/bin:/opt/homebrew/bin' }, { PATH: '/usr/bin:/bin' }]) {
    assert.equal(resolve('darwin', available, environment), '/opt/homebrew/bin/git');
    assert.equal(await resolvePosixGitExecutable('/work/story', environment, filesystem(available), 'darwin'),
      '/opt/homebrew/bin/git');
  }
});

test('standalone-only macOS needs no Apple developer tools; Linux PATH ordering remains unchanged', async () => {
  const standalone = new Set(['/standalone/git']);
  assert.equal(resolve('darwin', standalone, { PATH: '/standalone' }), '/standalone/git');
  const available = new Set(['/usr/bin/git', '/standalone/git', '/opt/homebrew/bin/git']);
  const environment = { PATH: '/usr/bin:/standalone' };
  assert.equal(resolve('linux', available, environment), '/usr/bin/git');
  assert.equal(await resolvePosixGitExecutable('/work/story', environment, filesystem(available), 'linux'), '/usr/bin/git');
  assert.deepEqual(gitHostSearchDirectories({ Path: 'C:\\Git\\cmd;C:\\Windows' }, 'win32'),
    ['C:\\Git\\cmd', 'C:\\Windows']);
  assert.deepEqual(gitHostSearchDirectories({ PATH: '/usr/bin' }, 'linux'), ['/usr/bin']);
});

test('Apple Git remains usable if no standalone Git exists; repository shadows stay excluded', async () => {
  const available = new Set(['/usr/bin/git', '/work/story/tools/git']);
  const links = new Map([['/opt/homebrew/bin/git', '/work/story/tools/git']]);
  const environment = { PATH: '.:/work/story/tools:/usr/bin' };
  assert.equal(resolve('darwin', available, environment, links), '/usr/bin/git');
  assert.equal(await resolvePosixGitExecutable('/work/story', environment, filesystem(available, links), 'darwin'),
    '/usr/bin/git');
  assert.throws(() => resolve('darwin', new Set(), environment), /absolute PATH entries/u);
  assert.deepEqual(gitHostSearchDirectories({ PATH: '.:/work/story' }, 'darwin'), ['.', '/work/story']);
});

test('Apple-toolchain failures are platform-specific and never expose raw stderr or accept a license', () => {
  for (const stderr of [license, 'xcode-select: error: no developer tools were found',
    'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)']) {
    assert.equal(gitDeveloperToolsUnavailable({ status: 69, stderr }, 'darwin'), true);
    assert.equal(gitDeveloperToolsUnavailable({ status: 69, stderr }, 'win32'), false);
    assert.equal(gitDeveloperToolsUnavailable({ status: 69, stderr }, 'linux'), false);
  }
  for (const result of [{ status: 0, stderr: license }, { status: 69, stderr: license, timedOut: true },
    { status: 128, stderr: 'Permission denied reading gitconfig' }, { status: 1, stderr: '' }]) {
    assert.equal(gitDeveloperToolsUnavailable(result, 'darwin'), false);
  }
  assert.equal(isAppleDeveloperGit('/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git'), true);
  assert.equal(isAppleDeveloperGit('/standalone/git'), false);
  let launches = 0;
  assert.throws(() => run('git', ['rev-parse', '--git-common-dir'], {
    platform: 'darwin', cwd: '/work/story', env: { PATH: '/usr/bin' },
    platformRealpathCommand: (candidate) => candidate,
    platformLstatCommand: (candidate) => candidate === '/usr/bin/git' ? file : missing(),
    spawnSyncCommand(executable, args) {
      launches += 1;
      assert.equal(executable, '/usr/bin/git');
      assert.deepEqual(args, ['rev-parse', '--git-common-dir']);
      return { status: 69, stdout: '', stderr: `${license}\npassword=never-show` };
    }
  }), (error) => error.code === 'GIT_DEVELOPER_TOOLS_UNAVAILABLE'
    && error.message === APPLE_GIT_UNAVAILABLE_MESSAGE && error.details.requiresXcode === false
    && !error.message.includes('never-show'));
  assert.equal(launches, 1, 'never retry an operation or auto-accept a license');
});

test('child Git retains its selected installation and exact credential configuration without changing the caller', () => {
  const source = { Path: '/usr/bin:/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: 'approved-helper', HTTPS_PROXY: 'approved-proxy' };
  const result = gitHostChildEnvironment(source, '/opt/homebrew/Cellar/git/2.54.0/bin/git', 'darwin');
  assert.equal(result.PATH, '/opt/homebrew/Cellar/git/2.54.0/bin:/usr/bin:/bin');
  assert.equal(result.Path, undefined);
  assert.equal(result.GIT_CONFIG_VALUE_0, source.GIT_CONFIG_VALUE_0);
  assert.equal(result.HTTPS_PROXY, source.HTTPS_PROXY);
  assert.equal(source.Path, '/usr/bin:/bin');
  assert.equal(source.PATH, undefined);
  assert.equal(gitHostChildEnvironment(source, '/usr/bin/git', 'linux'), source);
  assert.equal(gitHostChildEnvironment(source, 'C:\\Git\\git.exe', 'win32'), source);
});

test('allow-failure Git reads do not misreport an Apple-toolchain failure as an absent record', {
  skip: process.platform !== 'darwin'
}, () => {
  assert.throws(() => gitReadOutput({ status: 69, stderr: license }, 'Repository root', { absentStatus: 69 }),
    (error) => error.code === 'GIT_DEVELOPER_TOOLS_UNAVAILABLE' && error.message.includes('Xcode is optional'));
});

test('enterprise configuration preserves fail-closed policy while naming optional Apple tools', {
  skip: process.platform !== 'darwin'
}, () => {
  const scopes = [];
  assert.throws(() => enterpriseGitEnvironment({ ...process.env }, {
    runCommand(_command, args) {
      scopes.push(args.includes('--system') ? 'system' : 'global');
      return { status: 69, stdout: '', stderr: `${license}\npassword=never-show` };
    }
  }), (error) => error.code === 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE'
    && error.details.reason === 'developer-tools-unavailable'
    && error.message.includes('Xcode is optional') && !error.message.includes('never-show'));
  assert.deepEqual(scopes, ['system', 'global']);
});

test('GAL and the engine resolve the same standalone Git on this Mac; explicit pins never fall back', {
  skip: process.platform !== 'darwin'
}, async (t) => {
  const environment = { ...process.env, PATH: '/usr/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin' };
  const expected = resolvePlatformProcess('git', ['--version'], { environment }).executable;
  const created = await createGitRuntime({ trustedEnvironment: environment });
  assert.equal(created.ok, true, JSON.stringify(created));
  t.after(() => created.value.dispose());
  assert.equal(created.value.identity.path, expected);
  const absent = await createGitRuntime({ trustedGitPath: '/missing/approved/git', trustedEnvironment: environment });
  assert.equal(absent.ok, false);
  assert.equal(absent.code, 'GAL_EXECUTABLE_UNAVAILABLE');
});

test('workspace UI distinguishes optional-toolchain failure from a missing Story checkout', async () => {
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /current\.selectionErrorCode === 'GIT_DEVELOPER_TOOLS_UNAVAILABLE'/u);
  assert.match(extension, /Standalone Git is needed; Xcode is optional/u);
  const context = await readFile(new URL('../src/workspace-context.mjs', import.meta.url), 'utf8');
  assert.match(context, /selectionErrorCode: error\.code \?\? null/u);
});
