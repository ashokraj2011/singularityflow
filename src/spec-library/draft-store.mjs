/**
 * Specification drafts: the one editable copy of a specification on this clone (SPEC-SPA v1.3 §8,
 * v1.2 REQ-006 to REQ-008).
 *
 * `<git common dir>/singularity-flow/spec-drafts/<SPEC-ID>/<NNNNNN>.json`, record family `spec-draft`.
 * Every linked worktree of the clone shares it, and it is never in a commit. Each save is one
 * immutable snapshot holding the whole draft (prose, gap events, research items, checklist
 * decisions), written the way configuration drafts are: a synced temporary file linked into place,
 * then the directory synced, so after a crash a snapshot is either absent or complete. The draft's
 * head is the highest-numbered snapshot that verifies against its own digest.
 *
 * Every save names an operation: the same operation with the same payload returns the snapshot
 * already saved, the same operation with a different payload is refused, and a stale expected
 * sequence is refused with the draft unchanged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { prepareSharedPublicationStorage, sharedPublicationStorageDirectory } from '../publication-storage.mjs';
import { canonicalJson } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError, writeAtomic } from '../util.mjs';
import { requireSpecId, validSpecId } from './ids.mjs';

export const DRAFT_FAMILY = 'spec-draft';
const DIRECTORY = 'spec-drafts';
const SNAPSHOT = /^(\d{6})\.json$/u;
const TEMPORARY_FILE = /^\..+\.tmp$/u;
const LOCK_WAIT_MS = 30_000;
const LINKLESS_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL']);
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

// Test-only crash injection: the process dies at once, with no cleanup of any kind.
export function crashPoint(point) {
  if (process.env.NODE_ENV !== 'test' || process.env.SINGULARITY_FLOW_TEST_CRASH_AT !== point) return;
  process.kill(process.pid, 'SIGKILL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
}

export function draftsRoot(root) {
  return sharedPublicationStorageDirectory(root, DIRECTORY);
}

export function newOperationId(prefix = 'spo') {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

export function requireOperationId(value) {
  if (!OPERATION_ID.test(String(value ?? ''))) {
    fail(`--operation-id '${value ?? ''}' is not an operation ID: use letters, digits, '.', '_', ':' or '-', up to 128 characters.`,
      'SPEC_OPERATION_ID_INVALID', { operationId: value ?? null });
  }
  return value;
}

/** The digest a snapshot carries: every field but the digest itself, in canonical form. */
export function snapshotDigest(record) {
  const { snapshotSha256: _omitted, ...body } = record;
  return sha256(canonicalJson(body));
}

export function payloadDigest(operation, payload) {
  return sha256(canonicalJson({ operation, payload: payload ?? null }));
}

async function syncDirectory(directory) {
  // POSIX file plus directory fsync makes a link durable. Some Windows and network filesystems
  // cannot open or sync a directory; the atomic link or rename and the file sync remain.
  let handle = null;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error?.code)) throw error; }
  finally { await handle?.close(); }
}

/** Write `text` as `name` whole and never over an existing file: a synced temporary file, linked into place. */
async function publishSnapshotFile(directory, name, text) {
  const file = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  crashPoint('spec-draft-publish');
  try {
    try { await link(temporary, file); }
    catch (error) {
      if (!LINKLESS_CODES.has(error?.code)) throw error;
      // A filesystem without links gets a rename; the lock and the sequence check keep it from replacing anything.
      if (await lstat(file).catch((cause) => (missing(cause) ? null : Promise.reject(cause)))) {
        fail(`A draft snapshot ${file} appeared while it was being written; nothing was replaced.`, 'SPEC_DRAFT_CONFLICT', { file });
      }
      await rename(temporary, file);
    }
  } finally { await rm(temporary, { force: true }); }
  await syncDirectory(directory);
}

async function readSnapshot(file, specId) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
  let record;
  try { readRecord(DRAFT_FAMILY, text); record = JSON.parse(text); } // Verify the original signed/hash-bound bytes, not a migrated projection.
  catch (error) {
    // A snapshot a newer build wrote is refused with the upgrade, never treated as damaged.
    if (error?.code === 'SCHEMA_VERSION_FUTURE') throw error;
    return { damaged: true, reason: error.message };
  }
  if (record.specId !== specId || record.snapshotSha256 !== snapshotDigest(record)) {
    return { damaged: true, reason: 'its digest does not match its contents' };
  }
  return { damaged: false, record };
}

