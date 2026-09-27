import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('entry and aggregate storage ceilings are refusal-to-cache bounds, not partial configuration results', cacheProfile, async (t) => {
  const f = await fixture(t); await mkdir(f.cache, { mode: 0o700 });
  for (let index = 0; index < STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.entries; index += 1) {
    await mkdir(path.join(f.cache, index.toString(16).padStart(64, '0')));
  }
  const full = await read(f);
  assert.equal(full.counters['configuration.object-cache-fetch'] ?? 0, 0);
  assert.equal(full.snapshot.observedCommit, f.commit);
  assert.equal((await readdir(f.cache)).length, STORY_CONFIGURATION_OBJECT_CACHE_LIMITS.entries);
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

test('blocked native completion retains pre-dispatch quarantine and cannot admit a cache hit', cacheProfile, async (t) => {
  const f = await fixture(t);
  const session = new GitRemoteSession({ cwd: f.source, env: f.env, runAsyncCommand: async () => ({
    status: 0, stdout: `${f.commit}\trefs/heads/${CONFIGURATION_BRANCH}\n`, stderr: '', signal: null
  }) });
  await assert.rejects(read(f, { session, env: { ...f.env, SINGULARITY_FLOW_NO_NETWORK: '1' } }),
    (error) => error.code === 'STORY_CONFIGURATION_CACHE_OPERATION_UNCONFIRMED');
  const entries = await readdir(f.cache); assert.ok(entries.includes(`${f.key}.incomplete`));
  const marker = await readFile(path.join(f.cache, `${f.key}.incomplete`), 'utf8');
  const original = await read(f); assert.equal(original.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(original.snapshot.observedCommit, f.commit);
  assert.equal(await readFile(path.join(f.cache, `${f.key}.incomplete`), 'utf8'), marker);
});

test('actual native output-overflow preserves the quarantined store instead of treating status as completed', cacheProfile, async (t) => {
  const f = await fixture(t); const bin = path.join(f.base, 'probe-bin'); await mkdir(bin);
  const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(); assert.ok(path.isAbsolute(actualGit));
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst a=process.argv.slice(2);\nif(a.includes('fsck')){process.stdout.write('X'.repeat(128*1024));}else{const r=spawnSync(${JSON.stringify(actualGit)},a,{env:process.env,encoding:null});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.status??1;}\n`);
  await chmod(wrapper, 0o755);
  await assert.rejects(read(f, { env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }),
    (error) => error.code === 'STORY_CONFIGURATION_CACHE_OPERATION_UNCONFIRMED');
  const entries = await readdir(f.cache);
  assert.ok(entries.includes(f.key)); assert.ok(entries.includes(`${f.key}.incomplete`));
  assert.ok(!entries.includes('.allocation.lock'));
  const marker = await readFile(path.join(f.cache, `${f.key}.incomplete`), 'utf8');
  const fresh = await read(f); assert.equal(fresh.counters['configuration.object-cache-hit'] ?? 0, 0);
  assert.equal(fresh.snapshot.observedCommit, f.commit);
  assert.equal(await readFile(path.join(f.cache, `${f.key}.incomplete`), 'utf8'), marker);
});

test('actual async fetch overflow preserves pre-dispatch quarantine and never silently falls back after unknown cleanup', cacheProfile, async (t) => {
  const f = await fixture(t); const bin = path.join(f.base, 'fetch-probe-bin'); await mkdir(bin);
  const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(); assert.ok(path.isAbsolute(actualGit));
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst a=process.argv.slice(2);\nif(a.includes('fetch')){process.stdout.write('X'.repeat(128*1024));setInterval(()=>{},1000);}else{const r=spawnSync(${JSON.stringify(actualGit)},a,{env:process.env,encoding:null});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.status??1;}\n`);
  await chmod(wrapper, 0o755);
  const before = await f.before();
  await assert.rejects(read(f, { env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }),
    (error) => error.code === 'STORY_CONFIGURATION_CACHE_OPERATION_UNCONFIRMED');
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
