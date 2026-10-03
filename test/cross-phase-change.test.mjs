import assert from 'node:assert/strict';
import test from 'node:test';

import { crossPhaseChange, describeCrossPhaseChange } from '../src/evidence/cross-phase-change.mjs';
import { projectGateRefusal } from '../src/evidence/gate-refusal.mjs';

const W = 'XPC-1';

function story({ status = 'in_progress', reviewStatus = 'in_progress', rejectTo = ['backend', 'frontend', 'review'] } = {}) {
  const phase = (id, kind, extra = {}) => ({
    id, label: id, status: 'approved', generation: 1, artifacts: [], checks: [], approvals: [],
    requiredArtifact: { kind }, approvalPolicy: { mode: 'human', minimum: 1, authorities: ['reviewers'], rejectTo: [] }, ...extra
  });
  return {
    workItem: { id: W }, status, currentPhase: status === 'closed' ? null : 'review',
    phaseOrder: ['plan', 'backend', 'frontend', 'review'],
    phases: {
      plan: phase('plan', 'implementation-plan'),
      backend: phase('backend', 'implementation-summary', { generationPolicy: { task: 'code' }, writeScope: 'source-and-artifact' }),
      frontend: phase('frontend', 'implementation-summary', { generationPolicy: { task: 'code' }, writeScope: 'source-and-artifact' }),
      review: phase('review', 'conformance-report', {
        status: status === 'closed' ? 'approved' : reviewStatus,
        approvalPolicy: { mode: 'human', minimum: 1, authorities: ['reviewers'], rejectTo }
      })
    }
  };
}

const records = {
  planned: [{
    phase: 'plan', generation: 1, kind: 'planned',
    claims: {
      [`${W}:REQ-001`]: { expectedPaths: ['src/api.mjs'], tests: ['test/api.test.mjs'], steps: ['backend'] },
      [`${W}:REQ-002`]: { expectedPaths: ['web/view.mjs'], tests: ['test/view.test.mjs'], steps: ['frontend'] }
    },
    supportingFiles: ['package-lock.json']
  }]
};

test('a change in a step that delivers no code maps to its obligations and the code step that owns each path', async () => {
  // Two code steps named for what they build: whether a step delivers code is its contract, not its name.
  const workflow = story();
  const change = await crossPhaseChange('/unused', {}, workflow, workflow.phases.review, ['test/view.test.mjs', 'src/api.mjs', 'src/api.mjs'], { records });
  assert.deepEqual(change.paths, ['src/api.mjs', 'test/view.test.mjs']);
  assert.deepEqual(change.owners, ['backend', 'frontend']);
  assert.deepEqual(change.obligations.map((entry) => [entry.id, entry.owningSteps, entry.status]), [
    [`OBL:${W}:implement:REQ-001`, ['backend'], 'stale'],
    [`OBL:${W}:verify:REQ-001`, ['backend'], 'stale'],
    [`OBL:${W}:verify:REQ-002`, ['frontend'], 'stale']
  ], 'a changed test re-verifies only; a changed location re-implements and re-verifies');
  assert.deepEqual(change.unplanned, []);
  assert.deepEqual(change.returns.map((entry) => [entry.step, entry.permitted, entry.command]), [
    ['backend', true, `singularity-flow reject review --to backend --repair --reason <REASON>`],
    ['frontend', true, `singularity-flow reject review --to frontend --repair --reason <REASON>`]
  ]);
  assert.equal(change.checkpoint, 'backend');

  const described = describeCrossPhaseChange(change, { code: 'PRIOR_CODE_TEST_EVIDENCE_STALE', gate: 'consumption', workflow, phase: workflow.phases.review });
  assert.match(described.text, /They stay in your worktree; nothing was reverted or adopted\./);
  assert.match(described.text, /They change XPC-1:REQ-001, XPC-1:REQ-002, owned by backend, frontend\./);
  assert.match(described.text, /Return them with: singularity-flow reject review --to backend --repair --reason <REASON> or singularity-flow reject review --to frontend/);
  const gate = projectGateRefusal(described.gate);
  assert.equal(gate.code, 'PRIOR_CODE_TEST_EVIDENCE_STALE');
  assert.equal(gate.preserved.state, 'worktree');
  assert.match(gate.preserved.description, /src\/api\.mjs, test\/view\.test\.mjs/);
  assert.equal(gate.checkpoint, 'backend');
  assert.equal(gate.recoveryClass, 'repair-implementation');
  assert.deepEqual(gate.obligations.map((entry) => entry.stale?.relationship), ['changed-paths', 'changed-paths', 'changed-paths']);
  assert.equal(gate.actions.length, 2);
});

