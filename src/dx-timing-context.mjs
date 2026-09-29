import { AsyncLocalStorage } from 'node:async_hooks';

// Kept in a dependency-light module so low-level Git execution can emit counters without creating
// a git-execution -> dx-command-timing -> git.mjs import cycle.
const commandTimingContext = new AsyncLocalStorage();

/**
 * Story start reports each stage it enters, one stderr line each, when its caller asks with
 * `SINGULARITY_FLOW_PROGRESS=stderr-v1`. `[perf]` Only the fixed `start.*` span names are ever
 * written. The request is read once and removed, so no child process inherits it and writes
 * progress into output that something else parses.
 */
const PROGRESS_MODE = process.env.SINGULARITY_FLOW_PROGRESS === 'stderr-v1' ? 'stderr-v1' : null;
delete process.env.SINGULARITY_FLOW_PROGRESS;
const PROGRESS_STEP = /^start\.[a-z][a-z-]*$/u;

function reportProgress(name) {
  if (!PROGRESS_MODE || !PROGRESS_STEP.test(name)) return;
  try { process.stderr.write(`@@sflow-progress/v1 ${name}\n`); } catch { /* progress is advisory */ }
}

export function withCommandTiming(timer, action) {
  return commandTimingContext.run(timer, action);
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
