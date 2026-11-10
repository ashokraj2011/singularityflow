/**
 * Phase responsibility, batch 2 [SPEC-PHR]: the step that owns an output checks it, before it can be
 * approved, so a later step no longer meets the fault. Each new check refuses only in the owning step,
 * names how to fix it there in a structured field, and applies only to a Story that pinned the
 * owner-step checks when it started: a Story already running keeps its policy.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approvalHold, approvalHoldOwner } from '../src/approval-check.mjs';
import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { terminalRecoveryActions } from '../src/evidence/terminal.mjs';
import { criterionTestRefusal, inspectionWitnessRefusal, ownCriterionFindings, ownSignOffs, staleEvidenceRefusal } from '../src/owner-step-evidence.mjs';
import { acceptanceOwnerRefusal } from '../src/acceptance-owner-check.mjs';
import { specAcceptanceFindings } from '../src/governance.mjs';
import { ownerStepChecks, phaseResponsibilityPin } from '../src/phase-roles.mjs';
import { refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { plannedBasePathProblems } from '../src/plan-base-paths.mjs';
import { fulfillmentPlanCorrections } from '../src/delivery-evidence.mjs';
import { separatePlanGaps } from '../src/state.mjs';
import { approvalStaffingWarnings } from '../src/approval-staffing.mjs';
import { riskDecisionTransitions } from '../src/story-test-risk.mjs';
import { recordWitnessDeferral, witnessDeferralCandidates } from '../src/witness-deferrals.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { finalScopeStep, scopeDispositionRefusal } from '../src/scope/authoring.mjs';
import { recordScopeDecision } from '../src/scope/decisions.mjs';
import { buildScopeInventory } from '../src/scope/inventory.mjs';

const PINNED = { phaseResponsibility: phaseResponsibilityPin() };

test('[PHR:REQ-002] a Story pins the owner-step checks when it starts; one started before keeps its policy', () => {
  assert.equal(ownerStepChecks({ resolution: PINNED }), true);
  assert.equal(ownerStepChecks({ resolution: {} }), false, 'a Story started before the checks existed');
  assert.equal(ownerStepChecks(null), false);
});

/** Intake defines the scope (and the plan), specification is a later step that does not. */
function scopeStory({ pinned = true, status = 'awaiting_approval' } = {}) {
  const step = (id, stepStatus, responsibilities) => ({ id, label: id, status: stepStatus, generation: 1, approvals: [],
    approvalPolicy: { mode: 'required', authorities: ['product-approvers'], minimum: 1, rejectTo: [id] }, responsibilities });
  return { workItem: { id: 'W-1', title: 'Change the value' }, status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake', 'code'],
    phases: { intake: step('intake', status), code: { ...step('code', 'not_started'), generation: 0 } },
    resolution: { ...(pinned ? PINNED : {}), obligationGraph: { nodes: [{ id: 'intake', responsibilities: ['scope', 'plan', 'review'] },
      { id: 'code', responsibilities: ['implement', 'verify'] }], endpoints: [] } } };
}

async function storyDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phr-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity/work-items/W-1');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'documents.json'), JSON.stringify({ schemaVersion: 3, workId: 'W-1', documents: [] }));
  return { root, directory };
}

