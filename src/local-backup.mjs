/**
 * Backups of the work that exists only on this laptop (SDA §11, §12, §19 item 14; M5).
 *
 * Four kinds of authored data never leave this machine on their own:
 * - configuration drafts (src/configuration-drafts.mjs), saved here until they are proposed;
 * - specification drafts (src/spec-library/draft-store.mjs), saved here until they are published,
 *   with the proposals and assisted findings staged in them;
 * - specification split proposals (src/spec-library/split.mjs), kept here until they are published;
 * - laptop-local Story documents (src/document-storage.mjs), whose bytes are never committed.
 * `backup create` copies them into a directory the person chooses outside every checkout of the
 * repository, so another laptop, or this one after a loss, can take them back with `backup restore`.
 * Layouts of earlier builds (the single `drafts.json`, the document store inside the runtime
 * directory) are migrated first, so they are carried with their exact operation IDs and digests.
 *
 * A backup never carries what belongs to this machine: locks, sessions, caches and indexes,
 * journals, pending publications, saved pushes, temporary files or absolute paths. The file a
 * /sf-spec-author turn writes before `spec author propose` stages it is such a temporary file: what was
 * staged is in the draft. Pending
 * publications and saved pushes are recovered here (`sync`); the backup names them so the person
 * restoring it knows they did not come along.
 *
 * Restore changes no shared state and approves nothing:
 * - a specification draft's head snapshot is put back whole when this clone has no draft of that
 *   specification; a clone holding the same head is left as it is, and one holding a different draft
 *   keeps its own (manifest v2). A split proposal is put back the same way, by revision (manifest v3).
 * - a draft is saved again through the ordinary draft save, under its original operation ID, so it
 *   is checked against the approved configuration as it is now. The same operation already saved is
 *   left as it is; a different change under that ID is refused (OPERATION_ID_REUSE).
 * - a document's bytes are restored only where the Story still holds the exact document record they
 *   belong to (`documents restore`). When the Story moved on (its record changed or the document was
 *   detached), the bytes stay in the backup and the result says so.
 * Restoring the same backup again changes nothing.
 *
 * Layout: `<directory>/manifest.json` (record family `local-backup-manifest`) and
 * `<directory>/objects/<sha256>`, one file per distinct document. The manifest is written last, so an
 * interrupted backup has none and is refused as incomplete. A manifest a newer build wrote is
 * refused whole (SCHEMA_VERSION_FUTURE): nothing is restored from a backup this build cannot read.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { readRecord, stampCurrentRecord } from './schema-migrations.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';

export const BACKUP_FAMILY = 'local-backup-manifest';
const MANIFEST = 'manifest.json';
const OBJECTS = 'objects';
const CHANGE_SET_SCHEMA = 'sflow-studio-change-set@1';
const BACKUP_ID = /^lbk-[0-9a-f]{24}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FILE_NAME = /^[A-Za-z0-9._-]{1,255}$/u;
const MAXIMUM_DOCUMENTS = 10_000;
const MAXIMUM_DRAFTS = 1_000;
const MAXIMUM_BYTES = 8 * 1024 * 1024 * 1024;
const MANIFEST_LIMIT = 64 * 1024 * 1024;
/** What a backup never carries, whatever this machine holds. */
export const NEVER_CARRIED = Object.freeze(['locks', 'sessions', 'caches and indexes', 'journals', 'temporary files']);

const fail = (message, code, details = null) => { throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) }); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** The repository a backup belongs to, as a digest: its remote's comparison key, else its local ID. */
async function repositoryFingerprint(root) {
  const { configuredRemoteIdentity } = await import('./git-remote-diagnostics.mjs');
  let url = null;
  try { url = configuredRemoteIdentity(root, 'origin', { direction: 'fetch' }).url ?? null; } catch { url = null; }
  const { checkoutGitFacts, repositoryKey } = await import('./story-index.mjs');
  const facts = await checkoutGitFacts(root);
  const key = facts ? await repositoryKey(url, facts.commonDir, { create: true }) : null;
  if (!key || key.startsWith('gitdir:')) {
    fail('This repository has no identity a backup can be matched to. Run the command inside a clone of it.', 'BACKUP_REPOSITORY_MISMATCH');
  }
  return `sha256:${sha256(key)}`;
}

