import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveWorkType, normalizeGenerationPolicy } from '../src/config.mjs';
import { normalizeApprovalPolicy, normalizeApprovalSecurity } from '../src/approval-authority.mjs';
import { inputFindingSeverity, qualityValidationVerdict } from '../src/lifecycle-evidence-policy.mjs';
import { recordSha256 } from '../src/records.mjs';
import { compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill, skillCandidateCatalogSha256,
  skillContractSha256, skillPhaseCandidateSha256 } from '../src/skp-contract.mjs';
import { simulateResolvedWorkflowLifecycle, WORKFLOW_LIFECYCLE_SIMULATION_PROFILE,
  WORKFLOW_LIFECYCLE_SIMULATION_LIMITS } from '../src/workflow-lifecycle-simulation.mjs';
import { planSkillAmendmentEvidence } from '../src/skp-amendment-plan.mjs';

const hash = (char) => `sha256:${char.repeat(64)}`;
function definition() {
  const phase = (id, approval = 'none') => ({ label: id, artifact: { path: `artifacts/${id}/${id}.md`, minimumBytes: 20, maximumBytes: 16384 },
    defaultTemplate: 'common/empty.md', inputs: [], approval, writeScope: 'artifact-only',
    generation: { requirement: 'required', defaultProducer: 'human', allowedProducers: ['human'], task: 'analyze' }, qualityCommands: [] });
  return { version: 11, templatesRoot: 'singularity/templates', templates: {}, inputsMode: 'enforce',
    approvalSecurity: { profile: 'team' }, approvalAuthorities: { reviewers: { members: [{ email: 'reviewer@example.test' }, { email: 'second@example.test' }] } },
    phases: { intake: phase('intake'), analysis: phase('analysis', { authorities: ['reviewers'], minimum: 1 }), conformance: phase('conformance') },
    workTypes: { notes: { label: 'Notes', phases: ['intake', 'analysis', 'conformance'] } } };
}
function fixture(configure = () => {}) { const value = definition(); configure(value); return resolveWorkType(value, 'notes'); }
function find(report, id) { const result = report.scenarios.find((value) => value.id === id); assert.ok(result, `${id}: ${JSON.stringify(report.findings)}`); return result; }

test('structural lifecycle report is deterministic, immutable, bounded and exact-definition-addressed without mutating its owner resolution', () => {
  const resolved = fixture(); const before = structuredClone(resolved);
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile'); assert.equal(report.profile, WORKFLOW_LIFECYCLE_SIMULATION_PROFILE);
  assert.equal(report.sourceDefinitionSha256, `sha256:${recordSha256(resolved)}`);
  assert.equal(report.workflowId, resolved.id);
  assert.deepEqual(report, simulateResolvedWorkflowLifecycle(structuredClone(resolved)));
  assert.deepEqual(resolved, before); assert.ok(Object.isFrozen(report)); assert.ok(Object.isFrozen(report.scenarios[0].events));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.outputBytes);
  assert.equal(find(report, 'happy-path').outcome, 'expected-transition');
  assert.equal(find(report, 'completion').outcome, 'expected-refusal');
  assert.equal(report.effects.modelCalls, 0); assert.equal(report.effects.externalCalls, 0);
  assert.ok(Object.values(report.effects).every((value) => value === false || value === 0));
  assert.ok(report.coverage.excluded.includes('human-availability')); assert.ok(report.coverage.excluded.includes('native-host-enforcement'));
  assert.match(report.assumptions.join('\n'), /hypothetical.*not observed evidence/);
  assert.equal(JSON.stringify(report).includes('reviewer@example.test'), false);
});

test('generation zero needs publication even when approval or generation requirements are none', () => {
  const resolved = fixture((value) => { value.phases.intake.generation.requirement = 'none'; });
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile');
  const initial = find(report, 'publication-required:intake');
  assert.equal(initial.approvalMode, 'none'); assert.equal(initial.generationRequirement, 'none');
  assert.equal(initial.events[0].disposition, 'refused'); assert.equal(initial.events[1].to, 'generation-not-required');
  assert.ok(find(report, 'happy-path').events.some((event) => event.action === 'publish-assumed-output'));
});

test('required review is a valid human wait and partial approval cannot advance', () => {
  const report = simulateResolvedWorkflowLifecycle(fixture((value) => { value.phases.analysis.approval.minimum = 2; }));
  assert.equal(report.status, 'complete-for-profile');
  assert.equal(find(report, 'human-wait:analysis').outcome, 'expected-wait');
  const threshold = find(report, 'approval-threshold:analysis');
  assert.equal(threshold.events[0].to, 'awaiting_approval');
  assert.equal(threshold.events[1].disposition, 'conditional-on-real-eligible-distinct-humans');
  assert.equal(find(report, 'human-wait:analysis').minimum, 2);
});

