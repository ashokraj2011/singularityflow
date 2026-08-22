/**
 * Host-neutral usage observations and arithmetic for Context X-Ray.
 *
 * Provider totals and SFlow estimates deliberately use the same small value envelope while keeping
 * their assurance distinct. Nothing here reads prompts, provider output, source, or tool payloads.
 */

export const OBSERVATION_STATUSES = Object.freeze(['exact', 'partial', 'estimated', 'unavailable']);
export const USAGE_ASSURANCES = Object.freeze([
  'provider-reported', 'host-observed', 'sflow-measured', 'sflow-estimated',
  'self-reported', 'unavailable'
]);

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null;
}

export function usageMetric(value, {
  status = value == null ? 'unavailable' : 'exact',
  assurance = value == null ? 'unavailable' : 'provider-reported',
  reason = null
} = {}) {
  const numeric = finiteNonNegative(value);
  if (!OBSERVATION_STATUSES.includes(status)) throw new Error(`Unknown usage observation status '${status}'.`);
  if (!USAGE_ASSURANCES.includes(assurance)) throw new Error(`Unknown usage assurance '${assurance}'.`);
  if (numeric == null && status !== 'unavailable') {
    throw new Error(`Usage value with status '${status}' must be a finite non-negative number.`);
  }
  if (numeric != null && status === 'unavailable') {
    throw new Error('Unavailable usage cannot carry a numeric value.');
  }
  if (status === 'unavailable' && assurance !== 'unavailable') {
    throw new Error('Unavailable usage must carry unavailable assurance.');
  }
  return Object.freeze({ value: numeric, status, assurance, ...(reason ? { reason } : {}) });
}

/** Sum independent observations without converting missing members to zero. */
export function combineUsageMetrics(metrics, { assurance = null } = {}) {
  const values = metrics.filter((metric) => metric?.value != null);
  if (!values.length) return usageMetric(null);
  const exact = values.length === metrics.length && values.every((metric) => metric.status === 'exact');
  const estimated = values.length === metrics.length && values.every((metric) => metric.status === 'estimated');
  const status = exact ? 'exact' : estimated ? 'estimated' : 'partial';
  const resolvedAssurance = assurance
    ?? (new Set(values.map((metric) => metric.assurance)).size === 1
      ? values[0].assurance
      : status === 'estimated' ? 'sflow-estimated' : 'host-observed');
  return usageMetric(values.reduce((total, metric) => total + metric.value, 0), {
    status, assurance: resolvedAssurance
  });
}

/** Derived provider arithmetic. Cached input is already part of input and is never added twice. */
export function providerTokenArithmetic({
  inputTokens = usageMetric(null), outputTokens = usageMetric(null),
  cachedInputTokens = usageMetric(null), reasoningTokens = usageMetric(null),
  reasoningIsSeparate = false
} = {}) {
  let uncachedInputTokens = usageMetric(null);
  if (inputTokens.status === 'exact' && cachedInputTokens.status === 'exact') {
    uncachedInputTokens = cachedInputTokens.value <= inputTokens.value
      ? usageMetric(inputTokens.value - cachedInputTokens.value, {
        assurance: inputTokens.assurance === cachedInputTokens.assurance
          ? inputTokens.assurance : 'host-observed'
      })
      : usageMetric(null, { reason: 'cached input exceeds total input' });
  }

  const totalParts = [inputTokens, outputTokens];
  if (reasoningIsSeparate) totalParts.push(reasoningTokens);
  const totalProviderTokens = combineUsageMetrics(totalParts);
  return Object.freeze({ uncachedInputTokens, totalProviderTokens });
}

export function estimateUtf8Tokens(bytes) {
  const value = finiteNonNegative(bytes);
  if (value == null) return usageMetric(null);
  return usageMetric(Math.ceil(value / 4), {
    status: 'estimated', assurance: 'sflow-estimated'
  });
}

export function observationCompression(rawBytes, deliveredBytes) {
  const raw = finiteNonNegative(rawBytes);
  const delivered = finiteNonNegative(deliveredBytes);
  if (raw == null || delivered == null) {
    return Object.freeze({ ratio: usageMetric(null), reductionPercent: usageMetric(null) });
  }
  if (delivered > raw) {
    const reason = 'delivered bytes exceed observed raw bytes';
    return Object.freeze({
      ratio: usageMetric(null, { reason }),
      reductionPercent: usageMetric(null, { reason })
    });
  }
  const reductionPercent = raw === 0 ? 0 : 1 - (delivered / raw);
  return Object.freeze({
    ratio: delivered === 0
      ? usageMetric(null, { reason: 'delivered bytes are zero' })
      : usageMetric(raw / delivered, { assurance: 'sflow-measured' }),
    reductionPercent: usageMetric(reductionPercent, { assurance: 'sflow-measured' })
  });
}
