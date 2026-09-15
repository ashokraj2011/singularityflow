import { run, SingularityFlowError } from '../../util.mjs';

export const WMP_HISTORY_READ_TIMEOUT = 'WMP_HISTORY_READ_TIMEOUT';

/**
 * Exact-history reads are local object-store operations, never transport operations.
 *
 * `GIT_NO_LAZY_FETCH` prevents a promisor/partial clone from silently contacting its remote when
 * an object is absent. The remaining settings prevent credential UI from being opened if Git or a
 * configured helper nevertheless reaches a transport boundary. `timeoutClass: local-read` gives
 * every synchronous read the product-wide bounded deadline.
 */
export function worldModelHistoryOfflineGitEnvironment(env = process.env) {
  return {
    ...env,
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
}

function timeoutFailure(operation, cause) {
  return new SingularityFlowError(
    `Persisted World-model Git read '${operation}' exceeded its bounded local-read deadline.`,
    {
      code: WMP_HISTORY_READ_TIMEOUT,
      details: { operation, cause: 'SUBPROCESS_TIMEOUT' },
      cause
    }
  );
}

/** Run one bounded, non-interactive, no-lazy-fetch Git history read. */
export function runWorldModelHistoryGitRead(root, args, {
  env = process.env,
  runCommand = run,
  operation = String(args?.[0] ?? 'unknown'),
  ...options
} = {}) {
  let result;
  try {
    result = runCommand('git', args, {
      ...options,
      cwd: root,
      allowFailure: true,
      timeoutClass: 'local-read',
      env: worldModelHistoryOfflineGitEnvironment(env)
    });
  } catch (error) {
    if (error?.code === 'SUBPROCESS_TIMEOUT' || error?.code === WMP_HISTORY_READ_TIMEOUT) {
      if (error?.code === WMP_HISTORY_READ_TIMEOUT) throw error;
      throw timeoutFailure(operation, error);
    }
    throw error;
  }
  if (result?.timedOut || result?.error?.code === 'ETIMEDOUT') {
    throw timeoutFailure(operation, result?.error);
  }
  return result;
}
