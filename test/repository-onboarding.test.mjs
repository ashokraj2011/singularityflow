import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import {
  activateRepositoryOnboardingProposal, applyRepositoryOnboarding,
  inspectRepositoryOnboarding, inspectRepositoryOnboardingProposal,
  listRepositoryOnboardingProposals
} from '../src/repository-onboarding.mjs';
import {
  CONFIGURATION_BRANCH, STATE_CONFIGURATION_FORMAT, STATE_CONFIGURATION_MANIFEST,
  configurationAssetPaths, ensureConfigurationBranch
} from '../src/configuration-branch.mjs';
import { createCapabilityAuthorityLink } from '../src/capability-authority-link.mjs';
import { enterpriseGitEnvironment } from '../src/git-enterprise-environment.mjs';
import {
  currentSchemaVersion, familyForStoredPath, readRecord
} from '../src/schema-migrations.mjs';
import {
  mapCapability, organisationCacheFile, readOrganisation
} from '../src/organisation.mjs';
import {
  listLeadRepositories, rememberLeadRepository
} from '../src/lead-repositories.mjs';
import { gitRepositoryComparisonKey } from '../src/git-repository-identity.mjs';
import { GitRemoteSession, runRemoteGitAsync } from '../src/git-execution.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { recordSha256 } from '../src/records.mjs';
import { renderPlatformCommand } from '../src/safe-command-guidance.mjs';
import { run } from '../src/util.mjs';

async function repositoryFixture(name = 'application', { objectFormat = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-repository-onboarding-'));
  const source = path.join(base, `${name}-source`);
  const remote = path.join(base, `${name}.git`);
  run('git', [
    'init', '-q', ...(objectFormat ? [`--object-format=${objectFormat}`] : []), '-b', 'main', source
  ], { cwd: base });
  run('git', ['config', 'user.name', 'Onboarding Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'onboarding@example.test'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), `# ${name}\n`);
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'Initial application'], { cwd: source });
  run('git', ['clone', '-q', '--bare', '--no-hardlinks', source, remote], { cwd: base });
  // receive-pack may detach automatic maintenance after a push. A following local clone can then
  // race that repack while it copies the bare repository's pack files, so keep this fixture remote
  // stable and leave maintenance behavior to the Git transport tests.
  run('git', ['config', 'receive.autogc', 'false'], { cwd: remote });
  return { base, source, remote };
}

async function publishStateMirror(fixture, {
  retainHistory = false, subjectBound = true
} = {}) {
  const approved = path.join(fixture.base, 'approved');
  const publisher = path.join(fixture.base, 'state-publisher');
  run('git', ['clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH, fixture.remote, approved], {
    cwd: fixture.base
  });
  run('git', ['init', '-q', '-b', 'state', publisher], { cwd: fixture.base });
  run('git', ['config', 'user.name', 'State Mirror'], { cwd: publisher });
  run('git', ['config', 'user.email', 'state@example.test'], { cwd: publisher });
  await cp(path.join(approved, 'singularity'), path.join(publisher, 'singularity'), {
    recursive: true
  });
  await cp(path.join(approved, '.github'), path.join(publisher, '.github'), {
    recursive: true
  });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: approved }).stdout.trim();
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
  const files = {};
  const assets = {};
  for (const relative of await configurationAssetPaths(publisher)) {
    files[relative] = createHash('sha256')
      .update(await readFile(path.join(publisher, relative))).digest('hex');
    assets[relative] = { sha256: files[relative], ...sourceEntries.get(relative) };
  }
  const historyBranch = `sflow/config-history/${sourceCommit}`;
  const manifest = {
    format: STATE_CONFIGURATION_FORMAT,
    layout: 'canonical-paths',
    ...(subjectBound ? { subject: {
      repositoryIdentity: `sha256:${recordSha256({
        repositoryKey: gitRepositoryComparisonKey(fixture.remote)
      })}`
    } } : {}),
    source: { branch: CONFIGURATION_BRANCH, commit: sourceCommit },
    ...(retainHistory ? { history: { branch: historyBranch, commit: sourceCommit } } : {}),
    files,
    assets
  };
  await mkdir(path.join(publisher, 'configuration'), { recursive: true });
  await writeFile(path.join(publisher, STATE_CONFIGURATION_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'Publish verified state mirror'], { cwd: publisher });
  run('git', ['remote', 'add', 'origin', fixture.remote], { cwd: publisher });
  run('git', ['push', '-q', 'origin', 'state'], { cwd: publisher });
  if (retainHistory) {
    run('git', ['push', '-q', 'origin', `${sourceCommit}:refs/heads/${historyBranch}`], {
      cwd: approved
    });
  }
  return {
    sourceCommit,
    stateCommit: run('git', ['rev-parse', 'HEAD'], { cwd: publisher }).stdout.trim()
  };
}

async function publishStateFiles(fixture, files) {
  const publisher = path.join(fixture.base, `state-${Math.random().toString(16).slice(2)}`);
  run('git', ['init', '-q', '-b', 'state', publisher], { cwd: fixture.base });
  run('git', ['config', 'user.name', 'State Publisher'], { cwd: publisher });
  run('git', ['config', 'user.email', 'state@example.test'], { cwd: publisher });
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(publisher, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'Publish state'], { cwd: publisher });
  run('git', ['remote', 'add', 'origin', fixture.remote], { cwd: publisher });
  run('git', ['push', '-q', 'origin', 'state'], { cwd: publisher });
}

const capability = {
  capabilityId: 'payments', capabilityName: 'Payments', kind: 'delivery',
  repositoryId: 'application', jiraProject: null, teams: []
};

async function prepareConfigurationProposalMode(fixture, mode) {
  await ensureConfigurationBranch(fixture.remote, { capability });
  if (mode === 'migrate') {
    const editor = path.join(fixture.base, 'migration-source');
    run('git', [
      'clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH,
      fixture.remote, editor
    ], { cwd: fixture.base });
    run('git', ['config', 'user.name', 'Migration Source'], { cwd: editor });
    run('git', ['config', 'user.email', 'migration@example.test'], { cwd: editor });
    await rm(path.join(editor, '.github', 'agents', 'developer.agent.md'));
    run('git', ['add', '-A'], { cwd: editor });
    run('git', ['commit', '-qm', 'Retain an older packaged configuration'], { cwd: editor });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: editor });
  }
  const plan = await inspectRepositoryOnboarding(fixture.remote, { mode });
  assert.equal(plan.mode, mode);
  assert.equal(plan.status, 'update-available');
  assert.equal(plan.canApply, true);
  assert.match(plan.proposalBranch,
    new RegExp(`^sflow/config-change/onboarding/${mode}-[0-9a-f]{12}$`, 'u'));
  return plan;
}

