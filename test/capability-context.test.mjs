import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  applyCapabilityPolicyToInitiativeResolution,
  applyCapabilityPolicyToWorkResolution,
  assertCapabilitySource,
  isLocalCapabilityRepository,
  materializeCapabilityWorldModelPack,
  resolveCapabilityWorldModelCandidate,
  renderCapabilityWorldModelPack
} from '../src/capability-context.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { snapshot } from '../src/util.mjs';
import { initiativePublicationMode } from '../src/initiative-state.mjs';

const capability = {
  id: 'payments-api',
  policy: {
    approvalMinimum: 2,
    allowSelfApproval: false,
    requiredAuthorityGroups: ['architecture-reviewers'],
    requiredWorldModelViews: ['dev.impact'],
    requiredChecks: ['security-scan'],
    qualityCommands: ['npm test'],
    gateSeverity: 'block',
    contextBoundary: 'new',
    worldModelStaleness: 'fail',
    jiraProjects: ['PAY'],
    jiraFields: ['summary'],
    jiraOperations: ['create-story'],
    storageProviders: ['approved-store'],
    allowedMimeTypes: ['text/markdown']
  }
};

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test('capability publication policy tightens Initiative publication', () => {
  const initiative = (gitPublication) => ({
    resolution: { capability: { policy: { gitPublication } } }
  });
  assert.equal(initiativePublicationMode({ git: { publish: 'off' } }, initiative('warn')), 'warn');
  assert.equal(initiativePublicationMode({ git: { publish: 'off' } }, initiative('required')), 'required');
  assert.equal(initiativePublicationMode({ git: { publish: 'required' } }, initiative('off')), 'required');
});

test('capability policy becomes an enforceable part of Story resolution', () => {
  const resolved = applyCapabilityPolicyToWorkResolution({
    approvalAuthorities: { 'architecture-reviewers': { members: [] } },
    sequenceGates: { default: 'soft', phaseStatus: 'soft' },
    contextPolicy: { onApproval: 'keep', onRejection: 'compact', phaseOverrides: { design: 'compact' } },
    documents: { allowedPhases: ['design'] },
    phases: [{
      id: 'design', writeScope: 'documents', worldModel: { views: ['arch.contracts'] },
      qualityCommands: ['npm run lint'], approval: { authorities: [], minimum: 1, allowSelfApproval: true }
    }]
  }, capability);
  assert.deepEqual(resolved.phases[0].worldModel.views, ['arch.contracts', 'dev.impact']);
  assert.deepEqual(resolved.phases[0].qualityCommands, ['npm run lint', 'npm test']);
  assert.equal(resolved.phases[0].approval.minimum, 2);
  assert.equal(resolved.phases[0].approval.allowSelfApproval, false);
  assert.deepEqual(resolved.phases[0].approval.authorities, ['architecture-reviewers']);
  assert.deepEqual(resolved.sequenceGates, { default: 'hard', phaseStatus: 'hard' });
  assert.deepEqual(resolved.contextPolicy, { onApproval: 'new', onRejection: 'new', phaseOverrides: { design: 'new' } });
  assert.deepEqual(resolved.documents.allowedMimeTypes, ['text/markdown']);
  assert.equal(resolved.worldModelStaleness, 'fail');
  assert.throws(() => applyCapabilityPolicyToWorkResolution({
    approvalAuthorities: {}, phases: []
  }, capability), /unknown approval authority/);
  assert.throws(() => applyCapabilityPolicyToWorkResolution({
    approvalAuthorities: {}, phases: [{ id: 'design', writeScope: 'documents', approval: {} }]
  }, { id: 'locked', policy: { allowedPhases: [] } }), /does not allow workflow phase/);
  assert.throws(() => applyCapabilityPolicyToWorkResolution({
    approvalAuthorities: {}, phases: [{ id: 'design', writeScope: 'documents', approval: {} }]
  }, { id: 'locked', policy: { writeScopes: [] } }), /does not allow write scope/);
});

test('capability Jira scope is enforced at lifecycle intake', () => {
  assert.doesNotThrow(() => assertCapabilitySource(capability, {
    type: 'jira', key: 'PAY-42', url: 'https://jira.example/browse/PAY-42'
  }));
  assert.throws(() => assertCapabilitySource(capability, {
    type: 'jira', key: 'OTHER-42', url: 'https://jira.example/browse/OTHER-42'
  }), /does not allow Jira project/);
});

