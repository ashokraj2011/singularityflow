/** Deterministic structural scenarios only. No receipts, permissions or runtime effects are minted. */
import { recordSha256 } from './records.mjs';
import { evaluateSequence, phaseNeedsGeneration, sequenceGateMode } from './sequence.mjs';
import { approvalPolicyCapacity, approvalRequirementsMet, normalizeApprovalSecurity,
  remainingRequiredAuthorities } from './approval-authority.mjs';
import { normalizeReworkLoops, normalizeRepairBudget, repairBudgetPhaseForRejection, consumeRepairAttempt } from './repair-budget.mjs';
import { advanceCompletedPhase, reopenPhaseRange } from './lifecycle-transitions.mjs';
import { validateSkillPhaseBindingHeader } from './skp-contract.mjs';
import { planSkillAmendmentEvidence } from './skp-amendment-plan.mjs';
import path from 'node:path';
import { assertWorkTypeStartable } from './config.mjs';
import { resolvedArtifactSet, memberRoot } from './artifact-sets.mjs';
import { inputFindingSeverity, qualityValidationVerdict } from './lifecycle-evidence-policy.mjs';

export const WORKFLOW_LIFECYCLE_SIMULATION_PROFILE = 'story-structural-lifecycle/v1';
export const WORKFLOW_LIFECYCLE_SIMULATION_LIMITS = Object.freeze({ phases: 64, idBytes: 512, scenarios: 1024,
  events: 16384, findings: 128, loops: 128, inputBytes: 2 * 1024 * 1024, outputBytes: 1024 * 1024,
  nodes: 50000, depth: 32 });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIMENSIONS = ['progression', 'generation-publication', 'input-output-continuity', 'approval-waits',
  'approval-thresholds', 'quality-refusal', 'external-prerequisites', 'rework-invalidation',
  'skill-amendment-invalidation', 'repair-budgets', 'completion'];
const ASSUMPTIONS = Object.freeze([
  'All projected output bytes, published generations, successful checks and human decisions are hypothetical scenario inputs, not observed evidence.',
  'Configured reviewer capacity is static policy feasibility, not authenticated provider membership or actual human availability.',
  'When Story-start auto-enrollment is enabled, capacity may include one hypothetical new creator in each authority group; this is not an actual enrolled identity or an independent reviewer.',
  'Policy-waiver eligibility is not inferred; the human-review fallback is exercised.',
  'No real host enforcement, model behavior, artifact content, command outcome, network availability or execution readiness is established.',
  'Confirmed SKP provenance is supplied by the configuration owner; this report creates no confirmation or evidence acceptance.',
  'Skill-package amendments are proposed one at a time against declared dependencies; accepted lineage, retained receipts and reviewed adoption are not observed.'
]);
const EXCLUDED = ['native-host-enforcement', 'real-artifact-or-receipt-validation', 'human-availability',
  'provider-membership', 'command-or-model-behavior', 'publication-and-approval-evidence', 'active-Story-state',
  'historical-amendment-impact', 'initiative-rollup-and-child-readiness', 'actual-claim-map-and-planned-test-evidence',
  'termination-of-legacy-unbudgeted-human-rejection-loops'];
const effects = () => ({ stateChanged: false, filesChanged: false, configurationWritten: false,
  approvalGranted: false, executed: false, modelCalls: 0, externalCalls: 0 });
const failure = (code) => Object.assign(new Error(code), { code });
function ordinary(value) { return value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype; }
function boundedCopy(value) {
  let nodes = 0; const active = new Set();
  function copy(item, depth) {
    if (++nodes > WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.nodes || depth > WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.depth) throw failure('WCA_SIMULATION_LIMIT');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') { if (Buffer.from(item).toString('utf8') !== item) throw failure('WCA_SIMULATION_INVALID'); return item; }
    if (!ordinary(item) && !Array.isArray(item) || active.has(item)) throw failure('WCA_SIMULATION_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) throw failure('WCA_SIMULATION_INVALID');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw failure('WCA_SIMULATION_INVALID');
      result = item.map((entry) => copy(entry, depth + 1));
    } else result = Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, copy(entry, depth + 1)]));
    active.delete(item); return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.inputBytes) throw failure('WCA_SIMULATION_LIMIT');
  return result;
}
function freeze(value) { if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); } return value; }
function validId(value) {
  if (typeof value !== 'string') return false;
  if (Buffer.byteLength(value) > WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.idBytes) throw failure('WCA_SIMULATION_LIMIT');
  return ID.test(value);
}
function artifactPath(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096
  && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
  && !value.split(/[\\/]/u).includes('..') && !/[\0\r\n]/u.test(value); }
function outputPath(value, phaseId) { return typeof value === 'string' && Buffer.byteLength(value) <= 4096
  && value.startsWith(`artifacts/${phaseId}/`) && !value.includes('\\')
  && value.split('/').every((part) => part && part !== '.' && part !== '..' && !/[\0\r\n]/u.test(part)); }
function aggregate(resolved) {
  return { workItem: { id: 'SIMULATION' }, status: 'in_progress', currentPhase: resolved.phases[0].id,
    phaseOrder: resolved.phases.map((phase) => phase.id), resolution: structuredClone(resolved), history: [],
    phases: Object.fromEntries(resolved.phases.map((phase, index) => [phase.id, {
      id: phase.id, status: index ? 'not_started' : 'in_progress', generation: 0,
      generationPolicy: structuredClone(phase.generation), approvalPolicy: structuredClone(phase.approval),
      repairBudget: structuredClone(phase.repairBudget ?? null), approvals: [], rejectedAt: null
    }])) };
}
function at(index) { return `simulation-step-${String(index).padStart(6, '0')}`; }
function symbolicApprovals(policy) {
  // These private scenario tokens are never returned as approval records or admitted by an owner.
  const groups = [...(policy.requiredAuthorities ?? [])];
  while (groups.length < policy.minimum) groups.push(policy.authorities[0]);
  return groups.map((authorityGroup, index) => ({ decision: 'approved', authorityGroup,
    actor: { name: `hypothetical-reviewer-${index + 1}` } }));
}