/** The real path `target` will have: its nearest existing parent resolved, the rest appended. */
async function eventualPath(target) {
  const rest = [];
  let current = target;
  for (;;) {
    try { return path.join(await realpath(current), ...rest.reverse()); }
    catch (error) {
      if (!missing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** A backup holds the only copy of local documents: it never goes inside a checkout of this repository. */
async function assertOutsideCheckouts(root, target) {
  const { worktreeInventory } = await import('./story-worktree.mjs');
  const { gitCommonDir } = await import('./git-execution.mjs');
  const eventual = await eventualPath(target);
  for (const guarded of [...worktreeInventory(root).map((entry) => entry.path), gitCommonDir(root)]) {
    const real = await realpath(guarded).catch(() => path.resolve(guarded));
    if (contains(real, eventual)) {
      fail(`A backup holds documents that must never be committed, so it is not saved inside a checkout of this repository (${real}). Choose a directory outside it.`,
        'BACKUP_INSIDE_CHECKOUT', { checkout: real });
    }
  }
}

/** Checks the destination and creates what a backup writes into; returns how to remove only that again. */
async function emptyDestination(target) {
  const info = await lstat(target).catch((error) => (missing(error) ? null : Promise.reject(error)));
  if (info && (!info.isDirectory() || info.isSymbolicLink())) fail(`The backup destination is not an ordinary directory: ${target}`, 'BACKUP_DESTINATION_INVALID');
  if (info && (await readdir(target)).length) fail(`The backup destination is not empty: ${target}. Choose a new or empty directory.`, 'BACKUP_DESTINATION_INVALID');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await mkdir(path.join(target, OBJECTS), { mode: 0o700 });
  // A failed run leaves the destination as it found it, so the same --out works again (D10).
  return () => rm(info ? path.join(target, OBJECTS) : target, { recursive: true, force: true });
}

const GIB = 1024 * 1024 * 1024;
const size = (bytes) => (bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.ceil(bytes / (1024 * 1024))} MiB`);

/** What one backup cannot carry, named with where it comes from and what the person can do; nothing is written. */
function tooLarge(target, measured, limits) {
  const stories = [...measured.stories].sort((left, right) => right[1] - left[1]).slice(0, 3);
  fail(`This clone's laptop-local documents (${measured.documents} documents, ${size(measured.bytes)}`
    + `${stories.length ? `; most in ${stories.map(([workId, bytes]) => `${workId} (${size(bytes)})`).join(', ')}` : ''}) are more than one backup carries `
    + `(${limits.documents} documents, ${size(limits.bytes)}). Nothing was written to ${target}. A document that may be committed can move `
    + 'to Git storage with `singularity-flow documents store <DOCUMENT-ID> --store git` in its Story\'s checkout; then create the backup again.',
  'BACKUP_TOO_LARGE', { documents: measured.documents, bytes: measured.bytes, maximumDocuments: limits.documents,
    maximumBytes: limits.bytes, stories: stories.map(([workId, bytes]) => ({ workId, bytes })),
    nextAction: { command: `singularity-flow documents list ${stories[0]?.[0] ?? '<WORK-ID>'} --all --json`,
      label: 'See which of that Story\'s documents are kept only on this laptop.' } });
}

async function readRegular(file, { limit = Infinity } = {}) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return null;
    return await handle.readFile();
  } catch (error) {
    if (missing(error) || ['ELOOP', 'EISDIR'].includes(error?.code)) return null;
    throw error;
  } finally { await handle?.close().catch(() => {}); }
}