test('unattainable and overlapped required reviewer assignments invalidate the structural route', () => {
  const resolved = fixture(); resolved.approvalSecurity.autoEnrollNewIdentities = false;
  resolved.phases[1].approval.minimum = 3;
  assert.ok(simulateResolvedWorkflowLifecycle(resolved).findings.some((finding) => finding.code === 'WCA_SIMULATION_APPROVAL_UNATTAINABLE'));
  const overlap = fixture(); overlap.approvalSecurity.autoEnrollNewIdentities = false;
  overlap.approvalAuthorities = {
    first: { members: [{ email: 'same@example.test' }] }, second: { members: [{ email: 'same@example.test' }] }, optional: { members: [{ email: 'different@example.test' }] }
  };
  overlap.phases[1].approval = normalizeApprovalPolicy({ authorities: ['first', 'second', 'optional'], requiredAuthorities: ['first', 'second'], minimum: 2 }, overlap.approvalAuthorities, 'analysis');
  const report = simulateResolvedWorkflowLifecycle(overlap);
  assert.equal(report.status, 'invalid'); assert.deepEqual(report.scenarios, []);
  assert.ok(report.findings.some((finding) => finding.code === 'WCA_SIMULATION_APPROVAL_UNATTAINABLE'));
  assert.equal(JSON.stringify(report).includes('same@example.test'), false);
});

test('Story-start auto-enrollment supplies one hypothetical creator but never an independent reviewer or two required groups', () => {
  const resolved = fixture((value) => { value.approvalAuthorities.reviewers.members = []; });
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile');
  assert.equal(find(report, 'human-wait:analysis').outcome, 'expected-wait');
  assert.match(report.assumptions.join('\n'), /hypothetical new creator/);

  const disabled = structuredClone(resolved);
  disabled.approvalSecurity.autoEnrollNewIdentities = false;
  assert.ok(simulateResolvedWorkflowLifecycle(disabled).findings.some((finding) => finding.code === 'WCA_SIMULATION_APPROVAL_UNATTAINABLE'));

  const independent = structuredClone(resolved);
  independent.phases[1].approval.allowSelfApproval = false;
  assert.ok(simulateResolvedWorkflowLifecycle(independent).findings.some((finding) => finding.code === 'WCA_SIMULATION_APPROVAL_UNATTAINABLE'));
  independent.approvalAuthorities.reviewers.members = [{ email: 'independent@example.test' }];
  assert.equal(simulateResolvedWorkflowLifecycle(independent).status, 'complete-for-profile',
    'a named independent reviewer remains sufficient without counting the Story creator');

  const twoRequired = structuredClone(resolved);
  twoRequired.approvalAuthorities = { first: { members: [] }, second: { members: [] } };
  twoRequired.phases[1].approval = normalizeApprovalPolicy({ authorities: ['first', 'second'],
    requiredAuthorities: ['first', 'second'], minimum: 2 }, twoRequired.approvalAuthorities, 'analysis');
  assert.ok(simulateResolvedWorkflowLifecycle(twoRequired).findings.some((finding) => finding.code === 'WCA_SIMULATION_APPROVAL_UNATTAINABLE'));
});

test('regulated approval profile does not assume Story-start enrollment by default', () => {
  const resolved = fixture((value) => {
    value.approvalSecurity = { profile: 'regulated' };
    value.approvalAuthorities.reviewers.members = [{ email: 'reviewer@example.test' }];
    value.phases.analysis.approval.minimum = 2;
  });
  assert.equal(normalizeApprovalSecurity(resolved.approvalSecurity).autoEnrollNewIdentities, false);
  assert.ok(simulateResolvedWorkflowLifecycle(resolved).findings.some((finding) => finding.code === 'WCA_SIMULATION_APPROVAL_UNATTAINABLE'));
});

test('soft sequence gates require separate human override rather than silently proceeding', () => {
  const resolved = fixture(); resolved.sequenceGates = { default: 'soft' };
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(find(report, 'out-of-order').events[0].disposition, 'human-override-required-not-assumed');
  assert.equal(find(report, 'publication-required:intake').events[0].disposition, 'human-override-required');
  assert.equal(find(report, 'completion').events[0].disposition, 'human-reopen-override-required');
  assert.equal(find(report, 'out-of-order').outcome, 'expected-refusal');
});

test('required inputs model missing, unapproved, stale generation and exact-output continuity', () => {
  const report = simulateResolvedWorkflowLifecycle(fixture((value) => { value.phases.analysis.inputs = ['intake']; }));
  assert.equal(report.status, 'complete-for-profile');
  for (const status of ['missing', 'unapproved', 'hash-mismatch', 'stale-generation-or-receipt']) {
    const item = find(report, `input:analysis:intake:primary:${status}`);
    assert.equal(item.events[0].disposition, 'refused'); assert.equal(item.identity, 'exact-declared-output-current-approved-generation');
  }
});

