function frozen(value) { return Object.freeze(value); }

/** Resolve process outcome from runtime facts only. Raw output is intentionally not accepted. */
export function resolveExecutionOutcome({
  started = true,
  exitCode = null,
  signal = null,
  timedOut = false,
  cancelled = false,
  spawnErrorCode = null
} = {}) {
  if (cancelled) return frozen({
    state: 'cancelled', authority: 'runtime', exitCode, signal, reason: 'cancelled'
  });
  if (timedOut) return frozen({
    state: 'timed-out', authority: 'runtime', exitCode, signal, reason: 'timeout'
  });
  if (started === false || spawnErrorCode) return frozen({
    state: 'not-started', authority: 'runtime', exitCode: null, signal: null,
    reason: spawnErrorCode ? `spawn-error:${spawnErrorCode}` : 'process-not-started'
  });
  if (typeof signal === 'string' && signal) return frozen({
    state: 'failed', authority: 'process-signal', exitCode, signal, reason: `signal:${signal}`
  });
  if (Number.isInteger(exitCode)) return frozen({
    state: exitCode === 0 ? 'succeeded' : 'failed', authority: 'process-exit', exitCode,
    signal: null, reason: exitCode === 0 ? null : `exit-code:${exitCode}`
  });
  return frozen({
    state: 'unknown', authority: 'unavailable', exitCode: null, signal: null,
    reason: 'execution-metadata-unavailable'
  });
}
