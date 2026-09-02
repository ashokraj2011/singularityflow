import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  applyCapabilityPolicyToInitiativeResolution,
  applyCapabilityPolicyToWorkResolution,
  assertCapabilitySource,
  isLocalCapabilityRepository,
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

async function seedCapabilityModel(root, sourceTreeSha256, label) {
  const directory = path.join(root, 'singularity/world-model');
  await rm(directory, { recursive: true, force: true });
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'views'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'core/summary.brief.md'), `# ${label} brief\n`);
  await writeFile(path.join(directory, 'core/summary.md'), `# ${label} full\n`);
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
