/**
 * What a person reads before a workflow bundle is imported: every operation of the plan, and the
 * exact destination it is bound to. Workflow Studio's Import shows this read-only before confirming.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const workflowTransferPresentation = new URL('../apps/vscode/src/views/workflow-transfer-presentation.ts', import.meta.url);
const {
  workflowImportChoiceItems, workflowImportConflictTitle, workflowImportOpenChoices, workflowImportResolveArgs,
  workflowImportSuggestedChoices, workflowImportSuggestionSummary, workflowMutationPlanDetail, workflowMutationPlanMarkdown,
  workflowMutationPlanSummary
} = await import(workflowTransferPresentation);

const stepConflict = {
  subject: 'phase:release-plan', kind: 'phase', id: 'release-plan', reasons: ['definition: same ID has different content'],
  choices: ['keep', 'replace', 'rename'], suggested: 'rename', renameTo: 'release-plan-imported', usedBy: ['story:mobile-release']
};
const groupConflict = {
  subject: 'approval-group:release-managers', kind: 'approval-group', id: 'release-managers',
  reasons: ['definition: same ID has different content'], choices: ['keep', 'replace', 'rename'], suggested: 'keep',
  renameTo: 'release-managers-imported', usedBy: []
};
const configurationConflict = {
  subject: null, kind: null, id: 'story.configuration:singularity/workflow.yml', reasons: ['configuration: invalid'],
  choices: [], suggested: null, usedBy: []
};

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

test('workflow transfer review displays the exact bound destination, not only its plan digest', () => {
  const destinationAuthority = {
    kind: 'verified-state-mirror', branch: 'sflow/config', commit: 'a'.repeat(40),
    sourceCommit: 'b'.repeat(40), remoteFingerprint: 'c'.repeat(64)
  };
  const plan = { status: 'ready', planSha256: `sha256:${'d'.repeat(64)}`, destinationAuthority };
  for (const rendered of [workflowMutationPlanDetail(plan), workflowMutationPlanMarkdown(plan, 'Copy workflow')]) {
    assert.match(rendered, /Bound destination:/);
    for (const value of Object.values(destinationAuthority)) assert.ok(rendered.includes(value));
    assert.ok(rendered.includes(plan.planSha256));
  }
  for (const rendered of [workflowMutationPlanDetail({}), workflowMutationPlanMarkdown({}, 'Local import')]) {
    assert.match(rendered, /local working-tree content; no remote authorization/);
    assert.doesNotMatch(rendered, /remote fingerprint=/);
  }
});

test('the native import summary names consequences and the exact plan without the full dependency dump', () => {
  const plan = {
    planSha256: `sha256:${'d'.repeat(64)}`, destinationAuthority: { branch: 'sflow/config' },
    operations: { add: Array.from({ length: 52 }, (_, i) => ({ kind: 'agent', id: `agent-${i}` })),
      reuse: [{ id: 'existing' }], replace: [{ id: 'changed' }], keep: [{ id: 'kept' }] },
    renamed: [{ subject: 'agent:developer', to: 'developer-copy' }], changedPaths: ['workflow.yml', 'agent.md']
  };
  const summary = workflowMutationPlanSummary(plan);
  assert.match(summary, /Add 52 · Reuse 1 · Replace 1 · Keep 1/);
  assert.match(summary, /1 renamed · 2 changed files/);
  assert.match(summary, /Destination: sflow\/config/);
  assert.match(summary, /does not approve the workflow/);
  assert.ok(summary.includes(plan.planSha256));
  assert.equal(summary.split('\n').length, 5);
  assert.doesNotMatch(summary, /agent-51/);
  assert.match(workflowMutationPlanDetail(plan), /agent-51/);
  assert.match(workflowMutationPlanSummary({}), /Destination: local working tree/);
});

test('each import conflict offers its choices, the suggested one first, in the person\'s terms', () => {
  const items = workflowImportChoiceItems(stepConflict);
  assert.deepEqual(items.map((item) => item.label), [
    'Import theirs as release-plan-imported', 'Keep yours', 'Replace yours with theirs'
  ]);
  assert.equal(items[0].description, 'suggested');
  assert.deepEqual(items[0].choice, { action: 'rename', to: 'release-plan-imported' });
  assert.equal(items[1].detail, 'The imported workflow uses your step.');
  assert.equal(items[2].detail, 'This also changes story:mobile-release.');
  assert.equal(workflowImportChoiceItems(groupConflict)[0].label, 'Keep yours');
  assert.equal(workflowImportChoiceItems({ ...groupConflict, kind: 'workflow' })[0].detail, 'Theirs is not imported.');
  assert.equal(workflowImportConflictTitle(stepConflict, 0, 2), 'Import conflict 1 of 2: step release-plan');
});

test('suggested import choices become exact --resolve arguments; unresolvable conflicts still block', () => {
  const plan = { status: 'blocked', unresolved: [stepConflict, groupConflict, configurationConflict] };
  const { resolvable, blocking } = workflowImportOpenChoices(plan);
  assert.deepEqual(resolvable.map((item) => item.subject), ['phase:release-plan', 'approval-group:release-managers']);
  assert.deepEqual(blocking, [configurationConflict]);
  const choices = workflowImportSuggestedChoices(resolvable);
  assert.deepEqual(choices, {
    'phase:release-plan': { action: 'rename', to: 'release-plan-imported' }, 'approval-group:release-managers': { action: 'keep' }
  });
  assert.deepEqual(workflowImportResolveArgs(choices), [
    '--resolve', 'approval-group:release-managers=keep', '--resolve', 'phase:release-plan=rename:release-plan-imported'
  ]);
  assert.equal(workflowImportSuggestionSummary(resolvable),
    'Import 1 under new names, keep 1 of yours; nothing of yours changes unless you replace it.');
});

test('a resolved import plan shows new names, replacements and what was kept; an open one shows each choice', () => {
  const resolved = {
    status: 'ready', planSha256: `sha256:${'e'.repeat(64)}`,
    renamed: [{ subject: 'phase:release-plan', to: 'release-plan-imported' }],
    operations: {
      add: [], reuse: [], conflicts: [],
      replace: [{ kind: 'template', id: 'singularity/templates/x.md', subject: 'template-file:singularity/templates/x.md' }],
      keep: [{ kind: 'story.approvalAuthorities', id: 'release-managers', subject: 'approval-group:release-managers' }]
    }
  };
  for (const rendered of [workflowMutationPlanDetail(resolved), workflowMutationPlanMarkdown(resolved, 'Import')]) {
    assert.match(rendered, /New names \(1\)/);
    assert.match(rendered, /phase:release-plan → release-plan-imported/);
    assert.match(rendered, /Replace yours \(1\)/);
    assert.match(rendered, /Keep yours \(1\)/);
  }
  const open = workflowMutationPlanMarkdown({ status: 'blocked', unresolved: [stepConflict, configurationConflict] }, 'Import');
  assert.match(open, /## Choices needed \(2\)/);
  assert.match(open, /Choice: \*\*Import theirs as release-plan-imported\*\*/);
  assert.match(open, /Used here by: story:mobile-release/);
  assert.match(open, /No choice resolves this/);
});
