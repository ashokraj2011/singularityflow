import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { resolveLifecycleCapability } from '../src/capability-context.mjs';
import {
  ensureConfigurationBranch, materializeConfigurationSnapshot
} from '../src/configuration-branch.mjs';
import { sha256 } from '../src/world-model/canonicalize.mjs';
import { createWorldModelRepositoryDomain } from '../src/world-model/history/model-owners.mjs';
import {
  assertWorldModelRepositoryIdentityAuthority,
  resolveWorldModelRepositoryIdentityAuthority,
  selectPinnedStoryCapabilityResolution,
  validateWorldModelRepositoryIdentityAuthority
} from '../src/world-model/history/repository-identity-authority.mjs';
import { configuredWorldModelV4ScopeOptions } from '../src/world-model/scope/configuration.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { loadWorldModelConfig } from '../src/worldmodel.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function command(name, args, cwd, { env = {}, allowFailure = false } = {}) {
  const result = spawnSync(name, args, {
    cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  if (!allowFailure) {
    assert.equal(result.status, 0, `${name} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(root, ...args) {
  return command('git', args, root).stdout.trim();
}

async function repository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-repository-authority-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'application');
  const remote = path.join(base, 'application.git');
  const selection = path.join(base, 'active-workspace.json');
  const registry = path.join(base, 'workspaces.json');
  const env = {
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry
  };
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP authority test');
  git(root, 'config', 'user.email', 'wmp-authority@example.test');
  command(process.execPath, [cli, 'init'], root, { env });
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.repositories = {
    application: {
      url: remote,
      defaultBranch: 'main',
      branchCompletionPolicy: 'direct',
      requiredChecks: [],
      required: true,
      metadata: {},
      jira: { projectKey: null, boardId: null }
    },
    other: {
      url: path.join(base, 'other.git'),
      defaultBranch: 'main',
      branchCompletionPolicy: 'direct',
      requiredChecks: [],
      required: false,
      metadata: {},
      jira: { projectKey: null, boardId: null }
    }
  };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  await writeFile(path.join(root, 'singularity/capabilities.yml'), YAML.stringify({
    version: 1,
    capabilities: {
      product: { name: 'Product', kind: 'collection', parent: null, policy: {} },
      'application-api': {
        name: 'Application API', kind: 'delivery', parent: 'product',
        repository: 'application', sourceRoots: ['src'], sharedRoots: ['shared'],
        policy: { gitPublication: 'off' }
      },
      'other-api': {
        name: 'Other API', kind: 'delivery', parent: 'product',
        repository: 'other', policy: { gitPublication: 'off' }
      }
    }
  }));
  await writeFile(path.join(root, 'README.md'), '# Application\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initialize governed application');
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  await ensureConfigurationBranch(remote);
  return { base, root, remote, env };
}

async function withMachineEnvironment(env, operation) {
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return await operation(); }
  finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('repository identity authority is governed, clone-independent, and credential-free', {
  concurrency: false, timeout: 60_000
}, async (t) => {
  const fixture = await repository(t);
  await withMachineEnvironment(fixture.env, async () => {
    await assert.rejects(
      () => resolveWorldModelRepositoryIdentityAuthority(fixture.root, {
        capabilityId: 'application-api'
      }),
      (error) => error?.code === 'WMP_REPOSITORY_AUTHORITY_UNGOVERNED'
    );

    const first = await withApprovedConfigurationRead(fixture.root, () => (
      resolveWorldModelRepositoryIdentityAuthority(fixture.root, {
        capabilityId: 'application-api'
      })
    ), {
      preferAuthority: true, refreshAuthority: true, requireAuthorityRefresh: true
    });
    assert.deepEqual(
      validateWorldModelRepositoryIdentityAuthority(first.repositoryIdentityAuthority),
      first.repositoryIdentityAuthority
    );
    assert.equal(
      assertWorldModelRepositoryIdentityAuthority(
        first.repositoryIdentityAuthority, first.repositoryDomain
      ),
      first.repositoryIdentityAuthority
    );
    const rendered = JSON.stringify(first);
    assert.doesNotMatch(rendered, /:\/\/|application\.git|sflow-wmp-repository-authority/u);

    const clone = path.join(fixture.base, 'second-clone');
    git(fixture.base, 'clone', '-q', fixture.remote, clone);
    const second = await withApprovedConfigurationRead(clone, () => (
      resolveWorldModelRepositoryIdentityAuthority(clone, {
        capabilityId: 'application-api'
      })
    ), {
      preferAuthority: true, refreshAuthority: true, requireAuthorityRefresh: true
    });
    assert.deepEqual(second, first, 'machine paths do not affect governed repository identity');
    assert.deepEqual(first.scopeManifest.allowedPaths, ['src']);
    assert.deepEqual(first.scopeManifest.sharedPaths, ['shared']);

    const other = createWorldModelRepositoryDomain({
      repositoryId: 'another-repository',
      repositoryIdentitySha256: first.repositoryDomain.repositoryIdentitySha256
    });
    assert.throws(
      () => assertWorldModelRepositoryIdentityAuthority(
        first.repositoryIdentityAuthority, other
      ),
      (error) => error?.code === 'WMP_REPOSITORY_AUTHORITY_DOMAIN_MISMATCH'
    );
  });
});

test('accepted Story scope authority is identical to the canonical World-model command scope', {
  concurrency: false, timeout: 90_000
}, async (t) => {
  const fixture = await repository(t);
  await withMachineEnvironment(fixture.env, async () => {
    const started = command(process.execPath, [
      cli, 'start', 'WMP-SCOPE-1', '--isolated-worktree', '--json',
      '--from-branch', 'main', '--work-type', 'quick-fix',
      '--title', 'Preserve exact accepted World-model scope',
      '--description', 'Verify persisted model scope authority against the accepted Story policy.'
    ], fixture.root, { env: fixture.env });
    const storyRoot = JSON.parse(started.stdout).data.repositoryPath;
    const authority = await resolveWorldModelRepositoryIdentityAuthority(storyRoot, {
      capabilityId: 'application-api'
    });
    const config = await loadWorldModelConfig(storyRoot, {
      workId: 'WMP-SCOPE-1'
    });
    const commandScope = createScopeManifest(
      configuredWorldModelV4ScopeOptions(storyRoot, config)
    );

    assert.deepEqual(authority.scopeManifest, commandScope);
    assert.deepEqual(authority.scopeManifest.allowedPaths, ['src']);
    assert.deepEqual(authority.scopeManifest.sharedPaths, ['shared']);
  });
});

test('repository identity authority refuses a checkout that differs from approved portfolio', {
  concurrency: false, timeout: 60_000
}, async (t) => {
  const fixture = await repository(t);
  await withMachineEnvironment(fixture.env, async () => {
    await withApprovedConfigurationRead(fixture.root, async () => {
      git(fixture.root, 'remote', 'set-url', 'origin', 'https://example.test/other.git');
      await assert.rejects(
        () => resolveWorldModelRepositoryIdentityAuthority(fixture.root, {
          capabilityId: 'application-api'
        }),
        (error) => error?.code === 'WMP_REPOSITORY_AUTHORITY_REPOSITORY_MISMATCH'
      );
    }, {
      preferAuthority: true, refreshAuthority: true, requireAuthorityRefresh: true
    });
  });
});

test('repository identity authority refuses a capability that belongs to another repository', {
  concurrency: false, timeout: 60_000
}, async (t) => {
  const fixture = await repository(t);
  await withMachineEnvironment(fixture.env, async () => {
    await withApprovedConfigurationRead(fixture.root, async () => {
      await assert.rejects(
        () => resolveWorldModelRepositoryIdentityAuthority(fixture.root, {
          capabilityId: 'other-api'
        }),
        (error) => error?.code
          === 'WMP_REPOSITORY_AUTHORITY_CAPABILITY_REPOSITORY_MISMATCH'
      );
    }, {
      preferAuthority: true, refreshAuthority: true, requireAuthorityRefresh: true
    });
  });
});

test('Story-backed authority accepts only the canonical aggregate pin, not a copied config record', {
  concurrency: false, timeout: 60_000
}, async (t) => {
  const fixture = await repository(t);
  await withMachineEnvironment(fixture.env, async () => {
    const approved = await withApprovedConfigurationRead(fixture.root, () => (
      resolveLifecycleCapability(fixture.root, {
        capabilityId: 'application-api', required: true, refuseAmbiguous: true
      })
    ), {
      preferAuthority: true, refreshAuthority: true, requireAuthorityRefresh: true
    });
    const pinned = structuredClone(approved.effectiveResolution);
    pinned.policy = { ...pinned.policy, gateSeverity: 'warn' };
    pinned.policySha256 = sha256(pinned.policy);
    const resolutionCore = structuredClone(pinned);
    delete resolutionCore.resolutionSha256;
    delete resolutionCore.policy;
    pinned.resolutionSha256 = sha256(resolutionCore);

    const storyMap = {
      ...approved.map,
      authority: 'pinned-story-configuration'
    };
    const canonicalWorkflow = {
      resolution: {
        configurationSource: {
          repository: storyMap.repository,
          branch: storyMap.branch,
          commit: storyMap.commit,
          files: { 'singularity/capabilities.yml': storyMap.sha256 },
          filesSha256: sha256({ fixture: 'configuration-files' })
        },
        capability: {
          id: approved.id,
          map: storyMap,
          effectiveResolution: pinned
        }
      }
    };
    assert.equal(
      selectPinnedStoryCapabilityResolution(canonicalWorkflow, {
        id: approved.id, map: storyMap
      }, {
        suppliedResolution: pinned,
        currentConfigurationSource: canonicalWorkflow.resolution.configurationSource
      }).resolutionSha256,
      pinned.resolutionSha256
    );
    assert.throws(
      () => selectPinnedStoryCapabilityResolution(canonicalWorkflow, {
        id: approved.id, map: storyMap
      }, {
        suppliedResolution: approved.effectiveResolution,
        currentConfigurationSource: canonicalWorkflow.resolution.configurationSource
      }),
      (error) => error?.code === 'WMP_STORY_CAPABILITY_PIN_MISMATCH'
    );
    assert.throws(
      () => selectPinnedStoryCapabilityResolution(canonicalWorkflow, {
        id: approved.id, map: storyMap
      }, {
        suppliedResolution: pinned,
        currentConfigurationSource: {
          ...canonicalWorkflow.resolution.configurationSource,
          filesSha256: sha256({ fixture: 'rewritten-files' })
        }
      }),
      (error) => error?.code === 'WMP_STORY_CAPABILITY_PIN_MISMATCH',
      'rewritten asset hashes cannot inherit the Story configuration commit'
    );

    await materializeConfigurationSnapshot(fixture.root, { remote: fixture.remote });
    await assert.rejects(
      () => resolveWorldModelRepositoryIdentityAuthority(fixture.root, {
        capabilityId: 'application-api'
      }),
      (error) => error?.code === 'WMP_STORY_CAPABILITY_PIN_REQUIRED'
    );
    await assert.rejects(
      () => resolveWorldModelRepositoryIdentityAuthority(fixture.root, {
        capabilityId: 'application-api', pinnedCapabilityResolution: pinned
      }),
      (error) => error?.code === 'WMP_STORY_CAPABILITY_PIN_REQUIRED',
      'a copied configuration-source record plus a caller-supplied resolution is not a Story pin'
    );
    assert.notEqual(pinned.resolutionSha256, approved.effectiveResolution.resolutionSha256);
  });
});