test('repeat onboarding preview reuses exact-ref metadata while refresh and apply revalidate', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    await publishStateMirror(fixture);
    const env = {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(fixture.base, 'local', 'workspaces.json')
    };
    let clones = 0;
    let advertisements = 0;
    const observeGit = async (args, options) => {
      if (args.includes('clone')) clones += 1;
      if (args.includes('ls-remote')) advertisements += 1;
      return runRemoteGitAsync(args, options);
    };
    const options = {
      env, runRemoteCommand: observeGit,
      classificationCacheBuildIdentity: `source:${'a'.repeat(64)}`
    };
    const first = await inspectRepositoryOnboarding(fixture.remote, options);
    assert.equal(first.status, 'ready');
    assert.equal(first.configuration.status, 'current');
    assert.equal(first.state.kind, 'configuration-mirror');
    const initialClones = clones;
    const initialAdvertisements = advertisements;
    assert.ok(initialClones > 0);

    const repeated = await inspectRepositoryOnboarding(fixture.remote, options);
    assert.equal(repeated.planId, first.planId);
    assert.equal(clones, initialClones, 'unchanged metadata must not be cloned again');
    assert.ok(advertisements > initialAdvertisements, 'every preview checks live Git refs');

    const cacheDirectory = path.join(fixture.base, 'local',
      'repository-onboarding-classification-v1');
    const [cacheName] = await readdir(cacheDirectory);
    const cacheFile = path.join(cacheDirectory, cacheName);
    const cacheBytes = await readFile(cacheFile, 'utf8');
    assert.equal(cacheBytes.includes(fixture.remote), false,
      'the cache identifies the credential-free repository by fingerprint');
    await assert.rejects(
      inspectRepositoryOnboarding('https://cache-user:cache-secret@internal.invalid/team/app.git', options),
      /credential|user.?info|secret|token/iu
    );
    assert.equal((await readFile(cacheFile, 'utf8')).includes('cache-secret'), false,
      'a credentialed locator is refused before cache lookup or writing');

    await writeFile(cacheFile, '{ interrupted cache write');
    const beforeCorruptCache = clones;
    await inspectRepositoryOnboarding(fixture.remote, options);
    assert.ok(clones > beforeCorruptCache, 'malformed cache data falls back to live inspection');
    if (process.platform !== 'win32') {
      const symlinkTarget = path.join(fixture.base, 'unrelated-local-file');
      await writeFile(symlinkTarget, 'preserve this file');
      await rm(cacheFile);
      await symlink(symlinkTarget, cacheFile);
      const beforeSymlink = clones;
      await inspectRepositoryOnboarding(fixture.remote, options);
      assert.ok(clones > beforeSymlink, 'a cache-file symlink is never trusted');
      assert.equal(await readFile(symlinkTarget, 'utf8'), 'preserve this file');

      const unrelatedDirectory = path.join(fixture.base, 'unrelated-local-directory');
      await mkdir(unrelatedDirectory);
      await rm(cacheDirectory, { recursive: true });
      await symlink(unrelatedDirectory, cacheDirectory);
      const beforeDirectorySymlink = clones;
      await inspectRepositoryOnboarding(fixture.remote, options);
      assert.ok(clones > beforeDirectorySymlink,
        'a cache-directory symlink also falls back to live inspection');
      assert.deepEqual(await readdir(unrelatedDirectory), [],
        'the symlink target is never used as cache storage');
      await rm(cacheDirectory);
    }

    const beforeRefresh = clones;
    await inspectRepositoryOnboarding(fixture.remote, { ...options, refresh: true });
    assert.ok(clones > beforeRefresh, 'explicit refresh bypasses the classifier cache');
    const afterRefresh = clones;

    await inspectRepositoryOnboarding(fixture.remote, {
      ...options, classificationCacheBuildIdentity: `source:${'b'.repeat(64)}`
    });
    assert.ok(clones > afterRefresh, 'a new executable build revalidates unchanged refs');
    const afterNewBuild = clones;

    await assert.rejects(applyRepositoryOnboarding(fixture.remote, {
      ...options, confirmPlan: `sha256:${'0'.repeat(64)}`
    }), (error) => error.code === 'REPOSITORY_ONBOARDING_CONFIRMATION_MISMATCH');
    assert.ok(clones > afterNewBuild, 'apply deeply revalidates before checking the plan ID');
    const beforeMove = clones;

    const editor = path.join(fixture.base, 'advance-configuration');
    run('git', ['clone', '-q', '--branch', CONFIGURATION_BRANCH, fixture.remote, editor], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Onboarding Tester'], { cwd: editor });
    run('git', ['config', 'user.email', 'onboarding@example.test'], { cwd: editor });
    run('git', ['commit', '--allow-empty', '-qm', 'Advance configuration ref'], { cwd: editor });
    run('git', ['push', '-q', 'origin', `HEAD:${CONFIGURATION_BRANCH}`], { cwd: editor });
    const advanced = await inspectRepositoryOnboarding(fixture.remote, options);
    assert.notEqual(advanced.configuration.commit, first.configuration.commit);
    assert.ok(clones > beforeMove, 'a changed configuration ref invalidates the cache');
    const beforeStateMove = clones;

    const stateEditor = path.join(fixture.base, 'advance-state');
    run('git', ['clone', '-q', '--branch', 'state', fixture.remote, stateEditor], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Onboarding Tester'], { cwd: stateEditor });
    run('git', ['config', 'user.email', 'onboarding@example.test'], { cwd: stateEditor });
    run('git', ['commit', '--allow-empty', '-qm', 'Advance state ref'], { cwd: stateEditor });
    run('git', ['push', '-q', 'origin', 'HEAD:state'], { cwd: stateEditor });
    const stateAdvanced = await inspectRepositoryOnboarding(fixture.remote, options);
    assert.notEqual(stateAdvanced.state.commit, advanced.state.commit);
    assert.ok(clones > beforeStateMove, 'a changed state ref invalidates the cache');
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('invalid state classification is never reused from the onboarding preview cache', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    await publishStateFiles(fixture, { 'unrelated.json': '{"not":"sflow"}\n' });
    const env = {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(fixture.base, 'local', 'workspaces.json')
    };
    let clones = 0;
    const runRemoteCommand = async (args, options) => {
      if (args.includes('clone')) clones += 1;
      return runRemoteGitAsync(args, options);
    };
    const options = {
      env, runRemoteCommand, classificationCacheBuildIdentity: `source:${'a'.repeat(64)}`
    };
    const first = await inspectRepositoryOnboarding(fixture.remote, options);
    assert.equal(first.state.kind, 'invalid');
    const firstClones = clones;
    const second = await inspectRepositoryOnboarding(fixture.remote, options);
    assert.equal(second.state.kind, 'invalid');
    assert.ok(clones > firstClones, 'an invalid classifier result must be checked again');
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('an ordinary state branch is never treated as SFlow setup proof', async () => {
  const fixture = await repositoryFixture();
  try {
    await publishStateFiles(fixture, { 'application-state.json': '{"ownedBy":"application"}\n' });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.kind, 'repository-onboarding-plan/v1');
    assert.equal(plan.state.kind, 'invalid');
    assert.equal(plan.status, 'state-branch-not-recognized');
    assert.equal(plan.primaryAction, 'choose-another-state-branch');
    assert.equal(plan.canApply, false);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('state mirror paths cannot inject sparse patterns or materialize undeclared files', async () => {
  const fixture = await repositoryFixture();
  try {
    const sourceCommit = run('git', ['rev-parse', 'refs/heads/main'], {
      cwd: fixture.remote
    }).stdout.trim();
    const injected = 'singularity/x\n/*';
    const digest = '0'.repeat(64);
    const object = '0'.repeat(sourceCommit.length);
    await publishStateFiles(fixture, {
      [STATE_CONFIGURATION_MANIFEST]: `${JSON.stringify({
        format: STATE_CONFIGURATION_FORMAT,
        layout: 'canonical-paths',
        source: { branch: CONFIGURATION_BRANCH, commit: sourceCommit },
        files: { [injected]: digest },
        assets: { [injected]: { sha256: digest, object, mode: '100644' } }
      })}\n`,
      'undeclared/large.bin': 'must-not-be-treated-as-configuration\n'
    });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.state.kind, 'invalid');
    assert.equal(plan.state.code, 'STATE_CONFIGURATION_MIRROR_LIMIT_EXCEEDED');
    assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 1);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('valid lifecycle-only state recognizes SFlow without inferring capability ownership', async () => {
  const fixture = await repositoryFixture();
  try {
    await publishStateFiles(fixture, {
      'ledger/head.json': `${JSON.stringify({
        schemaVersion: currentSchemaVersion('ledger-entry'),
        sequence: 0, entryHash: null, previousHeadHash: null,
        updatedAt: '2026-01-01T00:00:00.000Z'
      })}\n`
    });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.state.kind, 'lifecycle-only');
    assert.equal(plan.status, 'sflow-repository-capability-not-mapped');
    assert.equal(plan.primaryAction, 'map-capability');
    assert.equal(plan.configuration.status, 'missing');
    const stateBefore = plan.state.commit;
    const recreate = await inspectRepositoryOnboarding(fixture.remote, { mode: 'recreate' });
    assert.equal(recreate.canApply, false);
    await assert.rejects(applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: recreate.planId
    }), { code: 'REPOSITORY_ONBOARDING_ACTION_UNAVAILABLE' });
    assert.equal(run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim(), stateBefore);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('current configuration rebuilds its projection without deleting lifecycle state', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const head = `${JSON.stringify({
      schemaVersion: currentSchemaVersion('ledger-entry'),
      sequence: 0, entryHash: null, previousHeadHash: null,
      updatedAt: '2026-01-01T00:00:00.000Z'
    })}\n`;
    await publishStateFiles(fixture, { 'ledger/head.json': head });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.status, 'ready');
    assert.deepEqual(plan.effects, [
      { kind: 'state-projection', target: 'state', action: 'refresh' },
      { kind: 'local-registration', target: fixture.remote, action: 'remember' }
    ]);
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'ready');
    assert.equal(run('git', ['show', 'state:ledger/head.json'], {
      cwd: fixture.remote
    }).stdout, head);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', 'refs/heads/state'
    ], { cwd: fixture.remote, allowFailure: true }).status, 0);
    assert.doesNotThrow(() => JSON.parse(run('git', [
      'show', `state:${STATE_CONFIGURATION_MANIFEST}`
    ], { cwd: fixture.remote }).stdout));
    assert.deepEqual((await listLeadRepositories()).map((entry) => entry.url), [fixture.remote]);

    const stateBeforeRegistrationOnly = run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim();
    process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'fresh-leads.json');
    const registrationPlan = await inspectRepositoryOnboarding(fixture.remote);
    assert.deepEqual(registrationPlan.effects, [{
      kind: 'local-registration', target: fixture.remote, action: 'remember'
    }]);
    const registrationResult = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: registrationPlan.planId
    });
    assert.equal(registrationResult.changed, true);
    assert.equal(run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim(), stateBeforeRegistrationOnly);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a failed state projection preserves configuration and returns an exact projection-only retry', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const configurationCommit = run('git', [
      'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote }).stdout.trim();
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.configuration.commit, configurationCommit);
    assert.ok(plan.effects.some((effect) =>
      effect.kind === 'state-projection' && effect.action === 'refresh'));
    const hook = path.join(fixture.remote, 'hooks', 'pre-receive');
    await writeFile(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/state" ]; then
    echo "state projection temporarily unavailable" >&2
    exit 1
  fi
done
exit 0
`);
    await chmod(hook, 0o755);

    let configurationPushes = 0;
    const observingRemoteCommand = async (args, options) => {
      if (args[0] === 'push'
          && args.some((argument) => argument.endsWith(':refs/heads/sflow/config'))) {
        configurationPushes += 1;
      }
      return runRemoteGitAsync(args, options);
    };
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId, runRemoteCommand: observingRemoteCommand
    });
    const retry = {
      shell: renderPlatformCommand([
        'singularity-flow', 'capability', 'onboard', fixture.remote, '--dry-run', '--json'
      ]),
      copilot: '/sf-capability-map'
    };
    assert.equal(result.status, 'ready-state-refresh-pending');
    assert.equal(result.primaryAction, 'retry');
    assert.equal(result.changed, true);
    assert.equal(result.stateRefresh.pending, true);
    assert.deepEqual(result.stateRefresh.retry, retry);
    assert.deepEqual(result.nextActions, retry);
    assert.equal(configurationPushes, 0);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', 'refs/heads/state'
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);

    const recoveryPlan = await inspectRepositoryOnboarding(fixture.remote, {
      runRemoteCommand: observingRemoteCommand
    });
    assert.equal(recoveryPlan.status, 'ready');
    assert.equal(recoveryPlan.configuration.commit, configurationCommit);
    assert.deepEqual(recoveryPlan.effects, [{
      kind: 'state-projection', target: 'state', action: 'refresh'
    }]);

    await rm(hook);
    const recovered = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: recoveryPlan.planId, runRemoteCommand: observingRemoteCommand
    });
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.stateRefresh.pending, false);
    assert.equal(configurationPushes, 0,
      'retrying the projection must not repeat the configuration mutation');
    assert.equal(run('git', [
      'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote }).stdout.trim(), configurationCommit);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a state branch with mirror and locator markers is refused without writes', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    await publishStateMirror(fixture);
    const editor = path.join(fixture.base, 'conflict-editor');
    run('git', ['clone', '-q', '--no-hardlinks', '--branch', 'state', fixture.remote, editor], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Conflict Editor'], { cwd: editor });
    run('git', ['config', 'user.email', 'conflict@example.test'], { cwd: editor });
    const link = createCapabilityAuthorityLink({
      authorityRemote: fixture.remote,
      repositoryRemote: fixture.remote,
      capabilityIds: ['payments']
    });
    const target = path.join(editor, 'singularity', 'capability-authority.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(link, null, 2)}\n`);
    run('git', ['add', '-A'], { cwd: editor });
    run('git', ['commit', '-qm', 'Add conflicting locator marker'], { cwd: editor });
    run('git', ['push', '-q', 'origin', 'state'], { cwd: editor });
    const stateBefore = run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim();
    const configBefore = run('git', ['rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: fixture.remote
    }).stdout.trim();
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.state.kind, 'invalid');
    assert.equal(plan.state.code, 'REPOSITORY_STATE_MARKER_CONFLICT');
    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.availableModes, ['reset-local']);
    await assert.rejects(applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    }), { code: 'REPOSITORY_ONBOARDING_ACTION_UNAVAILABLE' });
    assert.equal(run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim(), stateBefore);
    assert.equal(run('git', ['rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: fixture.remote
    }).stdout.trim(), configBefore);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a copied foreign state mirror cannot configure another repository', async () => {
  const source = await repositoryFixture('source-authority');
  const target = await repositoryFixture('target-application');
  try {
    await ensureConfigurationBranch(source.remote, { capability });
    await publishStateMirror(source);
    run('git', [
      'fetch', '--quiet', source.remote, 'refs/heads/state:refs/heads/state'
    ], { cwd: target.remote });
    const stateBefore = run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: target.remote
    }).stdout.trim();
    for (const mode of ['auto', 'migrate', 'recreate']) {
      const plan = await inspectRepositoryOnboarding(target.remote, { mode });
      assert.equal(plan.state.kind, 'invalid');
      assert.equal(plan.state.code, 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH');
      assert.equal(plan.canApply, false);
      await assert.rejects(applyRepositoryOnboarding(target.remote, {
        mode, confirmPlan: plan.planId
      }), { code: 'REPOSITORY_ONBOARDING_ACTION_UNAVAILABLE' });
    }
    assert.equal(run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: target.remote
    }).stdout.trim(), stateBefore);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: target.remote, allowFailure: true }).status, 1);
  } finally {
    await rm(source.base, { recursive: true, force: true });
    await rm(target.base, { recursive: true, force: true });
  }
});

