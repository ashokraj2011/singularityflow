import { SingularityFlowError } from './util.mjs';

const BEHIND_MODES = new Set(['warn', 'block']);
const ENFORCEMENT_MODES = new Set(['shadow', 'required']);
const SIGNING_MODES = new Set(['off', 'commit']);
const TRUST_TIERS = new Set(['T0', 'T1', 'T2', 'T3']);
const PIN_TRANSPORTS = new Set(['refs', 'branches', 'none']);
const PUBLICATION_MODES = new Set(['off', 'warn', 'required']);

function string(value, fallback, label) {
  const result = value ?? fallback;
  if (typeof result !== 'string' || !result.trim()) throw new SingularityFlowError(`${label} must be a non-empty string.`);
  return result.trim();
}

export function normalizeLedgerConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('ledger must be an object.');
  for (const key of Object.keys(value)) {
    if (!['enabled', 'branch', 'remote', 'behind', 'enforcement', 'signing', 'trustTier', 'maxRetries', 'pinTransport', 'retentionDays', 'publication', 'configurationHistory'].includes(key)) {
      throw new SingularityFlowError(`ledger contains unknown field '${key}'.`);
    }
  }
  if (value.enabled != null && typeof value.enabled !== 'boolean') throw new SingularityFlowError('ledger.enabled must be boolean.');
  const branch = string(value.branch, 'state', 'ledger.branch');
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
  const publication = value.publication ?? 'warn';
  if (!PUBLICATION_MODES.has(publication)) throw new SingularityFlowError('ledger.publication must be off, warn, or required.');
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
  const configurationHistory = value.configurationHistory == null ? null
    : normalizeConfigurationHistory(value.configurationHistory);
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
    publication,
    retentionDays,
    // Only when set, so a pinned Story resolution reads the same as before the field existed.
    ...(configurationHistory ? { configurationHistory } : {})
  };
}

/** `ledger.configurationHistory`: auto-clear of old `sflow/config-history/*` branches (on, 10 kept). */
export function normalizeConfigurationHistory(value) {
  const label = 'ledger.configurationHistory';
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'autoClear' && key !== 'keepRecent')) {
    throw new SingularityFlowError(`${label} takes only autoClear (boolean) and keepRecent (1-100).`);
  }
  const keepRecent = value.keepRecent ?? 10;
  if ((value.autoClear != null && typeof value.autoClear !== 'boolean')
    || !Number.isInteger(keepRecent) || keepRecent < 1 || keepRecent > 100) {
    throw new SingularityFlowError(`${label} takes only autoClear (boolean) and keepRecent (1-100).`);
  }
  return { autoClear: value.autoClear !== false, keepRecent };
}
