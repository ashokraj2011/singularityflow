/**
 * Small scheduling primitives for extension-host hot paths.
 *
 * They deliberately have no VS Code dependency, which keeps the concurrency contract directly
 * testable without loading an extension host. Neither primitive caches authority: they only avoid
 * repeating work that was requested again before the current JavaScript turn or operation ended.
 */

/** Run immediately on demand, but collapse every synchronous request into one microtask. */
export class MicrotaskCoalescer {
  private pending = false;
  private token = 0;
  private disposed = false;
  private readonly action: () => void;

  constructor(action: () => void) { this.action = action; }

  request(): void {
    if (this.disposed || this.pending) return;
    this.pending = true;
    const token = ++this.token;
    queueMicrotask(() => {
      if (this.disposed || !this.pending || token !== this.token) return;
      this.pending = false;
      this.action();
    });
  }

  /** Paint now, invalidating a previously queued paint. */
  flush(): void {
    if (this.disposed) return;
    this.pending = false;
    this.token += 1;
    this.action();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    this.token += 1;
  }
}

/**
 * Keep one operation in flight and, when requests arrive during it, run exactly one trailing
 * operation for their latest state.
 *
 * Every caller waits for the same final value. An intermediate value is never returned after a
 * newer request exists, which is the property configuration diagnostics need: an older validation
 * cannot overwrite the answer for bytes saved while it was running.
 */
export class LatestSingleFlight<T> {
  private requested = 0;
  private active: Promise<T> | null = null;
  private readonly operation: () => Promise<T>;

  constructor(operation: () => Promise<T>) { this.operation = operation; }

  request(): Promise<T> {
    this.requested += 1;
    if (!this.active) {
      const active = this.run().finally(() => {
        if (this.active === active) this.active = null;
      });
      this.active = active;
    }
    return this.active;
  }

  private async run(): Promise<T> {
    while (true) {
      const generation = this.requested;
      const value = await this.operation();
      if (generation === this.requested) return value;
    }
  }
}

/**
 * Gate snapshot-driven webview work for a retained panel.
 *
 * A retained panel keeps its DOM while hidden. Replacing that DOM for every repository refresh is
 * wasted extension-host and renderer work, and it also destroys the page state VS Code retained.
 * Loading notifications carry no new model, so they are ignored everywhere. Meaningful changes
 * received while hidden collapse into one render from the latest store state when revealed.
 */
export class RetainedPanelRenderGate {
  private pending = false;
  private disposed = false;
  private readonly isVisible: () => boolean;
  private readonly renderLatest: () => void;

  constructor(isVisible: () => boolean, renderLatest: () => void) {
    this.isVisible = isVisible;
    this.renderLatest = renderLatest;
  }

  changed(kind: string): void {
    if (this.disposed || kind === 'loading') return;
    if (!this.isVisible()) {
      this.pending = true;
      return;
    }
    this.renderLatest();
  }

  visibilityChanged(visible: boolean): void {
    if (this.disposed || !visible || !this.pending) return;
    this.pending = false;
    this.renderLatest();
  }

  /** A direct user-driven render already consumed the latest snapshot. */
  rendered(): void {
    if (!this.disposed) this.pending = false;
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
  }
}
