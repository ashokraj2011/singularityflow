/**
 * Failures that mean optional World-Model context cannot be obtained safely right now.
 *
 * These errors may be converted to a zero-context receipt because no World-Model bytes have been
 * accepted. Validation, digest, path, provenance, migration, and configuration errors are
 * deliberately absent: once candidate bytes are present, their integrity still fails closed.
 */
const AVAILABILITY_CODES = new Set([
  'WORLD_MODEL_CONTEXT_UNAVAILABLE',
  'WORLD_MODEL_GROUNDING_UNAVAILABLE',
  'WORLD_MODEL_SELECTION_UNAVAILABLE',
  'WORLD_MODEL_STATE_EXTRACTION_FAILED',
  'WORLD_MODEL_STALE',
  'WORLD_MODEL_UNPUBLISHED',
  'WORLD_MODEL_WORKTREE_DIRTY',
  'WMB_GATEWAY_PUBLICATION_AUTHORITY_UNAVAILABLE',
  'WMB_MANIFEST_MISSING',
  'WMB_SOURCE_SNAPSHOT_STALE',
  'WMB_STATE_AUTHORITY_REFRESH_REQUIRED',
  'WMB_STATE_AUTHORITY_UNAVAILABLE',
  'WMB_VIEW_UNAVAILABLE',
  'world_model.capability_missing',
  'world_model.capability_stale',
  'world_model.capability_unavailable',
  'world_model.local_only',
  'world_model.materialization_required',
  'world_model.state_authority_unavailable',
  'world_model.state_branch_absent',
  'world_model.state_extraction_failed',
  'world_model.state_removed_remotely'
]);

// A model on a missing, unmounted, or unreadable local cache is unavailable. Parse failures,
// short reads without a filesystem availability code, and digest mismatches remain integrity
// failures.
const AVAILABILITY_FILESYSTEM_CODES = new Set([
  'EACCES', 'ENOENT', 'EPERM', 'ESTALE'
]);

const AUTHORITY_ACCESS_FAILURES = new Set([
  'authentication-required', 'authorization-denied', 'branch-not-found',
  'network-transient', 'offline', 'proxy-configuration', 'rate-limited',
  'remote-not-found', 'tls-trust'
]);

export function isWorldModelAvailabilityError(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === 'WMB_STATE_AUTHORITY_REFRESH_FAILED') {
    // A credential, network, proxy, TLS, or rate-limit refusal means optional remote context is
    // unavailable. Ambiguous remotes/refs and tracking-ref races are authority-integrity faults.
    return AUTHORITY_ACCESS_FAILURES.has(String(error.details?.classification ?? ''));
  }
  if (AVAILABILITY_CODES.has(code)) return true;
  if (AVAILABILITY_FILESYSTEM_CODES.has(code)) return true;
  // An explicit outer code is the subsystem's classification. Never let an ENOENT cause turn an
  // integrity wrapper such as WMB_PINNED_CORE_INVALID into an availability failure.
  if (code) return false;
  return error.cause && error.cause !== error
    ? isWorldModelAvailabilityError(error.cause)
    : false;
}

export function worldModelAvailabilityReasonCode(
  error, fallback = 'WORLD_MODEL_GROUNDING_UNAVAILABLE'
) {
  const code = String(error?.code ?? '');
  if (code === 'WMB_STATE_AUTHORITY_REFRESH_FAILED'
      && isWorldModelAvailabilityError(error)) return code;
  if (AVAILABILITY_CODES.has(code) && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(code)) {
    // Durable prompt receipts use an uppercase vocabulary even when a legacy subsystem exposes a
    // dotted lowercase diagnostic code.
    return code.toUpperCase().replaceAll('.', '_').replaceAll('-', '_');
  }
  if (AVAILABILITY_FILESYSTEM_CODES.has(code)) return `WORLD_MODEL_${code}`;
  return fallback;
}

export const WORLD_MODEL_AVAILABILITY_CODES = Object.freeze([...AVAILABILITY_CODES]);
