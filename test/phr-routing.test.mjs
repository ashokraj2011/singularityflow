/**
 * Phase responsibility, batch 1 [SPEC-PHR]: a later step that meets a fault in an earlier step's
 * output routes it to the step that owns it, and never strands its own author with a fix they
 * cannot make. Nothing here refuses anything new; each test reads the routes the existing refusals,
 * holds and decisions already carry.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalHold } from '../src/approval-check.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';

/** Code is approved, verification awaits approval and may return to code. */
function story({ rejectTo = ['code', 'verification'] } = {}) {
  const step = (id, status, policy = {}) => ({ id, label: id[0].toUpperCase() + id.slice(1), status, generation: 1, approvals: [],
    generationPolicy: id === 'code' ? { task: 'code' } : undefined, approvalPolicy: { authorities: ['engineering'], minimum: 1, ...policy } });
  return { workItem: { id: 'W-1' }, status: 'in_progress', currentPhase: 'verification', phaseOrder: ['planning', 'code', 'verification'],
    phases: { planning: step('planning', 'approved'), code: step('code', 'approved'), verification: step('verification', 'awaiting_approval', { rejectTo }) },
    resolution: {} };
}
const refusal = (code, details = {}) => new SingularityFlowError(`${code} refused.`, { code, details });

test('[PHR:REQ-004] a hold takes the refusal\'s own repair, its owner step or its gate\'s actions before a return to itself', () => {
  const workflow = story();
  const verification = workflow.phases.verification;
  // Changed code after its approved tests: the refusal names the return to code; the hold used to return verification to itself.
  const stale = approvalHold(refusal('PRIOR_CODE_TEST_EVIDENCE_STALE', { phase: 'verification', sourcePhase: 'code', changedPaths: ['src/a.mjs'],
    repairCommand: 'singularity-flow reject verification --to code --reason <REASON>',
    gate: { actions: [{ command: 'singularity-flow decision plan --add-location <clause>=<path> --reason <reason>' },
      { command: 'singularity-flow reject verification --to code --reason <REASON>' }] } }), workflow, verification);
  assert.equal(stale.action.command, 'singularity-flow reject verification --to code --reason <REASON>');
  assert.match(stale.action.label, /returns verification to code, which owns what this refusal names/u);
  assert.equal(stale.action.skill, '/sf-reject');
  assert.doesNotMatch(JSON.stringify(stale), /--fetch/u, 'never a return of verification to itself');

  // Only the gate's actions: the first is the route.
  const gated = approvalHold(refusal('PRIOR_CODE_TEST_EVIDENCE_STALE', { phase: 'verification',
    gate: { actions: [{ command: 'singularity-flow reject verification --to code --reason <REASON>' }] } }), workflow, verification);
  assert.equal(gated.action.command, 'singularity-flow reject verification --to code --reason <REASON>');

  // Only the owner step: a return there, when this step may make it.
  const owned = approvalHold(refusal('STORY_REVIEW_SOURCE_CHANGED', { phase: 'verification', upstreamPhase: 'code' }), workflow, verification);
  assert.equal(owned.action.command, 'singularity-flow reject verification --work-id W-1 --to code --reason <REASON>');
  assert.match(owned.action.label, /code's author repairs it there/u);
  // A step that may not return there keeps the old route: nothing offers a return the CLI refuses.
  const barred = story({ rejectTo: ['verification'] });
  const kept = approvalHold(refusal('STORY_REVIEW_SOURCE_CHANGED', { phase: 'verification', upstreamPhase: 'code' }), barred, barred.phases.verification);
  assert.equal(kept.action.command, 'singularity-flow reject verification --work-id W-1 --fetch --reason <REASON>');
  // A refusal that names nothing still returns the step for changes, as before.
  const plain = approvalHold(refusal('STORY_REVIEW_SOURCE_CHANGED'), workflow, verification);
  assert.equal(plain.action.command, 'singularity-flow reject verification --work-id W-1 --fetch --reason <REASON>');
});

test('[PHR:REQ-003] the repository\'s own tests failing at verification approval return it to the code step, in the refusal and the hold', () => {
  const workflow = story();
  const back = 'singularity-flow reject verification --work-id W-1 --to code --reason <REASON>';
  const error = refusal('PHASE_VALIDATION_FAILED', { phase: 'verification', ownerPhase: 'code', upstreamPhase: 'code', repositoryTests: 'failed', repairCommand: back });
  const plan = refusalRemediationPlan(error, ['approve', 'verification', '--work-id', 'W-1']);
  assert.equal(plan.steps[0].command, back, 'the owner\'s return leads the approval turn\'s plan');
  assert.equal(plan.steps[0].skill, '/sf-reject');
  assert.ok(plan.steps.some((entry) => entry.id === 'leave-approval-turn'), 'the approval turn still ends');
  const hold = approvalHold(error, workflow, workflow.phases.verification);
  assert.equal(hold.action.command, back);
  assert.equal(hold.owner, 'author-repairs');
  // Without the owner, an approval refusal keeps the plan it always had.
  const own = refusalRemediationPlan(refusal('PHASE_VALIDATION_FAILED'), ['approve', 'verification', '--work-id', 'W-1']);
  assert.equal(own.steps[0].id, 'inspect-current-phase');
});
