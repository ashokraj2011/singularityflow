/** Recoverable, unreviewed checkpoints. They never become library revisions or approval evidence. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareSharedPublicationStorage } from '../publication-storage.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { createHash } from 'node:crypto';
import { committedFileBytes, committedTreePaths } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError, writeAtomic } from '../util.mjs';
import { sharedBasis, recordSharedBasis } from './shared-basis.mjs';
import { crashPoint, readDraft, saveDraft } from './draft-store.mjs';
import { requireSpecId } from './ids.mjs';
import { libraryView } from './library.mjs';

const ROOT = 'singularity/specification-drafts';
const hash = value => 'sha256:' + recordSha256(value);
const fail = (message, code, details) => { throw new SingularityFlowError(message, { code, details }); };
const bytesHash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/**
 * What another laptop continues from. A proposal or finding already settled keeps its identity and outcome and not
 * its text: its wording is in the draft or was turned down, and a person could never remove anything from it.
 */
export function portableDraft(draft) {
  const { sharedDraftBase: _base, ...content } = structuredClone(draft);
  if (content.proposals) content.proposals = content.proposals.map((proposal) => (proposal.status === 'staged' ? proposal
    : { id: proposal.id, kind: proposal.kind, status: proposal.status, at: proposal.at }));
  if (content.assisted?.findings) content.assisted.findings = content.assisted.findings.map((finding) => (finding.status === 'pending' ? finding
    : { id: finding.id, article: finding.article, status: finding.status, at: finding.at, ...(finding.gap ? { gap: finding.gap } : {}) }));
  return content;
}

export function sharedHeadAt(root, view, specId) {
  requireSpecId(specId);
  if (!view.commit) return null;
  const file = ROOT + '/' + specId + '/head.json';
  const bytes = committedFileBytes(root, view.commit, file);
  if (!bytes) return null;
  const head = readRecord('spec-shared-head', bytes.toString('utf8')).record;
  if (head.specId !== specId || !/^sha256:[a-f0-9]{64}$/u.test(head.checkpointSha256 ?? '')) fail('This shared draft has an invalid identity.', 'SPEC_SHARED_DRAFT_INVALID', { specId });
  const checkpointPath = ROOT + '/' + specId + '/' + head.checkpointSha256.slice(7) + '.json';
  const checkpointBytes = committedFileBytes(root, view.commit, checkpointPath);
  if (!checkpointBytes) fail('The shared draft checkpoint is missing; preserve the local draft and refresh.', 'SPEC_SHARED_DRAFT_INVALID', { specId });
  const checkpoint = readRecord('spec-shared-draft', checkpointBytes.toString('utf8')).record;
  const { checkpointSha256, ...core } = checkpoint;
  if (!checkpoint.draft || typeof checkpoint.draft !== 'object' || checkpoint.specId !== specId || hash(checkpoint.draft) !== checkpoint.contentSha256 || hash(core) !== checkpointSha256 || checkpointSha256 !== head.checkpointSha256) {
    fail('The shared draft checkpoint does not match its identity.', 'SPEC_SHARED_DRAFT_INVALID', { specId });
  }
  return { head, checkpoint, path: file, bytes, commit: view.commit };
}

/**
 * Every shared draft at one state commit, or the one named by `only`. One invalid or newer-schema
 * checkpoint is that entry's problem: it is reported under `unreadable` and the rest still read.
 */
export async function sharedDrafts(root, config, { refresh = false, view: pinnedView = null, only = null } = {}) {
  const view = pinnedView ?? await libraryView(root, config, { refresh });
  const drafts = [], unreadable = [];
  if (!view.commit) return { view, drafts, unreadable };
  const ids = committedTreePaths(root, view.commit, [ROOT]).flatMap(file => {
    const match = /^singularity\/specification-drafts\/(SPEC-[A-Z0-9-]+)\/head\.json$/u.exec(file);
    return match && (!only || match[1] === only) ? [match[1]] : [];
  });
  for (const id of ids) {
    try { const read = sharedHeadAt(root, view, id); if (read) drafts.push(read); }
    catch (error) { unreadable.push({ specId: id, code: error.code ?? null, message: error.message }); }
  }
  return { view, drafts, unreadable };
}

