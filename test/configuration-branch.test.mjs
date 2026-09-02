import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  CONFIGURATION_BRANCH, CONFIGURATION_SOURCE_PATH, ensureConfigurationBranch,
  configurationBranchHead,
  configurationAssetPaths, isConfigurationAsset, loadStoryConfigurationDefinition,
  loadStoryConfigurationSnapshot,
  materializeConfigurationSnapshot, readConfigurationSource, resolveConfigurationRemote,
  resolveRemoteStoryConfigurationAuthority, resolveStoryConfigurationAuthority,
  STATE_CONFIGURATION_BRANCH, STATE_CONFIGURATION_MANIFEST,
  withStoryConfigurationSnapshotRead
} from '../src/configuration-branch.mjs';
import { GitRemoteSession } from '../src/git-execution.mjs';
import { loadDefinition } from '../src/config.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import {
  configurationReadRoot, configurationReadSnapshot
} from '../src/configuration-read-scope.mjs';
import { approvedConfigurationMaterializations } from '../src/configuration-materialization.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';
import { publishCurrentIdentityToConfiguration } from '../src/configuration-people.mjs';
import { run } from '../src/util.mjs';
import {
  createWorkspaceConfiguration, rememberWorkspace, workspaceRepositoryPath
} from '../src/workspace.mjs';
import { activateWorkspaceContext } from '../src/workspace-context.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('configuration asset paths cannot traverse the repository', () => {
  assert.equal(isConfigurationAsset('singularity/workflow.yml'), true);
  assert.equal(isConfigurationAsset('.github/agents/reviewer.agent.md'), true);
  assert.equal(isConfigurationAsset('singularity/../outside.txt'), false);
  assert.equal(isConfigurationAsset('singularity/../../outside.txt'), false);
  assert.equal(isConfigurationAsset('/singularity/workflow.yml'), false);
  assert.equal(isConfigurationAsset('singularity/world-model/manifest.json'), false,
    'the stock generated world model remains runtime, not approved configuration');
});

async function repositoryFixture({ branch = 'main' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-configuration-branch-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'application.git');
  run('git', ['init', '-q', '-b', branch, source], { cwd: root });
  run('git', ['config', 'user.name', 'Configuration Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'configuration@example.com'], { cwd: source });
  await mkdir(path.join(source, 'singularity', 'work-items', 'OLD-1'), { recursive: true });
  await mkdir(path.join(source, 'singularity'), { recursive: true });
  await writeFile(path.join(source, 'README.md'), '# Application\n');
  await writeFile(path.join(source, 'singularity', 'company-policy.md'), '# Preserve this policy\n');
  await writeFile(path.join(source, 'singularity', 'work-items', 'OLD-1', 'workflow.json'), '{}\n');
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'application baseline'], { cwd: source });
  run('git', ['clone', '-q', '--bare', source, remote], { cwd: root });
  return { root, source, remote };
}

async function publishStateConfigurationMirror(fixture) {
  const approved = path.join(fixture.root, 'state-mirror-source');
  const publisher = path.join(fixture.root, 'state-mirror-publisher');
  run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, approved], { cwd: fixture.root });
  run('git', ['init', '-q', '-b', 'state', publisher], { cwd: fixture.root });
  run('git', ['config', 'user.name', 'Configuration Mirror'], { cwd: publisher });
  run('git', ['config', 'user.email', 'mirror@example.com'], { cwd: publisher });
  await cp(path.join(approved, 'singularity'), path.join(publisher, 'singularity'), { recursive: true });
  await cp(path.join(approved, '.github'), path.join(publisher, '.github'), { recursive: true });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: approved }).stdout.trim();
  const files = {};
  const sourceEntries = new Map(run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', 'HEAD', '--',
    'singularity', '.github/agents'
  ], { cwd: approved }).stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return [line.slice(second + 1), {
      mode: line.slice(0, first), object: line.slice(first + 1, second)
    }];
  }));
  const assets = {};
  for (const relative of await configurationAssetPaths(publisher)) {
    files[relative] = createHash('sha256').update(await readFile(path.join(publisher, relative))).digest('hex');
    assets[relative] = { sha256: files[relative], ...sourceEntries.get(relative) };
  }
  const manifest = {
    format: 'singularity-flow-configuration-mirror/v2',
    layout: 'canonical-paths',
    source: { branch: CONFIGURATION_BRANCH, commit: sourceCommit },
    product: { version: 'test', revision: 'test' },
    files,
    assets
  };
  await mkdir(path.join(publisher, 'configuration'), { recursive: true });
  await writeFile(path.join(publisher, STATE_CONFIGURATION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'Mirror approved configuration'], { cwd: publisher });
  run('git', ['remote', 'add', 'origin', fixture.remote], { cwd: publisher });
  run('git', ['push', '-q', 'origin', 'state'], { cwd: publisher });
  return {
    sourceCommit,
    stateCommit: run('git', ['rev-parse', 'HEAD'], { cwd: publisher }).stdout.trim()
  };
}