async function writeObject(directory, hash, bytes) {
  const handle = await open(path.join(directory, OBJECTS, hash), 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function directories(parent, pattern) {
  const entries = await readdir(parent, { withFileTypes: true }).catch((error) => (missing(error) ? [] : Promise.reject(error)));
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && pattern.test(entry.name)).map((entry) => entry.name);
}

/**
 * Every verified document in this clone's machine-local store, by Story; bytes another build moved are
 * migrated first. `measure` reads only each file's size, so a backup's size is known before it writes.
 */
async function localDocuments(root, onDocument, { measure = false } = {}) {
  const { localDocumentStoreDirectory, migrateLegacyLocalDocumentStore } = await import('./document-storage.mjs');
  await migrateLegacyLocalDocumentStore(root);
  const store = localDocumentStoreDirectory(root);
  const unreadable = [];
  for (const workId of await directories(store, WORK_ID)) {
    for (const hash of await directories(path.join(store, workId), SHA256)) {
      const folder = path.join(store, workId, hash);
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        // Dot files are a store's own: a replaced copy (.previous-) or an unfinished write (.partial).
        if (entry.name.startsWith('.') || !FILE_NAME.test(entry.name)) continue;
        if (measure) {
          if (entry.isFile()) await onDocument({ workId, sha256: hash, size: (await lstat(path.join(folder, entry.name))).size });
          continue;
        }
        const bytes = entry.isFile() ? await readRegular(path.join(folder, entry.name)) : null;
        if (!bytes || sha256(bytes) !== hash) { unreadable.push({ workId, key: `${hash}/${entry.name}` }); continue; }
        await onDocument({ workId, key: `${hash}/${entry.name}`, sha256: hash, size: bytes.length }, bytes);
      }
    }
  }
  return unreadable;
}

/** What waits on this machine and is recovered only here: named in the backup, never carried. */
async function sealedHere(root) {
  const { gitCommonDir } = await import('./git-execution.mjs');
  const names = await readdir(path.join(gitCommonDir(root), 'singularity-flow', 'pending-publication'))
    .catch((error) => (missing(error) ? [] : Promise.reject(error)));
  const pendingPublications = names.filter((name) => /^[a-z][a-z-]*--.+\.json$/u.test(name)).map((name) => {
    const [kind, ...id] = name.slice(0, -'.json'.length).split('--');
    return { kind, id: id.join('--') };
  });
  let savedPushes = null;
  try {
    const { transportIntentsForRepository, transportIntentTerminal } = await import('./transport-intents.mjs');
    savedPushes = (await transportIntentsForRepository(root)).filter((intent) => !transportIntentTerminal(intent)).length;
  } catch { savedPushes = null; }
  return { pendingPublications, savedPushes, never: [...NEVER_CARRIED] };
}

/**
 * Save this clone's configuration drafts and laptop-local documents into `out`, a new or empty
 * directory outside every checkout of the repository.
 */
