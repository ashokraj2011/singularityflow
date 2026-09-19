import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  capabilityMapMode, editCapability, materializeImplicitCapability,
  normalizeCapabilityOwnership, resolveCapabilityOwner, resolveImplicitCapability,
  validateCapabilities
} from '../src/capabilities.mjs';
import {
  registeredCapabilityAuthorityProvenance, resolveLifecycleCapability
} from '../src/capability-context.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { remoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { run } from '../src/util.mjs';

const REMOTE = 'https://example.test/acme/payments-service.git';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pcd-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'PCD Test'], { cwd: root });
  run('git', ['config', 'user.email', 'pcd@example.test'], { cwd: root });
  run('git', ['remote', 'add', 'origin', REMOTE], { cwd: root });
  await initializeDefinition(root);
  return root;
}

test('ordinary initialization keeps capability authority implicit and clone-stable', async () => {
  const left = await repository();
  const right = await repository();
  await assert.rejects(readFile(path.join(left, 'singularity/capabilities.yml'), 'utf8'), { code: 'ENOENT' });
  const [first, second] = await Promise.all([
    resolveLifecycleCapability(left, { required: true }),
    resolveLifecycleCapability(right, { required: true })
  ]);
  assert.equal(first.mode, 'implicit');
  assert.equal(first.id, 'repository-root');
  assert.equal(first.name, 'This repository');
  assert.equal(first.resolutionSha256, second.resolutionSha256);
  assert.deepEqual(first.sourceScope, { sourceRoots: [], sharedRoots: [] });
});

test('ordinary capability resolution ignores ambient repository selectors during portfolio matching', async (t) => {
  const root = await repository();
  const decoy = await mkdtemp(path.join(os.tmpdir(), 'sflow-pcd-decoy-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(decoy, { recursive: true, force: true })
  ]));
  run('git', ['init', '-q', '-b', 'main'], { cwd: decoy });
  run('git', ['remote', 'add', 'origin', 'https://example.test/acme/decoy.git'], { cwd: decoy });
  await writeFile(path.join(root, 'singularity/portfolio.yml'), `version: 1
repositories:
  payments-service:
    url: ${REMOTE}
  decoy-service:
    url: https://example.test/acme/decoy.git
`, 'utf8');

  const previousGitDir = process.env.GIT_DIR;
  const previousWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(decoy, '.git');
  process.env.GIT_WORK_TREE = decoy;
  try {
    const resolved = await resolveLifecycleCapability(root, { required: true });
    assert.equal(resolved.repositoryId, 'payments-service');
    assert.equal(resolved.map.repository, REMOTE);
    assert.equal(resolved.effectiveResolution.repository.identitySha256,
      `sha256:${remoteFingerprint(REMOTE)}`);
  } finally {
    if (previousGitDir == null) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
    if (previousWorkTree == null) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousWorkTree;
  }
});

test('capability inspection can shadow typed Git provenance without changing resolved authority', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'singularity/capabilities.yml'), `version: 2
management:
  mode: sflow-cli
capabilities:
  repository-root:
    name: This repository
    kind: delivery
    repository: payments-service
    sourceRoots: []
`, 'utf8');
  const observations = [];
  const reference = await resolveLifecycleCapability(root, { required: true });
  const shadow = await resolveLifecycleCapability(root, {
    required: true,
    gitReadMode: 'shadow',
    onGitShadowComparison(value) { observations.push(value); }
  });
  assert.deepEqual(shadow, reference);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].operation, 'capability.authority-provenance');
  assert.equal(observations[0].outcome, 'equivalent');
  assert.equal(observations[0].valuesRecorded, false);
});

test('GAL capability provenance shadow agrees for detached HEAD and absent remote', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'singularity/capabilities.yml'), `version: 2
management:
  mode: sflow-cli
capabilities:
  repository-root:
    name: This repository
    kind: delivery
    repository: payments-service
    sourceRoots: []
`, 'utf8');
  run('git', ['add', 'singularity/capabilities.yml'], { cwd: root });
  run('git', ['commit', '-qm', 'capability baseline'], { cwd: root });
  run('git', ['checkout', '--detach', '-q'], { cwd: root });
  run('git', ['remote', 'remove', 'origin'], { cwd: root });
  const observations = [];
  const reference = await resolveLifecycleCapability(root, { required: true });
  const shadow = await resolveLifecycleCapability(root, {
    required: true,
    gitReadMode: 'shadow',
    onGitShadowComparison(value) { observations.push(value); }
  });
  assert.deepEqual(shadow, reference);
  assert.equal(reference.map.repository, null);
  assert.equal(reference.map.branch, null);
  assert.equal(reference.map.commit, run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim());
  assert.equal(observations.length, 1);
  assert.equal(observations[0].outcome, 'equivalent');
  assert.equal(observations[0].valuesRecorded, false);
});

