/**
 * Lightweight, fail-closed WEL enforcement diagnostic for configuration admission paths.
 *
 * This module deliberately cannot accept lifecycle evidence or turn readiness on. Policy readers
 * use it only to explain why `enforce` is unavailable without importing the SGOS record readers,
 * Candidate verifier, or mutable Process Store into every CLI/VS Code runtime bundle.
 */
import { authenticatedRunnerReadiness } from './delivery-modes/authenticated-runner-provider.mjs';

export const WEL_EXTERNAL_ENFORCEMENT_GAPS = Object.freeze([
  'WEL_AUTHENTICATED_RUNNER_UNAVAILABLE',
  'WEL_TRUST_AUTHORITY_UNAPPROVED',
  'WEL_SANDBOX_PLATFORM_EVIDENCE_MISSING',
  'WEL_RELEASE_MATRIX_EVIDENCE_MISSING',
  'WEL_INDEPENDENT_SECURITY_REVIEW_MISSING'
]);

/** Always returns unavailable. No supplied value can grant lifecycle or enforcement authority. */
export function unavailableWelEnforcementReadiness({
  enrollment = null, runnerProviderConfiguration = null, story = null
} = {}) {
  const cab = authenticatedRunnerReadiness(runnerProviderConfiguration);
  const explicitlyEnforced = enrollment?.mode === 'enforce'
    && enrollment?.rollout?.enrollment === 'new-story-only';
  const gaps = [...new Set([
    ...(!explicitlyEnforced ? ['WEL_ENFORCEMENT_NOT_ENROLLED'] : []),
    'WEL_LIFECYCLE_JOIN_UNAVAILABLE',
    ...WEL_EXTERNAL_ENFORCEMENT_GAPS,
    ...cab.gaps
  ])];
  return Object.freeze({
    schemaVersion: 1, // schema-transient: read-only readiness/UI projection.
    kind: 'wel-enforcement-readiness',
    readinessScope: 'foundation-projection',
    lifecycleVerification: 'not-loaded',
    status: 'unavailable',
    enforcementAvailable: false,
    authority: 'none',
    story: story == null ? null : Object.freeze({
      workId: String(story.workId),
      enrollmentClassification: String(story.enrollmentClassification),
      enrollmentReason: story.enrollmentReason == null ? null : String(story.enrollmentReason),
      creationCommit: story.creationCommit == null ? null : String(story.creationCommit)
    }),
    enrolled: explicitlyEnforced,
    lifecycleJoined: false,
    authenticatedRunner: cab,
    releaseEvidence: 'missing',
    recoveryAvailable: true,
    gaps: Object.freeze(gaps),
    nextActions: Object.freeze([
      { id: 'inspect-candidate', owner: 'sgos-candidate', mutation: false },
      { id: 'inspect-program-attempt-lineage', owner: 'sgos-runtime', mutation: false },
      { id: 'inspect-witness-review', owner: 'phase-approval', mutation: false },
      { id: 'inspect-publication-recovery', owner: 'publication-unit-of-work', mutation: false },
      { id: 'retry-through-sgos', owner: 'sgos-retry', mutation: true },
      { id: 'disable-for-future-stories', owner: 'reviewed-configuration', mutation: true }
    ])
  });
}
