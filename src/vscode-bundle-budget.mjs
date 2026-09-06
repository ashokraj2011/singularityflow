/** Build a content-free byte and module-closure report for the shipped VS Code runtimes. */
export function buildVsCodeBundleBudgetReport(measured, policy) {
  if (!measured || typeof measured !== 'object' || Array.isArray(measured)) {
    throw new TypeError('Measured VS Code entries must be an object.');
  }
  if (policy?.schemaVersion !== 1 || policy?.kind !== 'sflow-vscode-bundle-budgets' // schema-transient: reviewed source-controlled benchmark policy, not a durable product record
      || !policy.entries || typeof policy.entries !== 'object') {
    throw new TypeError('VS Code bundle policy must be a schema-v1 sflow-vscode-bundle-budgets document.');
  }
  const failures = [];
  const entries = {};
  const expected = Object.keys(policy.entries).sort();
  const actual = Object.keys(measured).sort();
  for (const name of expected) {
    const limits = policy.entries[name];
    const value = measured[name];
    if (!value || !Number.isSafeInteger(value.bytes) || value.bytes < 1
        || !Number.isSafeInteger(value.modules) || value.modules < 1) {
      failures.push(`${name}:measurement-missing`);
      continue;
    }
    entries[name] = Object.freeze({ bytes: value.bytes, modules: value.modules });
    if (value.bytes > limits.maximumBytes) failures.push(`${name}:bytes>${limits.maximumBytes}`);
    if (value.modules > limits.maximumModules) failures.push(`${name}:modules>${limits.maximumModules}`);
  }
  for (const name of actual.filter((name) => !policy.entries[name])) {
    failures.push(`${name}:unbudgeted-entry`);
  }
  const totalJavaScriptBytes = Object.values(entries).reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalJavaScriptBytes > policy.totalJavaScriptBytes.maximum) {
    failures.push(`totalJavaScriptBytes:maximum>${policy.totalJavaScriptBytes.maximum}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'sflow-vscode-bundle-budget-report',
    status: failures.length ? 'failed' : 'passed',
    entries: Object.freeze(entries),
    totalJavaScriptBytes,
    budgets: Object.freeze({
      totalJavaScriptBytes: policy.totalJavaScriptBytes,
      entries: policy.entries
    }),
    failures: Object.freeze(failures)
  });
}
