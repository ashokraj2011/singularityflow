import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addDocuments, admitStoryDocumentResource, createStoryDocumentBudget,
  documentMimeType, STORY_DOCUMENT_RESOURCE_LIMITS, validateDocumentUrl
} from './documents.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { commitAndPublish } from './state-stores.mjs';
import { gitCommonDir } from './git.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';
import { documentSetLifecycleBinding } from './document-publication.mjs';

const DEFAULT_MAX_DOCUMENT_BYTES = 26214400;
const DEFAULT_CAPTURE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CAPTURE_NAME = new RegExp(`^(capture-${UUID_SOURCE})$`, 'u');
const RETIRED_CAPTURE_NAME = new RegExp(`^retired-(capture-${UUID_SOURCE})-(${UUID_SOURCE})$`, 'u');
// This binding is deliberately module-private. Callers may describe Story evidence, but only this
// module can attest that a file path names the private bytes captured before Story mutation.
const CAPTURE_BINDINGS = Symbol('singularity-flow.story-document-capture-bindings');

export function storyDocumentCaptureStorePath(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'story-document-captures');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

async function captureRepositoryFingerprint(root) {
  const common = await realpath(gitCommonDir(root));
  return `sha256:${createHash('sha256').update(common).digest('hex')}`;
}

function validCaptureLease(value, { captureId, token = null, repositoryFingerprint }) {
  // This is an intentionally schema-transient, private cleanup lease. It contains no source path,
  // captured path, prompt, identity, or document bytes and is never a durable governance record.
  if (!exactKeys(value, [
    'captureId', 'createdAt', 'kind', 'owner', 'repositoryFingerprint', 'schemaVersion', 'token'
  ].sort())) return false;
  if (!exactKeys(value.owner, ['host', 'pid'])) return false;
  return value.schemaVersion === 1 // schema-transient: private disposable capture lease.
    && value.kind === 'story-document-capture-lease'
    && value.captureId === captureId
    && CAPTURE_NAME.test(value.captureId)
    && typeof value.token === 'string'
    && new RegExp(`^${UUID_SOURCE}$`, 'u').test(value.token)
    && (token == null || value.token === token)
    && value.repositoryFingerprint === repositoryFingerprint
    && typeof value.owner.host === 'string'
    && value.owner.host.length > 0
    && value.owner.host.length <= 255
    && !/[\r\n]/u.test(value.owner.host)
    && Number.isSafeInteger(value.owner.pid)
    && value.owner.pid > 0
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt));
}

async function verifiedCaptureDirectory(directory, expected) {
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return null;
  const leasePath = path.join(directory, 'lease.json');
  const leaseInfo = await lstat(leasePath).catch(() => null);
  const dataInfo = await lstat(path.join(directory, 'data')).catch(() => null);
  if (!leaseInfo?.isFile() || leaseInfo.isSymbolicLink()
      || !dataInfo?.isDirectory() || dataInfo.isSymbolicLink()) return null;
  let lease;
  try { lease = JSON.parse(await readFile(leasePath, 'utf8')); }
  catch { return null; }
  return validCaptureLease(lease, expected) ? lease : null;
}

