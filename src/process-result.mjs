/**
 * True only when a child process completed and produced an admissible success result.
 *
 * Node can report `status: 0` together with an execution error (notably ETIMEDOUT), and injected
 * or platform-specific runners can retain cancellation/overflow facts alongside that exit code.
 * No parser, absence decision, or observation cache may treat such a result as an answer.
 */
export function processResultSucceeded(result) {
  return result?.status === 0
    && result.error == null
    && result.signal == null
    && result.timedOut !== true
    && result.aborted !== true
    && result.outputOverflow !== true
    && result.blocked !== true;
}

/** A non-zero command result is complete only when no execution boundary poisoned the exit. */
export function processResultCompleted(result) {
  return Number.isInteger(result?.status)
    && result.error == null
    && result.signal == null
    && result.timedOut !== true
    && result.aborted !== true
    && result.outputOverflow !== true
    && result.blocked !== true;
}