test('an unplanned path is accounted for first, and the returns follow where the Story stands', async () => {
  const open = story();
  const unplanned = await crossPhaseChange('/unused', {}, open, open.phases.review, ['src/helper.mjs', 'package-lock.json'], { records });
  assert.deepEqual(unplanned.unplanned, ['src/helper.mjs'], 'a planned supporting change is not unplanned');
  assert.deepEqual(unplanned.owners, ['frontend'], 'an unplanned path goes to the closest earlier code step');
  const text = describeCrossPhaseChange(unplanned, { code: 'X', gate: 'submission', workflow: open, phase: open.phases.review });
  assert.match(text.text, /No plan row names src\/helper\.mjs: account for each with singularity-flow decision plan/);
  assert.equal(text.gate.actions[0].command, 'singularity-flow decision plan --add-location <clause>=<path> --reason <reason>');

  const awaiting = story({ reviewStatus: 'awaiting_approval', rejectTo: ['frontend', 'review'] });
  const submitted = await crossPhaseChange('/unused', {}, awaiting, awaiting.phases.review, ['src/api.mjs', 'web/view.mjs'], { records });
  assert.deepEqual(submitted.returns.map((entry) => [entry.step, entry.permitted, entry.command, entry.reason]), [
    ['backend', false, 'singularity-flow reject review --to backend --reason <REASON>', "'review' may not return work to 'backend'"],
    ['frontend', true, 'singularity-flow reject review --to frontend --reason <REASON>', null]
  ]);
  assert.equal(submitted.checkpoint, 'frontend');

  const closed = story({ status: 'closed', rejectTo: ['backend', 'review'] });
  const reopened = await crossPhaseChange('/unused', {}, closed, closed.phases.review, ['web/view.mjs'], { records });
  assert.deepEqual(reopened.returns.map((entry) => [entry.step, entry.permitted, entry.command]), [
    ['frontend', false, `singularity-flow reopen ${W} --to frontend --reason <REASON>`]
  ]);
  const refused = describeCrossPhaseChange(reopened, { code: 'X', gate: 'consumption', workflow: closed, phase: closed.phases.review });
  assert.match(refused.text, /^Return them to frontend; no return is permitted from here \('review' may not return completed work to 'frontend'\)/);

  // A Story that plans no claims hands every change to the closest earlier code step.
  const plain = await crossPhaseChange('/unused', {}, open, open.phases.review, ['src/api.mjs'], { records: { planned: [] } });
  assert.deepEqual([plain.owners, plain.unplanned, plain.obligations], [['frontend'], [], []]);
});

test('the same refusal reaches the CLI recovery plan and the VS Code card with the same actions [E2G criterion 16]', async () => {
  const { refusalEnvelope } = await import('../src/refusal-remediation.mjs');
  const { SingularityFlowError } = await import('../src/util.mjs');
  const { refusalFor } = await import('../apps/vscode/src/views/refusal.ts');
  const workflow = story();
  const change = await crossPhaseChange('/unused', {}, workflow, workflow.phases.review, ['src/api.mjs', 'src/helper.mjs'], { records });
  const described = describeCrossPhaseChange(change, { code: 'PRIOR_CODE_TEST_EVIDENCE_STALE', gate: 'consumption', workflow, phase: workflow.phases.review });
  const error = new SingularityFlowError(`Phase 'review' requires current Code evidence. ${described.text}`,
    { code: 'PRIOR_CODE_TEST_EVIDENCE_STALE', details: { phase: 'review', changedPaths: change.paths, gate: described.gate } });
  const envelope = refusalEnvelope(error, ['phase', 'publish', 'review', '--json']);
  const gateCommands = envelope.error.details.gate.actions.map((entry) => entry.command);
  assert.deepEqual(gateCommands, [
    'singularity-flow decision plan --add-location <clause>=<path> --reason <reason>',
    'singularity-flow reject review --to backend --repair --reason <REASON>',
    'singularity-flow reject review --to frontend --repair --reason <REASON>'
  ]);
  const planned = envelope.remediationPlan.steps.map((entry) => entry.command).filter(Boolean);
  assert.deepEqual(planned.slice(0, gateCommands.length), gateCommands, 'the recovery plan leads with the gate\'s actions');

  const { view } = refusalFor({ result: envelope, message: envelope.error.message });
  assert.deepEqual(view.actions.map((entry) => entry.command), planned.slice(0, 3), 'VS Code offers the plan\'s first actions');
  const why = view.why.map((entry) => entry.label);
  assert.equal(why[0], 'The consumption gate refused: nothing was recorded.');
  for (const obligation of envelope.error.details.gate.obligations) assert.ok(why.includes(`${obligation.id} is stale`), why.join('\n'));
  assert.ok(why.includes('The changed files stay in the worktree: src/api.mjs, src/helper.mjs.'));
  assert.ok(why.includes('Responsible step: backend'));
});
