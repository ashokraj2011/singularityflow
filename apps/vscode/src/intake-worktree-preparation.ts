/** One speculative checkout per panel; native Git work is settled, never killed mid-checkout. */
type Preparation = { status: string; workId?: string; baseCommit?: string; owned?: boolean };
type Run = (args: string[]) => Promise<{ preparation?: Preparation }>;
type Held = { key: string; workId: string; baseCommit: string; owned: boolean };

export class IntakeWorktreePreparation {
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private held: Held | null = null;
  private readonly run: Run;
  constructor(run: Run) { this.run = run; }

  schedule(key: string, args: string[], remote?: string): void {
    const workId = args[1], rest = args.slice(2);
    if (!workId) { this.cancel(); return; }
    const generation = ++this.generation;
    this.pending = this.pending.then(async () => {
      await this.cleanup();
      if (generation !== this.generation) return;
      try {
        const value = (await this.run(['story', 'prepare-worktree', '--work-id', workId,
          ...rest, ...(remote ? ['--remote', remote] : [])])).preparation;
        if (value?.status === 'prepared' && typeof value.workId === 'string'
            && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseCommit ?? '')) {
          this.held = { key, workId: value.workId, baseCommit: value.baseCommit!, owned: value.owned === true };
        }
      } catch { /* Acceleration cannot disable Start. */ }
      if (generation !== this.generation) await this.cleanup();
    });
  }

  cancel(): void {
    ++this.generation;
    this.pending = this.pending.then(() => this.cleanup());
  }

  async take(key: string): Promise<Held | null> {
    await this.pending;
    if (this.held?.key !== key) { this.cancel(); return null; }
    const held = this.held;
    this.held = null;
    ++this.generation;
    return held;
  }

  private async cleanup(): Promise<void> {
    const held = this.held;
    this.held = null;
    if (!held?.owned) return;
    try {
      await this.run(['story', 'discard-worktree', '--work-id', held.workId, '--prepared-base', held.baseCommit, '--json']);
    } catch { /* Native code preserves dirty, changed, published or otherwise unverified work. */ }
  }
}