test('[PHR:REQ-002] finding 10: the step that defines the scope is approved only once each statement is dispositioned, so the ending no longer meets it', async (t) => {
  const { root, directory } = await storyDirectory(t);
  const source = { description: 'The API must stay stable.', acceptanceCriteria: ['The exported value equals 2.'] };
  const clauses = [{ id: 'W-1:AC-001', body: 'The exported value equals 2.' }];
  const workflow = scopeStory();
  assert.equal(finalScopeStep(workflow).id, 'intake');
  const inventory = await buildScopeInventory(root, directory, workflow, { source, clauses });
  const item = inventory.items.find((entry) => entry.disposition === 'unresolved');
  assert.ok(item, 'the fixture has a statement no clause carries');

  // The owning step refuses, with the decision list and the exact scope decisions as structured routes.
  const refusal = scopeDispositionRefusal(workflow, workflow.phases.intake, inventory);
  assert.equal(refusal.code, 'SCOPE_ITEMS_UNRESOLVED');
  assert.deepEqual([refusal.details.ownerPhase, refusal.details.scopePhase, refusal.details.items[0].id], ['intake', 'intake', item.id]);
  assert.equal(refusal.details.nextAction.command, 'singularity-flow decisions W-1');
  assert.match(refusal.details.recoveryCommands[0].command, new RegExp(`^singularity-flow decision scope W-1 --item ${item.id} --as <included\\|existing> --clause <CLAUSE-ID>`, 'u'));
  assert.match(refusal.details.recoveryCommands[1].command, /--as <excluded\|deferred\|informative/u);
  // Its approvers decide it, and every surface's hold says so: never a return of the step for changes.
  assert.equal(approvalHoldOwner(refusal), 'someone-decides');
  const hold = approvalHold(refusal, workflow, workflow.phases.intake);
  assert.deepEqual([hold.action.command, hold.who], ['singularity-flow decisions W-1', 'An approver of intake decides']);
  assert.doesNotMatch(JSON.stringify(hold), /reject intake/u);
  const plan = refusalRemediationPlan(refusal, ['approve', 'intake', '--work-id', 'W-1']);
  // The repair is in this step and this turn [PHR:REQ-006]: the decision list leads, then the statement's two routes;
  // never "recover the phase", "end the turn" or a rejection, which could not clear it.
  assert.deepEqual(plan.steps.map((entry) => [entry.id, entry.command]), [
    ['open-decision-list', 'singularity-flow decisions W-1'],
    ['include-scope-statement', refusal.details.recoveryCommands[0].command],
    ['decide-scope-statement-otherwise', refusal.details.recoveryCommands[1].command]]);
  assert.deepEqual([plan.context?.strategy, plan.context?.turn], ['person-decides-scope', 'current-turn']);
  assert.match(renderRefusalPlan(plan), /^Recovery plan:\n  Scope: phase intake — its approvers decide each source statement in the decision list now, then approve; nothing about the work needs repairing\.\n  1\. An approver of intake decides/u);
  assert.doesNotMatch(renderRefusalPlan(plan), /sf-recover|sf-reject|Turn boundary/u);

  // Once a person dispositions it, the step may be approved, and the ending has nothing left to refuse for it.
  recordScopeDecision(workflow, { item: item.id, disposition: 'excluded', reason: 'Stability is owned by the platform team, not this Story.',
    actor: 'po@example.test', authorityGroup: 'product-approvers', at: '2026-11-10T00:00:00.000Z', inventory, knownClauseIds: [] });
  const decided = await buildScopeInventory(root, directory, workflow, { source, clauses });
  assert.equal(scopeDispositionRefusal(workflow, workflow.phases.intake, decided), null);
  const ending = evaluateEvidence(evidenceGraph({ workflow, records: { indexes: [] }, scope: decided }));
  assert.ok(!ending.findings.some((entry) => entry.code === 'SCOPE_ITEMS_UNRESOLVED'));

  // A Story started before the check keeps working: its scope step is approved as before, and only its ending judges scope.
  const legacy = scopeStory({ pinned: false });
  assert.equal(scopeDispositionRefusal(legacy, legacy.phases.intake, inventory), null);
  assert.ok(evaluateEvidence(evidenceGraph({ workflow: legacy, records: { indexes: [] }, scope: inventory }))
    .findings.some((entry) => entry.code === 'SCOPE_ITEMS_UNRESOLVED'), 'the ending still holds an older Story');
  // A step that does not define the scope last is never held by it.
  const twoScopes = scopeStory();
  twoScopes.phaseOrder = ['intake', 'specification', 'code'];
  twoScopes.phases.specification = { ...twoScopes.phases.intake, id: 'specification', status: 'not_started', generation: 0 };
  twoScopes.resolution.obligationGraph.nodes.push({ id: 'specification', responsibilities: ['scope'] });
  assert.equal(scopeDispositionRefusal(twoScopes, twoScopes.phases.intake, inventory), null);
});

/**
 * A Story whose code step (implementation) awaits approval with AC-001 and AC-002 tagged in its tests,
 * judged as the ending judges it. `second` is how AC-002's test command ran: passed, failed, or passed
 * with skipped tests (which cannot verify the criterion).
 */