async function automaticSlot(root, minimum, now = Date.now()) {
  try {
    return await withSubjectLock(root, { kind: 'spec-draft', id: 'studio-library-sync' }, async () => {
      const directory = await prepareSharedPublicationStorage(root, 'spec-sync', 'Specification sharing schedule');
      const file = path.join(directory, 'schedule.json');
      const stored = await readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      const previous = stored ? readRecord('spec-sync-schedule', stored).record.attemptedAt : 0;
      const remaining = Math.min(minimum, previous + minimum - now);
      if (remaining > 0) return { status: 'deferred', retryAfterMs: remaining };
      await writeAtomic(file, canonicalJson({ schemaVersion: currentSchemaVersion('spec-sync-schedule'), attemptedAt: now }), { mode: 0o600 });
      return null;
    });
  } catch (error) { if (error.code === 'SUBJECT_LOCK_BUSY') return { status: 'deferred', retryAfterMs: minimum }; throw error; }
}

/**
 * The local version the shared head was made from when it is this laptop's own, or null. Its push landed
 * but the acknowledgement was lost (SPEC-SPA section 5.2), so it is the basis to continue from and not
 * another writer. The intent recorded before a push answers first, so history thinning cannot make this
 * read as someone else's; only the rare remaining path reads the whole history.
 */
async function ownCheckpoint(root, specId, remote, { contentSha256, local, basis }) {
  if (remote.checkpoint.contentSha256 === contentSha256) return local.sequence;
  if (basis?.pendingPush?.checkpointSha256 === remote.head.checkpointSha256) return basis.pendingPush.localSequence;
  const history = await readDraft(root, specId);
  return history?.snapshots.find(snapshot => snapshot.snapshotSha256 === remote.checkpoint.sourceSnapshotSha256)?.sequence ?? null;
}