test('a verified delivery locator takes precedence over conflicting local configuration', async () => {
  const lead = await repositoryFixture('lead');
  const delivery = await repositoryFixture('delivery');
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(delivery.base, 'leads.json');
  try {
    await ensureConfigurationBranch(lead.remote);
    const mapped = await mapCapability(lead.remote, {
      capabilityId: 'payments', name: 'Payments', kind: 'delivery',
      repositoryUrl: delivery.remote, initiatingRoot: lead.source
    });
    run('git', ['update-ref', `refs/heads/${CONFIGURATION_BRANCH}`, mapped.commit], {
      cwd: lead.remote
    });
    await ensureConfigurationBranch(delivery.remote);
    const configurationBefore = run('git', [
      'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: delivery.remote }).stdout.trim();
    const link = createCapabilityAuthorityLink({
      authorityRemote: lead.remote,
      repositoryRemote: delivery.remote,
      capabilityIds: ['payments']
    });
    await publishStateFiles(delivery, {
      'singularity/capability-authority.json': `${JSON.stringify(link, null, 2)}\n`
    });
    const plan = await inspectRepositoryOnboarding(delivery.remote);
    assert.equal(plan.state.kind, 'delivery-locator');
    assert.equal(plan.status, 'linked-to-team-configuration');
    assert.equal(plan.routing.leadUrl, lead.remote);
    assert.equal(plan.routing.verified, true);
    assert.deepEqual(plan.routing.capabilityIds, ['payments']);
    assert.deepEqual(plan.effects, [{
      kind: 'local-registration', target: lead.remote, action: 'remember'
    }]);
    const linked = await applyRepositoryOnboarding(delivery.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(linked.status, 'linked-to-team-configuration');
    assert.deepEqual((await listLeadRepositories()).map((entry) => entry.url), [lead.remote]);
    assert.equal(run('git', ['rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: delivery.remote
    }).stdout.trim(), configurationBefore);

    const stateBefore = plan.state.commit;
    const recreate = await inspectRepositoryOnboarding(delivery.remote, { mode: 'recreate' });
    assert.equal(recreate.canApply, false);
    assert.equal(recreate.status, 'linked-to-team-configuration');
    await assert.rejects(applyRepositoryOnboarding(delivery.remote, {
      mode: 'recreate', confirmPlan: recreate.planId
    }), { code: 'REPOSITORY_ONBOARDING_ACTION_UNAVAILABLE' });
    assert.equal(run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: delivery.remote
    }).stdout.trim(), stateBefore);
    assert.equal(run('git', ['rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: delivery.remote
    }).stdout.trim(), configurationBefore);
    const migrate = await inspectRepositoryOnboarding(delivery.remote, { mode: 'migrate' });
    assert.equal(migrate.canApply, false);
    await assert.rejects(applyRepositoryOnboarding(delivery.remote, {
      mode: 'migrate', confirmPlan: migrate.planId
    }), { code: 'REPOSITORY_ONBOARDING_ACTION_UNAVAILABLE' });
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(lead.base, { recursive: true, force: true });
    await rm(delivery.base, { recursive: true, force: true });
  }
});

test('delivery locator previews reuse exact-ref lead cache and revalidate moved refs', async () => {
  const lead = await repositoryFixture('preview-lead');
  const delivery = await repositoryFixture('preview-delivery');
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  const previousCache = process.env.SINGULARITY_FLOW_ORGANISATION_CACHE;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(delivery.base, 'leads.json');
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(delivery.base, 'organisation-cache');
  try {
    await ensureConfigurationBranch(lead.remote);
    const unmappedCommit = run('git', ['rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: lead.remote
    }).stdout.trim();
    const mapped = await mapCapability(lead.remote, {
      capabilityId: 'payments', name: 'Payments', kind: 'delivery',
      repositoryUrl: delivery.remote, initiatingRoot: lead.source
    });
    run('git', ['update-ref', `refs/heads/${CONFIGURATION_BRANCH}`, mapped.commit], {
      cwd: lead.remote
    });
    await publishStateMirror(lead);
    const link = createCapabilityAuthorityLink({
      authorityRemote: lead.remote, repositoryRemote: delivery.remote,
      capabilityIds: ['payments']
    });
    await publishStateFiles(delivery, {
      'singularity/capability-authority.json': `${JSON.stringify(link, null, 2)}\n`
    });
    await rm(organisationCacheFile(lead.remote), { force: true });

    let deliveryClones = 0;
    const options = {
      env: {
        ...process.env,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(delivery.base, 'local', 'workspaces.json')
      },
      runRemoteCommand: async (args, remoteOptions) => {
        if (args.includes('clone')) deliveryClones += 1;
        return runRemoteGitAsync(args, remoteOptions);
      },
      classificationCacheBuildIdentity: `source:${'a'.repeat(64)}`
    };
    const inspectTimed = async (extra = {}) => {
      const timer = commandTimer('delivery-locator-preview');
      const beforeDeliveryClones = deliveryClones;
      const plan = await withCommandTiming(timer,
        () => inspectRepositoryOnboarding(delivery.remote, { ...options, ...extra }));
      return {
        plan, counters: timer.finish().counters,
        deliveryClones: deliveryClones - beforeDeliveryClones
      };
    };
    const remoteCount = (counters, verb) => counters[`git.remote.command.${verb}`] ?? 0;

    const first = await inspectTimed();
    assert.equal(first.plan.routing.verified, true);
    assert.ok(remoteCount(first.counters, 'clone') > 0);
    const repeated = await inspectTimed();
    assert.equal(repeated.plan.planId, first.plan.planId);
    assert.equal(remoteCount(repeated.counters, 'clone'), 0,
      'unchanged delivery and lead refs should reuse both validated snapshots');
    assert.equal(remoteCount(repeated.counters, 'fetch'), 0);
    assert.ok(remoteCount(repeated.counters, 'ls-remote') >= 2,
      'both repositories are still checked against live remote refs');

    await ensureConfigurationBranch(delivery.remote);
    const localConfigurationAppeared = await inspectTimed();
    assert.equal(localConfigurationAppeared.plan.routing.verified, true);
    assert.ok(remoteCount(localConfigurationAppeared.counters, 'clone') > 0,
      'a newly created delivery configuration ref invalidates the null-ref cache key');
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: delivery.remote
    });
    const localConfigurationRemoved = await inspectTimed();
    assert.equal(localConfigurationRemoved.plan.routing.verified, true);
    assert.ok(remoteCount(localConfigurationRemoved.counters, 'clone') > 0,
      'removing the delivery configuration ref also invalidates the cache key');

    const refreshed = await inspectTimed({ refresh: true });
    assert.equal(refreshed.plan.routing.verified, true);
    assert.ok(remoteCount(refreshed.counters, 'clone') > refreshed.deliveryClones,
      'explicit refresh must re-read the lead authority');

    const applyTimer = commandTimer('delivery-locator-apply');
    const beforeApplyDeliveryClones = deliveryClones;
    await assert.rejects(withCommandTiming(applyTimer, () => applyRepositoryOnboarding(
      delivery.remote, { ...options, confirmPlan: `sha256:${'0'.repeat(64)}` }
    )), { code: 'REPOSITORY_ONBOARDING_CONFIRMATION_MISMATCH' });
    assert.ok(remoteCount(applyTimer.finish().counters, 'clone')
      > deliveryClones - beforeApplyDeliveryClones,
      'apply must deep-revalidate before comparing the confirmed plan');

    run('git', ['update-ref', `refs/heads/${CONFIGURATION_BRANCH}`, unmappedCommit], {
      cwd: lead.remote
    });
    const unmapped = await inspectTimed();
    assert.equal(unmapped.plan.routing.verified, false);
    assert.equal(unmapped.plan.canApply, false);
    assert.ok(remoteCount(unmapped.counters, 'clone') > unmapped.deliveryClones,
      'a moved lead configuration ref invalidates the warm cache');

    run('git', ['update-ref', `refs/heads/${CONFIGURATION_BRANCH}`, mapped.commit], {
      cwd: lead.remote
    });
    const restored = await inspectTimed();
    assert.equal(restored.plan.routing.verified, true);
    const stateEditor = path.join(lead.base, 'advance-lead-state');
    run('git', ['clone', '-q', '--branch', 'state', lead.remote, stateEditor], {
      cwd: lead.base
    });
    run('git', ['config', 'user.name', 'Onboarding Tester'], { cwd: stateEditor });
    run('git', ['config', 'user.email', 'onboarding@example.test'], { cwd: stateEditor });
    run('git', ['commit', '--allow-empty', '-qm', 'Advance lead state receipt'], {
      cwd: stateEditor
    });
    run('git', ['push', '-q', 'origin', 'HEAD:state'], { cwd: stateEditor });
    const advancedState = await inspectTimed();
    assert.equal(advancedState.plan.routing.verified, true);
    assert.ok(remoteCount(advancedState.counters, 'clone') > advancedState.deliveryClones,
      'a moved lead state ref must revalidate before the mapping stays trusted');

    const wrongLink = createCapabilityAuthorityLink({
      authorityRemote: lead.remote, repositoryRemote: delivery.remote,
      capabilityIds: ['wrong-capability']
    });
    const deliveryEditor = path.join(delivery.base, 'advance-delivery-state');
    run('git', ['clone', '-q', '--branch', 'state', delivery.remote, deliveryEditor], {
      cwd: delivery.base
    });
    run('git', ['config', 'user.name', 'Onboarding Tester'], { cwd: deliveryEditor });
    run('git', ['config', 'user.email', 'onboarding@example.test'], { cwd: deliveryEditor });
    await writeFile(path.join(deliveryEditor, 'singularity', 'capability-authority.json'),
      `${JSON.stringify(wrongLink, null, 2)}\n`);
    run('git', ['add', '-A'], { cwd: deliveryEditor });
    run('git', ['commit', '-qm', 'Move locator to an unapproved capability'], {
      cwd: deliveryEditor
    });
    run('git', ['push', '-q', 'origin', 'HEAD:state'], { cwd: deliveryEditor });
    const changedLocator = await inspectTimed();
    assert.notEqual(changedLocator.plan.state.commit, advancedState.plan.state.commit);
    assert.equal(changedLocator.plan.routing.verified, false);
    assert.equal(changedLocator.plan.canApply, false);
    assert.ok(changedLocator.deliveryClones > 0,
      'a moved delivery state ref invalidates its classified snapshot');
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    if (previousCache == null) delete process.env.SINGULARITY_FLOW_ORGANISATION_CACHE;
    else process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = previousCache;
    await rm(lead.base, { recursive: true, force: true });
    await rm(delivery.base, { recursive: true, force: true });
  }
});

test('a delivery locator remains schema-safe while its lead is recoverable only from state', async () => {
  const lead = await repositoryFixture('recoverable-lead');
  const delivery = await repositoryFixture('recoverable-delivery');
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(delivery.base, 'leads.json');
  try {
    await ensureConfigurationBranch(lead.remote);
    const mapped = await mapCapability(lead.remote, {
      capabilityId: 'payments', name: 'Payments', kind: 'delivery',
      repositoryUrl: delivery.remote, initiatingRoot: lead.source
    });
    run('git', ['update-ref', `refs/heads/${CONFIGURATION_BRANCH}`, mapped.commit], {
      cwd: lead.remote
    });
    await publishStateMirror(lead);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: lead.remote });

    const link = createCapabilityAuthorityLink({
      authorityRemote: lead.remote,
      repositoryRemote: delivery.remote,
      capabilityIds: ['payments']
    });
    await publishStateFiles(delivery, {
      'singularity/capability-authority.json': `${JSON.stringify(link, null, 2)}\n`
    });

    const plan = await inspectRepositoryOnboarding(delivery.remote);
    assert.equal(plan.status, 'linked-to-team-configuration');
    assert.equal(plan.routing.verified, true);
    assert.equal(Object.hasOwn(plan.routing, 'configurationCommit'), false,
      'an unavailable approved ref must be omitted instead of emitted as schema-invalid null');
    const result = await applyRepositoryOnboarding(delivery.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'linked-to-team-configuration');
    assert.equal(Object.hasOwn(result.routing, 'configurationCommit'), false);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(lead.base, { recursive: true, force: true });
    await rm(delivery.base, { recursive: true, force: true });
  }
});

