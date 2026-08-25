/** Honest token admission: exact/provider observations stay distinct from estimates and unknowns. */
import { SingularityFlowError } from './util.mjs';

export const TOKEN_ADMISSION_ASSURANCES = Object.freeze([
  'tokenizer-exact', 'provider-reported', 'host-observed',
  'conservative-upper-bound', 'estimated', 'unavailable'
]);

const DIRECT_ASSURANCE = new Set(['tokenizer-exact', 'provider-reported', 'host-observed']);

function metric(value, assurance = 'unavailable', label) {
  if (!TOKEN_ADMISSION_ASSURANCES.includes(assurance)) {
    throw new SingularityFlowError(`${label}.assurance must be ${TOKEN_ADMISSION_ASSURANCES.join(', ')}.`, {
      code: 'TKN_ADMISSION_INVALID'
    });
  }
  if (value == null) return Object.freeze({ value: null, assurance: 'unavailable' });
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SingularityFlowError(`${label}.value must be a non-negative integer or null.`, {
      code: 'TKN_ADMISSION_INVALID'
    });
  }
  return Object.freeze({ value, assurance });
}

function normalizedMetric(value, fallback, label) {
  if (value == null) return metric(fallback?.value ?? null, fallback?.assurance ?? 'unavailable', label);
  if (Number.isSafeInteger(value)) return metric(value, 'provider-reported', label);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be a token metric object.`, { code: 'TKN_ADMISSION_INVALID' });
  }
  return metric(value.value ?? null, value.assurance ?? (value.value == null ? 'unavailable' : 'estimated'), label);
}

function enforceable(metricValue, policyApprovedConservativeUpperBound) {
  return metricValue.value != null && (
    DIRECT_ASSURANCE.has(metricValue.assurance)
      || (metricValue.assurance === 'conservative-upper-bound' && policyApprovedConservativeUpperBound)
  );
}

/**
 * Assess one complete provider admission without treating bytes/4 as a tokenizer or an unknown
 * history as zero. `safeToEnforce` describes evidence sufficiency; `admitted` is the budget result.
 */
export function assessTokenAdmission({
  model = null,
  logicalPromptBytes = 0,
  logicalPromptTokens = null,
  systemAndToolReserveTokens = null,
  historyTokens = null,
  maximumInputTokens = null,
  policyApprovedConservativeUpperBound = false
} = {}) {
  if (!Number.isSafeInteger(logicalPromptBytes) || logicalPromptBytes < 0) {
    throw new SingularityFlowError('logicalPromptBytes must be a non-negative integer.', {
      code: 'TKN_ADMISSION_INVALID'
    });
  }
  const estimatedPrompt = { value: Math.ceil(logicalPromptBytes / 4), assurance: 'estimated' };
  const prompt = normalizedMetric(logicalPromptTokens, estimatedPrompt, 'logicalPromptTokens');
  const reserve = normalizedMetric(systemAndToolReserveTokens, null, 'systemAndToolReserveTokens');
  const history = normalizedMetric(historyTokens, null, 'historyTokens');
  const known = [prompt, reserve, history].filter((entry) => entry.value != null);
  const totalValue = known.length ? known.reduce((sum, entry) => sum + entry.value, 0) : null;
  const complete = known.length === 3;
  const safeToEnforce = [prompt, reserve, history]
    .every((entry) => enforceable(entry, policyApprovedConservativeUpperBound));
  const totalAssurance = complete && safeToEnforce
    ? (known.every((entry) => entry.assurance === known[0].assurance)
      ? known[0].assurance : 'conservative-upper-bound')
    : totalValue == null ? 'unavailable' : 'partial';
  const limit = maximumInputTokens == null ? null : metric(maximumInputTokens, 'provider-reported', 'maximumInputTokens').value;
  return Object.freeze({
    model: model ? String(model) : null,
    logicalPromptBytes,
    logicalPromptTokens: prompt,
    systemAndToolReserveTokens: reserve,
    historyTokens: history,
    totalAdmissionTokens: Object.freeze({ value: totalValue, assurance: totalAssurance }),
    maximumInputTokens: limit,
    safeToEnforce,
    admitted: safeToEnforce && limit != null ? totalValue <= limit : null,
    policyApprovedConservativeUpperBound: Boolean(policyApprovedConservativeUpperBound)
  });
}