/** Every snapshot file of one draft, in sequence order, each verified. */
async function readSnapshots(directory, specId) {
  const names = await readdir(directory).catch((error) => (missing(error) ? null : Promise.reject(error)));
  if (!names) return [];
  const snapshots = [];
  for (const name of names.filter((entry) => SNAPSHOT.test(entry)).sort()) {
    const file = path.join(directory, name);
    const read = await readSnapshot(file, specId);
    if (read) snapshots.push({ sequence: Number(SNAPSHOT.exec(name)[1]), file, ...read });
  }
  return snapshots;
}

/** Rebuildable local index, never an alternative to the immutable snapshot bytes. */
const INDEX_FILE = 'index.json';
const indexRow = record => ({ sequence: record.sequence, operationId: record.operationId,
  payloadDigest: record.payloadDigest, snapshotSha256: record.snapshotSha256 });
const snapshotName = sequence => String(sequence).padStart(6, '0') + '.json';
const inventoryDigest = names => sha256(names.join('\n'));
async function indexedDraft(directory, specId) {
  const names = (await readdir(directory).catch(error => missing(error) ? [] : Promise.reject(error))).filter(name => SNAPSHOT.test(name)).sort();
  let text;
  try { text = await readFile(path.join(directory, INDEX_FILE), 'utf8'); }
  catch (error) { if (missing(error) || ['EACCES', 'EPERM', 'EISDIR'].includes(error?.code)) return { names, index: null }; throw error; }
  try {
    const index = readRecord('spec-draft-index', text).record;
    const { indexSha256, ...core } = index;
    if (index.specId !== specId || indexSha256 !== sha256(canonicalJson(core)) || index.inventorySha256 !== inventoryDigest(names)
        || !Array.isArray(index.rows) || !Array.isArray(index.damaged) || index.rows.length + index.damaged.length !== names.length
        || !index.rows.every(row => Number.isSafeInteger(row.sequence) && row.sequence > 0 && OPERATION_ID.test(row.operationId)
          && /^sha256:[a-f0-9]{64}$/u.test(row.snapshotSha256) && /^sha256:[a-f0-9]{64}$/u.test(row.payloadDigest))
        || !index.damaged.every(item => SNAPSHOT.test(item.name) && typeof item.reason === 'string')) return { names, index: null };
    const latest = index.rows.at(-1);
    const read = latest ? await readSnapshot(path.join(directory, snapshotName(latest.sequence)), specId) : null;
    if (latest && (!read || read.damaged || read.record.snapshotSha256 !== latest.snapshotSha256 || read.record.sequence !== latest.sequence)) return { names, index: null };
    const head = read?.record ?? null;
    return { names, index, view: { specId, head, sequence: head?.sequence ?? 0, historyChecked: false,
      highestFile: names.length ? Number(SNAPSHOT.exec(names.at(-1))[1]) : 0,
      snapshots: head ? [head] : [], damaged: index.damaged.map(item => ({ file: path.join(directory, item.name), reason: item.reason })) } };
  } catch (error) {
    // An absent, torn or newer cache is ignored. Real snapshot read/permission errors remain errors.
    if (missing(error) || error instanceof SyntaxError || typeof error?.code === 'string' && error.code.startsWith('SCHEMA_')) return { names, index: null };
    throw error;
  }
}

async function writeDraftIndex(directory, specId, view, previousNames, record) {
  const core = { schemaVersion: currentSchemaVersion('spec-draft-index'), specId,
    inventorySha256: inventoryDigest([...previousNames, snapshotName(record.sequence)].sort()),
    rows: [...view.rows, indexRow(record)],
    damaged: view.damaged.map(item => ({ name: path.basename(item.file), reason: item.reason })) };
  await writeAtomic(path.join(directory, INDEX_FILE), canonicalJson({ ...core, indexSha256: sha256(canonicalJson(core)) }), { mode: 0o600 });
}