test('optional inputs tolerate only absence/unapproved, never stale identity; record and off modes remain distinct', () => {
  for (const mode of ['enforce', 'record', 'off']) {
    const report = simulateResolvedWorkflowLifecycle(fixture((value) => { value.inputsMode = mode; value.phases.analysis.inputs = [{ phase: 'intake', optional: true }]; }));
    assert.equal(report.status, 'complete-for-profile');
    assert.equal(find(report, 'input:analysis:intake:primary:missing').events[0].disposition, mode === 'off' ? 'not-enforced' : 'optional-tolerated');
    assert.equal(find(report, 'input:analysis:intake:primary:hash-mismatch').events[0].disposition, mode === 'off' ? 'not-enforced' : mode === 'record' ? 'warning' : 'refused');
  }
});

test('unresolved, forward and wrong-path inputs do not produce a fictional successful route', () => {
  for (const input of [{ phase: 'unknown', optional: false }, { phase: 'conformance', optional: false }, { phase: 'intake', path: 'artifacts/intake/other.md', optional: false }]) {
    const resolved = fixture(); resolved.phases[1].inputs = [input];
    const report = simulateResolvedWorkflowLifecycle(resolved);
    assert.equal(report.status, 'invalid'); assert.deepEqual(report.scenarios, []);
    assert.ok(report.findings.some((finding) => finding.code === 'WCA_SIMULATION_INPUT_IDENTITY_INVALID'));
  }
});

test('missing external prerequisites wait/refuse and check scripts are never exposed or executed', () => {
  const resolved = fixture((value) => { value.phases.analysis.qualityCommands = [{ id: 'dangerous', command: 'do-not-run-business-operation', requirement: 'required', modelPolicy: 'never' }]; });
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(find(report, 'external-unavailable:analysis').outcome, 'expected-wait');
  assert.equal(find(report, 'quality-failure:analysis').events[0].disposition, 'refused');
  assert.equal(find(report, 'quality-failure:analysis').checksExecuted, false);
  assert.equal(JSON.stringify(report).includes('do-not-run-business-operation'), false);
  assert.equal(report.effects.externalCalls, 0);
});

test('failed checks with a repair budget require reviewer-directed correction and can never be approved', () => {
  const resolved = fixture((value) => { value.phases.analysis.qualityCommands = [{ id: 'lint', argv: ['not-executed'], requirement: 'required', modelPolicy: 'never' }]; value.phases.analysis.repairBudget = { maxAttempts: 2 }; });
  const report = simulateResolvedWorkflowLifecycle(resolved);
  const failed = find(report, 'quality-failure:analysis');
  assert.equal(failed.events[0].to, 'awaiting_approval'); assert.equal(failed.events[0].disposition, 'human-rejection-required');
  assert.equal(failed.events[1].disposition, 'refused');
  resolved.phases[1].approval = normalizeApprovalPolicy('none', resolved.approvalAuthorities, 'analysis');
  const invalid = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(invalid.status, 'invalid'); assert.ok(invalid.findings.some((finding) => finding.code === 'WCA_SIMULATION_REPAIR_REVIEW_UNAVAILABLE'));
});

test('quality failures, unavailable required checks and malformed results reuse the exact runtime predicate without executing a command', () => {
  for (const requirement of ['required', 'optional']) {
    const report = simulateResolvedWorkflowLifecycle(fixture((value) => { value.phases.analysis.qualityCommands = [{ id: 'check:lint', command: 'INERT SCRIPT', requirement, modelPolicy: 'never' }]; }));
    for (const status of ['unavailable', 'malformed']) {
      const item = find(report, `quality-${status}:analysis`);
      const owner = qualityValidationVerdict([{ status, requirement }], { required: requirement === 'required' });
      assert.equal(item.verdict, owner.verdict);
      assert.equal(item.events[0].disposition, owner.invalid.length || owner.unavailableRequired.length ? 'refused' : 'optional-unavailable-not-passed');
      assert.equal(item.checksExecuted, false);
    }
    assert.equal(JSON.stringify(report).includes('INERT SCRIPT'), false);
  }
});

