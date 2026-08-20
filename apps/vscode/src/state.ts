/**
 * One snapshot, shared by every view, refreshed deliberately.
 *
 * `snapshot --json` is a whole read model in one process launch — cheap enough to call on
 * demand, far too expensive for each view to call for itself. More importantly, views that each
 * fetched their own would render different moments of the same repository side by side, which for
 * governance state is not a cosmetic problem: a tree saying "approved" beside a panel saying
 * "awaiting approval" is worse than either being briefly stale.
 *
 * So there is exactly one in-flight refresh and everyone waits on it. A refresh requested while one
 * is running is coalesced into one follow-up; paid work is not aborted and an older answer is never
 * published over the newer request.
 */
import { CORE_SNAPSHOT_SLICES, type SingularityFlowClient } from './cli/client.ts';
import type { RepositorySnapshot, SnapshotSlice } from './cli/snapshot.ts';

export interface WorkspaceStateChange {
  kind: 'cache' | 'loading' | 'snapshot' | 'error';
  /** True only when model data changed, never for a loading indicator. */
  revisionChanged: boolean;
}

export type StateListener = (state: WorkspaceState, change: WorkspaceStateChange) => void;

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
  private refreshGeneration = 0;
  /** A newly requested slice must not be answered by a revision-only not-modified receipt. */
  private forceFullSnapshot = false;
  private readonly loadedSlices = new Set<SnapshotSlice>(CORE_SNAPSHOT_SLICES);
  private disposed = false;

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
    // Cached heavy data may paint immediately, but it must not make every future activation pay to
    // reload every panel the person happened to open in an earlier session. The live activation
    // refresh remains core-only; a heavy surface calls ensureSlices when it is opened again.
    this.publish({ snapshot: cached, error: null, stale: true }, { kind: 'cache', revisionChanged: true });
    return true;
  }

  get current(): WorkspaceState { return this.state; }

  onDidChange(listener: StateListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private publish(next: Partial<WorkspaceState>, change: WorkspaceStateChange): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) {
      // One misbehaving view must not stop the others from being told.
      try { listener(this.state, change); } catch { /* ignored on purpose */ }
    }
  }

  /** Load a heavyweight domain once its surface is actually requested. */
  async ensureSlices(slices: readonly SnapshotSlice[]): Promise<void> {
    let added = false;
    for (const slice of slices) {
      if (this.loadedSlices.has(slice)) continue;
      this.loadedSlices.add(slice);
      added = true;
    }
    if (added) this.forceFullSnapshot = true;
    if (added || !this.state.snapshot) await this.refresh();
  }

  /** Sleep, unless the refresh is superseded or the window goes away first. */
  private static wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
      function cancel(): void { clearTimeout(timer); resolve(); }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  private revisionChanged(next: RepositorySnapshot): boolean {
    const previous = this.state.snapshot?.revision?.subjectRevision ?? null;
    const current = next.revision?.subjectRevision ?? null;
    return previous === null || current === null || previous !== current;
  }

  /**
   * One refresh loop for every overlapping request.
   *
   * A request arriving mid-read increments the generation. The older result is discarded and the
   * loop performs exactly one follow-up against the settled repository; it is never aborted after
   * paying most of the snapshot cost, and callers awaiting either request wait for the latest one.
   */
  private async refreshLoop(controller: AbortController): Promise<void> {
    this.publish({ loading: true }, { kind: 'loading', revisionChanged: false });
    while (!controller.signal.aborted && !this.disposed) {
      const generation = this.refreshGeneration;
      let failure: Error | null = null;
      let snapshot: RepositorySnapshot | null = null;
      const retryStartedAt = Date.now();
      let scheduledBackoffMs = 0;

      // One attempt, plus a retry per backoff step. Only a transient failure consumes them; anything
      // else breaks out immediately and goes to the recovery path below.
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          snapshot = await this.client.snapshot(
            controller.signal,
            [...this.loadedSlices],
            this.forceFullSnapshot ? null : (this.state.snapshot?.revision?.subjectRevision ?? null)
          );
          break;
        } catch (error) {
          if (controller.signal.aborted || this.disposed) return;
          failure = error instanceof Error ? error : new Error(String(error));
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !TRANSIENT_FAILURE.test(failure.message)) break;
          // Anchor every delay to one retry-loop deadline. If a snapshot call or the host event
          // loop already consumed part of the budget, do not add the full delay again. The OS may
          // deschedule this process for longer than the budget, but this loop never compounds that
          // pause with another 3.9 seconds of waits after it resumes.
          scheduledBackoffMs += delay;
          const remaining = Math.max(0, retryStartedAt + scheduledBackoffMs - Date.now());
          await WorkspaceStore.wait(remaining, controller.signal);
        }
      }

      // A refresh request arrived while this generation was reading. Its result describes the old
      // request, so do not fan it out to every panel; take one follow-up snapshot instead.
      if (generation !== this.refreshGeneration) continue;

      if (snapshot) {
        if (snapshot.notModified && this.state.snapshot) {
          const confirmed = {
            ...this.state.snapshot,
            included: snapshot.included ?? this.state.snapshot.included,
            revision: snapshot.revision ?? this.state.snapshot.revision,
            notModified: false
          };
          this.publish({ snapshot: confirmed, error: null, loading: false, stale: false }, {
            kind: 'snapshot', revisionChanged: false
          });
          try { this.cache?.write(confirmed); } catch { /* A cache that cannot be written is not a failure. */ }
          return;
        }
        const changed = this.revisionChanged(snapshot);
        this.forceFullSnapshot = false;
        this.publish({ snapshot, error: null, loading: false, stale: false }, {
          kind: 'snapshot', revisionChanged: changed
        });
        try { this.cache?.write(snapshot); } catch { /* A cache that cannot be written is not a failure. */ }
        return;
      }

      // A broken lifecycle definition must block Lifecycle, but it must not hide the files needed
      // to repair it. Ask the engine for its validation-independent configuration inventory.
      try {
        const recovery = await this.client.configurationSnapshot(controller.signal);
        if (generation !== this.refreshGeneration) continue;
        this.publish({ snapshot: recovery, error: failure, loading: false, stale: false }, {
          kind: 'error', revisionChanged: true
        });
      } catch {
        if (generation !== this.refreshGeneration) continue;
        this.publish({ error: failure, loading: false }, { kind: 'error', revisionChanged: false });
      }
      return;
    }
  }

  /** Refresh, coalescing any refresh already running. Never rejects: the error becomes state. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    this.refreshGeneration += 1;
    if (!this.inFlight) {
      const controller = new AbortController();
      this.controller = controller;
      const active = this.refreshLoop(controller);
      this.inFlight = active.finally(() => {
        if (this.controller === controller) this.controller = null;
        this.inFlight = null;
      });
    }
    await this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.listeners.clear();
  }
}
