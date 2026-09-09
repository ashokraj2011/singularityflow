import { spawn } from 'node:child_process';
import path from 'node:path';

import { createRepoContext } from './repo-context.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { nonInteractiveGitEnvironment } from './git-execution.mjs';
import { signalProcessTree, SingularityFlowError } from './util.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TYPE = /^(blob|tree|commit|tag)$/;
const pools = new Map();

function error(message, code, details = {}) {
  return new SingularityFlowError(message, { code, details });
}

export class FosGitObjectService {
  #root;
  #spawn;
  #child = null;
  #buffer = Buffer.alloc(0);
  #queue = [];
  #active = null;
  #closed = false;
  #idleTimer = null;
  #maxQueued;
  #maxObjectBytes;
  #timeoutMs;
  #idleMs;
  #spawns = 0;

  constructor(root, {
    spawnCommand = spawn, maxQueued = 128, maxObjectBytes = 32 * 1024 * 1024,
    timeoutMs = 30_000, idleMs = 30_000
  } = {}) {
    this.#root = path.resolve(root);
    this.#spawn = spawnCommand;
    this.#maxQueued = maxQueued;
    this.#maxObjectBytes = maxObjectBytes;
    this.#timeoutMs = timeoutMs;
    this.#idleMs = idleMs;
  }

