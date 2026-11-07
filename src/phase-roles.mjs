/** Compatibility exports; kernel phase interpretation has one owner. */
export {
  CONVERGENCE_ARTIFACT_KIND,
  CONFORMANCE_ARTIFACT_KIND,
  VISUAL_EVIDENCE_ARTIFACT_KIND,
  bindAcceptedPhaseInterpretation,
  artifactKindOf,
  isConvergencePhase,
  convergencePhaseOf,
  stepResponsibilities,
  phaseOwnsScope,
  latestStepBefore,
  reviewKindForResponsibilities,
  sourceReviewKind,
  scopeStepOf,
  intentAmendmentSource,
  isConformancePhase,
  conformancePhasesOf,
  conformancePhaseOf,
  isVisualVerificationPhase,
  visualVerificationPhaseOf,
  isTestEvidencePhase
} from './kernel/phase-policy.mjs';
