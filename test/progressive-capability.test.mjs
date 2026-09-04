import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  capabilityMapMode, editCapability, materializeImplicitCapability,
  normalizeCapabilityOwnership, resolveCapabilityOwner, resolveImplicitCapability,
  validateCapabilities
} from '../src/capabilities.mjs';
import { resolveLifecycleCapability } from '../src/capability-context.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
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