export async function createBackup(root, { out, limits = { documents: MAXIMUM_DOCUMENTS, bytes: MAXIMUM_BYTES } } = {}) {
  if (typeof out !== 'string' || !out.trim()) fail('Choose where to save the backup: --out <DIRECTORY>, outside this repository.', 'BACKUP_DESTINATION_INVALID');
  const target = path.resolve(out);
  await assertOutsideCheckouts(root, target);
  const repository = await repositoryFingerprint(root);
  const { readDrafts } = await import('./configuration-drafts.mjs');
  // `readDrafts` migrates an earlier build's `drafts.json` first; a backup carries the drafts as stored.
  const drafts = (await readDrafts(root)).changes.map(({ draftId, operationId, payloadDigest, sequence, addedAt, description, change, checkedAgainst }) => (
    { draftId, operationId, payloadDigest, sequence, addedAt, description, change, checkedAgainst }));
  if (drafts.length > MAXIMUM_DRAFTS) {
    fail(`This clone holds ${drafts.length} configuration drafts, more than one backup carries (${MAXIMUM_DRAFTS}). Nothing was written to ${target}. `
      + 'Propose them (`singularity-flow configuration propose`) or discard the ones no longer wanted, then create the backup again.',
    'BACKUP_TOO_LARGE', { drafts: drafts.length, maximumDrafts: MAXIMUM_DRAFTS, nextAction: 'singularity-flow configuration drafts' });
  }
  // Sized before anything is created: the documents were refused only after the destination was
  // partly written, and the same --out was then refused as not empty (D10).
  const measured = { documents: 0, bytes: 0, hashes: new Set(), stories: new Map() };
  await localDocuments(root, async ({ workId, sha256: hash, size: length }) => {
    measured.documents += 1;
    if (measured.hashes.has(hash)) return;
    measured.hashes.add(hash);
    measured.bytes += length;
    measured.stories.set(workId, (measured.stories.get(workId) ?? 0) + length);
  }, { measure: true });
  if (measured.documents > limits.documents || measured.bytes > limits.bytes) tooLarge(target, measured, limits);
  const { listDrafts } = await import('./spec-library/draft-store.mjs');
  const views = await listDrafts(root);
  const specDrafts = views.filter((draft) => draft.head).map((draft) => draft.head);
  // A snapshot newer than the head carried (or a draft with none that verifies) is named, never left out silently.
  const unreadableSpecDrafts = views.map((draft) => ({ specId: draft.specId, carriedSequence: draft.head?.sequence ?? null,
    files: draft.damaged.filter((entry) => Number(path.basename(entry.file, '.json')) > (draft.head?.sequence ?? 0)).map((entry) => path.basename(entry.file)) }))
    .filter((entry) => entry.files.length);
  if (specDrafts.length > MAXIMUM_DRAFTS) {
    fail(`This clone holds ${specDrafts.length} specification drafts, more than one backup carries (${MAXIMUM_DRAFTS}). Nothing was written to ${target}. Publish or discard some, then create the backup again.`,
      'BACKUP_TOO_LARGE', { specDrafts: specDrafts.length, maximumDrafts: MAXIMUM_DRAFTS, nextAction: 'singularity-flow spec author list' });
  }
  const { listProposals } = await import('./spec-library/split.mjs');
  const { proposals: splitProposals, unreadable: unreadableSplitProposals } = await listProposals(root);
  if (splitProposals.length > MAXIMUM_DRAFTS) {
    fail(`This clone holds ${splitProposals.length} specification split proposals, more than one backup carries (${MAXIMUM_DRAFTS}). Nothing was written to ${target}. Publish some, then create the backup again.`,
      'BACKUP_TOO_LARGE', { splitProposals: splitProposals.length, maximumDrafts: MAXIMUM_DRAFTS, nextAction: 'singularity-flow spec author list' });
  }
  const removeWritten = await emptyDestination(target);
  const documents = []; const written = new Set();
  let bytes = 0;
  let manifest; let text; let unreadable;
  try {
    unreadable = await localDocuments(root, async (document, content) => {
      // Documents added since they were sized: refused the same way, and this run's files removed below.
      if (documents.length >= limits.documents || bytes + content.length > limits.bytes) tooLarge(target, measured, limits);
      documents.push(document);
      if (written.has(document.sha256)) return;
      written.add(document.sha256);
      bytes += content.length;
      await writeObject(target, document.sha256, content);
    });
    const { localMachineId } = await import('./lease-liveness.mjs');
    manifest = stampCurrentRecord(BACKUP_FAMILY, {
      backupId: `lbk-${randomBytes(12).toString('hex')}`, createdAt: new Date().toISOString(),
      sourceMachine: localMachineId() ?? null, repository, configurationDrafts: drafts, specDrafts, splitProposals, documents,
      notCarried: await sealedHere(root)
    });
    text = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeAtomic(path.join(target, MANIFEST), text, { mode: 0o600 });
  } catch (error) {
    await removeWritten().catch(() => {});
    throw error;
  }
  return { schemaVersion: 1, resultType: 'sflow-backup-create', directory: target, backupId: manifest.backupId, // schema-transient: command result
    manifestSha256: `sha256:${sha256(text)}`, configurationDrafts: drafts.length, specDrafts: specDrafts.length,
    splitProposals: splitProposals.length, documents: documents.length, bytes,
    unreadableDocuments: unreadable, unreadableSpecDrafts, unreadableSplitProposals, notCarried: manifest.notCarried,
    next: `singularity-flow backup inspect ${JSON.stringify(target)}` };
}

