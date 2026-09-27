/** Pure evidence-policy predicates. They interpret observations, never execute checks or mint receipts. */
export function inputFindingSeverity(mode, optional, status) {
  if (status === 'captured' || (optional && ['missing', 'unapproved'].includes(status))) return null;
  return mode === 'enforce' ? 'error' : 'warning';
}

export function qualityValidationVerdict(checks = [], { required = false } = {}) {
  const known = new Set(['passed', 'failed', 'blocked', 'skipped-warning', 'unavailable']);
  const invalid = checks.filter((check) => !known.has(check?.status));
  const explicitFailures = checks.filter((check) => check.status === 'failed' || check.status === 'blocked');
  // Unknown output is never passing evidence; the runtime gate and the simulator share this rule.
  const failed = [...explicitFailures, ...invalid];
  const unavailable = checks.filter((check) => ['skipped-warning', 'unavailable'].includes(check.status));
  const unavailableRequired = unavailable.filter((check) => (check.requirement ?? 'required') === 'required');
  let verdict;
  if (!checks.length) verdict = required ? 'invalid' : 'not-required';
  else if (invalid.length) verdict = 'invalid';
  else if (explicitFailures.length) verdict = 'failed';
  else if (unavailable.length === checks.length) verdict = 'unavailable';
  else if (unavailable.length) verdict = 'partial';
  else verdict = 'passed';
  return { verdict, failed, invalid, unavailable, unavailableRequired };
}
