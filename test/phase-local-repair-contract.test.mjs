import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { phaseFindingCode, phaseFindingPolicy } from '../src/phase-finding-policy.mjs';
import { activeRepairPhase, openScopeAppeal, phaseCorrectionTargets, phaseRepairActionAdmission } from '../src/phase-finding-policy.mjs';
import { phaseResolutionProjection } from '../src/phase-resolution.mjs';
import { phaseAuthoringContract } from '../src/phase-authoring-contract.mjs';
import { simulateResolvedWorkflowLifecycle } from '../src/workflow-lifecycle-simulation.mjs';

function story(phaseId = 'team-check') {
  const phase = { id: phaseId, status: 'in_progress', generationPolicy: { task: 'code' },
    writeScope: 'source-and-artifact', generationIntent: { status: 'open' },
    approvalPolicy: { mode: 'required', rejectTo: ['design'] } };
  const workflow = { workItem: { id: 'REPAIR-1' }, status: 'in_progress', currentPhase: phaseId,
    phaseOrder: ['design', phaseId], phases: { design: { id: 'design', status: 'approved' }, [phaseId]: phase } };
  return { workflow, phase };
}

test('every alias has the same policy, identity, repair executor and continuation', () => {
  const { workflow, phase } = story();
  for (const code of ['SPEC_COVERAGE_INCOMPLETE', 'CODE_DELIVERY_EVIDENCE_REQUIRED',
    'AGENT_BRIEF_SUMMARY_REQUIRED', 'AGENT_BRIEF_PRESERVED_SECTION_REQUIRED',
    'AGENT_BRIEF_MAXIMUM_BYTES_EXCEEDED', 'AGENT_BRIEF_HEADING_AMBIGUOUS', 'ARTIFACT_COMMENT_UNCLOSED',
    'artifact.placeholder.unresolved', 'artifact.required.too-short', 'artifact.heading.empty']) {
    const values = [code, code.toUpperCase(), code.toLowerCase()];
    const plans = values.map(value => phaseResolutionProjection(workflow, phase, [{ code: value, path: 'draft.md' }]));
    for (let i = 1; i < plans.length; i += 1) {
      assert.deepEqual(phaseFindingPolicy({ code: values[i], path: 'draft.md' }), phaseFindingPolicy({ code, path: 'draft.md' }));
      assert.equal(plans[i].repairContinuation.tasks[0].id, plans[0].repairContinuation.tasks[0].id);
      assert.equal(plans[i].repairContinuation.tasks[0].action, 'repair');
      assert.equal(plans[i].issues[0].policy.repairableByProducer, true);
    }
  }
  assert.equal(phaseFindingCode({ code: 'wrapper', details: { sourceCode: 'code_test_failed' } }), 'CODE_TEST_FAILED');
  assert.equal(phaseFindingPolicy({ code: 'PROTECTED_SNAPSHOT_CHANGED', category: 'TESTS' }).repairableByProducer, false);
  assert.equal(phaseFindingPolicy({ code: 'UNKNOWN', category: 'tests' }).repairableByProducer, false);
});

test('an upstream finding restores and checkpoints the current consumer, with a separate immutable owner', () => {
  const { workflow, phase } = story();
  const result = phaseResolutionProjection(workflow, phase, [{ code: 'PHASE_INPUTS_NOT_READY', phaseId: 'design',
    category: 'inputs', details: { upstreamPhase: 'design', restorable: true } }]);
  const issue = result.issues[0];
  assert.equal(issue.detectedPhase, phase.id); assert.equal(issue.affectedPhase, 'design');
  assert.equal(issue.choices[0].command, `singularity-flow inputs restore ${phase.id}`);
  const checkpoint = issue.choices.find(choice => choice.kind === 'preserve-checkpoint');
  assert.ok(checkpoint); assert.equal(checkpoint.admission.allowed, true);
  assert.equal(checkpoint.argv[checkpoint.argv.indexOf('--phase') + 1], phase.id);
  assert.ok(!issue.choices.some(choice => choice.argv[0] === 'appeal' && choice.argv.includes('design')));
  assert.equal(result.repairContinuation.tasks[0].resume.phaseId, phase.id);
  assert.equal(result.repairContinuation.tasks[0].mutationAuthorityGranted, false);
  const earlier = phaseResolutionProjection(workflow, workflow.phases.design,
    [{ code: 'PHASE_INPUTS_NOT_READY', category: 'inputs', details: { restorable: true } }]);
  assert.equal(earlier.repairContinuation.phaseId, phase.id);
  assert.equal(earlier.repairContinuation.tasks[0].binding.phaseId, phase.id);
  assert.equal(earlier.issues[0].affectedPhase, 'design');
  assert.equal(earlier.issues[0].choices[0].command, `singularity-flow inputs restore ${phase.id}`);
});