test('approved-summary prerequisites preserve input policy and never treat a stale brief or expansion as approved source evidence', () => {
  for (const mode of ['enforce', 'record', 'off']) {
    const resolved = fixture((value) => { value.inputsMode = mode; value.phases.analysis.inputs = [{ phase: 'intake', optional: true, projection: 'approved-summary', fallback: 'whole' }]; });
    const report = simulateResolvedWorkflowLifecycle(resolved);
    for (const status of ['brief_missing', 'brief_invalid', 'expansion_missing']) {
      const item = find(report, `input-projection:analysis:intake:${status}`);
      const owner = mode === 'off' ? null : inputFindingSeverity(mode, true, status);
      assert.equal(item.events[0].disposition, mode === 'off' ? 'not-enforced' : owner === 'error' ? 'refused' : 'warning');
      assert.equal(item.observed, false); assert.equal(item.ownerStatus, status);
    }
    assert.equal(find(report, 'input:analysis:intake:primary:captured').ownerStatus, 'captured');
  }
  const unresolved = fixture((value) => { value.phases.analysis.inputs = [{ phase: 'intake', projection: 'approved-summary' }]; });
  unresolved.harnessImports.mode = 'off';
  const report = simulateResolvedWorkflowLifecycle(unresolved);
  assert.equal(report.status, 'invalid'); assert.ok(report.findings.some((finding) => finding.code === 'WCA_SIMULATION_EXPANSION_UNAVAILABLE'));
});

test('standalone repair policies exhaust on owner-selected failed validation and reset only on a new reset generation', () => {
  const resolved = fixture((value) => { value.phases.analysis.repairBudget = { maxAttempts: 2, resetOnPhase: 'intake' }; });
  const before = structuredClone(resolved); const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile');
  assert.equal(find(report, 'repair-budget:analysis').events.at(-1).disposition, 'refused-budget-exhausted');
  const reset = find(report, 'repair-budget-reset:analysis');
  assert.equal(reset.events[0].disposition, 'budget-not-cleared'); assert.equal(reset.events[1].disposition, 'new-budget-epoch');
  assert.deepEqual(resolved, before);
  resolved.phases[1].repairBudget.maxAttempts = 101;
  assert.equal(simulateResolvedWorkflowLifecycle(resolved).status, 'invalid');
});

test('ordinary artifact sets are resolved through the pinned owner and distinguish required and advisory optional members', () => {
  const resolved = fixture((value) => {
    value.phases.analysis.artifactSet = 'analysis-bundle';
    value.artifactSets = { 'analysis-bundle': { primary: 'analysis.md', members: [
      { path: 'analysis.md', role: 'primary', required: true },
      { path: 'required-evidence/', role: 'evidence', required: true },
      { path: 'planning.md', role: 'planning', authority: 'advisory', required: false }
    ] } };
  });
  const report = simulateResolvedWorkflowLifecycle(resolved); assert.equal(report.status, 'complete-for-profile');
  assert.equal(find(report, 'artifact-member:analysis:1').events[0].disposition, 'refused');
  assert.equal(find(report, 'artifact-member:analysis:2').required, true);
  const advisory = find(report, 'artifact-member:analysis:3'); assert.equal(advisory.authority, 'advisory');
  assert.equal(advisory.events[0].disposition, 'optional-tolerated'); assert.equal(advisory.advisoryIsApprovalEvidence, false);
  assert.equal(JSON.stringify(report).includes('required-evidence/'), false);
  const altered = structuredClone(resolved); altered.artifactSets['analysis-bundle'].primary = 'planning.md';
  assert.ok(simulateResolvedWorkflowLifecycle(altered).findings.some((finding) => finding.code === 'WCA_SIMULATION_ARTIFACT_SET_PRIMARY_INVALID'));
  delete altered.artifactSets['analysis-bundle'];
  const missing = simulateResolvedWorkflowLifecycle(altered); assert.equal(missing.status, 'incomplete'); assert.deepEqual(missing.scenarios, []);
});

test('long existing owner-admitted identifiers remain compatible within byte bounds and profile overflows are incomplete', () => {
  const resolved = fixture(); resolved.id = 'long'.repeat(30);
  assert.equal(simulateResolvedWorkflowLifecycle(resolved).status, 'complete-for-profile');
  resolved.id = 'x'.repeat(WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.idBytes + 1);
  const report = simulateResolvedWorkflowLifecycle(resolved); assert.equal(report.status, 'incomplete'); assert.equal(report.findings[0].code, 'WCA_SIMULATION_LIMIT');
});

test('declared bounded rework invalidates full target range, exhausts and resets only at a new pinned reset generation', () => {
  const resolved = fixture((value) => {
    value.phases.conformance.approval = { authorities: ['reviewers'], minimum: 1 };
    value.workTypes.notes.reworkLoops = [{ from: 'conformance', to: 'analysis', maxAttempts: 2, resetOnPhase: 'intake' }];
  });
  const before = structuredClone(resolved); const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile');
  const loop = find(report, 'rework:conformance:analysis');
  assert.deepEqual(loop.affectedPhases, ['analysis', 'conformance']);
  const exhausted = find(report, 'rework-budget-exhaustion:conformance:analysis');
  assert.equal(exhausted.outcome, 'expected-refusal'); assert.equal(exhausted.stateUnchanged, true);
  assert.equal(exhausted.events.at(-1).disposition, 'refused-budget-exhausted');
  assert.equal(exhausted.events.some((event) => event.action === 'reopen-range'), false);
  assert.ok(loop.events.some((event) => event.disposition === 'refused-until-fresh-generation-and-approval'));
  assert.equal(find(report, 'budget-reset:conformance:analysis').outcome, 'expected-transition');
  assert.deepEqual(resolved, before);
});