function validDraftEntry(entry, { DRAFT_ID, DRAFTABLE_OPERATIONS, draftPayloadDigest }) {
  return entry && typeof entry === 'object' && DRAFT_ID.test(entry.draftId ?? '')
    && typeof entry.operationId === 'string' && entry.operationId.length > 0 && entry.operationId.length <= 160
    && typeof entry.description === 'string' && entry.change && typeof entry.change === 'object'
    && DRAFTABLE_OPERATIONS.includes(entry.change.op) && entry.payloadDigest === draftPayloadDigest(entry.change, entry.description);
}

function validDocumentEntry(entry) {
  const [hash, name, ...rest] = String(entry?.key ?? '').split('/');
  return WORK_ID.test(entry?.workId ?? '') && SHA256.test(entry?.sha256 ?? '') && hash === entry.sha256
    && FILE_NAME.test(name ?? '') && !name.startsWith('.') && !rest.length && Number.isSafeInteger(entry.size) && entry.size >= 0;
}

/** A backup's manifest and objects, verified whole, or a refusal; nothing is written. */
export async function readBackup(directory) {
  if (typeof directory !== 'string' || !directory.trim()) fail('Name the backup directory: singularity-flow backup inspect <DIRECTORY>.', 'BACKUP_INVALID');
  const target = path.resolve(directory);
  const info = await lstat(target).catch((error) => (missing(error) ? null : Promise.reject(error)));
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(`No backup directory at ${target}.`, 'BACKUP_INVALID');
  const text = await readRegular(path.join(target, MANIFEST), { limit: MANIFEST_LIMIT });
  if (!text) fail(`${target} holds no complete backup: its manifest is missing, so it was interrupted or is not a backup.`, 'BACKUP_INVALID');
  const { record } = readRecord(BACKUP_FAMILY, text);
  const drafts = await import('./configuration-drafts.mjs');
  const { snapshotDigest } = await import('./spec-library/draft-store.mjs');
  const { validSpecId } = await import('./spec-library/ids.mjs');
  const { validProposalRecord } = await import('./spec-library/split.mjs');
  if (!BACKUP_ID.test(record.backupId ?? '') || !DIGEST.test(record.repository ?? '')
      || !Array.isArray(record.configurationDrafts) || record.configurationDrafts.length > MAXIMUM_DRAFTS
      || !record.configurationDrafts.every((entry) => validDraftEntry(entry, drafts))
      || !Array.isArray(record.specDrafts) || record.specDrafts.length > MAXIMUM_DRAFTS
      || !record.specDrafts.every((entry) => validSpecId(entry?.specId) && entry.snapshotSha256 === snapshotDigest(entry))
      || !Array.isArray(record.splitProposals) || record.splitProposals.length > MAXIMUM_DRAFTS
      || !record.splitProposals.every(validProposalRecord)
      || !Array.isArray(record.documents) || record.documents.length > MAXIMUM_DOCUMENTS
      || !record.documents.every(validDocumentEntry)) {
    fail(`The backup manifest at ${target} is not valid. Nothing was restored.`, 'BACKUP_INVALID');
  }
  const damaged = [];
  const sizes = new Map(record.documents.map((entry) => [entry.sha256, entry.size]));
  for (const [hash, size] of sizes) {
    const bytes = await readRegular(path.join(target, OBJECTS, hash));
    if (!bytes || bytes.length !== size || sha256(bytes) !== hash) damaged.push(hash);
  }
  if (damaged.length) {
    fail(`The backup at ${target} is damaged: ${damaged.length} document${damaged.length === 1 ? ' does' : 's do'} not match ${damaged.length === 1 ? 'its' : 'their'} recorded SHA-256. Nothing was restored.`,
      'BACKUP_INTEGRITY_FAILED', { damaged });
  }
  return { directory: target, manifest: record, manifestSha256: `sha256:${sha256(text)}` };
}

