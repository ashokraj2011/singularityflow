import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Kept in a dependency-light module so low-level Git execution can emit counters without creating
// a git-execution -> dx-command-timing -> git.mjs import cycle.
const commandTimingContext = new AsyncLocalStorage();
// CommonJS lazy runtimes contain separate copies of this module. Correlation, unlike policy or
// repository state, is host-wide and must survive that bundle boundary.
const actionKey = Symbol.for('singularity-flow.performance-action.v1');
const actions = globalThis[actionKey] ??= { context: new AsyncLocalStorage(), enabled: false };
const actionContext = actions.context;
export function configurePerformanceActions(enabled) { actions.enabled = enabled === true; }
export function performanceAction(action) { return actions.enabled ? withPerformanceAction(action) : action(); }
export function withPerformanceAction(action, id) { return actionContext.getStore() ? action() : actionContext.run(id ?? randomUUID(), action); }
export function performanceActionId() { return actionContext.getStore() ?? null; }
export function measurePerformance(category, name, action, fields) {
  const trace = commandTimingContext.getStore()?.trace;
  return trace ? trace.measure(category, name, action, typeof fields === 'function' ? fields() : fields) : action();
}
export function beginPerformanceSpan(category, name, fields) {
  return commandTimingContext.getStore()?.trace?.begin(category, name, fields) ?? null;
}

/**
 * Story start and publication report stages on stderr when the caller asks with
 * `SINGULARITY_FLOW_PROGRESS=stderr-v1`. `[perf]` Only known start/publication stage names are ever
 * written. The request is read once and removed, so no child process inherits it and writes
 * progress into output that something else parses.
 */
const PROGRESS_MODE = process.env.SINGULARITY_FLOW_PROGRESS === 'stderr-v1' ? 'stderr-v1' : null;
delete process.env.SINGULARITY_FLOW_PROGRESS;
const PROGRESS_STEP = /^(?:start\.[a-z][a-z-]*|publication\.(?:preflight|discovery|validation|commit|push))$/u;

function reportProgress(name) {
  if (!PROGRESS_MODE || !PROGRESS_STEP.test(name)) return;
  try {
    process.stderr.write(`@@sflow-progress/v1 ${name}\n`);
    commandTimingContext.getStore()?.feedback();
  } catch { /* progress is advisory */ }
}

export function withCommandTiming(timer, action) {
  return commandTimingContext.run(timer, () => timer.trace ? timer.trace.run(action) : action());
}

export function incrementCommandCounter(name, amount = 1) {
  return commandTimingContext.getStore()?.increment(name, amount) ?? null;
}

/** Record an operation-specific span without moving the command's sequential stage clock. */
export function measureCommandSpan(name, action) {
  reportProgress(name);
  const timer = commandTimingContext.getStore();
  return timer ? timer.measure(name, action) : action();
}

export function markCommandFeedback() {
  return commandTimingContext.getStore()?.feedback() ?? null;
}
