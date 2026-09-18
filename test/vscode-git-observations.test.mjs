import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  configuredGitRemotes, configuredGitRemoteUrls, currentGitSource,
  gitVersion, hasConfiguredGitRemote
} = await import(path.join(root, 'apps/vscode/src/cli/git-observations.ts'));

const ok = (output) => ({
  status: 0, stdout: Buffer.from(output), stderr: '', failure: null
});
const failed = (status, stderr = '') => ({
  status, stdout: Buffer.alloc(0), stderr, failure: null
});

test('VS Code early and World Model Git probes do not bypass the async Git adapter', async () => {
  const extension = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  const worldModel = await readFile(path.join(root, 'apps/vscode/src/world-model-build.ts'), 'utf8');
  assert.doesNotMatch(extension, /promisify\(execFile\)\(\s*['"]git['"]/u);
  assert.doesNotMatch(worldModel, /\b(?:execFileSync|spawnSync|execFile|spawn)\s*\(/u);
  assert.match(worldModel, /await currentGitSource\(active\.root\)/u);
});

test('VS Code early Git observations use the bounded async runner with closed argv', async () => {
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === '--version') return ok('git version 2.51.1\n');
    if (args[0] === 'remote' && args.length === 1) return ok('origin\nbackup\n');
    if (args[0] === 'remote') return ok('https://example.invalid/repo.git\n');
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return ok('topic\n');
    if (args[0] === 'rev-parse') return ok(`${'a'.repeat(40)}\n`);
    return ok('remote.origin.url\nhttps://example.invalid/repo.git\0');
  };
  const options = { runner, signal: new AbortController().signal };
  assert.equal(await gitVersion('/repo', options), 'git version 2.51.1');
  assert.deepEqual(await configuredGitRemotes('/repo', options), ['origin', 'backup']);
  assert.equal(await hasConfiguredGitRemote('/repo', 'origin', options), true);
  assert.deepEqual(await currentGitSource('/repo', options), {
    branch: 'topic', sourceCommit: 'a'.repeat(40)
  });
  assert.deepEqual(await configuredGitRemoteUrls('/repo', options), ['https://example.invalid/repo.git']);
  assert.deepEqual(calls.map(({ args }) => args), [
    ['--version'], ['remote'], ['remote', 'get-url', 'origin'],
    ['rev-parse', '--abbrev-ref', 'HEAD'], ['rev-parse', 'HEAD'],
    ['config', '--local', '--null', '--get-regexp', '^remote\\..*\\.url$']
  ]);
  assert.deepEqual(calls.map(({ options: call }) => call.timeout), [5_000, 10_000, 10_000, 10_000, 10_000, 5_000]);
  assert.ok(calls.every(({ options: call }) => call.cwd === '/repo' && call.signal === options.signal));
});

test('VS Code remote and source probes distinguish absence from Git infrastructure failure', async () => {
  const absent = async () => failed(2, "error: No such remote 'origin'");
  assert.equal(await hasConfiguredGitRemote('/repo', 'origin', { runner: absent }), false);
  await assert.rejects(
    hasConfiguredGitRemote('/repo', 'origin', { runner: async () => failed(2, 'usage: invalid option') }),
    (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE'
  );
  let calls = 0;
  const unavailable = async () => {
    calls += 1;
    return { status: null, stdout: Buffer.alloc(0), stderr: 'password=secret', failure: 'git-unavailable' };
  };
  await assert.rejects(
    hasConfiguredGitRemote('/repo', 'origin', { runner: unavailable }),
    (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE' && !error.message.includes('secret')
  );
  await assert.rejects(
    hasConfiguredGitRemote('/repo', '-unsafe', { runner: unavailable }),
    (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE'
  );
  assert.equal(calls, 1, 'unsafe names reject before spawning');
  assert.equal(await gitVersion('/repo', { runner: unavailable }), null);
  await assert.rejects(
    currentGitSource('/repo', { runner: unavailable }),
    (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE'
  );
  await assert.rejects(
    configuredGitRemotes('/repo', { runner: async () => failed(128, 'token=secret') }),
    (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE' && !error.message.includes('secret')
  );
  await assert.rejects(
    currentGitSource('/repo', { runner: async (args) => args.includes('--abbrev-ref')
      ? ok('topic\n') : ok('not-an-oid\n') }),
    (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE'
  );
});

test('VS Code remote URLs preserve NUL-framed values and reject malformed results', async () => {
  const result = await configuredGitRemoteUrls('/repo', { runner: async () => ok(
    'remote.origin.url\nhttps://example.invalid/with\nnewline\0'
    + 'remote.backup.url\nssh://example.invalid/backup\0'
  ) });
  assert.deepEqual(result, [
    'https://example.invalid/with\nnewline', 'ssh://example.invalid/backup'
  ]);
  assert.deepEqual(await configuredGitRemoteUrls('/repo', {
    runner: async () => failed(1)
  }), [], 'Git uses status 1 for no matching local remote URL');
  for (const output of ['remote.origin.url\nhttps://example.invalid/no-terminator', 'malformed\0']) {
    await assert.rejects(
      configuredGitRemoteUrls('/repo', { runner: async () => ok(output) }),
      (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE'
    );
  }
  await assert.rejects(
    configuredGitRemoteUrls('/repo', { runner: async () => ok(Buffer.from([0xff, 0x00])) }),
    (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE'
  );
  await assert.rejects(
    configuredGitRemoteUrls('/repo', { runner: async () => failed(128, 'credential=secret') }),
    (error) => error.code === 'GIT_OBSERVATION_UNAVAILABLE' && !error.message.includes('secret')
  );
});
