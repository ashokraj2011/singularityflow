/**
 * The first, deliberately closed GAL facade. Mutable observations use the existing supervised
 * asynchronous Git executor; raw blob reads use a byte-exact asynchronous batch transport.
 * There is no argv or mutation entry point here. Publication remains with its transaction owner.
 *
 * Unsupported operations are not faked.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readLocalGitBlobsAsync } from './git-local-blob-async.mjs';
import { createGitStatusReadFacade } from './git-access-status.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { failureEvidence } from './git-remote-diagnostics.mjs';
import { isFullyQualifiedWindowsPath } from './platform-process.mjs';

const LOCAL_DEADLINE_MS = 30_000;
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
// One admitted object must fit within a chunk; the aggregate request has a separate upper bound.
const MAX_CHUNK_BYTES = MAX_OBJECT_BYTES;
const MAX_BATCH_ENTRIES = 4_096;
const MAX_LIST_ENTRIES = 4_096;
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const OID = Object.freeze({ sha1: /^[0-9a-f]{40}$/u, sha256: /^[0-9a-f]{64}$/u });
const APPROVED_CONFIG_KEYS = new Set([
  'remote.origin.url', 'core.bare', 'core.filemode', 'core.ignorecase',
  'core.symlinks', 'core.protectntfs', 'core.protecthfs', 'extensions.objectformat'
]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const RUNTIME_ENVIRONMENTS = new WeakMap();

function success(subject, value, extra = {}) {
  return { ok: true, subject, value, completeness: true, ...extra };
}

function failure(code, operationId, subject = null, result = null) {
  const evidence = result ? failureEvidence(result) : null;
  return {
    ok: false, code, subject,
    diagnostic: {
      operationId, exitCode: evidence?.exitCode ?? null, signal: evidence?.signal ?? null,
      timedOut: evidence?.timedOut ?? false, blocked: evidence?.blocked ?? false,
      diagnosticSha256: evidence?.diagnosticSha256 ?? null,
      diagnosticBytes: evidence?.diagnosticBytes ?? 0,
      spawnErrorCode: typeof result?.error?.code === 'string' ? result.error.code : null,
      outputOverflow: result?.outputOverflow === true, cancelled: result?.aborted === true
    }
  };
}

function executionFailure(operationId, subject, result) {
  const code = result?.aborted ? 'GAL_CANCELLED'
    : result?.timedOut ? 'GAL_TIMEOUT'
      : result?.outputOverflow ? 'GAL_OUTPUT_LIMIT'
        : result?.error ? 'GAL_EXECUTABLE_UNAVAILABLE' : 'GAL_GIT_FAILED';
  return failure(code, operationId, subject, result);
}

function singleLine(output) {
  if (typeof output !== 'string' || !output.endsWith('\n') || output.includes('\0')) return null;
  return output.slice(0, -1);
}

function validOid(value, format) {
  return typeof value === 'string' && OID[format]?.test(value) === true;
}

function validRef(value) {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) return false;
  return validRefBytes(Buffer.from(value, 'utf8'));
}

function splitBytes(bytes, delimiter) {
  const values = [];
  let start = 0;
  for (let offset = 0; offset < bytes.length; offset += 1) {
    if (bytes[offset] !== delimiter) continue;
    values.push(bytes.subarray(start, offset));
    start = offset + 1;
  }
  values.push(bytes.subarray(start));
  return values;
}

function validRefBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 6 || bytes.length > 4_096
      || !bytes.subarray(0, 5).equals(Buffer.from('refs/'))
      || bytes.includes(Buffer.from('..')) || bytes.includes(Buffer.from('@{'))
      || bytes.some((byte) => byte <= 0x20 || byte === 0x7f
        || [0x7e, 0x5e, 0x3a, 0x3f, 0x2a, 0x5b, 0x5c].includes(byte))) return false;
  return splitBytes(bytes, 0x2f).every((part) => part.length
    && part[0] !== 0x2e && part.at(-1) !== 0x2e
    && !part.subarray(Math.max(0, part.length - 5)).equals(Buffer.from('.lock')));
}

function controlledEnvironment(source, executable) {
  const env = withoutGitProcessOverrides(source);
  // The shared owner removes known overrides. This facade's local, raw-read profile is narrower:
  // inherited command/repository/object/exec overrides cannot reinterpret the requested object.
  for (const key of Object.keys(env)) {
    // Host-selected protected system/global paths may carry approved office trust. They are not
    // command-scoped configuration and should not disappear during a local read.
    if (key.toUpperCase().startsWith('GIT_')
        && !/^GIT_CONFIG_(?:SYSTEM|GLOBAL)$/i.test(key)) delete env[key];
  }
  // An explicit runtime selection must also be the Git found by subprocesses that Git itself
  // launches. Keep the host's remaining PATH for approved helpers, but never search cwd first.
  const originalPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [path.dirname(executable), originalPath].filter(Boolean).join(path.delimiter);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.LC_ALL = 'C';
  // The executor is shared with remote commands and would refuse every call under this flag.
  // These descriptors are strictly local; lazy object acquisition is separately disabled above.
  delete env.SINGULARITY_FLOW_NO_NETWORK;
  return env;
}

async function executableAt(candidate, platform) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return null;
  const absolute = platform === 'win32'
    ? isFullyQualifiedWindowsPath(candidate) : path.isAbsolute(candidate);
  if (!absolute || (platform === 'win32' && !/git\.exe$/iu.test(path.win32.basename(candidate)))) {
    return null;
  }
  try {
    const canonical = await realpath(candidate);
    if (platform === 'win32' && !/git\.exe$/iu.test(path.win32.basename(canonical))) return null;
    const info = await stat(canonical);
    if (!info.isFile()) return null;
    await access(canonical, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return canonical;
  } catch { return null; }
}

async function resolveExecutable({ trustedGitPath = null, environment = process.env,
  platform = process.platform } = {}) {
  if (trustedGitPath != null) return executableAt(trustedGitPath, platform);
  const entry = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path');
  const search = String(entry?.[1] ?? '').split(path.delimiter);
  for (const directory of search) {
    const absolute = platform === 'win32'
      ? isFullyQualifiedWindowsPath(directory) : path.isAbsolute(directory);
    if (!absolute) continue; // empty and relative PATH entries can refer to an untrusted checkout
    const candidate = platform === 'win32'
      ? path.win32.join(directory, 'git.exe') : path.join(directory, 'git');
    const found = await executableAt(candidate, platform);
    if (found) return found;
  }
  return null;
}

function pinnedSpawn(executable) {
  return (_selected, args, options) => spawn(executable, args, options);
}

async function executeText(runtime, cwd, args, { signal, maxBuffer = 2 * 1024 * 1024 } = {}) {
  return runRemoteGitAsync(args, {
    cwd, env: RUNTIME_ENVIRONMENTS.get(runtime), operation: 'local-read',
    timeoutMs: runtime.deadlineMs, maxBuffer, allowFailure: true, signal,
    spawnCommand: pinnedSpawn(runtime.identity.path)
  });
}

async function executeBytes(runtime, cwd, args, { signal, maxBuffer = MAX_LIST_BYTES } = {}) {
  return runRemoteGitAsync(args, {
    cwd, env: RUNTIME_ENVIRONMENTS.get(runtime), operation: 'local-read',
    timeoutMs: runtime.deadlineMs, maxBuffer, allowFailure: true, signal,
    encoding: 'buffer', spawnCommand: pinnedSpawn(runtime.identity.path)
  });
}

function exactUtf8(bytes) {
  try { return UTF8.decode(bytes); } catch { return null; }
}

function byteValue(bytes) {
  const text = exactUtf8(bytes);
  return text === null
    ? { bytes: Buffer.from(bytes), text: null, base64: bytes.toString('base64') }
    : { bytes: Buffer.from(bytes), text, base64: null };
}

// structuredClone turns Node Buffers into Uint8Arrays. Keep the byte-bearing typed result
// identical for fresh and captured reads while isolating callers from the retained capture.
function cloneReadResult(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(cloneReadResult);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneReadResult(item)]));
  }
  return value;
}

function nulRecords(bytes, maximum = MAX_LIST_ENTRIES) {
  if (!Buffer.isBuffer(bytes) || (bytes.length && bytes.at(-1) !== 0)) return null;
  if (!bytes.length) return [];
  const records = [];
  let start = 0;
  for (let offset = 0; offset < bytes.length; offset += 1) {
    if (bytes[offset] !== 0) continue;
    if (records.length >= maximum) return 'limit';
    records.push(bytes.subarray(start, offset));
    start = offset + 1;
  }
  return records;
}

function validSelection(request, keys) {
  return request && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).every((key) => keys.includes(key));
}

function validScope(scope) {
  if (scope == null) return Buffer.alloc(0);
  if (typeof scope === 'string' && Buffer.from(scope, 'utf8').toString('utf8') !== scope) return null;
  const bytes = Buffer.isBuffer(scope) ? Buffer.from(scope)
    : typeof scope === 'string' ? Buffer.from(scope, 'utf8') : null;
  if (!bytes || !bytes.length || bytes.length > 4_096 || bytes.includes(0)
      || bytes[0] === 0x2f || bytes.at(-1) === 0x2f) return null;
  let start = 0;
  for (let offset = 0; offset <= bytes.length; offset += 1) {
    if (offset !== bytes.length && bytes[offset] !== 0x2f) continue;
    const part = bytes.subarray(start, offset);
    if (!part.length || (part.length === 1 && part[0] === 0x2e)
        || (part.length === 2 && part[0] === 0x2e && part[1] === 0x2e)) return null;
    start = offset + 1;
  }
  return bytes;
}

function checkedCaptureKey(options) {
  const freshness = options?.freshness ?? 'fresh';
  if (freshness === 'fresh') return options?.captureKey == null ? { freshness, key: null } : null;
  if (freshness !== 'captured' || typeof options?.captureKey !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.captureKey)) return null;
  return { freshness, key: options.captureKey };
}

function directoryIdentity(info) {
  return info?.isDirectory() ? [info.dev, info.ino, info.birthtimeMs] : null;
}

async function fileIdentity(location) {
  try {
    const info = await lstat(location);
    if (info.isFile()) {
      // Git's .git and commondir pointer files are small. Reject a changed/oversized pointer
      // instead of reading an unbounded file or trusting only a possibly restored timestamp.
      if (info.size > 4_096) return ['oversized', info.dev, info.ino, info.size];
      const bytes = await readFile(location);
      if (bytes.length > 4_096) return ['oversized', info.dev, info.ino, bytes.length];
      return ['file', info.dev, info.ino, createHash('sha256').update(bytes).digest('hex')];
    }
    // A main worktree's .git is a directory; its changing mtime is not an incarnation change.
    return [info.isDirectory() ? 'directory' : 'other', info.dev, info.ino, info.birthtimeMs];
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function repositoryStamp({ root, gitDir, commonDir }) {
  const [gitDirectory, commonDirectory, marker, commonPointer] = await Promise.all([
    stat(gitDir), stat(commonDir), root ? fileIdentity(path.join(root, '.git')) : null,
    fileIdentity(path.join(gitDir, 'commondir'))
  ]);
  const gitIdentity = directoryIdentity(gitDirectory);
  const commonIdentity = directoryIdentity(commonDirectory);
  if (!gitIdentity || !commonIdentity || (root && !marker)) return null;
  return JSON.stringify([gitIdentity, commonIdentity, marker, commonPointer]);
}

class GitInvocation {
  #repository;
  #controller = new AbortController();
  #closed = false;
  #captures = new Map();
  #statusReads;

  constructor(repository) {
    this.#repository = repository;
    this.#statusReads = createGitStatusReadFacade(repository, (args, { signal, maxBuffer }) =>
      runRemoteGitAsync(args, {
        cwd: repository.identity.nativePath,
        env: RUNTIME_ENVIRONMENTS.get(repository.runtime),
        operation: 'local-read', timeoutMs: repository.runtime.deadlineMs,
        maxBuffer, allowFailure: true, signal, encoding: 'buffer',
        spawnCommand: pinnedSpawn(repository.runtime.identity.path)
      }), { signal: this.#controller.signal });
  }
  get identity() { return this.#repository.identity; }

  async #observe(operationId, request, options, read) {
    if (this.#closed || this.#repository.closed) return failure('GAL_DISPOSED', operationId, request);
    if (!(await this.#repository.identityCurrent())) {
      return failure('GAL_REPOSITORY_CHANGED', operationId, request);
    }
    const capture = checkedCaptureKey(options);
    if (!capture) return failure('GAL_INPUT_INVALID', operationId, request);
    if (capture.freshness === 'fresh') {
      const result = await read();
      if (this.#closed) return failure('GAL_CANCELLED', operationId, request);
      return await this.#repository.identityCurrent()
        ? result : failure('GAL_REPOSITORY_CHANGED', operationId, request);
    }
    const key = `${operationId}:${capture.key}`;
    const fingerprint = JSON.stringify(request);
    const existing = this.#captures.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return failure('GAL_CAPTURE_CONFLICT', operationId, request);
      const result = await existing.promise;
      if (this.#closed) return failure('GAL_CANCELLED', operationId, request);
      if (!(await this.#repository.identityCurrent())) {
        return failure('GAL_REPOSITORY_CHANGED', operationId, request);
      }
      return cloneReadResult(result);
    }
    const pending = Promise.resolve().then(read);
    const held = { fingerprint, promise: pending };
    this.#captures.set(key, held);
    const result = await pending;
    if (this.#closed) return failure('GAL_CANCELLED', operationId, request);
    if (!(await this.#repository.identityCurrent())) {
      this.#captures.delete(key);
      return failure('GAL_REPOSITORY_CHANGED', operationId, request);
    }
    if (!result.ok && this.#captures.get(key) === held) this.#captures.delete(key);
    return cloneReadResult(result);
  }

  async head(options = {}) {
    const operationId = 'gal.head.v1';
    return this.#observe(operationId, {}, options, async () => {
      const runtime = this.#repository.runtime;
      const cwd = this.#repository.identity.nativePath;
      const symbolic = await executeText(runtime, cwd, ['symbolic-ref', '--quiet', 'HEAD'], {
        signal: this.#controller.signal, maxBuffer: 1024
      });
      if (symbolic.status !== 0 && (symbolic.status !== 1 || symbolic.error
          || symbolic.timedOut || symbolic.aborted || symbolic.outputOverflow
          || symbolic.stderr)) return executionFailure(operationId, { ref: 'HEAD' }, symbolic);
      const symbolicName = symbolic.status === 0 ? singleLine(symbolic.stdout) : null;
      if (symbolic.status === 0 && (!symbolicName || !validRef(symbolicName))) {
        return failure('GAL_PROTOCOL_INVALID', operationId, { ref: 'HEAD' }, symbolic);
      }
      const resolved = await executeText(runtime, cwd, ['rev-parse', '--verify', 'HEAD'], {
        signal: this.#controller.signal, maxBuffer: 1024
      });
      if (resolved.status !== 0) {
        if (symbolicName && resolved.status === 128 && !resolved.error && !resolved.timedOut
            && !resolved.aborted && !resolved.outputOverflow) {
          const exists = await executeText(runtime, cwd,
            ['show-ref', '--verify', '--quiet', symbolicName], {
              signal: this.#controller.signal, maxBuffer: 1024
            });
          if (exists.status === 1 && !exists.error && !exists.timedOut && !exists.aborted
              && !exists.outputOverflow && !exists.stderr && !exists.stdout) {
            const stable = await executeText(runtime, cwd, ['symbolic-ref', '--quiet', 'HEAD'], {
              signal: this.#controller.signal, maxBuffer: 1024
            });
            if (stable.error || stable.timedOut || stable.aborted || stable.outputOverflow) {
              return executionFailure(operationId, { ref: 'HEAD' }, stable);
            }
            if (stable.status !== 0 || singleLine(stable.stdout) !== symbolicName) {
              return failure('GAL_OBSERVATION_CHANGED', operationId, { ref: 'HEAD' }, stable);
            }
            return success({ ref: 'HEAD' }, { state: 'unborn', symbolicRef: symbolicName, oid: null }, {
              observedAt: new Date().toISOString(), classification: 'observational'
            });
          }
        }
        return executionFailure(operationId, { ref: 'HEAD' }, resolved);
      }
      const oid = singleLine(resolved.stdout);
      if (!validOid(oid, this.identity.objectFormat)) {
        return failure('GAL_PROTOCOL_INVALID', operationId, { ref: 'HEAD' }, resolved);
      }
      const stable = await executeText(runtime, cwd, ['symbolic-ref', '--quiet', 'HEAD'], {
        signal: this.#controller.signal, maxBuffer: 1024
      });
      if (stable.error || stable.timedOut || stable.aborted || stable.outputOverflow) {
        return executionFailure(operationId, { ref: 'HEAD' }, stable);
      }
      const stableName = stable.status === 0 ? singleLine(stable.stdout) : null;
      if (![0, 1].includes(stable.status) || stable.stderr
          || stableName !== symbolicName) {
        return failure('GAL_OBSERVATION_CHANGED', operationId, { ref: 'HEAD' }, stable);
      }
      return success({ ref: 'HEAD' }, {
        state: symbolicName ? 'attached' : 'detached', symbolicRef: symbolicName, oid
      }, { observedAt: new Date().toISOString(), classification: 'observational' });
    });
  }

  async resolveRef(request = {}) {
    const operationId = 'gal.resolve-ref.v1';
    const ref = request?.ref;
    if (!validRef(ref)) return failure('GAL_INPUT_INVALID', operationId, { ref });
    return this.#observe(operationId, { ref }, request, async () => {
      const exists = await executeText(this.#repository.runtime, this.identity.nativePath,
        ['show-ref', '--verify', '--quiet', ref], {
          signal: this.#controller.signal, maxBuffer: 1024
        });
      if (exists.status !== 0) {
        if (exists.status === 1 && !exists.error && !exists.timedOut && !exists.aborted
            && !exists.outputOverflow && !exists.stderr && !exists.stdout) {
          return failure('GAL_REF_ABSENT', operationId, { ref }, exists);
        }
        return executionFailure(operationId, { ref }, exists);
      }
      const result = await executeText(this.#repository.runtime, this.identity.nativePath,
        ['show-ref', '--verify', '--hash', ref], {
          signal: this.#controller.signal, maxBuffer: 1024
        });
      if (result.status !== 0) return executionFailure(operationId, { ref }, result);
      const oid = singleLine(result.stdout);
      if (!validOid(oid, this.identity.objectFormat)) {
        return failure('GAL_PROTOCOL_INVALID', operationId, { ref }, result);
      }
      return success({ ref }, { ref, oid, objectFormat: this.identity.objectFormat }, {
        observedAt: new Date().toISOString(), classification: 'observational'
      });
    });
  }

  async refs(request = {}) {
    const operationId = 'gal.refs.v1';
    if (!validSelection(request, ['prefix', 'includePeeled', 'freshness', 'captureKey'])
        || (request.prefix != null && !validRef(request.prefix))
        || (request.includePeeled != null && typeof request.includePeeled !== 'boolean')) {
      return failure('GAL_INPUT_INVALID', operationId);
    }
    const prefix = request.prefix ?? 'refs';
    const includePeeled = request.includePeeled ?? false;
    return this.#observe(operationId, { prefix, includePeeled }, request, async () => {
      const subject = { prefix };
      const output = await executeBytes(this.#repository.runtime, this.identity.nativePath, [
        'for-each-ref', `--count=${MAX_LIST_ENTRIES + 1}`,
        '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)%00%(*objectname)%00%(*objecttype)',
        prefix
      ], { signal: this.#controller.signal });
      if (output.status !== 0 || output.error || output.timedOut || output.aborted
          || output.outputOverflow) return executionFailure(operationId, subject, output);
      if (!Buffer.isBuffer(output.stdout)) return failure('GAL_PROTOCOL_INVALID', operationId, subject, output);
      const bytes = output.stdout;
      if (bytes.length && bytes.at(-1) !== 0x0a) {
        return failure('GAL_PROTOCOL_INVALID', operationId, subject, output);
      }
      let lineCount = 0;
      for (const byte of bytes) if (byte === 0x0a) lineCount += 1;
      if (lineCount > MAX_LIST_ENTRIES) {
        return failure('GAL_LIMIT_EXCEEDED', operationId, subject, output);
      }
      const lines = bytes.length ? splitBytes(bytes.subarray(0, -1), 0x0a) : [];
      if (lines.length > MAX_LIST_ENTRIES) return failure('GAL_LIMIT_EXCEEDED', operationId, subject, output);
      const entries = [];
      for (const line of lines) {
        const fields = splitBytes(line, 0);
        if (fields.length !== 6) return failure('GAL_PROTOCOL_INVALID', operationId, subject, output);
        const [refBytes, oidBytes, typeBytes, symbolicRefBytes, peeledOidBytes,
          peeledTypeBytes] = fields;
        const oid = oidBytes.toString('ascii');
        const type = typeBytes.toString('ascii');
        const peeledOid = peeledOidBytes.toString('ascii');
        const peeledType = peeledTypeBytes.toString('ascii');
        const prefixBytes = Buffer.from(prefix, 'utf8');
        if (!validRefBytes(refBytes)
            || !(refBytes.equals(prefixBytes)
              || (refBytes.length > prefixBytes.length
                && refBytes.subarray(0, prefixBytes.length).equals(prefixBytes)
                && refBytes[prefixBytes.length] === 0x2f))
            || ![oidBytes, typeBytes, peeledOidBytes, peeledTypeBytes]
              .every((value) => value.every((byte) => byte <= 0x7f))
            || !validOid(oid, this.identity.objectFormat)
            || !['blob', 'tree', 'commit', 'tag'].includes(type)
            || (symbolicRefBytes.length && !validRefBytes(symbolicRefBytes))
            || (peeledOid && !validOid(peeledOid, this.identity.objectFormat))
            || (peeledType && !['blob', 'tree', 'commit', 'tag'].includes(peeledType))
            || Boolean(peeledOid) !== Boolean(peeledType)
            || Boolean(peeledOid) !== (type === 'tag')) {
          return failure('GAL_PROTOCOL_INVALID', operationId, subject, output);
        }
        if (includePeeled && peeledType === 'tag') {
          // A remaining tag is not a complete peel. Do not report it as the final object.
          return failure('GAL_OPERATION_UNSUPPORTED', operationId, subject, output);
        }
        const name = byteValue(refBytes);
        const symbolic = symbolicRefBytes.length ? byteValue(symbolicRefBytes) : null;
        entries.push({ ref: name.text, refBytes: name.bytes, refBase64: name.base64,
          oid, objectType: type, symbolicRef: symbolic?.text ?? null,
          symbolicRefBytes: symbolic?.bytes ?? null,
          symbolicRefBase64: symbolic?.base64 ?? null,
          ...(includePeeled ? { peeledOid: peeledOid || null } : {}) });
      }
      return success(subject, { entries }, {
        observedAt: new Date().toISOString(), classification: 'observational'
      });
    });
  }

  async config(request = {}) {
    const operationId = 'gal.config.v1';
    if (!validSelection(request, ['keys', 'freshness', 'captureKey'])
        || !Array.isArray(request.keys) || !request.keys.length || request.keys.length > 16
        || request.keys.some((key) => !APPROVED_CONFIG_KEYS.has(key))
        || new Set(request.keys).size !== request.keys.length) {
      return failure('GAL_INPUT_INVALID', operationId);
    }
    const keys = [...request.keys];
    return this.#observe(operationId, { keys }, request, async () => {
      const entries = [];
      for (const key of keys) {
        const result = await executeBytes(this.#repository.runtime, this.identity.nativePath,
          ['config', '--null', '--get-all', key], {
            signal: this.#controller.signal, maxBuffer: MAX_CONFIG_BYTES
          });
        if (result.status === 1 && !result.error && !result.timedOut && !result.aborted
            && !result.outputOverflow && !result.stderr && Buffer.isBuffer(result.stdout)
            && result.stdout.length === 0) {
          entries.push({ key, values: [] });
          continue;
        }
        if (result.status !== 0 || result.error || result.timedOut || result.aborted
            || result.outputOverflow) return executionFailure(operationId, { key }, result);
        const values = nulRecords(result.stdout, 128);
        if (values === 'limit') return failure('GAL_LIMIT_EXCEEDED', operationId, { key }, result);
        if (!values) return failure('GAL_PROTOCOL_INVALID', operationId, { key }, result);
        entries.push({ key, values: values.map(byteValue) });
      }
      return success({ keys }, { entries }, {
        observedAt: new Date().toISOString(), classification: 'observational'
      });
    });
  }

  async tree(request = {}) {
    const operationId = 'gal.tree.v1';
    if (!validSelection(request, ['oid', 'recursive', 'scope'])
        || !validOid(request.oid, this.identity.objectFormat)
        || (request.recursive != null && typeof request.recursive !== 'boolean')) {
      return failure('GAL_INPUT_INVALID', operationId);
    }
    const scope = validScope(request.scope);
    if (!scope || (scope.length && request.recursive !== true)) {
      return failure('GAL_INPUT_INVALID', operationId);
    }
    const oid = request.oid;
    const recursive = request.recursive ?? false;
    const subject = { oid, recursive, scope: scope.length ? byteValue(scope) : null };
    return this.#observe(operationId, subject, {}, async () => {
      const type = await executeText(this.#repository.runtime, this.identity.nativePath,
        ['cat-file', '-t', oid], { signal: this.#controller.signal, maxBuffer: 128 });
      if (type.status !== 0 || type.error || type.timedOut || type.aborted || type.outputOverflow) {
        return type.status === 128 && !type.error && !type.timedOut && !type.aborted
          && !type.outputOverflow ? failure('GAL_OBJECT_UNAVAILABLE', operationId, subject, type)
          : executionFailure(operationId, subject, type);
      }
      const objectType = singleLine(type.stdout);
      if (objectType !== 'tree') return objectType && ['blob', 'commit', 'tag'].includes(objectType)
        ? failure('GAL_WRONG_OBJECT_TYPE', operationId, subject, type)
        : failure('GAL_PROTOCOL_INVALID', operationId, subject, type);
      const listed = await executeBytes(this.#repository.runtime, this.identity.nativePath,
        ['ls-tree', ...(recursive ? ['-r'] : []), '-z', '-l', '--full-tree', oid], {
          signal: this.#controller.signal
        });
      if (listed.status !== 0 || listed.error || listed.timedOut || listed.aborted
          || listed.outputOverflow) return executionFailure(operationId, subject, listed);
      const records = nulRecords(listed.stdout, MAX_LIST_ENTRIES + 1);
      if (records === 'limit') return failure('GAL_LIMIT_EXCEEDED', operationId, subject, listed);
      if (!records) return failure('GAL_PROTOCOL_INVALID', operationId, subject, listed);
      if (records.length > MAX_LIST_ENTRIES) return failure('GAL_LIMIT_EXCEEDED', operationId, subject, listed);
      const entries = [];
      for (const record of records) {
        const tab = record.indexOf(0x09);
        if (tab < 0) return failure('GAL_PROTOCOL_INVALID', operationId, subject, listed);
        const metadata = record.toString('ascii', 0, tab);
        const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([0-9a-f]+) +(-|[0-9]+)$/u.exec(metadata);
        const pathBytes = record.subarray(tab + 1);
        if (!record.subarray(0, tab).every((byte) => byte <= 0x7f)
            || !match || !validOid(match[3], this.identity.objectFormat) || !validScope(pathBytes)
            || (match[1] === '040000') !== (match[2] === 'tree')
            || (match[1] === '160000') !== (match[2] === 'commit')
            || (match[2] === 'blob' && !['100644', '100755', '120000'].includes(match[1]))) {
          return failure('GAL_PROTOCOL_INVALID', operationId, subject, listed);
        }
        const size = match[4] === '-' ? null : Number(match[4]);
        if ((size !== null && (!Number.isSafeInteger(size) || size < 0))
            || (match[2] !== 'blob' && size !== null)) {
          return failure('GAL_PROTOCOL_INVALID', operationId, subject, listed);
        }
        if (scope.length && !pathBytes.equals(scope)
            && !(pathBytes.length > scope.length && pathBytes.subarray(0, scope.length).equals(scope)
              && pathBytes[scope.length] === 0x2f)) continue;
        entries.push({ path: byteValue(pathBytes), mode: match[1], objectType: match[2],
          oid: match[3], size });
      }
      return success(subject, { treeOid: oid, recursive, entries }, {
        objectFormat: this.identity.objectFormat, classification: 'verified-immutable'
      });
    });
  }

  async blob(oid) {
    const operationId = 'gal.blob.v1';
    const result = await this.blobs({ oids: [oid] });
    if (!result.ok) return { ...result, diagnostic: { ...result.diagnostic, operationId } };
    return success({ oid }, { oid, bytes: Buffer.from(result.value.entries[0].bytes) }, {
      objectFormat: this.identity.objectFormat, classification: 'verified-immutable'
    });
  }

  statusDetail(request = {}) { return this.#statusReads.statusDetail(request); }

  indexDetail(request = {}) { return this.#statusReads.indexDetail(request); }

  status(request = {}) { return this.statusDetail(request); }

  index(request = {}) { return this.indexDetail(request); }

  async blobs(request = {}) {
    const operationId = 'gal.blobs.v1';
    const oids = request?.oids;
    if (this.#closed || this.#repository.closed) return failure('GAL_DISPOSED', operationId);
    if (!Array.isArray(oids) || oids.length > MAX_BATCH_ENTRIES
        || oids.some((oid) => !validOid(oid, this.identity.objectFormat))
        || (request.mode != null && request.mode !== 'required')) {
      return failure('GAL_INPUT_INVALID', operationId);
    }
    if (this.#controller.signal.aborted) return failure('GAL_CANCELLED', operationId);
    if (!(await this.#repository.identityCurrent())) {
      return failure('GAL_REPOSITORY_CHANGED', operationId);
    }
    if (!oids.length) return success({ oids: [] }, { entries: [] }, {
      objectFormat: this.identity.objectFormat, classification: 'verified-immutable'
    });
    try {
      const values = await readLocalGitBlobsAsync(this.identity.nativePath, oids, {
        executable: this.#repository.runtime.identity.path,
        env: RUNTIME_ENVIRONMENTS.get(this.#repository.runtime),
        signal: this.#controller.signal,
        deadlineMs: this.#repository.runtime.deadlineMs,
        maximumBytes: MAX_BATCH_BYTES, maximumObjectBytes: MAX_OBJECT_BYTES,
        maximumBatchBytes: MAX_CHUNK_BYTES
      });
      if (this.#controller.signal.aborted) return failure('GAL_CANCELLED', operationId);
      const identityCurrent = await this.#repository.identityCurrent();
      if (this.#controller.signal.aborted) return failure('GAL_CANCELLED', operationId);
      if (!identityCurrent) {
        return failure('GAL_REPOSITORY_CHANGED', operationId);
      }
      return success({ oids: [...oids] }, {
        entries: oids.map((oid) => ({ oid, bytes: Buffer.from(values.get(oid)) }))
      }, { objectFormat: this.identity.objectFormat, classification: 'verified-immutable' });
    } catch (error) {
      const code = error?.code === 'GIT_BLOB_BATCH_INVALID' ? 'GAL_OBJECT_UNAVAILABLE'
        : ['GAL_CANCELLED', 'GAL_TIMEOUT', 'GAL_OUTPUT_LIMIT', 'GAL_OBJECT_MISSING',
          'GAL_WRONG_OBJECT_TYPE', 'GAL_LIMIT_EXCEEDED', 'GAL_EXECUTABLE_UNAVAILABLE']
            .includes(error?.code) ? error.code : 'GAL_GIT_FAILED';
      return failure(code, operationId, { oids: [...oids] }, error?.result);
    }
  }

  // Remote transport and mutation authorization remain intentionally absent. A generic fallback
  // would bypass their owners.
  async dispose() {
    if (this.#closed) return success({ kind: 'invocation' }, { closed: true, alreadyClosed: true });
    this.#closed = true;
    this.#controller.abort();
    this.#statusReads.dispose();
    this.#captures.clear();
    return success({ kind: 'invocation' }, { closed: true, alreadyClosed: false });
  }
}

class GitRepository {
  #closed = false;
  #invocations = new Set();
  #stamp;
  constructor(runtime, identity, stamp) {
    this.runtime = runtime;
    this.identity = Object.freeze(identity);
    this.#stamp = stamp;
    Object.freeze(this);
  }
  get closed() { return this.#closed; }
  async identityCurrent() {
    if (this.#closed || this.runtime.closed) return false;
    try { return await repositoryStamp(this.identity) === this.#stamp; }
    catch { return false; }
  }
  beginInvocation() {
    if (this.#closed || this.runtime.closed) throw new Error('GAL repository is disposed.');
    const invocation = new GitInvocation(this);
    this.#invocations.add(invocation);
    return invocation;
  }
  async dispose() {
    if (this.#closed) return success({ kind: 'repository' }, { closed: true, alreadyClosed: true });
    this.#closed = true;
    await Promise.all([...this.#invocations].map((invocation) => invocation.dispose()));
    this.#invocations.clear();
    return success({ kind: 'repository' }, { closed: true, alreadyClosed: false });
  }
}

class GitRuntime {
  #closed = false;
  #repositories = new Set();
  constructor(identity, environment, deadlineMs, signal = null) {
    this.identity = Object.freeze(identity);
    this.deadlineMs = deadlineMs;
    this.signal = signal;
    RUNTIME_ENVIRONMENTS.set(this, environment);
    Object.freeze(this);
  }
  get closed() { return this.#closed; }

  async openRepository(nativePath) {
    const operationId = 'gal.open-repository.v1';
    if (this.#closed) return failure('GAL_DISPOSED', operationId);
    if (this.signal?.aborted) return failure('GAL_CANCELLED', operationId);
    if (typeof nativePath !== 'string' || !path.isAbsolute(nativePath) || nativePath.includes('\0')) {
      return failure('GAL_INPUT_INVALID', operationId);
    }
    let location;
    try { location = await realpath(nativePath); } catch { return failure('GAL_REPOSITORY_UNAVAILABLE', operationId); }
    const observation = async (args) => executeText(this, location, ['rev-parse', ...args], {
      signal: this.signal, maxBuffer: 4096
    });
    const gitDirResult = await observation(['--path-format=absolute', '--absolute-git-dir']);
    if (gitDirResult.status !== 0) return executionFailure(operationId, { nativePath: location }, gitDirResult);
    const commonResult = await observation(['--path-format=absolute', '--git-common-dir']);
    if (commonResult.status !== 0) return executionFailure(operationId, { nativePath: location }, commonResult);
    const formatResult = await observation(['--show-object-format']);
    if (formatResult.status !== 0) return executionFailure(operationId, { nativePath: location }, formatResult);
    const bareResult = await observation(['--is-bare-repository']);
    if (bareResult.status !== 0) return executionFailure(operationId, { nativePath: location }, bareResult);
    const gitDir = singleLine(gitDirResult.stdout);
    const commonDir = singleLine(commonResult.stdout);
    const objectFormat = singleLine(formatResult.stdout);
    const bareText = singleLine(bareResult.stdout);
    if (!gitDir || !commonDir || !path.isAbsolute(gitDir) || !path.isAbsolute(commonDir)
        || !OID[objectFormat] || !['true', 'false'].includes(bareText)) {
      return failure('GAL_PROTOCOL_INVALID', operationId, { nativePath: location });
    }
    let root = null;
    if (bareText === 'false') {
      const rootResult = await observation(['--show-toplevel']);
      if (rootResult.status !== 0) return executionFailure(operationId, { nativePath: location }, rootResult);
      root = singleLine(rootResult.stdout);
      if (!root || !path.isAbsolute(root)) return failure('GAL_PROTOCOL_INVALID', operationId);
    }
    let stamp;
    try { stamp = await repositoryStamp({ root, gitDir, commonDir }); }
    catch { return failure('GAL_REPOSITORY_UNAVAILABLE', operationId, { nativePath: location }); }
    if (!stamp) return failure('GAL_REPOSITORY_UNAVAILABLE', operationId, { nativePath: location });
    const instance = createHash('sha256').update(JSON.stringify([
      commonDir, gitDir, objectFormat, stamp
    ])).digest('hex');
    const identity = {
      nativePath: location, root, gitDir, commonDir,
      bare: bareText === 'true', objectFormat,
      indexPath: bareText === 'true' ? null : path.join(gitDir, 'index'),
      repositoryInstanceId: instance
    };
    const repository = new GitRepository(this, identity, stamp);
    this.#repositories.add(repository);
    return success({ nativePath: location }, repository, { classification: 'repository-instance' });
  }

  async dispose() {
    if (this.#closed) return success({ kind: 'runtime' }, { closed: true, alreadyClosed: true });
    this.#closed = true;
    await Promise.all([...this.#repositories].map((repository) => repository.dispose()));
    this.#repositories.clear();
    return success({ kind: 'runtime' }, { closed: true, alreadyClosed: false });
  }
}

/** Resolve Git before repository discovery. Explicit invalid selection never falls back to PATH. */
export async function createGitRuntime(options = {}) {
  const operationId = 'gal.create-runtime.v1';
  if (options.signal?.aborted) return failure('GAL_CANCELLED', operationId);
  const platform = options.platform ?? process.platform;
  const sourceEnvironment = options.trustedEnvironment ?? process.env;
  const executable = await resolveExecutable({
    trustedGitPath: options.trustedGitPath ?? null,
    environment: sourceEnvironment, platform
  });
  if (!executable) return failure('GAL_EXECUTABLE_UNAVAILABLE', operationId);
  const environment = controlledEnvironment(sourceEnvironment, executable);
  const deadlineMs = Number.isSafeInteger(options.deadlineMs)
    && options.deadlineMs > 0 && options.deadlineMs <= LOCAL_DEADLINE_MS
    ? options.deadlineMs : LOCAL_DEADLINE_MS;
  const provisional = { identity: { path: executable }, deadlineMs };
  RUNTIME_ENVIRONMENTS.set(provisional, environment);
  const version = await executeText(provisional, os.tmpdir(), ['--version'], {
    signal: options.signal, maxBuffer: 1024
  });
  if (version.status !== 0) return executionFailure(operationId, null, version);
  const versionText = singleLine(version.stdout);
  if (!versionText || !/^git version [^\r\n]+$/u.test(versionText)) {
    return failure('GAL_PROTOCOL_INVALID', operationId, null, version);
  }
  const runtime = new GitRuntime({ path: executable, version: versionText, platform },
    environment, deadlineMs, options.signal ?? null);
  return success({ executable: 'git' }, runtime, { classification: 'runtime' });
}