/** The Story's checkout on this machine: a worktree of this clone, else one the Story index records for this repository. */
async function storyCheckout(root, workId) {
  const { worktreeInventory } = await import('./story-worktree.mjs');
  const index = await import('./story-index.mjs');
  for (const entry of worktreeInventory(root)) {
    if ((await index.storyInCheckout(entry.path, { workId }).catch(() => null))?.workId === workId) return entry.path;
  }
  // Another clone of this repository, in a registered workspace; outside one nothing is indexed.
  const member = await index.checkoutMembership(root).catch(() => null);
  if (!member) return null;
  const { valid } = await index.lookupStoryCheckouts(workId, { repositoryKey: member.repositoryKey }).catch(() => ({ valid: [] }));
  return valid.find((entry) => entry.workId === workId && index.isLifecycle(entry))?.checkoutPath ?? null;
}

async function planDocuments(root, backup) {
  const byStory = new Map();
  for (const entry of backup.manifest.documents) byStory.set(entry.workId, [...(byStory.get(entry.workId) ?? []), entry]);
  const items = [];
  for (const [workId, entries] of byStory) {
    const checkout = await storyCheckout(root, workId);
    if (!checkout) {
      items.push(...entries.map((entry) => ({ workId, key: entry.key, sha256: entry.sha256, status: 'story-not-here',
        next: `singularity-flow session takeover ${workId} --json` })));
      continue;
    }
    const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
    const { loadManifest, evidenceIsActive } = await import('./documents-read.mjs');
    const { isLocalDocument, localDocumentAvailability } = await import('./document-storage.mjs');
    let config, workflow, records;
    try {
      ({ config, workflow } = await loadAcceptedStoryExecution(checkout, workId));
      records = (await loadManifest(checkout, config, workflow)).documents
        .filter((record) => isLocalDocument(record) && evidenceIsActive(record));
    } catch (error) {
      // One Story that cannot be read here keeps only its own documents back.
      items.push(...entries.map((entry) => ({ workId, key: entry.key, sha256: entry.sha256, status: 'refused', refusal: refusal(error) })));
      continue;
    }
    for (const entry of entries) {
      const record = records.find((candidate) => candidate.storage.key === entry.key && candidate.sha256 === entry.sha256);
      if (!record) { items.push({ workId, key: entry.key, sha256: entry.sha256, status: 'superseded' }); continue; }
      const available = await localDocumentAvailability(checkout, workId, record, { verify: true }) === 'available';
      items.push({ workId, key: entry.key, sha256: entry.sha256, documentId: record.id, name: record.name,
        status: available ? 'already-present' : 'to-restore', restore: available ? null : { checkout, config, workflow } });
    }
  }
  return items;
}

async function planDrafts(root, backup) {
  const { readDrafts } = await import('./configuration-drafts.mjs');
  const saved = new Map((await readDrafts(root)).changes.map((draft) => [draft.operationId, draft]));
  return backup.manifest.configurationDrafts.map((draft) => {
    const here = saved.get(draft.operationId);
    const status = !here ? 'to-restore' : here.payloadDigest === draft.payloadDigest ? 'already-saved' : 'operation-reused';
    return { draftId: draft.draftId, operationId: draft.operationId, description: draft.description, status,
      checkedAgainst: draft.checkedAgainst ?? null, draft };
  });
}

async function planSpecDrafts(root, backup) {
  const { readDraft } = await import('./spec-library/draft-store.mjs');
  const items = [];
  for (const record of backup.manifest.specDrafts) {
    const here = await readDraft(root, record.specId);
    const status = !here ? 'to-restore' : here.head?.snapshotSha256 === record.snapshotSha256 ? 'already-saved' : 'kept-local';
    items.push({ specId: record.specId, sequence: record.sequence, operationId: record.operationId, status, draft: record });
  }
  return items;
}