function codeStep({ pinned = true, second = 'passed', status = 'awaiting_approval', risks = [], issues = [], decisions = [], inspection = false, witnessRecords = [] } = {}) {
  const W = 'CODE-1';
  const [REQ, AC1, AC2] = [`${W}:REQ-001`, `${W}:AC-001`, `${W}:AC-002`];
  const policy = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [] };
  const approval = { decision: 'approved', actor: { login: 'reviewer' }, authorityGroup: 'reviewers', at: '2026-11-09T00:00:00Z' };
  const step = (id, extra = {}) => ({ id, label: id, status: 'approved', generation: 1, approvalPolicy: { ...policy, rejectTo: ['intake', id] }, approvals: [approval], ...extra });
  const workflow = { workItem: { id: W }, status: 'in_progress', currentPhase: status === 'approved' ? 'testing' : 'implementation', phaseOrder: ['intake', 'implementation', 'testing'],
    resolution: { ...(pinned ? PINNED : {}), plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } } },
    phases: { intake: step('intake', { requiredArtifact: { kind: 'requirements' } }),
      implementation: step('implementation', { status, approvals: status === 'approved' ? [approval] : [], generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' } }),
      testing: step('testing', { status: status === 'approved' ? 'in_progress' : 'not_started', generation: status === 'approved' ? 1 : 0, approvals: [], requiredArtifact: { kind: 'test-evidence' } }) },
    riskDecisions: risks, upstreamIssues: issues, upstreamIssueDecisions: decisions };
  const clause = (id, type, line, dependsOn = []) => ({ id, type, source: { path: 'intake.md', line }, bodySha256: String(line).repeat(64).slice(0, 64), dependsOn });
  const claim = { expectedPaths: ['src/value.mjs'], tests: [], testDisposition: 'unspecified', testReason: null };
  const delivered = { observedPaths: ['src/value.mjs'], commits: [], verdict: 'matched' };
  const run = (outcome) => ({ kind: 'test-execution', status: outcome === 'failed' ? 'failed' : 'passed',
    record: { status: outcome === 'failed' ? 'failed' : 'passed', exitCode: outcome === 'failed' ? 1 : 0, terminal: true,
      tests: { discovered: 2, passed: outcome === 'failed' ? 1 : 2, failed: outcome === 'failed' ? 1 : 0, skipped: outcome === 'skipped' ? 1 : 0 } } });
  const evaluation = evaluateEvidence(evidenceGraph({ workflow,
    records: { indexes: [{ workId: W, phase: 'intake', generation: 1, clauses: [clause(REQ, 'REQ', 3), clause(AC1, 'AC', 5, [REQ]), clause(AC2, 'AC', 6, [REQ])] }],
      planned: [{ workId: W, phase: 'intake', generation: 1, kind: 'planned',
        // With `inspection`, AC-002 is verified by a reviewer inspecting a document, not by its test.
        ...(inspection ? { verificationContracts: [{ clauseId: AC2, combination: 'all',
          slots: [{ slot: 'docs', method: 'inspection', role: 'primary', witness: { path: 'docs/value.md' }, requiredAssurance: 'source-bound' }] }] } : {}),
        claims: { [REQ]: claim,
        [AC1]: { ...claim, tests: ['test/one.test.mjs'], testDisposition: 'applicable' }, [AC2]: { ...claim, tests: ['test/two.test.mjs'], testDisposition: 'applicable' } } }],
      observed: [{ workId: W, phase: 'implementation', generation: 1, kind: 'observed', claims: { [REQ]: { ...delivered, testResults: [] },
        [AC1]: { ...delivered, testResults: ['test/one.test.mjs'] }, [AC2]: { ...delivered, testResults: ['test/two.test.mjs'] } } }], acceptance: [] },
    deliveries: [{ phaseId: 'implementation', generation: 1, status: 'ready', testRecovery: null,
      acceptanceCriteria: { bindings: [{ clauseId: AC1, testSource: 'test/one.test.mjs' }, { clauseId: AC2, testSource: 'test/two.test.mjs' }] },
      receipt: { status: 'ready', traceability: { bindings: [{ clauseId: AC1, testSource: 'test/one.test.mjs', commandId: 'one' }, { clauseId: AC2, testSource: 'test/two.test.mjs', commandId: 'two' }] } },
      executions: [{ commandId: 'one', ...run('passed') }, { commandId: 'two', ...run(second) }] }], witnessRecords }),
  { boundary: 'terminal', mode: 'decision' });
  return { workflow, evaluation, AC1, AC2 };
}

test('[PHR:REQ-002] finding 11: a code step whose own criterion its tests did not verify is held at its approval, where its author can still correct it', () => {
  // Verified: nothing holds the step.
  const passing = codeStep();
  assert.equal(criterionTestRefusal(passing.workflow, passing.workflow.phases.implementation, passing.evaluation), null);

  for (const [second, code] of [['failed', 'EVIDENCE_TEST_FAILED'], ['skipped', 'EVIDENCE_TESTS_SKIPPED']]) {
    const { workflow, evaluation, AC2 } = codeStep({ second });
    // The ending refuses this row: the same finding the step is now held for.
    assert.ok(evaluation.findings.some((entry) => entry.code === code && entry.blocking !== false), code);
    const refusal = criterionTestRefusal(workflow, workflow.phases.implementation, evaluation);
    assert.equal(refusal.code, 'CRITERION_TESTS_UNVERIFIED');
    assert.deepEqual(refusal.details.criteria.map((entry) => [entry.clauseId, entry.findings[0].code]), [[AC2, code]]);
    assert.equal(refusal.details.ownerPhase, 'implementation');
    // Structured routes: the return for the author's correction, and the people's dated risk.
    assert.equal(refusal.details.repairCommand, 'singularity-flow reject implementation --work-id CODE-1 --fetch --reason <REASON>');
    assert.match(refusal.details.recoveryCommands[0].command, /^singularity-flow decision risk --obligation OBL:CODE-1:verify:/u);
    assert.equal(approvalHoldOwner(refusal), 'author-repairs');
    assert.equal(approvalHold(refusal, workflow, workflow.phases.implementation).action.command, refusal.details.repairCommand);
    // A Story started before the check keeps its policy: its code step is approved as before, and only the ending judges.
    const legacy = codeStep({ second, pinned: false });
    assert.equal(criterionTestRefusal(legacy.workflow, legacy.workflow.phases.implementation, legacy.evaluation), null);
  }
  // A step whose criteria a later code step tests is not this step's to answer for.
  const { evaluation } = codeStep({ second: 'failed' });
  assert.deepEqual(ownCriterionFindings(evaluation, 'testing', /^EVIDENCE_/u), []);
});

