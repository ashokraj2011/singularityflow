import { AsyncLocalStorage } from 'node:async_hooks';

// Kept in a dependency-light module so low-level Git execution can emit counters without creating
// a git-execution -> dx-command-timing -> git.mjs import cycle.
const commandTimingContext = new AsyncLocalStorage();

export function withCommandTiming(timer, action) {
  return commandTimingContext.run(timer, action);
}

export function incrementCommandCounter(name, amount = 1) {
  return commandTimingContext.getStore()?.increment(name, amount) ?? null;
}
