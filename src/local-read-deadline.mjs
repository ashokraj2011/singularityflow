/** Invocation-local elapsed read budget. This only tightens existing process ceilings. */
import { AsyncLocalStorage } from 'node:async_hooks';

const READ_DEADLINE = new AsyncLocalStorage();
const MAXIMUM_READ_MS = 120_000;

function expired() {
  return Object.assign(new Error('The shared local read duration was exhausted; no partial result is available.'), {
    name: 'SingularityFlowError', code: 'LOCAL_READ_DEADLINE_EXCEEDED', exitCode: 1
  });
}

export function localReadDeadlineRemainingMs() {
  const scope = READ_DEADLINE.getStore();
  return scope ? Math.max(0, Math.ceil(scope.deadlineAt - performance.now())) : null;
}

export function assertLocalReadDeadline() {
  if (localReadDeadlineRemainingMs() === 0) throw expired();
}

export function localReadDeadlineAt() { return READ_DEADLINE.getStore()?.deadlineAt ?? null; }

/** One clock capture: zero is refusal, never an executor's 'unbounded/default' sentinel. */
export function localReadDeadlineTimeoutMs(ceiling) {
  const remaining = localReadDeadlineRemainingMs();
  if (remaining === null) return ceiling;
  if (remaining === 0) throw expired();
  return Math.min(ceiling, remaining);
}

export function localReadDeadlineSignal() { return READ_DEADLINE.getStore()?.controller.signal ?? null; }

/** No JSON override or injectable clock: nested scopes can only shorten their parent's budget. */
export async function withLocalReadDeadline(durationMs, callback) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAXIMUM_READ_MS
      || typeof callback !== 'function') throw new TypeError('A bounded local read duration and callback are required.');
  const parent = READ_DEADLINE.getStore();
  const deadlineAt = Math.min(parent?.deadlineAt ?? Infinity, performance.now() + durationMs);
  const controller = new AbortController();
  const onAbort = () => controller.abort('shared-local-read-deadline');
  parent?.controller.signal.addEventListener('abort', onAbort, { once: true });
  if (parent?.controller.signal.aborted) onAbort();
  const timer = setTimeout(onAbort, Math.max(1, Math.ceil(deadlineAt - performance.now())));
  const scope = Object.freeze({ deadlineAt, controller });
  try {
    return await READ_DEADLINE.run(scope, async () => {
      assertLocalReadDeadline();
      const result = await callback();
      assertLocalReadDeadline();
      return result;
    });
  } finally {
    clearTimeout(timer);
    parent?.controller.signal.removeEventListener('abort', onAbort);
  }
}