async function planSplitProposals(root, backup) {
  const { readProposal } = await import('./spec-library/split.mjs');
  const items = [];
  for (const record of backup.manifest.splitProposals) {
    const here = await readProposal(root, record.specId, record.revision);
    const status = !here ? 'to-restore' : !here.damaged && here.planSha256 === record.planSha256 ? 'already-saved' : 'kept-local';
    items.push({ specId: record.specId, revision: record.revision, planSha256: record.planSha256, status, draft: record });
  }
  return items;
}

const publicItem = ({ draft: _draft, restore: _restore, ...item }) => item;

function counts(items, statuses) {
  return Object.fromEntries(statuses.map((status) => [status, items.filter((item) => item.status === status).length]));
}

/** What restoring `directory` here would do. Reads only. */
export async function inspectBackup(root, directory) {
  const plan = await planBackup(root, directory);
  return { schemaVersion: 1, resultType: 'sflow-backup-inspect', ...plan.summary, // schema-transient: command result
    configurationDrafts: plan.drafts.map(publicItem), specDrafts: plan.specDrafts.map(publicItem),
    splitProposals: plan.splitProposals.map(publicItem), documents: plan.documents.map(publicItem),
    next: `singularity-flow backup restore ${JSON.stringify(plan.backup.directory)}` };
}

async function planBackup(root, directory) {
  const backup = await readBackup(directory);
  if (backup.manifest.repository !== await repositoryFingerprint(root)) {
    fail('This backup was made from another repository. Restore it inside a clone of the repository it came from.', 'BACKUP_REPOSITORY_MISMATCH');
  }
  const { localMachineId } = await import('./lease-liveness.mjs');
  const drafts = await planDrafts(root, backup);
  const specDrafts = await planSpecDrafts(root, backup);
  const splitProposals = await planSplitProposals(root, backup);
  const documents = await planDocuments(root, backup);
  return { backup, drafts, specDrafts, splitProposals, documents, summary: {
    directory: backup.directory, backupId: backup.manifest.backupId, createdAt: backup.manifest.createdAt,
    manifestSha256: backup.manifestSha256, fromThisMachine: Boolean(backup.manifest.sourceMachine) && backup.manifest.sourceMachine === localMachineId(),
    notCarried: backup.manifest.notCarried ?? null
  } };
}

/** Save one backed-up draft again, as the ordinary draft save does, under its original operation ID. */
async function replayDraft(root, draft) {
  const [{ authorChange }, { withApprovedConfigurationRead }, { planStudioChangeSet }] = await Promise.all([
    import('./configuration-drafts.mjs'), import('./approved-configuration-reader.mjs'), import('./workflow-studio.mjs')]);
  return authorChange(root, { schema: CHANGE_SET_SCHEMA, changes: [draft.change] }, {
    operationId: draft.operationId,
    // Reached only when this repository has no approved configuration: a draft is never written into the tree.
    apply: () => fail('This repository has no approved configuration, so a backed-up draft cannot be saved as a draft here. Nothing was written.',
      'BACKUP_DRAFTS_UNAPPROVED'),
    check: async (set, { refreshAuthority = true } = {}) => {
      let source = null;
      const plan = await withApprovedConfigurationRead(root, (seen) => { source = seen; return planStudioChangeSet(root, set); },
        { preferAuthority: true, refreshAuthority });
      return { plan, source };
    }
  });
}

const refusal = (error) => ({ code: error?.code ?? 'FAILED', message: String(error?.message ?? error).slice(0, 2000),
  ...(error?.outcomeClass ? { outcomeClass: error.outcomeClass } : {}) });

/**
 * Restore `directory` here: drafts saved again, documents whose exact record the Story still holds.
 * Idempotent; every item says what happened to it.
 */