test('a full state mirror restores missing configuration through an exact confirmed plan', async () => {
  const fixture = await repositoryFixture();
  const registry = path.join(fixture.base, 'leads.json');
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry;
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const mirror = await publishStateMirror(fixture);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: fixture.remote
    });

    const organisation = await readOrganisation(fixture.remote, { refresh: true });
    assert.equal(organisation.governed, true,
      'ordinary capability discovery consumes the verified recovery mirror');
    assert.equal(organisation.recoveryAvailable, true);
    assert.equal(organisation.recoverySourceCommit, mirror.sourceCommit);

    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.state.kind, 'configuration-mirror');
    assert.equal(plan.configuration.status, 'missing');
    assert.equal(plan.status, 'ready-to-restore');
    assert.equal(plan.primaryAction, 'restore-and-continue');
    assert.match(plan.planId, /^sha256:[0-9a-f]{64}$/);

    const applied = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(applied.changed, true);
    assert.equal(applied.status, 'configuration-review-required');
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
    const recoveryBytes = run('git', [
      'show', `${applied.proposal.branch}:singularity/.product/configuration-recovery.json`
    ], { cwd: fixture.remote }).stdout;
    assert.equal(familyForStoredPath(
      'singularity/.product/configuration-recovery.json'
    )?.id, 'repository-configuration-recovery');
    const recovery = readRecord('repository-configuration-recovery', recoveryBytes);
    assert.equal(recovery.record.kind, 'repository-configuration-recovery');
    assert.equal(recovery.record.planId, plan.planId);
    assert.equal(run('git', [
      'show', `${applied.proposal.branch}:singularity/capabilities.yml`
    ], { cwd: fixture.remote }).status, 0);

    // The reviewed activation is deliberately external to onboarding. Resume from a fresh plan
    // only after that exact proposal becomes approved configuration.
    run('git', ['update-ref', `refs/heads/${CONFIGURATION_BRANCH}`,
      applied.proposal.commit], { cwd: fixture.remote });

    const repeated = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(repeated.status, 'ready');
    const resumed = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: repeated.planId
    });
    assert.equal(resumed.status, 'ready');
    const finalPlan = await inspectRepositoryOnboarding(fixture.remote);
    const noOp = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: finalPlan.planId
    });
    assert.equal(noOp.changed, false);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('restore prefers the immutable retained configuration history commit', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const mirror = await publishStateMirror(fixture, { retainHistory: true });
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: fixture.remote
    });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(result.proposal.commit, mirror.sourceCommit,
      'the retained immutable commit is the exact review candidate');
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('mirror reconstruction preserves a disabled state-publication policy', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const editor = path.join(fixture.base, 'policy-editor');
    run('git', [
      'clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH, fixture.remote, editor
    ], { cwd: fixture.base });
    run('git', ['config', 'user.name', 'Policy Editor'], { cwd: editor });
    run('git', ['config', 'user.email', 'policy@example.test'], { cwd: editor });
    const workflowFile = path.join(editor, 'singularity', 'workflow.yml');
    const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
    workflow.ledger.enabled = false;
    await writeFile(workflowFile, YAML.stringify(workflow));
    run('git', ['add', 'singularity/workflow.yml'], { cwd: editor });
    run('git', ['commit', '-qm', 'Disable state publication'], { cwd: editor });
    run('git', ['push', '-q', 'origin', `${CONFIGURATION_BRANCH}:${CONFIGURATION_BRANCH}`], {
      cwd: editor
    });
    await publishStateMirror(fixture);
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: fixture.remote
    });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.state.stateProjectionEnabled, false);
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.notEqual(result.proposal.commit, plan.state.sourceCommit,
      'reconstruction creates a distinct reviewed candidate');
    const restored = YAML.parse(run('git', [
      'show', `${result.proposal.branch}:singularity/workflow.yml`
    ], { cwd: fixture.remote }).stdout);
    assert.equal(restored.ledger.enabled, false);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a legacy unbound mirror is recoverable only when retained history proves this repository', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const mirror = await publishStateMirror(fixture, {
      retainHistory: true, subjectBound: false
    });
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: fixture.remote
    });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.state.subjectBound, false);
    assert.equal(plan.state.repositoryBound, true);
    assert.equal(plan.state.legacyBinding.method, 'retained-history-and-portfolio');
    assert.equal(plan.status, 'ready-to-restore');
    assert.ok(!plan.availableModes.includes('migrate'));
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(result.proposal.commit, mirror.sourceCommit);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('current configuration rebinds an unbound legacy state mirror', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    await publishStateMirror(fixture, { subjectBound: false, retainHistory: false });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.configuration.status, 'current');
    assert.equal(plan.state.kind, 'configuration-mirror');
    assert.equal(plan.state.repositoryBound, false);
    assert.ok(plan.effects.some((effect) => effect.kind === 'state-projection'));
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'ready');
    const manifest = JSON.parse(run('git', [
      'show', `state:${STATE_CONFIGURATION_MANIFEST}`
    ], { cwd: fixture.remote }).stdout);
    assert.match(manifest.subject.repositoryIdentity, /^sha256:[0-9a-f]{64}$/u);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('restore rejects retained history whose assets do not equal the verified mirror', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    await publishStateMirror(fixture, { retainHistory: true });
    const editor = path.join(fixture.base, 'mirror-editor');
    run('git', ['clone', '-q', '--no-hardlinks', '--branch', 'state', fixture.remote, editor], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Mirror Editor'], { cwd: editor });
    run('git', ['config', 'user.email', 'mirror@example.test'], { cwd: editor });
    const relative = 'singularity/capabilities.yml';
    await writeFile(path.join(editor, relative),
      `${await readFile(path.join(editor, relative), 'utf8')}\n# state-only retained bytes\n`);
    const manifestFile = path.join(editor, STATE_CONFIGURATION_MANIFEST);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const bytes = await readFile(path.join(editor, relative));
    manifest.files[relative] = createHash('sha256').update(bytes).digest('hex');
    manifest.assets[relative] = {
      ...manifest.assets[relative], sha256: manifest.files[relative],
      object: run('git', ['hash-object', '-w', relative], { cwd: editor }).stdout.trim()
    };
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    run('git', ['add', '-A'], { cwd: editor });
    run('git', ['commit', '-qm', 'Publish mirror bytes that differ from history'], { cwd: editor });
    run('git', ['push', '-q', 'origin', 'state'], { cwd: editor });
    run('git', ['update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: fixture.remote
    });

    const plan = await inspectRepositoryOnboarding(fixture.remote);
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.notEqual(result.proposal.commit, plan.state.sourceCommit);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('recreate previews exact omissions and never follows a portable-data symlink', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const editor = path.join(fixture.base, 'configuration-editor');
    run('git', ['clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH, fixture.remote, editor], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Configuration Editor'], { cwd: editor });
    run('git', ['config', 'user.email', 'configuration@example.test'], { cwd: editor });
    const secret = path.join(fixture.base, 'host-secret.yml');
    await writeFile(secret, 'capabilities:\n  stolen:\n    name: HOST SECRET MUST NOT PUBLISH\n');
    await rm(path.join(editor, 'singularity', 'capabilities.yml'));
    await symlink(secret, path.join(editor, 'singularity', 'capabilities.yml'));
    await writeFile(path.join(editor, 'singularity', 'custom-onboarding.yml'), 'custom: true\n');
    run('git', ['add', '-A'], { cwd: editor });
    run('git', ['commit', '-qm', 'Add custom path and malicious portable symlink'], { cwd: editor });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: editor });

    const plan = await inspectRepositoryOnboarding(fixture.remote, { mode: 'recreate' });
    assert.equal(plan.canApply, true);
    assert.ok(plan.omitted.includes('singularity/custom-onboarding.yml'));
    assert.ok(plan.omitted.includes('singularity/capabilities.yml'));
    const result = await applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: plan.planId
    });
    const proposed = run('git', [
      'show', `${result.proposal.branch}:singularity/capabilities.yml`
    ], { cwd: fixture.remote, allowFailure: true });
    assert.ok(proposed.status !== 0
      || !/HOST SECRET MUST NOT PUBLISH/.test(proposed.stdout));
    assert.deepEqual(result.omitted, plan.omitted);
    const repeatedPlan = await inspectRepositoryOnboarding(fixture.remote, { mode: 'recreate' });
    const repeated = await applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: repeatedPlan.planId
    });
    assert.equal(repeated.proposal.existing, true);
    assert.equal(repeated.changed, false);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a selected alternate state branch never mutates an unrelated default state branch', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await publishStateFiles(fixture, { 'application-state.json': '{"ownedBy":"application"}\n' });
    const defaultState = run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim();
    const plan = await inspectRepositoryOnboarding(fixture.remote, {
      stateBranch: 'sflow-state'
    });
    assert.equal(plan.status, 'not-set-up');
    const result = await applyRepositoryOnboarding(fixture.remote, {
      stateBranch: 'sflow-state', confirmPlan: plan.planId
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim(), defaultState);
    assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/sflow-state'], {
      cwd: fixture.remote, allowFailure: true
    }).status, 1);
    assert.match(run('git', [
      'show', `${result.proposal.branch}:singularity/workflow.yml`
    ], { cwd: fixture.remote }).stdout, /branch: sflow-state/);
    assert.equal(run('git', [
      'for-each-ref', '--format=%(refname)', 'refs/heads/sflow/config-history/'
    ], { cwd: fixture.remote }).stdout.trim(), '',
    'onboarding projection performs no hidden configuration-history ref write');
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('an existing clone resolves its one configured origin before inspection', async () => {
  const fixture = await repositoryFixture();
  try {
    const clone = path.join(fixture.base, 'office-laptop-clone');
    run('git', ['clone', '-q', '--no-hardlinks', fixture.remote, clone], { cwd: fixture.base });
    const plan = await inspectRepositoryOnboarding(clone);
    assert.equal(plan.repository.url, fixture.remote);
    assert.equal(plan.status, 'not-set-up');
    assert.match(plan.nextActions.shell, /office-laptop-clone/u);
    const result = await applyRepositoryOnboarding(clone, { confirmPlan: plan.planId });
    assert.equal(result.status, 'configuration-review-required',
      'the exact local-clone preview remains valid when its returned plan is applied');
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a relative local repository locator is frozen before temporary Git work begins', async () => {
  const fixture = await repositoryFixture("relative-owner's-local");
  const relative = path.relative(process.cwd(), fixture.remote);
  try {
    assert.equal(path.isAbsolute(relative), false);
    const plan = await inspectRepositoryOnboarding(relative);
    assert.equal(plan.repository.url, fixture.remote);
    assert.equal(plan.repository.inputIdentity,
      `sha256:${createHash('sha256').update(fixture.remote).digest('hex')}`);
    assert.equal(plan.nextActions.shell, renderPlatformCommand([
      'singularity-flow', 'capability', 'onboard', fixture.remote,
      '--confirm-plan', plan.planId, '--json'
    ]));
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'configuration-review-required');
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a symlinked existing clone resolves the same origin with an exact-locator lease', async (t) => {
  const fixture = await repositoryFixture();
  const clone = path.join(fixture.base, 'application-clone');
  const linked = path.join(fixture.base, 'application-link');
  try {
    run('git', ['clone', '-q', '--no-hardlinks', fixture.remote, clone], { cwd: fixture.base });
    try {
      await symlink(clone, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('This Windows runner cannot create a junction.');
        return;
      }
      throw error;
    }
    const direct = await inspectRepositoryOnboarding(clone);
    const throughLink = await inspectRepositoryOnboarding(linked);
    assert.equal(throughLink.repository.url, direct.repository.url);
    assert.equal(throughLink.repository.identity, direct.repository.identity);
    assert.notEqual(throughLink.repository.inputIdentity, direct.repository.inputIdentity);
    assert.notEqual(throughLink.planId, direct.planId,
      'each local locator gets its own content-addressed confirmation lease');
    assert.match(throughLink.nextActions.shell, /application-link/u,
      'the returned apply command preserves the locator which produced the preview');
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a broken repository link is refused before Git inspection', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-broken-link-'));
  const linked = path.join(base, 'missing-repository');
  try {
    await symlink(path.join(base, 'does-not-exist'), linked,
      process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectRepositoryOnboarding(linked), {
      code: 'REPOSITORY_ONBOARDING_CLONE_LINK_INVALID'
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an oversized partial-clone fallback is deleted and refused before parsing', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    let inflated = false;
    const oversizedClone = async (args, options) => {
      const result = await runRemoteGitAsync(args, options);
      if (!inflated && result.status === 0 && args.includes('clone')) {
        const scratch = args.at(-1);
        const pack = path.join(scratch, '.git', 'objects', 'pack', 'ignored-filter.pack');
        await mkdir(path.dirname(pack), { recursive: true });
        await writeFile(pack, Buffer.alloc(1));
        await truncate(pack, 129 * 1024 * 1024);
        inflated = true;
      }
      return result;
    };
    await assert.rejects(inspectRepositoryOnboarding(fixture.remote, {
      runRemoteCommand: oversizedClone
    }), { code: 'REPOSITORY_ONBOARDING_SNAPSHOT_LIMIT_EXCEEDED' });
    assert.equal(inflated, true);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a two-stage filtered snapshot is surveyed then admitted without lazy fetch', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: fixture.remote });
    let cloneCount = 0;
    let observedAdmissionFilter = false;
    let movedRemote = false;
    const trace = path.join(fixture.base, 'sealed-snapshot-trace.json');
    const tracedGitEnv = enterpriseGitEnvironment(process.env);
    tracedGitEnv.GIT_TRACE2_EVENT = trace;
    const remoteSession = new GitRemoteSession({ env: tracedGitEnv });
    const inspectOfflineAfterClone = async (args, options) => {
      const result = await runRemoteGitAsync(args, options);
      if (!movedRemote && result.status === 0 && args.includes('clone')) {
        cloneCount += 1;
        if (cloneCount === 1) {
          assert.ok(args.includes('--filter=blob:none'),
            'the first clone must survey the tree without content blobs');
          return result;
        }
        const filter = args.find((arg) => arg.startsWith('--filter=blob:limit='));
        const limit = Number(filter?.split('=').at(-1));
        assert.ok(Number.isSafeInteger(limit) && limit > 1 && limit < 134217729,
          'the admitted per-blob limit must be derived from the surveyed file count');
        assert.deepEqual(args.slice(args.indexOf('--origin'), args.indexOf('--origin') + 2),
          ['--origin', 'sflow-snapshot'],
          'the disposable promisor transport must have one deterministic removable name');
        observedAdmissionFilter = true;
        await rename(fixture.remote, `${fixture.remote}.offline`);
        movedRemote = true;
      }
      return result;
    };

    const plan = await inspectRepositoryOnboarding(fixture.remote, {
      remoteSession, runRemoteCommand: inspectOfflineAfterClone
    });
    assert.equal(cloneCount, 2);
    assert.equal(observedAdmissionFilter, true);
    assert.equal(plan.configuration.status, 'current');
    const events = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    const commands = events.filter((event) => event.event === 'start')
      .map((event) => event.argv ?? []);
    const removedAt = commands.findLastIndex((argv) =>
      argv.includes('remote') && argv.includes('remove') && argv.includes('sflow-snapshot'));
    const legacyDetachedAt = commands.findLastIndex((argv) =>
      argv.includes('--unset-all') && argv.includes('extensions.partialClone'));
    const sizedAt = commands.findIndex((argv) => argv.includes('ls-tree') && argv.includes('--long'));
    assert.ok(removedAt >= 0 && legacyDetachedAt > removedAt && sizedAt > legacyDetachedAt,
      'all modern and legacy promisor discovery must be removed before tree sizing');
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('an uneven valid tree is admitted and object/worktree ceilings remain independent', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const editor = path.join(fixture.base, 'independent-quota-editor');
    run('git', [
      'clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH,
      fixture.remote, editor
    ], { cwd: fixture.base });
    run('git', ['config', 'user.name', 'Independent Quota'], { cwd: editor });
    run('git', ['config', 'user.email', 'independent-quota@example.test'], { cwd: editor });
    // One incompressible 65 MiB blob plus the ordinary small configuration files is below the
    // aggregate ceiling but above the first equal-share admission threshold. A bounded retry must
    // admit it after accounting for the known small blobs. Adding object-store and worktree bytes
    // together would also exceed 128 MiB even though each independent quota domain is valid.
    await writeFile(path.join(editor, 'admitted-large.bin'), randomBytes(65 * 1024 * 1024));
    run('git', ['add', 'admitted-large.bin'], { cwd: editor });
    run('git', ['commit', '-qm', 'Add independently admitted payload'], { cwd: editor });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: editor });
    run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: fixture.remote });

    const filters = [];
    const observeAdmissionRounds = async (args, options) => {
      const result = await runRemoteGitAsync(args, options);
      if (result.status === 0 && args.includes('clone')) {
        filters.push(args.find((arg) => arg.startsWith('--filter=')));
      }
      return result;
    };
    const plan = await inspectRepositoryOnboarding(fixture.remote, {
      runRemoteCommand: observeAdmissionRounds
    });
    assert.equal(plan.configuration.status, 'current');
    assert.equal(filters[0], '--filter=blob:none');
    const limits = filters.slice(1).map((filter) => Number(filter.split('=').at(-1)));
    assert.equal(limits.length, 2, 'the uneven tree must use one bounded admission retry');
    assert.ok(limits[0] < 65 * 1024 * 1024 && limits[1] > 65 * 1024 * 1024,
      'the retry must widen only after accounting for already-admitted small blobs');
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a valid multi-strata tree is refused when its next pass cannot prove the work bound',
  async () => {
    const fixture = await repositoryFixture();
    try {
      await ensureConfigurationBranch(fixture.remote, { capability });
      const editor = path.join(fixture.base, 'multi-strata-editor');
      run('git', [
        'clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH,
        fixture.remote, editor
      ], { cwd: fixture.base });
      run('git', ['config', 'user.name', 'Multi Strata'], { cwd: editor });
      run('git', ['config', 'user.email', 'multi-strata@example.test'], { cwd: editor });
      const payloadRoot = path.join(editor, 'multi-strata');
      await mkdir(payloadRoot, { recursive: true });
      for (const [name, mebibytes] of [['a', 45], ['b', 18], ['c', 35], ['d', 29]]) {
        const file = path.join(payloadRoot, `${name}.bin`);
        await writeFile(file, '');
        await truncate(file, mebibytes * 1024 * 1024);
      }
      run('git', ['add', 'multi-strata'], { cwd: editor });
      run('git', ['commit', '-qm', 'Add valid multi-strata payload'], { cwd: editor });
      run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: editor });
      run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: fixture.remote });
      const logicalBytes = run('git', ['ls-tree', '-r', '--long', 'HEAD'], {
        cwd: editor
      }).stdout.split(/\r?\n/u).filter(Boolean).reduce((total, line) => {
        const match = / ([0-9]+)\t/u.exec(line);
        return total + Number(match?.[1] ?? 0);
      }, 0);
      assert.ok(logicalBytes <= 128 * 1024 * 1024,
        'the fixture must remain aggregate-valid so the refusal tests work, not tree size');

      await assert.rejects(inspectRepositoryOnboarding(fixture.remote), {
        code: 'REPOSITORY_ONBOARDING_SNAPSHOT_WORK_LIMIT_EXCEEDED'
      });
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

