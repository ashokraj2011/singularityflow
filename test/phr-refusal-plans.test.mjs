/**
 * Every refusal phase-responsibility batch 2 adds or changes leads with the repair the owner's policy requires, in the
 * step that has it and in this turn [PHR:REQ-006]: the author's repair, or the person's decision. No step sends the
 * reader to recover, to return the work elsewhere or to end the turn, unless the refusal names that as its own repair
 * (a code step returned to its own author; proposing or deciding the amendment again). Each refusal is built by its
 * own function, its plan by refusalRemediationPlan and its text by renderRefusalPlan.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { stalePlanCorrectionRefusal, uncorrectedPlanRefusal } from '../src/amendment-plan-corrections.mjs';
import { criterionFailureRepair } from '../src/criterion-test-failures.mjs';
import { criterionTestRefusal, inspectionWitnessRefusal, staleEvidenceRefusal } from '../src/owner-step-evidence.mjs';
import { phaseResponsibilityPin } from '../src/phase-roles.mjs';
import { refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { recordVisualRisk, visualThresholdRefusal } from '../src/visual-risks.mjs';
import { recordWitnessDeferral } from '../src/witness-deferrals.mjs';

const W = 'PLAN-1';
const AC = `${W}:AC-001`;
const policy = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [] };
const step = (id, extra = {}) => ({ id, label: id, status: 'approved', generation: 1, approvals: [], approvalPolicy: { ...policy, rejectTo: [id] }, ...extra });
const story = () => ({ workItem: { id: W }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['planning', 'implementation', 'testing', 'screens'],
  resolution: { phaseResponsibility: phaseResponsibilityPin(), verification: { comparison: { mode: 'enforce' } } },
  phases: { planning: step('planning'), implementation: step('implementation', { status: 'awaiting_approval', generationPolicy: { task: 'code' } }),
    testing: step('testing', { status: 'not_started', generation: 0, requiredArtifact: { kind: 'test-evidence' } }),
    screens: step('screens', { status: 'not_started', generation: 0, requiredArtifact: { kind: 'visual-test-evidence' } }) } });
const row = (extra = {}) => ({ id: AC, type: 'AC', findings: [], actions: [{ kind: 'accept-risk', command: `singularity-flow decision risk ${W} --obligation OBL-1 --category known-failure --expires <YYYY-MM-DD> --reason <why>` }],
  obligations: [{ id: 'OBL-1', responsibility: 'verify', status: 'missing', owningSteps: ['implementation'] }], ...extra });
const refused = (fn) => { try { fn(); } catch (error) { return error; } throw new Error('expected a refusal'); };

// [name, the refusal, the command that met it, the first command the plan must lead with, a /sf-reject or reject that is its own repair]
async function cases() {
  const workflow = story();
  const phase = workflow.phases.implementation;
  const failing = [{ clauseId: AC, label: 'value test', testSource: 'test/value.test.mjs', commandId: 'unit' }];
  const codeTestFailed = new SingularityFlowError("Required test command 'unit' failed.", { code: 'CODE_TEST_FAILED',
    details: { phase: 'implementation', ...criterionFailureRepair(phase, failing).details } });
  return [
    ['criterion test at publication (item 1)', codeTestFailed, ['phase', 'publish', 'implementation', '--work-id', W], `singularity-flow phase prepublish implementation`, false],
    // As criterionTestFailureRefusal builds it from the attributed witnesses (criterion-test-failures.mjs).
    ['criterion test at submission (item 1)', new SingularityFlowError('A criterion\'s own test fails.', { code: 'CRITERION_TESTS_FAILED',
      details: { workId: W, phase: 'implementation', ...criterionFailureRepair(phase, failing).details,
        recoveryCommands: [{ command: `singularity-flow submit implementation --work-id ${W}`, label: 'Then submit it again.' }] } }),
    ['submit', 'implementation', '--work-id', W], 'singularity-flow phase prepublish implementation', false],
    ['a criterion its own tests did not verify, at approval (finding 11)', criterionTestRefusal(workflow, phase, { rows: [row({
      obligations: [{ id: 'OBL-1', responsibility: 'verify', status: 'failed', owningSteps: ['implementation'] }],
      findings: [{ code: 'EVIDENCE_TEST_FAILED', message: `${AC}'s own test failed.`, obligationIds: ['OBL-1'] }] })] }),
    ['approve', 'implementation', '--work-id', W], `singularity-flow reject implementation --work-id ${W}`, true],
    ['inspection sign-off (finding 12)', inspectionWitnessRefusal(workflow, phase, { rows: [row({ verification: { contract: { slots: [{ slot: 'docs', method: 'inspection', role: 'primary', status: 'missing' }] } } })] }),
      ['approve', 'implementation', '--work-id', W], `singularity-flow decisions ${W}`, false],
    ['visual sign-off at the visual step (G8)', inspectionWitnessRefusal(workflow, workflow.phases.screens, { rows: [row({ verification: { contract: { slots: [{ slot: 'screen', method: 'visual', role: 'primary', status: 'missing' }] } } })] }),
      ['approve', 'screens', '--work-id', W], `singularity-flow decisions ${W}`, false],
    ['evidence from before a scope revision', staleEvidenceRefusal(workflow, phase, { rows: [row({ findings: [{ code: 'EVIDENCE_STALE_AFTER_SCOPE_REVISION', message: `${AC} changed.`, obligationIds: ['OBL-1'] }] })] }),
      ['approve', 'implementation', '--work-id', W], `singularity-flow reject implementation --work-id ${W}`, true],
    ['a failed visual comparison (owner decision 3)', await visualThresholdRefusal(null, {}, workflow, workflow.phases.screens, { comparisons: [{ id: 'visual-0123456789abcdef01234567', status: 'fail', profileId: 'phone' }] }),
      ['approve', 'screens', '--work-id', W], `singularity-flow decision visual-risk ${W}`, false],
    ['the plan rows an amendment must carry (item 4)', uncorrectedPlanRefusal(workflow, [{ phase: 'planning', unplanned: [AC], removed: [], revised: [`${W}:REQ-002`] }], { file: 'amended.md' }),
      ['story', 'intent-amendment', 'propose', '--file', 'amended.md', '--reason', 'Review.'], `singularity-flow story intent-amendment propose --work-id ${W}`, true],
    ['carried plan rows that no longer fit (item 4)', stalePlanCorrectionRefusal(workflow, { id: 'AMD-001' }, { stale: [{ phase: 'planning', reason: 'planning was planned again' }], uncovered: [] }),
      ['story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001'], 'singularity-flow story intent-amendment decide AMD-001 --decision reject', true],
    ['a deferral to a step that cannot repair it (item 2)', refused(() => recordWitnessDeferral(story(), { clauseId: AC, slot: 'docs', method: 'inspection', from: 'implementation', to: 'testing',
      reason: 'The later step reads this document again.', actor: 'a', authorityGroup: 'reviewers', at: new Date().toISOString() })),
      ['decision', 'witness-defer', W, '--criterion', AC, '--slot', 'docs', '--to', 'testing', '--reason', 'x'], `singularity-flow decisions ${W}`, false],
    ['a visual risk without a valid date (owner decision 3)', refused(() => recordVisualRisk(story(), { comparison: { id: 'visual-x', status: 'fail' }, phase: 'screens', expires: '2000-01-01',
      reason: 'The device lab renders one pixel row differently.', actor: 'a', authorityGroup: 'reviewers', at: new Date().toISOString() })),
      ['decision', 'visual-risk', W, '--comparison', 'visual-x', '--expires', '2000-01-01', '--reason', 'x'], `singularity-flow decision visual-risk ${W} --comparison visual-x`, false]
  ];
}

test('[PHR:REQ-006] each batch 2 refusal leads with its in-step repair, and nothing sends the reader to recover, return or end the turn', async () => {
  for (const [name, error, argv, first, ownReturn] of await cases()) {
    assert.ok(error, `${name}: no refusal was built`);
    const plan = refusalRemediationPlan(error, argv);
    assert.ok(plan.steps[0]?.command?.startsWith(first), `${name}: leads with ${plan.steps[0]?.command}`);
    const text = renderRefusalPlan(plan);
    assert.doesNotMatch(text, /sf-recover|singularity-flow recover |Turn boundary|End this approval-only turn/u, `${name}:\n${text}`);
    for (const entry of plan.steps) {
      const leaves = /^singularity-flow reject /u.test(entry.command ?? '') || entry.skill === '/sf-reject';
      if (leaves) assert.ok(ownReturn, `${name}: ${entry.command} sends the reader out of the step`);
    }
    if (plan.context) assert.equal(plan.context.turn, 'current-turn', name);
  }
});
