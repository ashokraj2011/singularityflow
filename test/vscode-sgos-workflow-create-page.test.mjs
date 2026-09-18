import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  sgosWorkflowCreateHtml, sgosWorkflowPageReady, SGOS_WORKFLOW_CREATE_SCRIPT
} = await import(path.join(root, 'apps/vscode/src/views/sgos-workflow-create-page.ts'));

const digest = `sha256:${'a'.repeat(64)}`;
const guide = {
  intent: { intentId: 'INT-1', objective: 'Build an audited report', clauseCount: 3 },
  clauses: [{ clauseId: 'SUCCESS-001', field: 'successCriteria', statement: 'Report passes verification', required: true }],
  eligibleOperations: [{
    id: 'report.build', guidedRole: 'operation', verificationOperationIds: ['report.verify']
  }],
  eligibleVerificationOperations: [
    { id: 'report.verify', guidedRole: 'verifier' },
    { id: 'unrelated.verify', guidedRole: 'verifier' }
  ],
  installedLimits: { maximumAttemptsPerTask: 2 }
};

function state() {
  return {
    repository: '/work/repo',
    intentPath: 'reviewed/intent-ir.json',
    policyPath: 'reviewed/policy.json',
    registryPath: 'reviewed/registry.json',
    guide,
    selection: {
      id: 'verified-report', title: 'Verified report', operation: 'report.build',
      verificationOperation: 'report.verify', storageProfileSha256: digest,
      maximumAttempts: 1, outputRef: 'artifact:result',
      declarationOut: 'singularity/sgos-drafts/verified-report/workflow-declaration.json',
      workflowOut: 'singularity/sgos-drafts/verified-report/workflow-ir.json'
    }
  };
}

test('SGOS creator page is explicit, accessible, and labels the unratified boundary', () => {
  const html = sgosWorkflowCreateHtml(state());
  for (const label of ['Confirmed Intent IR', 'Policy snapshot', 'Operation registry snapshot',
    'Governed operation', 'Independent verifier', 'Stable workflow ID', 'Storage profile SHA-256',
    'Declaration JSON', 'Workflow IR JSON']) assert.match(html, new RegExp(label));
  assert.match(html, /This is not a Story phase workflow/);
  assert.match(html, /Review Intent clauses/);
  assert.match(html, /SUCCESS-001/);
  assert.match(html, /two uncommitted, unratified review files/);
  assert.match(html, /does not ratify, compile, approve, execute, commit, or push/);
  assert.match(html, /data-sgos-create="1">Create review files/);
  assert.equal(sgosWorkflowPageReady(state()), true);
  assert.match(SGOS_WORKFLOW_CREATE_SCRIPT, /type: 'browse'/);
  assert.match(SGOS_WORKFLOW_CREATE_SCRIPT, /window\.__sfVscode/);
  assert.doesNotMatch(SGOS_WORKFLOW_CREATE_SCRIPT, /acquireVsCodeApi\(/);
  assert.match(SGOS_WORKFLOW_CREATE_SCRIPT, /type: 'guide'/);
  assert.match(SGOS_WORKFLOW_CREATE_SCRIPT, /type: 'change'/);
  assert.match(SGOS_WORKFLOW_CREATE_SCRIPT, /type: 'create'/);
  assert.match(SGOS_WORKFLOW_CREATE_SCRIPT, /fields: currentFields\(\)/,
    'clicks use the latest visible fields even if an input has not blurred yet');
  assert.doesNotThrow(() => new Function(SGOS_WORKFLOW_CREATE_SCRIPT));
});

test('SGOS creator page never offers unrelated or unpaired verifiers', () => {
  const html = sgosWorkflowCreateHtml(state());
  assert.match(html, /<option value="report\.verify" selected>/);
  assert.doesNotMatch(html, /<option value="unrelated\.verify"/);
  const noPair = {
    ...state(), guide: {
      ...guide, eligibleOperations: [{
        id: 'report.build', guidedRole: 'operation', verificationOperationIds: []
      }]
    }
  };
  assert.equal(sgosWorkflowPageReady(noPair), false);
  assert.match(sgosWorkflowCreateHtml(noPair), /data-sgos-create="1" disabled/);
});

test('SGOS creator page escapes repository, guide, and error values', () => {
  const html = sgosWorkflowCreateHtml({
    ...state(), repository: '/work/<script>alert(1)</script>',
    error: '<img src=x onerror=alert(1)>',
    guide: { ...guide, intent: { ...guide.intent, objective: '<b>unsafe</b>' } }
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=/);
  assert.doesNotMatch(html, /<b>unsafe/);
  assert.match(html, /&lt;b&gt;unsafe&lt;\/b&gt;/);
});

test('SGOS creator page blocks invalid paths, stale guides, and unresolved clauses', () => {
  assert.equal(sgosWorkflowPageReady({ ...state(), intentPath: '../outside.json' }), false);
  assert.equal(sgosWorkflowPageReady({ ...state(), guide: undefined }), false);
  const blocked = {
    ...state(), guide: {
      ...guide, blockers: [{ code: 'UNRESOLVED', message: 'Human decision required' }]
    }
  };
  assert.equal(sgosWorkflowPageReady(blocked), false);
  assert.match(sgosWorkflowCreateHtml(blocked), /Human decision required/);
  assert.match(sgosWorkflowCreateHtml(blocked), /data-sgos-create="1" disabled/);
  assert.equal(sgosWorkflowPageReady({ ...state(), busy: true }), false);
});