function draftView(specId, snapshots) {
  const valid = snapshots.filter((entry) => !entry.damaged && entry.record.sequence === entry.sequence);
  const head = valid.at(-1)?.record ?? null;
  return {
    specId,
    head,
    sequence: head?.sequence ?? 0,
    highestFile: snapshots.at(-1)?.sequence ?? 0,
    snapshots: valid.map((entry) => entry.record),
    damaged: snapshots.filter((entry) => entry.damaged || entry.record?.sequence !== entry.sequence)
      .map((entry) => ({ file: entry.file, reason: entry.reason ?? 'its sequence does not match its name' }))
  };
}

/** One draft on this clone, or null when there is none. */
export async function readDraft(root, specId, { headOnly = false } = {}) {
  requireSpecId(specId);
  const directory = path.join(draftsRoot(root), specId);
  const indexed = headOnly ? await indexedDraft(directory, specId) : null;
  const view = indexed?.view ?? draftView(specId, await readSnapshots(directory, specId));
  return view.head || view.damaged.length ? view : null;
}

/** Every draft on this clone, by specification ID. With `unreadable`, a draft that cannot be read goes there instead of failing the list. */
export async function listDrafts(root, { unreadable = null, ...options } = {}) {
  const names = await readdir(draftsRoot(root)).catch((error) => (missing(error) ? [] : Promise.reject(error)));
  const drafts = [];
  for (const name of names.filter(validSpecId).sort()) {
    try {
      const draft = await readDraft(root, name, options);
      if (draft) drafts.push(draft);
    } catch (error) {
      if (!unreadable) throw error;
      unreadable.push({ specId: name, record: 'local draft', code: error.code ?? null, message: error.message });
    }
  }
  return drafts;
}

async function withDraftLock(root, specId, work) {
  const { withSubjectLock } = await import('../subject-lock.mjs');
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  for (let pause = 10; ; pause = Math.min(pause * 2, 250)) {
    let entered = false;
    try {
      return await withSubjectLock(root, { kind: 'spec-draft', id: specId }, async () => {
        entered = true;
        const parent = await prepareSharedPublicationStorage(root, DIRECTORY, 'Specification drafts');
        const directory = path.join(parent, specId);
        try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) fail(`Specification draft storage must be a real directory: ${directory}`, 'SPEC_DRAFT_STORAGE_UNSAFE', { directory });
        // Only a writer holding the lock creates temporary files, so any the next holder finds is an orphan.
        const orphans = (await readdir(directory)).filter((name) => TEMPORARY_FILE.test(name));
        for (const name of orphans) await rm(path.join(directory, name), { force: true });
        return work(directory);
      });
    } catch (error) {
      if (entered || error?.code !== 'SUBJECT_LOCK_BUSY' || Date.now() >= giveUpAt) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pause + Math.floor(Math.random() * pause)));
  }
}

/**
 * Local history retention (SPEC-SPA section 5.4). Autosave writes a whole snapshot per save, so a long
 * draft's history would grow without bound. Only ordinary wording saves are ever removed, and only
 * after these protections: the head, every other kind of snapshot (decisions, accepted proposals,
 * sources, publications), the sequence the shared basis names, the newest saves, and the last save of
 * each older hour. The head holds the wording, so no unsynchronized work is lost by removing the rest.
 */
const RETAINED_RECENT_SAVES = 200;
const RETENTION_BATCH = 50;
const retainedRecentSaves = (env = process.env) => {
  const configured = Number(env.SINGULARITY_FLOW_SPEC_HISTORY_RECENT);
  return Number.isSafeInteger(configured) && configured >= 20 ? configured : RETAINED_RECENT_SAVES;
};
export function retentionPlan(snapshots, { protectedSequences = [], recent = retainedRecentSaves() } = {}) {
  const head = snapshots.at(-1)?.sequence;
  const saves = snapshots.filter((snapshot) => snapshot.operation === 'edit');
  const newest = new Set(saves.slice(-recent).map((snapshot) => snapshot.sequence));
  const lastOfHour = new Map(saves.map((snapshot) => [String(snapshot.savedAt).slice(0, 13), snapshot.sequence]));
  const hourly = new Set(lastOfHour.values());
  const retain = [], remove = [];
  for (const { sequence, operation, savedAt } of snapshots) {
    const reason = sequence === head ? 'current version' : operation !== 'edit' ? operation
      : protectedSequences.includes(sequence) ? 'shared basis' : newest.has(sequence) ? 'recent save' : hourly.has(sequence) ? 'last save of its hour' : null;
    if (reason) retain.push({ sequence, reason }); else remove.push({ sequence, savedAt });
  }
  return { recent, retain, remove };
}