test('all normalized legacy rejection edges are covered without inventing budgets or silently authorizing inactive targets', () => {
  const resolved = fixture((value) => { value.phases.analysis.approval.rejectTo = ['intake', 'analysis', 'unknown', 'conformance']; });
  const before = structuredClone(resolved); const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile');
  const backward = find(report, 'rejection-edge:analysis:intake');
  assert.deepEqual(backward.affectedPhases, ['intake', 'analysis', 'conformance']);
  assert.equal(backward.budgetPolicy, 'none-selected-no-quota-inferred'); assert.equal(backward.observed, false);
  assert.deepEqual(find(report, 'rejection-edge:analysis:analysis').affectedPhases, ['analysis', 'conformance']);
  assert.equal(find(report, 'rejection-edge:analysis:unknown').events[0].disposition, 'refused-invalid-target');
  assert.equal(find(report, 'rejection-edge:analysis:conformance').events[0].disposition, 'refused-invalid-target');
  assert.equal(find(report, 'rejection-edge:intake:intake').events[0].disposition, 'refused-no-human-review-state');
  assert.ok(report.coverage.excluded.includes('termination-of-legacy-unbudgeted-human-rejection-loops'));
  assert.deepEqual(resolved, before);
});

test('generation none preserves the owner policy after rework while old output approvals remain invalidated', () => {
  const resolved = fixture((value) => { value.phases.intake.generation.requirement = 'none'; value.phases.analysis.approval.rejectTo = ['intake']; });
  const item = find(simulateResolvedWorkflowLifecycle(resolved), 'rejection-edge:analysis:intake');
  assert.equal(item.generation, 'owner-generation-policy-preserved');
  assert.equal(item.events.at(-1).disposition, 'not-current-approved-input');
});

test('a return to the repair reset phase is not fabricated as an exhausted attempt or observed new generation', () => {
  const resolved = fixture((value) => { value.phases.analysis.repairBudget = { maxAttempts: 2, resetOnPhase: 'analysis' }; });
  const report = simulateResolvedWorkflowLifecycle(resolved); assert.equal(report.status, 'complete-for-profile');
  const reset = find(report, 'repair-budget-reset-target:analysis');
  assert.equal(reset.events[0].disposition, 'reset-generation-requested-no-attempt-consumed');
  assert.equal(reset.actualNewGeneration, 'not-observed');
});

test('ordinary input cycles, unbounded loops and mismatched effective loop budgets refuse', () => {
  const cyclic = fixture(); cyclic.phases[0].inputs = [{ phase: 'analysis', optional: false }];
  assert.equal(simulateResolvedWorkflowLifecycle(cyclic).status, 'invalid');
  const invalidLoop = fixture(); invalidLoop.reworkLoops = [{ from: 'conformance', to: 'analysis', maxAttempts: Infinity }];
  assert.equal(simulateResolvedWorkflowLifecycle(invalidLoop).status, 'invalid');
  const mismatch = fixture((value) => { value.phases.conformance.approval = { authorities: ['reviewers'] }; value.workTypes.notes.reworkLoops = [{ from: 'conformance', to: 'analysis', maxAttempts: 2 }]; });
  mismatch.phases[1].repairBudget.maxAttempts = 1;
  const report = simulateResolvedWorkflowLifecycle(mismatch);
  assert.equal(report.status, 'invalid'); assert.ok(report.findings.some((finding) => finding.code === 'WCA_SIMULATION_REWORK_BUDGET_MISMATCH'));
});