function localOwnerState(owner) {
  if (owner.host !== os.hostname()) return 'remote';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

async function retireVerifiedCapture(store, name, expected) {
  const source = path.join(store, name);
  const lease = await verifiedCaptureDirectory(source, expected);
  if (!lease) return false;
  const retiredName = `retired-${lease.captureId}-${lease.token}`;
  const retired = path.join(store, retiredName);
  try { await rename(source, retired); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
    throw error;
  }
  // Revalidate the object after the atomic directory rename. If anything changed between the first
  // read and retirement, preserve the tombstone for manual inspection rather than deleting it.
  const retainedLease = await verifiedCaptureDirectory(retired, {
    ...expected, captureId: lease.captureId, token: lease.token
  });
  if (!retainedLease) return false;
  await rm(retired, { recursive: true, force: true });
  return true;
}

/**
 * Reclaim only direct-child capture directories whose private lease binds them to this exact Git
 * common directory. Names and deletion targets always come from the enumerated store, never JSON.
 */
export async function scavengeStoryDocumentCaptures(root, {
  nowMs = Date.now(),
  staleAfterMs = DEFAULT_CAPTURE_STALE_AFTER_MS
} = {}) {
  const store = storyDocumentCaptureStorePath(root);
  const storeInfo = await lstat(store).catch((error) => error?.code === 'ENOENT'
    ? null : Promise.reject(error));
  if (!storeInfo) return { removed: [], retained: [] };
  if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink()) {
    return { removed: [], retained: ['unsafe-store'] };
  }
  const repositoryFingerprint = await captureRepositoryFingerprint(root);
  const entries = await readdir(store, { withFileTypes: true });
  const removed = [];
  const retained = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const active = CAPTURE_NAME.exec(entry.name);
    const retired = RETIRED_CAPTURE_NAME.exec(entry.name);
    if (!active && !retired) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      retained.push(entry.name);
      continue;
    }
    const captureId = active?.[1] ?? retired[1];
    const token = retired?.[2] ?? null;
    const directory = path.join(store, entry.name);
    const lease = await verifiedCaptureDirectory(directory, {
      captureId, token, repositoryFingerprint
    });
    if (!lease) {
      retained.push(entry.name);
      continue;
    }
    let removable = Boolean(retired);
    if (active) {
      const ownerState = localOwnerState(lease.owner);
      const age = Math.max(0, nowMs - Date.parse(lease.createdAt));
      // A definitely dead local owner is immediately reclaimable. The TTL remains an independent
      // bound for PID reuse, remote hosts, and a process that never releases an abandoned capture.
      removable = ownerState === 'dead' || age >= staleAfterMs;
    }
    if (!removable) {
      retained.push(entry.name);
      continue;
    }
    const didRemove = retired
      ? (await rm(directory, { recursive: true, force: true }), true)
      : await retireVerifiedCapture(store, entry.name, {
          captureId, token: lease.token, repositoryFingerprint
        });
    (didRemove ? removed : retained).push(entry.name);
  }
  return { removed, retained };
}

async function createStoryDocumentCapture(root) {
  await scavengeStoryDocumentCaptures(root);
  const store = storyDocumentCaptureStorePath(root);
  await mkdir(store, { recursive: true, mode: 0o700 });
  const storeInfo = await lstat(store);
  if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink()) {
    throw new SingularityFlowError(
      'Story document capture storage is not a private directory in the repository Git metadata.',
      { code: 'STORY_DOCUMENT_CAPTURE_STORE_UNSAFE' }
    );
  }
  await chmod(store, 0o700);
  const repositoryFingerprint = await captureRepositoryFingerprint(root);
  const captureId = `capture-${randomUUID()}`;
  const token = randomUUID();
  const directory = path.join(store, captureId);
  const data = path.join(directory, 'data');
  try {
    await mkdir(directory, { mode: 0o700 });
    await mkdir(data, { mode: 0o700 });
    await writeAtomic(path.join(directory, 'lease.json'), `${JSON.stringify({
      schemaVersion: 1, // schema-transient: private disposable capture lease, never governance state.
      kind: 'story-document-capture-lease',
      captureId,
      token,
      repositoryFingerprint,
      owner: { host: os.hostname(), pid: process.pid },
      createdAt: new Date().toISOString()
    }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let disposed = false;
  return {
    captureId,
    directory,
    data,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await retireVerifiedCapture(store, captureId, {
        captureId, token, repositoryFingerprint
      });
    }
  };
}

async function captureRegularFile(source, destination, {
  maxFileBytes, allowedMimeTypes, evidence, displayPath, budget, depth,
  beforeFileOpen = null
}) {
  const info = await lstat(source, { bigint: true }).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Document path is not a regular file or directory: ${displayPath}`);
  }
  if (info.size > BigInt(maxFileBytes)) {
    throw new SingularityFlowError(`Document exceeds the ${maxFileBytes} byte limit: ${displayPath}`);
  }
  const size = Number(info.size);
  admitStoryDocumentResource(budget, { depth, size, label: displayPath });
  const type = documentMimeType(source);
  if (allowedMimeTypes && !allowedMimeTypes.includes(type)) {
    throw new SingularityFlowError(`Capability does not allow MIME type '${type}' for ${displayPath}.`);
  }
  let handle;
  let bytes;
  try {
    // Testable race boundary: production callers never inject this hook. The descriptor is opened
    // with O_NOFOLLOW where the host provides it and then identity-bound to the earlier lstat.
    await beforeFileOpen?.({ source, displayPath });
    handle = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino
        || opened.size !== info.size || opened.mtimeNs !== info.mtimeNs
        || opened.ctimeNs !== info.ctimeNs) {
      throw new SingularityFlowError(
        `Document path changed while it was being captured: ${displayPath}`,
        { code: 'STORY_DOCUMENT_CHANGED' }
      );
    }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new SingularityFlowError(
        `Document changed while it was being captured: ${displayPath}`,
        { code: 'STORY_DOCUMENT_CHANGED' }
      );
    }
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Document path could not be read: ${displayPath}: ${error.message}`, {
      code: 'STORY_DOCUMENT_UNREADABLE', cause: error
    });
  } finally {
    await handle?.close().catch(() => {});
  }
  // Size is checked again against the bytes actually captured. A file that grows between lstat and
  // read must not bypass the admission limit.
  if (bytes.byteLength > maxFileBytes) {
    throw new SingularityFlowError(`Document exceeds the ${maxFileBytes} byte limit: ${displayPath}`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  evidence.push(Object.freeze({
    source: path.resolve(source),
    captured: destination,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: type
  }));
}

async function captureDocumentPath(
  source, destination, policy, evidence, displayPath = source, requireNonEmpty = true, depth = 0
) {
  admitStoryDocumentResource(policy.budget, { depth, label: displayPath });
  const info = await lstat(source, { bigint: true }).catch(() => null);
  if (!info || info.isSymbolicLink()) {
    throw new SingularityFlowError(`Document path is not a regular file or directory: ${displayPath}`);
  }
  if (info.isFile()) {
    await captureRegularFile(source, destination, {
      ...policy, evidence, displayPath, depth
    });
    return 1;
  }
  if (!info.isDirectory()) {
    throw new SingularityFlowError(`Document path is not a regular file or directory: ${displayPath}`);
  }
  const assertDirectoryIdentity = async () => {
    const current = await lstat(source, { bigint: true }).catch(() => null);
    if (!current?.isDirectory() || current.isSymbolicLink()
        || current.dev !== info.dev || current.ino !== info.ino
        || current.mtimeNs !== info.mtimeNs || current.ctimeNs !== info.ctimeNs) {
      throw new SingularityFlowError(
        `Document directory changed while it was being captured: ${displayPath}`,
        { code: 'STORY_DOCUMENT_CHANGED' }
      );
    }
  };
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let count = 0;
  let entries;
  try {
    await policy.beforeDirectoryRead?.({ source, displayPath });
    await assertDirectoryIdentity();
    entries = await readdir(source, { withFileTypes: true });
    await assertDirectoryIdentity();
  }
  catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Document directory could not be read: ${displayPath}: ${error.message}`, {
      code: 'STORY_DOCUMENT_UNREADABLE', cause: error
    });
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await assertDirectoryIdentity();
    const childSource = path.join(source, entry.name);
    const childDestination = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SingularityFlowError(`Document directories cannot contain symbolic links: ${childSource}`);
    }
    count += await captureDocumentPath(
      childSource, childDestination, policy, evidence, childSource, false, depth + 1
    );
    await assertDirectoryIdentity();
  }
  if (requireNonEmpty && !count) {
    throw new SingularityFlowError(`Document directory contains no regular files: ${displayPath}`);
  }
  return count;
}

