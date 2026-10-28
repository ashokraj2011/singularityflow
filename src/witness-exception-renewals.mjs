/**
 * Renewing a lapsed witness exception (`decision witness-exception`, 2026-10-28).
 *
 * A step's approval may accept a test as an exception for a criterion (`approve --witness-mapping
 * <sha256>=exception:<facets> --witness-mapping-expires`). Once that date passed before the Story
 * finished, the final check refused it, and the only way out was returning the Story to that code
 * step: regenerating and retesting code that had not changed. A person who approves the step that
 * recorded the exception renews it instead, with a new future expiry and a reason, for that exact
 * exception (step, generation and mapping digest); a later generation of the step needs its own
 * decision. Renewals are append-only; the latest one for an exception sets its expiry, which the
 * final check reads (renewedWitnessExpiry in governance.mjs, where the gate's graph already is).
 */
import { renewedWitnessExpiry } from './governance.mjs';
import { SingularityFlowError } from './util.mjs';

export { renewedWitnessExpiry, witnessExceptionRenewalCommand } from './governance.mjs';

const MAX_REASON = 1000;

/** The exception this step's current approval recorded for `mappingSha256`, or null. */
export function witnessException(workflow, phaseId, mappingSha256) {
  const phase = workflow?.phases?.[phaseId];
  for (const approval of [...(phase?.approvals ?? [])].reverse()) {
    if (approval?.invalidatedAt || approval.decision !== 'approved' || Number(approval.generation) !== Number(phase.generation)) continue;
    const mapping = (approval.witnessMappings ?? []).find((entry) => entry?.mappingSha256 === mappingSha256 && entry.decision === 'exception');
    if (mapping) return { phase, approval, mapping };
  }
  return null;
}

/** Record one renewal on the aggregate; the caller checked authority. */
export function recordWitnessExceptionRenewal(workflow, { phaseId, mappingSha256, expires, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const found = witnessException(workflow, phaseId, mappingSha256);
  if (!found) {
    throw new SingularityFlowError(`${phaseId}'s current approval recorded no witness exception for ${mappingSha256}.`,
      { code: 'WITNESS_EXCEPTION_UNKNOWN', details: { phase: phaseId, mappingSha256 } });
  }
  const expiry = Date.parse(/^\d{4}-\d{2}-\d{2}$/u.test(String(expires ?? '')) ? `${expires}T23:59:59.999Z` : String(expires ?? ''));
  if (!Number.isFinite(expiry) || expiry <= Date.parse(at)) {
    throw new SingularityFlowError('A renewed witness exception needs a future expiry: --expires YYYY-MM-DD.', { code: 'WITNESS_EXCEPTION_RENEWAL_INVALID' });
  }
  const text = String(reason ?? '').trim();
  if (text.length < 10 || text.length > MAX_REASON) {
    throw new SingularityFlowError(`Say why the exception still stands in 10 to ${MAX_REASON} characters with --reason.`, { code: 'WITNESS_EXCEPTION_RENEWAL_INVALID' });
  }
  workflow.witnessExceptionRenewals ??= [];
  const record = {
    id: `WXR-${String(workflow.witnessExceptionRenewals.length + 1).padStart(3, '0')}`,
    phase: phaseId, generation: Number(found.phase.generation), mappingSha256, clauseId: found.mapping.clauseId ?? null,
    previousExpiresAt: renewedWitnessExpiry(workflow, phaseId, found.phase.generation, mappingSha256) ?? found.mapping.expiresAt ?? null,
    expiresAt: new Date(expiry).toISOString(), reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.witnessExceptionRenewals.push(record);
  return record;
}