  get processSpawns() { return this.#spawns; }
  get queued() { return this.#queue.length + (this.#active ? 1 : 0); }
  get closed() { return this.#closed; }

  async read(oid, { signal } = {}) {
    if (!OID.test(oid ?? '')) throw error('Object service requires one full SHA-1 or SHA-256 object ID.', 'OBJECT_ID_INVALID');
    if (this.#closed) throw error('Git object service is closed.', 'OBJECT_SERVICE_CLOSED');
    if (this.queued >= this.#maxQueued) throw error('Git object service queue is full.', 'LIMIT_EXCEEDED');
    if (signal?.aborted) throw error('Git object request was cancelled.', 'OBJECT_REQUEST_CANCELLED');
    incrementCommandCounter('git.requests');
    incrementCommandCounter('git.batch-requests');
    this.#ensureChild();
    return new Promise((resolve, reject) => {
      const request = { oid, resolve, reject, signal, abort: null, timer: null, size: null, objectOid: null, type: null };
      request.abort = () => {
        if (this.#active === request) {
          this.#failService(error('Git object request was cancelled.', 'OBJECT_REQUEST_CANCELLED'));
        } else {
          const index = this.#queue.indexOf(request);
          if (index >= 0) this.#queue.splice(index, 1);
          this.#finishRequest(request, 'reject', error('Git object request was cancelled.', 'OBJECT_REQUEST_CANCELLED'));
        }
      };
      signal?.addEventListener('abort', request.abort, { once: true });
      this.#queue.push(request);
      this.#pump();
    });
  }

  #ensureChild() {
    if (this.#child) return;
    const child = this.#spawn('git', ['cat-file', '--batch'], {
      cwd: this.#root,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...nonInteractiveGitEnvironment(process.env), GIT_NO_LAZY_FETCH: '1' }
    });
    this.#child = child;
    this.#spawns += 1;
    incrementCommandCounter('git.spawns');
    // Unlike one-shot Git processes, this child serves many logical object requests. Keep the
    // distinct counter meaningful so timing evidence can prove whether pooling is actually reusing
    // a process instead of permanently reporting a structural zero.
    incrementCommandCounter('git.child-spawns');
    child.stdout.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length > this.#maxObjectBytes + 8192) {
        this.#failService(error('Git object service output exceeded its bounded buffer.', 'LIMIT_EXCEEDED'));
        return;
      }
      this.#parse();
    });
    child.once('error', () => this.#failService(error('Git object service could not start.', 'OBJECT_SERVICE_UNAVAILABLE')));
    child.once('close', (code) => {
      if (this.#child !== child) return;
      this.#child = null;
      if (!this.#closed && (this.#active || this.#queue.length)) {
        this.#failService(error(`Git object service exited before completing its request (${code ?? 'unknown'}).`, 'OBJECT_SERVICE_UNAVAILABLE'));
      }
    });
  }

  #pump() {
    if (this.#active || !this.#queue.length || this.#closed) {
      if (!this.#active && !this.#queue.length) this.#armIdle();
      return;
    }
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    const request = this.#queue.shift();
    this.#active = request;
    request.timer = setTimeout(() => {
      this.#failService(error('Git object request exceeded its operation deadline.', 'OBJECT_REQUEST_TIMEOUT'));
    }, this.#timeoutMs);
    try {
      this.#child.stdin.write(`${request.oid}\n`, 'ascii');
    } catch {
      this.#failService(error('Git object service input stream is unavailable.', 'OBJECT_SERVICE_UNAVAILABLE'));
    }
  }

  #parse() {
    const request = this.#active;
    if (!request) return;
    if (request.size == null) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) return;
      const header = this.#buffer.subarray(0, newline).toString('ascii');
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (header === `${request.oid} missing`) {
        this.#active = null;
        this.#finishRequest(request, 'resolve', null);
        this.#pump();
        return;
      }
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-z]+) (\d+)$/.exec(header);
      const size = Number(match?.[3]);
      if (!match || !OID.test(match[1]) || !TYPE.test(match[2]) || !Number.isSafeInteger(size) || size < 0) {
        this.#failService(error('Git object service returned a malformed protocol header.', 'OBJECT_PROTOCOL_INVALID'));
        return;
      }
      if (match[1] !== request.oid) {
        this.#failService(error(
          'Git object service returned a different object than the exact object requested.',
          'OBJECT_PROTOCOL_INVALID', { expectedOid: request.oid, actualOid: match[1] }
        ));
        return;
      }
      if (size > this.#maxObjectBytes) {
        this.#failService(error('Git object exceeds the configured object-service limit.', 'LIMIT_EXCEEDED', { size }));
        return;
      }
      request.objectOid = match[1]; request.type = match[2]; request.size = size;
    }
    if (this.#buffer.length < request.size + 1) return;
    if (this.#buffer[request.size] !== 0x0a) {
      this.#failService(error('Git object service returned malformed object framing.', 'OBJECT_PROTOCOL_INVALID'));
      return;
    }
    const bytes = Buffer.from(this.#buffer.subarray(0, request.size));
    this.#buffer = this.#buffer.subarray(request.size + 1);
    this.#active = null;
    this.#finishRequest(request, 'resolve', Object.freeze({ oid: request.objectOid, type: request.type, bytes }));
    this.#pump();
    if (this.#buffer.length && !this.#active) {
      this.#failService(error('Git object service returned unrequested bytes.', 'OBJECT_PROTOCOL_INVALID'));
    }
  }

  #finishRequest(request, method, value) {
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    request[method](value);
  }

  #armIdle() {
    if (this.#idleTimer || !this.#child) return;
    this.#idleTimer = setTimeout(() => this.close(), this.#idleMs);
    this.#idleTimer.unref?.();
  }

  async #failService(reason) {
    const requests = [this.#active, ...this.#queue].filter(Boolean);
    this.#active = null; this.#queue = []; this.#buffer = Buffer.alloc(0);
    const child = this.#child; this.#child = null;
    if (child) await signalProcessTree(child, 'SIGKILL').catch(() => {});
    for (const request of requests) this.#finishRequest(request, 'reject', reason);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#idleTimer);
    await this.#failService(error('Git object service was closed.', 'OBJECT_SERVICE_CLOSED'));
  }
}

export async function fosGitObjectService(root, options = {}) {
  const identity = await createRepoContext(root).identity();
  const key = identity.commonDir;
  const current = pools.get(key);
  if (current && !current.closed) return current;
  const service = new FosGitObjectService(root, options);
  pools.set(key, service);
  return service;
}

export async function closeFosGitObjectServices() {
  const services = [...pools.values()];
  pools.clear();
  await Promise.all(services.map((service) => service.close()));
}