test('[PHR:REQ-003] finding 11: at the ending, an inconclusive criterion of an earlier step offers its upstream route', () => {
  const { workflow, evaluation, AC2 } = codeStep({ second: 'skipped', status: 'approved' });
  const row = evaluation.rows.find((entry) => entry.id === AC2);
  assert.equal(row.obligations.find((entry) => entry.responsibility === 'verify').status, 'inconclusive');
  const actions = terminalRecoveryActions('CODE-1', evaluation, null, workflow);
  assert.ok(actions.includes(`singularity-flow upstream-issue raise --work-id CODE-1 --phase implementation --about ${AC2} --problem <what-is-wrong>`), actions.join('\n'));
  // A decided accepted risk on that issue settles the inconclusive row, as it settles a failed one.
  const issue = { id: 'UPI-001', phase: 'implementation', about: AC2, problem: 'Its test is skipped in this repository.' };
  const settled = codeStep({ second: 'skipped', status: 'approved', issues: [issue], decisions: [{ issue: 'UPI-001', outcome: 'accept-risk', expiresAt: '2999-01-01T00:00:00.000Z' }] });
  assert.equal(settled.evaluation.rows.find((entry) => entry.id === AC2).obligations.find((entry) => entry.responsibility === 'verify').status, 'excepted');
});

test('[PHR:REQ-002] finding 12: a code step is approved only once the inspection of its own criterion is signed off, so the ending no longer asks for it', () => {
  const { workflow, evaluation, AC2 } = codeStep({ inspection: true });
  // The ending refuses the row; the code step's approval now does, where its approvers can give it.
  assert.ok(evaluation.findings.some((entry) => entry.code === 'EVIDENCE_INSPECTION_MISSING' && entry.blocking !== false));
  assert.equal(criterionTestRefusal(workflow, workflow.phases.implementation, evaluation), null, 'its tests are not what is missing');
  const refusal = inspectionWitnessRefusal(workflow, workflow.phases.implementation, evaluation);
  assert.equal(refusal.code, 'EVIDENCE_INSPECTION_MISSING');
  assert.deepEqual(refusal.details.criteria.map((entry) => entry.clauseId), [AC2]);
  assert.equal(refusal.details.nextAction.command, 'singularity-flow decisions CODE-1');
  const commands = refusal.details.recoveryCommands.map((entry) => entry.command);
  assert.equal(commands[0], 'singularity-flow approve implementation --work-id CODE-1 --confirm-evidence');
  assert.ok(commands.some((command) => command.startsWith(`singularity-flow decision witness CODE-1 --criterion ${AC2} --slot docs `)), commands.join('\n'));
  assert.ok(commands.some((command) => command.startsWith('singularity-flow decision risk --obligation OBL:CODE-1:verify:')), commands.join('\n'));
  // Its approvers decide it: the hold names them, and the decision list is its route on both hosts.
  assert.equal(approvalHoldOwner(refusal), 'someone-decides');
  const hold = approvalHold(refusal, workflow, workflow.phases.implementation);
  assert.deepEqual([hold.action.command, hold.who], ['singularity-flow decisions CODE-1', 'An approver of implementation decides']);

  // Signed off: nothing holds the step, and the ending has nothing left for it.
  const signed = codeStep({ inspection: true, witnessRecords: [{ clauseId: AC2, slot: 'docs', method: 'inspection', status: 'met', assurance: 'source-bound' }] });
  assert.equal(inspectionWitnessRefusal(signed.workflow, signed.workflow.phases.implementation, signed.evaluation), null);
  assert.ok(!signed.evaluation.findings.some((entry) => entry.code === 'EVIDENCE_INSPECTION_MISSING'));
  // A Story started before the check keeps its policy.
  const legacy = codeStep({ inspection: true, pinned: false });
  assert.equal(inspectionWitnessRefusal(legacy.workflow, legacy.workflow.phases.implementation, legacy.evaluation), null);
});

