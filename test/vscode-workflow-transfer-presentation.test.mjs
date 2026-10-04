/**
 * What a person reads before a workflow bundle is imported: every operation of the plan, and the
 * exact destination it is bound to. Workflow Studio's Import shows this read-only before confirming.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const workflowTransferPresentation = new URL('../apps/vscode/src/views/workflow-transfer-presentation.ts', import.meta.url);
const { workflowMutationPlanDetail, workflowMutationPlanMarkdown } = await import(workflowTransferPresentation);

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
