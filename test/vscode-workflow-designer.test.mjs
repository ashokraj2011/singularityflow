import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = new URL('../apps/vscode/src/views/designer-page.ts', import.meta.url);
const host = new URL('../apps/vscode/src/views/designer.ts', import.meta.url);
const { designerHtml, DESIGNER_SCRIPT } = await import(page);

test('Workflow Designer browser script remains valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(DESIGNER_SCRIPT));
});

test('Story workflow draft shows planned claims and a phase-contract simulation before save', () => {
  const draft = {
    isNew: true, id: 'custom-delivery', label: 'Custom delivery', description: '',
    governs: 'story', phases: [
      { id: 'specification', label: 'Specification' },
      { id: 'implementation', label: 'Implementation' }
    ], plannedClaimsMode: 'required', clausePhases: '', claimOwners: '', optOutReason: ''
  };
  const choices = [
    { id: 'specification', label: 'Specification', governs: 'story', artifactKind: 'requirements',
      template: 'spec-driven/spec.md', inputs: ['intake'], authorities: ['product-approvers'],
      minimumApprovals: 1, views: ['business'], task: 'analyze' },
    { id: 'implementation', label: 'Implementation', governs: 'story', artifactKind: 'implementation',
      template: 'common/implementation.md', inputs: ['specification'], authorities: ['engineering-reviewers'],
      minimumApprovals: 2, views: ['development'], task: 'code' }
  ];
  const html = designerHtml('phases', [], [], null, '', [], 'singularity/portfolio.yml', null,
    draft, null, undefined, [], choices);
  assert.match(html, /data-workflow-planned-claims/);
  assert.match(html, /Eligible in this sequence: specification/);
  assert.match(html, /Draft simulation · phase contracts/);
  assert.match(html, /spec-driven\/spec\.md/);
  assert.match(html, /2 \(engineering-reviewers\)/);
  assert.match(html, /implementation=specification/);
  assert.match(html, /Create workflow/);
  assert.match(DESIGNER_SCRIPT, /claimOwners: value\('\[data-workflow-claim-owners\]'\)/);
});

test('phase editor exposes code task and configured approval groups without inventing authority', () => {
  const draft = { isNew: true, id: '', label: '', governs: 'story', views: '', agents: '', lanes: '',
    task: 'code', approvalAuthorities: 'product-approvers', approvalMinimum: 2 };
  const html = designerHtml('phases', [], [], null, '', [], 'singularity/portfolio.yml', null,
    null, draft, undefined, [], [], '', [], [], [], true, null, ['product-approvers']);
  assert.match(html, /Generation task/);
  assert.match(html, /Only Code instructs the phase agent to implement application changes/);
  assert.match(html, /<option value="code" selected>/);
  assert.match(html, /data-phase-authorities/);
  assert.match(html, /Configured groups: product-approvers/);
  assert.match(html, /data-phase-minimum[^>]+value="2"/);
  assert.match(DESIGNER_SCRIPT, /task: document\.querySelector\('\[data-phase-task\]'\)/);
});

test('Designer host sends explicit governed CLI policy flags and checks eligibility before mutation', async () => {
  const code = await readFile(host, 'utf8');
  assert.match(code, /command\.push\('--planned-claims', draft\.plannedClaimsMode/);
  assert.match(code, /command\.push\('--clause-phases'/);
  assert.match(code, /command\.push\('--claim-owners'/);
  assert.match(code, /command\.push\('--opt-out-reason'/);
  assert.match(code, /Eligible phases in this workflow/);
  assert.match(code, /command\.push\('--task', this\.phaseDraft\.task/);
  assert.match(code, /'--authorities'/);
  assert.match(code, /'--minimum'/);
});
