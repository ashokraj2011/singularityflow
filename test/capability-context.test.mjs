import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
import { worldModelSourceSnapshot } from '../src/grounding.mjs';
import { snapshot } from '../src/util.mjs';
import { initiativePublicationMode } from '../src/initiative-state.mjs';
import { writeV3Manifest } from '../src/world-model-materialization.mjs';

const capability = {
  id: 'payments-api',
  policy: {
    approvalMinimum: 2,
    allowSelfApproval: false,
    requiredAuthorityGroups: ['architecture-reviewers'],
    requiredWorldModelViews: ['security'],
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

async function seedCapabilityModel(root, sourceTreeSha256, label, {
  fullTrailingNewline = true
} = {}) {
  const directory = path.join(root, 'singularity/world-model');
  await rm(directory, { recursive: true, force: true });
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'views'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'core/summary.brief.md'), `# ${label} brief\n`);
  await writeFile(
    path.join(directory, 'core/summary.md'),
    `# ${label} full${fullTrailingNewline ? '\n' : ''}`
  );
  await writeFile(path.join(directory, 'core/model.json'), '{}\n');
  await writeFile(path.join(directory, 'path-index.json'), '{}\n');
  await writeFile(path.join(directory, 'views/security.md'), `# ${label} security\n`);
  await writeFile(path.join(directory, 'evidence/evidence.jsonl'), '{"id":"E-1"}\n');
  await writeV3Manifest(directory, {
    schema_version: '3.0',
    generated_at: '2026-08-31T00:00:00.000Z',
    generated_date: '31 August 2026',
    builder_version: 'test',
    builder_prompt_sha256: 'a'.repeat(64),
    analysis_depth: 'standard',
    repository_commit: git(root, 'rev-parse', 'main'),
    repository_branch: 'main',
    working_tree_clean: true,
    source_tree_sha256: sourceTreeSha256,
    core: {
      tiers: {
        brief: { status: 'ready', path: 'core/summary.brief.md' },
        full: { status: 'ready', path: 'core/summary.md' }
      },
      model: { path: 'core/model.json' }
    },
    views: {
      security: {
        tiers: {
          brief: { status: 'missing', path: 'views/security.brief.md' },
          full: { status: 'ready', path: 'views/security.md' }
        }
      }
    },
    domains: [], task_guides: [],
    path_index: { path: 'path-index.json' },
    evidence: { path: 'evidence/evidence.jsonl' },
    materializations: []
  });
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
      id: 'design', writeScope: 'documents', worldModel: { views: ['architecture'] },
      qualityCommands: ['npm run lint'], approval: { authorities: [], minimum: 1, allowSelfApproval: true }
    }]
  }, capability);
  assert.deepEqual(resolved.phases[0].worldModel.views, ['architecture', 'security']);
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
      id: 'plan', worldModelViews: ['business'], bundleApproval: { mode: 'individual', minimum: 1 },
      outputs: [{ id: 'plan', approval: { mode: 'individual', minimum: 1 } }],
      checklist: [{ id: 'informational', approval: { mode: 'none', minimum: 0 } }]
    }],
    repositories: { mobile: { requiredChecks: ['build'] } }
  }, capability);
  assert.deepEqual(resolved.phases[0].worldModelViews, ['business', 'security']);
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
    const core = path.join(directory, 'summary.md');
    const security = path.join(directory, 'security.md');
    const testing = path.join(directory, 'testing.md');
    await writeFile(core, '# API summary\n');
    await writeFile(security, '# API security\n');
    await writeFile(testing, '# API tests\n');
    const entries = await Promise.all([
      ['summary.md', ['core']], ['security.md', ['security']], ['testing.md', ['testing']]
    ].map(async ([name, views]) => {
      const info = await snapshot(path.join(directory, name));
      return {
        repositoryId: 'api', sourcePath: `singularity/world-model/${name}`,
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
    }, { views: ['security'] });
    assert.match(rendered.text, /API summary/);
    assert.match(rendered.text, /API security/);
    assert.doesNotMatch(rendered.text, /API tests/);
    assert.equal(rendered.files.length, 2);

    await writeFile(security, '# changed after pinning\n');
    const advisory = await renderCapabilityWorldModelPack(root, {
      id: 'payments-api', policy: {}, context: {
        path: 'singularity/work-items/WORK-1/context/capability-world-model.json', sha256: record.sha256
      }
    }, { views: ['security'], grounding: 'warn' });
    assert.equal(advisory.text, '');
    assert.deepEqual(advisory.files, []);
    assert.match(advisory.warnings.join('\n'), /Capability world-model grounding unavailable/);
    await assert.rejects(
      () => renderCapabilityWorldModelPack(root, {
        id: 'payments-api', policy: {}, context: {
          path: 'singularity/work-items/WORK-1/context/capability-world-model.json', sha256: record.sha256
        }
      }, { views: ['security'], grounding: 'enforce' }),
      /Capability world-model snapshot changed/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unavailable capability world-model context stays advisory under enforce', async () => {
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
    assert.match(unavailable.warnings.join('\n'), /grounding unavailable/);

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
    assert.match(legacyAvailability.warnings.join('\n'), /grounding unavailable/);

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
      assert.match(result.warnings.join('\n'), /grounding unavailable/);
    }

    // Semantic invalidity remains fail-closed; only proven availability failures are advisory.
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
      await assert.rejects(
        () => renderCapabilityWorldModelPack(root, {
          id: 'payments-api',
          policy: { worldModelGrounding: 'enforce' },
          context: { path: 'capability-world-model.json', sha256: invalidRecord.sha256 }
        }, { grounding: 'enforce' }),
        /invalid cross-repository world-model context/
      );
    }

    // One valid sibling must not hide another sibling's corrupted context.
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
    await assert.rejects(
      () => renderCapabilityWorldModelPack(root, {
        id: 'payments-api',
        policy: { worldModelGrounding: 'enforce' },
        context: { path: 'capability-world-model.json', sha256: mixedRecord.sha256 }
      }, { grounding: 'enforce' }),
      /invalid cross-repository world-model context for invalid-api/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability materialization preserves exact model bytes without adding a newline', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-exact-bytes-'));
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
    const siblingSource = await worldModelSourceSnapshot(sibling, {});
    await seedCapabilityModel(sibling, siblingSource.sha256, 'exact sibling', {
      fullTrailingNewline: false
    });

    const workspace = {
      version: 1, id: 'exact-bytes', name: 'Exact bytes', path: base,
      anchor: { provider: 'workspace', siteId: 'local', key: 'exact-bytes', title: 'Exact bytes' },
      leadRepository: 'current', capabilityAuthority: { url: currentRemote },
      repositories: {
        current: {
          id: 'current', url: currentRemote, defaultBranch: 'main', required: true,
          path: 'repos/current', capabilities: ['demo'],
          clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
        },
        sibling: {
          id: 'sibling', url: siblingRemote, defaultBranch: 'main', required: true,
          path: 'repos/sibling', capabilities: ['demo'],
          clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
        }
      },
      capabilities: ['demo'],
      directories: { repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira' },
      createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z'
    };
    const active = {
      schemaVersion: 1, workspaceId: workspace.id, workspaceName: workspace.name,
      workspacePath: base, anchorKey: workspace.anchor.key, repositoryId: 'current',
      repositoryPath: current, canonicalRepositoryPath: current, checkoutPath: current,
      repositoryState: 'ready', branch: 'main', capabilities: ['demo'],
      repositoryCapabilities: ['demo'], storyId: null, selectedAt: '2026-09-03T00:00:00.000Z'
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

    const itemRelative = 'singularity/work-items/EXACT-BYTES';
    const itemDirectory = path.join(current, itemRelative);
    const result = await materializeCapabilityWorldModelPack(current, {
      id: 'demo', path: ['demo'], map: { sha256: 'f'.repeat(64) },
      deliveries: [{ repositories: ['current', 'sibling'] }],
      policy: { contextMaxBytes: 64 * 1024 }, sourceScope: null, warnings: []
    }, { itemDirectory, itemRelative, views: [] });
    const record = JSON.parse(await readFile(path.join(current, result.path), 'utf8'));
    const pinned = record.files.find((entry) => entry.repositoryId === 'sibling');
    assert.ok(pinned);
    const bytes = await readFile(path.join(current, pinned.path));
    assert.equal(bytes.toString('utf8'), '# exact sibling full');
    assert.equal(bytes.at(-1), 'l'.charCodeAt(0));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pinned.sha256);
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

test('sibling capability grounding resolves the exact scoped source from validated state history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-sibling-source-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Capability Tester');
    git(root, 'config', 'user.email', 'capability@example.com');
    await mkdir(path.join(root, 'service'), { recursive: true });
    await mkdir(path.join(root, 'unrelated'), { recursive: true });
    await writeFile(path.join(root, 'service/api.js'), 'export const api = 1;\n');
    await writeFile(path.join(root, 'unrelated/note.txt'), 'one\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'source');

    const sourceScope = { sourceRoots: ['service'], sharedRoots: [] };
    const definition = {
      worldModel: { outputDir: 'singularity/world-model', stateBranch: 'state' },
      ledger: { branch: 'state' }
    };
    const source = await worldModelSourceSnapshot(root, {
      worldModel: { sourceRoots: ['service'], sharedRoots: [] }
    });
    git(root, 'switch', '-qc', 'state');
    await seedCapabilityModel(root, source.sha256, 'matching scoped model');
    git(root, 'add', 'singularity/world-model');
    git(root, 'commit', '-qm', 'matching scoped model');
    const matchingCommit = git(root, 'rev-parse', 'HEAD');

    await seedCapabilityModel(root, `sha256:${'b'.repeat(64)}`, 'different source tip');
    git(root, 'add', '-A', 'singularity/world-model');
    git(root, 'commit', '-qm', 'different source model');
    git(root, 'switch', '-q', 'main');

    // A file outside the capability scope does not invalidate the scoped source identity.
    await writeFile(path.join(root, 'unrelated/note.txt'), 'two\n');
    git(root, 'add', 'unrelated/note.txt');
    git(root, 'commit', '-qm', 'change unrelated source');

    const resolved = await resolveCapabilityWorldModelCandidate(root, definition, {
      sourceScope,
      views: ['security']
    });
    assert.equal(resolved.sourceState.sha256, source.sha256);
    assert.equal(resolved.located.commit, matchingCommit);
    assert.equal(resolved.located.historical, true);
    assert.equal(resolved.located.requestedSourceTreeSha256, source.sha256);
    assert.equal(resolved.located.sourceTreeSha256, source.sha256);

    // A reachable remote that has no state branch is authoritative. The exact local state ref is
    // now an unpublished leftover, not governed sibling context that may be pinned silently.
    const remote = path.join(root, 'origin.git');
    git(root, 'init', '--bare', '-q', '-b', 'main', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-q', '-u', 'origin', 'main');
    await assert.rejects(
      resolveCapabilityWorldModelCandidate(root, definition, { sourceScope, views: ['security'] }),
      (error) => error.code === 'world_model.capability_authority_conflict'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
