import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = new URL('../apps/vscode/src/views/designer-page.ts', import.meta.url);
const host = new URL('../apps/vscode/src/views/designer.ts', import.meta.url);
const extensionHost = new URL('../apps/vscode/src/extension.ts', import.meta.url);
const model = new URL('../apps/vscode/src/views/designer-model.ts', import.meta.url);
const loopModel = new URL('../apps/vscode/src/views/workflow-loop-draft.ts', import.meta.url);
const workflowTransferPresentation = new URL(
  '../apps/vscode/src/views/workflow-transfer-presentation.ts', import.meta.url
);
const { designerHtml, DESIGNER_SCRIPT } = await import(page);
const { buildProfiles } = await import(model);
const { workflowLoopIssues } = await import(loopModel);
const { workflowMutationPlanDetail, workflowMutationPlanMarkdown } = await import(workflowTransferPresentation);

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
  assert.match(html, />Generates code<\/span>/);
  assert.match(html, /Provisional classification from the selected phase task contracts/);
  assert.match(DESIGNER_SCRIPT, /claimOwners: value\('\[data-workflow-claim-owners\]'\)/);
});

test('Workflow Designer uses the engine code-generation projection for saved workflow labels', () => {
  const snapshot = {
    definition: {
      workTypes: {
        build: { label: 'Build delivery', description: 'Code path', phases: ['implementation'] },
        review: { label: 'Review only', description: 'Document path', phases: ['review'] },
        legacy: { label: 'Legacy cached', description: 'Classification absent', phases: ['implementation'] }
      },
      phases: {
        implementation: { label: 'Implementation', generation: { task: 'code' } },
        review: { label: 'Review', generation: { task: 'none' } }
      }
    },
    workflowCodeGeneration: {
      build: { generatesCode: true, codePhases: ['implementation'] },
      review: { generatesCode: false, codePhases: [] }
    },
    initiatives: []
  };
  const profiles = buildProfiles(snapshot);
  assert.equal(profiles.find((profile) => profile.id === 'build').generatesCode, true);
  assert.equal(profiles.find((profile) => profile.id === 'review').generatesCode, false);
  assert.equal(profiles.find((profile) => profile.id === 'legacy').generatesCode, undefined,
    'the view does not guess from an implementation phase name or phase task');
  const html = designerHtml('phases', profiles, [], 'build', '', [], 'singularity/portfolio.yml', null);
  assert.match(html, /Build delivery · story · Generates code/);
  assert.match(html, /Review only · story · No code generation/);
  assert.match(html, /Legacy cached · story · Code behavior unavailable/);
  assert.match(html, /title="[^"]*Selecting or starting this workflow does not generate code automatically/);
  assert.match(html, /aria-label="[^"]*code is authored only when a code phase is run/);
});