test('[PHR:REQ-002] finding 14: the plan\'s existing and removed rows are checked against the Story\'s base where the planner can correct them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phr-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Base Test');
  git('config', 'user.email', 'base@example.invalid');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/old.mjs'), 'export const old = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  const workflow = { workItem: { id: 'PLAN-1', baseCommit } };
  const claims = {
    'PLAN-1:REQ-001': { fulfillment: 'existing', expectedPaths: ['src/old.mjs'] },
    'PLAN-1:REQ-002': { fulfillment: 'existing', expectedPaths: ['src/missing.mjs'] },
    'PLAN-1:REQ-003': { fulfillment: 'removed', expectedPaths: ['src/gone.mjs'] },
    'PLAN-1:REQ-004': { fulfillment: 'removed', expectedPaths: ['src/old.mjs'] },
    // A path the plan itself creates is the Story's work, not the base's.
    'PLAN-1:REQ-005': { fulfillment: 'new', expectedPaths: ['src/made.mjs'] },
    'PLAN-1:REQ-006': { fulfillment: 'existing', expectedPaths: ['src/made.mjs'] }
  };
  assert.deepEqual(plannedBasePathProblems(root, workflow, claims).map((entry) => [entry.code, entry.clauseId, entry.path]), [
    ['specification.planned-existing-path-missing', 'PLAN-1:REQ-002', 'src/missing.mjs'],
    ['specification.planned-removed-path-absent', 'PLAN-1:REQ-003', 'src/gone.mjs']]);
  // Without an exact base commit nothing is judged here; the code step still judges the delivery.
  assert.deepEqual(plannedBasePathProblems(root, { workItem: { id: 'PLAN-1', baseBranch: 'main' } }, claims), []);

  // At the code step the same row now names the plan's corrections and the upstream issue, beside the delivery.
  const step = (id, status) => ({ id, label: id, status, generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1, rejectTo: [id] } });
  const coding = { workItem: { id: 'PLAN-1' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['planning', 'implementation'],
    phases: { planning: step('planning', 'approved'), implementation: { ...step('implementation', 'in_progress'), generationPolicy: { task: 'code' } } },
    resolution: { plannedClaims: { mode: 'required', owners: { implementation: 'planning' } } } };
  const routed = await fulfillmentPlanCorrections(coding, coding.phases.implementation, [{ code: 'code.delivery.existing-path-missing', path: 'src/missing.mjs', value: 'PLAN-1:REQ-002' }]);
  const { planCorrections } = routed;
  assert.equal(routed.planningOwner, 'planning');
  assert.deepEqual(planCorrections.map((entry) => entry.command), [
    'singularity-flow decision plan PLAN-1 --set-fulfillment PLAN-1:REQ-002=<new|modified|existing|removed|document|configuration> --reason <why>',
    'singularity-flow decision plan PLAN-1 --replace-location PLAN-1:REQ-002=src/missing.mjs:<NEW-PATH> --reason <why>',
    'singularity-flow upstream-issue raise --work-id PLAN-1 --phase planning --about PLAN-1:REQ-002 --problem <what-is-wrong>']);
  const refusal = new SingularityFlowError('Phase implementation has no publishable code delivery.', { code: 'CODE_DELIVERY_EVIDENCE_REQUIRED',
    details: { phase: 'implementation', ...routed, findings: [{ code: 'code.delivery.existing-path-missing', path: 'src/missing.mjs', value: 'PLAN-1:REQ-002' }] } });
  const plan = refusalRemediationPlan(refusal, ['phase', 'publish', 'implementation', '--work-id', 'PLAN-1']);
  assert.deepEqual(plan.steps.filter((entry) => ['correct-plan-row', 'raise-upstream-issue'].includes(entry.id)).map((entry) => entry.command),
    [planCorrections[0].command, planCorrections[2].command]);
  const choices = phaseResolutionChoices(coding, coding.phases.implementation, refusal).choices;
  assert.deepEqual(choices.filter((entry) => ['plan-correction', 'upstream-issue'].includes(entry.kind)).map((entry) => [entry.kind, entry.owner, entry.command]),
    [['plan-correction', 'planning-approval-authority', planCorrections[0].command], ['upstream-issue', 'planning-approval-authority', planCorrections[2].command]]);
});