/**
 * Validate and freeze Story-birth evidence before any governed Story commit is attempted.
 *
 * Local bytes are copied into a leased private snapshot under the repository Git common directory
 * and publication reads only that snapshot. This gives crash recovery a bounded, repository-local
 * scavenging boundary without leaving exact input bytes in the operating-system temporary folder.
 * URLs are syntax-validated without network access: start must not fetch arbitrary web content merely
 * to decide whether it can create a Story. Callers must dispose the returned capture in `finally`.
 */
export async function preflightInitialStoryDocuments(inputs = [], {
  repositoryRoot = null,
  maxFileBytes = DEFAULT_MAX_DOCUMENT_BYTES,
  maxFiles = STORY_DOCUMENT_RESOURCE_LIMITS.maxFiles,
  maxTotalBytes = STORY_DOCUMENT_RESOURCE_LIMITS.maxTotalBytes,
  maxDepth = STORY_DOCUMENT_RESOURCE_LIMITS.maxDepth,
  allowedMimeTypes = null,
  beforeFileOpen = null,
  beforeDirectoryRead = null
} = {}) {
  if (!inputs.length) return Object.freeze({ inputs: [], evidence: [], dispose: async () => {} });
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new SingularityFlowError('Story document byte limit must be a positive integer.');
  }
  const hasLocalFiles = inputs.some((rawInput) => {
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? rawInput : {};
    const candidates = input.files ?? (input.type === 'file' ? [input.path] : []);
    return Array.isArray(candidates) && candidates.length > 0;
  });
  if (hasLocalFiles && (typeof repositoryRoot !== 'string' || !repositoryRoot.trim())) {
    throw new SingularityFlowError(
      'Story document capture requires the verified repository root.',
      { code: 'STORY_DOCUMENT_CAPTURE_REPOSITORY_REQUIRED' }
    );
  }
  const allowlist = allowedMimeTypes == null ? null : [...new Set(allowedMimeTypes.map(String))];
  const budget = createStoryDocumentBudget({ maxFiles, maxTotalBytes, maxDepth });
  const capture = hasLocalFiles ? await createStoryDocumentCapture(repositoryRoot) : null;
  const captureRoot = capture?.data ?? null;
  const prepared = [];
  const evidence = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await capture?.dispose();
  };
  try {
    for (const [inputIndex, rawInput] of inputs.entries()) {
      const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? rawInput : {};
      const url = input.url ?? (input.type === 'url' ? input.value : null);
      if (url != null) {
        validateDocumentUrl(url);
        admitStoryDocumentResource(budget, { depth: 0, size: 0, label: 'URL reference' });
      }
      const candidates = input.files ?? (input.type === 'file' ? [input.path] : []);
      if (!Array.isArray(candidates)) {
        throw new SingularityFlowError('Story document files must be an array of paths.');
      }
      if (!candidates.length && url == null) {
        throw new SingularityFlowError('Provide one or more files or --url <https-url>.');
      }
      const capturedFiles = [];
      const firstEvidenceIndex = evidence.length;
      for (const [fileIndex, candidate] of candidates.entries()) {
        if (typeof candidate !== 'string' || !candidate.trim()) {
          throw new SingularityFlowError('Document path is not a regular file or directory:');
        }
        const source = path.resolve(candidate);
        const destination = path.join(
          captureRoot, String(inputIndex), String(fileIndex), path.basename(source)
        );
        await captureDocumentPath(source, destination, {
          maxFileBytes, allowedMimeTypes: allowlist, beforeFileOpen, beforeDirectoryRead, budget
        }, evidence, candidate);
        capturedFiles.push(destination);
      }
      const preparedInput = {
        ...input,
        ...(url == null ? {} : { url }),
        files: Object.freeze(capturedFiles)
      };
      Object.defineProperty(preparedInput, CAPTURE_BINDINGS, {
        value: Object.freeze(evidence.slice(firstEvidenceIndex)),
        enumerable: false,
        configurable: false,
        writable: false
      });
      prepared.push(Object.freeze(preparedInput));
    }
    return Object.freeze({
      inputs: Object.freeze(prepared),
      evidence: Object.freeze(evidence),
      captureDirectory: capture?.directory ?? null,
      dispose
    });
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}

