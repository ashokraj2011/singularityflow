import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readdir, rename, rm, utimes, writeFile, readFile } from 'node:fs/promises';
import { prepareConfigurationObjectCheckout } from '../src/configuration-object-store.mjs';
import { cloneCapabilityConfiguration } from '../src/capability-configuration-checkout.mjs';
import { frozenRemoteTransport } from '../src/git-remote-diagnostics.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { materializeConfigurationSnapshot } from '../src/configuration-state-git.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { run } from '../src/util.mjs';
import { remoteFingerprint } from '../src/git-remote-diagnostics.mjs';

test('private object pool reuses exact commits and blobs but never changes the application checkout', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-object-pool-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), remote = path.join(base, 'authority.git');
  run('git', ['init', '--quiet', '--template=', '-b', 'main', source]);
  run('git', ['config', 'user.name', 'Fixture'], { cwd: source });
  run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: source });
  await import('node:fs/promises').then(fs => fs.mkdir(path.join(source, 'singularity')));
  await writeFile(path.join(source, 'singularity/workflow.yml'), 'version: 2\n');
  await writeFile(path.join(source, 'README.md'), '# Application stays unchanged\n');
  run('git', ['add', '.'], { cwd: source }); run('git', ['commit', '-qm', 'baseline'], { cwd: source });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
  run('git', ['branch', 'sflow/config'], { cwd: source });
  run('git', ['clone', '--quiet', '--bare', '--', source, remote]);
  const before = await readFile(path.join(source, '.git/index'));
  let unsupported = false;
  const read = async () => {
    const scratch = await mkdtemp(path.join(base, 'read-'));
    const timer = commandTimer('object-pool', { commandClass: 'read' });
    await withCommandTiming(timer, async () => {
      const transport = frozenRemoteTransport(remote);
      const pool = await prepareConfigurationObjectCheckout(source, scratch, { remote, transport,
        authorityCommit: commit, runRemoteCommand: runRemoteGitAsync });
      if (!pool && process.platform === 'win32') {
        unsupported = true; t.skip('Private object-store ACL profile is unavailable; original reads remain supported.'); return;
      }
      assert.ok(pool, 'qualified hosts must admit a pool');
      try {
        const reader = await materializeConfigurationSnapshot(scratch, transport.remote, commit, transport.env, pool.download);
        assert.equal(reader.file(commit, 'singularity/workflow.yml').bytes.toString(), 'version: 2\n');
      } finally { await rm(scratch, { recursive: true, force: true }); await pool.release(); }
    });
    return timer.finish().counters;
  };
  const cold = await read();
  if (unsupported) return;
  const warm = await read();
  assert.equal(cold['configuration.object-store-fetch'], 1);
  assert.equal(warm['configuration.object-store-hit'], 1);
  assert.equal(warm['git.remote.commands'] ?? 0, 0, 'exact object reuse requires no object transport');
  assert.deepEqual(await readFile(path.join(source, '.git/index')), before);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim(), commit);
});

test('complete configuration pools reuse deep paged capability refs without sharing filtered objects', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-complete-object-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), remote = path.join(base, 'authority.git');
  run('git', ['init', '--quiet', '--template=', '-b', 'main', source]);
  const git = (...args) => run('git', args, { cwd: source }).stdout.trim();
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(source, 'README.md'), '# baseline\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const authorityCommit = git('rev-parse', 'HEAD');
  git('branch', 'sflow/config');
  await writeFile(path.join(source, 'new.md'), 'new proposal body\n');
  git('add', '.'); git('commit', '-qm', 'proposal');
  const proposalCommit = git('rev-parse', 'HEAD');
  // Short enough in the source checkout, beyond MAX_PATH under the pool's authority hash.
  const branch = `sflow/config-change/capability/map-${'component-'.repeat(5)}12345678`;
  git('branch', branch);
  run('git', ['clone', '--quiet', '--bare', '--', source, remote]);
  const reads = [];
  const download = async (args, options) => { reads.push(args); return runRemoteGitAsync(args, options); };
  for (const iteration of [0, 1]) {
    const scratch = await mkdtemp(path.join(base, 'read-'));
    const transport = frozenRemoteTransport(remote);
    const pool = await prepareConfigurationObjectCheckout(source, scratch, {
      remote, transport, authorityCommit, completeObjects: true, runRemoteCommand: download
    });
    if (!pool && process.platform === 'win32') { t.skip('Private object-store ACL profile unavailable'); return; }
    assert.ok(pool);
    try {
      const before = reads.length;
      await pool.includeBranches([{ branch, proposalCommit }]);
      assert.equal(reads.length - before, iteration === 0 ? 1 : 0);
      assert.equal(run('git', ['show', `refs/remotes/origin/${branch}:new.md`], { cwd: scratch }).stdout,
        'new proposal body\n');
      await assert.rejects(pool.includeBranches([{ branch: 'bad\nref', proposalCommit }]),
        error => error.code === 'CONFIGURATION_OBJECT_STORE_UNSAFE');
    } finally { await rm(scratch, { recursive: true, force: true }); await pool.release(); }
  }
  assert.equal(reads.length, 2, 'authority and proposal transfer once, not on every list request');
  assert.ok(reads.every(args => !args.includes('--filter=blob:none')));
  const scratch = await mkdtemp(path.join(base, 'mutation-'));
  const cloned = await cloneCapabilityConfiguration(scratch, {
    remote, transport: frozenRemoteTransport(remote), authorityCommit, fullHistory: true,
    cacheRoot: source, runRemoteCommand: download
  });
  assert.equal(cloned.status, 0);
  assert.equal(reads.length, 2, 'remap/review reuse needs no configuration history transfer');
  await assert.rejects(readFile(path.join(scratch, '.git/objects/info/alternates')), { code: 'ENOENT' });
  await rename(path.join(source, '.git/singularity-flow/configuration-objects-complete-v1'),
    path.join(base, 'unavailable-cache'));
  assert.equal(run('git', ['show', `${authorityCommit}:README.md`], { cwd: scratch }).stdout, '# baseline\n',
    'retained mutation recovery owns its objects even after the derived cache disappears');
});

