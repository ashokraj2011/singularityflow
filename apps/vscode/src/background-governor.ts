/**
 * Optional background work waits while a person is waiting on the intake form. `[perf]`
 *
 * Opening Start Work used to compete with activation's Story discovery (three `session candidates`
 * processes, each a full fetch) and the product checks, on the same machine and the same remote.
 * None of that is needed to start a Story, so it waits for the form to close, for at most a bounded
 * time, and an explicit refresh never waits at all. This module has no VS Code import so it can be
 * tested without the extension host.
 *
 * There is deliberately no module-level instance: each lazily loaded bundle would get its own copy.
 * The extension owns the one governor and hands panels a function that takes a hold.
 */
export const MAX_BACKGROUND_DEFERRAL_MS = 120_000;

export interface BackgroundHold {
  release(): void;
}

export class BackgroundWorkGovernor {
  private readonly holds = new Set<symbol>();
  private readonly waiters = new Set<() => void>();

  /** Hold optional work until `release`. Holds nest; the last release lets waiters run. */
  hold(reason: string): BackgroundHold {
    const token = Symbol(reason);
    this.holds.add(token);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.holds.delete(token);
        if (!this.holds.size) for (const waiter of [...this.waiters]) waiter();
      }
    };
  }

  get held(): boolean { return this.holds.size > 0; }

  /** Resolves once nothing holds, the deferral cap passes, or the caller aborts. Never rejects. */
  waitUntilIdle({ signal, maxDeferralMs = MAX_BACKGROUND_DEFERRAL_MS }: {
    signal?: AbortSignal; maxDeferralMs?: number;
  } = {}): Promise<void> {
    if (!this.held || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, maxDeferralMs));
      signal?.addEventListener('abort', done, { once: true });
      this.waiters.add(done);
    });
  }
}