test('Story capability policy preserves explicit approval-free phases', () => {
  const approval = { mode: 'none', minimum: 0, authorities: [], requiredAuthorities: [], allowSelfApproval: false };
  const resolution = {
    approvalAuthorities: { 'architecture-reviewers': { members: [] } },
    phases: [{ id: 'implement', writeScope: 'source-and-artifact', approval }]
  };
  for (const selected of [{ id: 'default', policy: {} }, capability]) {
    const result = applyCapabilityPolicyToWorkResolution(resolution, selected);
    assert.deepEqual(result.phases[0].approval, approval);
    assert.notEqual(result.phases[0].approval, approval);
  }
});

test('capability policy tightens Initiative gates without inventing approval on mode none', () => {
  const resolved = applyCapabilityPolicyToInitiativeResolution({
    approvalAuthorities: { 'architecture-reviewers': { members: [] } },
    contextPolicy: { onApproval: 'keep', onRejection: 'keep', phaseOverrides: {} },
    jira: {
      allowedHosts: [], allowedProjects: [],
      writePolicy: { operations: ['create-epic', 'create-story'], allowedFields: ['summary', 'description'] }
    },
    storage: {
      defaultProvider: 'unapproved-store', maxBytes: 5000, allowedMimeTypes: [],
      providers: { 'approved-store': { type: 's3' }, 'unapproved-store': { type: 's3' } }
    },
    phases: [{
      id: 'plan', worldModelViews: ['biz.rules'], bundleApproval: { mode: 'individual', minimum: 1 },
      outputs: [{ id: 'plan', approval: { mode: 'individual', minimum: 1 } }],
      checklist: [{ id: 'informational', approval: { mode: 'none', minimum: 0 } }]
    }],
    repositories: { mobile: { requiredChecks: ['build'] } }
  }, capability);
  assert.deepEqual(resolved.phases[0].worldModelViews, ['biz.rules', 'dev.impact']);
  assert.equal(resolved.phases[0].bundleApproval.minimum, 2);
  assert.deepEqual(resolved.phases[0].outputs[0].approval.authorities, ['architecture-reviewers']);
  assert.deepEqual(resolved.phases[0].checklist[0].approval, { mode: 'none', minimum: 0 });
  assert.equal(resolved.phases[0].checklist[0].gate, 'block');
  assert.deepEqual(Object.keys(resolved.storage.providers), ['approved-store']);
  assert.equal(resolved.storage.defaultProvider, 'approved-store');
  assert.deepEqual(resolved.jira.allowedProjects, ['PAY']);
  assert.deepEqual(resolved.jira.writePolicy.operations, ['create-story']);
  assert.deepEqual(resolved.jira.writePolicy.allowedFields, ['summary']);
  assert.deepEqual(resolved.repositories.mobile.requiredChecks, ['build', 'security-scan']);
});

