/** Closed, deterministic registry for bounded workspace reliability healers. */
import { AsyncLocalStorage } from 'node:async_hooks';

import { SingularityFlowError } from './util.mjs';

const DEFINITIONS = Object.freeze([
  {
    id: 'stale-workspace-registry', detects: ['WORKSPACE_REGISTRY_STALE'], level: 'H1',
    scope: 'machine-local-derived-state', authority: 'automatic', attempts: 1,
    preconditions: ['registry-readable', 'workspace-manifest-valid'],
    effects: ['rewrite-registry-projection'], verify: ['registry-resolves-workspace'],
    rollback: 'restore-previous-registry-file'
  },
  {
    id: 'expired-bootstrap-lease', detects: ['BOOTSTRAP_LEASE_EXPIRED'], level: 'H1',
    scope: 'machine-local-derived-state', authority: 'automatic', attempts: 1,
    preconditions: ['lease-expired', 'bootstrap-record-integrity-valid'],
    effects: ['remove-expired-machine-local-lease'], verify: ['bootstrap-lease-acquired'],
    rollback: 'not-required-expired-lock'
  },
  {
    id: 'orphan-bootstrap-staging', detects: ['BOOTSTRAP_STAGING_ORPHANED'], level: 'H1',
    scope: 'session-owned-temporary-path', authority: 'automatic', attempts: 1,
    preconditions: ['canonical-containment', 'ownership-marker-valid', 'contents-session-owned'],
    effects: ['remove-verified-staging-directory'], verify: ['staging-directory-absent'],
    rollback: 'not-recoverable-session-temporary-bytes'
  },
  {
    id: 'missing-derived-index', detects: ['DERIVED_INDEX_MISSING'], level: 'H1',
    scope: 'machine-local-derived-state', authority: 'automatic', attempts: 1,
    preconditions: ['authoritative-source-valid', 'destination-absent'],
    effects: ['rebuild-derived-index'], verify: ['derived-index-matches-source'],
    rollback: 'remove-rebuilt-derived-index'
  },
  {
    id: 'runtime-projection-drift', detects: ['EMBEDDED_RUNTIME_PROJECTION_STALE'], level: 'H1',
    scope: 'installed-product-derived-state', authority: 'automatic', attempts: 1,
    preconditions: ['packaged-runtime-valid'], effects: ['reconcile-runtime-projection'],
    verify: ['runtime-projection-matches-package'], rollback: 'restore-previous-projection'
  },
  {
    id: 'remote-push-already-succeeded', detects: ['TRANSPORT_OUTCOME_UNKNOWN'], level: 'H1',
    scope: 'transport-projection', authority: 'automatic', attempts: 1,
    preconditions: ['remote-readable', 'remote-target-equals-source-commit'],
    effects: ['mark-transport-succeeded'], verify: ['remote-target-equals-source-commit'],
    rollback: 'restore-prior-local-intent-projection'
  }
].map((entry) => Object.freeze({
  ...entry,
  detects: Object.freeze(entry.detects), preconditions: Object.freeze(entry.preconditions),
  effects: Object.freeze(entry.effects), verify: Object.freeze(entry.verify)
})));

const BY_ID = new Map(DEFINITIONS.map((entry) => [entry.id, entry]));
const invocation = new AsyncLocalStorage();

export function workspaceHealerRegistry() { return DEFINITIONS; }

export function workspaceHealer(id) {
  const healer = BY_ID.get(id);
  if (!healer) throw new SingularityFlowError(`Unknown workspace healer '${id}'.`, {
    code: 'WORKSPACE_HEALER_UNKNOWN'
  });
  return healer;
}

/** A receipt cannot claim self-healing without concrete passing postcondition evidence. */
export function healerReceipt(id, { effects = null, postconditions = [], proof = {}, appliedAt = new Date().toISOString() } = {}) {
  const healer = workspaceHealer(id);
  if (!Array.isArray(postconditions) || !postconditions.length
    || postconditions.some((entry) => entry?.status !== 'pass')) {
    throw new SingularityFlowError(`Workspace healer '${id}' has no passing postcondition proof.`, {
      code: 'WORKSPACE_HEALER_PROOF_REQUIRED'
    });
  }
  return Object.freeze({
    id: healer.id, level: healer.level, authority: healer.authority, appliedAt,
    effects: Object.freeze([...(effects ?? healer.effects)]),
    postconditions: Object.freeze(postconditions.map((entry) => Object.freeze({ ...entry }))),
    proof: Object.freeze({ ...proof })
  });
}

/** Execute one registered healer and prevent recursive healer invocation. */
export async function runWorkspaceHealer(id, operation) {
  const healer = workspaceHealer(id);
  if (invocation.getStore()) {
    throw new SingularityFlowError('A workspace healer cannot invoke another healer recursively.', {
      code: 'WORKSPACE_HEALER_RECURSION_REFUSED', details: { active: invocation.getStore(), requested: id }
    });
  }
  if (typeof operation !== 'function') throw new TypeError('A workspace healer requires an operation.');
  return invocation.run(id, async () => {
    const result = await operation(healer);
    return { result, receipt: healerReceipt(id, result?.receipt ?? result) };
  });
}