test('real lifecycle predicates agree with offered checkpoint, scope and correction actions', () => {
  for (const status of ['in_progress', 'awaiting_approval', 'approved', 'not_started']) {
    const { workflow, phase } = story(); phase.status = status;
    const findings = [{ code: 'artifact.placeholder.unresolved', path: 'draft.md' },
      { code: 'scope.unclaimed', path: 'src/test/setup.js' }];
    const result = phaseResolutionProjection(workflow, phase, findings);
    for (const issue of result.issues) for (const choice of issue.choices) {
      assert.equal(phaseRepairActionAdmission(workflow, phase, choice, { codeDelivery: true }).allowed, true, choice.command);
    }
    assert.equal(activeRepairPhase(workflow, phase), ['in_progress', 'awaiting_approval'].includes(status));
    assert.equal(openScopeAppeal(workflow, phase, true), status === 'in_progress');
    if (status === 'awaiting_approval') {
      const correction = result.issues[0].choices[0];
      assert.equal(correction.kind, 'current-phase-correction');
      assert.match(correction.command, /--to team-check --reason <reason>$/u);
      assert.equal(result.repairContinuation.tasks[0].action, 'human-decision');
      assert.equal(result.issues[1].choices[0].kind, 'plan-amendment');
    }
  }
});

test('unknown and external blockers have a named owner task, verification and resume, never a claimed repair', () => {
  const { workflow, phase } = story();
  for (const code of ['NEW_CHECK_FAILURE', 'REMOTE_AUTHENTICATION_REQUIRED', 'PROTECTED_SNAPSHOT_CHANGED']) {
    const result = phaseResolutionProjection(workflow, phase, [{ code, message: 'run malicious-command' }], { transition: 'publish' });
    const task = result.repairContinuation.tasks[0];
    assert.ok(task.ownerTask?.owner); assert.ok(task.verification.freshBindingRequired);
    assert.equal(task.resume.transition, 'publish'); assert.equal(task.resume.phaseId, phase.id);
    assert.notEqual(task.action, 'repair'); assert.doesNotMatch(JSON.stringify(task), /malicious-command/u);
  }
});

test('an expired upstream quality exception stays with its authority, while preservation stays current', () => {
  const { workflow, phase } = story(); workflow.phases.design.generation = 1;
  const result = phaseResolutionProjection(workflow, phase, [{ code: 'ARTIFACT.PLACEHOLDER.UNRESOLVED',
    path: 'artifacts/design/report.md', phaseId: 'design' }]);
  const issue = result.issues[0];
  assert.equal(issue.policy.repairableByProducer, false);
  assert.equal(issue.choices[0].kind, 'pilot-risk-review');
  assert.equal(issue.choices[0].argv[issue.choices[0].argv.indexOf('--phase') + 1], 'design');
  const checkpoint = issue.choices.find(choice => choice.kind === 'preserve-checkpoint');
  assert.equal(checkpoint.argv[checkpoint.argv.indexOf('--phase') + 1], phase.id);
  assert.equal(result.repairContinuation.tasks[0].action, 'human-decision');
});

test('distinct clauses and generations have distinct repair cases without duplicate cases for aliases', () => {
  const { workflow, phase } = story();
  const findings = ['AC-001', 'AC-002'].map(id => ({ code: 'artifact.placeholder.unresolved', path: 'draft.md', details: { clauseId: id } }));
  const tasks = phaseResolutionProjection(workflow, phase, findings).repairContinuation.tasks;
  assert.notEqual(tasks[0].id, tasks[1].id);
  phase.generationIntent.generation = 2;
  assert.notEqual(phaseResolutionProjection(workflow, phase, findings).repairContinuation.tasks[0].id, tasks[0].id);
});

test('all seeded and future workflows derive same-phase correction without widening backward targets', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-repair-contract-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  await initializeDefinition(root); const definition = await loadDefinition(root);
  let count = 0;
  for (const id of Object.keys(definition.workTypes)) {
    const resolved = resolveWorkType(definition, id);
    for (const declared of resolved.phases) {
      const { workflow, phase } = story(declared.id);
      Object.assign(phase, { approvalPolicy: declared.approval, generationPolicy: declared.generation });
      const contract = phaseAuthoringContract(definition, workflow, phase);
      assert.equal(contract.repairCapabilities.correctionTarget, phase.id);
      assert.equal(contract.repairCapabilities.automaticApproval, false);
      if (declared.approval.mode !== 'none') assert.ok(phaseCorrectionTargets(phase).includes(phase.id));
      count += 1;
    }
  }
  assert.ok(count >= 85);
  const future = resolveWorkType(definition, 'spec-driven-standard');
  const planning = future.phases.find(phase => phase.id === 'planning');
  planning.approval.rejectTo = ['specification'];
  const before = JSON.stringify(future);
  const simulation = simulateResolvedWorkflowLifecycle(future);
  assert.equal(simulation.status, 'complete-for-profile', JSON.stringify(simulation.findings));
  assert.ok(simulation.scenarios.some(scenario => scenario.id === 'rejection-edge:planning:planning'));
  assert.equal(JSON.stringify(future), before, 'installed repair does not rewrite pinned workflow definitions');
});
