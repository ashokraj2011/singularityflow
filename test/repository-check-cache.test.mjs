import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachedRepositoryCheck, repositoryCheckStatus, routineRepositoryChecksAllowed, withFreshRepositoryChecks } from '../src/repository-check-cache.mjs';
import { normalizeRepositoryCheckSettings, repositoryCheckSettings, saveRepositoryCheckSettings } from '../src/repository-check-settings.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { withFreshGitFacts } from '../src/git-fact-cache.mjs';

function operation(id, fn, parent = null) {
  const run = () => withOperationContext({ operation: { id, classification: 'read', modelPolicy: 'never' },
    modelMode: { enabled: false } }, fn);
  return parent ? operation(parent, run) : run();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-repository-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config'),
    SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: path.join(root, 'preferences.json') };
  delete env.SINGULARITY_FLOW_GIT_FACT_CACHE;
  delete env.SINGULARITY_FLOW_REPOSITORY_CHECK_MODE;
  delete env.SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES;
  const git = args => execFileSync('git', args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Cache tester']); git(['config', 'user.email', 'cache@example.invalid']);
  const file = path.join(root, 'observed.json'); await writeFile(file, '{}\n');
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const options = { kind: 'accepted-workflow', identity: { workId: 'future-phase' }, files: [file], env };
  const directory = path.join(root, '.git/singularity-flow/cache/repository-checks');
  const cacheFile = async () => path.join(directory, (await readdir(directory)).find(name => name.endsWith('.json')));
  return { root, env, git, file, options, directory, cacheFile };
}

test('defaults, workspace overrides and shell overrides are local and validated', async t => {
  const f = await fixture(t);
  assert.deepEqual(repositoryCheckSettings(f.root, { env: f.env }), { mode: 'cached', intervalMinutes: 30 });
  await saveRepositoryCheckSettings({ mode: 'always', intervalMinutes: 5 }, { file: f.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES });
  await saveRepositoryCheckSettings({ mode: 'manual', intervalMinutes: 45 }, {
    file: f.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES, workspacePath: f.root
  });
  assert.deepEqual(repositoryCheckSettings(f.root, { env: f.env }), { mode: 'manual', intervalMinutes: 45 });
  assert.deepEqual(repositoryCheckSettings(f.root, { env: { ...f.env, SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'cached',
    SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES: '10' } }), { mode: 'cached', intervalMinutes: 10 });
  for (const settings of [null, 'manual', { mode: 'off' }, { intervalMinutes: 0 }, { intervalMinutes: 1.5 }, { intervalMinutes: Infinity }]) {
    assert.throws(() => normalizeRepositoryCheckSettings(settings), { code: 'REPOSITORY_CHECK_SETTINGS_INVALID' });
  }
  assert.equal(repositoryCheckSettings(f.root, { env: { ...f.env, SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'off' } }).mode, 'always');
  await saveRepositoryCheckSettings(null, { file: f.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES, workspacePath: f.root });
  assert.deepEqual(repositoryCheckSettings(f.root, { env: f.env }), { mode: 'always', intervalMinutes: 5 },
    'clearing a workspace override restores user defaults, not a stale mirror');
});

test('phase, next and session share a persistent successful result; explicit refresh ignores it', async t => {
  const f = await fixture(t); let calls = 0;
  const verify = async () => ({ status: 'ready', bytes: new Map([['agent', Buffer.from('original')]]), n: ++calls });
  const first = await operation('phase.enter.compose', () => cachedRepositoryCheck(f.root, f.options, verify));
  assert.equal(first.n, 1);
  first.bytes.set('agent', Buffer.from('caller edit'));
  for (const id of ['nextsteps', 'session.open-local', 'session.status', 'phase.enter', 'phase.enter.compose']) {
    const cached = await operation(id, () => cachedRepositoryCheck(f.root, f.options, verify));
    assert.equal(cached.n, 1, id);
    assert.equal(cached.bytes.get('agent').toString(), 'original');
    assert.equal(repositoryCheckStatus(f.root).source, 'cache');
  }
  await operation('check', () => withFreshRepositoryChecks(() => cachedRepositoryCheck(f.root, f.options, verify)));
  assert.equal(calls, 2);
  assert.equal(repositoryCheckStatus(f.root).source, 'fresh');
  assert.equal(repositoryCheckStatus(f.root).refresh.copilotCommand, '/sf-check');
  await operation('nextsteps', () => withFreshGitFacts(() => cachedRepositoryCheck(f.root, f.options, verify)));
  assert.equal(calls, 3, 'a fresh Git-proof boundary cannot be hidden by a higher-level cache');
});

