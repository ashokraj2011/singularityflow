export function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index];
}

export function summarizeSamples(samples) {
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const variance = samples.reduce((total, value) => total + ((value - mean) ** 2), 0) / samples.length;
  return {
    samples: samples.length,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean
  };
}

export function evaluateLatency(name, summary, budget, baseline = null) {
  const failures = [];
  if (summary.p50Ms > budget.p50Ms) failures.push(`${name} p50 ${summary.p50Ms.toFixed(1)}ms exceeds ${budget.p50Ms}ms`);
  if (budget.p95Ms != null && summary.p95Ms > budget.p95Ms) failures.push(`${name} p95 ${summary.p95Ms.toFixed(1)}ms exceeds ${budget.p95Ms}ms`);
  if (baseline?.p50Ms && summary.p50Ms > baseline.p50Ms * 1.2) failures.push(`${name} p50 regressed by more than 20% from ${baseline.p50Ms.toFixed(1)}ms`);
  if (baseline?.p95Ms && summary.p95Ms > baseline.p95Ms * 1.2) failures.push(`${name} p95 regressed by more than 20% from ${baseline.p95Ms.toFixed(1)}ms`);
  return failures;
}