test('capability provenance uses the registered fail-closed read by default', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'singularity/capabilities.yml'), `version: 2
management:
  mode: sflow-cli
capabilities:
  repository-root:
    name: This repository
    kind: delivery
    repository: payments-service
    sourceRoots: []
`, 'utf8');
  run('git', ['config', '--local', '--add', 'remote.origin.url',
    'https://example.test/acme/other.git'], { cwd: root });

  await assert.rejects(
    resolveLifecycleCapability(root, { required: true }),
    (error) => error.code === 'GIT_QUERY_RESULT_AMBIGUOUS'
  );
  await assert.rejects(
    resolveLifecycleCapability(root, { required: true, gitReadMode: 'shadow' }),
    (error) => error.code === 'GIT_QUERY_RESULT_AMBIGUOUS'
  );
  const legacy = await resolveLifecycleCapability(root, {
    required: true, gitReadMode: 'reference'
  });
  assert.ok([REMOTE, 'https://example.test/acme/other.git'].includes(legacy.map.repository),
    'the explicit compatibility reader remains available for qualification only');
});

test('registered capability provenance keeps the legacy three-process budget', () => {
  const calls = [];
  const result = registeredCapabilityAuthorityProvenance('/repository', {
    isRepositoryRoot: () => true,
    query(root, id, params = {}) {
      calls.push({ root, id, params });
      return id === 'repository.remote-url' ? REMOTE
        : id === 'repository.branch' ? 'main' : 'a'.repeat(40);
    }
  });
  assert.deepEqual(result, {
    repository: REMOTE, branch: 'main', commit: 'a'.repeat(40)
  });
  assert.deepEqual(calls.map(({ id }) => id), [
    'repository.remote-url', 'repository.branch', 'repository.head'
  ]);
  assert.equal(calls[0].params.remote, 'origin');
});

test('registered capability provenance does not search above a Git-less approved projection', () => {
  let calls = 0;
  assert.deepEqual(registeredCapabilityAuthorityProvenance('/verified/projection', {
    isRepositoryRoot: () => false,
    query() { calls += 1; throw new Error('must not run'); }
  }), { repository: null, branch: null, commit: null });
  assert.equal(calls, 0);
});

test('Git-less capability projections bind resolution to an explicit verified checkout', async () => {
  const application = await repository();
  const projection = await mkdtemp(path.join(os.tmpdir(), 'sflow-pcd-projection-'));
  await initializeDefinition(projection);
  await writeFile(path.join(projection, 'singularity/capabilities.yml'), `version: 2
management:
  mode: sflow-cli
capabilities:
  payments:
    name: Payments
    kind: delivery
    repository: payments-service
    sourceRoots: []
`, 'utf8');

  const resolved = await resolveLifecycleCapability(projection, {
    capabilityId: 'payments',
    required: true,
    repositoryContext: {
      root: application,
      remote: 'origin',
      repositoryId: 'payments-service'
    }
  });
  assert.equal(resolved.repositoryId, 'payments-service');
  assert.deepEqual(resolved.effectiveResolution.repository, {
    id: 'payments-service',
    identitySha256: `sha256:${remoteFingerprint(REMOTE)}`
  });
  await assert.rejects(
    resolveLifecycleCapability(projection, {
      capabilityId: 'payments',
      required: true,
      repositoryContext: {
        root: projection,
        remote: 'origin',
        repositoryId: 'payments-service'
      }
    }),
    { code: 'CAPABILITY_REPOSITORY_CONTEXT_INVALID' }
  );
});

test('implicit materialization retains repository-root and produces a managed v2 map', () => {
  const implicit = resolveImplicitCapability({
    repositoryId: 'payments-service',
    repositoryIdentitySha256: `sha256:${'a'.repeat(64)}`,
    approvedConfigurationSha256: `sha256:${'b'.repeat(64)}`,
    approvalProfile: 'team'
  });
  const explicit = validateCapabilities(materializeImplicitCapability(implicit));
  assert.equal(capabilityMapMode(explicit), 'explicit-managed');
  assert.equal(explicit.capabilities['repository-root'].repository, 'payments-service');
  assert.deepEqual(explicit.capabilities['repository-root'].sourceRoots, []);
  assert.equal(explicit.management.materializedFrom.resolutionSha256, implicit.resolutionSha256);
});