function storyStartApprovalAuthorities(resolved) {
  if (!normalizeApprovalSecurity(resolved.approvalSecurity ?? {}).autoEnrollNewIdentities) return null;
  // createWorkflow() enrolls the same Story creator in every pinned authority group before
  // checking phase capacity. Use one distinct symbolic identity across all groups: this can
  // satisfy a single ordinary reviewer slot, never two independently required groups.
  const authorities = structuredClone(resolved.approvalAuthorities);
  const existing = new Set(Object.values(authorities).flatMap((authority) =>
    (authority.members ?? []).map((member) => String(member.githubLogin ?? '').toLowerCase())));
  let login = 'sflow-simulation-creator';
  while (existing.has(login)) login += '-next';
  for (const authority of Object.values(authorities)) {
    authority.members ??= [];
    authority.members.push({ githubLogin: login });
  }
  return authorities;
}

/** The caller supplies the existing owner's resolved Story contract, never executable actions. */
export function simulateResolvedWorkflowLifecycle(resolved) {
  let captured; let sourceDefinitionSha256 = null; let workflowId = null; const scenarios = []; const findings = [];
  let eventCount = 0; let incomplete = false; let invalid = false;
  const coverage = { phaseCount: 0, scenarioCount: 0, eventCount: 0, dimensions: [...DIMENSIONS],
    excluded: [...EXCLUDED], interpretation: 'hypothetical-structural-scenarios-only' };
  const report = () => ({ schemaVersion: 1, kind: 'workflow-lifecycle-simulation',
    profile: WORKFLOW_LIFECYCLE_SIMULATION_PROFILE, workflowId, sourceDefinitionSha256,
    status: invalid ? 'invalid' : incomplete ? 'incomplete' : 'complete-for-profile',
    scenarios, findings, coverage: { ...coverage, scenarioCount: scenarios.length, eventCount },
    assumptions: [...ASSUMPTIONS], effects: effects() });
  const finding = (code, phaseId, severity = 'invalid') => {
    if (findings.length >= WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.findings) throw failure('WCA_SIMULATION_LIMIT');
    findings.push({ code, ...(phaseId ? { phaseId } : {}), severity,
      message: severity === 'incomplete' ? 'This contract cannot be completely assessed by this structural profile.'
        : 'The declared contract does not admit the required structural transition.' });
    if (severity === 'incomplete') incomplete = true; else invalid = true;
  };
  const scenario = (id, phaseId, expected, outcome, events, detail = {}) => {
    if (scenarios.length >= WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.scenarios
        || eventCount + events.length > WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.events) throw failure('WCA_SIMULATION_LIMIT');
    eventCount += events.length;
    scenarios.push({ id, ...(phaseId ? { phaseId } : {}), expected, outcome, events, ...detail });
  };
  const event = (action, from, to, disposition, rule) => ({ action, from, to, disposition, rule });
  try {
    captured = boundedCopy(resolved); sourceDefinitionSha256 = `sha256:${recordSha256(captured)}`;
    if (!ordinary(captured) || !validId(captured.id) || !Array.isArray(captured.phases)
        || !captured.phases.length) throw failure('WCA_SIMULATION_INVALID');
    workflowId = captured.id;
    try { assertWorkTypeStartable(captured); }
    catch (error) {
      finding(error?.code === 'WORKFLOW_OBLIGATIONS_UNMET' ? 'WCA_SIMULATION_OBLIGATIONS_UNMET' : 'WCA_SIMULATION_PLANNED_CLAIMS_MIGRATION_REQUIRED');
    }
    if (captured.phases.length > WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.phases
        || (captured.reworkLoops?.length ?? 0) > WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.loops) throw failure('WCA_SIMULATION_LIMIT');
    coverage.phaseCount = captured.phases.length;
    const order = captured.phases.map((phase) => phase.id);
    if (new Set(order).size !== order.length || order.some((id) => !validId(id))) throw failure('WCA_SIMULATION_INVALID');
    if (!['off', 'record', 'enforce'].includes(captured.inputsMode ?? 'off')) throw failure('WCA_SIMULATION_INVALID');
    const autoEnrolledAuthorities = storyStartApprovalAuthorities(captured);
    const outputs = new Map(); const declarations = new Map(); const sets = new Map();
    for (const [index, phase] of captured.phases.entries()) {
      if (!ordinary(phase) || phase.order !== index || !ordinary(phase.artifact)
          || !artifactPath(phase.artifact.path) || !ordinary(phase.generation)
          || !['required', 'optional', 'none'].includes(phase.generation.requirement)
          || !ordinary(phase.approval) || !['required', 'policy', 'none'].includes(phase.approval.mode)
          || !Array.isArray(phase.inputs) || !Array.isArray(phase.qualityCommands ?? [])) {
        finding('WCA_SIMULATION_PHASE_INVALID', phase.id); continue;
      }
      if (phase.id === 'convergence' && (phase.approval.mode !== 'required'
          || phase.generation.requirement !== 'required' || phase.generation.defaultProducer !== 'deterministic'
          || !Array.isArray(phase.generation.allowedProducers) || phase.generation.allowedProducers.length !== 1
          || phase.generation.allowedProducers[0] !== 'deterministic')) finding('WCA_SIMULATION_CONVERGENCE_POLICY_INVALID', phase.id);
      if ((phase.qualityCommands ?? []).length && phase.repairBudget && phase.approval.mode === 'none') {
        finding('WCA_SIMULATION_REPAIR_REVIEW_UNAVAILABLE', phase.id);
      }
      try { normalizeRepairBudget(phase.repairBudget, { phaseId: phase.id, phases: order }); }
      catch { finding('WCA_SIMULATION_REPAIR_BUDGET_INVALID', phase.id); }
      try {
        const set = resolvedArtifactSet(null, { resolution: captured }, phase);
        if (set) {
          if (path.posix.join(memberRoot(phase), set.primary) !== path.posix.normalize(phase.artifact.path.replaceAll('\\', '/'))) {
            finding('WCA_SIMULATION_ARTIFACT_SET_PRIMARY_INVALID', phase.id);
          }
          sets.set(phase.id, set);
        }
      } catch { finding('WCA_SIMULATION_ARTIFACT_SET_UNAVAILABLE', phase.id, 'incomplete'); }
      if (phase.kind === 'skill') {
        if (!phase.skillBinding) { finding('WCA_SIMULATION_SKP_BINDING_UNAVAILABLE', phase.id, 'incomplete'); continue; }
        try { validateSkillPhaseBindingHeader(phase.skillBinding, phase.id); }
        catch { finding('WCA_SIMULATION_SKP_BINDING_INVALID', phase.id); continue; }
        const refs = phase.skillBinding.bindingRefs;
        if (!ordinary(refs) || !ordinary(refs.confirmation)) {
          finding('WCA_SIMULATION_SKP_BINDING_UNAVAILABLE', phase.id, 'incomplete'); continue;
        }
        if (!/^sha256:[a-f0-9]{64}$/u.test(refs.confirmation.planSha256 ?? '')
            || !/^sha256:[a-f0-9]{64}$/u.test(refs.confirmation.candidateSha256 ?? '')
            || !Number.isSafeInteger(refs.confirmation.draftRevision) || refs.confirmation.draftRevision < 1) {
          finding('WCA_SIMULATION_SKP_BINDING_INVALID', phase.id); continue;
        }
        if (!ordinary(refs) || !Array.isArray(refs.outputs) || !refs.outputs.length || !Array.isArray(refs.inputs)
            || refs.outputs.some((output) => !ordinary(output) || !validId(output.id)
              || !outputPath(output.path, phase.id) || typeof output.required !== 'boolean')
            || new Set(refs.outputs.map((output) => output.id)).size !== refs.outputs.length
            || new Set(refs.outputs.map((output) => output.path)).size !== refs.outputs.length
            || !refs.outputs.some((output) => output.path === phase.artifact.path && output.required)) {
          finding('WCA_SIMULATION_SKP_OUTPUT_INVALID', phase.id); continue;
        }
        outputs.set(phase.id, refs.outputs.map((output) => ({ id: output.id, path: output.path, required: output.required })));
        declarations.set(phase.id, refs.inputs.map((input) => ({ ...input, optional: input.required === false })));
        const set = sets.get(phase.id);
        if (refs.outputs.length > 1 && (!set || set.members.length !== refs.outputs.length
            || refs.outputs.some((output) => !set.members.some((member) => member.authority === 'governed'
              && member.required === output.required && !member.path.endsWith('/')
              && path.posix.join(memberRoot(phase), member.path) === output.path)))
            || refs.outputs.length === 1 && set) finding('WCA_SIMULATION_SKP_ARTIFACT_SET_INVALID', phase.id);
      } else if (phase.kind === undefined || phase.kind === 'template') {
        outputs.set(phase.id, [{ id: 'primary', path: phase.artifact.path, required: true }]);
        declarations.set(phase.id, phase.inputs.map((input) => ({ ...input, output: 'primary' })));
      } else finding('WCA_SIMULATION_PRODUCER_UNSUPPORTED', phase.id, 'incomplete');
      if (phase.approval.mode !== 'none') {
        if (!Number.isSafeInteger(phase.approval.minimum) || phase.approval.minimum < 1
            || !Array.isArray(phase.approval.authorities) || !phase.approval.authorities.length
            || !Array.isArray(phase.approval.requiredAuthorities)
            || phase.approval.authorities.some((id) => !validId(id))) { finding('WCA_SIMULATION_APPROVAL_INVALID', phase.id); continue; }
        try {
          // A phase requiring independent review cannot count the hypothetical Story creator.
          const authorities = phase.approval.allowSelfApproval === false
            ? captured.approvalAuthorities : autoEnrolledAuthorities ?? captured.approvalAuthorities;
          const capacity = approvalPolicyCapacity(authorities, phase.approval);
          if (!capacity.attainable) finding('WCA_SIMULATION_APPROVAL_UNATTAINABLE', phase.id);
          if (phase.approval.minimum > 128) throw failure('WCA_SIMULATION_LIMIT');
        } catch (error) { if (error.code === 'WCA_SIMULATION_LIMIT') throw error; finding('WCA_SIMULATION_APPROVAL_INVALID', phase.id); }
      }
    }
    for (const [index, phase] of captured.phases.entries()) for (const input of declarations.get(phase.id) ?? []) {
      const producerIndex = order.indexOf(input.phase); const available = outputs.get(input.phase) ?? [];
      if (!validId(input.phase) || !validId(input.output) || producerIndex < 0 || producerIndex >= index
          || typeof input.optional !== 'boolean' || phase.kind === 'skill' && (typeof input.required !== 'boolean' || input.state !== 'approved')
          || !available.some((output) => output.id === input.output && (input.path === undefined || output.path === input.path))) {
        finding('WCA_SIMULATION_INPUT_IDENTITY_INVALID', phase.id);
      }
    }
    let loops;
    try { loops = normalizeReworkLoops(captured.reworkLoops ?? [], { workTypeId: captured.id, phases: order }); }
    catch { finding('WCA_SIMULATION_REWORK_INVALID'); loops = []; }
    if (invalid || incomplete) return freeze(report());
    const initial = aggregate(captured); const happy = structuredClone(initial); const happyEvents = [];
    for (const phase of captured.phases) {
      const state = happy.phases[phase.id]; const decision = evaluateSequence(happy, { requestedPhase: phase.id });
      if (!decision.allowed) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
      const needs = phaseNeedsGeneration(happy, state);
      const publicationMode = sequenceGateMode(happy, 'generationCommit');
      scenario(`publication-required:${phase.id}`, phase.id, 'refuse-or-require-human-override', 'expected-refusal', [
        event('submit-generation-zero', 'in_progress', 'in_progress', publicationMode === 'soft' ? 'human-override-required' : 'refused', 'state:submission-generationCommit'),
        event('generation-freshness', 'generation-zero', needs ? 'generation-required' : 'generation-not-required', 'owner-evaluated', 'sequence:phaseNeedsGeneration')
      ], { generationRequirement: phase.generation.requirement, approvalMode: phase.approval.mode });
      happyEvents.push(event('publish-assumed-output', 'in_progress', 'published', 'hypothetical', 'state:publishGeneration'));
      state.generation = 1; happy.history.push({ phase: state.id, event: 'phase_generated', at: at(happyEvents.length) });
      if (phase.id === 'convergence') {
        scenario('convergence-human-advance', phase.id, 'direct-submit-refuses-exact-human-advance-required', 'expected-wait', [
          event('ordinary-submit-convergence', 'published', 'published', 'refused-human-advance-required', 'state:submitConfirmedConvergencePhase'),
          event('exact-human-advance-assumed', 'published', 'awaiting_approval', 'hypothetical-direct-human-confirmation', 'state:assertConvergenceConfirmation')
        ]);
        happyEvents.push(event('confirm-exact-convergence-assumed', 'published', 'published', 'hypothetical-human-confirmation', 'state:submitConfirmedConvergencePhase'));
      }
      if (phase.approval.mode === 'none') {
        state.status = 'approved'; happyEvents.push(event('submit', 'published', 'approved', 'approval-not-required', 'state:submitPhaseTransition'));
      } else {
        state.status = 'awaiting_approval'; happyEvents.push(event('submit', 'published', 'awaiting_approval', 'valid-human-wait', 'state:submitPhaseTransition'));
        scenario(`human-wait:${phase.id}`, phase.id, 'wait-not-deadlock', 'expected-wait', [
          event('await-reviewer', 'awaiting_approval', 'awaiting_approval', 'human-availability-not-established', 'approval:approvalPolicyCapacity')
        ], { minimum: phase.approval.minimum, requiredAuthorityCount: phase.approval.requiredAuthorities.length,
          selfApproval: phase.approval.allowSelfApproval === false ? 'distinct-from-producer-required' : 'configured-policy', policyWaiver: phase.approval.mode === 'policy' ? 'not-assumed' : 'not-applicable' });
        const hypothetical = symbolicApprovals(phase.approval);
        const partial = hypothetical.slice(0, -1);
        const met = approvalRequirementsMet(phase.approval, hypothetical);
        const partialMet = approvalRequirementsMet(phase.approval, partial);
        if (!met || partialMet || remainingRequiredAuthorities(phase.approval, hypothetical).length) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        scenario(`approval-threshold:${phase.id}`, phase.id, 'partial-waits-complete-advances', 'expected-transition', [
          event('hypothetical-partial-review', 'awaiting_approval', 'awaiting_approval', 'threshold-not-met', 'approval:approvalRequirementsMet'),
          event('hypothetical-complete-review', 'awaiting_approval', 'approved', 'conditional-on-real-eligible-distinct-humans', 'approval:approvalRequirementsMet')
        ]);
        const invalidated = hypothetical.map((approval) => ({ ...approval, invalidatedAt: at(999) }));
        const duplicated = Array.from({ length: Math.max(phase.approval.minimum, 2) }, () => ({ ...hypothetical[0] }));
        if (approvalRequirementsMet(phase.approval, invalidated)) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        scenario(`approval-evidence:${phase.id}`, phase.id, 'invalidated-or-duplicate-decisions-cannot-fill-distinct-thresholds', 'expected-refusal', [
          event('invalidated-approvals', 'awaiting_approval', 'awaiting_approval', 'refused', 'approval:approvalRequirementsMet'),
          event('duplicate-reviewer-decisions', 'awaiting_approval', 'awaiting_approval', approvalRequirementsMet(phase.approval, duplicated)
            ? 'single-reviewer-satisfies-only-configured-single-threshold' : 'distinct-threshold-not-met', 'approval:approvalRequirementsMet')
        ], { realReceiptAcceptance: 'not-assessed' });
        state.approvals = hypothetical; state.status = 'approved';
        happyEvents.push(event('review-assumed', 'awaiting_approval', 'approved', 'hypothetical-human-results', 'approval:approvalRequirementsMet'));
      }
      const upcoming = advanceCompletedPhase(happy, state, at(happyEvents.length));
      happyEvents.push(event('advance', phase.id, upcoming?.id ?? 'complete', 'projected-owner-transition', 'lifecycle:advanceCompletedPhase'));
      scenario(`output-required:${phase.id}`, phase.id, 'missing-or-stale-output-refuses', 'expected-refusal', [
        event('publish-missing-required-output', 'in_progress', 'in_progress', 'refused', 'state:validatePhase'),
        event('submit-stale-output-identity', 'published', 'published', 'refused', 'state:validatePhase')
      ], { requiredOutputCount: (outputs.get(phase.id) ?? []).filter((output) => output.required).length,
        identity: 'exact-phase-output-and-generation-not-real-receipt' });
      for (const [memberIndex, member] of (sets.get(phase.id)?.members ?? []).entries()) {
        scenario(`artifact-member:${phase.id}:${memberIndex + 1}`, phase.id,
          member.required ? 'required-member-missing-refuses' : 'optional-member-is-not-required-evidence',
          member.required ? 'expected-refusal' : 'expected-tolerance', [
            event('hypothetical-missing-member', 'publication', 'publication', member.required ? 'refused' : 'optional-tolerated', 'artifacts:resolvedArtifactSet'),
            event('changed-complete-bundle', 'submitted-bundle', 'changed-bundle', 'requires-new-exact-bundle-review', 'artifacts:bundleSha256')
          ], { memberIndex: memberIndex + 1, required: member.required, authority: member.authority,
            actualMemberBytes: 'not-read', advisoryIsApprovalEvidence: false });
      }
      for (const output of outputs.get(phase.id) ?? []) if (!output.required) {
        scenario(`optional-output:${phase.id}:${output.id}`, phase.id, 'selected-optional-output-binds-exact-receipt', 'expected-refusal', [
          event('optional-output-absent', 'publication', 'publication', 'optional-tolerated', 'skp:bound-output-required'),
          event('selected-optional-output-stale', 'captured-input', 'captured-input', 'refused-exact-selected-output-required', 'inputs:collectInputs')
        ], { outputId: output.id, actualReceipt: 'not-verified' });
      }
      for (const input of declarations.get(phase.id) ?? []) {
        const mode = phase.kind === 'skill' ? 'enforce' : captured.inputsMode ?? 'off';
        for (const [status, ownerStatus] of [['missing', 'missing'], ['unapproved', 'unapproved'],
          ['hash-mismatch', 'hash_mismatch'], ['stale-generation-or-receipt', phase.kind === 'skill' ? 'receipt_invalid' : 'unapproved'], ['captured', 'captured']]) {
          const severity = mode === 'off' ? null : inputFindingSeverity(mode, input.optional, ownerStatus);
          const disposition = mode === 'off' ? 'not-enforced' : ownerStatus === 'captured' ? 'hypothetical-exact-evidence'
            : severity === 'error' ? 'refused' : severity === 'warning' ? 'warning' : 'optional-tolerated';
          scenario(`input:${phase.id}:${input.phase}:${input.output}:${status}`, phase.id,
            disposition === 'refused' ? 'refuse-invalid-input' : 'preserve-declared-input-mode', disposition === 'refused' ? 'expected-refusal' : 'expected-tolerance', [
              event(`input-${status}`, 'prepare', 'prepare', disposition, 'inputs:collectInputs')
            ], { producerPhase: input.phase, outputId: input.output, optional: input.optional, ownerStatus,
              mode, identity: 'exact-declared-output-current-approved-generation' });
        }
        if (phase.kind === 'skill') scenario(`input:${phase.id}:${input.phase}:${input.output}:receipt-missing`, phase.id,
          'missing-exact-submission-or-approval-receipt-refuses', 'expected-refusal', [
            event('input-receipt-missing', 'prepare', 'prepare', inputFindingSeverity(mode, input.optional, 'receipt_missing') === 'error' ? 'refused' : 'unexpected-tolerance', 'inputs:inputFindingSeverity')
          ], { optional: input.optional, ownerStatus: 'receipt_missing', mode, actualReceipt: 'not-read' });
        if (input.projection === 'approved-summary') {
          for (const status of ['brief_missing', 'brief_invalid', 'expansion_missing']) {
            const severity = mode === 'off' ? null : inputFindingSeverity(mode, input.optional, status);
            scenario(`input-projection:${phase.id}:${input.phase}:${status}`, phase.id,
              'projection-does-not-bypass-source-or-generation-binding', severity === 'error' ? 'expected-refusal' : 'expected-tolerance', [
                event('hypothetical-projection-prerequisite', 'prepare', 'prepare', mode === 'off' ? 'not-enforced'
                  : severity === 'error' ? 'refused' : 'warning', 'inputs:inputFindingSeverity')
              ], { ownerStatus: status, fallback: input.fallback === 'whole' ? 'exact-approved-whole-fallback-when-owner-allows' : 'no-fallback', observed: false });
          }
          if (input.expansion === 'hash-bound-reference' && captured.harnessImports?.mode === 'off') finding('WCA_SIMULATION_EXPANSION_UNAVAILABLE', phase.id);
        }
      }
      if ((phase.qualityCommands ?? []).length) {
        const required = phase.qualityCommands.some((check) => (check.requirement ?? 'required') === 'required');
        const failed = qualityValidationVerdict([{ status: 'failed', requirement: required ? 'required' : 'optional' }], { required });
        if (failed.verdict !== 'failed' || !failed.failed.length) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        scenario(`quality-failure:${phase.id}`, phase.id,
        phase.repairBudget ? 'reviewer-directed-repair-not-approval' : 'refuse-submission', 'expected-refusal', [
          event('hypothetical-failed-check', 'published', phase.repairBudget ? 'awaiting_approval' : 'published', phase.repairBudget ? 'human-rejection-required' : 'refused', 'state:submitPhaseTransition'),
          event('approve-failed-check', 'awaiting_approval', 'awaiting_approval', 'refused', 'state:approvePhase')
        ], { checksExecuted: false, verdict: failed.verdict });
        for (const status of ['unavailable', 'malformed']) {
          const verdict = qualityValidationVerdict(phase.qualityCommands.map((check) => ({ status, requirement: check.requirement ?? 'required' })), { required });
          const refusal = verdict.invalid.length > 0 || verdict.unavailableRequired.length > 0;
          scenario(`quality-${status}:${phase.id}`, phase.id, refusal ? 'missing-or-invalid-check-evidence-refuses' : 'optional-unavailable-is-not-passing-evidence',
            refusal ? 'expected-refusal' : 'expected-wait', [
              event('hypothetical-check-result', 'published', 'published', refusal ? 'refused' : 'optional-unavailable-not-passed', 'quality:qualityValidationVerdict')
            ], { checksExecuted: false, verdict: verdict.verdict });
        }
      }
      scenario(`external-unavailable:${phase.id}`, phase.id, 'wait-or-refuse-without-effects', 'expected-wait', [
        event('missing-external-prerequisite', 'in_progress', 'in_progress', 'wait-or-refuse-no-effect', phase.kind === 'skill' ? 'state:assertSkillPhaseHostReady' : 'state:publication-and-external-evidence-gates')
      ], { host: phase.kind === 'skill' ? 'enforcement-unavailable' : 'not-qualified', observed: false });
    }
    scenario('happy-path', null, 'conditional-completion', happy.status === 'complete' ? 'expected-transition' : 'unexpected-block', happyEvents,
      { conditions: ['exact-outputs-published', 'checks-pass', 'real-distinct-eligible-human-decisions-when-required', 'external-prerequisites-available'], actualExecution: 'not-run' });
    if (happy.status !== 'complete') finding('WCA_SIMULATION_COMPLETION_UNREACHABLE');
    const completed = evaluateSequence(happy, { requestedPhase: order[0] });
    scenario('completion', null, 'completion-refuses-new-transition', !completed.allowed && completed.gate === 'completion' ? 'expected-refusal' : 'unexpected-transition', [
      event('prepare-after-completion', 'complete', 'complete', sequenceGateMode(happy, 'completion') === 'soft' ? 'human-reopen-override-required' : 'refused', 'sequence:evaluateSequence')
    ]);
    if (order.length > 1) {
      const outOfOrder = evaluateSequence(initial, { requestedPhase: order[1] });
      scenario('out-of-order', order[1], 'only-current-phase-may-change', !outOfOrder.allowed ? 'expected-refusal' : 'unexpected-transition', [
        event('prepare-later-phase', 'not_started', 'not_started', sequenceGateMode(initial, 'currentPhase') === 'soft' ? 'human-override-required-not-assumed' : 'refused', 'sequence:evaluateSequence')
      ]);
      if (outOfOrder.allowed) finding('WCA_SIMULATION_SEQUENCE_UNREACHABLE');
    }
    const selectedSkillIds = [...new Set(captured.phases.filter((phase) => phase.kind === 'skill')
      .map((phase) => phase.skillBinding.bindingRefs.skill?.id))];
    for (const skillId of selectedSkillIds) {
      if (!validId(skillId)) throw failure('WCA_SIMULATION_INVALID');
      const impact = planSkillAmendmentEvidence(captured, { replacedSkillIds: [skillId] });
      const detail = { skillId, affectedPhases: [...impact.affectedPhaseIds],
        preservedPhases: [...impact.preservedPhaseIds], unknownPhases: impact.unknown.map(({ phaseId }) => phaseId),
        dependencyProof: impact.status, assurance: 'hypothetical-dependency-only',
        actualAmendment: 'not-created', actualReceiptAcceptance: 'not-assessed', observed: false };
      if (impact.status !== 'ready') {
        scenario(`package-amendment:${skillId}`, null, 'unknown-dependencies-refuse-selective-reuse', 'expected-refusal', [
          event('proposed-package-replacement', 'pinned-package', 'pinned-package',
            'refused-dependency-unproven', 'skp:planSkillAmendmentEvidence')
        ], { ...detail, revalidation: 'not-projected', preservedEvidenceReuse: 'not-authorized' });
        continue;
      }
      if (impact.affectedPhaseIds.some((id) => happy.phases[id].generationPolicy.requirement === 'none')) {
        scenario(`package-amendment:${skillId}`, null, 'affected-evidence-requires-publishable-generation', 'expected-refusal', [
          event('proposed-package-replacement', 'pinned-package', 'pinned-package',
            'refused-generation-unavailable', 'state:assertSelectableSkillAmendmentReopen')
        ], { ...detail, revalidation: 'not-projected', preservedEvidenceReuse: 'not-authorized' });
        continue;
      }
      // This private aggregate only projects the existing reviewed owner's post-adoption state.
      // It is never returned as Story state, approval evidence or an accepted amendment record.
      const projected = structuredClone(happy);
      const preservedBefore = impact.preservedPhaseIds.map((id) => JSON.stringify(projected.phases[id]));
      const first = impact.affectedPhaseIds[0];
      const amendment = { status: 'approved', affectedPhaseIds: [...impact.affectedPhaseIds],
        preservedPhaseIds: [...impact.preservedPhaseIds] };
      projected.skillVersionAmendments = [amendment]; projected.status = 'in_progress'; projected.currentPhase = first;
      for (const [index, id] of impact.affectedPhaseIds.entries()) {
        const phase = projected.phases[id];
        phase.approvals = phase.approvals.map((approval) => ({ ...approval, invalidatedAt: at(1000) }));
        phase.status = index ? 'not_started' : 'in_progress';
        phase.skillAmendmentRevalidation = { state: 'affected', generationAtAdoption: phase.generation };
        if (!phaseNeedsGeneration(projected, phase)
            || phase.approvalPolicy.mode !== 'none' && approvalRequirementsMet(phase.approvalPolicy, phase.approvals)) {
          throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        }
      }
      const amendmentEvents = [
        event('reviewed-adoption-assumed', 'pinned-package', 'reviewed-package',
          'hypothetical-separate-human-decision', 'state:storySkillVersionDecision'),
        event('selective-revalidation-assumed', 'approved-evidence', 'affected-evidence-stale',
          'old-generations-and-approvals-not-reusable', 'sequence:phaseNeedsGeneration')
      ];
      const revalidatedPhases = [];
      for (const id of impact.affectedPhaseIds) {
        const phase = projected.phases[id];
        if (projected.currentPhase !== id || !evaluateSequence(projected, { requestedPhase: id }).allowed) {
          throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        }
        phase.generation += 1;
        if (phaseNeedsGeneration(projected, phase)) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        phase.approvals = phase.approvalPolicy.mode === 'none' ? [] : symbolicApprovals(phase.approvalPolicy);
        phase.status = 'approved'; revalidatedPhases.push(id);
        const upcoming = advanceCompletedPhase(projected, phase, at(1001 + revalidatedPhases.length));
        amendmentEvents.push(event('new-publication-and-review-assumed', id, upcoming?.id ?? 'complete',
          'conditional-on-fresh-evidence-skips-only-approved-independent-phases', 'lifecycle:advanceCompletedPhase'));
      }
      const preservedUnchanged = impact.preservedPhaseIds.every((id, index) =>
        JSON.stringify(projected.phases[id]) === preservedBefore[index]);
      if (!preservedUnchanged || projected.status !== 'complete') throw failure('WCA_SIMULATION_OWNER_MISMATCH');
      scenario(`package-amendment:${skillId}`, first, 'reviewed-replacement-revalidates-only-proven-dependents', 'expected-transition',
        amendmentEvents, { ...detail, revalidatedPhases, preservedEvidenceUnchanged: preservedUnchanged,
          priorGenerations: 'retained-but-not-fresh', priorAffectedApprovals: 'invalidated',
          conditions: ['verified-accepted-lineage', 'separate-reviewed-package-adoption', 'fresh-publication-and-required-human-approval',
            'qualified-host-before-real-skill-execution'] });
    }
    for (const phase of captured.phases) for (const targetId of phase.approval.rejectTo ?? []) {
      if (!validId(targetId)) throw failure('WCA_SIMULATION_INVALID');
      const targetIndex = order.indexOf(targetId);
      if (targetIndex < 0 || targetIndex > phase.order || phase.approval.mode === 'none') {
        scenario(`rejection-edge:${phase.id}:${targetId}`, phase.id, 'invalid-or-unreviewable-rejection-refuses', 'expected-refusal', [
          event('hypothetical-reject', 'review-state-unavailable', 'unchanged', targetIndex < 0 || targetIndex > phase.order
            ? 'refused-invalid-target' : 'refused-no-human-review-state', 'state:rejectPhase')
        ], { targetPhase: targetId, permission: 'not-granted' });
        continue;
      }
      const projected = structuredClone(happy); projected.status = 'in_progress'; projected.currentPhase = phase.id;
      const source = projected.phases[phase.id]; source.status = 'awaiting_approval'; source.validationVerdict = 'passed';
      if (!evaluateSequence(projected, { requestedPhase: phase.id, allowedStatuses: ['awaiting_approval'] }).allowed) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
      let budgetPhase;
      try { budgetPhase = repairBudgetPhaseForRejection(projected, source, targetId); }
      catch { finding('WCA_SIMULATION_REWORK_BUDGET_MISMATCH', targetId); continue; }
      const affected = reopenPhaseRange(projected, { targetId, at: at(999), actor: 'hypothetical-human', reason: 'hypothetical-eligible-reviewer-rejection' });
      if (affected.some((id) => projected.phases[id].status === 'approved'
          || projected.phases[id].approvals.some((approval) => !approval.invalidatedAt))) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
      scenario(`rejection-edge:${phase.id}:${targetId}`, phase.id, 'conditional-human-rejection-invalidates-entire-range', 'expected-transition', [
        event('eligible-reviewer-rejection-assumed', 'awaiting_approval', targetId, 'hypothetical-human-decision', 'state:rejectPhase'),
        event('reopen-range', phase.id, targetId, 'all-target-and-later-approvals-invalidated', 'lifecycle:reopenPhaseRange'),
        event('consume-old-output', 'old-approved-generation', 'unapproved-old-generation', 'not-current-approved-input', 'inputs:inputFindingSeverity')
      ], { targetPhase: targetId, affectedPhases: affected, selectedBudgetPhase: budgetPhase?.id ?? null,
        budgetPolicy: budgetPhase ? 'existing-selected-policy-exercised-separately' : 'none-selected-no-quota-inferred',
        generation: phaseNeedsGeneration(projected, projected.phases[targetId]) ? 'owner-requires-new-generation' : 'owner-generation-policy-preserved',
        prerequisites: ['real-eligible-reviewer', 'exact-published-review-packet', 'required-change-request-comment'], observed: false });
    }
    for (const phase of captured.phases.filter((candidate) => candidate.repairBudget && !loops.some((loop) => loop.to === candidate.id))) {
      const projected = structuredClone(happy); const source = projected.phases[phase.id];
      source.validationVerdict = 'failed';
      const budgetPhase = repairBudgetPhaseForRejection(projected, source, source.id);
      if (!budgetPhase || budgetPhase.id !== source.id) { finding('WCA_SIMULATION_REPAIR_BUDGET_SELECTION_UNPROVEN', phase.id); continue; }
      if (phase.repairBudget.resetOnPhase === phase.id) {
        const reset = consumeRepairAttempt(projected, budgetPhase, { targetPhase: phase.id, actor: 'hypothetical-human', at: at(1), changeRequestId: 'hypothetical-reset-target' });
        if (!reset.resetRequested || reset.attempts.length) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        scenario(`repair-budget-reset-target:${phase.id}`, phase.id, 'return-to-reset-phase-is-a-request-not-a-budget-reset-or-approval', 'expected-wait', [
          event('return-to-reset-phase', phase.id, phase.id, 'reset-generation-requested-no-attempt-consumed', 'repair:consumeRepairAttempt')
        ], { authorization: 'existing-human-review-gates-not-waived', actualNewGeneration: 'not-observed' });
        continue;
      }
      const budgetEvents = [];
      for (let attempt = 0; attempt < phase.repairBudget.maxAttempts; attempt += 1) {
        const receipt = consumeRepairAttempt(projected, budgetPhase, { targetPhase: phase.id,
          actor: 'hypothetical-human', at: at(attempt + 1), changeRequestId: `hypothetical-${attempt + 1}` });
        budgetEvents.push(event('conditional-owner-selected-repair', phase.id, phase.id,
          `budget-${receipt.attempts.length}-of-${phase.repairBudget.maxAttempts}`, 'repair:consumeRepairAttempt'));
      }
      let exhausted = false;
      try { consumeRepairAttempt(projected, budgetPhase, { targetPhase: phase.id, actor: 'hypothetical-human', at: at(999), changeRequestId: 'hypothetical-exhaustion' }); }
      catch (error) { exhausted = error.code === 'REPAIR_BUDGET_EXHAUSTED'; }
      if (!exhausted) finding('WCA_SIMULATION_REWORK_EXHAUSTION_UNPROVEN', phase.id);
      scenario(`repair-budget:${phase.id}`, phase.id, 'owner-selected-policy-is-bounded-not-a-new-rejection-grant', exhausted ? 'expected-refusal' : 'unexpected-transition', [
        ...budgetEvents, event('repair-after-budget', phase.id, phase.id, exhausted ? 'refused-budget-exhausted' : 'unexpectedly-allowed', 'repair:consumeRepairAttempt')
      ], { authorization: 'existing-reviewer-and-sequence-gates-not-waived', validationFailure: 'hypothetical' });
      if (phase.repairBudget.resetOnPhase) {
        const resetId = phase.repairBudget.resetOnPhase;
        const beforeReset = structuredClone(projected.repairBudgets[phase.id]);
        const requested = consumeRepairAttempt(projected, budgetPhase, { targetPhase: resetId, actor: 'hypothetical-human', at: at(1000), changeRequestId: 'hypothetical-reset-request' });
        if (!requested.resetRequested || JSON.stringify(beforeReset) !== JSON.stringify(projected.repairBudgets[phase.id])) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        projected.phases[resetId].generation += 1;
        const reset = consumeRepairAttempt(projected, budgetPhase, { targetPhase: phase.id, actor: 'hypothetical-human', at: at(1001), changeRequestId: 'hypothetical-new-epoch' });
        if (reset.attempts.length !== 1) throw failure('WCA_SIMULATION_OWNER_MISMATCH');
        scenario(`repair-budget-reset:${phase.id}`, phase.id, 'reset-request-alone-does-not-clear-exhaustion', 'expected-transition', [
          event('reset-request-only', phase.id, resetId, 'budget-not-cleared', 'repair:consumeRepairAttempt'),
          event('new-reset-generation-assumed', resetId, phase.id, 'new-budget-epoch', 'repair:consumeRepairAttempt')
        ], { resetPhase: resetId, observed: false });
      }
    }
    for (const loop of loops) {
      const projected = structuredClone(happy); projected.currentPhase = loop.from; projected.status = 'in_progress';
      const source = projected.phases[loop.from]; source.status = 'awaiting_approval';
      if (!(source.approvalPolicy.rejectTo ?? []).includes(loop.to) || source.approvalPolicy.mode === 'none') {
        finding('WCA_SIMULATION_REWORK_REVIEW_UNAVAILABLE', loop.from); continue;
      }
      let budgetPhase;
      try { budgetPhase = repairBudgetPhaseForRejection(projected, source, loop.to); }
      catch { finding('WCA_SIMULATION_REWORK_BUDGET_MISMATCH', loop.to); continue; }
      if (!budgetPhase) { finding('WCA_SIMULATION_REWORK_BUDGET_MISSING', loop.to); continue; }
      const accepted = structuredClone(projected); const acceptedBudget = accepted.phases[budgetPhase.id];
      const firstAttempt = consumeRepairAttempt(accepted, acceptedBudget, { targetPhase: loop.to,
        actor: 'hypothetical-human', at: at(1), changeRequestId: 'hypothetical-accepted-rework' });
      const affected = reopenPhaseRange(accepted, { targetId: loop.to, at: at(999), actor: 'hypothetical-human', reason: 'hypothetical-rework' });
      const fresh = phaseNeedsGeneration(accepted, accepted.phases[loop.to]);
      scenario(`rework:${loop.from}:${loop.to}`, loop.from, 'accepted-human-rework-invalidates-range', 'expected-transition', [
        event('human-rejection-assumed', loop.from, loop.to, `budget-${firstAttempt.attempts.length}-of-${loop.maxAttempts}`, 'repair:consumeRepairAttempt'),
        event('reopen-range', loop.from, loop.to, 'all-target-and-later-approvals-invalidated', 'lifecycle:reopenPhaseRange'),
        event('reuse-prior-output', 'approved-old-generation', 'unapproved-old-generation', fresh ? 'refused-until-fresh-generation-and-approval' : 'prior-approval-invalidated-generation-policy-preserved', 'sequence:phaseNeedsGeneration')
      ], { targetPhase: loop.to, affectedPhases: affected, previousOutputReceipts: 'retained-but-not-current-approved-input' });
      const budgetEvents = [];
      for (let attempt = 0; attempt < loop.maxAttempts; attempt += 1) {
        const receipt = consumeRepairAttempt(projected, budgetPhase, { targetPhase: loop.to,
          actor: 'hypothetical-human', at: at(attempt + 1), changeRequestId: `hypothetical-${attempt + 1}` });
        budgetEvents.push(event('human-rejection-assumed', loop.from, loop.to, `budget-${receipt.attempts.length}-of-${loop.maxAttempts}`, 'repair:consumeRepairAttempt'));
      }
      let exhausted = false;
      const exhaustedBeforeRefusal = JSON.stringify(projected);
      try { consumeRepairAttempt(projected, budgetPhase, { targetPhase: loop.to, actor: 'hypothetical-human', at: at(loop.maxAttempts + 1), changeRequestId: 'hypothetical-exhaustion' }); }
      catch (error) { exhausted = error.code === 'REPAIR_BUDGET_EXHAUSTED'; }
      const unchanged = JSON.stringify(projected) === exhaustedBeforeRefusal;
      budgetEvents.push(event('reject-after-budget', loop.from, loop.from, exhausted ? 'refused-budget-exhausted' : 'unexpectedly-allowed', 'repair:consumeRepairAttempt'));
      if (!exhausted || !unchanged) finding('WCA_SIMULATION_REWORK_EXHAUSTION_UNPROVEN', loop.to);
      scenario(`rework-budget-exhaustion:${loop.from}:${loop.to}`, loop.from, 'budget-refusal-before-any-lifecycle-mutation', exhausted && unchanged ? 'expected-refusal' : 'unexpected-transition',
        budgetEvents, { targetPhase: loop.to, stateUnchanged: unchanged,
          conditions: ['separate-reviewable-clone', 'maximum-prior-accepted-budget-attempts'], actualExecution: 'not-run' });
      if (loop.resetOnPhase) {
        projected.phases[loop.resetOnPhase].generation += 1;
        const reset = consumeRepairAttempt(projected, budgetPhase, { targetPhase: loop.to, actor: 'hypothetical-human', at: at(1000), changeRequestId: 'hypothetical-reset' });
        scenario(`budget-reset:${loop.from}:${loop.to}`, loop.to, 'new-reset-phase-generation-resets-budget', reset.attempts.length === 1 ? 'expected-transition' : 'unexpected-transition', [
          event('new-reset-generation-assumed', loop.resetOnPhase, loop.to, 'new-budget-epoch', 'repair:consumeRepairAttempt')
        ], { resetPhase: loop.resetOnPhase, observed: false });
      }
    }
    const result = report();
    if (Buffer.byteLength(JSON.stringify(result)) > WORKFLOW_LIFECYCLE_SIMULATION_LIMITS.outputBytes) throw failure('WCA_SIMULATION_LIMIT');
    return freeze(result);
  } catch (error) {
    const limited = error.code === 'WCA_SIMULATION_LIMIT';
    return freeze({ schemaVersion: 1, kind: 'workflow-lifecycle-simulation', profile: WORKFLOW_LIFECYCLE_SIMULATION_PROFILE,
      workflowId, sourceDefinitionSha256, status: limited ? 'incomplete' : 'invalid', scenarios: [],
      findings: [{ code: limited ? 'WCA_SIMULATION_LIMIT' : 'WCA_SIMULATION_INVALID', severity: limited ? 'incomplete' : 'invalid',
        message: limited ? 'Structural simulation exceeded its bounded profile; no complete or truncated-success report is emitted.' : 'Structural simulation could not validate the resolved contract; no assumed successful route is emitted.' }],
      coverage: { ...coverage, scenarioCount: 0, eventCount: 0, dimensions: [], incompleteDimensions: [...DIMENSIONS] },
      assumptions: [...ASSUMPTIONS], effects: effects() });
  }
}