function skillFixture(extraOutputs = [], { primaryOutputId = 'notes' } = {}) {
  const phase = { id: 'analysis', kind: 'skill', label: 'Analysis', skill: { id: 'analysis-skill', packageSha256: hash('a') }, contract: {
    task: 'analyze', consumes: [{ phase: 'intake', output: 'primary', required: true, state: 'approved' }],
    produces: [{ id: primaryOutputId, path: 'artifacts/analysis/analysis.md', kind: 'custom:notes', mediaType: 'text/markdown', encoding: 'utf-8', minimumBytes: 20, maximumBytes: 16384, clauses: 'none', claimRole: 'findings' }, ...extraOutputs],
    checks: [], writeScope: 'artifact-only', readScope: { inputs: true, sourcePaths: [] }, approval: { authorities: ['reviewers'], minimum: 1 }
  } };
  const catalog = { skillPackages: { 'analysis-skill': { packageSha256: hash('a'), eligibility: 'candidate-producer' } }, phases: { intake: { outputs: [{ id: 'primary', path: 'artifacts/intake/intake.md' }] } }, checks: {}, approvalAuthorities: definition().approvalAuthorities, approvalSecurity: { profile: 'team' }, readPaths: [], sourceScopes: {}, artifactSets: {} };
  if (extraOutputs.length) {
    phase.contract.primaryOutput = primaryOutputId; phase.contract.artifactSet = 'analysis-outputs';
    catalog.artifactSets['analysis-outputs'] = { primary: 'analysis.md', members: phase.contract.produces.map((output) => ({
      path: output.path.slice('artifacts/analysis/'.length), role: output.id, required: output.required !== false, authority: 'governed'
    })) };
  }
  const order = ['intake', 'analysis', 'conformance']; const catalogSha256 = skillCandidateCatalogSha256(catalog);
  const compiled = compileConfirmedSkillPhase({ phase, catalog, phaseOrder: order, confirmation: { contractSha256: skillContractSha256(phase.id, phase.contract), catalogSha256, packageSha256: hash('a'), candidateSha256: skillPhaseCandidateSha256(phase, order, catalogSha256), planSha256: hash('b'), draftRevision: 1 } });
  return fixture((value) => { value.version = 3; value.phases.analysis = configurationPhaseFromCompiledSkill(compiled); value.inputsMode = 'off';
    if (extraOutputs.length) value.artifactSets = catalog.artifactSets; });
}

test('confirmed skill structure always enforces exact output inputs without claiming qualified host or real receipts', () => {
  const report = simulateResolvedWorkflowLifecycle(skillFixture());
  assert.equal(report.status, 'complete-for-profile');
  assert.equal(find(report, 'input:analysis:intake:primary:missing').mode, 'enforce');
  assert.equal(find(report, 'input:analysis:intake:primary:stale-generation-or-receipt').events[0].disposition, 'refused');
  assert.equal(find(report, 'external-unavailable:analysis').host, 'enforcement-unavailable');
  assert.equal(report.effects.executed, false);
});

test('confirmed multi-output skills join the exact governed artifact set and selected optional output keeps receipt continuity', () => {
  const resolved = skillFixture([{ id: 'extra', path: 'artifacts/analysis/extra.md', kind: 'custom:notes', mediaType: 'text/markdown',
    encoding: 'utf-8', minimumBytes: 20, maximumBytes: 16384, clauses: 'none', claimRole: 'none', required: false }]);
  const report = simulateResolvedWorkflowLifecycle(resolved); assert.equal(report.status, 'complete-for-profile', JSON.stringify(report.findings));
  assert.equal(find(report, 'optional-output:analysis:extra').events[1].disposition, 'refused-exact-selected-output-required');
  const altered = structuredClone(resolved); const set = altered.artifactSets[altered.phases[1].artifactSet]; set.members[1].required = true;
  assert.ok(simulateResolvedWorkflowLifecycle(altered).findings.some((finding) => finding.code === 'WCA_SIMULATION_SKP_ARTIFACT_SET_INVALID'));
});

function amendmentFixture({ sharedPackage = false } = {}) {
  const value = definition(); value.version = 3;
  const order = ['intake', 'analysis', 'audit', 'review', 'conformance'];
  const selected = order.slice(1).map((id) => ({ id,
    skillId: sharedPackage && ['analysis', 'audit'].includes(id) ? 'shared-skill' : `${id}-skill`,
    producer: ['analysis', 'audit'].includes(id) ? 'intake' : id === 'review' ? 'analysis' : 'review' }));
  const catalog = { skillPackages: Object.fromEntries(selected.map(({ skillId }) => [skillId,
    { packageSha256: hash('a'), eligibility: 'candidate-producer' }])),
  phases: Object.fromEntries(order.map((id) => [id, { outputs: [{ id: id === 'intake' ? 'primary' : 'notes',
    path: `artifacts/${id}/${id}.md` }] }])), checks: {}, approvalAuthorities: value.approvalAuthorities,
  approvalSecurity: { profile: 'team' }, readPaths: [], sourceScopes: {}, artifactSets: {} };
  const catalogSha256 = skillCandidateCatalogSha256(catalog);
  for (const { id, skillId, producer } of selected) {
    const phase = { id, kind: 'skill', label: id, skill: { id: skillId, packageSha256: hash('a') }, contract: {
      task: 'analyze', consumes: [{ phase: producer, output: producer === 'intake' ? 'primary' : 'notes', required: true, state: 'approved' }],
      produces: [{ id: 'notes', path: `artifacts/${id}/${id}.md`, kind: 'custom:notes', mediaType: 'text/markdown',
        encoding: 'utf-8', minimumBytes: 20, maximumBytes: 16384, clauses: 'none', claimRole: 'findings' }],
      checks: [], writeScope: 'artifact-only', readScope: { inputs: true, sourcePaths: [] },
      approval: { authorities: ['reviewers'], minimum: 1 }
    } };
    const compiled = compileConfirmedSkillPhase({ phase, catalog, phaseOrder: order,
      confirmation: { contractSha256: skillContractSha256(id, phase.contract), catalogSha256, packageSha256: hash('a'),
        candidateSha256: skillPhaseCandidateSha256(phase, order, catalogSha256), planSha256: hash('b'), draftRevision: 1 } });
    value.phases[id] = configurationPhaseFromCompiledSkill(compiled);
  }
  value.workTypes.notes.phases = order;
  return resolveWorkType(value, 'notes');
}