export async function restoreBackup(root, directory) {
  const plan = await planBackup(root, directory);
  const drafts = [];
  for (const item of plan.drafts) {
    if (item.status === 'already-saved') { drafts.push(publicItem(item)); continue; }
    try {
      const result = await replayDraft(root, item.draft);
      if (result?.valid === false) {
        drafts.push({ ...publicItem(item), status: 'refused', problems: (result.problems ?? []).map((problem) => problem.message ?? String(problem)) });
      } else {
        // A draft the approved configuration holds by now (approved since the backup) is not saved again.
        drafts.push({ ...publicItem(item), status: result?.saved === 'existing' ? 'already-saved' : result?.saved === 'unchanged' ? 'already-approved' : 'restored' });
      }
    } catch (error) { drafts.push({ ...publicItem(item), status: 'refused', refusal: refusal(error) }); }
  }
  if (drafts.some((item) => item.status === 'restored')) {
    const { readDrafts } = await import('./configuration-drafts.mjs');
    const now = new Map((await readDrafts(root)).changes.map((draft) => [draft.operationId, draft]));
    for (const item of drafts.filter((entry) => entry.status === 'restored')) {
      const checkedAgainst = now.get(item.operationId)?.checkedAgainst ?? null;
      // The approved configuration moved since the draft was first saved: it was checked again, here, against the current one.
      Object.assign(item, { checkedAgainstNow: checkedAgainst,
        approvedConfigurationMoved: Boolean(item.checkedAgainst?.commit && checkedAgainst?.commit && item.checkedAgainst.commit !== checkedAgainst.commit) });
    }
  }
  const specDrafts = [];
  for (const item of plan.specDrafts) {
    if (item.status !== 'to-restore') { specDrafts.push(publicItem(item)); continue; }
    try {
      const { restoreDraftSnapshot } = await import('./spec-library/draft-store.mjs');
      const restored = await restoreDraftSnapshot(root, item.draft);
      specDrafts.push({ ...publicItem(item), status: restored.outcome === 'restored' ? 'restored' : restored.outcome === 'unchanged' ? 'already-saved' : 'kept-local' });
    } catch (error) { specDrafts.push({ ...publicItem(item), status: 'refused', refusal: refusal(error) }); }
  }
  const splitProposals = [];
  for (const item of plan.splitProposals) {
    if (item.status !== 'to-restore') { splitProposals.push(publicItem(item)); continue; }
    try {
      const { restoreProposal } = await import('./spec-library/split.mjs');
      const restored = await restoreProposal(root, item.draft);
      splitProposals.push({ ...publicItem(item), status: restored.outcome === 'restored' ? 'restored' : restored.outcome === 'unchanged' ? 'already-saved' : 'kept-local' });
    } catch (error) { splitProposals.push({ ...publicItem(item), status: 'refused', refusal: refusal(error) }); }
  }
  const documents = [];
  for (const item of plan.documents) {
    if (item.status !== 'to-restore') { documents.push(publicItem(item)); continue; }
    try {
      const { restoreLocalDocument } = await import('./documents.mjs');
      await restoreLocalDocument(item.restore.checkout, item.restore.config, item.restore.workflow,
        { documentId: item.documentId, file: path.join(plan.backup.directory, OBJECTS, item.sha256) });
      documents.push({ ...publicItem(item), status: 'restored' });
    } catch (error) { documents.push({ ...publicItem(item), status: 'refused', refusal: refusal(error) }); }
  }
  const draftCounts = counts(drafts, ['restored', 'already-saved', 'already-approved', 'refused']);
  const documentCounts = counts(documents, ['restored', 'already-present', 'superseded', 'story-not-here', 'refused']);
  const specDraftCounts = counts(specDrafts, ['restored', 'already-saved', 'kept-local', 'refused']);
  const splitProposalCounts = counts(splitProposals, ['restored', 'already-saved', 'kept-local', 'refused']);
  return { schemaVersion: 1, resultType: 'sflow-backup-restore', ...plan.summary, // schema-transient: command result
    status: [...drafts, ...specDrafts, ...splitProposals, ...documents].some((item) => item.status === 'refused') ? 'partial' : 'restored',
    counts: { configurationDrafts: draftCounts, specDrafts: specDraftCounts, splitProposals: splitProposalCounts, documents: documentCounts },
    configurationDrafts: drafts, specDrafts, splitProposals, documents,
    effects: { shared: false, committed: false, pushed: false, proposed: false, approvalsChanged: false },
    next: draftCounts.restored ? 'singularity-flow configuration drafts' : null };
}