test('capability world-model rendering is phase scoped and hash verified', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-context-'));
  try {
    const directory = path.join(root, 'singularity/work-items/WORK-1/context/capability-world-model/api');
    await mkdir(directory, { recursive: true });
    const contracts = path.join(directory, 'arch.contracts.md');
    const impact = path.join(directory, 'dev.impact.md');
    const hotspots = path.join(directory, 'dev.hotspots.md');
    await writeFile(contracts, '# API contracts\n');
    await writeFile(impact, '# API impact\n');
    await writeFile(hotspots, '# API hotspots\n');
    const entries = await Promise.all([
      ['arch.contracts.md', ['arch.contracts']], ['dev.impact.md', ['dev.impact']],
      ['dev.hotspots.md', ['dev.hotspots']]
    ].map(async ([name, views]) => {
      const info = await snapshot(path.join(directory, name));
      return {
        repositoryId: 'api', sourcePath: `singularity/world-model/views/${name}`,
        path: `singularity/work-items/WORK-1/context/capability-world-model/api/${name}`,
        views, sha256: info.sha256, bytes: info.size
      };
    }));
    const recordPath = path.join(root, 'singularity/work-items/WORK-1/context/capability-world-model.json');
    await writeFile(recordPath, `${JSON.stringify({ files: entries, repositories: [], warnings: [] })}\n`);
    const record = await snapshot(recordPath);
    const rendered = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api', policy: {}, context: {
        path: 'singularity/work-items/WORK-1/context/capability-world-model.json', sha256: record.sha256
      }
    }, { views: ['arch.contracts', 'dev.impact'] });
    assert.match(rendered.text, /API contracts/);
    assert.match(rendered.text, /API impact/);
    assert.doesNotMatch(rendered.text, /API hotspots/);
    assert.equal(rendered.files.length, 2);

    await writeFile(impact, '# changed after pinning\n');
    const advisory = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api', policy: {}, context: {
        path: 'singularity/work-items/WORK-1/context/capability-world-model.json', sha256: record.sha256
      }
    }, { views: ['dev.impact'], grounding: 'warn' });
    assert.equal(advisory.text, '');
    assert.deepEqual(advisory.files, []);
    assert.match(advisory.warnings.join('\n'), /Capability world-model grounding unavailable/);
    // `enforce` acts as warn: changed pinned context is left out, never a refusal.
    const enforced = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api', policy: {}, context: {
        path: 'singularity/work-items/WORK-1/context/capability-world-model.json', sha256: record.sha256
      }
    }, { views: ['dev.impact'], grounding: 'enforce' });
    assert.equal(enforced.text, '');
    assert.match(enforced.warnings.join('\n'), /Capability world-model snapshot changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unavailable or invalid capability world-model context stays advisory under enforce', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-unavailable-'));
  try {
    const recordPath = path.join(root, 'capability-world-model.json');
    await writeFile(recordPath, `${JSON.stringify({
      files: [],
      repositories: [{ id: 'api', status: 'world-model-missing' }],
      warnings: ["Capability repository 'api' has no current world model."]
    })}\n`);
    const record = await snapshot(recordPath);
    const unavailable = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api',
      policy: { worldModelGrounding: 'enforce' },
      context: { path: 'capability-world-model.json', sha256: record.sha256 }
    }, { grounding: 'enforce' });
    assert.equal(unavailable.text, '');
    assert.deepEqual(unavailable.files, []);
    assert.match(unavailable.warnings.join('\n'), /has no current world model/);

    const missingRecord = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api',
      policy: { worldModelGrounding: 'enforce' },
      context: { path: 'missing-context-record.json', sha256: '0'.repeat(64) }
    }, { grounding: 'enforce' });
    assert.equal(missingRecord.text, '');
    assert.match(missingRecord.warnings.join('\n'), /context is unavailable/);

    await writeFile(recordPath, `${JSON.stringify({
      files: [{
        repositoryId: 'api', sourcePath: 'singularity/world-model/core/summary.md',
        path: 'missing-pinned-summary.md', views: ['core'], sha256: 'a'.repeat(64), bytes: 12
      }],
      repositories: [{ id: 'api', status: 'pinned' }], warnings: []
    })}\n`);
    const missingPinRecord = await snapshot(recordPath);
    const missingPin = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api',
      policy: { worldModelGrounding: 'enforce' },
      context: { path: 'capability-world-model.json', sha256: missingPinRecord.sha256 }
    }, { grounding: 'enforce' });
    assert.equal(missingPin.text, '');
    assert.match(missingPin.warnings.join('\n'), /snapshot is unavailable/);

    // Old records did not retain `failureClass`/`reasonCode`, but a v4 remote-access failure did
    // retain its Git classification. Upgrade that recognizable shape at read time so an office
    // authentication/proxy failure cannot block ordinary work after installing the fix.
    await writeFile(recordPath, `${JSON.stringify({
      files: [],
      repositories: [{
        id: 'api', status: 'world-model-invalid',
        classification: 'authentication-required', retryable: true
      }],
      warnings: []
    })}\n`);
    const legacyAvailabilityRecord = await snapshot(recordPath);
    const legacyAvailability = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api',
      policy: { worldModelGrounding: 'enforce' },
      context: { path: 'capability-world-model.json', sha256: legacyAvailabilityRecord.sha256 }
    }, { grounding: 'enforce' });
    assert.equal(legacyAvailability.text, '');
    assert.deepEqual(legacyAvailability.files, []);

    for (const legacyRepository of [
      { id: 'api', status: 'world-model-authority-conflict', refresh: 'offline-cached' },
      {
        id: 'api', status: 'world-model-invalid',
        reasonCode: 'world_model.state_extraction_failed'
      }
    ]) {
      await writeFile(recordPath, `${JSON.stringify({
        files: [], repositories: [legacyRepository], warnings: []
      })}\n`);
      const legacyRecord = await snapshot(recordPath);
      const result = await renderCapabilityWorldModelPack(root, {
        id: 'payments-api',
        policy: { worldModelGrounding: 'enforce' },
        context: { path: 'capability-world-model.json', sha256: legacyRecord.sha256 }
      }, { grounding: 'enforce' });
      assert.equal(result.text, '');
      assert.deepEqual(result.files, []);
    }

    // Invalid sibling context is guidance too: nothing is pinned for it and nothing is refused.
    for (const invalidRepository of [
      { id: 'api', status: 'world-model-invalid' },
      {
        id: 'api', status: 'world-model-invalid',
        classification: 'legacy-unregistered-view'
      }
    ]) {
      await writeFile(recordPath, `${JSON.stringify({
        files: [], repositories: [invalidRepository], warnings: []
      })}\n`);
      const invalidRecord = await snapshot(recordPath);
      const invalid = await renderCapabilityWorldModelPack(root, {
        id: 'payments-api',
        policy: { worldModelGrounding: 'enforce' },
        context: { path: 'capability-world-model.json', sha256: invalidRecord.sha256 }
      }, { grounding: 'enforce' });
      assert.equal(invalid.text, '');
      assert.deepEqual(invalid.files, []);
    }

    // A corrupted sibling is left out; the valid sibling's pinned context is still guidance.
    const pinnedPath = path.join(root, 'pinned-core.md');
    await writeFile(pinnedPath, '# Valid sibling context\n');
    const pinnedInfo = await snapshot(pinnedPath);
    await writeFile(recordPath, `${JSON.stringify({
      files: [{
        repositoryId: 'valid-api', sourcePath: 'singularity/world-model/core/summary.md',
        path: 'pinned-core.md', views: ['core'], sha256: pinnedInfo.sha256, bytes: pinnedInfo.size
      }],
      repositories: [
        { id: 'valid-api', status: 'pinned' },
        { id: 'invalid-api', status: 'world-model-invalid', failureClass: 'integrity' }
      ],
      warnings: []
    })}\n`);
    const mixedRecord = await snapshot(recordPath);
    const mixed = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api',
      policy: { worldModelGrounding: 'enforce' },
      context: { path: 'capability-world-model.json', sha256: mixedRecord.sha256 }
    }, { grounding: 'enforce' });
    assert.match(mixed.text, /Valid sibling context/);
    assert.deepEqual(mixed.files.map((file) => file.repositoryId), ['valid-api']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability materialization records a sibling without a registered model as unavailable, never pinned', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-unbuilt-sibling-'));
  const originalActive = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const originalRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  try {
    const current = path.join(base, 'repos/current');
    const sibling = path.join(base, 'repos/sibling');
    const currentRemote = path.join(base, 'remotes/current.git');
    const siblingRemote = path.join(base, 'remotes/sibling.git');
    for (const [repository, remote] of [[current, currentRemote], [sibling, siblingRemote]]) {
      await mkdir(repository, { recursive: true });
      git(repository, 'init', '-q', '-b', 'main');
      git(repository, 'config', 'user.name', 'Capability Tester');
      git(repository, 'config', 'user.email', 'capability@example.com');
      await writeFile(path.join(repository, 'source.txt'), 'source\n');
      git(repository, 'add', 'source.txt');
      git(repository, 'commit', '-qm', 'source');
      await mkdir(path.dirname(remote), { recursive: true });
      git(repository, 'init', '--bare', '-q', '-b', 'main', remote);
      git(repository, 'remote', 'add', 'origin', remote);
      git(repository, 'push', '-q', '-u', 'origin', 'main');
    }

    // The sibling is a governed registered-v4 repository that has never built its World Model.
    await initializeDefinition(sibling);
    git(sibling, 'add', '.');
    git(sibling, 'commit', '-qm', 'initialize governed sibling');
    git(sibling, 'push', '-q', 'origin', 'main');

    const workspace = {
      version: 1, id: 'exact-bytes', name: 'Exact bytes', path: base,
      anchor: { provider: 'workspace', siteId: 'local', key: 'exact-bytes', title: 'Exact bytes' },
      leadRepository: 'current', capabilityAuthority: { url: currentRemote },
      repositories: {
        current: {
          id: 'current', url: currentRemote, defaultBranch: 'main', required: true,
          path: 'repos/current', capabilities: ['repository-root'],
          clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
        },
        sibling: {
          id: 'sibling', url: siblingRemote, defaultBranch: 'main', required: true,
          path: 'repos/sibling', capabilities: ['repository-root'],
          clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
        }
      },
      capabilities: ['repository-root'],
      directories: { repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira' },
      createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z'
    };
    const active = {
      schemaVersion: 1, workspaceId: workspace.id, workspaceName: workspace.name,
      workspacePath: base, anchorKey: workspace.anchor.key, repositoryId: 'current',
      repositoryPath: current, canonicalRepositoryPath: current, checkoutPath: current,
      repositoryState: 'ready', branch: 'main', capabilities: ['repository-root'],
      repositoryCapabilities: ['repository-root'], storyId: null, selectedAt: '2026-09-03T00:00:00.000Z'
    };
    const activeFile = path.join(base, 'active-workspace.json');
    const registryFile = path.join(base, 'workspaces.json');
    await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
    await writeFile(activeFile, `${JSON.stringify(active, null, 2)}\n`);
    await writeFile(registryFile, `${JSON.stringify({
      schemaVersion: 1,
      workspaces: [{
        id: workspace.id, path: base, name: workspace.name,
        anchorKey: workspace.anchor.key, anchorType: 'Workspace', siteId: 'local',
        leadRepositoryPath: current, openedAt: '2026-09-03T00:00:00.000Z', archivedAt: null
      }]
    }, null, 2)}\n`);
    process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = activeFile;
    process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;

    const itemRelative = 'singularity/work-items/UNBUILT-SIBLING';
    const itemDirectory = path.join(current, itemRelative);
    const result = await materializeCapabilityWorldModelPack(current, {
      id: 'repository-root', path: ['repository-root'], map: { sha256: 'f'.repeat(64) },
      deliveries: [{ repositories: ['current', 'sibling'] }],
      policy: { contextMaxBytes: 64 * 1024 }, sourceScope: null, warnings: []
    }, { itemDirectory, itemRelative, views: [] });
    const record = JSON.parse(await readFile(path.join(current, result.path), 'utf8'));
    assert.deepEqual(record.files, [], 'nothing from the sibling is pinned');
    const siblingEntry = record.repositories.find((entry) => entry.id === 'sibling');
    assert.equal(siblingEntry.status, 'world-model-missing');
    assert.equal(siblingEntry.failureClass, 'availability');
    assert.match(record.warnings.join('\n'), /Capability repository 'sibling' world model is unavailable/);
  } finally {
    if (originalActive == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = originalActive;
    if (originalRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = originalRegistry;
    await rm(base, { recursive: true, force: true });
  }
});

test('an explicit off policy does not inspect optional capability world-model context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-off-'));
  try {
    const result = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api',
      context: { path: 'missing-capability-context.json', sha256: '0'.repeat(64) }
    }, { grounding: 'off' });
    assert.deepEqual(result, { text: '', files: [], warnings: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a Story worktree does not pin its own repository as sibling capability context', () => {
  assert.equal(isLocalCapabilityRepository(
    'calc', 'calc', '/workspace/repos/calc', '/workspace/.story-worktrees/CFA/repos/calc'
  ), true);
  assert.equal(isLocalCapabilityRepository(
    'api', 'calc', '/workspace/repos/api', '/workspace/.story-worktrees/CFA/repos/calc'
  ), false);
});

test('a sibling repository still configured for legacy-v3 is refused by name', async () => {
  await assert.rejects(
    resolveCapabilityWorldModelCandidate(os.tmpdir(), {
      worldModel: { format: 'legacy-v3', outputDir: 'singularity/world-model' }
    }, { views: ['dev.impact'] }),
    (error) => error.code === 'WMB_FORMAT_RETIRED' && /capability repository/.test(error.message)
  );
});
