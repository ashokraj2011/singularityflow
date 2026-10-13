/** Coalesce edits before launching native Git work; no result or authorization is cached here. */
export class IntakePreflightScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delay: number;
  private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout };

  constructor(delay = 400, timers = { set: setTimeout, clear: clearTimeout }) {
    this.delay = delay;
    this.timers = timers;
  }

  schedule(action: () => void): void {
    this.cancel();
    this.timer = this.timers.set(() => {
      this.timer = null;
      action();
    }, this.delay);
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
