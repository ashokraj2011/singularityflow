/**
 * SPEC-OSA v1.1 §7.2–§7.3: one conditional operation opens a step's version on the shared Story branch
 * [OSA:REQ-030–REQ-034, AC-015–AC-017; D3, D6].
 *
 * `openVersion` takes a stable operation ID, the exact proposal (its expected lifecycle revision) and, for every opening but
 * the first of version 1, the person's sealed consent receipt (story-version-consent.mjs). In one governed commit it
 * reserves the number (the step's `versionOpening.highWatermark`), opens it (a code step's generation intent and receipt, or
 * a document step's reservation) and appends the opening record with the receipt; the leased push then makes it the shared
 * authority's. It reuses the Story publication unit of work: its subject lock, journal, exact-path staging, leased push and
 * retained pending publication (story-publication-service.mjs `commitAndPublish`, with `transactionId` = the operation ID).
 * Only the Story's metadata is staged: the record, `workflow.json`, `STATUS.md`, the generation-start receipt and the work
 * interval baseline. Application files, unrelated changes and local attachments stay where they are, uncommitted.
 *
 * Each operation keeps one sealed checkpoint on this clone (story-version-acceptance.mjs): prepared, locally persisted,
 * shared acceptance pending or confirmed, unknown, or refused. The same operation ID with the same payload returns the
 * original outcome without another commit or question; another payload under it is refused. A lost or uncertain reply is
 * reconciled as the same operation against the remote (`reconcileOpening`); nothing ever allocates a replacement version.
 *
 * The opening names its writer: this checkout's writer ID and a fence number. Only that writer authors the version; a
 * verified takeover (`takeOverWriter`, from `session takeover`) moves the fence with its own leased commit, and the old
 * writer is refused at its next entry or consequential boundary.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { recordSha256 } from './records.mjs';
import { nowIso, posix, SingularityFlowError } from './util.mjs';
import { versionNumbers } from './kernel/step-versions.mjs';
import { openingFactsOf, versionFactsOf } from './phase-generation-need.mjs';
import { CHECKPOINT_PURPOSE, CHECKPOINT_SCHEMA, WRITER_SCHEMA, checkpointFile, gitDirectories, readCheckpoint, readWriterId, sealHere,
  writerFile } from './story-version-acceptance.mjs';
import { consentProblem, dropGrant } from './story-version-consent.mjs';
import { OPENING_OPERATION, versionProposal } from './story-version-proposal.mjs';

export { OPENING_OPERATION, PROPOSAL_SCHEMA, versionProposal } from './story-version-proposal.mjs';

export const TAKEOVER_OPERATION = 'version-writer-takeover/v1';
export const RECORD_SCHEMA = 'version-opening/v1';
export const TAKEOVER_SCHEMA = 'version-writer-takeover/v1';
export const OPENING_REASONS = Object.freeze(['initial', 'watermark', 'rework', 'rejected', 'amendment', 'author-conflict', 'review-corrections',
  'requested-change', 'changed-after-publication', 'own-correction', 'legacy-promotion']);
const OPERATION_ID = /^v[ot]-[0-9a-f]{32}$/u;

const refuse = (message, code, details = {}) => new SingularityFlowError(message, { code, details });

/** The step's legal next action as the kernel decides it and the host renders it, for a refusal to lead with [OSA:REQ-022]. */
async function legalNext(root, workflow, phase, config = null) {
  try { return (await (await import('./commands/phase-opening.mjs')).kernelRoute(root, workflow, phase, { config })).route; }
  catch { return null; }
}
/** The step's own preview, `phase rollover <step> --json`, after which the person is asked for their yes [D3, OSA:REQ-030]. */
async function askAgain(phase) {
  try { return (await (await import('./commands/phase-opening.mjs')).askingRoute(phase.id, null, { json: true })) ?? null; }
  catch { return null; }
}
const sha = (value) => `sha256:${recordSha256(value)}`;

/** The opening operation's ID for a proposal: stable, so a repeated request is the same operation. */
export const operationIdOf = (digest) => `vo-${createHash('sha256').update(`${OPENING_OPERATION}\n${digest}`).digest('hex').slice(0, 32)}`;
export const validOperationId = (value) => typeof value === 'string' && OPERATION_ID.test(value);

// ------------------------------------------------------------------------------------------------ the writer and checkpoints

