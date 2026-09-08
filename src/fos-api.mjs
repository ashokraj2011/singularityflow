/**
 * Stable in-process boundary for separately installed FOS authority adapters.
 *
 * This surface verifies adapter certification and exposes only the M5 operations that consume the
 * resulting process-local set. It does not enable a feature or grant publication authority.
 */
export {
  certifiedFosAdapterTypes,
  FOS_ADAPTER_SCENARIOS,
  FOS_ADAPTER_TYPES,
  fosAdapterCertificationPayloadSha256,
  requireCertifiedFosAdapter,
  verifyFosAdapterSet
} from './fos-adapters.mjs';

export {
  acceptFosApprovalRequest,
  createFosApprovalRequest,
  evaluateFosPrCheckAdoption,
  fosMilestoneReadiness,
  requestFosPreauthorization
} from './fos-features.mjs';

export {
  deliverFosApprovalOutbox,
  enqueueFosApprovalRequest
} from './fos-convenience-store.mjs';