test('hypothetical package amendment shares the owner dependency proof and revalidates dependents while preserving independent approvals', () => {
  const resolved = amendmentFixture(); const before = structuredClone(resolved);
  const expected = planSkillAmendmentEvidence(resolved, { replacedSkillIds: ['analysis-skill'] });
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile', JSON.stringify(report.findings));
  const amendment = find(report, 'package-amendment:analysis-skill');
  assert.equal(amendment.outcome, 'expected-transition'); assert.equal(amendment.dependencyProof, 'ready');
  assert.deepEqual(amendment.affectedPhases, expected.affectedPhaseIds);
  assert.deepEqual(amendment.preservedPhases, expected.preservedPhaseIds);
  assert.deepEqual(amendment.revalidatedPhases, ['analysis', 'review', 'conformance']);
  assert.deepEqual(amendment.preservedPhases, ['intake', 'audit']);
  assert.equal(amendment.preservedEvidenceUnchanged, true);
  assert.equal(amendment.priorAffectedApprovals, 'invalidated');
  assert.equal(amendment.priorGenerations, 'retained-but-not-fresh');
  const progression = amendment.events.filter((event) => event.action === 'new-publication-and-review-assumed');
  assert.equal(progression[0].to, 'review', 'the transition owner skips the approved independent audit');
  assert.equal(progression.at(-1).to, 'closed');
  assert.equal(amendment.actualAmendment, 'not-created'); assert.equal(amendment.actualReceiptAcceptance, 'not-assessed');
  assert.equal(amendment.observed, false); assert.equal(report.effects.executed, false);
  assert.ok(report.coverage.dimensions.includes('skill-amendment-invalidation'));
  assert.ok(report.coverage.excluded.includes('historical-amendment-impact'));
  assert.deepEqual(resolved, before);
  assert.deepEqual(report, simulateResolvedWorkflowLifecycle(structuredClone(resolved)));
});

test('one hypothetical package replacement covers every selected phase sharing that package', () => {
  const report = simulateResolvedWorkflowLifecycle(amendmentFixture({ sharedPackage: true }));
  assert.equal(report.status, 'complete-for-profile', JSON.stringify(report.findings));
  const amendment = find(report, 'package-amendment:shared-skill');
  assert.deepEqual(amendment.affectedPhases, ['analysis', 'audit', 'review', 'conformance']);
  assert.deepEqual(amendment.preservedPhases, ['intake']);
  assert.equal(report.scenarios.filter((scenario) => scenario.id === 'package-amendment:shared-skill').length, 1);
});

test('unknown amendment dependencies refuse selective reuse without changing ordinary structural readiness or inventing independence', () => {
  const resolved = skillFixture(); const before = structuredClone(resolved);
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile');
  const amendment = find(report, 'package-amendment:analysis-skill');
  assert.equal(amendment.outcome, 'expected-refusal'); assert.equal(amendment.dependencyProof, 'blocked');
  assert.deepEqual(amendment.affectedPhases, ['analysis']);
  assert.deepEqual(amendment.unknownPhases, ['conformance']);
  assert.deepEqual(amendment.preservedPhases, ['intake']);
  assert.equal(amendment.preservedEvidenceReuse, 'not-authorized');
  assert.equal(amendment.revalidation, 'not-projected');
  assert.equal(amendment.events[0].disposition, 'refused-dependency-unproven');
  assert.deepEqual(resolved, before);
});

test('dependency-proven amendment still refuses an affected phase with no publishable generation', () => {
  const resolved = skillFixture([], { primaryOutputId: 'primary' });
  resolved.phases[2].inputs = [{ phase: 'analysis', optional: false }];
  resolved.phases[2].generation.requirement = 'none';
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile', JSON.stringify(report.findings));
  const amendment = find(report, 'package-amendment:analysis-skill');
  assert.equal(amendment.dependencyProof, 'ready'); assert.equal(amendment.outcome, 'expected-refusal');
  assert.deepEqual(amendment.affectedPhases, ['analysis', 'conformance']);
  assert.equal(amendment.events[0].disposition, 'refused-generation-unavailable');
  assert.equal(amendment.actualAmendment, 'not-created');
});

