import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = new URL('../apps/vscode/src/views/designer-page.ts', import.meta.url);
const host = new URL('../apps/vscode/src/views/designer.ts', import.meta.url);
const loopModel = new URL('../apps/vscode/src/views/workflow-loop-draft.ts', import.meta.url);
const { designerHtml, DESIGNER_SCRIPT } = await import(page);
const { workflowLoopIssues } = await import(loopModel);

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

test('Story workflow editor shows bounded, reviewer-directed backward loops', () => {
  const draft = {
    isNew: false, id: 'spec-code-test-loop', label: 'Spec Code Test', description: '',
    governs: 'story', phases: [
      { id: 'specification', label: 'Specification' },
      { id: 'implementation', label: 'Code' },
      { id: 'testing', label: 'Testing' }
    ],
    reworkLoops: [{ from: 'testing', to: 'implementation', maxAttempts: 3, resetOnPhase: 'specification' }],
    plannedClaimsMode: 'required', clausePhases: '', claimOwners: '', optOutReason: ''
  };
  const html = designerHtml('phases', [], [], null, '', [], 'singularity/portfolio.yml', null,
    draft, null, undefined, [], [
      { id: 'specification', label: 'Specification', governs: 'story', artifactKind: 'requirements' },
      { id: 'implementation', label: 'Code', governs: 'story', task: 'code' },
      { id: 'testing', label: 'Testing', governs: 'story' }
    ]);
  assert.match(html, /data-workflow-loop-row="0"/);
  assert.match(html, /data-loop-from/);
  assert.match(html, /data-loop-to/);
  assert.match(html, /data-loop-max[^>]*value="3"/);
  assert.match(html, /data-loop-reset/);
  assert.match(html, /testing<\/code> ↶ <code>implementation/);
  assert.match(html, /reviewer-directed repair attempts/);
  assert.match(html, /does not run phases, change the specification, or approve work automatically/);
  assert.match(DESIGNER_SCRIPT, /type: 'add-workflow-loop'/);
  assert.match(DESIGNER_SCRIPT, /type: 'remove-workflow-loop'/);
  assert.match(DESIGNER_SCRIPT, /type: 'workflow-loops'/);
  const invalidHtml = designerHtml('phases', [], [], null, '', [], 'singularity/portfolio.yml', null,
    { ...draft, reworkLoops: [{ ...draft.reworkLoops[0], resetOnPhase: 'implementation' }] },
    null, undefined, [], []);
  assert.match(invalidHtml, /data-save-workflow="1" disabled/);
  assert.match(invalidHtml, /reset phase must be earlier than the return phase/);
});

test('loop validation preserves a draft but rejects removed or reordered phases', () => {
  const loops = [{ from: 'testing', to: 'implementation', maxAttempts: 3, resetOnPhase: 'specification' }];
  assert.deepEqual(workflowLoopIssues(['specification', 'implementation', 'testing'], loops), []);
  assert.match(workflowLoopIssues(['specification', 'testing', 'implementation'], loops).join(' '), /earlier than the source/);
  assert.match(workflowLoopIssues(['specification', 'implementation'], loops).join(' '), /source phase in this workflow/);
  assert.match(workflowLoopIssues(['implementation', 'testing'], loops).join(' '), /reset phase must be in this workflow/);
  assert.match(workflowLoopIssues(['specification', 'implementation', 'testing'], [
    { ...loops[0], resetOnPhase: 'implementation' }
  ]).join(' '), /reset phase must be earlier than the return phase/);
  assert.match(workflowLoopIssues(['specification', 'implementation', 'testing'], [
    { ...loops[0], maxAttempts: 0 }
  ]).join(' '), /whole number from 1 through 100/);
  assert.match(workflowLoopIssues(['specification', 'implementation', 'testing'], [loops[0], loops[0]]).join(' '), /already listed/);
  assert.match(workflowLoopIssues(['specification', 'implementation', 'testing', 'conformance'], [
    loops[0], { from: 'conformance', to: 'implementation', maxAttempts: 2, resetOnPhase: 'specification' }
  ]).join(' '), /must use the same maximum attempts and reset phase/);
  assert.match(workflowLoopIssues(['specification', 'implementation', 'testing', 'conformance'], [
    loops[0], { from: 'conformance', to: 'implementation', maxAttempts: 3, resetOnPhase: '' }
  ]).join(' '), /must use the same maximum attempts and reset phase/);
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
  assert.match(code, /workflowLoopIssues\(draft\.phases\.map/);
  assert.match(code, /command\.push\('--loop'/);
  assert.match(code, /command\.push\('--clear-loops'\)/);
});
