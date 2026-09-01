/**
 * Exact watcher-echo suppression for explicit extension mutations.
 *
 * A debounce alone cannot tell the extension's own write from another terminal's write. This
 * fence only consumes events already observed before an explicit refresh and only when that
 * refresh proves, through the coordinator's per-slice hashes, that it incorporated those events.
 * An event observed later, an unknown revision, or a mismatched slice is returned to the normal
 * watcher refresh path.
 */
import path from 'node:path';
import type { RepositorySnapshot, SnapshotSlice } from './cli/snapshot.ts';
import { changedSnapshotSlices } from './state.ts';

export type GovernedWatcherEvent = Readonly<{
  sequence: number;
  relativePath: string | null;
  candidateSlices: readonly SnapshotSlice[];
}>;

export type GovernedWatcherBatch = Readonly<{
  throughSequence: number;
  events: readonly GovernedWatcherEvent[];
}>;

const EMPTY_BATCH: GovernedWatcherBatch = Object.freeze({
  throughSequence: 0,
  events: Object.freeze([])
});

/** The slices a governed path can affect; repository is the safe content-aware fallback. */
export function governedPathCandidateSlices(
  repositoryRoot: string,
  changedPath: string | null | undefined
): readonly SnapshotSlice[] {
  if (!changedPath) return Object.freeze(['repository']);
  const relative = path.relative(path.resolve(repositoryRoot), path.resolve(changedPath)).replaceAll('\\', '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return Object.freeze(['repository']);
  }
  if (/^singularity\/(work-items|initiatives)\//.test(relative)) {
    return Object.freeze(['lifecycle', 'repository']);
  }
  if (relative === 'singularity/capabilities.yml') {
    return Object.freeze(['capabilities', 'repository']);
  }
  if (/^singularity\/(integrations|telemetry|ledger)(?:\/|\.|$)/.test(relative)) {
    return Object.freeze(['integrations', 'repository']);
  }
  if (/^singularity\/(workflow\.yml|portfolio\.yml|modelTiers\.yml|impact\.yml|templates\/|prompts\/|agents\/|skills\/)/.test(relative)) {
    return Object.freeze(['configuration', 'repository']);
  }
  return Object.freeze(['repository']);
}

export class RevisionSliceWatcherFence {
  private sequence = 0;
  private pending: GovernedWatcherEvent[] = [];
  private readonly repositoryRoot: () => string;
  private delayed: {
    revision: NonNullable<RepositorySnapshot['revision']>;
    changedSlices: ReadonlySet<SnapshotSlice>;
  } | null = null;

  constructor(repositoryRoot: () => string) { this.repositoryRoot = repositoryRoot; }

  observe(changedPath?: string | null): GovernedWatcherEvent {
    const root = this.repositoryRoot();
    const relative = changedPath
      ? path.relative(path.resolve(root), path.resolve(changedPath)).replaceAll('\\', '/')
      : null;
    const event = Object.freeze({
      sequence: ++this.sequence,
      relativePath: relative,
      candidateSlices: governedPathCandidateSlices(root, changedPath)
    });
    this.pending.push(event);
    return event;
  }

  get hasPending(): boolean { return this.pending.length > 0; }

  /** Repository selection is an authority boundary; an event from A cannot refresh or fence B. */
  reset(): void { this.pending = []; this.delayed = null; }

  clearDelayedEcho(): void { this.delayed = null; }

  /** Remove only events already delivered. Events arriving during the refresh form a later batch. */
  capture(): GovernedWatcherBatch {
    if (!this.pending.length) return EMPTY_BATCH;
    const events = Object.freeze(this.pending.splice(0));
    return Object.freeze({ throughSequence: events.at(-1)?.sequence ?? 0, events });
  }

  /** Put an unproven batch back ahead of newer events so the normal debounce refresh consumes it. */
  restore(batch: GovernedWatcherBatch): void {
    if (!batch.events.length) return;
    const known = new Set(this.pending.map((entry) => entry.sequence));
    this.pending = [
      ...batch.events.filter((entry) => !known.has(entry.sequence)),
      ...this.pending
    ].sort((left, right) => left.sequence - right.sequence);
  }