test('unconfirmed skill proposal is incomplete and never receives an invented runtime binding', () => {
  const resolved = fixture(); resolved.phases[1].kind = 'skill'; const before = structuredClone(resolved);
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'incomplete'); assert.deepEqual(report.scenarios, []);
  assert.ok(report.findings.some((finding) => finding.code === 'WCA_SIMULATION_SKP_BINDING_UNAVAILABLE'));
  assert.deepEqual(resolved, before);
  const missingConfirmation = skillFixture(); delete missingConfirmation.phases[1].skillBinding.bindingRefs.confirmation;
  assert.equal(simulateResolvedWorkflowLifecycle(missingConfirmation).status, 'incomplete');
});

test('convergence requires deterministic publication and its separate exact human advancement', () => {
  const resolved = fixture(); const phase = resolved.phases[1]; phase.id = 'convergence'; phase.artifact.path = 'artifacts/convergence/result.md'; phase.artifact.kind = 'convergence-report';
  phase.generation = normalizeGenerationPolicy({ requirement: 'required', defaultProducer: 'deterministic', allowedProducers: ['deterministic'] }, 'convergence');
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'complete-for-profile'); assert.equal(find(report, 'convergence-human-advance').events[0].disposition, 'refused-human-advance-required');
  phase.approval.mode = 'none'; assert.equal(simulateResolvedWorkflowLifecycle(resolved).status, 'invalid');
});

test('budgets, malformed object graphs and hostile getters fail without partial successful or disclosed reports', () => {
  const oversized = fixture(); oversized.phases = Array.from({ length: 65 }, (_, index) => ({ ...oversized.phases[0], id: `phase-${index}`, order: index }));
  const limited = simulateResolvedWorkflowLifecycle(oversized);
  assert.equal(limited.status, 'incomplete'); assert.deepEqual(limited.scenarios, []); assert.equal(limited.findings[0].code, 'WCA_SIMULATION_LIMIT');
  let calls = 0; const getter = fixture(); Object.defineProperty(getter, 'danger', { enumerable: true, get: () => { calls += 1; throw new Error('PRIVATE ERROR BYTES'); } });
  const refused = simulateResolvedWorkflowLifecycle(getter);
  assert.equal(calls, 0); assert.equal(refused.status, 'invalid'); assert.equal(JSON.stringify(refused).includes('PRIVATE ERROR BYTES'), false);
  const cyclic = fixture(); cyclic.self = cyclic; assert.equal(simulateResolvedWorkflowLifecycle(cyclic).status, 'invalid');
  const huge = fixture(); huge.secretProse = 'x'.repeat(WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.inputBytes + 1);
  assert.equal(simulateResolvedWorkflowLifecycle(huge).status, 'incomplete');
});

test('scenario budget refuses all rather than silently truncating a complete report', () => {
  const resolved = fixture(); const source = resolved.phases[1]; resolved.phases = Array.from({ length: 64 }, (_, index) => ({ ...structuredClone(source),
    id: `phase-${index}`, order: index, artifact: { ...source.artifact, path: `artifacts/phase-${index}/result.md` },
    inputs: Array.from({ length: index }, (_, producer) => ({ phase: `phase-${producer}`, optional: false, path: `artifacts/phase-${producer}/result.md` })) }));
  const report = simulateResolvedWorkflowLifecycle(resolved);
  assert.equal(report.status, 'incomplete'); assert.deepEqual(report.scenarios, []); assert.equal(report.coverage.scenarioCount, 0);
  assert.equal(report.findings[0].code, 'WCA_SIMULATION_LIMIT');
});

test('simulator has no effectful dependency calls and output contains no raw prompts, identities or scripts', async () => {
  const module = await readFile(new URL('../src/workflow-lifecycle-simulation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /\b(?:spawn|execFile|writeFile|readFile|fetch|publishGeneration|submitPhase|approvePhase|rejectPhase|assertPhaseSequence|enforceSequenceGate)\s*\(/u);
  const resolved = fixture(); resolved.prompt = 'DO NOT DISCLOSE THIS RAW PROMPT'; resolved.phases[1].qualityCommands = [{ command: 'DANGEROUS RAW SCRIPT' }];
  const serialized = JSON.stringify(simulateResolvedWorkflowLifecycle(resolved));
  assert.doesNotMatch(serialized, /DO NOT DISCLOSE|DANGEROUS RAW SCRIPT|reviewer@example/);
});
