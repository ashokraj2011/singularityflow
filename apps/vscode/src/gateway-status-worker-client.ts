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
type Pending = { resolve(value: StatusChrome | null): void; timer: ReturnType<typeof setTimeout> };

export class GatewayStatusWorker {
  private worker: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private disposed = false;

  constructor(private readonly extensionPath: string) {}

  read(route: GatewayRepositoryContext, workId: string | null, lens: string): Promise<StatusChrome | null> {
    if (this.disposed) return Promise.resolve(null);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
        // A wedged read cannot safely share its process with the next repository/status request.
        if (this.worker === worker) {
          this.worker = null;
          this.finishPending();
          worker.kill();
        }
      }, STATUS_READ_TIMEOUT_MS);
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
    if (worker) worker.kill();
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
    worker.on('error', () => {
      recordHostBackgroundProcessCompleted(worker.pid);
      this.workerFailed(worker);
    });
    worker.on('exit', () => {
      recordHostBackgroundProcessCompleted(worker.pid);
      this.workerFailed(worker);
    });
    this.worker = worker;
    return worker;
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