test('[PHR:REQ-002] finding 15: an approved separate plan that parts from the amended clauses is named, with its approvers\' corrections', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phr-amend-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = 'singularity/work-items/AMD-1/context/claims/planning-gen1-planned.json';
  await mkdir(path.join(root, path.dirname(planPath)), { recursive: true });
  const row = { expectedPaths: ['src/a.mjs'], tests: ['test/a.test.mjs'], testDisposition: 'applicable', testReason: null, deviation: null, fulfillment: 'modified' };
  await writeFile(path.join(root, planPath), JSON.stringify({ kind: 'planned', workId: 'AMD-1', phase: 'planning', generation: 1,
    claims: { 'AMD-1:REQ-001': row, 'AMD-1:REQ-002': row } }));
  const step = (id, status, extra = {}) => ({ id, label: id, status, generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 }, ...extra });
  const workflow = (pinned) => ({ workItem: { id: 'AMD-1' }, status: 'in_progress', currentPhase: 'code', phaseOrder: ['specification', 'planning', 'code'],
    resolution: { ...(pinned ? PINNED : {}) },
    phases: { specification: step('specification', 'approved', { requiredArtifact: { kind: 'requirements' } }),
      planning: step('planning', 'approved', { claimMaps: { planned: { path: planPath, generation: 1 } } }),
      code: step('code', 'in_progress', { generationPolicy: { task: 'code' } }) } });
  const config = { workItemRoot: 'singularity/work-items' };
  // The amendment drops REQ-002 and adds REQ-003: the plan has a row for one and none for the other.
  const [gap] = await separatePlanGaps(root, config, workflow(true), ['AMD-1:REQ-001', 'AMD-1:REQ-003']);
  assert.deepEqual([gap.phase, gap.unplanned, gap.removed], ['planning', ['AMD-1:REQ-003'], ['AMD-1:REQ-002']]);
  assert.match(gap.routes[0].command, /--owner planning --add-row AMD-1:REQ-003=<PATH> --test <TEST>/u);
  assert.match(gap.routes[1].command, /--owner planning --remove-row AMD-1:REQ-002 /u);
  assert.deepEqual(await separatePlanGaps(root, config, workflow(true), ['AMD-1:REQ-001', 'AMD-1:REQ-002']), [], 'a plan that still plans every clause');
  // A Story started before the check keeps its policy: nothing is judged at the amendment.
  assert.deepEqual(await separatePlanGaps(root, config, workflow(false), ['AMD-1:REQ-001', 'AMD-1:REQ-003']), []);
});

