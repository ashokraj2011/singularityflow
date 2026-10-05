/** Versioned, read-only phase interpretation and runtime-topology admission. */
import { bindAcceptedPhaseInterpretation, artifactKindOf, isConvergencePhase,
  isConformancePhase, isVisualVerificationPhase } from './phase-roles.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { phaseResponsibilities } from './evidence/responsibilities.mjs';
import { isKnownPackagedAssetHash } from './packaged-asset-history.mjs';
import { SingularityFlowError } from './util.mjs';

export const PHASE_SEMANTICS_PROFILE = 'sflow-phase-semantics/v1';
const LEGACY_CONVERGENCE_TEMPLATE = 'singularity/templates/spec-driven/convergence.md';

function legacyConvergenceCandidate(phase) {
  return artifactKindOf(phase) === 'verification-report'
    && (phase.template === 'spec-driven/convergence.md'
      || phase.defaultTemplate === 'spec-driven/convergence.md');
}

/** Ordinary current pins require no additional Git reads merely to display their roles. */
export function needsAcceptedPhaseInterpretation(workflow) {
  return Boolean(workflow?.workflowSnapshot) && (
    workflow.resolution?.phaseSemantics?.profile !== undefined
      && workflow.resolution.phaseSemantics.profile !== PHASE_SEMANTICS_PROFILE
    || workflow.resolution?.obligationGraph?.compilerVersion != null
      && workflow.resolution.obligationGraph.compilerVersion !== 1
    || !workflow.resolution?.obligationGraph
    || (workflow.resolution?.phases ?? []).some(legacyConvergenceCandidate)
  );
}

/** Called with policy and templates from the verified accepted closure, never the live YAML. */
export function installAcceptedPhaseInterpretation(workflow, policy, phaseTemplates, semantics = {}) {
  if (policy.phaseSemantics?.profile != null && semantics.phaseSemantics != null
      && policy.phaseSemantics.profile !== semantics.phaseSemantics) {
    throw new SingularityFlowError('The accepted policy and manifest disagree about phase semantics. Use a compatible build and inspect the accepted closure; do not guess its execution rules.',
      { code: 'WFA_RUNTIME_INCOMPATIBLE' });
  }
  const profile = policy.phaseSemantics?.profile ?? semantics.phaseSemantics;
  if (profile != null && profile !== PHASE_SEMANTICS_PROFILE) {
    throw new SingularityFlowError(`This Story requires unsupported phase semantics '${profile}'. Use a compatible Singularity Flow build; do not rewrite its accepted policy.`,
      { code: 'WFA_RUNTIME_INCOMPATIBLE', details: { profile } });
  }
  const phases = policy.phases ?? [];
  if (policy.obligationGraph?.compilerVersion != null && policy.obligationGraph.compilerVersion !== 1) {
    throw new SingularityFlowError(`This Story requires unsupported obligation compiler '${policy.obligationGraph.compilerVersion}'. Use a compatible build; do not silently drop its responsibilities.`,
      { code: 'WFA_RUNTIME_INCOMPATIBLE' });
  }
  const hasCodeStep = phases.some(phaseRequiresCodeDelivery);
  const kinds = {}; const responsibilities = {};
  for (const phase of phases) {
    let kind = artifactKindOf(phase);
    if (profile == null && legacyConvergenceCandidate(phase)) {
      const generation = phase.generation;
      const knownTemplate = isKnownPackagedAssetHash(LEGACY_CONVERGENCE_TEMPLATE, phaseTemplates[phase.id]?.sha256);
      const codeBefore = phases.slice(0, phases.indexOf(phase)).some(phaseRequiresCodeDelivery);
      if (!knownTemplate || !codeBefore || phase.writeScope !== 'artifact-only'
          || phase.approval?.mode !== 'required' || generation?.requirement !== 'required'
          || generation.defaultProducer !== 'deterministic'
          || generation.allowedProducers?.length !== 1 || generation.allowedProducers[0] !== 'deterministic') {
        throw new SingularityFlowError(`The accepted legacy review step '${phase.id}' cannot be interpreted safely as Convergence. Review the workflow contract and explicitly adopt a supported policy; ordinary submission is not a repair.`,
          { code: 'WFA_PHASE_SEMANTICS_UNSUPPORTED', details: { phase: phase.id } });
      }
      kind = 'convergence-report';
    }
    kinds[phase.id] = kind;
    responsibilities[phase.id] = Object.freeze([...(policy.obligationGraph?.nodes?.find((node) => node.id === phase.id)?.responsibilities
      ?? phaseResponsibilities(phase, { plannedClaims: policy.plannedClaims, hasCodeStep }))]);
  }
  bindAcceptedPhaseInterpretation(workflow, kinds, Object.freeze(responsibilities));
}

/** Pure findings: incomplete drafts stay readable, but cannot be activated or started. */
export function phaseTopologyFindings(resolved) {
  const phases = resolved?.phases ?? [];
  const findings = [];
  const add = (code, phase, message) => findings.push({ code, phaseId: phase.id, severity: 'error', message,
    resolvingAction: 'Edit the effective workflow in Configuration Center, then validate it before starting a Story.' });
  const convergence = phases.filter(isConvergencePhase);
  if (convergence.length > 1) add('WORKFLOW_CONVERGENCE_MULTIPLE_UNSUPPORTED', convergence[1],
    'Only one Convergence step is supported: iteration storage must not be shared by separate review stages.');
  for (const phase of convergence) {
    if (!phases.slice(0, phases.indexOf(phase)).some(phaseRequiresCodeDelivery)) {
      add('WORKFLOW_CONVERGENCE_CODE_SOURCE_MISSING', phase, `Convergence '${phase.id}' needs an earlier code-delivery step and its reconciliation. Use an ordinary document review for a workflow that produces no code.`);
    }
  }
  const visual = phases.filter(isVisualVerificationPhase);
  if (visual.length > 1) add('WORKFLOW_VISUAL_MULTIPLE_UNSUPPORTED', visual[1],
    'Only one visual-evidence stage is supported by this workflow contract. Split stages into separate workflows until independent receipt namespaces are supported.');
  for (const phase of phases) {
    if ((isConvergencePhase(phase) || isConformancePhase(phase) || isVisualVerificationPhase(phase))
        && (phase.generationPolicy ?? phase.generation)?.requirement === 'none') {
      add('WORKFLOW_PROOF_OUTPUT_REQUIRED', phase,
        `Proof-producing step '${phase.id}' cannot be sign-off-only. Keep its report generation required; use an ordinary review step to review existing outputs.`);
    } else if ((phase.generationPolicy ?? phase.generation)?.requirement === 'none') {
      add('WORKFLOW_REVIEW_RECEIPT_UNSUPPORTED', phase,
        `Step '${phase.id}' declares no output generation, but this execution contract requires a publication receipt. Use a required deterministic or authored review artifact; a no-output review receipt is not supported yet.`);
    }
  }
  return findings;
}

export function assertPhaseTopology(resolved) {
  const findings = phaseTopologyFindings(resolved);
  if (findings.length) throw new SingularityFlowError(`Workflow '${resolved.id}' has unsupported execution topology:\n- ${findings.map((entry) => entry.message).join('\n- ')}\n${findings[0].resolvingAction}`,
    { code: findings[0].code, details: { findings } });
  return resolved;
}