  /** Consume the batch only when exact post-refresh slice hashes prove it was incorporated. */
  matchesExplicitRefresh(
    batch: GovernedWatcherBatch,
    before: RepositorySnapshot | null,
    after: RepositorySnapshot | null
  ): boolean {
    if (!batch.events.length || !before || !after) return false;
    const beforeSubject = before.revision?.subjectRevision;
    const afterSubject = after.revision?.subjectRevision;
    if (!beforeSubject || !afterSubject || beforeSubject === afterSubject) return false;
    const changed = new Set(changedSnapshotSlices(before, after));
    if (!changed.size) return false;
    return batch.events.every((event) => {
      // Candidate order is significant: use the path's domain slice whenever that slice was loaded;
      // repository is only the compatibility fallback for a core-only snapshot. Otherwise any Git
      // movement could falsely hide a configuration event whose configuration bytes were not read.
      const authoritativeSlice = event.candidateSlices.find((slice) =>
        typeof before.revision?.slices?.[slice] === 'string'
        && typeof after.revision?.slices?.[slice] === 'string');
      if (!authoritativeSlice || !changed.has(authoritativeSlice)) return false;
      return before.revision?.slices?.[authoritativeSlice]
        !== after.revision?.slices?.[authoritativeSlice];
    });
  }

  /**
   * Run one explicit refresh and reconcile only the watcher events that preceded it.
   *
   * The caller owns its debounce timer. A false result means the captured events were restored and
   * must take the ordinary watcher path; events observed while `refresh` ran are never candidates
   * for suppression and remain pending independently.
   */
  async reconcileExplicitRefresh(
    current: () => RepositorySnapshot | null,
    refresh: () => Promise<void>
  ): Promise<{ suppressedWatcherEcho: boolean; changedSlices: readonly SnapshotSlice[] }> {
    const before = current();
    const batch = this.capture();
    await refresh();
    const after = current();
    const changedSlices = changedSnapshotSlices(before, after);
    const suppressedWatcherEcho = this.matchesExplicitRefresh(batch, before, after);
    if (!suppressedWatcherEcho) this.restore(batch);
    const revision = after?.revision;
    if (before && revision?.subjectRevision && revision.worktreeHash
      && before.revision?.subjectRevision !== revision.subjectRevision && changedSlices.length) {
      this.delayed = { revision: structuredClone(revision), changedSlices: new Set(changedSlices) };
    } else {
      this.delayed = null;
    }
    return { suppressedWatcherEcho, changedSlices };
  }

  /**
   * Prove that a watcher batch delivered after the explicit refresh is only its delayed echo.
   *
   * Slice matching is necessary but insufficient: another terminal can change the same Story file.
   * The repository-only probe must also reproduce the exact branch, HEAD, and content-aware
   * worktree hash captured by the completed refresh. Any unavailable or different fact fails open
   * to a normal full refresh.
   */
  async matchesDelayedEcho(
    batch: GovernedWatcherBatch,
    probe: () => Promise<RepositorySnapshot['revision'] | null>
  ): Promise<boolean> {
    const expected = this.delayed;
    if (!expected || !batch.events.length) return false;
    const expectedSlices = expected.revision.slices ?? {};
    const sliceMatches = batch.events.every((event) => {
      const authoritativeSlice = event.candidateSlices.find((slice) =>
        typeof expectedSlices[slice] === 'string');
      return authoritativeSlice !== undefined && expected.changedSlices.has(authoritativeSlice);
    });
    if (!sliceMatches) return false;
    let actual: RepositorySnapshot['revision'] | null;
    try { actual = await probe(); } catch { return false; }
    const exact = actual?.branch === expected.revision.branch
      && actual?.head === expected.revision.head
      && typeof actual?.worktreeHash === 'string'
      && actual.worktreeHash === expected.revision.worktreeHash;
    if (!exact) this.delayed = null;
    return exact;
  }
}