test('ownership accepts only trailing double-star shorthand and resolves longest prefix', () => {
  assert.equal(normalizeCapabilityOwnership('./services/payments/**'), 'services/payments');
  assert.throws(() => normalizeCapabilityOwnership('services/*/src'), { code: 'PCD_PATH_INVALID' });
  const definition = validateCapabilities({
    version: 2,
    management: { mode: 'sflow-cli' },
    capabilities: {
      'repository-root': {
        name: 'This repository', kind: 'delivery', repository: 'repo', sourceRoots: []
      },
      payments: {
        name: 'Payments', kind: 'delivery', parent: 'repository-root', repository: 'repo',
        sourceRoots: ['services/payments']
      },
      ledger: {
        name: 'Ledger', kind: 'delivery', parent: 'payments', repository: 'repo',
        sourceRoots: ['services/payments/ledger']
      }
    }
  });
  assert.equal(resolveCapabilityOwner(definition, 'services/payments/ledger/src/a.ts').capabilityId, 'ledger');
  assert.equal(resolveCapabilityOwner(definition, 'README.md').capabilityId, 'repository-root');
});

test('managed maps refuse compatibility edits without a registered mutation', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'singularity/capabilities.yml'), `version: 2
management:
  mode: sflow-cli
capabilities:
  repository-root:
    name: This repository
    kind: delivery
    repository: payments-service
    sourceRoots: []
`, 'utf8');
  await assert.rejects(
    editCapability(root, 'repository-root', { name: 'Changed directly' }),
    { code: 'PCD_MANAGED_EDIT_REQUIRED' }
  );
});

test('legacy maps stay legacy while managed dependencies require exact immutable contracts', () => {
  const legacy = validateCapabilities({
    version: 1,
    capabilities: {
      payments: { name: 'Payments', kind: 'delivery', repository: 'repo' }
    }
  });
  assert.equal(capabilityMapMode(legacy), 'explicit-legacy');

  const exact = {
    capability: 'model-serving',
    contract: {
      id: 'inference-api', version: '8',
      sha256: `sha256:${'c'.repeat(64)}`,
      publicationSha256: `sha256:${'d'.repeat(64)}`,
      publisherAuthority: 'platform-contract-authority'
    }
  };
  assert.doesNotThrow(() => validateCapabilities({
    version: 2, management: { mode: 'sflow-cli' },
    capabilities: {
      'repository-root': {
        name: 'This repository', kind: 'delivery', repository: 'repo', dependencies: [exact]
      }
    }
  }));
  assert.throws(() => validateCapabilities({
    version: 2, management: { mode: 'sflow-cli' },
    capabilities: {
      'repository-root': {
        name: 'This repository', kind: 'delivery', repository: 'repo',
        dependencies: [{ ...exact, contract: { ...exact.contract, version: 'latest' } }]
      }
    }
  }), /version/);
});

test('managed dependency cycles are refused deterministically', () => {
  const contract = (capability, salt) => ({
    capability,
    contract: {
      id: `${capability}-api`, version: '1',
      sha256: `sha256:${salt.repeat(64)}`,
      publicationSha256: `sha256:${salt.repeat(64)}`,
      publisherAuthority: 'contract-authority'
    }
  });
  assert.throws(() => validateCapabilities({
    version: 2, management: { mode: 'sflow-cli' },
    capabilities: {
      first: { name: 'First', kind: 'delivery', repository: 'repo', dependencies: [contract('second', 'e')] },
      second: { name: 'Second', kind: 'delivery', repository: 'repo', dependencies: [contract('first', 'f')] }
    }
  }), { code: 'PCD_DEPENDENCY_CYCLE' });
});

test('PCD durable families are registered before writing', () => {
  for (const family of [
    'effective-capability-resolution', 'capability-map', 'capability-change',
    'capability-materialization-equivalence', 'capability-dependency-resolution',
    'capability-explanation', 'capability-managed-adoption'
  ]) assert.ok(currentSchemaVersion(family) >= 1, family);
});