test('configuration authority pins a non-main application default branch', async () => {
  const fixture = await repositoryFixture({ branch: 'trunk' });
  try {
    await ensureConfigurationBranch(fixture.remote);
    const workflow = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/workflow.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.equal(workflow.defaultBaseBranch, 'trunk');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('concurrent configuration bootstrap never reports a losing capability as published', async () => {
  const fixture = await repositoryFixture();
  const capability = (capabilityId) => ({
    capabilityId, capabilityName: capabilityId.toUpperCase(), kind: 'collection',
    repositoryId: 'application', jiraProject: null, teams: []
  });
  try {
    const results = await Promise.allSettled([
      ensureConfigurationBranch(fixture.remote, { capability: capability('alpha') }),
      ensureConfigurationBranch(fixture.remote, { capability: capability('beta') })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message,
      /does not define requested capability/);
    const map = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/capabilities.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.equal(Object.keys(map.capabilities).length, 1, 'only the winning capability is governed');
    assert.ok(['alpha', 'beta'].includes(Object.keys(map.capabilities)[0]));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a same-ID bootstrap race does not accept different winning capability values', async () => {
  const fixture = await repositoryFixture();
  const capability = (capabilityName) => ({
    capabilityId: 'alpha', capabilityName, kind: 'collection',
    repositoryId: 'application', jiraProject: null, teams: []
  });
  try {
    const results = await Promise.allSettled([
      ensureConfigurationBranch(fixture.remote, { capability: capability('Alpha Platform') }),
      ensureConfigurationBranch(fixture.remote, { capability: capability('Different Alpha') })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message,
      /created concurrently.*values do not match/);
    const approved = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/capabilities.yml`
    ], { cwd: fixture.remote }).stdout).capabilities.alpha;
    assert.ok(['Alpha Platform', 'Different Alpha'].includes(approved.name));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('repeated bootstrap accepts reviewed evolution of an existing capability', async () => {
  const fixture = await repositoryFixture();
  const requested = {
    capabilityId: 'alpha', capabilityName: 'Alpha', kind: 'collection',
    repositoryId: 'application', jiraProject: null, teams: []
  };
  try {
    await ensureConfigurationBranch(fixture.remote, { capability: requested });
    const checkout = path.join(fixture.root, 'reviewed-capability-change');
    run('git', ['clone', '-q', '--branch', CONFIGURATION_BRANCH, fixture.remote, checkout]);
    run('git', ['config', 'user.name', 'Configuration Reviewer'], { cwd: checkout });
    run('git', ['config', 'user.email', 'reviewer@example.test'], { cwd: checkout });
    const file = path.join(checkout, 'singularity/capabilities.yml');
    const definition = YAML.parseDocument(await readFile(file, 'utf8'));
    definition.setIn(['capabilities', 'alpha', 'name'], 'Reviewed Alpha Platform');
    definition.setIn(['capabilities', 'alpha', 'jira', 'projectKey'], 'ALPHA');
    definition.setIn(['capabilities', 'alpha', 'teams'], ['platform-team']);
    await writeFile(file, definition.toString());
    run('git', ['add', 'singularity/capabilities.yml'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Evolve approved capability metadata'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', `HEAD:${CONFIGURATION_BRANCH}`], { cwd: checkout });

    const repeated = await ensureConfigurationBranch(fixture.remote, { capability: requested });
    assert.equal(repeated.created, false);
    assert.equal(repeated.branch, CONFIGURATION_BRANCH);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('configuration authority is bootstrapped without changing application history', async () => {
  const fixture = await repositoryFixture();
  try {
    const before = run('git', ['rev-parse', 'main'], { cwd: fixture.remote }).stdout.trim();
    const result = await ensureConfigurationBranch(fixture.remote);
    assert.equal(result.branch, CONFIGURATION_BRANCH);
    assert.equal(result.created, true);
    assert.equal(run('git', ['rev-parse', 'main'], { cwd: fixture.remote }).stdout.trim(), before);
    assert.match(run('git', ['show', `${CONFIGURATION_BRANCH}:singularity/workflow.yml`], {
      cwd: fixture.remote
    }).stdout, /^version: 2/m);
    assert.equal(run('git', ['show', `${CONFIGURATION_BRANCH}:singularity/company-policy.md`], {
      cwd: fixture.remote
    }).stdout, '# Preserve this policy\n');
    assert.notEqual(run('git', [
      'cat-file', '-e', `${CONFIGURATION_BRANCH}:singularity/work-items/OLD-1/workflow.json`
    ], { cwd: fixture.remote, allowFailure: true }).status, 0, 'runtime state is never imported as configuration');
    assert.equal((await ensureConfigurationBranch(fixture.remote)).created, false, 'bootstrap is idempotent');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('configuration bootstrap invalidates a reusable remote session after publishing the new branch', async () => {
  const fixture = await repositoryFixture();
  try {
    const session = new GitRemoteSession();
    assert.equal(configurationBranchHead(fixture.remote, { session }).exists, false,
      'the shared session begins with a cached absent-branch observation');

    const created = await ensureConfigurationBranch(fixture.remote, { remoteSession: session });
    assert.equal(created.created, true);
    const observed = configurationBranchHead(fixture.remote, { session });
    assert.equal(observed.exists, true,
      'a successful bootstrap invalidates the negative observation before returning');
    assert.equal(observed.sha, created.commit);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('first capability authority never checks out an irrelevant monorepo application tree', async () => {
  const fixture = await repositoryFixture();
  const environmentKeys = [
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    // A required smudge filter represents LFS/code-generation work a large application checkout
    // may perform. It deliberately fails: configuration bootstrap has no reason to invoke it.
    await writeFile(path.join(fixture.source, 'large-application.bin'), Buffer.alloc(2 * 1024 * 1024, 0x5a));
    run('git', ['add', 'large-application.bin'], { cwd: fixture.source });
    run('git', ['commit', '-qm', 'large application payload'], { cwd: fixture.source });
    await writeFile(path.join(fixture.source, '.gitattributes'),
      'large-application.bin filter=monorepo required\n');
    run('git', ['add', '.gitattributes'], { cwd: fixture.source });
    run('git', ['commit', '-qm', 'application checkout filter'], { cwd: fixture.source });
    run('git', ['push', '-q', fixture.remote, 'main:main'], { cwd: fixture.source });
    run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: fixture.remote });

    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'filter.monorepo.smudge',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'filter.monorepo.required',
      GIT_CONFIG_VALUE_1: 'true'
    });

    const result = await ensureConfigurationBranch(fixture.remote);
    assert.equal(result.created, true);
    assert.equal(run('git', ['show', `${CONFIGURATION_BRANCH}:singularity/company-policy.md`], {
      cwd: fixture.remote
    }).stdout, '# Preserve this policy\n', 'the governed configuration bytes are still imported');
    assert.notEqual(run('git', [
      'cat-file', '-e', `${CONFIGURATION_BRANCH}:large-application.bin`
    ], { cwd: fixture.remote, allowFailure: true }).status, 0,
    'application blobs never enter the orphan configuration authority');
  } finally {
    for (const key of environmentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a lifecycle branch receives and verifies one exact approved configuration revision', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    run('git', ['switch', '-q', '-c', 'STORY-100'], { cwd: checkout });

    const snapshot = await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    assert.equal(snapshot.branch, CONFIGURATION_BRANCH);
    assert.match(snapshot.commit, /^[0-9a-f]{40}$/);
    assert.ok(snapshot.paths.includes(CONFIGURATION_SOURCE_PATH));
    assert.equal((await loadDefinition(checkout)).version, 2);

    const provenance = await readConfigurationSource(checkout, { verify: true });
    assert.equal(provenance.commit, snapshot.commit);
    assert.equal(provenance.repository, fixture.remote);
    assert.equal(
      provenance.files['singularity/company-policy.md'],
      snapshot.files['singularity/company-policy.md']
    );

    await writeFile(path.join(checkout, 'singularity', 'unapproved-local-policy.yml'), 'enabled: true\n');
    await assert.rejects(
      () => readConfigurationSource(checkout, { verify: true }),
      /Pinned configuration asset set changed after materialization.*Unexpected: singularity\/unapproved-local-policy\.yml/
    );
    await rm(path.join(checkout, 'singularity', 'unapproved-local-policy.yml'));

    await writeFile(path.join(checkout, 'singularity', 'company-policy.md'), '# Changed after pinning\n');
    await assert.rejects(
      () => readConfigurationSource(checkout, { verify: true }),
      /Pinned configuration asset changed after materialization/
    );
    assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), '# Application\n');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('custom configuration roots materialize while custom world-model output remains runtime', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const publisher = path.join(fixture.root, 'custom-root-publisher');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, publisher], {
      cwd: fixture.root
    });
    run('git', ['config', 'user.name', 'Custom Root Publisher'], { cwd: publisher });
    run('git', ['config', 'user.email', 'custom-roots@example.com'], { cwd: publisher });

    const workflowFile = path.join(publisher, 'singularity/workflow.yml');
    const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
    workflow.templatesRoot = 'governance/templates';
    workflow.worldModel.outputDir = 'governance/world-model';
    workflow.worldModel.promptSource = 'governance/prompts/worldmodel-builder.md';
    await writeFile(workflowFile, YAML.stringify(workflow));
    const portfolioFile = path.join(publisher, 'singularity/portfolio.yml');
    const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
    portfolio.templatesRoot = 'governance/templates';
    await writeFile(portfolioFile, YAML.stringify(portfolio));

    await cp(path.join(publisher, 'singularity/templates'), path.join(publisher, 'governance/templates'), {
      recursive: true
    });
    await mkdir(path.join(publisher, 'governance/prompts'), { recursive: true });
    await cp(
      path.join(publisher, 'singularity/prompts/worldmodel-builder.md'),
      path.join(publisher, 'governance/prompts/worldmodel-builder.md')
    );
    await mkdir(path.join(publisher, 'governance/world-model'), { recursive: true });
    await writeFile(path.join(publisher, 'governance/world-model/manifest.json'), '{"custom":true}\n');
    await writeFile(path.join(publisher, 'governance/application.txt'), 'must not be transported\n');
    await mkdir(path.join(publisher, 'singularity/world-model'), { recursive: true });
    await writeFile(path.join(publisher, 'singularity/world-model/manifest.json'),
      '{"generated":"stock-runtime"}\n');
    await rm(path.join(publisher, 'singularity/templates'), { recursive: true });
    run('git', ['add', '-A'], { cwd: publisher });
    run('git', ['commit', '-qm', 'use custom governed roots'], { cwd: publisher });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: publisher });

    const approvedPaths = await configurationAssetPaths(publisher);
    assert.ok(approvedPaths.includes('governance/templates/common/implementation.md'));
    assert.ok(approvedPaths.includes('governance/prompts/worldmodel-builder.md'));
    assert.equal(approvedPaths.includes('governance/world-model/manifest.json'), false);
    assert.ok(approvedPaths.includes('.github/agents/developer.agent.md'));
    assert.equal(approvedPaths.includes('governance/application.txt'), false);
    assert.equal(approvedPaths.includes('singularity/world-model/manifest.json'), false);

    const checkout = path.join(fixture.root, 'custom-root-checkout');
    run('git', ['clone', '-q', '--single-branch', '--branch', 'main', fixture.remote, checkout], {
      cwd: fixture.root
    });
    const approvedRead = await withApprovedConfigurationRead(checkout, async () => ({
      definition: await loadDefinition(checkout),
      snapshot: configurationReadSnapshot(checkout)
    }), { preferAuthority: true });
    assert.equal(approvedRead.definition.templatesRoot, 'governance/templates');
    assert.equal(approvedRead.definition.worldModel.outputDir, 'governance/world-model');
    assert.ok(approvedRead.snapshot?.assets?.some(
      (entry) => entry.relative === 'singularity/portfolio.yml'
    ), 'the request-local approved read retains the exact verified portfolio bytes');

    run('git', ['switch', '-q', '-c', 'CUSTOM-ROOTS'], { cwd: checkout });
    await mkdir(path.join(checkout, 'governance/world-model'), { recursive: true });
    await writeFile(path.join(checkout, 'governance/world-model/manifest.json'),
      '{"runtime":"preserve-me"}\n');
    const materialized = await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    assert.ok(materialized.paths.includes('governance/templates/common/implementation.md'));
    assert.equal(materialized.paths.includes('governance/world-model/manifest.json'), false);
    assert.ok(materialized.paths.includes('.github/agents/developer.agent.md'));
    assert.equal(materialized.paths.includes('governance/application.txt'), false);
    assert.equal(materialized.paths.includes('singularity/world-model/manifest.json'), false);
    assert.equal(JSON.parse(await readFile(
      path.join(checkout, 'governance/world-model/manifest.json'), 'utf8'
    )).runtime, 'preserve-me');
    assert.equal((await readConfigurationSource(checkout, { verify: true })).commit, materialized.commit);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('configuration verification uses canonical Git bytes across CRLF worktrees', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'crlf-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Windows Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'windows@example.com'], { cwd: checkout });
    run('git', ['switch', '-q', '-c', 'STORY-CRLF'], { cwd: checkout });
    await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    run('git', ['add', '-A'], { cwd: checkout });
    run('git', ['commit', '-qm', 'materialize approved configuration'], { cwd: checkout });
    run('git', ['config', 'core.autocrlf', 'true'], { cwd: checkout });
    const workflowFile = path.join(checkout, 'singularity/workflow.yml');
    const canonical = await readFile(workflowFile, 'utf8');
    await writeFile(workflowFile, canonical.replaceAll('\n', '\r\n'));
    assert.equal(run('git', ['diff', '--quiet', '--', 'singularity/workflow.yml'], {
      cwd: checkout, allowFailure: true
    }).status, 0, 'Git regards the CRLF checkout as the same canonical blob');
    const source = await readConfigurationSource(checkout, { verify: true });
    assert.equal(source.assets['singularity/workflow.yml'].mode, '100644');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('one verified Story snapshot validates and materializes without a second remote read', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'single-read-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['switch', '-q', '-c', 'STORY-SNAPSHOT'], { cwd: checkout });
    const authority = await resolveStoryConfigurationAuthority(checkout);
    const prepared = await loadStoryConfigurationSnapshot(authority);
    assert.equal(prepared.definition.version, 2);

    const fullRead = await withStoryConfigurationSnapshotRead(checkout, prepared, async () => ({
      snapshot: configurationReadSnapshot(checkout),
      workflow: await readFile(path.join(configurationReadRoot(checkout), 'singularity/workflow.yml'))
    }));
    assert.equal(fullRead.snapshot, prepared,
      'the full request-local read exposes the exact already-verified snapshot internally');
    assert.ok(fullRead.workflow.length > 0);

    const narrowRead = await withStoryConfigurationSnapshotRead(checkout, prepared, async () => ({
      snapshot: configurationReadSnapshot(checkout),
      portfolioVisible: await readFile(
        path.join(configurationReadRoot(checkout), 'singularity/portfolio.yml')
      ).then(() => true, (error) => error?.code !== 'ENOENT')
    }), { selectPaths: ['singularity/workflow.yml'] });
    assert.equal(narrowRead.snapshot, null,
      'selected-path scopes must not expose a parent snapshot containing omitted files');
    assert.equal(narrowRead.portfolioVisible, false);

    // Removing the remote proves materialization consumes the already-verified bytes instead of
    // silently cloning the authority a second time.
    await rm(fixture.remote, { recursive: true, force: true });
    const materialized = await materializeConfigurationSnapshot(checkout, {
      authority, snapshot: prepared
    });
    assert.equal(materialized.commit, authority.commit);
    assert.equal((await loadDefinition(checkout)).version, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('remote authority discovery observes configuration and state together exactly once', async () => {
  const calls = [];
  const session = {
    observe(remote, options) {
      calls.push({ remote, options });
      return {
        ok: true,
        remote,
        refs: new Map(),
        failure: null
      };
    }
  };

  assert.equal(await resolveRemoteStoryConfigurationAuthority(
    'https://example.invalid/authority.git', { session }
  ), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.includeHead, false);
  assert.deepEqual(calls[0].options.refs, [
    `refs/heads/${CONFIGURATION_BRANCH}`,
    `refs/heads/${STATE_CONFIGURATION_BRANCH}`
  ]);
});

test('configuration remote resolution preserves probe failures instead of reporting absence', async () => {
  const fixture = await repositoryFixture();
  try {
    run('git', ['remote', 'add', 'origin', fixture.remote], { cwd: fixture.source });
    const calls = [];
    const session = {
      observe(remote, options) {
        calls.push({ remote, options });
        return {
          ok: false,
          remote,
          refs: new Map(),
          failure: {
            code: 'REMOTE_UNREACHABLE',
            classification: 'offline',
            retryable: true,
            advice: 'Restore network access and retry.'
          }
        };
      }
    };

    await assert.rejects(
      () => resolveConfigurationRemote(fixture.source, 'origin', { session }),
      (error) => error.code === 'REMOTE_UNREACHABLE'
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options.refs, [`refs/heads/${CONFIGURATION_BRANCH}`]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a verified state authority retains its snapshot for reuse after the remote disappears', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const mirror = await publishStateConfigurationMirror(fixture);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: fixture.remote
    });

    const authority = await resolveRemoteStoryConfigurationAuthority(fixture.remote);
    assert.equal(authority.branch, STATE_CONFIGURATION_BRANCH);
    assert.equal(authority.commit, mirror.stateCommit);
    assert.equal(authority.sourceCommit, mirror.sourceCommit);

    await rm(fixture.remote, { recursive: true, force: true });
    const snapshot = await loadStoryConfigurationSnapshot(authority);
    assert.equal(snapshot.observedCommit, mirror.stateCommit);
    assert.equal(snapshot.sourceCommit, mirror.sourceCommit);
    assert.equal(snapshot.definition.version, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a capability workspace uses its explicit organisation authority for Story intake', async () => {
  const authority = await repositoryFixture();
  const delivery = await repositoryFixture();
  const sibling = await repositoryFixture();
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-split-configuration-authority-'));
  const registry = path.join(machine, 'workspaces.json');
  const selection = path.join(machine, 'active-workspace.json');
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  try {
    await ensureConfigurationBranch(authority.remote);
    const created = await createWorkspaceConfiguration({
      baseDirectory: path.join(machine, 'workspaces'),
      id: 'payments',
      name: 'Payments',
      leadRepository: 'delivery',
      capabilityAuthority: { url: authority.remote },
      capabilities: [],
      repositories: {
        delivery: {
          url: delivery.remote, defaultBranch: 'main', required: true, path: 'repos/delivery'
        },
        sibling: {
          url: sibling.remote, defaultBranch: 'main', required: true, path: 'repos/sibling'
        }
      }
    }, { confirmation: 'payments', clone: true });
    await rememberWorkspace(registry, created.workspace, created.status);
    await activateWorkspaceContext(registry, selection, created.workspace.id, {
      repositoryId: 'delivery', detectStory: false
    });
    process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registry;
    process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selection;

    const checkout = workspaceRepositoryPath(created.workspace, created.workspace.repositories.delivery);
    const resolved = await resolveStoryConfigurationAuthority(checkout);
    assert.equal(resolved.remote, authority.remote);
    assert.equal(resolved.branch, CONFIGURATION_BRANCH);
    assert.equal(await resolveConfigurationRemote(checkout), authority.remote);

    const siblingCheckout = workspaceRepositoryPath(
      created.workspace, created.workspace.repositories.sibling
    );
    const siblingAuthority = await resolveStoryConfigurationAuthority(siblingCheckout);
    assert.equal(siblingAuthority.remote, authority.remote,
      'a non-selected workspace member retains the explicit capability authority');
    assert.equal(await resolveConfigurationRemote(siblingCheckout), authority.remote);
    const siblingLinked = path.join(machine, 'linked-sibling');
    run('git', ['worktree', 'add', '-q', '-b', 'SIBLING-STORY', siblingLinked, 'main'], {
      cwd: siblingCheckout
    });
    const linkedAuthority = await resolveStoryConfigurationAuthority(siblingLinked);
    assert.equal(linkedAuthority.remote, authority.remote,
      'a linked worktree of a non-selected member retains the explicit capability authority');

    run('git', ['switch', '-q', '-c', 'PAY-100'], { cwd: checkout });
    const snapshot = await materializeConfigurationSnapshot(checkout);
    assert.equal(snapshot.repository, authority.remote);
    assert.equal((await readConfigurationSource(checkout, { verify: true })).repository, authority.remote);

    assert.equal(await resolveStoryConfigurationAuthority(delivery.source), null,
      'an unrelated checkout must not inherit the machine-wide active workspace authority');
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    await rm(authority.root, { recursive: true, force: true });
    await rm(delivery.root, { recursive: true, force: true });
    await rm(sibling.root, { recursive: true, force: true });
    await rm(machine, { recursive: true, force: true });
  }
});

test('Story intake refuses an authority that moves after selection without touching the checkout', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'stale-authority-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    const authority = await resolveStoryConfigurationAuthority(checkout, 'origin');
    assert.match(authority.commit, /^[0-9a-f]{40}$/);

    const publisher = path.join(fixture.root, 'stale-authority-publisher');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, publisher], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Publisher'], { cwd: publisher });
    run('git', ['config', 'user.email', 'publisher@example.com'], { cwd: publisher });
    await writeFile(path.join(publisher, 'singularity', 'company-policy.md'), '# New approved policy\n');
    run('git', ['add', 'singularity/company-policy.md'], { cwd: publisher });
    run('git', ['commit', '-qm', 'advance approved configuration'], { cwd: publisher });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: publisher });

    await assert.rejects(
      () => loadStoryConfigurationDefinition(authority),
      (error) => error.code === 'STORY_CONFIGURATION_AUTHORITY_STALE'
    );
    await assert.rejects(
      () => materializeConfigurationSnapshot(checkout, { authority, remoteName: 'origin' }),
      (error) => error.code === 'STORY_CONFIGURATION_AUTHORITY_STALE'
    );
    assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: checkout
    }).stdout, '', 'stale authority refusal is pre-mutation');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('new-Story workflow listing reads current authority instead of an older pinned Story', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'pinned-story-catalog');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    run('git', ['switch', '-q', '-c', 'PINNED-OLD'], { cwd: checkout });
    await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    const workflowFile = path.join(checkout, 'singularity/workflow.yml');
    const pinned = YAML.parse(await readFile(workflowFile, 'utf8'));
    delete pinned.workTypes['spec-driven-standard'];
    await writeFile(workflowFile, YAML.stringify(pinned));
    run('git', ['add', '-A'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Pin an older Story workflow catalog'], { cwd: checkout });

    const historical = JSON.parse(spawnSync(process.execPath, [
      cli, 'workflow', 'list', '--json'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }).stdout);
    assert.equal(historical.find((entry) => entry.id === 'spec-driven-standard')?.installed, false,
      'ordinary inspection describes the active Story pin');

    const forStart = spawnSync(process.execPath, [
      cli, 'workflow', 'list', '--json', '--for-start'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(forStart.status, 0, forStart.stderr || forStart.stdout);
    const catalog = JSON.parse(forStart.stdout);
    assert.equal(catalog.find((entry) => entry.id === 'spec-driven-standard')?.installed, true,
      'new Story intake describes the latest approved configuration');
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'PINNED-OLD');
    assert.equal(YAML.parse(await readFile(workflowFile, 'utf8')).workTypes['spec-driven-standard'],
      undefined, 'authority inspection never mutates the pinned Story');

    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-SPEC-NEW', '--json', '--from-branch', 'main',
      '--work-type', 'spec-driven-standard', '--agent', 'product-owner',
      '--title', 'Use the current standard workflow',
      '--description', 'A new Story must use approved configuration instead of the older active pin.'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const result = JSON.parse(started.stdout);
    const newStoryRoot = result.data.repositoryPath ?? checkout;
    const state = JSON.parse(await readFile(path.join(
      newStoryRoot, 'singularity/work-items/CFG-SPEC-NEW/workflow.json'
    ), 'utf8'));
    assert.equal(state.workItem.workType, 'spec-driven-standard');
    assert.equal(state.resolution.configurationSource.branch, CONFIGURATION_BRANCH);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('new-Story choices and start freeze one current authority definition', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    run('git', ['push', '-q', fixture.remote, 'HEAD:refs/heads/trunk'], { cwd: fixture.source });

    const checkout = path.join(fixture.root, 'one-snapshot-start');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    run('git', ['remote', 'add', 'approved', fixture.remote], { cwd: checkout });
    run('git', ['remote', 'set-url', '--push', 'approved', path.join(fixture.root, 'unreachable.git')], {
      cwd: checkout
    });
    run('git', ['switch', '-q', '-c', 'PINNED-CHOICES'], { cwd: checkout });
    await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    const pinnedFile = path.join(checkout, 'singularity/workflow.yml');
    const pinned = YAML.parse(await readFile(pinnedFile, 'utf8'));
    pinned.git.remote = 'stale-policy';
    pinned.git.publish = 'required';
    pinned.defaultBaseBranch = 'main';
    delete pinned.workTypes['current-only'];
    await writeFile(pinnedFile, YAML.stringify(pinned));
    run('git', ['add', '-A'], { cwd: checkout });
    run('git', ['commit', '-qm', 'retain older start policy'], { cwd: checkout });

    const publisher = path.join(fixture.root, 'one-snapshot-publisher');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, publisher], {
      cwd: fixture.root
    });
    run('git', ['config', 'user.name', 'Configuration Publisher'], { cwd: publisher });
    run('git', ['config', 'user.email', 'publisher@example.com'], { cwd: publisher });
    const approvedFile = path.join(publisher, 'singularity/workflow.yml');
    const approved = YAML.parse(await readFile(approvedFile, 'utf8'));
    approved.git.remote = 'approved';
    approved.git.publish = 'off';
    approved.defaultBaseBranch = 'trunk';
    approved.approvalSecurity.autoEnrollNewIdentities = false;
    approved.workTypes['current-only'] = {
      ...approved.workTypes['quick-fix'],
      label: 'Current authority only'
    };
    await writeFile(approvedFile, YAML.stringify(approved));
    run('git', ['add', 'singularity/workflow.yml'], { cwd: publisher });
    run('git', ['commit', '-qm', 'change every new Story decision'], { cwd: publisher });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: publisher });

    let receipt = JSON.parse(spawnSync(process.execPath, [
      cli, 'choices', 'begin', 'start', 'CFG-ONE-SNAPSHOT', '--json'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }).stdout);
    assert.ok(receipt.choiceSets.find((entry) => entry.id === 'workflow-template')
      .options.some((entry) => entry.id === 'current-only'));
    assert.ok(receipt.choiceSets.find((entry) => entry.id === 'base-branch')
      .options.some((entry) => entry.id === 'trunk'));
    for (const [choice, answer] of [
      ['base-branch', 'trunk'],
      ['intake-source', 'manual'],
      ['workflow-template', 'current-only']
    ]) {
      const answered = spawnSync(process.execPath, [
        cli, 'choices', 'answer', receipt.token, choice, answer, '--json'
      ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
      assert.equal(answered.status, 0, answered.stderr || answered.stdout);
      receipt = JSON.parse(answered.stdout);
    }
    assert.equal(receipt.ready, true);

    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-ONE-SNAPSHOT', '--json', '--selection-receipt', receipt.token,
      '--title', 'Use one current authority snapshot',
      '--description', 'Every new Story decision comes from the same approved definition.'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const result = JSON.parse(started.stdout);
    assert.equal(result.data.workType, 'current-only');
    assert.equal(result.data.base.branch, 'trunk');
    assert.equal(result.data.base.remote, 'approved');
    assert.equal(result.data.publication.pushed, false,
      'approved publish=off must not require the deliberately unreachable push URL');

    // An existing local Story is governed by its immutable pin. Starting the same ID again must
    // resume without probing either the application destination or configuration authority.
    run('git', ['remote', 'set-url', 'approved', path.join(fixture.root, 'offline-approved.git')], {
      cwd: checkout
    });
    run('git', ['remote', 'set-url', 'origin', path.join(fixture.root, 'offline-origin.git')], {
      cwd: checkout
    });
    const resumed = spawnSync(process.execPath, [
      cli, 'start', 'CFG-ONE-SNAPSHOT', '--json'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(),
      'CFG-ONE-SNAPSHOT');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a later materialization records configuration assets removed by the approved revision', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'checkout-removal');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['switch', '-q', '-c', 'STORY-REMOVE'], { cwd: checkout });
    await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    assert.equal(await readFile(path.join(checkout, 'singularity/company-policy.md'), 'utf8'), '# Preserve this policy\n');

    const approved = path.join(fixture.root, 'approved-config');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, approved], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Tester'], { cwd: approved });
    run('git', ['config', 'user.email', 'configuration@example.com'], { cwd: approved });
    await rm(path.join(approved, 'singularity/company-policy.md'));
    run('git', ['add', '-A'], { cwd: approved });
    run('git', ['commit', '-qm', 'remove obsolete policy'], { cwd: approved });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: approved });

    const refreshed = await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    assert.ok(refreshed.paths.includes('singularity/company-policy.md'));
    await assert.rejects(() => readFile(path.join(checkout, 'singularity/company-policy.md'), 'utf8'), /ENOENT/);
    const source = await readConfigurationSource(checkout, { verify: true });
    assert.equal(source.schemaVersion, 2);
    assert.match(source.projectionSha256, /^[0-9a-f]{64}$/);
    assert.match(source.removed['singularity/company-policy.md'].object, /^[0-9a-f]{40,64}$/);
    const baseline = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    const changes = await buildRepositoryChangeSet(checkout, { baseCommit: baseline });
    assert.equal(
      approvedConfigurationMaterializations(changes, source).has('singularity/company-policy.md'),
      true,
      'an exact deletion selected by approved configuration is input projection, not a Story violation'
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Story start materializes approved configuration without requiring it on application main', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'story-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-100', '--title', 'Use approved configuration',
      '--description', 'Prove application main can remain code-only.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'CFG-100');
    const workflow = JSON.parse(await readFile(
      path.join(checkout, 'singularity', 'work-items', 'CFG-100', 'workflow.json'), 'utf8'
    ));
    assert.equal(workflow.schemaVersion, currentSchemaVersion('story-workflow'));
    assert.equal(workflow.resolution.wel.mode, 'disabled');
    assert.equal(workflow.resolution.wel.rollout.enrollment, 'new-story-only');
    assert.match(workflow.resolution.configurationSource.commit, /^[0-9a-f]{40}$/);
    assert.equal(workflow.resolution.configurationSource.branch, CONFIGURATION_BRANCH);
    assert.equal(workflow.phases.intake.approvalPolicy.allowSelfApproval, true,
      'new Stories pin the default self-approval control');
    assert.ok(Object.values(workflow.resolution.approvalAuthorities).every((authority) =>
      authority.members.some((member) => member.email === 'story@example.com')),
    'the Story pins its starter identity in every approval group');
    const approvedWorkflow = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/workflow.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.ok(Object.values(approvedWorkflow.approvalAuthorities).every((authority) =>
      authority.members.some((member) => member.email === 'story@example.com')),
    'automatic enrollment is published before configuration is materialized');
    assert.equal(approvedWorkflow.approvalSecurity.autoEnrollNewIdentities, true);
    const approvedPortfolio = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/portfolio.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.ok(Object.values(approvedPortfolio.approvalAuthorities).every((authority) =>
      authority.members.some((member) => member.email === 'story@example.com')),
    'automatic enrollment covers every Initiative approval group too');
    assert.equal(
      run('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], {
        cwd: fixture.remote, allowFailure: true
      }).status,
      128,
      'application main remains free of Singularity configuration'
    );
    assert.equal(run('git', ['cat-file', '-e', 'CFG-100:singularity/configuration-source.json'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 0, 'the published Story carries configuration provenance');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Story start recovers from a verified state mirror when sflow/config is unavailable', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const mirrored = await publishStateConfigurationMirror(fixture);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: fixture.remote });
    const checkout = path.join(fixture.root, 'state-only-story-checkout');
    run('git', ['clone', '-q', '--single-branch', '--branch', 'main', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'State Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'state-story@example.com'], { cwd: checkout });
    assert.notEqual(run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/state'], {
      cwd: checkout, allowFailure: true
    }).status, 0, 'the narrow clone begins without a local state ref');

    const branches = spawnSync(process.execPath, [cli, 'workspace', 'branches', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(branches.status, 0, branches.stderr || branches.stdout);
    assert.notEqual(run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/state'], {
      cwd: checkout, allowFailure: true
    }).status, 0, 'a read-only authority overlay must not mutate the checkout remote-tracking refs');
    assert.ok(JSON.parse(branches.stdout).choices.some((choice) => choice.branch === 'main' && choice.everywhere),
      'the VS Code base-branch command reads the local verified state mirror too');

    // These are the independent calls made while the VS Code Start form is open. It is not enough
    // for base preflight alone to work: either missing catalog silently empties a required dropdown
    // and prevents the form from ever issuing `start`.
    const profiles = spawnSync(process.execPath, [cli, 'initiative', 'profiles', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(profiles.status, 0, profiles.stderr || profiles.stdout);
    assert.ok(JSON.parse(profiles.stdout).some((profile) => profile.id === 'epic-planning'));
    const workflows = spawnSync(process.execPath, [cli, 'workflow', 'list', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(workflows.status, 0, workflows.stderr || workflows.stdout);
    assert.ok(JSON.parse(workflows.stdout).some((workflow) => workflow.id === 'chore' && workflow.governs === 'story'));
    const validation = spawnSync(process.execPath, [cli, 'configuration', 'validate', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
    assert.equal(JSON.parse(validation.stdout).valid, true);
    const beforeStart = spawnSync(process.execPath, [cli, 'nextsteps', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(beforeStart.status, 0, beforeStart.stderr || beforeStart.stdout);
    assert.equal(JSON.parse(beforeStart.stdout).state, 'no_active_work_item');

    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-STATE', '--json', '--title', 'Use state recovery configuration',
      '--description', 'Create a Story when only the verified state mirror is available.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const workflow = JSON.parse(await readFile(
      path.join(checkout, 'singularity/work-items/CFG-STATE/workflow.json'), 'utf8'
    ));
    assert.equal(workflow.resolution.configurationSource.commit, mirrored.sourceCommit);
    assert.deepEqual(workflow.resolution.configurationSource.mirror, {
      branch: 'state', commit: mirrored.stateCommit
    });
    assert.equal(run('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 128, 'application main remains configuration-free');
    assert.equal(run('git', ['cat-file', '-e', 'CFG-STATE:singularity/configuration-source.json'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 0, 'the Story publishes hash-bound state-mirror provenance');

    const narrowResume = path.join(fixture.root, 'narrow-state-story-resume-checkout');
    run('git', ['clone', '-q', '--single-branch', '--branch', 'main', fixture.remote, narrowResume], {
      cwd: fixture.root
    });
    run('git', ['config', 'user.name', 'Narrow Resume Tester'], { cwd: narrowResume });
    run('git', ['config', 'user.email', 'narrow-resume@example.com'], { cwd: narrowResume });
    const narrowResumed = spawnSync(process.execPath, [
      cli, 'resume', 'CFG-STATE', '--fetch', '--agent', 'developer', '--json'
    ], { cwd: narrowResume, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(narrowResumed.status, 0, narrowResumed.stderr || narrowResumed.stdout);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: narrowResume }).stdout.trim(), 'CFG-STATE');

    // Once started, every phase is driven by the immutable configuration snapshot carried by the
    // Story. Prove that ordinary phase reads and authoring preparation no longer consult the shared
    // mirror by removing that authority before exercising them.
    run('git', ['update-ref', '-d', 'refs/heads/state'], { cwd: fixture.remote });
    const phase = spawnSync(process.execPath, [cli, 'phase', 'show', 'intake', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(phase.status, 0, phase.stderr || phase.stdout);
    assert.equal(JSON.parse(phase.stdout).phase, 'intake');
    const prepared = spawnSync(process.execPath, [cli, 'prepare', 'intake', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    const duringStory = spawnSync(process.execPath, [cli, 'nextsteps', '--json'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
    });
    assert.equal(duringStory.status, 0, duringStory.stderr || duringStory.stdout);
    assert.equal(JSON.parse(duringStory.stdout).workId, 'CFG-STATE');

    // A second machine can re-enter from the published lifecycle branch even if the shared mirror
    // is temporarily unavailable. Resume first discovers the Story ref, then switches to and uses
    // that ref's pinned files; it never recreates or substitutes configuration.
    const resumedCheckout = path.join(fixture.root, 'state-story-resume-checkout');
    run('git', ['clone', '-q', fixture.remote, resumedCheckout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Resume Tester'], { cwd: resumedCheckout });
    run('git', ['config', 'user.email', 'resume@example.com'], { cwd: resumedCheckout });
    const resumed = spawnSync(process.execPath, [
      cli, 'resume', 'CFG-STATE', '--fetch', '--agent', 'developer', '--json'
    ], { cwd: resumedCheckout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: resumedCheckout }).stdout.trim(), 'CFG-STATE');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a state mirror with changed bytes is not a Story configuration authority', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    await publishStateConfigurationMirror(fixture);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: fixture.remote });
    const tamper = path.join(fixture.root, 'tampered-state');
    run('git', ['clone', '-q', '-b', 'state', fixture.remote, tamper], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Mirror'], { cwd: tamper });
    run('git', ['config', 'user.email', 'mirror@example.com'], { cwd: tamper });
    await writeFile(path.join(tamper, 'singularity/workflow.yml'), 'version: 2\n');
    run('git', ['add', 'singularity/workflow.yml'], { cwd: tamper });
    run('git', ['commit', '-qm', 'Tamper with mirrored bytes'], { cwd: tamper });
    run('git', ['push', '-q', 'origin', 'state'], { cwd: tamper });

    const checkout = path.join(fixture.root, 'tampered-state-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    await assert.rejects(
      () => materializeConfigurationSnapshot(checkout, { remote: fixture.remote }),
      /mirror (?:Git identity|hash) does not match/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a state mirror with a changed Git mode is not a Story configuration authority', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    await publishStateConfigurationMirror(fixture);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: fixture.remote });
    const tamper = path.join(fixture.root, 'mode-tampered-state');
    run('git', ['clone', '-q', '-b', 'state', fixture.remote, tamper], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Mirror'], { cwd: tamper });
    run('git', ['config', 'user.email', 'mirror@example.com'], { cwd: tamper });
    run('git', ['update-index', '--chmod=+x', 'singularity/workflow.yml'], { cwd: tamper });
    run('git', ['commit', '-qm', 'Tamper with mirrored mode'], { cwd: tamper });
    run('git', ['push', '-q', 'origin', 'state'], { cwd: tamper });

    const checkout = path.join(fixture.root, 'mode-tampered-state-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    await assert.rejects(
      () => materializeConfigurationSnapshot(checkout, { remote: fixture.remote }),
      /mirror Git identity does not match/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Story start changes nothing when neither configuration authority is available', async () => {
  const fixture = await repositoryFixture();
  try {
    const checkout = path.join(fixture.root, 'no-authority-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'No Authority Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'no-authority@example.com'], { cwd: checkout });
    const before = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-NONE', '--json', '--title', 'No authority',
      '--description', 'Refuse without configuration authority.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: {
      ...process.env,
      NO_COLOR: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(fixture.root, 'empty-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(fixture.root, 'no-active-workspace.json')
    } });
    assert.notEqual(started.status, 0, `${started.stderr}\n${started.stdout}`);
    assert.match(started.stderr, /Neither an approved sflow\/config branch nor a verified state configuration mirror/);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'main');
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim(), before);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: checkout }).stdout, '');
    assert.notEqual(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/CFG-NONE'], {
      cwd: checkout, allowFailure: true
    }).status, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI Story start never substitutes a base workflow for an unreadable authority', async () => {
  const fixture = await repositoryFixture();
  try {
    const isolated = {
      ...process.env,
      NO_COLOR: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(fixture.root, 'empty-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(fixture.root, 'no-active-workspace.json')
    };
    const initialized = spawnSync(process.execPath, [cli, 'init'], {
      cwd: fixture.source, encoding: 'utf8', env: isolated
    });
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    run('git', ['add', '.github', 'singularity'], { cwd: fixture.source });
    run('git', ['commit', '-qm', 'legacy checked-out configuration'], { cwd: fixture.source });
    run('git', ['push', '-q', fixture.remote, 'main'], { cwd: fixture.source });

    const checkout = path.join(fixture.root, 'unreadable-authority-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Offline Authority Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'offline-authority@example.com'], { cwd: checkout });
    const baseCommit = run('git', ['rev-parse', 'main'], { cwd: checkout }).stdout.trim();
    run('git', ['switch', '-q', '-c', 'CFG-OFFLINE'], { cwd: checkout });
    await mkdir(path.join(checkout, 'singularity/seeds'), { recursive: true });
    await writeFile(path.join(checkout, 'singularity/seeds/CFG-OFFLINE.yml'), YAML.stringify({
      story: { workId: 'CFG-OFFLINE', parentBranch: 'main', baseCommit }
    }));
    run('git', ['add', 'singularity/seeds/CFG-OFFLINE.yml'], { cwd: checkout });
    run('git', ['commit', '-qm', 'materialize Story seed'], { cwd: checkout });
    run('git', ['switch', '-q', 'main'], { cwd: checkout });
    run('git', ['remote', 'set-url', 'origin', path.join(fixture.root, 'missing-authority.git')], {
      cwd: checkout
    });
    const before = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();

    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-OFFLINE', '--json', '--title', 'Refuse stale base configuration',
      '--description', 'Do not silently govern with an older checked-out workflow.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: isolated });
    assert.notEqual(started.status, 0, `${started.stderr}\n${started.stdout}`);
    assert.match(started.stderr, /Cannot reach Story configuration authority/);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'main');
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim(), before);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: checkout }).stdout, '');
    assert.match(run('git', ['branch', '--list', 'CFG-OFFLINE'], { cwd: checkout }).stdout, /CFG-OFFLINE/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('automatic identity enrollment obeys the approved configuration switch', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const approved = path.join(fixture.root, 'approved-auto-enrollment-off');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, approved], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Tester'], { cwd: approved });
    run('git', ['config', 'user.email', 'configuration@example.com'], { cwd: approved });
    const workflowFile = path.join(approved, 'singularity/workflow.yml');
    const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
    workflow.approvalSecurity.autoEnrollNewIdentities = false;
    await writeFile(workflowFile, YAML.stringify(workflow));
    run('git', ['add', 'singularity/workflow.yml'], { cwd: approved });
    run('git', ['commit', '-qm', 'disable automatic identity enrollment'], { cwd: approved });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: approved });

    const checkout = path.join(fixture.root, 'auto-enrollment-off-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Unlisted Developer'], { cwd: checkout });
    run('git', ['config', 'user.email', 'unlisted@example.com'], { cwd: checkout });
    const result = await publishCurrentIdentityToConfiguration(checkout, { automatic: true });
    assert.equal(result.changed, false);
    assert.equal(result.skipped, 'automatic-enrollment-disabled');

    const after = YAML.parse(run('git', [
      'show', `${CONFIGURATION_BRANCH}:singularity/workflow.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.ok(Object.values(after.approvalAuthorities).every((authority) =>
      !authority.members.some((member) => member.email === 'unlisted@example.com')));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('failed Story start restores materialized configuration so retries reach the real refusal', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const approved = path.join(fixture.root, 'approved-invalid-id');
    run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, fixture.remote, approved], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Configuration Tester'], { cwd: approved });
    run('git', ['config', 'user.email', 'configuration@example.com'], { cwd: approved });
    const workflowFile = path.join(approved, 'singularity/workflow.yml');
    const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
    workflow.idPattern = '^CFG-[0-9]+$';
    await writeFile(workflowFile, YAML.stringify(workflow));
    run('git', ['add', 'singularity/workflow.yml'], { cwd: approved });
    run('git', ['commit', '-qm', 'restrict governed Story identifiers'], { cwd: approved });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: approved });

    const checkout = path.join(fixture.root, 'failed-story-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    const invoke = () => spawnSync(process.execPath, [
      cli, 'start', 'WORK-ANU', '--title', 'Reach the real refusal',
      '--description', 'A failed materialization must not poison the next attempt.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = invoke();
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /Work ID WORK-ANU does not match \^CFG-\[0-9\]\+\$/);
      assert.doesNotMatch(failed.stderr, /Working tree is not clean/);
      assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'main');
      assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: checkout
      }).stdout, '');
      assert.notEqual(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/WORK-ANU'], {
        cwd: checkout, allowFailure: true
      }).status, 0);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Story start from a governance proposal still materializes approved configuration', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote);
    const checkout = path.join(fixture.root, 'governance-checkout');
    run('git', ['clone', '-q', fixture.remote, checkout], { cwd: fixture.root });
    run('git', ['config', 'user.name', 'Story Tester'], { cwd: checkout });
    run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
    run('git', ['switch', '-q', '-c', 'sflow/govern/application-review'], { cwd: checkout });
    await materializeConfigurationSnapshot(checkout, { remote: fixture.remote });
    run('git', ['add', '-A'], { cwd: checkout });
    run('git', ['commit', '-qm', 'review governed configuration'], { cwd: checkout });

    const started = spawnSync(process.execPath, [
      cli, 'start', 'CFG-REVIEW', '--title', 'Start from reviewed governance',
      '--description', 'Cut the Story from main and pin approved configuration.',
      '--from-branch', 'main', '--work-type', 'chore', '--agent', 'developer', '--json'
    ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

    assert.equal(started.status, 0, started.stderr || started.stdout);
    const result = JSON.parse(started.stdout);
    assert.equal(result.data.workItem.id, 'CFG-REVIEW');
    assert.equal(result.data.currentPhase, 'intake');
    assert.equal(run('git', ['branch', '--show-current'], { cwd: checkout }).stdout.trim(), 'CFG-REVIEW');
    assert.equal(run('git', ['cat-file', '-e', 'CFG-REVIEW:singularity/configuration-source.json'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 0, 'the Story branch carries approved configuration provenance');
    assert.notEqual(run('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 0, 'application main remains unchanged');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
