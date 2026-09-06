/**
 * In-memory measurements for the explicit real-extension-host benchmark.
 *
 * The probe is disabled unless the benchmark runner opts in. It never records command arguments,
 * repository paths, work IDs, output, identities, wall-clock timestamps, or file content. The
 * hidden control command is registered only in that opted-in extension host and disappears with
 * the process.
 */
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export type HostPerformanceMark =
  | 'repositoryResolved'
  | 'cachePublished'
  | 'firstSidebarRender'
  | 'cachedFirstPaint'
  | 'confirmedSnapshotPublished'
  | 'confirmedFirstPaint'
  | 'activationComplete';

export type HostRuntimeLoad = 'help' | 'panels' | 'support' | 'world-model';

export interface HostPerformanceSnapshot {
  readonly schemaVersion: 1;
  readonly kind: 'sflow-vscode-extension-host-performance';
  readonly enabled: boolean;
  readonly elapsedMs: number;
  readonly marksMs: Readonly<Partial<Record<HostPerformanceMark, number>>>;
  readonly runtimeLoadsMs: Readonly<Partial<Record<HostRuntimeLoad, number>>>;
  readonly counters: {
    readonly cliProcessesStarted: number;
    readonly cliProcessesCompleted: number;
    readonly cliProcessesSucceeded: number;
    readonly cliProcessesFailed: number;
    readonly cliProcessesConcurrent: number;
    readonly cliProcessesMaximumConcurrent: number;
    readonly backgroundTasksStarted: number;
    readonly backgroundTasksCompleted: number;
    readonly backgroundTasksConcurrent: number;
    readonly backgroundTasksMaximumConcurrent: number;
    readonly storeEvents: number;
    readonly snapshotEvents: number;
    readonly sidebarRenders: number;
  };
  readonly childMemory: {
    readonly status: 'measured-linux-proc' | 'unavailable-on-platform';
    readonly peakRssBytes: number | null;
  };
  readonly runtime: {
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
    readonly logicalCpus: number;
    readonly extensionHostRssBytes: number;
  };
}

const enabled = process.env.SINGULARITY_FLOW_VSCODE_HOST_BENCHMARK === '1';
let startedAt = performance.now();
let marks: Partial<Record<HostPerformanceMark, number>> = {};
let runtimeLoadsMs: Partial<Record<HostRuntimeLoad, number>> = {};
let counters = {
  cliProcessesStarted: 0,
  cliProcessesCompleted: 0,
  cliProcessesSucceeded: 0,
  cliProcessesFailed: 0,
  cliProcessesConcurrent: 0,
  cliProcessesMaximumConcurrent: 0,
  backgroundTasksStarted: 0,
  backgroundTasksCompleted: 0,
  backgroundTasksConcurrent: 0,
  backgroundTasksMaximumConcurrent: 0,
  storeEvents: 0,
  snapshotEvents: 0,
  sidebarRenders: 0
};
const activeChildPids = new Set<number>();
let childRssTimer: ReturnType<typeof setInterval> | null = null;
let peakChildRssBytes = 0;

function sampleChildRss(): void {
  if (process.platform !== 'linux') return;
  let total = 0;
  for (const pid of activeChildPids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const kib = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1] ?? 0);
      if (Number.isFinite(kib)) total += kib * 1024;
    } catch { /* A short-lived child can exit between the PID snapshot and the read. */ }
  }
  peakChildRssBytes = Math.max(peakChildRssBytes, total);
}

function updateChildSampler(): void {
  if (!enabled || process.platform !== 'linux') return;
  if (activeChildPids.size && !childRssTimer) {
    sampleChildRss();
    childRssTimer = setInterval(sampleChildRss, 10);
    childRssTimer.unref?.();
  } else if (!activeChildPids.size && childRssTimer) {
    sampleChildRss();
    clearInterval(childRssTimer);
    childRssTimer = null;
  }
}

export function beginHostPerformanceActivation(): boolean {
  if (!enabled) return false;
  startedAt = performance.now();
  marks = {};
  runtimeLoadsMs = {};
  counters = {
    cliProcessesStarted: 0,
    cliProcessesCompleted: 0,
    cliProcessesSucceeded: 0,
    cliProcessesFailed: 0,
    cliProcessesConcurrent: 0,
    cliProcessesMaximumConcurrent: 0,
    backgroundTasksStarted: 0,
    backgroundTasksCompleted: 0,
    backgroundTasksConcurrent: 0,
    backgroundTasksMaximumConcurrent: 0,
    storeEvents: 0,
    snapshotEvents: 0,
    sidebarRenders: 0
  };
  peakChildRssBytes = 0;
  return true;
}

export function markHostPerformance(mark: HostPerformanceMark): void {
  if (!enabled || marks[mark] !== undefined) return;
  marks[mark] = performance.now() - startedAt;
}