test('a full pool makes room for a new remote by removing its least recently used idle authority', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-object-pool-evict-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  run('git', ['init', '--quiet', '--template=', '-b', 'main', source]);
  run('git', ['config', 'user.name', 'Fixture'], { cwd: source });
  run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# pool\n');
  run('git', ['add', '.'], { cwd: source }); run('git', ['commit', '-qm', 'baseline'], { cwd: source });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
  run('git', ['branch', 'sflow/config'], { cwd: source });
  // Ten authorities: each bare copy is a distinct remote with its own pool.
  const remotes = Array.from({ length: 10 }, (_, index) => path.join(base, `authority-${index}.git`));
  for (const remote of remotes) run('git', ['clone', '--quiet', '--bare', '--', source, remote]);
  const local = path.join(source, '.git', 'singularity-flow', 'configuration-objects-v1');
  const pools = async () => (await readdir(local)).filter(name => /^[a-f0-9]{64}$/u.test(name)).sort();
  const borrow = async (remote) => {
    const scratch = await mkdtemp(path.join(base, 'read-'));
    const pool = await prepareConfigurationObjectCheckout(source, scratch, { remote,
      transport: frozenRemoteTransport(remote), authorityCommit: commit, runRemoteCommand: runRemoteGitAsync });
    return { pool, async release() { await rm(scratch, { recursive: true, force: true }); await pool?.release(); } };
  };
  const first = await borrow(remotes[0]);
  if (!first.pool && process.platform === 'win32') { t.skip('Private object-store ACL profile unavailable'); return; }
  await first.release();
  for (const remote of remotes.slice(1, 8)) await (await borrow(remote)).release();
  assert.equal((await pools()).length, 8);
  // Last use is the pool directory's modification time: authority-0 oldest, authority-7 newest.
  for (const [index, remote] of remotes.slice(0, 8).entries()) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, index));
    await utimes(path.join(local, remoteFingerprint(remote)), at, at);
  }

  // authority-0 is borrowed, so the oldest idle pool, authority-1, makes room for authority-8.
  const held = await borrow(remotes[0]);
  assert.ok(held.pool, 'an existing authority always reuses its own pool');
  const timer = commandTimer('object-pool-evict', { commandClass: 'read' });
  await withCommandTiming(timer, async () => {
    const next = await borrow(remotes[8]);
    assert.ok(next.pool, 'a full pool admits a new remote once an idle authority is removed');
    await next.release();
  });
  assert.equal(timer.finish().counters['configuration.object-store-evicted'], 1);
  const after = await pools();
  assert.equal(after.length, 8, 'the pool never grows past its bound');
  assert.ok(after.includes(remoteFingerprint(remotes[0])), 'a borrowed authority is never removed');
  assert.ok(!after.includes(remoteFingerprint(remotes[1])), 'the least recently used idle authority is removed');
  assert.ok(after.includes(remoteFingerprint(remotes[8])));
  assert.deepEqual((await readdir(local)).filter(name => name.startsWith('.evicted-')), []);

  // With every authority borrowed, a new remote still takes the ordinary clone path.
  const borrowed = [held];
  for (const name of after.filter(name => name !== remoteFingerprint(remotes[0]))) {
    const remote = remotes.find(candidate => remoteFingerprint(candidate) === name);
    borrowed.push(await borrow(remote));
  }
  assert.ok(borrowed.every(entry => entry.pool));
  const refused = await borrow(remotes[9]);
  assert.equal(refused.pool, null, 'no borrowed pool is removed to make room');
  await refused.release();
  for (const entry of borrowed) await entry.release();
  assert.deepEqual(await pools(), after);
});

test('a failed pool transfer is the checkout result a failed clone would be, and no clone follows it', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-object-pool-failure-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  run('git', ['init', '--quiet', '--template=', '-b', 'main', source]);
  run('git', ['config', 'user.name', 'Fixture'], { cwd: source });
  run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# pool\n');
  run('git', ['add', '.'], { cwd: source }); run('git', ['commit', '-qm', 'baseline'], { cwd: source });
  const authorityCommit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
  const missing = path.join(base, 'authority-does-not-exist.git');
  const calls = [];
  const scratch = await mkdtemp(path.join(base, 'mutation-'));
  const result = await cloneCapabilityConfiguration(scratch, {
    remote: missing, transport: frozenRemoteTransport(missing), authorityCommit, fullHistory: true,
    cacheRoot: source, runRemoteCommand: async (args, options) => { calls.push(args[0]); return runRemoteGitAsync(args, options); }
  });
  if (calls.length === 0 && process.platform === 'win32') { t.skip('Private object-store ACL profile unavailable'); return; }
  assert.notEqual(result.status, 0);
  assert.equal(result.failure.classification, 'remote-not-found');
  assert.deepEqual(calls, ['fetch'], 'the failed pool transfer is reported, never repeated through a clone');
  assert.equal(Object.keys(result).includes('remoteResult'), false);
});
