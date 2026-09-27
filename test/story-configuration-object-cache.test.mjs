import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import YAML from 'yaml';

import {
  CONFIGURATION_BRANCH, loadStoryConfigurationSnapshot, resolveRemoteStoryConfigurationAuthority,
  resolveApprovedStoryWorkType, captureVerifiedConfigurationAssetBytes,
  STORY_CONFIGURATION_OBJECT_CACHE_LIMITS
} from '../src/configuration-branch.mjs';
import { GitRemoteSession } from '../src/git-execution.mjs';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { configurationReadRoot, configurationReadSnapshot } from '../src/configuration-read-scope.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { recordSha256 } from '../src/records.mjs';
import { removeTemporaryTree } from '../src/util.mjs';
import { acquireFileLease } from '../src/file-lease.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t, { attributes = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-object-cache-'));
  t.after(() => removeTemporaryTree(base));
  const source = path.join(base, 'source'); const remote = path.join(base, 'authority.git');
  const cache = path.join(base, 'cache'); await mkdir(source);
  git(source, 'init', '-q', '-b', 'main'); git(source, 'config', 'user.name', 'Snapshot Cache Fixture');
  git(source, 'config', 'user.email', 'snapshot-cache@example.test');
  const phase = (id) => ({ label: id, artifact: { path: `artifacts/${id}/${id}.md`, minimumBytes: 20,
    maximumBytes: 16_384 }, defaultTemplate: 'common/note.md', inputs: [], approval: { mode: 'none' },
    writeScope: 'artifact-only', generation: { requirement: 'optional', defaultProducer: 'human',
      allowedProducers: ['human'], task: 'analyze' } });
  const definition = { version: 2, templatesRoot: 'singularity/templates',
    worldModel: { views: ['architecture', 'development', 'testing', 'security', 'business', 'operations', 'release'] },
    workTypes: { baseline: { label: 'Baseline', phases: ['intake', 'conformance'] } },
    phases: { intake: phase('intake'), conformance: phase('conformance') },
    approvalSecurity: { profile: 'team' }, approvalAuthorities: { reviewers: {
      label: 'Reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } } };
  await mkdir(path.join(source, 'singularity/templates/common'), { recursive: true });
  await mkdir(path.join(source, '.github/agents'), { recursive: true });
  await mkdir(path.join(source, 'singularity/skills/inert-note'), { recursive: true });
  await writeFile(path.join(source, 'singularity/workflow.yml'), YAML.stringify(definition));
  await writeFile(path.join(source, 'singularity/templates/common/note.md'), '# Approved note\r\n');
  await writeFile(path.join(source, 'singularity/skills/inert-note/SKILL.md'),
    '---\nname: inert-note\ndescription: Inert exact source\n---\nRead the retained source.\n');
  await writeFile(path.join(source, 'singularity/skills/inert-note/reference.txt'), 'Exact source bytes\n');
  for (const [agent, id] of [['product-owner', 'intake'], ['qa', 'conformance']]) {
    await writeFile(path.join(source, `.github/agents/${agent}.agent.md`),
      `---\nname: ${agent}\ndescription: Approved role\ntools: []\nmetadata:\n  sflow-phases: ${id}\n  sflow-default-for: ${id}\n---\nRead only approved inputs.\n`);
  }
  if (attributes) await writeFile(path.join(source, '.gitattributes'), attributes);
  await writeFile(path.join(source, 'README.md'), '# Unchanged application\n');
  git(source, 'add', '.'); git(source, 'update-index', '--chmod=+x', 'singularity/skills/inert-note/reference.txt');
  git(source, 'commit', '-qm', 'approved exact snapshot'); git(source, 'branch', CONFIGURATION_BRANCH);
  git(base, 'clone', '-q', '--bare', source, remote); git(source, 'remote', 'add', 'origin', remote);
  // Uncommitted unrelated application work is not eligible for the cache or altered by its reads.
  await writeFile(path.join(source, 'README.md'), '# Dirty application stays here\n');
  const commit = git(source, 'rev-parse', 'HEAD');
  const authority = { remote, branch: CONFIGURATION_BRANCH, commit, source: 'configuration' };
  const env = { ...process.env, SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: cache };
  const before = async () => ({ refs: git(source, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: git(source, 'symbolic-ref', 'HEAD'), status: git(source, 'status', '--porcelain=v1'),
    index: await readFile(path.join(source, '.git/index')), content: await readFile(path.join(source, 'README.md')),
    remoteRefs: git(base, '--git-dir', remote, 'for-each-ref', '--format=%(refname) %(objectname)') });
  return { base, source, remote, cache, commit, authority, env, before, key: recordSha256({
    remote, branch: CONFIGURATION_BRANCH, commit }) };
}
async function read(f, options = {}) {
  const timer = commandTimer('story-cache-fixture', { commandClass: 'read' });
  const snapshot = await withCommandTiming(timer, () => loadStoryConfigurationSnapshot(f.authority, {
    env: f.env, session: new GitRemoteSession({ cwd: f.source, env: f.env }), useObjectCache: true, ...options
  }));
  return { snapshot, counters: timer.finish().counters };
}
async function onlineReaderEnvironment(f, action) {
  const overrides = {
    SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: f.cache,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.base, 'no-active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(f.base, 'no-workspace-registry.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.base, 'no-lead-registry.json')
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try { return await action(); } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}
async function approvedReader(f, options = {}) {
  const timer = commandTimer('approved-reader-cache-fixture', { commandClass: 'read' });
  const value = await withCommandTiming(timer, () => withApprovedConfigurationRead(f.source, async (authority) => ({
    authority,
    sourceCommit: configurationReadSnapshot(f.source)?.sourceCommit,
    workflow: await readFile(path.join(configurationReadRoot(f.source), 'singularity/workflow.yml'), 'utf8'),
    template: await readFile(path.join(configurationReadRoot(f.source), 'singularity/templates/common/note.md'), 'utf8')
  }), { preferAuthority: true, ...options }));
  return { value, counters: timer.finish().counters };
}
const projection = (snapshot) => ({ authority: snapshot.authority, observedCommit: snapshot.observedCommit,
  sourceCommit: snapshot.sourceCommit, definition: JSON.parse(JSON.stringify(snapshot.definition,
    (key, value) => key === 'file' && typeof value === 'string' && path.isAbsolute(value)
      ? value.slice(value.indexOf('/.github/agents/') + 1) : value)), assets: snapshot.assets.map((asset) => ({
    ...asset, contents: asset.contents.toString('base64') })) });
const cacheProfile = { skip: process.platform === 'win32' ? 'Windows cache profile is deliberately deferred; original clone remains supported.' : false };
const cacheKeys = async (cache) => (await readdir(cache)).filter((entry) => /^[a-f0-9]{64}$/u.test(entry));

async function advanceAuthority(f, number) {
  await writeFile(path.join(f.source, 'singularity/templates/common/note.md'), `# Approved note ${number}\n`);
  git(f.source, 'add', 'singularity/templates/common/note.md'); git(f.source, 'commit', '-qm', `approved revision ${number}`);
  git(f.source, 'push', '-q', 'origin', `HEAD:${CONFIGURATION_BRANCH}`);
  f.commit = git(f.source, 'rev-parse', 'HEAD');
  f.authority = { ...f.authority, commit: f.commit };
  f.key = recordSha256({ remote: f.remote, branch: CONFIGURATION_BRANCH, commit: f.commit });
}

async function waitForFixturePath(file) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await lstat(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('fixture did not reach its advertised process checkpoint');
}

test('33 exact revisions retain a bounded LRU cache and the newest revision remains a warm hit', cacheProfile, async (t) => {
  const f = await fixture(t);
  const oldest = f.key; await read(f);
  for (let revision = 1; revision < 33; revision += 1) {
    await advanceAuthority(f, revision);
    const result = await read(f);
    assert.equal(result.snapshot.observedCommit, f.commit);
    assert.equal(result.counters['configuration.object-cache-miss'], 1);
    assert.ok((await cacheKeys(f.cache)).length <= STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.entries);
    if (revision === 32) assert.equal(result.counters['configuration.object-cache-evicted'], 1);
  }
  assert.ok(!(await cacheKeys(f.cache)).includes(oldest));
  const warm = await read(f);
  assert.equal(warm.counters['configuration.object-cache-hit'], 1);
  assert.equal(warm.counters['configuration.object-cache-fetch'] ?? 0, 0);
});

test('warm hit updates LRU modification time while holding the key lease', cacheProfile, async (t) => {
  const f = await fixture(t); await read(f);
  const directory = path.join(f.cache, f.key); const old = new Date(1_000);
  await utimes(directory, old, old);
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-hit'], 1);
  assert.ok((await lstat(directory)).mtimeMs > old.getTime());
});

test('a live entry is never evicted and dead-owner quarantine is retired before older idle entries', cacheProfile, async (t) => {
  const f = await fixture(t); await mkdir(f.cache, { mode: 0o700 });
  const keys = [];
  for (let index = 0; index < 32; index += 1) {
    const key = index.toString(16).padStart(64, '0'); keys.push(key);
    const directory = path.join(f.cache, key); await mkdir(directory, { mode: 0o700 });
    await utimes(directory, new Date(1_000 + index), new Date(1_000 + index));
  }
  const live = await acquireFileLease(path.join(f.cache, `${keys[0]}.incomplete`));
  assert.ok(live); t.after(() => live.release({ cleanupConfirmed: true }));
  const deceased = path.join(f.cache, `${keys.at(-1)}.incomplete`);
  const module = new URL('../src/file-lease.mjs', import.meta.url).href;
  const fixtureOwner = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { acquireFileLease } from ${JSON.stringify(module)}; const lease = await acquireFileLease(${JSON.stringify(deceased)}); await lease.retainQuarantine({ childPids: [], unknownChildren: false });`],
  { encoding: 'utf8', timeout: 10_000 });
  assert.equal(fixtureOwner.status, 0, fixtureOwner.stderr);
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-evicted'], 1);
  assert.equal(result.snapshot.observedCommit, f.commit);
  const remaining = await cacheKeys(f.cache);
  assert.ok(remaining.includes(keys[0]), 'the live lease and its store remain untouched');
  assert.ok(remaining.includes(keys[1]), 'an older idle store loses to a provably dead quarantine');
  assert.ok(!remaining.includes(keys.at(-1)));
  assert.ok(await lstat(path.join(f.cache, `${keys[0]}.incomplete`)));
});

test('all live entries decline admission without deleting or waiting for their key leases', cacheProfile, async (t) => {
  const f = await fixture(t); await mkdir(f.cache, { mode: 0o700 });
  const leases = [];
  t.after(() => Promise.all(leases.map((lease) => lease.release({ cleanupConfirmed: true }))));
  for (let index = 0; index < 32; index += 1) {
    const key = index.toString(16).padStart(64, '0'); const directory = path.join(f.cache, key);
    await mkdir(directory, { mode: 0o700 });
    leases.push(await acquireFileLease(`${directory}.incomplete`));
  }
  assert.ok(leases.every(Boolean));
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-fetch'] ?? 0, 0);
  assert.equal(result.counters['configuration.object-cache-evicted'] ?? 0, 0);
  assert.equal(result.snapshot.observedCommit, f.commit);
  assert.equal((await cacheKeys(f.cache)).length, 32);
});

test('an oversized idle derived entry is evicted before admitting the next exact snapshot', cacheProfile, async (t) => {
  const f = await fixture(t); const key = '0'.repeat(64); const directory = path.join(f.cache, key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(path.join(directory, 'oversized-derived-object'), 'wx');
  await file.truncate(STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.storageBytes + 1); await file.close();
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-evicted'], 1);
  assert.equal(result.counters['configuration.object-cache-miss'], 1);
  assert.equal(result.snapshot.observedCommit, f.commit);
  assert.deepEqual(await cacheKeys(f.cache), [f.key]);
});

test('the aggregate 16,384-file ceiling evicts an idle entry instead of disabling future cache admission', cacheProfile, async (t) => {
  const f = await fixture(t); const key = '0'.repeat(64); const directory = path.join(f.cache, key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let offset = 0; offset < STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.storageFiles; offset += 128) {
    await Promise.all(Array.from({ length: 128 }, (_, index) =>
      writeFile(path.join(directory, `derived-${offset + index}`), '')));
  }
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-evicted'], 1);
  assert.equal(result.counters['configuration.object-cache-miss'], 1);
  assert.equal(result.snapshot.observedCommit, f.commit);
  assert.deepEqual(await cacheKeys(f.cache), [f.key]);
});

test('a live allocation lease waits only the bounded admission interval before independent fallback', cacheProfile, async (t) => {
  const f = await fixture(t); await mkdir(f.cache, { mode: 0o700 });
  const lease = await acquireFileLease(path.join(f.cache, '.allocation.lock'));
  assert.ok(lease); t.after(() => lease.release({ cleanupConfirmed: true }));
  const started = performance.now(); const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-allocation-timeout'], 1);
  assert.equal(result.counters['configuration.object-cache-fetch'] ?? 0, 0);
  assert.ok(performance.now() - started < 1_200, 'no former five-second allocation wait');
  assert.equal(result.snapshot.observedCommit, f.commit);
  assert.ok(await lease.owns());
});

test('a real SIGKILL allocation owner is reclaimed without the former five-second penalty', cacheProfile, async (t) => {
  const f = await fixture(t); await mkdir(f.cache, { mode: 0o700 });
  const lock = path.join(f.cache, '.allocation.lock'); const checkpoint = path.join(f.base, 'allocation-held');
  const module = new URL('../src/file-lease.mjs', import.meta.url).href;
  const owner = spawn(process.execPath, ['--input-type=module', '-e',
    `import { writeFile } from 'node:fs/promises'; import { acquireFileLease } from ${JSON.stringify(module)}; await acquireFileLease(${JSON.stringify(lock)}); await writeFile(${JSON.stringify(checkpoint)}, 'ready'); setInterval(() => {}, 1000);`],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { if (owner.exitCode == null && owner.signalCode == null) owner.kill('SIGKILL'); });
  await waitForFixturePath(checkpoint); const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
  const started = performance.now(); const result = await read(f);
  assert.equal(result.snapshot.observedCommit, f.commit);
  assert.equal(result.counters['configuration.object-cache-miss'], 1);
  assert.ok(performance.now() - started < 1_000, 'crash recovery retains no five-second cache timeout');
  await assert.rejects(lstat(lock), { code: 'ENOENT' });
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`a configuration reader killed mid-fetch with ${signal} leaves no allocator and its next read uses a safe independent store`, cacheProfile, async (t) => {
    const f = await fixture(t); const bin = path.join(f.base, `crash-${signal}-bin`); await mkdir(bin);
    const checkpoint = path.join(f.base, `fetch-${signal}-started`);
    const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const wrapper = path.join(bin, 'git');
    await writeFile(wrapper, `#!${process.execPath}\nconst { spawnSync } = require('node:child_process'); const { writeFileSync, readFileSync } = require('node:fs'); const a = process.argv.slice(2); if (a.includes('fetch')) { writeFileSync(${JSON.stringify(checkpoint)}, JSON.stringify({ pid: process.pid })); setTimeout(() => { process.exitCode = 1; }, 500); } else { const r = spawnSync(${JSON.stringify(actualGit)}, a, { env: process.env, encoding: null, ...(a.includes('cat-file') ? { input: readFileSync(0) } : {}) }); if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); process.exitCode = r.status ?? 1; }\n`);
    await chmod(wrapper, 0o755);
    const configuration = new URL('../src/configuration-branch.mjs', import.meta.url).href;
    const leases = new URL('../src/file-lease.mjs', import.meta.url).href;
    const owner = spawn(process.execPath, ['--input-type=module', '-e',
      `import { installFileLeaseSignalHandlers } from ${JSON.stringify(leases)}; import { loadStoryConfigurationSnapshot } from ${JSON.stringify(configuration)}; installFileLeaseSignalHandlers(); await loadStoryConfigurationSnapshot(${JSON.stringify(f.authority)}, { env: process.env, useObjectCache: true });`],
    { env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(() => { if (owner.exitCode == null && owner.signalCode == null) owner.kill('SIGKILL'); });
    await waitForFixturePath(checkpoint);
    const helper = JSON.parse(await readFile(checkpoint, 'utf8')).pid;
    t.after(async () => {
      // The fixture helper has no descendants and does no store writes. Confirm it has ended
      // before removing the deliberately quarantined cache tree at fixture teardown.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try { process.kill(helper, 0); }
        catch (error) { if (error.code === 'ESRCH') return; throw error; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('fixture helper completion was not confirmed');
    });
    const exited = once(owner, 'exit'); owner.kill(signal); await exited;
    await assert.rejects(lstat(path.join(f.cache, '.allocation.lock')), { code: 'ENOENT' });
    const marker = path.join(f.cache, `${f.key}.incomplete`); const retained = await readFile(marker);
    const started = performance.now(); const result = await read(f);
    assert.equal(result.snapshot.observedCommit, f.commit);
    assert.equal(result.counters['configuration.object-cache-hit'] ?? 0, 0);
    assert.equal(result.counters['configuration.object-cache-fetch'] ?? 0, 0);
    assert.ok(performance.now() - started < 1_000, 'no abandoned global cache wait');
    assert.deepEqual(await readFile(marker), retained, 'unknown child ownership is fenced, not guessed from age');
  });
}

test('a slow fetch holds only its entry lease and another key can fill independently', cacheProfile, async (t) => {
  const f = await fixture(t); const other = await fixture(t); other.cache = f.cache;
  other.env = { ...other.env, SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: f.cache };
  const bin = path.join(f.base, 'slow-fetch-bin'); await mkdir(bin);
  const checkpoint = path.join(f.base, 'fetch-started');
  const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}\nconst { spawnSync } = require('node:child_process'); const { writeFileSync, readFileSync } = require('node:fs'); const a = process.argv.slice(2); const exec = () => { const r = spawnSync(${JSON.stringify(actualGit)}, a, { env: process.env, encoding: null, ...(a.includes('cat-file') ? { input: readFileSync(0) } : {}) }); if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); process.exitCode = r.status ?? 1; }; if (a.includes('fetch')) { writeFileSync(${JSON.stringify(checkpoint)}, 'ready'); setTimeout(exec, 2_000); } else exec();\n`);
  await chmod(wrapper, 0o755);
  let firstFinished = false;
  const first = read(f, { env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } })
    .finally(() => { firstFinished = true; });
  await waitForFixturePath(checkpoint);
  await assert.rejects(lstat(path.join(f.cache, '.allocation.lock')), { code: 'ENOENT' });
  const second = await read(other);
  assert.equal(second.counters['configuration.object-cache-miss'], 1);
  assert.equal(second.snapshot.observedCommit, other.commit);
  assert.equal(firstFinished, false, 'the other entry did not wait for the slow transfer');
  assert.equal((await first).snapshot.observedCommit, f.commit);
});

test('CLI opt-in exact-object cache removes repeat remote transfer, retaining all ordinary/SKP bytes and modes', cacheProfile, async (t) => {
  const f = await fixture(t); const before = await f.before();
  const original = await loadStoryConfigurationSnapshot(f.authority, { env: f.env, captureAuthoringBytes: true });
  const cold = await read(f, { captureAuthoringBytes: true }); const warm = await read(f, { captureAuthoringBytes: true });
  assert.equal(cold.counters['configuration.object-cache-fetch'], 1);
  assert.equal(cold.counters['configuration.object-cache-miss'], 1, JSON.stringify(cold.counters));
  assert.equal(warm.counters['configuration.object-cache-fetch'] ?? 0, 0);
  assert.equal(warm.counters['configuration.object-cache-hit'], 1);
  assert.equal(warm.counters['git.remote.command.ls-remote'], 1, 'warm object admission still observes exact current authority');
  assert.deepEqual(projection(cold.snapshot), projection(original));
  assert.deepEqual(projection(warm.snapshot), projection(original));
  assert.equal(warm.snapshot.assets.find((asset) => asset.relative.endsWith('/reference.txt')).gitMode, '100755');
  assert.equal(resolveApprovedStoryWorkType(warm.snapshot, 'baseline').id, 'baseline');
  assert.deepEqual(captureVerifiedConfigurationAssetBytes(warm.snapshot, {
    selectPaths: ['singularity/workflow.yml', 'singularity/templates/common/note.md']
  }), captureVerifiedConfigurationAssetBytes(original, {
    selectPaths: ['singularity/workflow.yml', 'singularity/templates/common/note.md'] }));
  assert.equal(git(f.base, '--git-dir', path.join(f.cache, f.key), 'remote'), '', 'local reads have no named/lazy transport');
  assert.deepEqual(await f.before(), before, 'read leaves dirty application, index, branch, refs and provider refs unchanged');
});

test('default/gateway-style snapshots never create or consume the CLI cache', async (t) => {
  const f = await fixture(t); const ordinary = await read(f, { useObjectCache: false });
  assert.equal(ordinary.counters['configuration.object-cache-fetch'] ?? 0, 0);
  await assert.rejects(readdir(f.cache), { code: 'ENOENT' });
  assert.equal(ordinary.snapshot.observedCommit, f.commit);
});

test('approved online reader requires explicit cache opt-in, reuses warm transfer and leaves gateway defaults off', cacheProfile, async (t) => {
  const f = await fixture(t); const before = await f.before();
  await onlineReaderEnvironment(f, async () => {
    const ordinary = await approvedReader(f);
    assert.equal(ordinary.counters['configuration.object-cache-fetch'] ?? 0, 0);
    assert.equal(ordinary.counters['git.remote.command.clone'], 1);
    await assert.rejects(readdir(f.cache), { code: 'ENOENT' });
    const cold = await approvedReader(f, { useObjectCache: true });
    const warm = await approvedReader(f, { useObjectCache: true });
    assert.equal(cold.counters['configuration.object-cache-fetch'], 1);
    assert.equal(warm.counters['configuration.object-cache-hit'], 1);
    assert.equal(warm.counters['configuration.object-cache-fetch'] ?? 0, 0);
    assert.equal(warm.counters['git.remote.command.clone'], 1,
      'generic clone counter still includes the local exact-object projection; transfer reuse is not a no-clone claim');
    assert.equal(warm.counters['git.remote.command.ls-remote'], 2,
      'canonical selection and cache admission retain their fresh exact observations');
    assert.equal(warm.value.sourceCommit, f.commit);
    assert.deepEqual(cold.value, ordinary.value);
    assert.deepEqual(warm.value, ordinary.value);
    const gateway = await approvedReader(f);
    assert.equal(gateway.counters['configuration.object-cache-hit'] ?? 0, 0);
    assert.equal(gateway.counters['configuration.object-cache-fetch'] ?? 0, 0);
    assert.equal(gateway.counters['git.remote.command.clone'], 1,
      'existing cache does not opt an ordinary reader into derived storage');
    assert.deepEqual(gateway.value, ordinary.value);
  });
  assert.deepEqual(await f.before(), before);
});

test('fresh owner capture forwards only explicit online cache opt-in', cacheProfile, async (t) => {
  const f = await fixture(t);
  await onlineReaderEnvironment(f, async () => {
    const defaultFresh = await approvedReader(f, { freshOwnerCapture: true });
    assert.equal(defaultFresh.counters['configuration.object-cache-fetch'] ?? 0, 0);
    await assert.rejects(readdir(f.cache), { code: 'ENOENT' });
    const cold = await approvedReader(f, { freshOwnerCapture: true, useObjectCache: true });
    const warm = await approvedReader(f, { freshOwnerCapture: true, useObjectCache: true });
    assert.equal(cold.counters['configuration.object-cache-fetch'], 1);
    assert.equal(warm.counters['configuration.object-cache-hit'], 1);
    assert.equal(warm.counters['configuration.object-cache-fetch'] ?? 0, 0);
    assert.deepEqual(warm.value, defaultFresh.value);
  });
});

test('warm cache refuses changed authority even when the same invocation session memoized the old ref', cacheProfile, async (t) => {
  const f = await fixture(t); await read(f);
  const session = new GitRemoteSession({ cwd: f.source, env: f.env });
  await resolveRemoteStoryConfigurationAuthority(f.remote, { session });
  await writeFile(path.join(f.source, 'singularity/workflow.yml'),
    `${await readFile(path.join(f.source, 'singularity/workflow.yml'), 'utf8')}\n# New approved revision\n`);
  git(f.source, 'add', 'singularity/workflow.yml'); git(f.source, 'commit', '-qm', 'advance authority');
  git(f.source, 'push', '-q', 'origin', `HEAD:${CONFIGURATION_BRANCH}`);
  const updated = git(f.source, 'rev-parse', 'HEAD');
  await assert.rejects(read(f, { session }), (error) => error.code === 'STORY_CONFIGURATION_AUTHORITY_STALE'
    && error.details.actualCommit === updated);
  f.authority = await resolveRemoteStoryConfigurationAuthority(f.remote);
  const fresh = await read(f); assert.equal(fresh.snapshot.observedCommit, updated);
});

test('unreachable authority and removed authority never become a warm cache success', cacheProfile, async (t) => {
  const f = await fixture(t); await read(f);
  git(f.base, '--git-dir', f.remote, 'update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`);
  await assert.rejects(read(f), (error) => error.code === 'STORY_CONFIGURATION_AUTHORITY_STALE' && error.details.actualCommit == null);
  await rename(f.remote, `${f.remote}.unavailable`);
  await assert.rejects(read(f), (error) => error.code !== 'STORY_CONFIGURATION_AUTHORITY_STALE');
});

test('committed EOL/encoding attributes decline caching and preserve the original checkout-byte projection', cacheProfile, async (t) => {
  const f = await fixture(t, { attributes: '*.md text eol=crlf\n' });
  const original = await loadStoryConfigurationSnapshot(f.authority, { env: f.env });
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(result.counters['configuration.object-cache-declined'], 1);
  assert.deepEqual(projection(result.snapshot), projection(original));
  assert.equal(result.snapshot.assets.find((asset) => asset.relative.endsWith('/note.md')).contents.toString(), '# Approved note\r\n');
  assert.deepEqual(await readdir(f.cache), [], 'unsupported cold object profile is not retained');
});

test('concurrent independent sessions share one exact transfer under the inode-bound lease', cacheProfile, async (t) => {
  const f = await fixture(t); const results = await Promise.all([read(f), read(f)]);
  assert.equal(results.reduce((total, result) => total + (result.counters['configuration.object-cache-fetch'] ?? 0), 0), 1);
  assert.deepEqual(projection(results[0].snapshot), projection(results[1].snapshot));
  assert.deepEqual((await readdir(f.cache)).sort(), [f.key]);
});

test('quarantined or corrupted cached objects cannot approve altered bytes or trigger hidden lazy fetching', cacheProfile, async (t) => {
  const f = await fixture(t); await read(f); const directory = path.join(f.cache, f.key);
  const marker = `${directory}.incomplete`; await writeFile(marker, 'opaque crash-left nonce\n');
  const quarantined = await read(f);
  assert.equal(quarantined.counters['configuration.object-cache-quarantined'], 1);
  assert.equal(quarantined.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(await readFile(marker, 'utf8'), 'opaque crash-left nonce\n');
  await rm(marker);
  // A forged same-key HEAD and caller-authored cache metadata are not authority.
  await writeFile(path.join(directory, 'HEAD'), `${'a'.repeat(40)}\n`);
  const changed = await read(f);
  assert.equal(changed.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(changed.snapshot.observedCommit, f.commit);
  await writeFile(path.join(directory, 'objects/info/alternates'), `${f.source}/.git/objects\n`);
  const alternate = await read(f);
  assert.equal(alternate.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(alternate.snapshot.observedCommit, f.commit);
});

test('missing local objects do not lazily refetch from cache metadata; original exact live read remains available', cacheProfile, async (t) => {
  const f = await fixture(t); await read(f); const directory = path.join(f.cache, f.key);
  const objects = path.join(directory, 'objects');
  for (const entry of await readdir(objects)) {
    if (/^[a-f0-9]{2}$/u.test(entry) || entry === 'pack') await removeTemporaryTree(path.join(objects, entry));
  }
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(result.counters['configuration.object-cache-fetch'] ?? 0, 0,
    'cache failure cannot become an implicit transport request from its local metadata');
  assert.equal(result.counters['git.remote.command.fetch'] ?? 0, 0);
  assert.equal(result.counters['git.remote.command.clone'], 1, 'fallback is only the original admitted remote snapshot owner');
  assert.equal(result.snapshot.observedCommit, f.commit);
});

test('cached local transform or include configuration cannot widen the closed metadata profile', cacheProfile, async (t) => {
  const f = await fixture(t); await read(f); const directory = path.join(f.cache, f.key);
  git(directory, 'config', 'filter.unreviewed.smudge', 'never-executed-test-command');
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(result.counters['configuration.object-cache-profile-config'], 1);
  assert.equal(result.snapshot.observedCommit, f.commit);
  git(directory, 'config', '--unset', 'filter.unreviewed.smudge');
  git(directory, 'config', 'core.bare', 'false');
  const nonBare = await read(f);
  assert.equal(nonBare.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(nonBare.counters['configuration.object-cache-profile-config'], 1);
});

test('existing non-private cache permissions are declined without chmod or retained data mutation', cacheProfile, async (t) => {
  const f = await fixture(t); await mkdir(f.cache, { mode: 0o755 }); await chmod(f.cache, 0o755);
  const result = await read(f); assert.equal(result.counters['configuration.object-cache-fetch'] ?? 0, 0);
  assert.equal(result.snapshot.observedCommit, f.commit); assert.deepEqual(await readdir(f.cache), []);
});

test('misconfigured broad cache directories are not treated as derived stores', cacheProfile, async (t) => {
  const f = await fixture(t); const before = await f.before();
  const result = await read(f, { env: { ...f.env, SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: f.source } });
  assert.equal(result.counters['configuration.object-cache-fetch'] ?? 0, 0);
  assert.equal(result.snapshot.observedCommit, f.commit);
  assert.deepEqual(await f.before(), before);
  assert.ok(!(await readdir(f.source)).includes('.allocation.lock'));
});

test('symlink cache roots and exact-entry symlinks are declined without following or overwriting them', cacheProfile, async (t) => {
  const f = await fixture(t); const other = path.join(f.base, 'other'); await mkdir(other);
  await symlink(other, f.cache, 'dir'); const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-hit'] ?? 0, 0); assert.deepEqual(await readdir(other), []);
  await rm(f.cache); await mkdir(f.cache, { mode: 0o700 }); await symlink(other, path.join(f.cache, f.key), 'dir');
  await read(f); assert.deepEqual(await readdir(other), []);
});

test('logical object/file budgets decline this additive cache profile without weakening the original read', cacheProfile, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'large-unselected.txt'), Buffer.alloc(STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.objectBytes + 1, 0x61));
  git(f.source, 'add', 'large-unselected.txt'); git(f.source, 'commit', '-qm', 'unselected large branch object');
  git(f.source, 'push', '-q', 'origin', `HEAD:${CONFIGURATION_BRANCH}`);
  f.authority = await resolveRemoteStoryConfigurationAuthority(f.remote);
  const result = await read(f);
  assert.equal(result.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(result.counters['configuration.object-cache-declined'], 1);
  assert.equal(result.snapshot.observedCommit, f.authority.commit);
  assert.deepEqual(await readdir(f.cache), []);
});

test('entry ceiling evicts an idle derived entry, while an oversized selected entry declines without partial configuration', cacheProfile, async (t) => {
  const f = await fixture(t); await mkdir(f.cache, { mode: 0o700 });
  for (let index = 0; index < STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.entries; index += 1) {
    await mkdir(path.join(f.cache, index.toString(16).padStart(64, '0')), { mode: 0o700 });
  }
  const full = await read(f);
  assert.equal(full.counters['configuration.object-cache-fetch'], 1);
  assert.equal(full.counters['configuration.object-cache-evicted'], 1);
  assert.equal(full.snapshot.observedCommit, f.commit);
  assert.equal((await readdir(f.cache)).filter((entry) => /^[a-f0-9]{64}$/u.test(entry)).length,
    STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.entries);
  await removeTemporaryTree(f.cache); await mkdir(path.join(f.cache, f.key), { recursive: true, mode: 0o700 });
  const oversized = await open(path.join(f.cache, f.key, 'oversized-derived-object'), 'wx');
  await oversized.truncate(STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.storageBytes + 1); await oversized.close();
  const capped = await read(f);
  assert.equal(capped.counters['configuration.object-cache-fetch'] ?? 0, 0);
  assert.equal(capped.snapshot.observedCommit, f.commit);
});

test('mutable caller authority selectors are captured before cache observation awaits', cacheProfile, async (t) => {
  const f = await fixture(t); let release; const gate = new Promise((resolve) => { release = resolve; });
  const actual = new GitRemoteSession({ cwd: f.source, env: f.env });
  const session = { observeAsync: async (...args) => { await gate; return actual.observeAsync(...args); } };
  const authority = { ...f.authority }; const pending = loadStoryConfigurationSnapshot(authority, { env: f.env, session, useObjectCache: true });
  authority.remote = path.join(f.base, 'wrong-destination.git'); authority.commit = 'b'.repeat(40); release();
  const snapshot = await pending; assert.equal(snapshot.authority.remote, f.remote); assert.equal(snapshot.observedCommit, f.commit);
});

test('blocked native completion retains quarantine, declines cache and lets the independent transport report its refusal', cacheProfile, async (t) => {
  const f = await fixture(t);
  const session = new GitRemoteSession({ cwd: f.source, env: f.env, runAsyncCommand: async () => ({
    status: 0, stdout: `${f.commit}\trefs/heads/${CONFIGURATION_BRANCH}\n`, stderr: '', signal: null
  }) });
  await assert.rejects(read(f, { session, env: { ...f.env, SINGULARITY_FLOW_NO_NETWORK: '1' } }),
    (error) => error.code !== 'STORY_CONFIGURATION_CACHE_OPERATION_UNCONFIRMED');
  const entries = await readdir(f.cache); assert.ok(entries.includes(`${f.key}.incomplete`));
  const marker = await readFile(path.join(f.cache, `${f.key}.incomplete`), 'utf8');
  const original = await read(f); assert.equal(original.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(original.snapshot.observedCommit, f.commit);
  assert.equal(await readFile(path.join(f.cache, `${f.key}.incomplete`), 'utf8'), marker);
});

for (const kind of ['structured-refusal', 'ordinary-error', 'type-error']) {
  test(`a throwing cache transfer preserves its ${kind} without an accidental second transport attempt`, cacheProfile, async (t) => {
    const f = await fixture(t); const calls = path.join(f.base, `calls-${kind}.txt`);
    const execution = new URL('../src/git-execution.mjs', import.meta.url).href;
    const configuration = new URL('../src/configuration-branch.mjs', import.meta.url).href;
    const loader = path.join(f.base, `throwing-transfer-${kind}-loader.mjs`);
    // Test-local ESM wrapping keeps the production reader API unchanged. Fresh ls-remote uses
    // the real transport; only the already-dispatched cache transfer rejects. All other native
    // Git operations remain the original implementation.
    const wrapper = `\nimport { appendFileSync as fixtureAppend } from 'node:fs';\nexport async function runRemoteGitAsync(args, options) {\n  if (args.includes('fetch')) {\n    fixtureAppend(${JSON.stringify(calls)}, 'fetch\\n');\n    const error = ${kind === 'structured-refusal'
      ? "new SingularityFlowError('fixture transport refusal', { code: 'REMOTE_AUTH_REQUIRED' })"
      : kind === 'type-error' ? "new TypeError('fixture transfer launcher rejected')" : "new Error('fixture transfer connection lost')"};\n    ${kind === 'ordinary-error' ? "error.code = 'ECONNRESET';" : ''}\n    throw error;\n  }\n  if (args.includes('clone')) fixtureAppend(${JSON.stringify(calls)}, 'clone\\n');\n  return runFixtureOriginalRemoteGitAsync(args, options);\n}\n`;
    await writeFile(loader, `export async function load(url, context, nextLoad) { const result = await nextLoad(url, context); if (url !== ${JSON.stringify(execution)}) return result; const source = String(result.source); const signature = 'export async function runRemoteGitAsync(args, {'; if (!source.includes(signature)) throw new Error('fixture transfer signature changed'); return { ...result, source: source.replace(signature, 'async function runFixtureOriginalRemoteGitAsync(args, {') + ${JSON.stringify(wrapper)} }; }\n`);
    const child = spawnSync(process.execPath, ['--experimental-loader', loader, '--input-type=module', '-e',
      `import { loadStoryConfigurationSnapshot } from ${JSON.stringify(configuration)}; let error = null; try { await loadStoryConfigurationSnapshot(${JSON.stringify(f.authority)}, { env: process.env, useObjectCache: true }); } catch (value) { error = { name: value.name, message: value.message, code: value.code ?? null }; } process.stdout.write(JSON.stringify({ error }));`],
    { cwd: f.source, env: { ...f.env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, child.stderr);
    const expected = kind === 'structured-refusal'
      ? { name: 'SingularityFlowError', message: 'fixture transport refusal', code: 'REMOTE_AUTH_REQUIRED' }
      : kind === 'type-error'
        ? { name: 'TypeError', message: 'fixture transfer launcher rejected', code: null }
        : { name: 'Error', message: 'fixture transfer connection lost', code: 'ECONNRESET' };
    assert.deepEqual(JSON.parse(child.stdout).error, expected);
    assert.equal(await readFile(calls, 'utf8'), 'fetch\n', 'no ordinary-clone retry after the transfer exception');
    const marker = path.join(f.cache, `${f.key}.incomplete`); const retained = await readFile(marker);
    assert.ok((await cacheKeys(f.cache)).includes(f.key));
    const original = await read(f);
    assert.equal(original.snapshot.observedCommit, f.commit);
    assert.equal(original.counters['configuration.object-cache-hit'] ?? 0, 0);
    assert.deepEqual(await readFile(marker), retained, 'the unknown-child store remains fenced');
  });
}

test('actual native cache-only output overflow preserves the quarantined store and uses the original reader', cacheProfile, async (t) => {
  const f = await fixture(t); const bin = path.join(f.base, 'probe-bin'); await mkdir(bin);
  const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(); assert.ok(path.isAbsolute(actualGit));
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst {readFileSync}=require('node:fs');\nconst a=process.argv.slice(2);\nif(a.includes('fsck')){process.stdout.write('X'.repeat(128*1024));}else{const r=spawnSync(${JSON.stringify(actualGit)},a,{env:process.env,encoding:null,...(a.includes('cat-file')?{input:readFileSync(0)}:{})});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.status??1;}\n`);
  await chmod(wrapper, 0o755);
  const result = await read(f, { env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(result.snapshot.observedCommit, f.commit);
  assert.equal(result.counters['configuration.object-cache-hit'] ?? 0, 0);
  const entries = await readdir(f.cache);
  assert.ok(entries.includes(f.key)); assert.ok(entries.includes(`${f.key}.incomplete`));
  assert.ok(!entries.includes('.allocation.lock'));
  const marker = await readFile(path.join(f.cache, `${f.key}.incomplete`), 'utf8');
  const fresh = await read(f); assert.equal(fresh.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(fresh.snapshot.observedCommit, f.commit);
  assert.equal(await readFile(path.join(f.cache, `${f.key}.incomplete`), 'utf8'), marker);
});

test('actual async cache fetch overflow preserves quarantine and falls back through an independent original store', cacheProfile, async (t) => {
  const f = await fixture(t); const bin = path.join(f.base, 'fetch-probe-bin'); await mkdir(bin);
  const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(); assert.ok(path.isAbsolute(actualGit));
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst {readFileSync}=require('node:fs');\nconst a=process.argv.slice(2);\nif(a.includes('fetch')){process.stdout.write('X'.repeat(128*1024));setInterval(()=>{},1000);}else{const r=spawnSync(${JSON.stringify(actualGit)},a,{env:process.env,encoding:null,...(a.includes('cat-file')?{input:readFileSync(0)}:{})});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.status??1;}\n`);
  await chmod(wrapper, 0o755);
  const before = await f.before();
  const result = await read(f, { env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(result.snapshot.observedCommit, f.commit);
  assert.equal(result.counters['configuration.object-cache-hit'] ?? 0, 0);
  const entries = await readdir(f.cache); assert.ok(entries.includes(f.key));
  assert.ok(entries.includes(`${f.key}.incomplete`)); assert.ok(!entries.includes('.allocation.lock'));
  assert.deepEqual(await f.before(), before);
});

test('opaque snapshot-tree signal refusal conservatively retains quarantine and its original validation diagnostic', cacheProfile, async (t) => {
  const f = await fixture(t); const bin = path.join(f.base, 'snapshot-probe-bin'); await mkdir(bin);
  const fixtureTemporaryRoot = path.join(f.base, 'private-projections'); await mkdir(fixtureTemporaryRoot);
  const priorTemporaryRoot = process.env.TMPDIR;
  process.env.TMPDIR = fixtureTemporaryRoot;
  t.after(() => { if (priorTemporaryRoot == null) delete process.env.TMPDIR; else process.env.TMPDIR = priorTemporaryRoot; });
  const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(); assert.ok(path.isAbsolute(actualGit));
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst {readFileSync}=require('node:fs');\nconst a=process.argv.slice(2);\nif(a.includes('ls-tree')&&a.some(x=>x.startsWith('--format='))&&!a.includes('--full-tree')){process.kill(process.pid,'SIGTERM');}else{const r=spawnSync(${JSON.stringify(actualGit)},a,{env:process.env,encoding:null,...(a.includes('cat-file')?{input:readFileSync(0)}:{})});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.status??1;}\n`);
  await chmod(wrapper, 0o755);
  await assert.rejects(read(f, { env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }),
    (error) => /no canonical Git blob identity/u.test(error.message));
  assert.ok((await readdir(f.cache)).includes(`${f.key}.incomplete`));
  assert.equal((await readdir(fixtureTemporaryRoot)).filter((entry) => entry.startsWith('sflow-story-config-cache-read-')).length, 1,
    'opaque validator outcomes cannot authorize removal of their native checkout');
});
