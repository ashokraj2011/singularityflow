/** A bounded client for the inert status-bar gateway worker. */
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';

import type { GatewayRepositoryContext } from './gateway-session.ts';
import {
  recordHostBackgroundProcessCompleted, recordHostBackgroundProcessStarted
} from './host-performance.ts';

export type StatusChrome = {
  readonly gates: {
    readonly total: number;
    readonly met: number;
    readonly unmet: number;
    readonly outstanding: number;
  } | null;
  readonly recoveryWorkId: string | null;
  readonly decisions: number;
  readonly leads: string | null;
};

const STATUS_READ_TIMEOUT_MS = 30_000;
// A stopped worker gets this long to release what it holds. A signal listener in the shared kernel can hold SIGTERM back.
const STOP_GRACE_MS = 2_000;
// Asking again at once only adds another process to the load that wedged the last read.
const WEDGED_BACKOFF_MS = 60_000;
export type StatusWorkerTiming = { readonly readTimeoutMs: number; readonly stopGraceMs: number; readonly wedgedBackoffMs: number };
type Pending = { resolve(value: StatusChrome | null): void; timer: ReturnType<typeof setTimeout> };

/** One window keeps at most one worker: a new one starts only once the last has really gone. */
export class GatewayStatusWorker {
  private worker: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly stopping = new Set<ChildProcess>();
  private notBefore = 0;
  private disposed = false;
  private readonly extensionPath: string;
  private readonly timing: StatusWorkerTiming;

  constructor(extensionPath: string, timing: StatusWorkerTiming = {
    readTimeoutMs: STATUS_READ_TIMEOUT_MS, stopGraceMs: STOP_GRACE_MS, wedgedBackoffMs: WEDGED_BACKOFF_MS
  }) {
    this.extensionPath = extensionPath;
    this.timing = timing;
  }

  read(route: GatewayRepositoryContext, workId: string | null, lens: string): Promise<StatusChrome | null> {
    if (this.disposed || this.stopping.size || Date.now() < this.notBefore) return Promise.resolve(null);
    let worker: ChildProcess;
    try { worker = this.ensureWorker(); } catch { return Promise.resolve(null); }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
        // A wedged read cannot safely share its process with the next repository/status request.
        if (this.worker === worker) {
          this.notBefore = Date.now() + this.timing.wedgedBackoffMs;
          this.retire(worker);
        }
      }, this.timing.readTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      try {
        worker.send({ id, route, workId, lens });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    this.finishPending();
    // The window is closing and no timer can be relied on to follow up.
    if (worker) worker.kill('SIGKILL');
    for (const stopping of this.stopping) stopping.kill('SIGKILL');
  }

  private ensureWorker(): ChildProcess {
    if (this.worker) return this.worker;
    const worker = fork(path.join(this.extensionPath, 'dist', 'gateway-status-worker.cjs'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    // The helper follows the extension host; it must not keep an extension-test process or a
    // closing VS Code window alive after every visible SFlow surface has quiesced.
    worker.unref();
    worker.channel?.unref?.();
    recordHostBackgroundProcessStarted(worker.pid);
    worker.on('message', (message: { id?: number; value?: StatusChrome | null }) => {
      if (!Number.isSafeInteger(message?.id)) return;
      const pending = this.pending.get(message.id!);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id!);
      pending.resolve(message.value ?? null);
    });
    // An error does not mean it has gone: a failed send leaves a live process nobody would stop.
    worker.on('error', () => {
      if (this.worker === worker) this.retire(worker);
    });
    worker.on('exit', () => {
      recordHostBackgroundProcessCompleted(worker.pid);
      this.stopping.delete(worker);
      this.workerFailed(worker);
    });
    this.worker = worker;
    return worker;
  }

  private retire(worker: ChildProcess): void {
    this.worker = null;
    this.finishPending();
    // A worker that never started has no process to wait for, and never exits.
    if (!worker.pid) return;
    this.stopping.add(worker);
    worker.kill();
    const timer = setTimeout(() => worker.kill('SIGKILL'), this.timing.stopGraceMs);
    timer.unref?.();
    worker.once('exit', () => clearTimeout(timer));
  }

  private workerFailed(worker: ChildProcess): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.finishPending();
  }

  private finishPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pending.clear();
  }
}
