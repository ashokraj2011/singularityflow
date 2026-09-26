/** One measured, cached CommonJS Help runtime for the Help Center and @sflow. */
import path from 'node:path';

import { recordHostRuntimeLoad } from './host-performance.ts';

type HelpRuntime = typeof import('./help-runtime.ts');
let runtime: HelpRuntime | null = null;

export function helpRuntime(): HelpRuntime {
  if (runtime) return runtime;
  const started = performance.now();
  runtime = require(path.join(__dirname, 'help-runtime.cjs')) as HelpRuntime;
  recordHostRuntimeLoad('help', performance.now() - started);
  return runtime;
}

export const resolveHelp: HelpRuntime['resolveHelp'] = (...args) => helpRuntime().resolveHelp(...args);