async function protectedDraftSequences(root, specId) {
  const basis = await (await import('./shared-basis.mjs')).sharedBasis(root, specId);
  return Number.isSafeInteger(basis?.localSequence) ? [basis.localSequence] : [];
}

/** What the next retention pass would remove from this draft and what it keeps: a read. */
export async function draftRetentionPreview(root, specId, view) {
  return retentionPlan(view.snapshots, { protectedSequences: await protectedDraftSequences(root, specId) });
}

/** One pass, every RETENTION_BATCH saves past the bound, holding the draft lock. Its failure never undoes a save. */
async function thinDraftHistory(root, specId, directory, rows) {
  if (rows.length < retainedRecentSaves() + RETENTION_BATCH || rows.at(-1).sequence % RETENTION_BATCH) return;
  const read = await readSnapshots(directory, specId);
  if (read.some((entry) => entry.damaged)) return;
  const { remove } = retentionPlan(read.map((entry) => entry.record), { protectedSequences: await protectedDraftSequences(root, specId) });
  for (const { sequence } of remove) await rm(path.join(directory, snapshotName(sequence)), { force: true });
  if (remove.length) await syncDirectory(directory);
}

/** The fields a person's wording save replaces. Staged proposals, sources, research and decisions are others. */
export const sameWording = (left, right) => left.spec === right.spec && left.title === right.title && (left.kind ?? null) === (right.kind ?? null);

/**
 * Save the next snapshot of a draft.
 *
 * `change(draft)` receives a copy of the head's draft (null when `create`) and returns the whole new
 * draft; it may refuse by throwing. A replayed operation returns the snapshot it saved before.
 * `wordingBasis` is for a change that only replaces wording: an expected sequence that is behind the
 * head is not stale while the wording at it still matches the head's, because every snapshot since
 * changed something this save keeps.
 */
