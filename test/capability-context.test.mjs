import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  applyCapabilityPolicyToInitiativeResolution,
  applyCapabilityPolicyToWorkResolution,
  assertCapabilitySource,
  isLocalCapabilityRepository,
  renderCapabilityWorldModelPack
} from '../src/capability-context.mjs';
import { snapshot } from '../src/util.mjs';
import { initiativePublicationMode } from '../src/initiative-state.mjs';

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