test('a refused explicit refresh invalidates the previous success before verification', async t => {
  const f = await fixture(t); let calls = 0;
  const run = () => cachedRepositoryCheck(f.root, f.options, async () => ({ n: ++calls }));
  await operation('nextsteps', run);
  await assert.rejects(operation('check', () => withFreshRepositoryChecks(() =>
    cachedRepositoryCheck(f.root, f.options, async () => { throw new Error('new refusal'); }))), /new refusal/);
  await operation('nextsteps', run);
  assert.equal(calls, 2, 'the old successful result was not resurrected');
});

test('cached mode expires at the configured boundary; manual refresh does not become a hidden TTL', async t => {
  const f = await fixture(t); let calls = 0;
  const run = () => operation('nextsteps', () => cachedRepositoryCheck(f.root, f.options, async () => ({ n: ++calls })));
  await run();
  const file = await f.cacheFile();
  const expired = JSON.parse(await readFile(file, 'utf8')); expired.checkedAt = Date.now() - 31 * 60_000;
  await writeFile(file, JSON.stringify(expired));
  await run(); assert.equal(calls, 2);
  await saveRepositoryCheckSettings({ mode: 'manual', intervalMinutes: 1 }, { file: f.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES });
  const manual = JSON.parse(await readFile(file, 'utf8')); manual.checkedAt = Date.now() - 7 * 24 * 60 * 60_000;
  await writeFile(file, JSON.stringify(manual));
  await run(); assert.equal(calls, 2);
  await saveRepositoryCheckSettings({ mode: 'always', intervalMinutes: 30 }, { file: f.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES });
  await run(); await run(); assert.equal(calls, 4);
});

test('Story bytes, HEAD, index, config, environment and worktrees invalidate independently', async t => {
  const f = await fixture(t); let calls = 0;
  const run = (options = f.options) => operation('nextsteps', () => cachedRepositoryCheck(f.root, options, async () => ({ n: ++calls })));
  await run(); await run(); assert.equal(calls, 1);
  await writeFile(f.file, '{"changed":true}\n'); await run(); assert.equal(calls, 2);
  f.git(['add', 'observed.json']); await run(); assert.equal(calls, 3);
  f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'changed']); await run(); assert.equal(calls, 4);
  f.git(['config', 'user.name', 'Another tester']); await run(); assert.equal(calls, 5);
  await run({ ...f.options, env: { ...f.env, SINGULARITY_FLOW_TEST_IDENTITY: 'changed identity' } });
  assert.equal(calls, 6);
  await run({ ...f.options, identity: { workId: 'another-story' } }); assert.equal(calls, 7);
});

test('writers, nested writes and ordinary library calls cannot reuse routine verification', async t => {
  const f = await fixture(t); let calls = 0;
  const run = () => cachedRepositoryCheck(f.root, f.options, async () => ({ n: ++calls }));
  await operation('nextsteps', run);
  for (const id of ['phase.prepublish', 'phase.publish', 'approve', 'submit', 'prepare', 'recover', 'review-source.context']) {
    await operation(id, run);
    await operation('nextsteps', run, id);
  }
  await run(); assert.equal(calls, 16);
  assert.equal(await operation('approve', () => routineRepositoryChecksAllowed()), false);
});

test('failed, corrupt, oversized and symlinked caches fall back to real verification', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(operation('nextsteps', () => cachedRepositoryCheck(f.root, f.options,
    async () => { throw new Error('verification refused'); })), /verification refused/);
  const run = () => operation('nextsteps', () => cachedRepositoryCheck(f.root, f.options, async () => ({ n: ++calls })));
  await run(); const file = await f.cacheFile();
  await writeFile(file, 'broken'); await run(); assert.equal(calls, 2);
  const record = JSON.parse(await readFile(file, 'utf8')); record.sha256 = '0'.repeat(64);
  await writeFile(file, JSON.stringify(record)); await run(); assert.equal(calls, 3);
  await writeFile(file, Buffer.alloc(12 * 1024 * 1024 + 1)); await run(); assert.equal(calls, 4);
  await rm(file);
  const other = path.join(f.root, 'unrelated'); await writeFile(other, 'preserve me');
  await symlink(other, file).catch(error => { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; });
  await run(); assert.equal(calls, 5);
  assert.equal(await readFile(other, 'utf8'), 'preserve me');
});
