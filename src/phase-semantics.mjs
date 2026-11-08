import { phaseTopologyFindings } from './kernel/phase-policy.mjs';
export { phaseTopologyFindings } from './kernel/phase-policy.mjs';
import { PHASE_SEMANTICS_PROFILE, ARA_PHASE_SEMANTICS_PROFILE } from './kernel/phase-policy.mjs';
export { PHASE_SEMANTICS_PROFILE, ARA_PHASE_SEMANTICS_PROFILE } from './kernel/phase-policy.mjs';
/** Versioned, read-only phase interpretation and runtime-topology admission. */
import { bindAcceptedPhaseInterpretation, artifactKindOf, isConvergencePhase,
  isConformancePhase, isVisualVerificationPhase } from './kernel/phase-policy.mjs';
import { phaseRequiresCodeDelivery } from './kernel/phase-policy.mjs';
import { phaseResponsibilities } from './kernel/phase-responsibilities.mjs';
import { isKnownPackagedAssetHash } from './packaged-asset-history.mjs';
import { SingularityFlowError } from './util.mjs';
const SUPPORTED_PHASE_PROFILES = new Set([PHASE_SEMANTICS_PROFILE, ARA_PHASE_SEMANTICS_PROFILE]);
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
      && !SUPPORTED_PHASE_PROFILES.has(workflow.resolution.phaseSemantics.profile)
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
  if (profile != null && !SUPPORTED_PHASE_PROFILES.has(profile)) {
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

export function assertPhaseTopology(resolved) {
  const findings = phaseTopologyFindings(resolved);
  if (findings.length) throw new SingularityFlowError(`Workflow '${resolved.id}' has unsupported execution topology:\n- ${findings.map((entry) => entry.message).join('\n- ')}\n${findings[0].resolvingAction}`,
    { code: findings[0].code, details: { findings } });
  return resolved;
}