test('Workflow Designer exposes multi-export, host import, and linked workflow copy', () => {
  const profiles = [
    { id: 'feature', label: 'Feature', description: 'Build a feature.', governs: 'story', phases: [] },
    { id: 'bugfix', label: 'Bug fix', description: 'Repair a defect.', governs: 'story', phases: [] }
  ];
  const exportHtml = designerHtml(
    'phases', profiles, [], 'feature', '', [], 'singularity/portfolio.yml', null,
    null, null, undefined, [], [], '', [], [], [], true, null, [],
    { mode: 'export', selectedWorkflowIds: ['story:feature', 'story:bugfix'], copySourceId: null, copyTargetId: '', copyLabel: '' }
  );
  assert.match(exportHtml, /data-open-workflow-export/);
  assert.match(exportHtml, /data-import-workflows/);
  assert.match(exportHtml, /data-open-workflow-copy/);
  assert.equal((exportHtml.match(/data-workflow-export-id=/g) ?? []).length, 2);
  assert.equal((exportHtml.match(/data-workflow-export-id="[^"]+" checked/g) ?? []).length, 2);
  assert.match(exportHtml, /resolves and deduplicates their phase contracts/);
  assert.match(exportHtml, /Story data, generated work-item artifacts, credentials, local caches, and ledger history are never exported/);

  const copyHtml = designerHtml(
    'phases', profiles, [], 'feature', '', [], 'singularity/portfolio.yml', null,
    null, null, undefined, [], [], '', [], [], [], true, null, [],
    { mode: 'copy', selectedWorkflowIds: [], copySourceId: 'feature', copyTargetId: 'feature-copy', copyLabel: 'Feature copy' }
  );
  assert.match(copyHtml, /Linked workflow copy/);
  assert.match(copyHtml, /data-workflow-copy-id[^>]+value="feature-copy"/);
  assert.match(copyHtml, /reuses the existing shared phase, artifact, template, and agent contracts/);
  assert.match(copyHtml, /Review copy plan…/);
  assert.match(copyHtml, /governed authority creates a review proposal; local authority records a local edit/);
  assert.match(DESIGNER_SCRIPT, /type: 'export-workflows'/);
  assert.match(DESIGNER_SCRIPT, /type: 'import-workflows'/);
  assert.match(DESIGNER_SCRIPT, /type: 'copy-workflow'/);
});

test('Workflow draft omits a provisional code badge when a phase task contract is unavailable', () => {
  const html = designerHtml('phases', [], [], null, '', [], 'singularity/portfolio.yml', null, {
    isNew: true, id: 'unknown-task', label: 'Unknown task', description: '', governs: 'story',
    phases: [{ id: 'custom', label: 'Custom' }], reworkLoops: []
  }, null, undefined, [], [{ id: 'custom', label: 'Custom', governs: 'story' }]);
  assert.doesNotMatch(html, /workflow-code-generation/);
});

test('Workflow edit never guesses from a shared phase when an effective override may differ', () => {
  const html = designerHtml('phases', [], [], null, '', [], 'singularity/portfolio.yml', null, {
    isNew: false, id: 'chore', label: 'Chore', description: '', governs: 'story',
    phases: [{ id: 'implementation', label: 'Implementation' }], reworkLoops: []
  }, null, undefined, [], [{
    id: 'implementation', label: 'Implementation', governs: 'story', task: 'code'
  }]);
  assert.doesNotMatch(html, /Provisional classification/,
    'saved workflows must use the engine projection because a work type can override the shared task');
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
  const extensionCode = await readFile(extensionHost, 'utf8');
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
  assert.match(extensionCode, /\['workflow', 'export'\]/);
  assert.match(extensionCode, /command\.push\('--workflow', workflowId\)/);
  assert.match(extensionCode, /showSaveDialog/);
  assert.match(extensionCode, /showOpenDialog/);
  assert.match(extensionCode, /\['workflow', 'import', source\.fsPath\]/);
  assert.match(extensionCode, /\['workflow', 'copy', message\.sourceId, message\.targetId, '--label', message\.label\]/);
  assert.match(extensionCode, /baseCommand, '--dry-run', '--json'/);
  assert.match(extensionCode, /'--confirm', preview\.confirmation/);
  assert.match(extensionCode, /workflowMutationPlanDetail\(plan\)/);
  assert.match(extensionCode, /workflowMutationPlanMarkdown\(plan, title\)/);
  assert.match(extensionCode, /showTextDocument\(previewDocument, \{ preview: true \}\)/);
  assert.match(extensionCode, /Apply reviewed plan/);
  assert.match(extensionCode, /authority will decide whether this creates a review proposal or a local edit/);
});

test('workflow import confirmation renders every operation beyond eight without truncation', () => {
  const add = Array.from({ length: 12 }, (_, index) => ({
    kind: 'story.phase', id: `phase-${String(index + 1).padStart(2, '0')}`, sha256: `sha256:${index}`
  }));
  const reuse = Array.from({ length: 10 }, (_, index) => ({
    kind: 'agent', id: `agent-${String(index + 1).padStart(2, '0')}`
  }));
  const conflicts = Array.from({ length: 9 }, (_, index) => ({
    kind: 'template', id: `template-${String(index + 1).padStart(2, '0')}`, reason: 'different content'
  }));
  const plan = {
    status: 'blocked', planSha256: `sha256:${'a'.repeat(64)}`,
    operations: { add, reuse, conflicts }, sharedDependencies: { phases: 12, agents: 10 },
    changedPaths: ['singularity/workflow.yml', '.github/agents/developer.agent.md']
  };
  const detail = workflowMutationPlanDetail(plan);
  const markdown = workflowMutationPlanMarkdown(plan, 'Import complete bundle');
  for (const item of [...add, ...reuse, ...conflicts]) {
    assert.match(detail, new RegExp(`${item.kind}:${item.id}`));
    assert.match(markdown, new RegExp(`${item.kind}:${item.id}`));
  }
  assert.match(detail, /Add \(12\):/);
  assert.match(detail, /Reuse exact \(10\):/);
  assert.match(detail, /Conflicts \(9\):/);
  assert.doesNotMatch(detail, /\+\d+ more/);
  assert.match(detail, /Predicted changed paths: singularity\/workflow\.yml, \.github\/agents\/developer\.agent\.md/);
  assert.match(markdown, /## Predicted changed paths \(2\)/);
  assert.match(detail, /governed authority creates a review proposal; local authority records a local edit/);
});
