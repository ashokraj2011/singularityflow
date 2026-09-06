/** Computed CommonJS boundary for support operations that pull the full configuration graph. */
import path from 'node:path';

type Runtime = typeof import('./support-runtime.ts');
let runtime: Runtime | null = null;

function loadRuntime(): Runtime {
  return runtime ??= require(path.join(__dirname, 'support-runtime.cjs')) as Runtime;
}

export const readRecord: Runtime['readRecord'] = (...args) => loadRuntime().readRecord(...args);
export const recordHelpMetric: Runtime['recordHelpMetric'] = (...args) => loadRuntime().recordHelpMetric(...args);