export async function saveDraft(root, specId, {
  operationId, operation, payload = null, expectedSequence = null, wordingBasis = false, create = false, actor = null, change
}) {
  requireSpecId(specId);
  requireOperationId(operationId);
  const digest = payloadDigest(operation, payload);
  return withDraftLock(root, specId, async (directory) => {
    const indexed = await indexedDraft(directory, specId);
    const view = indexed.view ?? draftView(specId, await readSnapshots(directory, specId));
    const rows = indexed.index?.rows ?? view.snapshots.map(indexRow);
    const earlierRow = rows.find(record => record.operationId === operationId);
    let earlier = null;
    if (earlierRow) {
      const read = await readSnapshot(path.join(directory, snapshotName(earlierRow.sequence)), specId);
      if (!read || read.damaged || read.record.snapshotSha256 !== earlierRow.snapshotSha256 || read.record.operationId !== operationId
          || read.record.payloadDigest !== earlierRow.payloadDigest) fail('The original save receipt cannot be verified. Preserve your text and inspect Earlier versions or restore the backup.', 'SPEC_DRAFT_OPERATION_UNAVAILABLE', { specId, operationId });
      earlier = read.record;
    }
    if (earlier) {
      if (earlier.payloadDigest === digest) return { snapshot: earlier, replayed: true, head: view.head };
      fail(`Operation ${operationId} already saved a different change to ${specId} (snapshot ${earlier.sequence}); nothing was saved. Use a new operation ID for a new change.`,
        'SPEC_DRAFT_OPERATION_REUSED', { specId, operationId, sequence: earlier.sequence, nextAction: `singularity-flow spec author status ${specId}` });
    }
    if (create && view.head) {
      fail(`${specId} already has a draft on this clone (snapshot ${view.sequence}). Continue it, or discard it first.`,
        'SPEC_DRAFT_EXISTS', { specId, sequence: view.sequence, nextAction: `singularity-flow spec author status ${specId}` });
    }
    if (!create && !view.head) {
      fail(`${specId} has no draft on this clone.`, 'SPEC_DRAFT_MISSING',
        { specId, nextAction: `singularity-flow spec author new ${specId} --title "TITLE"` });
    }
    const basis = expectedSequence !== null && expectedSequence !== view.sequence && wordingBasis && Number.isSafeInteger(expectedSequence) && expectedSequence > 0 && expectedSequence < view.sequence
      ? await readSnapshot(path.join(directory, snapshotName(expectedSequence)), specId) : null;
    if (expectedSequence !== null && expectedSequence !== view.sequence && !(basis?.record && sameWording(basis.record.draft, view.head.draft))) {
      fail(`${specId}'s draft is at snapshot ${view.sequence}, not ${expectedSequence}; someone saved it since you read it. Nothing was saved. Read it again and redo your change on top.`,
        'SPEC_DRAFT_STALE', { specId, expected: expectedSequence, current: view.sequence, nextAction: `singularity-flow spec author status ${specId}` });
    }
    const draft = await change(view.head ? structuredClone(view.head.draft) : null);
    const sequence = Math.max(view.sequence, view.highestFile) + 1;
    const record = {
      schemaVersion: currentSchemaVersion(DRAFT_FAMILY),
      specId,
      sequence,
      operationId,
      operation,
      payloadDigest: digest,
      previousSnapshotSha256: view.head?.snapshotSha256 ?? null,
      savedAt: new Date().toISOString(),
      savedBy: actor ? { name: actor.name ?? null, email: actor.email ?? null } : null,
      draft
    };
    record.snapshotSha256 = snapshotDigest(record);
    await publishSnapshotFile(directory, `${String(sequence).padStart(6, '0')}.json`, canonicalJson(record));
    // The snapshot is already durable. A failed optimization cache write cannot undo that fact;
    // the next writer rebuilds it from the immutable history instead.
    await writeDraftIndex(directory, specId, { rows, damaged: view.damaged }, indexed.names, record).catch(() => undefined);
    await thinDraftHistory(root, specId, directory, [...rows, indexRow(record)]).catch(() => undefined);
    return { snapshot: record, replayed: false, head: record };
  });
}

/**
 * Put back a whole snapshot from a backup when this clone has no draft of that specification. A clone
 * holding the same head is left as it is; a clone holding a different draft keeps its own.
 */
export async function restoreDraftSnapshot(root, record) {
  const specId = requireSpecId(record?.specId);
  if (record.snapshotSha256 !== snapshotDigest(record)) {
    fail(`The backed-up draft of ${specId} does not match its digest; nothing was restored.`, 'SPEC_DRAFT_BACKUP_INVALID', { specId });
  }
  return withDraftLock(root, specId, async (directory) => {
    const view = draftView(specId, await readSnapshots(directory, specId));
    if (view.head?.snapshotSha256 === record.snapshotSha256) return { specId, outcome: 'unchanged' };
    if (view.head || view.highestFile) return { specId, outcome: 'kept-local', localSequence: view.sequence };
    await publishSnapshotFile(directory, `${String(record.sequence).padStart(6, '0')}.json`, canonicalJson(record));
    return { specId, outcome: 'restored', sequence: record.sequence };
  });
}

/** Remove this clone's draft of one specification. Published revisions are untouched. */
export async function discardDraft(root, specId) {
  requireSpecId(specId);
  return withDraftLock(root, specId, async (directory) => {
    const snapshots = (await readdir(directory)).filter((name) => SNAPSHOT.test(name)).length;
    if (!snapshots) fail(`${specId} has no draft on this clone.`, 'SPEC_DRAFT_MISSING', { specId, nextAction: 'singularity-flow spec author list' });
    await rm(directory, { recursive: true, force: true });
    await syncDirectory(path.dirname(directory));
    return { specId, snapshots };
  });
}
