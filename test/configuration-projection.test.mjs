import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConfigurationProjection, fetchConfigurationBase } from '../src/configuration-projection.mjs';
import { frozenRemoteTransport } from '../src/git-remote-diagnostics.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { run } from '../src/util.mjs';

async function fixture(t, { count = 3, partial = true, format = 'sha1' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-projection-objects-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), remote = path.join(base, 'authority.git'), root = path.join(base, 'workspace');
  const git = (cwd, args, options = {}) => run('git', args, { cwd, ...options }).stdout.trim();
  git(base, ['init', '-q', `--object-format=${format}`, '-b', 'main', source]);
  await mkdir(path.join(source, '.github', 'agents'), { recursive: true });
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const name = `.github/agents/agent-${i}.agent.md`, bytes = `Agent ${i}\n`;
    files.set(name, bytes); await writeFile(path.join(source, name), bytes);
  }
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Configuration']);
  git(source, ['branch', 'sflow/config']);
  git(base, ['clone', '-q', '--bare', source, remote]);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  const url = pathToFileURL(remote).href;
  git(base, ['clone', '-q', '--no-checkout', ...(partial ? ['--filter=blob:none'] : []), url, root]);
  await writeFile(path.join(root, 'unrelated.txt'), 'Preserve this user file.\n');
  const before = { config: await readFile(path.join(root, '.git/config')), head: git(root, ['rev-parse', 'HEAD']) };
  const transport = frozenRemoteTransport(url);
  const fetched = await fetchConfigurationBase(root, transport, { branch: 'sflow/config' });
  assert.equal(fetched.failure, null);
  const project = async (name, download = runRemoteGitAsync) => {
    const directory = path.join(base, name); await mkdir(directory);
    await createConfigurationProjection(root, directory, fetched.commit, { branch: 'sflow/config', env: transport.env, transport, runRemoteCommand: download });
    return directory;
  };
  return { base, root, remote, transport, fetched, files, before, project, git };
}

test('a blobless workspace hydrates only missing configuration objects once and reuses them without changing its checkout', async t => {
  const f = await fixture(t);
  const calls = [];
  const download = async (args, options) => { calls.push({ args, options }); return runRemoteGitAsync(args, options); };
  const first = await f.project('first', download);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, f.root, 'Downloaded objects belong to the durable workspace cache.');
  assert.equal(calls[0].args.at(-4), f.transport.remote);
  assert.ok(calls[0].args.slice(-3).every(oid => /^[a-f0-9]{40}$/u.test(oid)));
  assert.ok(!calls[0].args.some(arg => arg === '--all' || arg.startsWith('--filter')));
  for (const [name, text] of f.files) assert.equal(await readFile(path.join(first, name), 'utf8'), text);
  await f.project('second', download);
  assert.equal(calls.length, 1, 'A second projection uses the hydrated objects without another blob fetch.');
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), f.before.head);
  assert.deepEqual(await readFile(path.join(f.root, '.git/config')), f.before.config);
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'Preserve this user file.\n');
  assert.equal(f.git(f.root, ['status', '--porcelain', '--untracked-files=normal']).includes('unrelated.txt'), true);
});

test('complete clones need no object download; SHA-256 projections use the source object format', async t => {
  const f = await fixture(t, { partial: false, format: 'sha256' });
  const target = await f.project('complete', () => { throw new Error('Complete objects must not be downloaded again.'); });
  assert.equal(f.git(target, ['rev-parse', '--show-object-format']), 'sha256');
  assert.equal(f.git(target, ['rev-parse', 'HEAD']), f.fetched.commit);
});

test('large missing inventories use Windows-safe bounded batches through the approved authority', async t => {
  const f = await fixture(t, { count: 260 });
  f.git(f.root, ['remote', 'set-url', 'origin', path.join(f.base, 'unavailable-application-origin.git')]);
  const calls = [];
  await f.project('batched', async (args, options) => { calls.push(args); return runRemoteGitAsync(args, options); });
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert.equal(args[args.indexOf('--') + 1], f.transport.remote);
    assert.ok(args.length - args.indexOf('--') - 2 <= 128);
  }
});

test('hydration failures preserve authentication evidence and never expose credential-shaped provider text', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.project('denied', async () => ({ status: 128,
    stderr: "could not read Username for 'https://fixture-user:secret-value@example.invalid/private.git'",
    failure: { code: 'REMOTE_AUTHENTICATION_REQUIRED', classification: 'authentication-required', advice: 'Sign in to Git and retry.' } })), error => {
    assert.equal(error.code, 'REMOTE_AUTHENTICATION_REQUIRED');
    assert.equal(error.details.stage, 'configuration-object-hydration');
    assert.equal(error.details.missingObjects, 3);
    assert.match(error.message, /Sign in to Git/u);
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /fixture-user|secret-value|private\.git/u);
    return true;
  });
  assert.deepEqual(await readFile(path.join(f.root, '.git/config')), f.before.config);
});

test('a successful fetch must actually make every referenced blob available before files are written', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.project('incomplete', async () => ({ status: 0, stdout: '', stderr: '' })), error => {
    assert.equal(error.code, 'CONFIGURATION_PROJECTION_OBJECTS_UNAVAILABLE');
    assert.equal(error.details.missingObjects, 3);
    return true;
  });
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), f.before.head);
});

test('a hydration timeout retains the deadline evidence and does not silently retry through another remote', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(() => f.project('timeout', async (_args, options) => {
    calls++;
    assert.ok(options.timeoutMs > 0);
    return { status: null, timedOut: true, signal: 'SIGTERM', stderr: 'deadline exceeded',
      failure: { code: 'REMOTE_TIMEOUT', classification: 'timeout', advice: 'Check remote access and retry the same operation.' } };
  }), error => {
    assert.equal(error.code, 'REMOTE_TIMEOUT');
    assert.equal(error.details.evidence.timedOut, true);
    assert.equal(error.details.evidence.signal, 'SIGTERM');
    assert.equal(error.details.stage, 'configuration-object-hydration');
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(path.join(f.root, '.git/config')), f.before.config);
});
