/** Bounded kernel read scheduling. Running slots include cancellation and process cleanup. */
import { SingularityFlowError } from './util.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { AsyncResource } from 'node:async_hooks';

const cancelled = () => new SingularityFlowError('The read was cancelled.', { code: 'READ_CANCELLED' });

export function createReadScheduler({ concurrency = 4, perRepository = 2, maximumQueued = 64 } = {}) {
  if (![concurrency, perRepository, maximumQueued].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1024)) {
    throw new TypeError('Read scheduler limits must be bounded positive integers.');
  }
  const queued = [], activeByKey = new Map();
  let running = 0;
  const drain = () => {
    while (running < concurrency) {
      const eligible = queued.filter(ticket => (activeByKey.get(ticket.key) ?? 0) < perRepository);
      const selected = eligible.find(ticket => ticket.priority === 'interactive') ?? eligible[0];
      if (!selected) return;
      queued.splice(queued.indexOf(selected), 1);
      selected.signal?.removeEventListener('abort', selected.abort);
      if (selected.signal?.aborted) { selected.reject(cancelled()); selected.resource.emitDestroy(); continue; }
      running++; activeByKey.set(selected.key, (activeByKey.get(selected.key) ?? 0) + 1);
      // Do not release the slot merely because a signal fired; the owned executor must finish cleanup.
      // A shared drain may run in another request's AsyncLocalStorage context. Restore the
      // requester's operation/read/timing contexts before invoking any kernel read.
      Promise.resolve().then(() => selected.resource.runInAsyncScope(() => {
        incrementCommandCounter('reads.queue-wait-ms', Math.max(0, Math.round(performance.now() - selected.queuedAt)));
        return selected.read(selected.signal);
      })).then(selected.resolve, selected.reject).finally(() => {
        selected.resource.emitDestroy();
        running--;
        const active = activeByKey.get(selected.key) - 1;
        active ? activeByKey.set(selected.key, active) : activeByKey.delete(selected.key);
        drain();
      });
    }
  };
  return Object.freeze({
    run(key, read, { signal = null, priority = 'interactive' } = {}) {
      if (typeof key !== 'string' || !key || typeof read !== 'function' || !['interactive', 'background'].includes(priority)) {
        return Promise.reject(new TypeError('Supply a kernel-owned read and a repository scheduling key.'));
      }
      if (signal?.aborted) { incrementCommandCounter('reads.cancelled-before-start'); return Promise.reject(cancelled()); }
      if (queued.length >= maximumQueued) return Promise.reject(new SingularityFlowError(
        'The read queue is full. Retry after the active reads complete.', { code: 'READ_QUEUE_FULL' }));
      return new Promise((resolve, reject) => {
        const ticket = { key, read, resolve, reject, signal, priority, abort: null, queuedAt: performance.now(),
          resource: new AsyncResource('sflow-read') };
        ticket.abort = () => {
          const index = queued.indexOf(ticket);
          if (index < 0) return;
          queued.splice(index, 1); signal.removeEventListener('abort', ticket.abort);
          ticket.resource.runInAsyncScope(() => incrementCommandCounter('reads.cancelled-before-start'));
          ticket.resource.emitDestroy(); reject(cancelled());
        };
        signal?.addEventListener('abort', ticket.abort, { once: true });
        queued.push(ticket); queueMicrotask(drain);
      });
    },
    counts() { return Object.freeze({ running, queued: queued.length, repositories: activeByKey.size }); }
  });
}

export const gitReadScheduler = createReadScheduler();
