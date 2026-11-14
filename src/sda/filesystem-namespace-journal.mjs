/** Explicit local-filesystem storage. Immutable, fsynced entries have a single no-overwrite link point. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { NAMESPACE_STORAGE_SCHEMAS, admitNamespaceStorageSchema } from './namespace/storage-schemas.mjs';
import {
  exactObject, namespaceError, namespaceScope
} from './namespace/values.mjs';
import { namespaceBinding, namespaceLimits, assertNamespaceBinding, assertNamespaceNotCancelled } from './namespace/contract.mjs';
import { namespaceTransaction, namespaceTransactionIdentity } from './namespace/transaction.mjs';
import { applyNamespaceTransaction, emptyNamespaceState } from './namespace/state-transition.mjs';
import { NAMESPACE_JOURNAL_PORT } from './namespace/journal-contract.mjs';

const FORMAT = 'sflow-filesystem-namespace/v1';
const MAX_FILE_BYTES = 1_048_576;
const READ_BATCH_SIZE = 8;
const FILE = /^([0-9]{20})\.json$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isMissing = error => error?.code === 'ENOENT';
const isNamespaceError = error => typeof error?.code === 'string' && error.code.startsWith('SDA_NAMESPACE_');
const LINK_REFUSED = new Set(['EACCES', 'EPERM', 'ENOENT', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL',
  'EROFS', 'ENOSPC', 'EDQUOT', 'EMLINK']);
const corrupt = (message, cause) => namespaceError(message, 'SDA_NAMESPACE_CORRUPT', { stage: 'journal-read' }, cause);
const unavailable = (stage, cause) => isNamespaceError(cause) ? cause
  : namespaceError('The namespace filesystem did not complete the operation.', 'SDA_NAMESPACE_UNAVAILABLE', {
    stage, timedOut: cause?.code === 'ETIMEDOUT'
  }, cause);

async function directory(file, { create = false } = {}) {
  if (create) await mkdir(file, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt('A namespace storage directory is not an ordinary directory.');
}

async function readJsonBytes(file) {
  let handle;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) throw corrupt('A namespace entry is not an ordinary file.');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw corrupt('A namespace entry changed identity or exceeds its storage bound.');
    }
    const bytes = await handle.readFile();
    // Retain the existing UTF-8 length check, including its malformed-input behavior.
    if (Buffer.byteLength(bytes.toString('utf8')) !== stat.size) throw corrupt('A namespace entry changed while being read.');
    return bytes;
  } finally { await handle?.close(); }
}
function parseJsonBytes(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (cause) { throw corrupt('A namespace entry contains invalid JSON.', cause); }
}
async function readJson(file) { return parseJsonBytes(await readJsonBytes(file)); }

async function syncDirectory(file) {
  const handle = await open(file, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** File content is durable before its atomic link becomes visible. Never overwrite a winning slot. */
async function stageJson(directoryPath, value) {
  const file = path.join(directoryPath, `${randomUUID()}.pending`);
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(file).catch(() => {}); throw error; }
  await handle.close();
  return file;
}

function validateManifest(manifest, binding, limits) {
  let storedBinding, storedLimits;
  try {
    exactObject(manifest, ['schemaVersion', 'format', 'storeId', 'binding', 'limits', 'cursorKey']);
    storedBinding = namespaceBinding(manifest.binding);
    storedLimits = namespaceLimits(manifest.limits);
    admitNamespaceStorageSchema('manifest', manifest);
    if (manifest.format !== FORMAT || !UUID.test(manifest.storeId)
      || typeof manifest.cursorKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(manifest.cursorKey)) {
      throw new Error('Manifest format does not match.');
    }
  } catch (cause) {
    if (cause.code === 'SDA_NAMESPACE_UNSUPPORTED') throw cause;
    throw corrupt('The namespace store manifest is invalid.', cause);
  }
  if (!same(storedBinding, binding) || Object.keys(storedLimits)
    .some(key => key !== 'maxPage' && storedLimits[key] !== limits[key])) {
    throw namespaceError('The requested binding or record/transaction limits do not match this store.');
  }
  return manifest;
}

