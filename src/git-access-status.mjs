/**
 * Closed, byte-exact mutable Git reads for an already-verified GAL repository.
 * The caller supplies its pinned, supervised Buffer executor; this module cannot select a
 * repository, executable, arbitrary descriptor, or argv. Captures are invocation-local.
 */
import { failureEvidence } from './git-remote-diagnostics.mjs';
import { gitQueryDescriptor } from './git-query.mjs';

const OPERATIONS = Object.freeze({
  status: Object.freeze({ id: 'gal.status-detail.v1', descriptor: 'repository.status-detail',
    keys: ['untracked', 'includeIgnored', 'freshness', 'captureKey'], maxBuffer: 64 * 1024 * 1024 }),
  index: Object.freeze({ id: 'gal.index-detail.v1', descriptor: 'repository.index-detail',
    keys: ['freshness', 'captureKey'], maxBuffer: 64 * 1024 * 1024 })
});
const CAPTURE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function success(subject, value) {
  return { ok: true, subject, value, completeness: true,
    observedAt: new Date().toISOString(), classification: 'observational' };
}

function failure(code, operationId, subject, result = null) {
  const evidence = result ? failureEvidence(result) : null;
  return { ok: false, code, subject, diagnostic: {
    operationId, exitCode: evidence?.exitCode ?? null, signal: evidence?.signal ?? null,
    timedOut: evidence?.timedOut ?? false, blocked: evidence?.blocked ?? false,
    diagnosticSha256: evidence?.diagnosticSha256 ?? null,
    diagnosticBytes: evidence?.diagnosticBytes ?? 0,
    spawnErrorCode: typeof result?.error?.code === 'string' ? result.error.code : null,
    outputOverflow: result?.outputOverflow === true, cancelled: result?.aborted === true
  } };
}

function executionFailure(operationId, subject, result) {
  const code = result?.aborted ? 'GAL_CANCELLED'
    : result?.timedOut ? 'GAL_TIMEOUT'
      : result?.outputOverflow ? 'GAL_OUTPUT_LIMIT'
        : result?.error ? 'GAL_EXECUTABLE_UNAVAILABLE' : 'GAL_GIT_FAILED';
  return failure(code, operationId, subject, result);
}

function selectedRequest(kind, request, repository) {
  const operation = OPERATIONS[kind];
  const subject = { repositoryInstanceId: repository.identity.repositoryInstanceId,
    objectFormat: repository.identity.objectFormat };
  if (kind === 'status') {
    subject.untracked = request?.untracked ?? 'all';
    subject.includeIgnored = request?.includeIgnored ?? false;
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some((key) => !operation.keys.includes(key))) return { subject };
  const freshness = request.freshness ?? 'fresh';
  if (freshness !== 'fresh' && freshness !== 'captured') return { subject };
  if (freshness === 'captured' && (typeof request.captureKey !== 'string'
      || !CAPTURE_KEY.test(request.captureKey))) return { subject };
  if (freshness === 'fresh' && request.captureKey != null) return { subject };
  const descriptor = gitQueryDescriptor(operation.descriptor);
  try {
    const params = descriptor.validate(subject);
    return { subject, descriptor, params, freshness, captureKey: request.captureKey ?? null };
  } catch { return { subject }; }
}

/**
 * `execute(argv, { signal, maxBuffer })` must be owned by the verified GAL runtime: pinned
 * executable, controlled environment, repository identity's native cwd, hard deadline, and
 * Buffer stdout. The helper itself exposes only statusDetail and indexDetail.
 */
export function createGitStatusReadFacade(repository, execute, { signal = null } = {}) {
  if (!repository?.identity?.repositoryInstanceId || !repository.identity.objectFormat
      || typeof repository.identityCurrent !== 'function' || typeof execute !== 'function') {
    throw new TypeError('A verified GAL repository and bound Buffer executor are required.');
  }
  const controller = new AbortController();
  const captures = new Map();
  let closed = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  async function read(kind, request = {}) {
    const operation = OPERATIONS[kind];
    const selection = selectedRequest(kind, request, repository);
    const { subject, descriptor, params, freshness, captureKey } = selection;
    if (closed || repository.closed) return failure('GAL_DISPOSED', operation.id, subject);
    if (!descriptor) return failure('GAL_INPUT_INVALID', operation.id, subject);
    // A bare repository has no worktree status or owned index. In particular, an empty
    // `ls-files` response there must not masquerade as a complete stage inventory.
    if (repository.identity.bare) return failure('GAL_OPERATION_UNSUPPORTED', operation.id, subject);
    if (controller.signal.aborted) return failure('GAL_CANCELLED', operation.id, subject);
    if (!(await repository.identityCurrent())) {
      return failure('GAL_REPOSITORY_CHANGED', operation.id, subject);
    }
    const readOnce = async () => {
      const result = await execute(descriptor.argv(params), {
        signal: controller.signal, maxBuffer: operation.maxBuffer
      });
      if (result.status !== 0 || result.timedOut || result.aborted || result.outputOverflow
          || result.error) return executionFailure(operation.id, subject, result);
      if (!Buffer.isBuffer(result.stdout)) {
        return failure('GAL_PROTOCOL_INVALID', operation.id, subject, result);
      }
      try { return success(subject, descriptor.parser(result, params)); }
      catch (error) {
        return failure(['GAL_PARSE_INVALID', 'GAL_LIMIT_EXCEEDED', 'GAL_OPERATION_UNSUPPORTED']
          .includes(error?.code) ? error.code : 'GAL_PROTOCOL_INVALID', operation.id, subject,
        result);
      }
    };
    const captureId = `${operation.id}:${captureKey}`;
    const fingerprint = JSON.stringify(params);
    let captured = freshness === 'captured' ? captures.get(captureId) : null;
    if (captured && captured.fingerprint !== fingerprint) {
      return failure('GAL_CAPTURE_CONFLICT', operation.id, subject);
    }
    if (!captured) {
      captured = { fingerprint, promise: Promise.resolve().then(readOnce) };
      if (freshness === 'captured') captures.set(captureId, captured);
    }
    let result;
    try { result = await captured.promise; }
    catch (error) {
      // The transport normally returns a typed result. A throwing injected executor still fails
      // closed, without leaking its message, argv, or repository path into public diagnostics.
      result = failure(controller.signal.aborted ? 'GAL_CANCELLED' : 'GAL_GIT_FAILED',
        operation.id, subject, { error });
    }
    if (closed || controller.signal.aborted) return failure('GAL_CANCELLED', operation.id, subject);
    if (!(await repository.identityCurrent())) {
      if (freshness === 'captured') captures.delete(captureId);
      return failure('GAL_REPOSITORY_CHANGED', operation.id, subject);
    }
    if (freshness === 'captured' && !result.ok && captures.get(captureId) === captured) {
      captures.delete(captureId);
    }
    return structuredClone(result);
  }

  return Object.freeze({
    statusDetail: (request = {}) => read('status', request),
    indexDetail: (request = {}) => read('index', request),
    dispose() {
      if (closed) return;
      closed = true;
      controller.abort();
      signal?.removeEventListener('abort', onAbort);
      captures.clear();
    }
  });
}