async function directories(root) {
  const found = gitDirectories(root);
  if (found) return found;
  const { gitDir, gitCommonDir } = await import('./git.mjs');
  return { gitDir: gitDir(root), commonDir: gitCommonDir(root) };
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** This clone's integrity key exists before anything is sealed: the first opening creates it. */
async function ensureKey(root) {
  const { machineLocalPublicationIntegrityKey } = await import('./publication-machine-integrity.mjs');
  if (!await machineLocalPublicationIntegrityKey(root, { create: true })) throw refuse('This clone cannot seal its opening records.', 'VERSION_OPENING_STORAGE_UNAVAILABLE');
}

/** This checkout's writer ID, made on first use: one per checkout, never shared. */
export async function writerIdOf(root) {
  const { gitDir } = await directories(root);
  const existing = readWriterId(gitDir);
  if (existing) return existing;
  const writerId = `vw-${randomBytes(16).toString('hex')}`;
  await writeAtomic(writerFile(gitDir), { schema: WRITER_SCHEMA, writerId, createdAt: nowIso() });
  return readWriterId(gitDir) ?? writerId;
}

async function saveCheckpoint(commonDir, record) {
  const sealed = sealHere(commonDir, CHECKPOINT_PURPOSE, { ...record, schema: CHECKPOINT_SCHEMA, updatedAt: nowIso(),
    history: [...(record.history ?? []), { state: record.state, at: nowIso() }].slice(-16) });
  if (!sealed) throw refuse('This clone cannot seal its opening checkpoint.', 'VERSION_OPENING_STORAGE_UNAVAILABLE');
  await writeAtomic(checkpointFile(commonDir, record.workId, record.operationId), sealed);
  return sealed;
}

/** One operation's checkpoint on this clone, or null. */
export async function openingCheckpoint(root, workId, operationId) {
  const { commonDir } = await directories(root);
  return readCheckpoint(commonDir, workId, operationId);
}

/** The original refusal of a refused operation, replayed with its code and route. */
function replayedRefusal(checkpoint) {
  const error = refuse(checkpoint.refusal?.message ?? 'This opening was refused.', checkpoint.refusal?.code ?? 'VERSION_OPENING_REFUSED',
    { ...(checkpoint.refusal?.details ?? {}), operationId: checkpoint.operationId, replayed: true, checkpoint: 'refused' });
  return error;
}

// ------------------------------------------------------------------------------------------------ the opening operation

/**
 * Open `proposal.version` of `phase` as one operation. `open(workflow, phase)` makes the step's own opening (a code step's
 * intent, a document step's reservation) inside the governed transaction and returns the intent, if any. `receipt` is the
 * person's sealed consent; `principal` the identity opening it here. `fault(point)` lets tests stop it at a named point.
 * Returns `{ outcome, replayed, checkpoint }`; an uncertain shared acceptance throws with the operation's checkpoint.
 */
export async function openVersion(root, config, workflow, phase, { proposal, digest, receipt = null, principal = null, operationId = null,
  open, fault = null, agent = null, settled = null }) {
  const id = operationId ?? operationIdOf(digest);
  if (!validOperationId(id)) throw refuse(`'${id}' is not an opening operation ID.`, 'VERSION_OPENING_OPERATION_INVALID');
  const workId = workflow.workItem.id;
  const { commonDir } = await directories(root);
  await ensureKey(root);
  const payloadDigest = sha({ operation: OPENING_OPERATION, workId, phase: phase.id, version: proposal.version, proposalDigest: digest });
  const existing = readCheckpoint(commonDir, workId, id);
  // The same ID asks for the same thing, or it is refused; the same request returns what it got the first time [REQ-033].
  if (existing && existing.payloadDigest !== payloadDigest) {
    throw refuse(`Operation ${id} already opened something else (version ${existing.version} of ${existing.phase}); an operation ID is never reused for another request.`,
      'VERSION_OPENING_OPERATION_REUSED', { operationId: id, version: existing.version, phase: existing.phase });
  }
  if (existing?.state === 'shared-confirmed') return { outcome: existing.outcome, replayed: true, checkpoint: existing.state };
  if (existing?.state === 'refused') throw replayedRefusal(existing);
  if (['locally-persisted', 'shared-pending', 'unknown'].includes(existing?.state) || phase.versionOpening?.operationId === id) {
    return reconcileOpening(root, config, workflow, phase, { operationId: id });
  }
  // The opening is made only from the proposal as the Story is now: its number and its expected lifecycle revision.
  const { head } = await import('./git.mjs');
  const current = versionProposal(workflow, phase, { reason: proposal.reason, confirmation: proposal.confirmation,
    lifecycleRevision: proposal.lifecycleRevision === null ? null : head(root), adoption: proposal.adoption });
  if (current.digest !== digest) {
    throw refuse(`${phase.id} changed since version ${proposal.version} was proposed (now version ${current.proposal.version}, or the Story moved). Nothing was opened; preview it again so the person sees what they are asked.`,
      'VERSION_OPENING_STALE', { phase: phase.id, proposedVersion: proposal.version, currentVersion: current.proposal.version,
        nextAction: await legalNext(root, workflow, phase, config) });
  }
  // Only the first opening of version 1 omits the person's yes [§7.2]; every other needs its exact, sealed receipt, the
  // author's own correction too (owner, 2026-11-17) [D3, OSA:REQ-030]; but a review's findings on a version only the reviewer
  // saw open settled, with an undo, never as consent (owner, 2026-11-19; review-findings-opening.mjs).
  const reviewSettled = settled?.kind === 'review-corrections' && proposal.reason === 'review-corrections' && Boolean(settled.settlement) && !receipt;
  let settledRecord = null;
  const problem = reviewSettled ? null : proposal.consent !== 'not-required' || receipt ? consentProblem(commonDir, receipt, { digest, proposal, principal }) : null;
  // A yes that opens nothing (another person's, expired, declined, for another proposal, or none) is asked again: the
  // step's own preview, which this person answers themselves; the step's other next action only when that cannot be named.
  if (problem) throw refuse(`${problem.words} Nothing was opened.`, problem.code, { phase: phase.id, version: proposal.version,
    nextAction: await askAgain(phase) ?? await legalNext(root, workflow, phase, config) });
  const writerId = await writerIdOf(root);
  const fence = Number(phase.versionOpening?.writer?.fence ?? 0) + 1;
  const base = { operationId: id, payloadDigest, workId, phase: phase.id, version: proposal.version, proposalDigest: digest, history: [] };
  let checkpoint = await saveCheckpoint(commonDir, { ...base, state: 'prepared' });
  const move = async (state, extra = {}) => { checkpoint = await saveCheckpoint(commonDir, { ...checkpoint, ...extra, state }); return checkpoint; };
  if (fault) await fault('before-reservation', { operationId: id });
  const [{ commitAndPublish }, { LIFECYCLE_EVENT }, { workDirRelative }, { writeJson }] = await Promise.all([
    import('./story-publication-service.mjs'), import('./lifecycle-event.mjs'), import('./story-paths.mjs'), import('./util.mjs')]);
  const directory = workDirRelative(config, workId);
  const recordPath = posix(path.join(directory, 'context', 'version-openings', `${phase.id}-v${proposal.version}.json`));
  const openedAt = nowIso();
  const writer = { fence, writerId, operationId: id };
  let recordSha256 = null;
  let intent = null;
  let result;
  const { workflowPublicationMode } = await import('./story-publication-binding.mjs');
  const off = workflowPublicationMode(config, workflow) === 'off';
  const outcomeOf = (commit, pushed) => ({ operationId: id, workId, phase: phase.id, version: proposal.version, commit, pushed: Boolean(pushed),
    authority: off ? 'local-branch' : 'story-branch', recordPath, recordSha256, writer: { fence, writerId },
    consent: receipt ? { receiptId: receipt.receiptId, surface: receipt.response.surface, assurance: receipt.principal.assurance,
      confirmedAt: receipt.confirmedAt } : null, intent: intent?.id ? { id: intent.id } : null, openedAt });
  try {
    result = await commitAndPublish(root, config, workflow, { type: LIFECYCLE_EVENT.VERSION_OPENED, phaseId: phase.id, generation: proposal.version,
      ...(agent ? { agent } : {}),
      payload: { operationId: id, version: proposal.version, from: proposal.from.published, reason: proposal.reason, proposalDigest: digest,
        consentReceiptId: receipt?.receiptId ?? null, writerFence: fence } },
    `Open ${phase.id} version ${proposal.version} of ${workId}`, [], {
      transactionId: id,
      // Only the Story's metadata: never application files, unrelated changes or local attachments [§7.2, OSA:REQ-031].
      exactWorkItemPaths: [recordPath, posix(path.join(directory, 'context', 'generation-start')), posix(path.join(directory, 'context', 'work-intervals'))],
      beforeStateWrite: async () => {
        intent = await open(workflow, phase);
        // The settlement that stands in for the person's yes is written in this same commit: an opening that fails leaves none.
        if (reviewSettled) {
          settledRecord = (await import('./settled-decisions.mjs')).recordSettledDecision(workflow, { ...settled.settlement, at: openedAt, actor: settled.actor ?? null, agent });
          (workflow.history ??= []).push({ at: openedAt, actor: settled.actor ?? 'system', agent, event: 'decision_settled', phase: phase.id,
            detail: `${settledRecord.id} (${settledRecord.kind}) settled by SFlow: ${settledRecord.answer}` });
        }
        const record = { schema: RECORD_SCHEMA, operationId: id, payloadDigest, proposal, proposalDigest: digest, consent: receipt,
          ...(reviewSettled ? { settled: { kind: settledRecord.kind, id: settledRecord.id } } : {}),
          writer: { ...writer, actor: principal ? { name: principal.name ?? null, email: principal.email ?? null, login: principal.login ?? null } : null },
          intent: intent?.id ? { id: intent.id, receiptSha256: intent.receiptSha256 ?? null } : null, openedAt };
        recordSha256 = sha(record);
        await writeJson(path.join(root, recordPath), record);
        // The reservation moves the high-watermark in the same commit as the opening it reserves [§4.3, §7.2].
        phase.versionOpening = { operationId: id, version: proposal.version, highWatermark: proposal.version, reason: proposal.reason,
          path: recordPath, sha256: recordSha256, consent: receipt ? { receiptId: receipt.receiptId, surface: receipt.response.surface,
            assurance: receipt.principal.assurance } : reviewSettled ? { settled: settledRecord.id, surface: 'settled' } : null, writer, openedAt };
        (workflow.history ??= []).push({ at: openedAt, actor: principal?.email ?? principal?.name ?? 'system', agent, event: 'version_opened',
          phase: phase.id, detail: `version ${proposal.version} opened (${proposal.reason})${receipt ? ` on the person's yes (${receipt.response.surface})`
            : reviewSettled ? ` settled for the person (${settledRecord.id}; only the reviewer had seen version ${proposal.from?.published ?? proposal.version - 1})` : ''}` });
      },
      fault: async (point, context) => {
        // The commit exists on this clone; its shared acceptance is pending until the push answers [§7.2 checkpoints].
        if (point === 'after-commit') await move('locally-persisted', { commit: context.sourceCommit, recordPath, recordSha256 });
        // The remote took the leased push: the shared authority accepted the opening.
        if (point === 'after-push' && context.pushed) await move('shared-confirmed', { commit: context.publishedCommit, outcome: outcomeOf(context.publishedCommit, true) });
        if (fault) await fault(point, context);
      }
    });
  } catch (error) {
    if (error?.publicationRefAdvanced) {
      // The commit is on this branch and retained for sync; what the remote did with it decides the checkpoint.
      const conflict = error.outcomeClass === 'REVISION_CONFLICT';
      const state = conflict ? 'refused' : error.pushOutcome === 'transport-indeterminate' ? 'unknown' : 'shared-pending';
      const refusal = conflict ? { code: 'VERSION_OPENING_CONFLICT', message: `Another checkout changed ${workId}'s shared branch first, so version ${proposal.version} of ${phase.id} was not opened there. Your local opening commit is kept, unpublished.`,
        details: { phase: phase.id, version: proposal.version, nextAction: { command: `singularity-flow sync ${workId} --set-aside`,
          label: 'Set this unpublished opening aside and follow the shared branch' } } } : null;
      await move(state, { commit: error.publicationCommit ?? checkpoint.commit ?? null, recordPath, recordSha256, ...(refusal ? { refusal } : {}) });
      if (conflict) throw replayedRefusal({ ...checkpoint, refusal: { ...refusal, details: { ...refusal.details, originalCode: error.code ?? null } } });
      throw Object.assign(refuse(`Version ${proposal.version} of ${phase.id} is committed here, but whether the shared Story branch accepted it is ${state === 'unknown' ? 'unknown (the push\'s answer was lost)' : 'pending (the push did not complete)'}. `
        + 'Nothing may be written in it until that is settled, and no other version is opened instead.', state === 'unknown' ? 'VERSION_OPENING_OUTCOME_UNKNOWN' : 'VERSION_OPENING_SHARED_PENDING',
      { phase: phase.id, version: proposal.version, operationId: id, checkpoint: state, original: { code: error.code ?? null, message: String(error.message ?? '').slice(0, 600) },
        nextAction: { command: `singularity-flow phase opening ${phase.id} --reconcile --json`, label: `Settle whether version ${proposal.version}'s opening reached the shared branch` } }), { cause: error });
    }
    // Stopped after its commit (a fault after local persistence): the outcome is settled as the same operation, never redone.
    if (checkpoint.state !== 'prepared') {
      if (checkpoint.state === 'locally-persisted') await move('unknown');
      throw Object.assign(refuse(`Version ${proposal.version} of ${phase.id} was committed here, then stopped before its shared acceptance was known. Nothing may be written in it until that is settled, and no other version is opened instead.`,
        'VERSION_OPENING_OUTCOME_UNKNOWN', { phase: phase.id, version: proposal.version, operationId: id, checkpoint: checkpoint.state,
          original: { code: error?.code ?? null, message: String(error?.message ?? '').slice(0, 600) },
          nextAction: { command: `singularity-flow phase opening ${phase.id} --reconcile --json`, label: `Settle whether version ${proposal.version}'s opening reached the shared branch` } }), { cause: error });
    }
    // Refused before any commit: nothing was opened, and the operation may run again once its cause is gone.
    await rm(checkpointFile(commonDir, workId, id), { force: true }).catch(() => {});
    throw error;
  }
  const outcome = outcomeOf(result.sha, result.pushed);
  // With publication on, only a push the remote answered is shared acceptance; `warn` keeps an unanswered one pending.
  if (!off && !result.pushed) {
    await move('shared-pending', { commit: result.sha, recordPath, recordSha256, outcome });
    throw refuse(`Version ${proposal.version} of ${phase.id} is committed here; its shared acceptance is pending until sync publishes it. Nothing may be written in it until then.`,
      'VERSION_OPENING_SHARED_PENDING', { phase: phase.id, version: proposal.version, operationId: id, checkpoint: 'shared-pending',
        nextAction: { command: `singularity-flow phase opening ${phase.id} --reconcile --json`, label: `Publish and settle version ${proposal.version}'s opening` } });
  }
  await move('shared-confirmed', { commit: result.sha, recordPath, recordSha256, outcome });
  if (receipt) await dropGrant(commonDir, digest);
  if (fault) await fault('before-reply', { operationId: id, outcome });
  return { outcome, replayed: false, checkpoint: 'shared-confirmed', ...(settledRecord ? { settled: settledRecord } : {}) };
}

// ------------------------------------------------------------------------------------------------ reconciliation

/**
 * Settle an opening whose shared acceptance is not confirmed here, as the same operation [§7.2, OSA:REQ-033]: publish its
 * exact retained commit through the Story's sync when it is still waiting, then observe the Story branch. It never authors
 * again and never opens another version: an unreadable remote leaves it unknown. By default it settles the operation the
 * step's view reads (story-version-acceptance.mjs observeOpening): the writer takeover's, once the writer was taken over.
 * Settling only the opening's own, a takeover whose push did not land was named "settle it" forever (review, 2026-11-17).
 */
export async function reconcileOpening(root, config, workflow, phase, { operationId = phase?.versionOpening?.writer?.operationId ?? phase?.versionOpening?.operationId ?? null } = {}) {
  const workId = workflow.workItem.id;
  const { commonDir } = await directories(root);
  if (!validOperationId(operationId)) throw refuse(`${phase.id} has no opening to settle.`, 'VERSION_OPENING_NOT_FOUND', { phase: phase.id });
  let checkpoint = readCheckpoint(commonDir, workId, operationId);
  if (checkpoint?.state === 'shared-confirmed') return { outcome: checkpoint.outcome, replayed: true, checkpoint: checkpoint.state };
  if (checkpoint?.state === 'refused') throw replayedRefusal(checkpoint);
  // The step's opening record names its own operation and its writer's (a takeover moves the writer with its own).
  const named = (opening) => opening?.operationId === operationId || opening?.writer?.operationId === operationId;
  const pointer = named(phase.versionOpening) ? phase.versionOpening : null;
  if (!checkpoint && !pointer) throw refuse(`Operation ${operationId} opened nothing that this checkout knows of.`, 'VERSION_OPENING_NOT_FOUND', { operationId });
  // Stopped before its reservation: nothing was committed, so nothing is settled; the same confirmation runs it again.
  if (checkpoint?.state === 'prepared' && !pointer) throw refuse(`Version ${checkpoint.version} of ${phase.id} was not opened: its operation stopped before anything was committed. Run the same confirmation again.`,
    'VERSION_OPENING_NOT_STARTED', { operationId, phase: phase.id, nextAction: await legalNext(root, workflow, phase) });
  await ensureKey(root);
  const [{ head, commitIsAncestor }, { workflowPublicationMode, workflowPublicationBranch }, pending] = await Promise.all([
    import('./git.mjs'), import('./story-publication-binding.mjs'), import('./publication-pending.mjs')]);
  const base = checkpoint ?? { operationId, payloadDigest: null, workId, phase: phase.id, version: pointer.version, proposalDigest: null,
    recordPath: pointer.path, recordSha256: pointer.sha256, history: [] };
  const save = async (state, extra = {}) => { checkpoint = await saveCheckpoint(commonDir, { ...base, ...checkpoint, ...extra, state }); return checkpoint; };
  let commit = checkpoint?.commit ?? null;
  if (!commit) {
    // No commit kept here: the opening settles by its committed record only, never by a working-copy edit [§14].
    const [{ sourceFileAt }, { workDirRelative }] = await Promise.all([import('./source-inspection.mjs'), import('./story-paths.mjs')]);
    const committed = sourceFileAt(root, 'HEAD', `${workDirRelative(config, workId)}/workflow.json`);
    let held = false;
    try { held = committed.status === 'present' && named(JSON.parse(committed.value)?.phases?.[phase.id]?.versionOpening); } catch { held = false; }
    if (!held) throw refuse(`The opening ${operationId} of ${phase.id} is in this working copy only, never committed: it opens nothing. Inspect what this checkout knows of it; its next version opens only through its own preview and the person's yes.`,
      'VERSION_OPENING_NOT_SHARED', { operationId, phase: phase.id, nextAction: { command: `singularity-flow phase opening ${phase.id} --json` } });
    commit = head(root);
  }
  // A retained commit of this very operation is published by the Story's own sync, under the lease it was made against.
  const retained = await pending.readPendingPublication(root, { kind: 'story', id: workId }).catch(() => null);
  if (retained?.record?.transactionId === operationId) {
    try { await pending.syncPendingLifecyclePublication(root, { kind: 'story', id: workId }); }
    catch (error) {
      if (/non-fast-forward|fetch first|stale info|another clone published/iu.test(String(error?.message ?? '')) || error?.outcomeClass === 'REVISION_CONFLICT'
          || error?.code === 'PUBLICATION_REMOTE_CHANGED') {
        const refusal = { code: 'VERSION_OPENING_CONFLICT', message: `Another checkout changed ${workId}'s shared branch first, so this opening of version ${base.version} was not accepted there.`,
          details: { phase: phase.id, version: base.version, nextAction: { command: `singularity-flow sync ${workId} --set-aside`,
            label: 'Set this unpublished opening aside and follow the shared branch' } } };
        await save('refused', { refusal });
        throw replayedRefusal(checkpoint);
      }
      await save('unknown');
      throw Object.assign(refuse(`Version ${base.version} of ${phase.id} is still not on the shared Story branch: ${String(error?.message ?? '').slice(0, 300)} Nothing else was opened; settle it again once the remote answers.`,
        'VERSION_OPENING_OUTCOME_UNKNOWN', { phase: phase.id, version: base.version, operationId, checkpoint: 'unknown', original: { code: error?.code ?? null },
          nextAction: { command: `singularity-flow phase opening ${phase.id} --reconcile --json`, label: `Settle version ${base.version}'s opening again` } }), { cause: error });
    }
  }
  const local = commit ?? head(root);
  const outcomeOf = (authority) => checkpoint?.outcome ?? { operationId, workId, phase: phase.id, version: base.version, commit: local, pushed: authority === 'story-branch',
    authority, recordPath: base.recordPath ?? pointer?.path ?? null, recordSha256: base.recordSha256 ?? pointer?.sha256 ?? null,
    writer: pointer?.writer ? { fence: pointer.writer.fence, writerId: pointer.writer.writerId } : null, consent: pointer?.consent ?? null, intent: null,
    openedAt: pointer?.openedAt ?? null, reconciled: true };
  if (workflowPublicationMode(config, workflow) === 'off') {
    if (commit && !commitIsAncestor(root, commit, head(root))) {
      await save('refused', { refusal: { code: 'VERSION_OPENING_NOT_SHARED', message: `The opening commit of version ${base.version} is no longer on this branch.` } });
      throw replayedRefusal(checkpoint);
    }
    await save('shared-confirmed', { outcome: outcomeOf('local-branch') });
    return { outcome: checkpoint.outcome, replayed: true, checkpoint: 'shared-confirmed' };
  }
  const [{ configuredRemoteAuthority }, { lifecycleAuthority }] = await Promise.all([import('./git-remote-diagnostics.mjs'), import('./sda/story-branch-authority.mjs')]);
  const remote = config.git?.remote ?? 'origin';
  const branch = workflowPublicationBranch(root, workflow);
  const authority = configuredRemoteAuthority(root, remote);
  const observed = authority?.url ? await lifecycleAuthority(root).observe({ remote: authority.url, branch }).catch(() => null) : null;
  const holds = await pending.remoteBranchHolds(root, { observed, commit: local, remote, branch });
  if (holds === 'exact' || holds === 'descendant') {
    await save('shared-confirmed', { commit: local, outcome: outcomeOf('story-branch') });
    return { outcome: checkpoint.outcome, replayed: true, checkpoint: 'shared-confirmed', remote: holds };
  }
  if (holds === 'absent') {
    await save('shared-pending', { commit: local });
    throw refuse(`Version ${base.version} of ${phase.id} is committed here but not on the shared Story branch. Publish it with singularity-flow sync ${workId}, then settle it again. Nothing else was opened.`,
      'VERSION_OPENING_SHARED_PENDING', { phase: phase.id, version: base.version, operationId, checkpoint: 'shared-pending',
        nextAction: { command: `singularity-flow sync ${workId}`, label: `Publish the opening of version ${base.version}` } });
  }
  await save('unknown', { commit: local });
  throw refuse(`The shared Story branch of ${workId} could not be read, so whether version ${base.version} of ${phase.id} was accepted is unknown. Nothing may be written in it, and nothing else is opened; settle it again when the remote answers.`,
    'VERSION_OPENING_OUTCOME_UNKNOWN', { phase: phase.id, version: base.version, operationId, checkpoint: 'unknown',
      nextAction: { command: `singularity-flow phase opening ${phase.id} --reconcile --json`, label: `Settle version ${base.version}'s opening again` } });
}

/**
 * The relevant shared authority, read once at a consequential boundary (the authoring entry): the Story branch's remote
 * tip against this checkout [§7.3]. `stale` when the shared branch moved past what this checkout holds (another checkout
 * opened, published or took over), `unavailable` when it cannot be read (offline), else `verified`. Only the Story's own
 * branch is read, never another branch or the history; nothing is fetched or changed.
 */
export async function sharedAuthorityAt(root, config, workflow) {
  const [{ workflowPublicationMode, workflowPublicationBranch }, { configuredRemoteAuthority }, { lifecycleAuthority }, { head }, { sourceContains }] = await Promise.all([
    import('./story-publication-binding.mjs'), import('./git-remote-diagnostics.mjs'), import('./sda/story-branch-authority.mjs'), import('./git.mjs'),
    import('./source-inspection.mjs')]);
  if (workflowPublicationMode(config, workflow) === 'off') return { status: 'verified', authority: 'local-branch' };
  const url = configuredRemoteAuthority(root, config.git?.remote ?? 'origin')?.url;
  const observed = url ? await lifecycleAuthority(root).observe({ remote: url, branch: workflowPublicationBranch(root, workflow) }, { allowPrefetched: true }).catch(() => null) : null;
  if (!observed || observed.reachable !== true || observed.malformed) return { status: 'unavailable', diagnostic: 'The shared Story branch could not be read; this checkout\'s view of it may be old.' };
  const local = head(root);
  if (!observed.sha || observed.sha === local) return { status: 'verified', remote: observed.sha ?? null, local };
  const behind = sourceContains(root, observed.sha, local, { offline: true });
  return behind.status === 'present' && behind.value ? { status: 'verified', remote: observed.sha, local }
    : { status: 'stale', remote: observed.sha, local, diagnostic: 'The shared Story branch moved past this checkout: another checkout opened, published or took over a version.' };
}

/** What this checkout knows of `phase`'s opening: its record, checkpoint and writer, read only [§7.3]. */
export async function inspectOpening(root, workflow, phase) {
  const pointer = phase.versionOpening ?? null;
  const { commonDir, gitDir } = await directories(root);
  const holder = pointer?.writer?.operationId ?? pointer?.operationId ?? null;
  const checkpoint = holder ? readCheckpoint(commonDir, workflow.workItem.id, holder) : null;
  const own = readWriterId(gitDir);
  const opened = openingFactsOf(phase);
  return { schemaVersion: 1, resultType: 'sflow-version-opening', workId: workflow.workItem.id, phase: phase.id,
    opening: pointer ? { operationId: pointer.operationId, version: pointer.version, reason: pointer.reason, path: pointer.path, sha256: pointer.sha256,
      consent: pointer.consent ?? null, writer: { fence: pointer.writer?.fence ?? null, current: Boolean(own && pointer.writer?.writerId === own) }, openedAt: pointer.openedAt } : null,
    checkpoint: checkpoint ? { operationId: checkpoint.operationId, state: checkpoint.state, commit: checkpoint.commit ?? null, updatedAt: checkpoint.updatedAt } : null,
    legacyIntent: opened?.status === 'open' && opened.record === 'legacy' ? { version: opened.version, record: 'legacy' } : null };
}

// ------------------------------------------------------------------------------------------------ the writer fence

/**
 * Move an open version's writer fence to this checkout, after a verified takeover (`session takeover`) [§7.3, OSA:REQ-034,
 * AC-017]: one leased commit names this checkout's writer and the next fence number, so the old writer is refused at its
 * next entry, publication, review retention or submission. Returns null when there is nothing to take over.
 */
export async function takeOverWriter(root, config, workflow, phase, { fault = null, principal = null } = {}) {
  const pointer = phase?.versionOpening;
  const numbers = versionNumbers(versionFactsOf(workflow, phase));
  if (!pointer?.operationId || !numbers.ok || numbers.writing === null || Number(pointer.version) !== numbers.writing) return null;
  const writerId = await writerIdOf(root);
  if (pointer.writer?.writerId === writerId) return { taken: false, current: true, fence: pointer.writer.fence ?? null };
  const workId = workflow.workItem.id;
  const { commonDir } = await directories(root);
  await ensureKey(root);
  const id = `vt-${randomBytes(16).toString('hex')}`;
  const fence = Number(pointer.writer?.fence ?? 0) + 1;
  const [{ commitAndPublish }, { LIFECYCLE_EVENT }, { workDirRelative }, { writeJson }] = await Promise.all([
    import('./story-publication-service.mjs'), import('./lifecycle-event.mjs'), import('./story-paths.mjs'), import('./util.mjs')]);
  const recordPath = posix(path.join(workDirRelative(config, workId), 'context', 'version-openings', `${phase.id}-v${pointer.version}-fence${fence}.json`));
  let checkpoint = await saveCheckpoint(commonDir, { operationId: id, payloadDigest: sha({ operation: TAKEOVER_OPERATION, workId, phase: phase.id, version: pointer.version, fence }),
    workId, phase: phase.id, version: pointer.version, proposalDigest: null, state: 'prepared', history: [] });
  const at = nowIso();
  try {
    const result = await commitAndPublish(root, config, workflow, { type: LIFECYCLE_EVENT.VERSION_WRITER_TAKEN_OVER, phaseId: phase.id, generation: pointer.version,
      payload: { operationId: id, version: pointer.version, fence, previousFence: pointer.writer?.fence ?? null } },
    `Take over ${phase.id} version ${pointer.version} of ${workId}`, [], {
      transactionId: id, exactWorkItemPaths: [recordPath],
      beforeStateWrite: async () => {
        await writeJson(path.join(root, recordPath), { schema: TAKEOVER_SCHEMA, operationId: id, opening: pointer.operationId, version: pointer.version,
          fence, previous: { fence: pointer.writer?.fence ?? null, writerId: pointer.writer?.writerId ?? null }, writerId,
          actor: principal ? { name: principal.name ?? null, email: principal.email ?? null, login: principal.login ?? null } : null, at });
        phase.versionOpening = { ...pointer, writer: { fence, writerId, operationId: id } };
        (workflow.history ??= []).push({ at, actor: principal?.email ?? principal?.name ?? 'system', agent: null, event: 'version_writer_taken_over',
          phase: phase.id, detail: `version ${pointer.version}: writer fence ${fence}` });
      },
      fault: async (point, context) => {
        if (point === 'after-commit') checkpoint = await saveCheckpoint(commonDir, { ...checkpoint, state: 'locally-persisted', commit: context.sourceCommit });
        if (fault) await fault(point, context);
      }
    });
    const { workflowPublicationMode } = await import('./story-publication-binding.mjs');
    const shared = result.pushed || workflowPublicationMode(config, workflow) === 'off';
    checkpoint = await saveCheckpoint(commonDir, { ...checkpoint, state: shared ? 'shared-confirmed' : 'shared-pending', commit: result.sha,
      outcome: { operationId: id, version: pointer.version, fence, commit: result.sha } });
    return { taken: shared, fence, operationId: id, commit: result.sha, checkpoint: checkpoint.state };
  } catch (error) {
    if (error?.publicationRefAdvanced) {
      checkpoint = await saveCheckpoint(commonDir, { ...checkpoint, state: error.outcomeClass === 'REVISION_CONFLICT' ? 'refused'
        : error.pushOutcome === 'transport-indeterminate' ? 'unknown' : 'shared-pending', commit: error.publicationCommit ?? null });
    } else await rm(checkpointFile(commonDir, workId, id), { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * At a consequential boundary (publication, review retention, submission), the open version must be one this checkout
 * may write: an operation's opening accepted on the shared branch and held by this checkout's writer [§7.3, OSA:REQ-034].
 * A legacy local opening is let through as before; the kernel and its route promote it.
 */
export async function assertOpeningWriter(root, workflow, phase) {
  const { observeOpening } = await import('./story-version-acceptance.mjs');
  const numbers = versionNumbers(versionFactsOf(workflow, phase));
  // Only the open version an operation opened: a published one, or a legacy local opening, is checked as before.
  if (!phase?.versionOpening || !numbers.ok || numbers.writing === null || Number(phase.versionOpening.version) !== numbers.writing) return null;
  const observed = observeOpening(root, workflow, phase);
  if (!observed) return null;
  const version = phase.versionOpening.version;
  if (observed.writer !== 'current') {
    throw refuse(`Another checkout holds version ${version} of ${phase.id} (writer fence ${observed.fence ?? 'unknown'}); this one may inspect it but not publish, retain a review or submit it. Take it over first only when that checkout's work is published or set aside.`,
      'VERSION_WRITER_FENCED', { phase: phase.id, version, fence: observed.fence, nextAction: { command: `singularity-flow session takeover ${workflow.workItem.id} --json` } });
  }
  if (observed.acceptance !== 'confirmed') {
    throw refuse(`Version ${version} of ${phase.id} is not confirmed on the shared Story branch yet (${observed.acceptance}); settle its opening before publishing, retaining a review or submitting it.`,
      'VERSION_OPENING_NOT_ACCEPTED', { phase: phase.id, version, acceptance: observed.acceptance,
        nextAction: { command: `singularity-flow phase opening ${phase.id} --reconcile --json` } });
  }
  return observed;
}