/**
 * Publish every document supplied at Story birth in one governed transaction.
 *
 * Each input retains its own label/kind semantics, but the manifest and lifecycle event are
 * committed once. This keeps exact document IDs in the finalized event while avoiding one remote
 * push per attachment.
 */
export async function publishInitialStoryDocuments(root, config, workflow, {
  workId = workflow.workItem.id,
  inputs = [],
  operation = 'supporting-document-upload'
} = {}) {
  if (!inputs.length) return [];
  let records = [];
  await commitAndPublish(
    root,
    config,
    workflow,
    { type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, payload: { operation } },
    `[${workId}][documents][upload] supporting evidence`,
    [],
    {
      beforeStateWrite: async () => {
        records = await stageInitialStoryDocuments(root, config, workflow, { inputs });
        return records;
      },
      eventFromResult: (created) => ({
        payload: {
          operation,
          ...documentSetLifecycleBinding(created ?? [])
        }
      })
    }
  );
  return records;
}

/**
 * Add frozen Story-birth evidence to an already-open lifecycle transaction.
 *
 * Story creation uses this hook inside its opening publication so the branch can never contain a
 * durable Story without the supporting evidence the operator supplied. The standalone publisher
 * above reuses the same write path for compatibility callers that already own a Story.
 */
export async function stageInitialStoryDocuments(root, config, workflow, {
  inputs = [], requireFrozen = false
} = {}) {
  const records = [];
  for (const input of inputs) {
    const frozenEvidence = input?.[CAPTURE_BINDINGS] ?? null;
    if (requireFrozen && (input?.files?.length ?? 0) > 0 && !frozenEvidence) {
      throw new SingularityFlowError(
        'Story supporting documents must be captured and integrity-bound before publication.',
        { code: 'STORY_DOCUMENT_CAPTURE_REQUIRED' }
      );
    }
    records.push(...await addDocuments(root, config, workflow, {
      files: input.files ?? (input.type === 'file' ? [input.path] : []),
      url: input.url ?? null,
      label: input.label ?? null,
      kind: input.kind ?? null,
      frozenEvidence
    }));
  }
  return records;
}
