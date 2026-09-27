import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitRemoteSession, runRemoteGitAsync } from '../src/git-execution.mjs';
import { enterpriseGitEnvironment } from '../src/git-enterprise-environment.mjs';
import { inspectCapabilityRepository, readOrganisation } from '../src/organisation.mjs';
import { inspectRepositoryOnboarding } from '../src/repository-onboarding.mjs';
import {
  CONFIGURATION_BRANCH, STATE_CONFIGURATION_FORMAT, STATE_CONFIGURATION_MANIFEST,
  configurationAssetPaths, ensureConfigurationBranch
} from '../src/configuration-branch.mjs';
import { run } from '../src/util.mjs';

const oid = '1'.repeat(40);
const remote = 'https://example.test/team/repository.git';
const complete = (stdout = '') => ({ status: 0, stdout, stderr: '', timedOut: false });

test('literal branch-prefix observations cover descendants and absence, not adjacent namespaces or arbitrary globs', async () => {
  const calls = [];
  const session = new GitRemoteSession({ async runAsyncCommand(args) {
    calls.push(args);
    return complete(`${oid}\trefs/heads/sflow/config-history/one\n`);
  } });
  const broad = await session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/config-history/*'] });
  for (const refs of [
    ['refs/heads/sflow/config-history/one'],
    ['refs/heads/sflow/config-history/missing'],
    ['refs/heads/sflow/config-history/nested/*']
  ]) assert.equal(await session.observeAsync(remote, { includeHead: false, refs }), broad);
  assert.equal(calls.length, 1);
  await session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/config-history-adjacent/one'] });
  assert.equal(calls.length, 2);
  session.invalidate(remote);
  await session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/*/history/*'] });
  await session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/config/history/one'] });
  assert.equal(calls.length, 4, 'a wildcard ancestor does not prove a literal namespace complete');
});

test('a failed prefix observation cannot suppress a successful narrow authority observation', async () => {
  const calls = [];
  const session = new GitRemoteSession({ async runAsyncCommand(args) {
    calls.push(args);
    return args.includes('refs/heads/sflow/config-history/*')
      ? { status: 128, stdout: '', stderr: 'provider inventory refused' }
      : complete(`${oid}\trefs/heads/sflow/config-history/one\n`);
  } });
  const broad = await session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/config-history/*'] });
  assert.equal(broad.ok, false);
  const narrow = await session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/config-history/one'] });
  assert.equal(narrow.ok, true);
  assert.equal(narrow.refs.get('refs/heads/sflow/config-history/one'), oid);
  assert.equal(calls.length, 2);
});

test('an in-flight successful prefix probe coalesces descendants and invalidation demands fresh data', async () => {
  let release;
  let calls = 0;
  const wait = new Promise((resolve) => { release = resolve; });
  const session = new GitRemoteSession({ async runAsyncCommand() {
    calls += 1;
    if (calls === 1) await wait;
    return complete(`${oid}\trefs/heads/sflow/config-history/one\n`);
  } });
  const broad = session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/config-history/*'], timeoutMs: 5_000 });
  const narrow = session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/config-history/one'], timeoutMs: 5_000 });
  release();
  assert.equal(await broad, await narrow);
  assert.equal(calls, 1);
  session.invalidate(remote);
  await session.observeAsync(remote, { includeHead: false, refs: ['refs/heads/sflow/config-history/one'] });
  assert.equal(calls, 2);
});

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-engine-observations-'));
  const saved = Object.fromEntries([
    'SINGULARITY_FLOW_LEAD_REGISTRY', 'SINGULARITY_FLOW_ORGANISATION_CACHE',
    'SINGULARITY_FLOW_AUTHORITY_CACHE', 'SINGULARITY_FLOW_WORKSPACE_REGISTRY',
    'NODE_ENV', 'SINGULARITY_FLOW_TEST_IDENTITY'
  ].map((key) => [key, process.env[key]]));
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(base, 'local', 'leads.json');
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(base, 'local', 'organisation');
  process.env.SINGULARITY_FLOW_AUTHORITY_CACHE = path.join(base, 'local', 'authority');
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(base, 'local', 'workspaces.json');
  process.env.NODE_ENV = 'test';
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Engine Fixture';
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'source');
  const repository = path.join(base, 'repository.git');
  run('git', ['init', '-q', '-b', 'main', source], { cwd: base });
  run('git', ['config', 'user.name', 'Engine Fixture'], { cwd: source });
  run('git', ['config', 'user.email', 'engine@example.test'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), 'Fixture\n');
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'Initial'], { cwd: source });
  run('git', ['clone', '-q', '--bare', '--no-hardlinks', source, repository], { cwd: base });
  run('git', ['config', 'receive.autogc', 'false'], { cwd: repository });
  await ensureConfigurationBranch(repository, { capability: {
    capabilityId: 'payments', capabilityName: 'Payments', kind: 'delivery',
    repositoryId: 'application', jiraProject: null, teams: []
  }, authorIdentity: { name: 'Engine Fixture', email: 'engine@example.test' } });
  return { base, source, repository };
}

function countedSession() {
  const calls = [];
  const session = new GitRemoteSession({ env: enterpriseGitEnvironment(), async runAsyncCommand(args, options) {
    calls.push(args);
    return runRemoteGitAsync(args, options);
  } });
  return { calls, session };
}

test('self-lead inspection shares one fresh advertisement across locator, organisation and proposal readers', async (t) => {
  const f = await fixture(t);
  for (const refresh of [true, false]) {
    const { calls, session } = countedSession();
    const result = await inspectCapabilityRepository(f.repository, { refresh, authorityRemoteSession: session });
    assert.equal(result.status, 'known-repository-unassigned');
    assert.equal(result.matches.length, 1);
    assert.equal(result.proposalCoverage, 'complete');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('refs/heads/sflow/config'));
    assert.ok(calls[0].includes('refs/heads/state'));
    assert.ok(calls[0].includes('refs/heads/sflow/config-change/capability/*'));
  }
  const editor = path.join(f.base, 'editor');
  run('git', ['clone', '-q', '--no-local', '--branch', CONFIGURATION_BRANCH, f.repository, editor]);
  run('git', ['-c', 'user.name=Engine Fixture', '-c', 'user.email=engine@example.test',
    'commit', '--allow-empty', '-qm', 'Byte-identical new authority'], { cwd: editor });
  run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: editor });
  const { calls, session } = countedSession();
  const current = await readOrganisation(f.repository, { remoteSession: session });
  assert.equal(current.configurationCommit, run('git', ['rev-parse', CONFIGURATION_BRANCH], { cwd: f.repository }).stdout.trim());
  assert.equal(current.cached, false, 'a new operation observes a moved byte-identical authority');
  assert.equal(calls.length, 1);
});

test('inspection retries exact authorities after inventory failure without authorizing an unchecked new mapping', async (t) => {
  const f = await fixture(t);
  const before = run('git', ['show-ref'], { cwd: f.repository }).stdout;
  const calls = [];
  const session = new GitRemoteSession({ env: enterpriseGitEnvironment(), async runAsyncCommand(args, options) {
    calls.push(args);
    if (args.includes('refs/heads/sflow/config-change/capability/*')) {
      return { status: 128, stdout: '', stderr: 'Fixture inventory refused' };
    }
    return runRemoteGitAsync(args, options);
  } });
  const result = await inspectCapabilityRepository(f.repository, { authorityRemoteSession: session });
  assert.equal(result.matches.length, 1, 'the exact approved catalog remains readable');
  assert.equal(result.status, 'known-repository-unassigned');
  assert.notEqual(result.proposalCoverage, 'complete');
  assert.equal(result.completeness, 'partial');
  assert.ok(calls.some((args) => args.includes('refs/heads/sflow/config')
    && !args.some((arg) => arg.endsWith('/*'))), 'failed inventory does not poison exact current-ref queries');
  assert.equal(run('git', ['show-ref'], { cwd: f.repository }).stdout, before);
});

async function legacyMirror(f) {
  const approved = path.join(f.base, 'approved');
  const publisher = path.join(f.base, 'publisher');
  run('git', ['clone', '-q', '--no-local', '--branch', CONFIGURATION_BRANCH, f.repository, approved]);
  run('git', ['init', '-q', '-b', 'state', publisher]);
  run('git', ['config', 'user.name', 'Engine Fixture'], { cwd: publisher });
  run('git', ['config', 'user.email', 'engine@example.test'], { cwd: publisher });
  await cp(path.join(approved, 'singularity'), path.join(publisher, 'singularity'), { recursive: true });
  await cp(path.join(approved, '.github'), path.join(publisher, '.github'), { recursive: true });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: approved }).stdout.trim();
  const objects = new Map(run('git', ['ls-tree', '-r', '-z', 'HEAD'], { cwd: approved }).stdout
    .split('\0').filter(Boolean).map((row) => {
      const [metadata, relative] = row.split('\t');
      const [mode, , object] = metadata.split(' ');
      return [relative, { mode, object }];
    }));
  const files = {};
  const assets = {};
  for (const relative of await configurationAssetPaths(publisher)) {
    files[relative] = createHash('sha256').update(await readFile(path.join(publisher, relative))).digest('hex');
    assets[relative] = { sha256: files[relative], ...objects.get(relative) };
  }
  const historyBranch = `sflow/config-history/${sourceCommit}`;
  await mkdir(path.join(publisher, 'configuration'), { recursive: true });
  await writeFile(path.join(publisher, STATE_CONFIGURATION_MANIFEST), JSON.stringify({
    format: STATE_CONFIGURATION_FORMAT, layout: 'canonical-paths',
    source: { branch: CONFIGURATION_BRANCH, commit: sourceCommit },
    history: { branch: historyBranch, commit: sourceCommit }, files, assets
  }));
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'Legacy mirror'], { cwd: publisher });
  run('git', ['push', '-q', f.repository, 'state'], { cwd: publisher });
  run('git', ['push', '-q', f.repository, `${sourceCommit}:refs/heads/${historyBranch}`], { cwd: approved });
  run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: f.repository });
}

test('legacy onboarding retains its exact plan while history/review coverage uses one advertisement', async (t) => {
  const f = await fixture(t);
  await legacyMirror(f);
  const calls = [];
  const recordGit = async (args, options) => {
    if (args.includes('ls-remote')) calls.push(args);
    return runRemoteGitAsync(args, options);
  };
  const options = { runRemoteCommand: recordGit, useClassificationCache: false };
  const broad = await inspectRepositoryOnboarding(f.repository, options);
  assert.equal(broad.status, 'ready-to-restore');
  assert.equal(broad.state.legacyBinding.method, 'retained-history-and-portfolio');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('refs/heads/sflow/config-history/*'));
  assert.ok(calls[0].includes('refs/heads/sflow/config-change/onboarding/*'));
  calls.length = 0;
  const narrow = await inspectRepositoryOnboarding(f.repository, {
    ...options, async runRemoteCommand(args, commandOptions) {
      if (args.includes('refs/heads/sflow/config-history/*')) {
        calls.push(args);
        return { status: 128, stdout: '', stderr: 'Broad inventory unavailable' };
      }
      return recordGit(args, commandOptions);
    }
  });
  assert.equal(narrow.planId, broad.planId, 'advertisement coverage is not part of the exact plan identity');
  assert.deepEqual(narrow.observedRefs, broad.observedRefs);
  assert.ok(calls.length > 1, 'broad failure retries exact current/history/review refs');
});
