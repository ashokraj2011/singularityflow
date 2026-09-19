/**
 * Active persisted-view validator surface.
 *
 * Historical registry entries import immutable versioned validators directly. Future behavior
 * changes add a new module and registry entry rather than changing the v1 implementation.
 */
export {
  persistedOverviewCapturedInputGaps,
  verifyPersistedOverviewCandidateV1,
  verifyPersistedOverviewCandidateV1 as verifyPersistedOverviewCandidate
} from './persisted-overview-validator-v1.mjs';
