/** Private, bounded read transport for an SFlow-owned VS Code host. No listening endpoint. */
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledReadWorkerUrl } from './bundled-cli.mjs';
import { READ_WORKER_FORMAT, READ_WORKER_MAX_QUEUE, READ_WORKER_MAX_REPLY_BYTES,
  readWorkerBuildFingerprint, warmReadRequest } from './read-worker-protocol.mjs';

const workers = new Map();
const MAX_WORKERS = 2, MAX_REQUESTS = 64, MAX_AGE_MS = 300_000, IDLE_MS = 60_000;
const cancelled = signal => signal?.reason ?? new Error('The Singularity Flow read was cancelled.');

function stop(worker) {
  if (worker.closed) return;
  worker.closed = true;
  clearTimeout(worker.idle);
  clearTimeout(worker.startTimer);
  if (workers.get(worker.key) === worker) workers.delete(worker.key);
  worker.readyResolve(false);
  for (const request of worker.pending.values()) request.finish(null);
  worker.pending.clear();
  try { worker.child.kill(); } catch { /* Already closed. */ }
}

/** Invalidate code/session reuse, not a mutation receipt. A following read starts fresh. */
export function invalidateReadWorkers(repository) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const selected = normalize(path.resolve(repository));
  let canonical = selected;
  try { canonical = normalize(realpathSync.native(repository)); } catch { /* May already be removed. */ }
  for (const worker of workers.values()) {
    if (normalize(worker.selected) === selected || normalize(worker.repository) === canonical) stop(worker);
  }
}

export function disposeReadWorkers() {
  for (const worker of [...workers.values()]) stop(worker);
}

function idle(worker) {
  clearTimeout(worker.idle);
  if (worker.pending.size || worker.closed) return;
  worker.child.unref();
  worker.child.channel?.unref();
  worker.idle = setTimeout(() => stop(worker), IDLE_MS);
  worker.idle.unref?.();
}

function open({ key, repository, selected, executable, env, build, entry, onWorkerStarted, onWorkerExited }) {
  let child;
  try {
    // Fixed owned script, native argv and parent-private IPC. Never a shell or user-supplied handler.
    child = fork(entry, [], { execPath: executable, execArgv: [], cwd: repository,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  } catch { return null; }
  try { onWorkerStarted?.(child.pid); } catch { /* Diagnostic only. */ }
  const worker = { key, repository, selected, child, build: build.fingerprint,
    nonce: randomBytes(16).toString('hex'), pending: new Map(), nextId: 0,
    startedAt: Date.now(), closed: false, readyResolve: null, ready: null,
    startTimer: null, idle: null };
  worker.ready = new Promise(resolve => { worker.readyResolve = resolve; });
  worker.startTimer = setTimeout(() => stop(worker), 5_000);
  workers.set(key, worker);
  child.on('message', message => {
    if (worker.closed) return;
    if (!message || message.format !== READ_WORKER_FORMAT || message.nonce !== worker.nonce
        || Buffer.byteLength(JSON.stringify(message)) > READ_WORKER_MAX_REPLY_BYTES) return stop(worker);
    if (message.type === 'ready' && message.build === worker.build && !worker.bound) {
      worker.bound = true;
      clearTimeout(worker.startTimer);
      worker.readyResolve(true);
      return idle(worker);
    }
    const request = worker.pending.get(message.id);
    if (!worker.bound || message.type !== 'result' || !request
        || !['value', 'unsupported', 'unavailable'].includes(message.result?.kind)) return stop(worker);
    request.finish(message.result.kind === 'value' ? message.result : null);
    idle(worker);
  });
  child.once('error', () => stop(worker));
  child.once('exit', () => { stop(worker); try { onWorkerExited?.(child.pid); } catch { /* Diagnostic only. */ } });
  child.once('disconnect', () => stop(worker));
  child.send({ type: 'bind', format: READ_WORKER_FORMAT, nonce: worker.nonce,
    repository, build: worker.build }, error => { if (error) stop(worker); });
  return worker;
}

/** Null means use the ordinary CLI once. Cancellation rejects, and must never trigger fallback. */
export async function readWithWorker({ executable, cli, repository: selected, args, env = process.env, signal,
  onWorkerStarted, onWorkerExited }) {
  const started = performance.now();
  if (signal?.aborted) throw cancelled(signal);
  if (env.SINGULARITY_FLOW_READ_WORKER === 'off' || !warmReadRequest(args) || !path.isAbsolute(executable)) return null;
  const build = await readWorkerBuildFingerprint(cli);
  if (!build) return null;
  let repository;
  try { repository = await realpath(selected); } catch { return null; }
  if (signal?.aborted) throw cancelled(signal);
  // Secret/permission/environment changes create a different scope. Values are never diagnostic output.
  const scope = createHash('sha256').update(JSON.stringify([repository, cli, executable, build.fingerprint,
    Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
  let worker = workers.get(scope);
  for (const prior of [...workers.values()]) {
    if (prior.repository === repository && prior.key !== scope) stop(prior);
  }
  if (worker && (Date.now() - worker.startedAt > MAX_AGE_MS || worker.nextId >= MAX_REQUESTS)) {
    if (worker.pending.size) return null;
    stop(worker); worker = null;
  }
  const reused = Boolean(worker);
  if (!worker) {
    if (workers.size >= MAX_WORKERS) {
      const candidate = [...workers.values()].find(value => !value.pending.size);
      if (!candidate) return null;
      stop(candidate);
    }
    const entry = bundledReadWorkerUrl(build.root, env)
      ?? new URL('./read-worker.mjs', import.meta.url).href;
    worker = open({ key: scope, repository, selected: path.resolve(selected), executable, env, build,
      entry: fileURLToPath(entry), onWorkerStarted, onWorkerExited });
    if (!worker) return null;
  }
  const current = worker;
  // Attach cancellation before awaiting worker startup, not after the five-second startup deadline.
  const onAbort = () => stop(current);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) { stop(current); throw cancelled(signal); }
    if (!await current.ready || current.closed) {
      if (signal?.aborted) throw cancelled(signal);
      return null;
    }
    if (current.pending.size >= READ_WORKER_MAX_QUEUE) return null;
    clearTimeout(current.idle);
    current.child.ref(); current.child.channel?.ref();
    const id = ++current.nextId;
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => stop(current), 90_000);
      current.pending.set(id, { finish: value => {
        clearTimeout(timer); current.pending.delete(id); resolve(value);
      } });
      current.child.send({ type: 'read', format: READ_WORKER_FORMAT, nonce: current.nonce, id, args },
        error => { if (error) stop(current); });
    });
    if (signal?.aborted) throw cancelled(signal);
    // An install can be replaced while the read is executing. Never deliver the old engine's answer.
    if ((await readWorkerBuildFingerprint(cli))?.fingerprint !== current.build) { stop(current); return null; }
    return result ? { ...result, transport: reused ? 'warm-worker' : 'worker-start',
      durationMs: Math.round(performance.now() - started) } : null;
  } finally { signal?.removeEventListener('abort', onAbort); }
}