export async function syncDraft(root, config, specId, { automatic = false, minimumIntervalMs = 30000 } = {}) {
  if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 1000 || minimumIntervalMs > 3600000) fail('The automatic sharing interval must be 1–3600 seconds.', 'SPEC_SYNC_INTERVAL_INVALID');
  const local = await readDraft(root, requireSpecId(specId), { headOnly: true });
  if (!local?.head) fail('Open or restore a draft before sharing it.', 'SPEC_DRAFT_MISSING', { specId });
  const content = portableDraft(local.head.draft);
  // A shared checkpoint cannot be taken back, so nothing leaves before this; a refusal takes no automatic slot.
  const { assertFilesShareable, publishCheckedFiles } = await import('./share-check.mjs');
  assertFilesShareable(specId, { 'checkpoint.json': canonicalJson({ draft: content }) });
  if (automatic) { const deferred = await automaticSlot(root, minimumIntervalMs); if (deferred) return { ...deferred, specId }; }
  const contentSha256 = hash(content);
  let basis = await sharedBasis(root, specId) ?? local.head.draft.sharedDraftBase;
  const view = await libraryView(root, config);
  let remote;
  try { remote = sharedHeadAt(root, view, specId); }
  catch (error) {
    throw new SingularityFlowError('Your writing is saved on this laptop. Sharing did not start: ' + error.message, { code: error.code, cause: error, details: { specId, nextAction: 'singularity-flow spec author status ' + specId + ' --json' } });
  }
  if (remote && remote.head.checkpointSha256 !== basis?.checkpointSha256) {
    // Acknowledge only what that push carried: newer writing is not shared until its own push lands.
    const localSequence = await ownCheckpoint(root, specId, remote, { contentSha256, local, basis });
    if (localSequence !== null) {
      basis = { checkpointSha256: remote.head.checkpointSha256, contentSha256: remote.checkpoint.contentSha256, localSequence };
      await recordSharedBasis(root, specId, basis);
    }
  }
  if (basis?.contentSha256 === contentSha256 && remote?.head.checkpointSha256 === basis.checkpointSha256) {
    const { pendingPush: _settled, ...reconciled } = basis;
    await recordSharedBasis(root, specId, { ...reconciled, localSequence: local.sequence });
    return { status: 'synced', specId, checkpointSha256: basis.checkpointSha256, unchanged: true, commit: view.commit };
  }
  const core = { schemaVersion: currentSchemaVersion('spec-shared-draft'), specId,
    previousCheckpointSha256: basis?.checkpointSha256 ?? null, contentSha256,
    sourceSnapshotSha256: local.head.snapshotSha256, draft: content,
    savedAt: local.head.savedAt, savedBy: local.head.savedBy };
  const checkpointSha256 = hash(core);
  if (remote && remote.head.checkpointSha256 !== checkpointSha256
      && remote.head.checkpointSha256 !== (basis?.checkpointSha256 ?? null)) {
    fail('There is a newer shared draft. Your writing is saved on this laptop. Compare both versions before continuing.',
      'SPEC_SHARED_DRAFT_CONFLICT', { specId, localSequence: local.sequence, sharedCheckpoint: remote.head.checkpointSha256,
        nextAction: 'singularity-flow spec author shared ' + specId + ' --json' });
  }
  let commit = view.commit;
  if (remote?.head.checkpointSha256 !== checkpointSha256) {
    const checkpoint = Buffer.from(canonicalJson({ ...core, checkpointSha256 }));
    const head = Buffer.from(canonicalJson({ schemaVersion: currentSchemaVersion('spec-shared-head'), specId,
      checkpointSha256, previousCheckpointSha256: basis?.checkpointSha256 ?? null }));
    const headPath = ROOT + '/' + specId + '/head.json';
    const entries = { [ROOT + '/' + specId + '/' + checkpointSha256.slice(7) + '.json']: checkpoint, [headPath]: head };
    // Before the push: if its acknowledgement is lost, this says the checkpoint is ours and keeps its version from thinning.
    await recordSharedBasis(root, specId, { ...basis, pendingPush: { checkpointSha256, localSequence: local.sequence } });
    try {
      const published = await publishCheckedFiles(root, view.ledger, entries, '[' + specId + '][spec:draft] saved checkpoint', {
        exactBlobSha256: Object.fromEntries(Object.entries(entries).map(([file, bytes]) => [file, bytesHash(bytes)])),
        pathPreconditions: { [headPath]: remote ? { condition: 'exact', sha256: bytesHash(remote.bytes),
          bytes: remote.bytes.length, gitMode: '100644' } : { condition: 'absent' } }
      }, { specId, verb: 'shared', code: 'SPEC_SHARED_DRAFT_SECRET' });
      commit = published.commit;
    } catch (error) {
      if (['SPEC_SHARED_DRAFT_SECRET', 'SPEC_SHARE_CHECK_FAILED'].includes(error.code)) throw error;
      throw new SingularityFlowError('Your writing is saved on this laptop. Sharing did not finish: ' + error.message,
        { code: error.code === 'state_branch.path_precondition_failed' ? 'SPEC_SHARED_DRAFT_CONFLICT' : 'SPEC_SHARED_DRAFT_PENDING',
          cause: error, details: { specId, checkpointSha256, originalCode: error.code ?? null,
            nextAction: 'singularity-flow spec author sync ' + specId + ' --json' } });
    }
  }
  crashPoint('spec-draft-synced');
  await recordSharedBasis(root, specId, { checkpointSha256, contentSha256, localSequence: local.sequence });
  return { status: 'synced', specId, checkpointSha256, commit, reviewed: false };
}

/** Explicit adoption retains all local snapshots; the expected sequence prevents a late overwrite. */
export async function resumeSharedDraft(root, config, specId, { checkpointSha256, expectedSequence, operationId }) {
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) fail('Compare your current draft before opening the shared version; supply --expected-seq N (0 for no local draft).', 'SPEC_DRAFT_STALE', { specId });
  const view = await libraryView(root, config);
  const shared = sharedHeadAt(root, view, requireSpecId(specId));
  if (!shared || shared.head.checkpointSha256 !== checkpointSha256) fail('The shared draft changed. Compare its current version before opening it.', 'SPEC_SHARED_DRAFT_STALE', { specId });
  const local = await readDraft(root, specId);
  const saved = await saveDraft(root, specId, { operationId, operation: 'resume-shared', create: !local?.head,
    expectedSequence: expectedSequence ?? 0, payload: { checkpointSha256 },
    change: () => ({ ...shared.checkpoint.draft, sharedDraftBase: { checkpointSha256,
      contentSha256: shared.checkpoint.contentSha256 } }) });
  await recordSharedBasis(root, specId, { checkpointSha256, contentSha256: shared.checkpoint.contentSha256, localSequence: saved.snapshot.sequence });
  return saved;
}