/** New stores are opt-in. Existing Git checkouts and installed authority are never selected here. */
export async function openFilesystemNamespaceJournal({ root, binding, create = false, limits }) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || typeof create !== 'boolean') {
    throw namespaceError('Filesystem namespace storage requires an explicit absolute root and create policy.');
  }
  const normalizedBinding = namespaceBinding(binding);
  const normalizedLimits = namespaceLimits(limits);
  limits = normalizedLimits;
  let canonicalRoot, manifest;
  try {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    await directory(root);
    canonicalRoot = await realpath(root);
    const manifestFile = path.join(canonicalRoot, 'store.json');
    try { manifest = await readJson(manifestFile); }
    catch (error) {
      if (!create || !isMissing(error)) throw error;
      const entries = await readdir(canonicalRoot);
      if (entries.includes('store.json')) {
        manifest = await readJson(manifestFile);
      } else {
        if (entries.some(name => !/^[a-f0-9-]{36}\.pending$/u.test(name))) {
          throw namespaceError('Refusing to initialize namespace storage over existing files.');
        }
        const candidate = { schemaVersion: NAMESPACE_STORAGE_SCHEMAS.manifest.currentVersion, format: FORMAT, storeId: randomUUID(),
          binding: normalizedBinding, limits: normalizedLimits, cursorKey: randomBytes(32).toString('base64url') };
        const pending = await stageJson(canonicalRoot, candidate);
        try { await link(pending, manifestFile); await syncDirectory(canonicalRoot); }
        catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
        finally { await unlink(pending).catch(() => {}); }
        manifest = await readJson(manifestFile);
      }
    }
    validateManifest(manifest, normalizedBinding, normalizedLimits);
    if (create) await syncDirectory(canonicalRoot);
  } catch (cause) { throw unavailable('store-open', cause); }
  const manifestBytes = JSON.stringify(manifest);
  // Byte-verified memoization, not an advisory read cache. Every call still opens every
  // observed entry and checks its complete current bytes before reusing replay work.
  const replayPrefixes = new Map();
  const maximumReplayBytes = 8 * 1024 * 1024, maximumReplayProjects = 8, maximumReplayFiles = 16_384;
  let retainedReplayBytes = 0;
  function forgetReplay(projectId) {
    const previous = replayPrefixes.get(projectId);
    if (previous) { retainedReplayBytes -= previous.bytes; replayPrefixes.delete(projectId); }
  }
  function rememberReplay(projectId, value) {
    const bytes = Buffer.byteLength(JSON.stringify({records:[...value.state.records],events:[...value.state.events],
      operations:[...value.state.operations]})) + value.fingerprints.length * 128;
    forgetReplay(projectId);
    if (bytes > maximumReplayBytes) return;
    while (replayPrefixes.size >= maximumReplayProjects || retainedReplayBytes + bytes > maximumReplayBytes) {
      forgetReplay(replayPrefixes.keys().next().value);
    }
    replayPrefixes.set(projectId, {...value, bytes}); retainedReplayBytes += bytes;
  }

  const projectDirectory = scope => path.join(canonicalRoot, `project-${hash(JSON.stringify(namespaceScope(scope)))}`);

  async function checkManifest() {
    const observed = await readJson(path.join(canonicalRoot, 'store.json'));
    validateManifest(observed, normalizedBinding, normalizedLimits);
    if (JSON.stringify(observed) !== manifestBytes) throw corrupt('The namespace store identity changed while it was open.');
  }

  async function projectPaths(scope, createProject) {
    const project = projectDirectory(scope), commits = path.join(project, 'commits'), staging = path.join(project, 'staging');
    if (createProject) {
      try { await directory(project); }
      catch (error) {
        if (!isMissing(error)) throw error;
        const candidate = `${project}.init-${randomUUID()}`;
        await directory(candidate, { create: true });
        try {
          await directory(path.join(candidate, 'commits'), { create: true });
          await directory(path.join(candidate, 'staging'), { create: true });
          await syncDirectory(candidate);
          try { await rename(candidate, project); }
          catch (cause) { if (!['EEXIST', 'ENOTEMPTY'].includes(cause.code)) throw cause; }
          await syncDirectory(canonicalRoot);
        } finally { await rm(candidate, { recursive: true, force: true }); }
      }
      await directory(project);
      await directory(commits);
      await directory(staging);
    } else {
      try { await directory(project); }
      catch (error) { if (isMissing(error)) return null; throw error; }
      await directory(commits);
    }
    return { project, commits, staging };
  }

  async function readVerified(scope, through, useReplay) {
    try {
      const normalizedScope = namespaceScope(scope);
      await checkManifest();
      const paths = await projectPaths(normalizedScope, false);
      let state = emptyNamespaceState(), sha256 = null, sequence = 0;
      if (!paths) {
        if (through !== null && through !== 0) throw corrupt('The requested namespace snapshot is missing.');
        return { scope: normalizedScope, state, sha256, sequence };
      }
      const files = (await readdir(paths.commits)).sort();
      if (files.some(name => !FILE.test(name))) throw corrupt('The namespace journal contains an unrecognized entry.');
      const projectId = normalizedScope.projectId;
      const previous = useReplay && files.length <= maximumReplayFiles ? replayPrefixes.get(projectId) : null;
      const cached = previous && previous.sequence <= files.length && (through === null || through >= previous.sequence) ? previous : null;
      if (cached) state = cached.state;
      const revisions = new Set(cached?.revisions ?? []), fingerprints = [];
      let observedBytes = 0;
      const selectedFiles = through === null ? files : files.slice(0, through);
      for (let offset = 0; offset < selectedFiles.length; offset += READ_BATCH_SIZE) {
        // File I/O is independent. Interpret each result in sequence so the original
        // first integrity/read error, digest chain and snapshot boundary stay exact.
        const batch = await Promise.allSettled(selectedFiles.slice(offset, offset + READ_BATCH_SIZE)
          .map(file => readJsonBytes(path.join(paths.commits, file))));
        for (const [index, observed] of batch.entries()) {
          const file = selectedFiles[offset + index];
          if (Number(FILE.exec(file)[1]) !== sequence + 1) throw corrupt('The namespace journal has a missing or invalid sequence.');
          if (observed.status === 'rejected') throw observed.reason;
          const bytes = observed.value;
          observedBytes += bytes.byteLength;
          const fingerprint = hash(bytes);
          if (files.length <= maximumReplayFiles) fingerprints.push(fingerprint);
          if (cached && sequence < cached.sequence) {
            if (fingerprint !== cached.fingerprints[sequence]) {
              forgetReplay(projectId);
              // Preserve existing interpretation of changed valid bytes; never serve the old view.
              return await readVerified(scope, through, false);
            }
            sequence += 1;
            if (sequence === cached.sequence) sha256 = cached.sha256;
            continue;
          }
          const envelope = parseJsonBytes(bytes);
          let applied;
          try {
            exactObject(envelope, ['body', 'sha256']);
            const { body } = envelope;
            exactObject(body, ['schemaVersion', 'storeId', 'binding', 'scope', 'sequence', 'previousSha256', 'revision', 'transaction']);
            if (envelope.sha256 !== hash(JSON.stringify(body))) throw new Error('Journal digest mismatch.');
            admitNamespaceStorageSchema('entry', body);
            if (body.storeId !== manifest.storeId
              || !same(namespaceBinding(body.binding), normalizedBinding) || !same(namespaceScope(body.scope), normalizedScope)
              || body.sequence !== sequence + 1 || body.previousSha256 !== sha256
              || typeof body.revision !== 'string' || !body.revision.startsWith('fs:') || !UUID.test(body.revision.slice(3))
              || revisions.has(body.revision)) throw new Error('Journal integrity or binding mismatch.');
            const transaction = namespaceTransaction(body.transaction, limits);
            for (const item of [...transaction.preconditions, ...transaction.changes, ...transaction.events]) {
              assertNamespaceBinding({ binding: normalizedBinding }, item.namespace);
            }
            const identity = namespaceTransactionIdentity(normalizedScope, transaction, limits);
            applied = applyNamespaceTransaction(state, normalizedScope, transaction, {
              revision: body.revision, requestDigest: hash(identity), limits
            });
            if (applied.replayed) throw new Error('A duplicate operation was appended as another transaction.');
            revisions.add(body.revision);
          } catch (cause) {
            if (cause.code === 'SDA_NAMESPACE_UNSUPPORTED') throw cause;
            throw corrupt('The namespace journal failed integrity or transaction validation.', cause);
          }
          state = applied.state; sequence += 1; sha256 = envelope.sha256;
        }
      }
      if (through !== null && sequence !== through) throw corrupt('The requested namespace snapshot is no longer present.');
      if (through === null) {
        if (files.length > maximumReplayFiles || observedBytes > maximumReplayBytes) forgetReplay(projectId);
        else if (cached && cached.sequence === sequence && cached.sha256 === sha256) {
          replayPrefixes.delete(projectId); replayPrefixes.set(projectId, cached);
        } else rememberReplay(projectId, {state, sha256, sequence, fingerprints, revisions});
      }
      // The trusted journal caller receives a detached view, never the retained memoized Maps.
      return { scope: normalizedScope, state: structuredClone(state), sha256, sequence };
    } catch (cause) { throw unavailable('journal-read', cause); }
  }

  const read = (scope, {through = null} = {}) => readVerified(scope, through, true);

  async function append(scope, observed, transaction, { signal } = {}) {
    const normalizedScope = namespaceScope(scope);
    transaction = namespaceTransaction(transaction, limits);
    for (const value of [...transaction.preconditions, ...transaction.changes, ...transaction.events]) {
      assertNamespaceBinding({ binding: normalizedBinding }, value.namespace);
    }
    const revision = `fs:${randomUUID()}`;
    const applied = applyNamespaceTransaction(observed.state, normalizedScope, transaction, {
      revision, requestDigest: hash(namespaceTransactionIdentity(normalizedScope, transaction, limits)), limits
    });
    if (applied.replayed) return { accepted: true, ...applied };
    let pending, linked = false, linkAttempted = false;
    try {
      await checkManifest();
      const paths = await projectPaths(normalizedScope, true);
      const sequence = observed.sequence + 1;
      if (!Number.isSafeInteger(sequence)) throw namespaceError('The namespace journal exhausted its sequence range.', 'SDA_NAMESPACE_UNAVAILABLE');
      const body = { schemaVersion: NAMESPACE_STORAGE_SCHEMAS.entry.currentVersion, storeId: manifest.storeId, binding: normalizedBinding, scope: normalizedScope,
        sequence, previousSha256: observed.sha256, revision, transaction };
      pending = await stageJson(paths.staging, { body, sha256: hash(JSON.stringify(body)) });
      assertNamespaceNotCancelled(signal);
      linkAttempted = true;
      try { await link(pending, path.join(paths.commits, `${String(sequence).padStart(20, '0')}.json`)); linked = true; }
      catch (cause) { if (cause.code === 'EEXIST') return { accepted: false }; throw cause; }
      await syncDirectory(paths.commits);
      return { accepted: true, ...applied };
    } catch (cause) {
      if (linked || (linkAttempted && !LINK_REFUSED.has(cause?.code))) {
        throw namespaceError('The namespace transaction may have committed; inspect its operation before retrying.',
          'SDA_NAMESPACE_OUTCOME_UNKNOWN', { operationId: transaction.operationId,
            stage: linked ? 'durability' : 'publication', timedOut: cause?.code === 'ETIMEDOUT' }, cause);
      }
      throw unavailable('journal-commit', cause);
    } finally { if (pending) await unlink(pending).catch(() => {}); }
  }

  return Object.freeze({
    contract: NAMESPACE_JOURNAL_PORT,
    manifest: Object.freeze({ storeId: manifest.storeId, binding: normalizedBinding, cursorKey: manifest.cursorKey }),
    read, append,
    async confirm(scope) {
      try {
        await checkManifest();
        const paths = await projectPaths(scope, false);
        if (paths) await syncDirectory(paths.commits);
      } catch (cause) { throw unavailable('operation-inspection', cause); }
    }
  });
}
