/**
 * One snapshot, shared by every view, refreshed deliberately.
 *
 * `snapshot --json` is a whole read model in one process launch — cheap enough to call on
 * demand, far too expensive for each view to call for itself. More importantly, views that each
 * fetched their own would render different moments of the same repository side by side, which for
 * governance state is not a cosmetic problem: a tree saying "approved" beside a panel saying
 * "awaiting approval" is worse than either being briefly stale.
 *
 * So there is exactly one in-flight refresh, everyone waits on it, and everyone is told when it
 * lands. A refresh requested while one is running supersedes it — the older answer is already known
 * to be out of date, and finishing it would only overwrite the newer one.
 */
import type { SingularityFlowClient } from './cli/client.ts';
import type { RepositorySnapshot } from './cli/snapshot.ts';

export type StateListener = (state: WorkspaceState) => void;

/**
 * A failure that describes a moment rather than a fault.
 *
 * The engine refuses a snapshot whose repository moved while it was being assembled. That is the
 * right answer for a governed write and the wrong one to leave on screen, because the condition has
 * usually passed by the time anyone reads the message. Trying again is all it ever needed.
 *
 * Matched on text because it arrives as a CLI message, and matched narrowly on purpose: a broken
 * lifecycle definition is a real fault, and retrying it four times would only delay the error the
 * person needs in order to repair it.
 */
const TRANSIENT_FAILURE = /Repository state changed while the snapshot was being assembled/i;

/**
 * Backoff for those retries: quick enough to be invisible when one edit landed mid-read, spread
 * enough that a phase writing artifacts continuously gets a chance to finish a file. Bounded,
 * because a repository under permanent churn must still end at a visible error rather than a
 * sidebar that spins forever.
 */
const RETRY_DELAYS_MS = [400, 1_000, 2_500];

export interface WorkspaceState {
  snapshot: RepositorySnapshot | null;
  /** The error from the most recent failed refresh, cleared by the next success. */
  error: Error | null;
  loading: boolean;
  /**
   * This snapshot was restored from the last session and has not been confirmed against the
   * repository yet. Views may render it, but must say so: governance state that is quietly out of
   * date is worse than governance state that is visibly loading.
   */
  stale: boolean;
}

/**
 * Somewhere to keep the last snapshot between sessions.
 *
 * Injected rather than reached for, because this module deliberately does not import `vscode` — the
 * store is the piece worth testing without an extension host. The real implementation is backed by
 * `workspaceState` and keyed by repository root.
 */
export interface SnapshotCache {
  read(): RepositorySnapshot | null;
  write(snapshot: RepositorySnapshot): void;
}

export class WorkspaceStore {
  private readonly client: SingularityFlowClient;
  private readonly cache: SnapshotCache | null;
  private readonly listeners = new Set<StateListener>();
  private state: WorkspaceState = { snapshot: null, error: null, loading: false, stale: false };
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(client: SingularityFlowClient, cache: SnapshotCache | null = null) {
    this.client = client;
    this.cache = cache;
  }

  /**
   * Publish the previous session's snapshot, so the sidebar opens with content instead of nothing.
   *
   * `snapshot --json` takes most of a second, and until it lands there was literally nothing to
   * render: every cold open showed an empty panel for the whole round trip, and nothing survived a
   * window reload. The last answer is almost always still true — a repository rarely changes while
   * VS Code is closed — so it is shown immediately and marked `stale` until the real one arrives.
   *
   * Separate from the constructor because publishing needs listeners, and the views subscribe after
   * the store exists.
   */
  primeFromCache(): boolean {
    if (this.state.snapshot || !this.cache) return false;
    const cached = this.cache.read();
    if (!cached) return false;
    this.publish({ snapshot: cached, error: null, stale: true });
    return true;
  }

  get current(): WorkspaceState { return this.state; }

  onDidChange(listener: StateListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private publish(next: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) {
      // One misbehaving view must not stop the others from being told.
      try { listener(this.state); } catch { /* ignored on purpose */ }
    }
  }

  /** Sleep, unless the refresh is superseded or the window goes away first. */
  private static wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
      function cancel(): void { clearTimeout(timer); resolve(); }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  /** Refresh, superseding any refresh already running. Never rejects: the error becomes state. */
  async refresh(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ loading: true });

    const run = (async () => {
      let failure: Error | null = null;
      // One attempt, plus a retry per backoff step. Only a transient failure consumes them; anything
      // else breaks out immediately and goes to the recovery path below.
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const snapshot = await this.client.snapshot(controller.signal);
          // A superseded refresh must not publish: its answer is older than the one now in flight.
          if (this.controller !== controller) return;
          this.publish({ snapshot, error: null, loading: false, stale: false });
          // Only a full, confirmed snapshot is worth restoring next session. The recovery path
          // below deliberately does not write: it is a configuration inventory produced *because*
          // the lifecycle failed to load, and priming a later session with it would open the
          // sidebar on a repair view of a repository that may be perfectly healthy.
          try { this.cache?.write(snapshot); } catch { /* A cache that cannot be written is not a failure. */ }
          return;
        } catch (error) {
          if (this.controller !== controller) return;
          failure = error instanceof Error ? error : new Error(String(error));
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !TRANSIENT_FAILURE.test(failure.message)) break;
          await WorkspaceStore.wait(delay, controller.signal);
          if (this.controller !== controller) return;
        }
      }

      // A broken lifecycle definition must block Lifecycle, but it must not hide the files needed
      // to repair it. Ask the engine for its validation-independent configuration inventory.
      try {
        const recovery = await this.client.configurationSnapshot(controller.signal);
        if (this.controller !== controller) return;
        this.publish({ snapshot: recovery, error: failure, loading: false, stale: false });
      } catch {
        if (this.controller !== controller) return;
        // The failure is what matters now, but a primed snapshot stays on screen behind it rather
        // than blanking the sidebar — it is still the last thing known to be true, and it is what
        // the reader needs in order to act on the error.
        this.publish({ error: failure, loading: false });
      }
    })();

    this.inFlight = run;
    await run;
    if (this.inFlight === run) this.inFlight = null;
  }

  dispose(): void {
    this.controller?.abort();
    this.listeners.clear();
  }
}