test('[PHR:REQ-002] finding 16: Story start names each gated step only its author could approve, and holds nothing', () => {
  const author = { email: 'author@example.test', login: 'author' };
  const group = (...emails) => ({ allowAnyGitIdentity: false, members: emails.map((email) => ({ email })) });
  const policy = (authorities, extra = {}) => ({ mode: 'required', minimum: 1, authorities, ...extra });
  const workflow = { workItem: { id: 'STAFF-1' }, phaseOrder: ['intake', 'design', 'code', 'release', 'notes', 'open'],
    resolution: { approvalAuthorities: { product: group('author@example.test'), engineering: group('author@example.test', 'reviewer@example.test'),
      release: group('lead@example.test'), everyone: { allowAnyGitIdentity: true, members: [] } } },
    phases: {
      // Only the author is in its group and self-approval is forbidden: nobody can approve it.
      intake: { approvalPolicy: policy(['product'], { allowSelfApproval: false }) },
      // Only the author, but they may approve it themselves (recorded as self-approval).
      design: { approvalPolicy: policy(['product']) },
      code: { approvalPolicy: policy(['engineering'], { allowSelfApproval: false }) },
      release: { approvalPolicy: policy(['release']) },
      notes: { approvalPolicy: { mode: 'none', minimum: 0, authorities: [] } },
      open: { approvalPolicy: policy(['everyone'], { allowSelfApproval: false }) } } };
  const warnings = approvalStaffingWarnings(workflow, author);
  assert.deepEqual(warnings.map((entry) => [entry.id, entry.phase]), [['approval-staffing', 'intake']]);
  assert.match(warnings[0].message, /Nobody but this Story's author can approve intake, and its policy forbids self-approval \(product\)/u);
  assert.equal(warnings[0].nextAction.command, 'singularity-flow story approvers refresh STAFF-1 --reason <why>');
  // A step whose groups name nobody at all, so the author is in none of them, is named too.
  const empty = { ...workflow, phaseOrder: ['release'], resolution: { approvalAuthorities: { release: group() } } };
  const [unstaffed] = approvalStaffingWarnings(empty, author);
  assert.match(unstaffed.message, /Nobody but this Story's author can approve release, and the author is in none of its approval groups \(release\)/u);
});

test('[PHR:REQ-002] finding 17: a supplemental document\'s risk accepted at its step\'s approval also covers the later steps that read it, in the same decision', () => {
  const workflow = (pinned, inputs = ['design']) => ({ workItem: { id: 'DOC-1' }, phaseOrder: ['design', 'build', 'release'],
    resolution: { ...(pinned ? PINNED : {}), phases: [{ id: 'design' }, { id: 'build', inputs }, { id: 'release' }] },
    phases: { design: { id: 'design' }, build: { id: 'build' }, release: { id: 'release' } } });
  // At the document's own approval the reviewers decide its later reads too: never a later step held for it.
  assert.deepEqual(riskDecisionTransitions(workflow(true), 'design', 'approve', { document: true }), ['approve', 'downstream']);
  // Only for a document, only at approval, and only where a later step reads the step.
  assert.deepEqual(riskDecisionTransitions(workflow(true), 'design', 'submit', { document: true }), ['submit']);
  assert.deepEqual(riskDecisionTransitions(workflow(true), 'design', 'approve'), ['approve']);
  assert.deepEqual(riskDecisionTransitions(workflow(true, []), 'design', 'approve', { document: true }), ['approve']);
  // A Story started before the check keeps one transition per decision.
  assert.deepEqual(riskDecisionTransitions(workflow(false), 'design', 'approve', { document: true }), ['approve']);
});

test('[PHR:REQ-007] owner decision 2: a sign-off is deferred, by a person, only to a later step that can perform and repair it, which then holds it', () => {
  const { workflow, evaluation, AC2 } = codeStep({ inspection: true });
  // A later code step can change the inspected file, so it can take the sign-off; the non-code testing step cannot.
  workflow.phaseOrder = ['intake', 'implementation', 'polish', 'testing'];
  workflow.phases.polish = { id: 'polish', label: 'polish', status: 'not_started', generation: 0, approvals: [],
    approvalPolicy: { mode: 'required', minimum: 1, authorities: ['reviewers'] }, generationPolicy: { task: 'code' } };
  assert.deepEqual(witnessDeferralCandidates(workflow, { from: 'implementation', method: 'inspection' }), ['polish']);
  const decide = (to) => recordWitnessDeferral(workflow, { clauseId: AC2, slot: 'docs', method: 'inspection', from: 'implementation', to,
    reason: 'The runbook is rewritten in the polish step, so it is inspected there.', actor: 'reviewer', authorityGroup: 'reviewers', at: '2026-11-10T08:00:00.000Z' });
  assert.throws(() => decide('testing'), (error) => error.code === 'WITNESS_DEFERRAL_INVALID'
    && /testing can neither change the file the sign-off reads nor capture the screens it shows/u.test(error.message)
    && error.details.candidates.includes('polish'));
  assert.throws(() => decide('intake'), (error) => error.code === 'WITNESS_DEFERRAL_INVALID' && /does not come after implementation/u.test(error.message));
  // Before any deferral the delivering step holds it, and names the deferral among its routes.
  const held = inspectionWitnessRefusal(workflow, workflow.phases.implementation, evaluation);
  assert.ok(held.details.recoveryCommands.some((entry) => entry.command === `singularity-flow decision witness-defer CODE-1 --criterion ${AC2} --slot docs --to polish --reason <why>`),
    JSON.stringify(held.details.recoveryCommands));
  const record = decide('polish');
  assert.deepEqual([record.id, record.from, record.to], ['WDF-001', 'implementation', 'polish']);
  // Deferred: the delivering step is no longer held for it; the step it names holds it as its own check.
  assert.equal(inspectionWitnessRefusal(workflow, workflow.phases.implementation, evaluation), null);
  const moved = inspectionWitnessRefusal(workflow, workflow.phases.polish, evaluation);
  assert.deepEqual(moved.details.criteria.map((entry) => [entry.clauseId, entry.slot, entry.deferredFrom]), [[AC2, 'docs', 'implementation']]);
  assert.equal(moved.details.nextAction.command, 'singularity-flow decisions CODE-1');
  // The dated risk stays a route beside it, at both steps.
  assert.ok(moved.details.recoveryCommands.some((entry) => /^singularity-flow decision risk --obligation OBL:CODE-1:verify:/u.test(entry.command)));
});

/** A Story's last code step and a visual verification step after it, with one criterion each test or sign-off answers for. */
function laterChecksStory({ pinned = true, spec = { mode: 'enforce', coverage: 'record', acceptance: 'verify' } } = {}) {
  const step = (id, extra = {}) => ({ id, label: id, status: 'approved', generation: 1, approvals: [],
    approvalPolicy: { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [], rejectTo: [id] }, ...extra });
  return { workItem: { id: 'LATE-1' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['planning', 'implementation', 'screens'],
    resolution: { ...(pinned ? PINNED : {}), spec },
    phases: { planning: step('planning', { requiredArtifact: { kind: 'implementation-plan' } }),
      implementation: step('implementation', { status: 'in_progress', generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' } }),
      screens: step('screens', { status: 'not_started', generation: 0, requiredArtifact: { kind: 'visual-test-evidence' } }) } };
}

test('[PHR:REQ-007] G6: the acceptance the ending judges refuses the last code step\'s submission, where its author runs it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phr-accept-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Accept Test'); git('config', 'user.email', 'accept@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-q', '-m', 'base');
  const AC = 'LATE-1:AC-001';
  const records = { indexes: [{ workId: 'LATE-1', phase: 'planning', generation: 1, clauses: [{ id: AC, type: 'AC' }] }],
    planned: [{ workId: 'LATE-1', phase: 'planning', generation: 1, kind: 'planned', claims: { [AC]: { expectedPaths: ['src/a.mjs'], tests: ['test/a.test.mjs'], testDisposition: 'applicable' } } }],
    observed: [], acceptance: [] };
  const config = { workItemRoot: 'singularity/work-items' };
  const story = laterChecksStory();
  const refusal = await acceptanceOwnerRefusal(root, config, story, story.phases.implementation, { records });
  assert.equal(refusal?.code, 'SPEC_ACCEPTANCE_INCOMPLETE');
  assert.deepEqual(refusal.details.findings.map((entry) => entry.code).sort(), ['gate.acceptance.observed-test-missing', 'gate.acceptance.run-missing']);
  assert.equal(refusal.details.ownerPhase, 'implementation');
  assert.equal(refusal.details.nextAction.command, 'singularity-flow spec acceptance --phase implementation');
  assert.equal(refusalRemediationPlan(refusal, ['submit', 'implementation']).steps.some((entry) => entry.command === refusal.details.nextAction.command), true);
  // The same evaluation the ending runs: the gate's own findings for these records, less the plan's.
  const { entries } = await specAcceptanceFindings(root, config, story, story.resolution.spec, records);
  assert.deepEqual(entries.map((entry) => entry.code).sort(), refusal.details.findings.map((entry) => entry.code).sort());
  // Nothing where the ending refuses nothing, for a Story started before, or at a step that is not the last code step.
  assert.equal(await acceptanceOwnerRefusal(root, config, laterChecksStory({ spec: { mode: 'record', acceptance: 'verify' } }), story.phases.implementation, { records }), null);
  assert.equal(await acceptanceOwnerRefusal(root, config, laterChecksStory({ pinned: false }), story.phases.implementation, { records }), null);
  assert.equal(await acceptanceOwnerRefusal(root, config, story, story.phases.planning, { records }), null);
});

test('[PHR:REQ-007] a visual sign-off is the visual step\'s to hold, and evidence from before a scope revision the code step\'s', () => {
  const story = laterChecksStory();
  const AC = 'LATE-1:AC-001';
  const row = (extra = {}) => ({ id: AC, type: 'AC', findings: [], actions: [],
    obligations: [{ id: 'OBL-1', responsibility: 'verify', status: 'missing', owningSteps: ['implementation'] }],
    verification: { contract: { slots: [{ slot: 'screen', method: 'visual', role: 'primary', status: 'missing' }] } }, ...extra });
  const evaluation = { rows: [row()] };
  assert.deepEqual(ownSignOffs(evaluation, story, 'implementation'), [], 'the code step does not capture the screens');
  const [held] = ownSignOffs(evaluation, story, 'screens');
  assert.deepEqual([held.clauseId, held.slot, held.findings[0].code], [AC, 'screen', 'EVIDENCE_VISUAL_MISSING']);
  assert.equal(inspectionWitnessRefusal(story, story.phases.screens, evaluation)?.details.ownerPhase, 'screens');
  // On a route with no visual step, the code step that delivers the criterion holds it.
  const noScreens = { ...story, phaseOrder: ['planning', 'implementation'], phases: { planning: story.phases.planning, implementation: story.phases.implementation } };
  assert.equal(ownSignOffs(evaluation, noScreens, 'implementation').length, 1);

  const stale = { rows: [row({ verification: null, findings: [{ code: 'EVIDENCE_STALE_AFTER_SCOPE_REVISION', message: `${AC} changed in scope revision 2.`, obligationIds: ['OBL-1'] }] })] };
  const refusal = staleEvidenceRefusal(story, story.phases.implementation, stale);
  assert.equal(refusal?.code, 'EVIDENCE_STALE_AFTER_SCOPE_REVISION');
  assert.equal(refusal.details.repairCommand, 'singularity-flow reject implementation --work-id LATE-1 --fetch --reason <REASON>');
  assert.equal(staleEvidenceRefusal(story, story.phases.screens, stale), null, 'only the step that answers for it');
  assert.equal(staleEvidenceRefusal(laterChecksStory({ pinned: false }), story.phases.implementation, stale), null);
});
