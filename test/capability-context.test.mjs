import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCapabilityPolicyToInitiativeResolution,
  applyCapabilityPolicyToWorkResolution,
  assertCapabilitySource
} from '../src/capability-context.mjs';
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
