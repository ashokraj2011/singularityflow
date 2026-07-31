import { SingularityFlowError } from './util.mjs';

const BEHIND_MODES = new Set(['warn', 'block']);
const ENFORCEMENT_MODES = new Set(['shadow', 'required']);
const SIGNING_MODES = new Set(['off', 'commit']);
const TRUST_TIERS = new Set(['T0', 'T1', 'T2', 'T3']);
const PIN_TRANSPORTS = new Set(['refs', 'branches', 'none']);

function string(value, fallback, label) {
  const result = value ?? fallback;
  if (typeof result !== 'string' || !result.trim()) throw new SingularityFlowError(`${label} must be a non-empty string.`);
  return result.trim();
}

export function normalizeLedgerConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('ledger must be an object.');
  for (const key of Object.keys(value)) {
    if (!['enabled', 'branch', 'remote', 'behind', 'enforcement', 'signing', 'trustTier', 'maxRetries', 'pinTransport', 'retentionDays'].includes(key)) {
      throw new SingularityFlowError(`ledger contains unknown field '${key}'.`);
    }
  }
  if (value.enabled != null && typeof value.enabled !== 'boolean') throw new SingularityFlowError('ledger.enabled must be boolean.');
  const branch = string(value.branch, 'singularity/ledger', 'ledger.branch');
  const remote = string(value.remote, 'origin', 'ledger.remote');
  const behind = value.behind ?? 'warn';
  if (!BEHIND_MODES.has(behind)) throw new SingularityFlowError('ledger.behind must be warn or block.');
  const enforcement = value.enforcement ?? 'shadow';
  if (!ENFORCEMENT_MODES.has(enforcement)) throw new SingularityFlowError('ledger.enforcement must be shadow or required.');
  const signing = value.signing ?? 'off';
  if (!SIGNING_MODES.has(signing)) throw new SingularityFlowError('ledger.signing must be off or commit.');
  const trustTier = value.trustTier ?? 'T0';
  if (!TRUST_TIERS.has(trustTier)) throw new SingularityFlowError('ledger.trustTier must be T0, T1, T2, or T3.');
  const pinTransport = value.pinTransport ?? 'refs';
  if (!PIN_TRANSPORTS.has(pinTransport)) throw new SingularityFlowError('ledger.pinTransport must be refs, branches, or none.');
  const retentionDays = value.retentionDays ?? 2555;
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 36500) {
    throw new SingularityFlowError('ledger.retentionDays must be an integer from 0 through 36500.');
  }
  const maxRetries = value.maxRetries ?? 4;
  if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 20) {
    throw new SingularityFlowError('ledger.maxRetries must be an integer from 1 through 20.');
  }
  if (['T2', 'T3'].includes(trustTier) && signing === 'off') {
    throw new SingularityFlowError(`${trustTier} requires ledger.signing: commit or a future event-signature driver.`);
  }
  return {
    enabled: value.enabled === true,
    branch,
    remote,
    behind,
    enforcement,
    signing,
    trustTier,
    maxRetries,
    pinTransport,
    retentionDays
  };
}
