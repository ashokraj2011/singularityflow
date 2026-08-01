/**
 * One snapshot, shared by every view, refreshed deliberately.
 *
 * `desktop snapshot --json` is a whole read model in one process launch — cheap enough to call on
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
import type { DesktopSnapshot } from './cli/snapshot.ts';

export type StateListener = (state: WorkspaceState) => void;

export interface WorkspaceState {
  snapshot: DesktopSnapshot | null;
  /** The error from the most recent failed refresh, cleared by the next success. */
  error: Error | null;
  loading: boolean;
}

export class WorkspaceStore {
  private readonly client: SingularityFlowClient;
  private readonly listeners = new Set<StateListener>();
  private state: WorkspaceState = { snapshot: null, error: null, loading: false };
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(client: SingularityFlowClient) {
    this.client = client;
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

  /** Refresh, superseding any refresh already running. Never rejects: the error becomes state. */
  async refresh(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ loading: true });

    const run = (async () => {
      try {
        const snapshot = await this.client.snapshot(controller.signal);
        // A superseded refresh must not publish: its answer is older than the one now in flight.
        if (this.controller !== controller) return;
        this.publish({ snapshot, error: null, loading: false });
      } catch (error) {
        if (this.controller !== controller) return;
        this.publish({ error: error instanceof Error ? error : new Error(String(error)), loading: false });
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