/** Record only the stable runtime category and elapsed load time, never a module or machine path. */
export function recordHostRuntimeLoad(runtime: HostRuntimeLoad, durationMs: number): void {
  if (!enabled || runtimeLoadsMs[runtime] !== undefined || !Number.isFinite(durationMs)) return;
  runtimeLoadsMs[runtime] = Math.max(0, durationMs);
}

export function recordHostCliProcessStarted(pid?: number): void {
  if (!enabled) return;
  counters.cliProcessesStarted += 1;
  counters.cliProcessesConcurrent += 1;
  counters.cliProcessesMaximumConcurrent = Math.max(
    counters.cliProcessesMaximumConcurrent,
    counters.cliProcessesConcurrent
  );
  if (pid && Number.isSafeInteger(pid) && pid > 0) activeChildPids.add(pid);
  updateChildSampler();
}

export function recordHostCliProcessCompleted(pid?: number, exitCode: number | null = null): void {
  if (!enabled) return;
  counters.cliProcessesCompleted += 1;
  if (exitCode === 0) counters.cliProcessesSucceeded += 1;
  else counters.cliProcessesFailed += 1;
  counters.cliProcessesConcurrent = Math.max(0, counters.cliProcessesConcurrent - 1);
  if (pid) activeChildPids.delete(pid);
  updateChildSampler();
}

/** Include persistent, non-CLI helpers in the same child-RSS envelope without mislabelling them. */
export function recordHostBackgroundProcessStarted(pid?: number): void {
  if (!enabled || !pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  activeChildPids.add(pid);
  updateChildSampler();
}

export function recordHostBackgroundProcessCompleted(pid?: number): void {
  if (!enabled || !pid) return;
  activeChildPids.delete(pid);
  updateChildSampler();
}

/** Include fire-and-forget SFlow reads in real-host quiescence and interval attribution. */
export async function trackHostBackgroundTask<T>(task: Promise<T>): Promise<T> {
  if (!enabled) return task;
  counters.backgroundTasksStarted += 1;
  counters.backgroundTasksConcurrent += 1;
  counters.backgroundTasksMaximumConcurrent = Math.max(
    counters.backgroundTasksMaximumConcurrent, counters.backgroundTasksConcurrent
  );
  try {
    return await task;
  } finally {
    counters.backgroundTasksCompleted += 1;
    counters.backgroundTasksConcurrent = Math.max(0, counters.backgroundTasksConcurrent - 1);
  }
}

export function recordHostStoreEvent(kind: string): void {
  if (!enabled) return;
  counters.storeEvents += 1;
  if (kind === 'snapshot' || kind === 'cache') counters.snapshotEvents += 1;
}

export function recordHostSidebarRender(projection: 'initial' | 'loading' | 'cache' | 'confirmed'): void {
  if (!enabled) return;
  counters.sidebarRenders += 1;
  markHostPerformance('firstSidebarRender');
  if (projection === 'cache') markHostPerformance('cachedFirstPaint');
  if (projection === 'confirmed') markHostPerformance('confirmedFirstPaint');
}

/** Reset only interval counters; activation marks remain available to the runner. */
export function resetHostPerformanceInterval(): HostPerformanceSnapshot {
  const snapshot = hostPerformanceSnapshot();
  counters = {
    cliProcessesStarted: 0,
    cliProcessesCompleted: 0,
    cliProcessesSucceeded: 0,
    cliProcessesFailed: 0,
    cliProcessesConcurrent: counters.cliProcessesConcurrent,
    cliProcessesMaximumConcurrent: counters.cliProcessesConcurrent,
    backgroundTasksStarted: 0,
    backgroundTasksCompleted: 0,
    backgroundTasksConcurrent: counters.backgroundTasksConcurrent,
    backgroundTasksMaximumConcurrent: counters.backgroundTasksConcurrent,
    storeEvents: 0,
    snapshotEvents: 0,
    sidebarRenders: 0
  };
  peakChildRssBytes = 0;
  runtimeLoadsMs = {};
  return snapshot;
}

export function hostPerformanceSnapshot(): HostPerformanceSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'sflow-vscode-extension-host-performance',
    enabled,
    elapsedMs: performance.now() - startedAt,
    marksMs: Object.freeze({ ...marks }),
    runtimeLoadsMs: Object.freeze({ ...runtimeLoadsMs }),
    counters: Object.freeze({ ...counters }),
    childMemory: Object.freeze({
      status: process.platform === 'linux' ? 'measured-linux-proc' : 'unavailable-on-platform',
      peakRssBytes: process.platform === 'linux' ? peakChildRssBytes : null
    }),
    runtime: Object.freeze({
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      logicalCpus: os.availableParallelism(),
      extensionHostRssBytes: process.memoryUsage().rss
    })
  });
}