test('an oversized tracked tree is refused before any worktree checkout', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: fixture.remote });
    const editor = path.join(fixture.base, 'oversized-tree-editor');
    run('git', [
      'clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH,
      fixture.remote, editor
    ], { cwd: fixture.base });
    run('git', ['config', 'user.name', 'Oversized Tree'], { cwd: editor });
    run('git', ['config', 'user.email', 'oversized@example.test'], { cwd: editor });
    const oversized = path.join(editor, 'oversized.bin');
    await writeFile(oversized, '');
    await truncate(oversized, 129 * 1024 * 1024);
    run('git', ['add', 'oversized.bin'], { cwd: editor });
    run('git', ['commit', '-qm', 'Add oversized tracked payload'], { cwd: editor });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: editor });

    let observedNoCheckout = false;
    let movedRemote = false;
    let cloneCount = 0;
    const inspectBeforeCheckout = async (args, options) => {
      const result = await runRemoteGitAsync(args, options);
      if (!movedRemote && result.status === 0 && args.includes('clone')) {
        cloneCount += 1;
        assert.ok(args.includes('--no-checkout'),
          'every remote snapshot must start without materializing its tracked tree');
        if (cloneCount === 1) {
          assert.ok(args.includes('--filter=blob:none'));
          return result;
        }
        const filter = args.find((arg) => arg.startsWith('--filter=blob:limit='));
        assert.ok(filter, 'the admitted clone must use its surveyed per-blob ceiling');
        await assert.rejects(readFile(path.join(args.at(-1), 'oversized.bin')), {
          code: 'ENOENT'
        });
        if (cloneCount < 3) return result;
        observedNoCheckout = true;
        // An omitted oversized promisor blob must be classified from local metadata. Making the
        // remote unavailable proves neither quota inspection nor checkout can lazy-fetch it.
        await rename(fixture.remote, `${fixture.remote}.offline`);
        movedRemote = true;
      }
      return result;
    };
    await assert.rejects(inspectRepositoryOnboarding(fixture.remote, {
      runRemoteCommand: inspectBeforeCheckout
    }), { code: 'REPOSITORY_ONBOARDING_SNAPSHOT_LIMIT_EXCEEDED' });
    assert.equal(cloneCount, 3);
    assert.equal(observedNoCheckout, true);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('aggregate tracked bytes are refused before worktree checkout', async () => {
  const fixture = await repositoryFixture();
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const editor = path.join(fixture.base, 'aggregate-tree-editor');
    run('git', [
      'clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH,
      fixture.remote, editor
    ], { cwd: fixture.base });
    run('git', ['config', 'user.name', 'Aggregate Tree'], { cwd: editor });
    run('git', ['config', 'user.email', 'aggregate@example.test'], { cwd: editor });
    const first = path.join(editor, 'first-large.bin');
    const second = path.join(editor, 'second-large.bin');
    await writeFile(first, '');
    await writeFile(second, '');
    await truncate(first, 65 * 1024 * 1024);
    await truncate(second, 64 * 1024 * 1024);
    run('git', ['add', 'first-large.bin', 'second-large.bin'], { cwd: editor });
    run('git', ['commit', '-qm', 'Add aggregate oversized payload'], { cwd: editor });
    run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: editor });
    run('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: fixture.remote });

    let observedNoCheckout = false;
    let cloneCount = 0;
    let movedRemote = false;
    const inspectBeforeCheckout = async (args, options) => {
      const result = await runRemoteGitAsync(args, options);
      if (!movedRemote && result.status === 0 && args.includes('clone')) {
        cloneCount += 1;
        const scratch = args.at(-1);
        await assert.rejects(readFile(path.join(scratch, 'first-large.bin')), { code: 'ENOENT' });
        await assert.rejects(readFile(path.join(scratch, 'second-large.bin')), { code: 'ENOENT' });
        if (cloneCount === 1) {
          assert.ok(args.includes('--filter=blob:none'));
          return result;
        }
        const filter = args.find((arg) => arg.startsWith('--filter=blob:limit='));
        assert.ok(filter, 'aggregate admission must use a surveyed per-blob ceiling');
        if (cloneCount < 3) return result;
        observedNoCheckout = true;
        await rename(fixture.remote, `${fixture.remote}.offline`);
        movedRemote = true;
      }
      return result;
    };
    await assert.rejects(inspectRepositoryOnboarding(fixture.remote, {
      runRemoteCommand: inspectBeforeCheckout
    }), { code: 'REPOSITORY_ONBOARDING_SNAPSHOT_LIMIT_EXCEEDED' });
    assert.equal(cloneCount, 3);
    assert.equal(observedNoCheckout, true);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('fresh setup preserves a SHA-256 application repository object format', async (t) => {
  const probe = await mkdtemp(path.join(os.tmpdir(), 'sflow-sha256-probe-'));
  const supported = run('git', ['init', '-q', '--object-format=sha256', probe], {
    allowFailure: true
  }).status === 0;
  await rm(probe, { recursive: true, force: true });
  if (!supported) return t.skip('installed Git does not support SHA-256 repositories');
  const fixture = await repositoryFixture('sha256-application', { objectFormat: 'sha256' });
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.applicationSource.commit.length, 64);
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(result.proposal.commit.length, 64);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a moved observed ref refuses a confirmed plan without overwriting it', async () => {
  const fixture = await repositoryFixture();
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    await writeFile(path.join(fixture.source, 'AFTER.md'), '# after preview\n');
    run('git', ['add', 'AFTER.md'], { cwd: fixture.source });
    run('git', ['commit', '-qm', 'Advance application'], { cwd: fixture.source });
    run('git', ['push', '-q', fixture.remote, 'main:main'], { cwd: fixture.source });
    await assert.rejects(
      applyRepositoryOnboarding(fixture.remote, { confirmPlan: plan.planId }),
      (error) => ['REPOSITORY_ONBOARDING_CONFIRMATION_MISMATCH',
        'REPOSITORY_ONBOARDING_PLAN_STALE'].includes(error.code)
    );
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('source refs are re-observed after candidate construction and before configuration creation', async () => {
  const fixture = await repositoryFixture();
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    let observations = 0;
    let advanced = false;
    const racingRemoteCommand = async (args, options) => {
      if (args[0] === 'ls-remote' && ++observations === 3) {
        await writeFile(path.join(fixture.source, 'AFTER-CANDIDATE.md'), '# raced candidate\n');
        run('git', ['add', 'AFTER-CANDIDATE.md'], { cwd: fixture.source });
        run('git', ['commit', '-qm', 'Advance after candidate construction'], {
          cwd: fixture.source
        });
        run('git', ['push', '-q', fixture.remote, 'main:main'], { cwd: fixture.source });
        advanced = true;
      }
      return runRemoteGitAsync(args, options);
    };
    await assert.rejects(applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId, runRemoteCommand: racingRemoteCommand
    }), { code: 'REPOSITORY_ONBOARDING_PLAN_STALE' });
    assert.equal(advanced, true, 'fixture must advance only at the final pre-push observation');
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a source move after final observation can publish only a review proposal', async () => {
  const fixture = await repositoryFixture();
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    let raced = false;
    let configurationPushes = 0;
    let proposalPushes = 0;
    let advancedCommit = null;
    const raceAtPublication = async (args, options) => {
      if (args[0] === 'push') {
        const destination = args.at(-1) ?? '';
        if (destination.endsWith(`:refs/heads/${CONFIGURATION_BRANCH}`)) {
          configurationPushes += 1;
        }
        if (destination.endsWith(`:refs/heads/${plan.proposalBranch}`)) {
          proposalPushes += 1;
          if (!raced) {
            await writeFile(path.join(fixture.source, 'AFTER-FINAL-CHECK.md'),
              '# advanced at publication boundary\n');
            run('git', ['add', 'AFTER-FINAL-CHECK.md'], { cwd: fixture.source });
            run('git', ['commit', '-qm', 'Advance after final onboarding check'], {
              cwd: fixture.source
            });
            advancedCommit = run('git', ['rev-parse', 'HEAD'], {
              cwd: fixture.source
            }).stdout.trim();
            run('git', ['push', '-q', fixture.remote, 'main:main'], {
              cwd: fixture.source
            });
            raced = true;
          }
        }
      }
      return runRemoteGitAsync(args, options);
    };

    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId, runRemoteCommand: raceAtPublication
    });
    assert.equal(raced, true,
      'fixture must advance the source after the final observation and at publication');
    assert.equal(configurationPushes, 0,
      'a mutable source cannot feed an unguarded sflow/config create');
    assert.equal(proposalPushes, 1);
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(result.proposal.branch, plan.proposalBranch);
    assert.equal(run('git', ['rev-parse', 'refs/heads/main'], {
      cwd: fixture.remote
    }).stdout.trim(), advancedCommit);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
    assert.equal(run('git', [
      'rev-parse', `refs/heads/${plan.proposalBranch}`
    ], { cwd: fixture.remote }).stdout.trim(), result.proposal.commit);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('source-derived configuration creation publishes one leased review proposal and never claims readiness', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.match(plan.proposalBranch, /^sflow\/config-change\/onboarding\/create-/u);
    assert.equal(plan.observedRefs[`refs/heads/${plan.proposalBranch}`], null);
    assert.ok(plan.effects.some((effect) =>
      effect.target === plan.proposalBranch && effect.action === 'propose'));
    let protectedPushes = 0;
    const protectedConfiguration = async (args, options) => {
      if (args[0] === 'push' && args.at(-1)?.endsWith(':refs/heads/sflow/config')) {
        protectedPushes += 1;
        return {
          status: 1, stdout: '', stderr: 'remote: protected branch update failed',
          failure: {
            classification: 'policy-rejected', code: 'REMOTE_POLICY_REJECTED',
            retryable: false, advice: 'Use the reviewed merge path.'
          }
        };
      }
      return runRemoteGitAsync(args, options);
    };
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId, runRemoteCommand: protectedConfiguration
    });
    assert.equal(protectedPushes, 0,
      'mutable source refs cannot be atomically guarded by a vanilla Git config-create push');
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(result.primaryAction, 'review-choices');
    assert.equal(result.changed, true);
    assert.equal(result.review.configurationReady, false);
    assert.equal(result.review.published, true);
    assert.equal(result.review.targetBranch, CONFIGURATION_BRANCH);
    assert.equal(result.proposal.branch, plan.proposalBranch);
    assert.equal(result.proposal.commit, result.proposal.candidateCommit);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
    assert.equal(run('git', [
      'rev-parse', `refs/heads/${plan.proposalBranch}`
    ], { cwd: fixture.remote }).stdout.trim(), result.proposal.commit);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', 'refs/heads/state'
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
    assert.deepEqual(await listLeadRepositories(), []);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a setup proposal is visible, reviewable, and activates only its exact reviewed commit', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    const applied = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(applied.review.reason, 'guarded-source-refs');
    assert.match(applied.review.inspectCommand, /setup-proposal/u);
    const queue = await listRepositoryOnboardingProposals(fixture.remote);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].branch, applied.proposal.branch);
    assert.equal(queue[0].status, 'pending-review');
    const cliQueue = run(process.execPath, [
      path.resolve('bin/singularity-flow.mjs'), 'capability', 'setup-proposals',
      '--lead', fixture.remote, '--json'
    ], { cwd: process.cwd() });
    assert.equal(JSON.parse(cliQueue.stdout).proposals[0].branch, applied.proposal.branch);
    const detail = await inspectRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch
    );
    const cliDetail = run(process.execPath, [
      path.resolve('bin/singularity-flow.mjs'), 'capability', 'setup-proposal',
      applied.proposal.branch, '--lead', fixture.remote, '--json'
    ], { cwd: process.cwd() });
    assert.equal(JSON.parse(cliDetail.stdout).proposalCommit, applied.proposal.commit);
    assert.equal(detail.valid, true);
    assert.equal(detail.sourceFresh, true);
    assert.equal(detail.targetCommit, null);
    assert.equal(detail.proposalCommit, applied.proposal.commit);
    assert.ok(detail.changedFiles.some((file) =>
      file.paths.includes('singularity/workflow.yml')));
    await assert.rejects(() => activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, { confirm: applied.proposal.commit }
    ), { code: 'REPOSITORY_ONBOARDING_CONFIGURATION_UNPROTECTED' });
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
    const cliActivation = run(process.execPath, [
      path.resolve('bin/singularity-flow.mjs'), 'capability', 'setup-activate',
      applied.proposal.branch, '--lead', fixture.remote,
      '--confirm', applied.proposal.commit, '--acknowledge-unprotected', '--json'
    ], { cwd: process.cwd() });
    const activated = JSON.parse(cliActivation.stdout);
    assert.equal(activated.activated, true);
    assert.equal(activated.targetCommit, applied.proposal.commit);
    const repeated = await activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, { confirm: applied.proposal.commit }
    );
    assert.equal(repeated.alreadyMerged, true);
    const recreatePlan = await inspectRepositoryOnboarding(fixture.remote, {
      mode: 'recreate'
    });
    const recreated = await applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: recreatePlan.planId
    });
    const laterProposal = await inspectRepositoryOnboardingProposal(
      fixture.remote, recreated.proposal.branch, { includeDiff: false }
    );
    assert.equal(laterProposal.valid, true,
      'an unchanged recovery receipt remains valid in later configuration proposals');
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a moved source blocks activation of an earlier setup proposal', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    const applied = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    await writeFile(path.join(fixture.source, 'LATER.md'), '# Later\n');
    run('git', ['add', 'LATER.md'], { cwd: fixture.source });
    run('git', ['commit', '-qm', 'Advance source'], { cwd: fixture.source });
    run('git', ['push', '-q', fixture.remote, 'main:main'], { cwd: fixture.source });
    const detail = await inspectRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch
    );
    assert.equal(detail.valid, false);
    assert.equal(detail.status, 'stale-source');
    await assert.rejects(() => activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, {
        confirm: applied.proposal.commit, acknowledgeUnprotected: true
      }
    ), { code: 'REPOSITORY_ONBOARDING_PROPOSAL_SOURCE_STALE' });
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a protected setup target remains pending under repository review controls', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    const applied = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    const protectedPush = async (args, options) => {
      if (args[0] === 'push' && args.at(-1)?.endsWith(':refs/heads/sflow/config')) {
        return {
          status: 1, stdout: '', stderr: 'remote: protected branch: pull request required',
          failure: {
            classification: 'policy-rejected', code: 'REMOTE_POLICY_REJECTED',
            retryable: false, advice: 'Use a pull request.'
          }
        };
      }
      return runRemoteGitAsync(args, options);
    };
    const result = await activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, {
        confirm: applied.proposal.commit, acknowledgeUnprotected: true,
        runRemoteCommand: protectedPush
      }
    );
    assert.equal(result.activated, false);
    assert.equal(result.status, 'review-required');
    assert.equal(result.externalAction?.sourceBranch, applied.proposal.branch);
    const networkFailure = async (args, options) => {
      if (args[0] === 'push' && args.at(-1)?.endsWith(':refs/heads/sflow/config')) {
        return {
          status: 1, stdout: '',
          stderr: 'remote: protected branch proxy page at https://name:secret@example.test/repo',
          failure: {
            classification: 'network-transient', code: 'REMOTE_NETWORK_TRANSIENT',
            retryable: true, advice: 'Retry the network connection.'
          }
        };
      }
      return runRemoteGitAsync(args, options);
    };
    const network = await activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, {
        confirm: applied.proposal.commit, acknowledgeUnprotected: true,
        runRemoteCommand: networkFailure
      }
    );
    assert.equal(network.status, 'activation-pending');
    assert.equal(network.failure.classification, 'network-transient');
    assert.doesNotMatch(network.failure.diagnostic, /name:secret/u);
    assert.equal(run('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote, allowFailure: true }).status, 1);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('an existing configuration setup proposal activates only from its exact base', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const plan = await inspectRepositoryOnboarding(fixture.remote, { mode: 'recreate' });
    const applied = await applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: plan.planId
    });
    assert.equal(applied.status, 'configuration-review-required');
    const detail = await inspectRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, { includeDiff: false }
    );
    assert.equal(detail.valid, true);
    assert.equal(detail.proposalBase, plan.configuration.commit);
    const wrongSuffix = plan.configuration.commit.startsWith('f'.repeat(12))
      ? 'e'.repeat(12) : 'f'.repeat(12);
    const spoofedBranch = `sflow/config-change/onboarding/recreate-${wrongSuffix}`;
    run('git', ['update-ref', `refs/heads/${spoofedBranch}`, applied.proposal.commit], {
      cwd: fixture.remote
    });
    const spoofed = await inspectRepositoryOnboardingProposal(
      fixture.remote, spoofedBranch, { includeDiff: false }
    );
    assert.equal(spoofed.valid, false);
    assert.equal(spoofed.status, 'invalid');
    const activated = await activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, {
        confirm: applied.proposal.commit, acknowledgeUnprotected: true
      }
    );
    assert.equal(activated.activated, true);
    assert.equal(activated.targetCommit, applied.proposal.commit);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('an advanced configuration target blocks a stale setup proposal', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const plan = await inspectRepositoryOnboarding(fixture.remote, { mode: 'recreate' });
    const applied = await applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: plan.planId
    });
    const maintainer = path.join(fixture.base, 'other-configuration');
    run('git', ['clone', '-q', '--branch', CONFIGURATION_BRANCH, fixture.remote, maintainer], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Other Maintainer'], { cwd: maintainer });
    run('git', ['config', 'user.email', 'maintainer@example.test'], { cwd: maintainer });
    const workflowFile = path.join(maintainer, 'singularity', 'workflow.yml');
    await writeFile(workflowFile, `${await readFile(workflowFile, 'utf8')}\n`);
    run('git', ['add', 'singularity/workflow.yml'], { cwd: maintainer });
    run('git', ['commit', '-qm', 'Advance approved configuration'], { cwd: maintainer });
    run('git', ['push', '-q', fixture.remote,
      `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], { cwd: maintainer });
    const detail = await inspectRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, { includeDiff: false }
    );
    assert.equal(detail.valid, false);
    assert.equal(detail.status, 'stale-target');
    await assert.rejects(() => activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, {
        confirm: applied.proposal.commit, acknowledgeUnprotected: true
      }
    ), { code: 'REPOSITORY_ONBOARDING_PROPOSAL_TARGET_STALE' });
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('an externally merged setup proposal is recognized without another direct push', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const plan = await inspectRepositoryOnboarding(fixture.remote, { mode: 'recreate' });
    const applied = await applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: plan.planId
    });
    const reviewer = path.join(fixture.base, 'reviewer');
    run('git', ['clone', '-q', '--branch', CONFIGURATION_BRANCH, fixture.remote, reviewer], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Setup Reviewer'], { cwd: reviewer });
    run('git', ['config', 'user.email', 'reviewer@example.test'], { cwd: reviewer });
    run('git', ['fetch', '-q', fixture.remote,
      `${applied.proposal.branch}:refs/remotes/origin/setup-review`], { cwd: reviewer });
    run('git', ['merge', '-q', '--no-ff', '--no-edit', 'refs/remotes/origin/setup-review'], {
      cwd: reviewer
    });
    run('git', ['push', '-q', fixture.remote, `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: reviewer
    });
    const detail = await inspectRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, { includeDiff: false }
    );
    assert.equal(detail.merged, true);
    assert.equal(detail.valid, true);
    const result = await activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, { confirm: applied.proposal.commit }
    );
    assert.equal(result.alreadyMerged, true);
    assert.equal(result.activated, true);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a concurrent external merge reconciles a refused direct setup update', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const plan = await inspectRepositoryOnboarding(fixture.remote, { mode: 'recreate' });
    const applied = await applyRepositoryOnboarding(fixture.remote, {
      mode: 'recreate', confirmPlan: plan.planId
    });
    const reviewer = path.join(fixture.base, 'concurrent-reviewer');
    run('git', ['clone', '-q', '--branch', CONFIGURATION_BRANCH, fixture.remote, reviewer], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Setup Reviewer'], { cwd: reviewer });
    run('git', ['config', 'user.email', 'reviewer@example.test'], { cwd: reviewer });
    run('git', ['fetch', '-q', fixture.remote,
      `${applied.proposal.branch}:refs/remotes/origin/setup-review`], { cwd: reviewer });
    let externalMerged = false;
    const mergeDuringPush = async (args, options) => {
      if (args[0] === 'push' && args.at(-1)?.endsWith(':refs/heads/sflow/config')) {
        run('git', ['merge', '-q', '--no-ff', '--no-edit', 'refs/remotes/origin/setup-review'], {
          cwd: reviewer
        });
        run('git', ['push', '-q', fixture.remote,
          `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], { cwd: reviewer });
        externalMerged = true;
        return {
          status: 1, stdout: '', stderr: 'remote: protected branch: pull request required',
          failure: {
            classification: 'policy-rejected', code: 'REMOTE_POLICY_REJECTED',
            retryable: false, advice: 'Use a pull request.'
          }
        };
      }
      return runRemoteGitAsync(args, options);
    };
    const result = await activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, {
        confirm: applied.proposal.commit, acknowledgeUnprotected: true,
        runRemoteCommand: mergeDuringPush
      }
    );
    assert.equal(externalMerged, true);
    assert.equal(result.activated, true);
    assert.equal(result.alreadyMerged, true);
    assert.notEqual(result.targetCommit, applied.proposal.commit);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a matching approved ref does not legitimize an invalid setup branch', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
  try {
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    const applied = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    const reviewer = path.join(fixture.base, 'invalid-reviewer');
    run('git', ['clone', '-q', '--branch', applied.proposal.branch, fixture.remote, reviewer], {
      cwd: fixture.base
    });
    run('git', ['config', 'user.name', 'Invalid Reviewer'], { cwd: reviewer });
    run('git', ['config', 'user.email', 'reviewer@example.test'], { cwd: reviewer });
    await writeFile(path.join(reviewer, 'README.md'), '# Unrelated work\n');
    run('git', ['add', 'README.md'], { cwd: reviewer });
    run('git', ['commit', '-qm', 'Add unrelated work'], { cwd: reviewer });
    const invalidCommit = run('git', ['rev-parse', 'HEAD'], { cwd: reviewer }).stdout.trim();
    run('git', ['push', '-q', fixture.remote,
      `HEAD:refs/heads/${applied.proposal.branch}`], { cwd: reviewer });
    run('git', ['push', '-q', fixture.remote,
      `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], { cwd: reviewer });
    const detail = await inspectRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, { includeDiff: false }
    );
    assert.equal(detail.merged, true);
    assert.equal(detail.valid, false);
    assert.equal(detail.status, 'invalid');
    assert.ok(detail.invalidFiles.includes('README.md'));
    await assert.rejects(() => activateRepositoryOnboardingProposal(
      fixture.remote, applied.proposal.branch, { confirm: invalidCommit }
    ), { code: 'REPOSITORY_ONBOARDING_PROPOSAL_INVALID' });
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('a pre-existing onboarding review ref is preserved and never adopted or overwritten', async () => {
  const fixture = await repositoryFixture();
  try {
    const sourceCommit = run('git', ['rev-parse', 'refs/heads/main'], {
      cwd: fixture.remote
    }).stdout.trim();
    const branch = `sflow/config-change/onboarding/create-${sourceCommit.slice(0, 12)}`;
    run('git', ['update-ref', `refs/heads/${branch}`, sourceCommit], { cwd: fixture.remote });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    assert.equal(plan.proposalBranch, branch);
    assert.equal(plan.observedRefs[`refs/heads/${branch}`], sourceCommit);
    let proposalPushes = 0;
    const protectedConfiguration = async (args, options) => {
      if (args[0] === 'push' && args.at(-1)?.endsWith(':refs/heads/sflow/config')) {
        return {
          status: 1, stdout: '', stderr: 'remote: protected branch update failed',
          failure: {
            classification: 'policy-rejected', code: 'REMOTE_POLICY_REJECTED',
            retryable: false, advice: 'Use the reviewed merge path.'
          }
        };
      }
      if (args[0] === 'push' && args.at(-1)?.endsWith(`:refs/heads/${branch}`)) {
        proposalPushes += 1;
      }
      return runRemoteGitAsync(args, options);
    };
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId, runRemoteCommand: protectedConfiguration
    });
    assert.equal(result.status, 'configuration-review-required');
    assert.equal(result.changed, false);
    assert.equal(result.proposal.existing, true);
    assert.equal(result.proposal.conflict, true);
    assert.equal(result.review.recovery.action, 'resolve-proposal-conflict');
    assert.notEqual(result.proposal.candidateCommit, sourceCommit);
    assert.equal(proposalPushes, 0);
    assert.equal(run('git', ['rev-parse', `refs/heads/${branch}`], {
      cwd: fixture.remote
    }).stdout.trim(), sourceCommit);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('migrate and recreate publish review proposals without moving approved configuration', async () => {
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  try {
    for (const mode of ['migrate', 'recreate']) {
      const fixture = await repositoryFixture(`${mode}-review`);
      process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
      try {
        const plan = await prepareConfigurationProposalMode(fixture, mode);
        const configurationBefore = run('git', [
          'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
        ], { cwd: fixture.remote }).stdout.trim();
        let configurationPushes = 0;
        let proposalPushes = 0;
        const observePushes = async (args, options) => {
          if (args[0] === 'push') {
            const destination = args.at(-1) ?? '';
            if (destination.endsWith(`:refs/heads/${CONFIGURATION_BRANCH}`)) {
              configurationPushes += 1;
            }
            if (destination.endsWith(`:refs/heads/${plan.proposalBranch}`)) {
              proposalPushes += 1;
            }
          }
          return runRemoteGitAsync(args, options);
        };
        const result = await applyRepositoryOnboarding(fixture.remote, {
          mode, confirmPlan: plan.planId, runRemoteCommand: observePushes
        });
        assert.equal(configurationPushes, 0,
          `${mode} must never write approved configuration directly`);
        assert.equal(proposalPushes, 1);
        assert.equal(result.status, 'configuration-review-required');
        assert.equal(result.primaryAction, 'review-choices');
        assert.equal(result.changed, true);
        assert.equal(result.review.configurationReady, false);
        assert.equal(result.review.status, 'review-required');
        assert.equal(result.review.recovery.action, 'merge-proposal');
        assert.equal(result.proposal.branch, plan.proposalBranch);
        assert.equal(result.proposal.conflict, false);
        assert.equal(result.proposal.published, true);
        assert.deepEqual(result.effects, [{
          kind: plan.effects.find((effect) => effect.action === 'propose').kind,
          target: plan.proposalBranch,
          action: 'propose'
        }]);
        assert.equal(run('git', [
          'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
        ], { cwd: fixture.remote }).stdout.trim(), configurationBefore);
        assert.equal(run('git', [
          'rev-parse', `refs/heads/${plan.proposalBranch}`
        ], { cwd: fixture.remote }).stdout.trim(), result.proposal.commit);
        assert.deepEqual(await listLeadRepositories(), [],
          'review-required configuration is never registered as ready');
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
  }
});

test('migrate and recreate preserve conflicting review refs and report review required', async () => {
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  try {
    for (const mode of ['migrate', 'recreate']) {
      const fixture = await repositoryFixture(`${mode}-conflict`);
      process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
      try {
        await ensureConfigurationBranch(fixture.remote, { capability });
        if (mode === 'migrate') {
          const editor = path.join(fixture.base, 'migration-source');
          run('git', [
            'clone', '-q', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH,
            fixture.remote, editor
          ], { cwd: fixture.base });
          run('git', ['config', 'user.name', 'Migration Source'], { cwd: editor });
          run('git', ['config', 'user.email', 'migration@example.test'], { cwd: editor });
          await rm(path.join(editor, '.github', 'agents', 'developer.agent.md'));
          run('git', ['add', '-A'], { cwd: editor });
          run('git', ['commit', '-qm', 'Retain an older packaged configuration'], { cwd: editor });
          run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: editor });
        }
        const configurationBefore = run('git', [
          'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
        ], { cwd: fixture.remote }).stdout.trim();
        const conflictingCommit = run('git', ['rev-parse', 'refs/heads/main'], {
          cwd: fixture.remote
        }).stdout.trim();
        const branch = `sflow/config-change/onboarding/${mode}-${configurationBefore.slice(0, 12)}`;
        run('git', ['update-ref', `refs/heads/${branch}`, conflictingCommit], {
          cwd: fixture.remote
        });
        const plan = await inspectRepositoryOnboarding(fixture.remote, { mode });
        assert.equal(plan.proposalBranch, branch);
        assert.equal(plan.observedRefs[`refs/heads/${branch}`], conflictingCommit);
        let proposalPushes = 0;
        const preserveConflict = async (args, options) => {
          if (args[0] === 'push'
              && (args.at(-1) ?? '').endsWith(`:refs/heads/${branch}`)) {
            proposalPushes += 1;
          }
          return runRemoteGitAsync(args, options);
        };
        const result = await applyRepositoryOnboarding(fixture.remote, {
          mode, confirmPlan: plan.planId, runRemoteCommand: preserveConflict
        });
        assert.equal(proposalPushes, 0);
        assert.equal(result.status, 'configuration-review-required');
        assert.equal(result.primaryAction, 'review-choices');
        assert.equal(result.changed, false);
        assert.equal(result.review.configurationReady, false);
        assert.equal(result.review.status, 'proposal-conflict');
        assert.equal(result.review.recovery.action, 'resolve-proposal-conflict');
        assert.equal(result.proposal.existing, true);
        assert.equal(result.proposal.conflict, true);
        assert.equal(result.proposal.published, false);
        assert.equal(result.proposal.commit, conflictingCommit);
        assert.notEqual(result.proposal.candidateCommit, conflictingCommit);
        assert.deepEqual(result.effects, [],
          'an existing conflict is not reported as a completed proposal effect');
        assert.equal(run('git', ['rev-parse', `refs/heads/${branch}`], {
          cwd: fixture.remote
        }).stdout.trim(), conflictingCommit);
        assert.equal(run('git', [
          'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
        ], { cwd: fixture.remote }).stdout.trim(), configurationBefore);
        assert.deepEqual(await listLeadRepositories(), [],
          'a conflicting proposal cannot register repository setup as ready');
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
  }
});

test('migrate and recreate reconcile a concurrently created review ref as a conflict', async () => {
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  try {
    for (const mode of ['migrate', 'recreate']) {
      const fixture = await repositoryFixture(`${mode}-concurrent-conflict`);
      process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(fixture.base, 'leads.json');
      try {
        const plan = await prepareConfigurationProposalMode(fixture, mode);
        const configurationBefore = run('git', [
          'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
        ], { cwd: fixture.remote }).stdout.trim();
        const conflictingCommit = run('git', ['rev-parse', 'refs/heads/main'], {
          cwd: fixture.remote
        }).stdout.trim();
        let raced = false;
        const createConflictAtPush = async (args, options) => {
          if (!raced && args[0] === 'push'
              && (args.at(-1) ?? '').endsWith(`:refs/heads/${plan.proposalBranch}`)) {
            raced = true;
            run('git', [
              'update-ref', `refs/heads/${plan.proposalBranch}`, conflictingCommit
            ], { cwd: fixture.remote });
          }
          return runRemoteGitAsync(args, options);
        };
        const result = await applyRepositoryOnboarding(fixture.remote, {
          mode, confirmPlan: plan.planId, runRemoteCommand: createConflictAtPush
        });
        assert.equal(raced, true);
        assert.equal(result.status, 'configuration-review-required');
        assert.equal(result.changed, false);
        assert.equal(result.review.configurationReady, false);
        assert.equal(result.review.status, 'proposal-conflict');
        assert.equal(result.review.recovery.action, 'resolve-proposal-conflict');
        assert.equal(result.proposal.existing, true);
        assert.equal(result.proposal.conflict, true);
        assert.equal(result.proposal.published, false);
        assert.equal(result.proposal.commit, conflictingCommit);
        assert.deepEqual(result.effects, [],
          'a losing create lease is not reported as a completed proposal effect');
        assert.equal(run('git', [
          'rev-parse', `refs/heads/${plan.proposalBranch}`
        ], { cwd: fixture.remote }).stdout.trim(), conflictingCommit);
        assert.equal(run('git', [
          'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
        ], { cwd: fixture.remote }).stdout.trim(), configurationBefore);
        assert.deepEqual(await listLeadRepositories(), []);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
  }
});

test('a local registry failure after remote setup returns an exact resumable local-only recovery', async () => {
  const fixture = await repositoryFixture();
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  const unusableRegistry = path.join(fixture.base, 'registry-is-a-directory');
  await mkdir(unusableRegistry);
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = unusableRegistry;
  try {
    await ensureConfigurationBranch(fixture.remote, { capability });
    const plan = await inspectRepositoryOnboarding(fixture.remote);
    const result = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: plan.planId
    });
    assert.equal(result.status, 'local-registration-pending');
    assert.equal(result.primaryAction, 'retry');
    assert.equal(result.changed, true);
    assert.equal(result.localRegistration.status, 'pending');
    assert.equal(result.localRegistration.remembered, false);
    assert.equal(result.localRegistration.target, fixture.remote);
    assert.equal(result.localRegistration.code, 'CAPABILITY_LEAD_REGISTRY_WRITE_FAILED');
    assert.equal(result.localRegistration.retry.shell, renderPlatformCommand([
      'singularity-flow', 'capability', 'onboard', fixture.remote, '--dry-run', '--json'
    ]));
    const configurationCommit = run('git', [
      'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote }).stdout.trim();
    const stateCommit = run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim();

    const recoveryPlan = await inspectRepositoryOnboarding(fixture.remote);
    assert.deepEqual(recoveryPlan.effects, [{
      kind: 'local-registration', target: fixture.remote, action: 'remember'
    }]);
    const recovery = await applyRepositoryOnboarding(fixture.remote, {
      confirmPlan: recoveryPlan.planId
    });
    assert.equal(recovery.status, 'local-registration-pending');
    assert.equal(recovery.changed, false);
    assert.equal(run('git', [
      'rev-parse', `refs/heads/${CONFIGURATION_BRANCH}`
    ], { cwd: fixture.remote }).stdout.trim(), configurationCommit);
    assert.equal(run('git', ['rev-parse', 'refs/heads/state'], {
      cwd: fixture.remote
    }).stdout.trim(), stateCommit);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('reset-local works offline and a repeated reset is an exact no-op', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-reset-'));
  const remote = path.join(base, 'offline.git');
  const registry = path.join(base, 'leads.json');
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry;
  try {
    await rememberLeadRepository(remote);
    const cache = organisationCacheFile(remote);
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, '{}\n');

    const plan = await inspectRepositoryOnboarding(remote, { mode: 'reset-local' });
    assert.deepEqual(plan.availableModes, ['reset-local']);
    assert.equal(plan.observedRefs && Object.keys(plan.observedRefs).length, 0);
    assert.equal(plan.effects.length, 2);
    const result = await applyRepositoryOnboarding(remote, {
      mode: 'reset-local', confirmPlan: plan.planId
    });
    assert.equal(result.changed, true);
    assert.equal(result.localReset.leadRegistrationsRemoved, 1);
    assert.equal(result.localReset.organisationCachesRemoved, 1);
    assert.deepEqual(await listLeadRepositories(), []);

    const registryBefore = await readFile(registry, 'utf8');
    const repeatedPlan = await inspectRepositoryOnboarding(remote, { mode: 'reset-local' });
    assert.deepEqual(repeatedPlan.effects, []);
    const repeated = await applyRepositoryOnboarding(remote, {
      mode: 'reset-local', confirmPlan: repeatedPlan.planId
    });
    assert.equal(repeated.changed, false);
    assert.equal(await readFile(registry, 'utf8'), registryBefore);
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(base, { recursive: true, force: true });
  }
});

test('reset-local removes equivalent registry and cache URL spellings', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-onboarding-reset-alias-'));
  const registry = path.join(base, 'leads.json');
  const previousRegistry = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry;
  // The identity layer deliberately recognizes the public provider's documented HTTPS/SSH alias,
  // but repository-source hygiene forbids baking a public sample authority into fixtures.
  const providerHost = ['github', 'com'].join('.');
  const registered = `https://${providerHost}/Example/Office-App.git`;
  const requested = `git@${providerHost}:example/office-app.git`;
  try {
    await rememberLeadRepository(registered);
    for (const target of [registered, requested]) {
      const cache = organisationCacheFile(target);
      await mkdir(path.dirname(cache), { recursive: true });
      await writeFile(cache, '{}\n');
    }
    const plan = await inspectRepositoryOnboarding(requested, { mode: 'reset-local' });
    assert.equal(plan.localReset.leadRegistrations, 1);
    assert.equal(plan.localReset.organisationCaches, 2);
    assert.equal(plan.effects.filter((effect) => effect.kind === 'local-registration').length, 1);
    assert.equal(plan.effects.filter((effect) => effect.kind === 'local-cache').length, 2);
    const result = await applyRepositoryOnboarding(requested, {
      mode: 'reset-local', confirmPlan: plan.planId
    });
    assert.equal(result.localReset.leadRegistrationsRemoved, 1);
    assert.equal(result.localReset.organisationCachesRemoved, 2);
    assert.deepEqual(await listLeadRepositories(), []);
    for (const target of [registered, requested]) {
      await assert.rejects(readFile(organisationCacheFile(target)), { code: 'ENOENT' });
    }
  } finally {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previousRegistry;
    await rm(base, { recursive: true, force: true });
  }
});
