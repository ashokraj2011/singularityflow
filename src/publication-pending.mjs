import path from 'node:path';
import os from 'node:os';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import {
  branch, changes, commitIsAncestor, exactRemoteBranchObservationAsync, gitCommonDir,
  governedCommitIdentity, head, publicationPushOutcome, pushCommitToBranchAsync, refExists, refHead,
  remoteContains
} from './git.mjs';
import { configuredRemoteAuthority } from './git-remote-diagnostics.mjs';
import {
  clearPublicationJournal,
  publicationJournalOwnedByCurrentProcess,
  readPublicationJournal,
  updatePublicationJournal
} from './publication-journal.mjs';
import { bindLifecycleEvent } from './lifecycle-event.mjs';
import { recordSha256 } from './records.mjs';
import { exists, readJson, SingularityFlowError, writeJson } from './util.mjs';
import { subjectRef } from './subject-ref.mjs';
import { currentSchemaVersion, readRecord, stampCurrentRecord } from './schema-migrations.mjs';
import { restorePublicationPreimage } from './publication-recovery.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { subjectLockPath } from './subject-lock.mjs';
import {
  prepareSharedPublicationStorage, resolveSharedPublicationFile
} from './publication-storage.mjs';
import {
  MACHINE_LOCAL_PUBLICATION_INTEGRITY_SCHEME,
  machineLocalPublicationIntegrityKey
} from './publication-machine-integrity.mjs';
export {
  sealMachineLocalPublicationReceipt,
  verifyMachineLocalPublicationReceipt
} from './publication-machine-integrity.mjs';
import {
  sgosLifecycleCandidateIdentity,
  publishVerifiedSgosLifecycleCandidate,
  verifySgosLifecycleCandidateBinding
} from './sgos/candidate-lifecycle.mjs';

const PENDING_PUBLICATION_FAMILY = 'pending-publication';
const PENDING_INTEGRITY_SCHEME = MACHINE_LOCAL_PUBLICATION_INTEGRITY_SCHEME;

function pendingIntegrityPayload(record) {
  const { recoveryIntegrity: _integrity, ...payload } = record ?? {};
  return `sha256:${recordSha256(payload)}`;
}

async function sealPendingPublication(root, record) {
  const key = await machineLocalPublicationIntegrityKey(root, { create: true });
  if (!key) throw new SingularityFlowError('Pending-publication integrity key is unavailable.');
  const payload = pendingIntegrityPayload(record);
  return {
    ...record,
    recoveryIntegrity: {
      scheme: PENDING_INTEGRITY_SCHEME,
      keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
      mac: `sha256:${createHmac('sha256', key).update(payload).digest('hex')}`
    }
  };
}

export async function verifyPendingPublicationIntegrity(root, record) {
  const integrity = record?.recoveryIntegrity;
  const key = await machineLocalPublicationIntegrityKey(root);
  if (!key || integrity?.scheme !== PENDING_INTEGRITY_SCHEME
    || integrity.keyId !== createHash('sha256').update(key).digest('hex').slice(0, 16)
    || !/^sha256:[0-9a-f]{64}$/.test(integrity.mac ?? '')) return false;
  const expected = Buffer.from(
    createHmac('sha256', key).update(pendingIntegrityPayload(record)).digest('hex'), 'hex'
  );
  const actual = Buffer.from(integrity.mac.slice('sha256:'.length), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function writeSealedPendingPublication(root, target, record) {
  await writeJson(target, await sealPendingPublication(
    root, stampCurrentRecord(PENDING_PUBLICATION_FAMILY, record)
  ));
}

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
}

function displayMarkerPath(root, absolute) {
  if (!absolute) return null;
  const relative = path.relative(root, absolute);
  if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return `pending-publication/${path.basename(absolute)}`;
}

export function localPendingPublicationPath(root, kind, id) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'pending-publication', `${kind}--${safeId(id)}.json`);
}

async function sharedPendingPublication(root, kind, id, { migrate = true } = {}) {
  const resolved = await resolveSharedPublicationFile(root, {
    directory: 'pending-publication',
    name: `${kind}--${safeId(id)}.json`,
    label: `Pending publication for ${kind} '${id}'`,
    // Keep the stored representation beside the migrated in-memory record. Recovery integrity was
    // computed over those historical bytes; verifying a v2 MAC after adding v3's `candidate:null`
    // changes the signed payload and makes every authentic pre-Candidate marker look tampered.
    read: async (target) => {
      const stored = await readJson(target);
      const decoded = readRecord(PENDING_PUBLICATION_FAMILY, stored);
      return {
        stored,
        record: decoded.record,
        storedVersion: decoded.storedVersion,
        migratedThrough: decoded.migratedThrough,
        integrityVerified: await verifyPendingPublicationIntegrity(root, stored)
      };
    },
    // Repository-common and linked-worktree copies must agree on the exact sealed representation,
    // not merely on the shape a newer reader derives from it.
    identity: (value) => recordSha256(value.stored),
    migrate
  });
  if (!resolved) return null;

  let envelope = resolved.value;
  let schemaMigrated = false;
  if (migrate && envelope.migratedThrough.length > 0 && envelope.integrityVerified) {
    // Authenticate the stored v2 payload first, then atomically replace it with a newly sealed v3
    // record. A crash sees either complete receipt; it never sees migrated bytes with the old MAC.
    await writeSealedPendingPublication(root, resolved.path, envelope.record);
    const stored = await readJson(resolved.path);
    const decoded = readRecord(PENDING_PUBLICATION_FAMILY, stored);
    envelope = {
      stored,
      record: decoded.record,
      storedVersion: decoded.storedVersion,
      migratedThrough: decoded.migratedThrough,
      integrityVerified: await verifyPendingPublicationIntegrity(root, stored)
    };
    if (!envelope.integrityVerified || envelope.storedVersion !== currentSchemaVersion(PENDING_PUBLICATION_FAMILY)) {
      throw new SingularityFlowError(
        `Pending publication for ${kind} '${id}' could not be resealed after schema migration.`,
        { code: 'PENDING_PUBLICATION_PROGRESS_INTEGRITY_INVALID' }
      );
    }
    schemaMigrated = true;
  }
  return {
    ...resolved,
    value: envelope.record,
    storedValue: envelope.stored,
    storedVersion: envelope.storedVersion,
    integrityVerified: envelope.integrityVerified,
    schemaMigrated,
    migrated: resolved.migrated || schemaMigrated
  };
}

/**
 * Where a pre-kernel release would have left the marker.
 *
 * `workItemRoot` and `initiativeRoot` are configurable, and this hard-coded `singularity/…`, so a
 * repository that keeps its work items anywhere else had markers that no lookup here could see —
 * while every mutation path, which passes its own `legacyPath`, refused to run because of them.
 */
export function defaultLegacyPendingPublicationPath(root, kind, id, roots = {}) {
  const directory = kind === 'initiative'
    ? (roots.initiativeRoot ?? 'singularity/initiatives')
    : kind === 'story'
      ? (roots.workItemRoot ?? 'singularity/work-items')
      : null;
  // Ad hoc and Goal receipts were Git-local from their first supported release. Treating every
  // non-Initiative subject as a legacy Story would let `adhoc sync`/`goal sync` unlink an unrelated
  // tracked Story marker whose ID happened to match.
  if (!directory) return null;
  return path.join(root, directory, String(id), 'publication-pending.json');
}

function legacyCandidates(root, { kind, id, legacyPath = null, roots = {} } = {}) {
  return [...new Set([
    legacyPath,
    defaultLegacyPendingPublicationPath(root, kind, id, roots),
    // The stock location too, so a repository that moved its roots still finds what an older
    // release left behind before the move.
    defaultLegacyPendingPublicationPath(root, kind, id)
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

function recoveryRecord(journal, updates = {}) {
  return {
    ...(journal.pendingMetadata ?? {}),
    schemaVersion: currentSchemaVersion(PENDING_PUBLICATION_FAMILY),
    subject: journal.subject,
    branch: journal.branch,
    remote: journal.remote,
    remoteFingerprint: journal.remoteFingerprint ?? null,
    commit: journal.commit ?? null,
    event: journal.commit ? bindLifecycleEvent(journal.event, journal.commit) : journal.event,
    transactionId: journal.transactionId ?? null,
    tree: journal.tree ?? null,
    eventSha256: journal.eventSha256 ?? null,
    stateSha256: journal.stateSha256 ?? null,
    publicationMode: journal.publicationMode ?? null,
    candidate: journal.candidate ?? null,
    pushOutcome: journal.pushOutcome ?? 'not-attempted',
    ...(journal.expectedRemoteSha !== undefined
      ? { expectedRemoteSha: journal.expectedRemoteSha }
      : {}),
    createdAt: journal.createdAt,
    ...updates
  };
}

function divergentRecovery(journal, reason) {
  return recoveryRecord(journal, {
    recoveryStage: 'publication-recovery-diverged',
    code: 'PUBLICATION_RECOVERY_DIVERGED',
    error: `Automatic recovery stopped because ${reason}. The journal was retained and no ref or remote was changed.`
  });
}

function verifiedJournalCommit(root, journal) {
  if (!journal.transactionId || !journal.commit || !journal.tree || !journal.stateSha256) {
    return { valid: false, reason: 'the journal does not identify one exact transaction commit' };
  }
  const identity = governedCommitIdentity(root, journal.commit);
  if (!identity) return { valid: false, reason: `recorded commit ${journal.commit} is unavailable` };
  const candidateFailures = candidateBindingFailures(journal.candidate);
  if (candidateFailures.length) return { valid: false, reason: candidateFailures[0] };
  if (journal.candidate != null) {
    const expectedCandidate = sgosLifecycleCandidateIdentity(journal.event);
    if (journal.candidate.candidateId !== expectedCandidate.candidateId
        || journal.candidate.normalizedEventSha256 !== expectedCandidate.normalizedEventSha256) {
      return { valid: false, reason: 'the Candidate does not bind the journal lifecycle event' };
    }
  }
  const expectedStateSha256 = `sha256:${recordSha256({
    transactionId: journal.transactionId,
    expectedHead: journal.expectedHead,
    branch: journal.branch,
    tree: journal.tree,
    eventSha256: journal.eventSha256,
    publicationMode: journal.publicationMode,
    ...(journal.candidate ? { candidate: journal.candidate } : {}),
    ...(journal.remoteFingerprint ? { remoteFingerprint: journal.remoteFingerprint } : {}),
    ...(journal.expectedRemoteSha !== undefined
      ? { expectedRemoteSha: journal.expectedRemoteSha }
      : {})
  })}`;
  const mismatch = [
    [identity.parents.length === 1 && identity.parents[0] === journal.expectedHead, 'parent commit'],
    [identity.tree === journal.tree, 'tree'],
    [identity.transactionId === journal.transactionId, 'transaction ID'],
    [identity.eventSha256 === journal.eventSha256, 'event digest'],
    [identity.stateSha256 === journal.stateSha256, 'state digest'],
    [journal.stateSha256 === expectedStateSha256, 'recomputed state digest'],
    [identity.publicationMode === journal.publicationMode, 'publication mode'],
    [candidateIdentityMatches(identity.candidate, journal.candidate), 'Candidate binding'],
    [journal.candidate == null || journal.tree === journal.candidate.candidateTree,
      'Candidate tree']
  ].find(([matches]) => !matches);
  return mismatch
    ? { valid: false, reason: `the recorded commit has a different ${mismatch[1]}` }
    : { valid: true, identity };
}

function fullObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

function sha256Digest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function candidateBindingFailures(candidate, label = 'Candidate binding') {
  if (candidate == null) return [];
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return [`${label} is invalid`];
  const failures = [];
  if (!/^CAN-[A-Za-z0-9._:-]{6,127}$/.test(candidate.candidateId ?? '')) {
    failures.push(`${label} ID is invalid`);
  }
  for (const field of [
    'normalizedEventSha256', 'candidateSha256', 'retainedCandidateSha256', 'verificationReceiptSha256',
    'verificationProfileSha256'
  ]) {
    if (!sha256Digest(candidate[field])) failures.push(`${label} ${field} is invalid`);
  }
  for (const field of ['candidateTree', 'candidateCommit']) {
    if (!fullObjectId(candidate[field])) failures.push(`${label} ${field} is invalid`);
  }
  return failures;
}

function candidateIdentityMatches(identityCandidate, candidate) {
  if (candidate == null) return identityCandidate == null;
  if (!identityCandidate || identityCandidate.invalid === true) return false;
  return identityCandidate.candidateId === candidate.candidateId
    && identityCandidate.candidateSha256 === candidate.candidateSha256
    && identityCandidate.verificationReceiptSha256 === candidate.verificationReceiptSha256
    && identityCandidate.verificationProfileSha256 === candidate.verificationProfileSha256;
}

/**
 * Verify that a durable post-commit recovery marker names one exact governed transaction.
 *
 * A pending marker is transport authority: `sync` is allowed to move a remote ref solely because
 * this record says a prior governed transaction crossed its local commit boundary. Schema-version
 * validation alone does not prove that claim. Bind every mutable marker field back to the immutable
 * commit object and its trailers before exposing the commit to a push command.
 */
export function verifyPendingPublicationCommit(root, record, {
  subject = null,
  branch: expectedBranch = null,
  remote: expectedRemote = null,
  allowPublicationOff = false
} = {}) {
  const failures = [];
  const publicationModes = allowPublicationOff ? ['off', 'required', 'warn'] : ['required', 'warn'];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return Object.freeze({
      valid: false, failures: ['marker is not an object'], identity: null,
      candidateVerified: false, legacyUnverified: false
    });
  }
  failures.push(...candidateBindingFailures(record.candidate));
  if (!record.subject || typeof record.subject !== 'object' || Array.isArray(record.subject)) {
    failures.push('subject is missing');
  } else {
    if (!['story', 'initiative', 'adhoc', 'goal'].includes(record.subject.kind)) failures.push('subject kind is invalid');
    if (!String(record.subject.id ?? '').trim()) failures.push('subject ID is missing');
    if (subject?.kind && record.subject.kind !== subject.kind) failures.push('subject kind does not match the requested subject');
    if (subject?.id && record.subject.id !== subject.id) failures.push('subject ID does not match the requested subject');
  }
  if (!String(record.branch ?? '').trim()) failures.push('publication branch is missing');
  if (expectedBranch && record.branch !== expectedBranch) failures.push('publication branch does not match the requested branch');
  if (record.subject?.branch && record.subject.branch !== record.branch) failures.push('subject branch does not match the publication branch');
  if (!String(record.remote ?? '').trim()) failures.push('publication remote is missing');
  if (expectedRemote && record.remote !== expectedRemote) failures.push('publication remote does not match the configured remote');
  if (record.remoteFingerprint != null
    && !/^[0-9a-f]{64}$/.test(record.remoteFingerprint)) failures.push('publication remote fingerprint is invalid');
  if (!fullObjectId(record.commit)) failures.push('commit is not a full lowercase Git object ID');
  if (!fullObjectId(record.tree)) failures.push('tree is not a full lowercase Git object ID');
  if (!String(record.transactionId ?? '').trim()) failures.push('transaction ID is missing');
  if (!sha256Digest(record.eventSha256)) failures.push('event digest is invalid');
  if (!sha256Digest(record.stateSha256)) failures.push('state digest is invalid');
  if (!publicationModes.includes(record.publicationMode)) failures.push('publication mode is invalid');
  const pushOutcomes = ['not-attempted', 'rejected', 'transport-indeterminate'];
  if (record.pushOutcome !== undefined && !pushOutcomes.includes(record.pushOutcome)) {
    failures.push('push outcome is invalid');
  }
  if (record.expectedRemoteSha === null && !pushOutcomes.includes(record.pushOutcome)) {
    failures.push('create-only publication is missing its push outcome');
  }
  if (record.expectedRemoteSha !== undefined
    && record.expectedRemoteSha !== null
    && !fullObjectId(record.expectedRemoteSha)) failures.push('expected remote commit is invalid');
  if (!record.event || typeof record.event !== 'object' || Array.isArray(record.event)) {
    failures.push('bound lifecycle event is missing');
  } else {
    if (record.event.subject?.kind !== record.subject?.kind
      || record.event.subject?.id !== record.subject?.id) failures.push('event subject does not match the marker subject');
    if (record.event.subject?.branch && record.event.subject.branch !== record.branch) {
      failures.push('event branch does not match the publication branch');
    }
    const transactionEvent = {
      ...record.event,
      sourceCommit: null,
      idempotencyKey: null,
      idempotencyHash: null
    };
    const eventSha256 = `sha256:${recordSha256(transactionEvent)}`;
    if (record.eventSha256 !== eventSha256) failures.push('event digest does not match the bound lifecycle event');
    if (fullObjectId(record.commit)) {
      try {
        const rebound = bindLifecycleEvent(transactionEvent, record.commit);
        if (record.event.sourceCommit !== rebound.sourceCommit) failures.push('event source commit does not match the recorded commit');
        if (record.event.idempotencyKey !== rebound.idempotencyKey) failures.push('event idempotency key is invalid');
        if (record.event.idempotencyHash !== rebound.idempotencyHash) failures.push('event idempotency digest is invalid');
      } catch {
        failures.push('event transport binding is invalid');
      }
    }
    if (record.candidate != null) {
      try {
        const expectedCandidate = sgosLifecycleCandidateIdentity(transactionEvent);
        if (record.candidate.candidateId !== expectedCandidate.candidateId) {
          failures.push('Candidate ID does not bind the marker lifecycle event');
        }
        if (record.candidate.normalizedEventSha256 !== expectedCandidate.normalizedEventSha256) {
          failures.push('Candidate normalized event digest does not match the marker event');
        }
      } catch {
        failures.push('Candidate lifecycle event binding is invalid');
      }
    }
  }

  const identity = fullObjectId(record.commit) ? governedCommitIdentity(root, record.commit) : null;
  if (!identity) failures.push('recorded commit is unavailable');
  else {
    if (identity.commit !== record.commit) failures.push('commit does not resolve to the exact recorded object ID');
    if (identity.parents.length !== 1) failures.push('governed transaction commit must have exactly one parent');
    if (identity.tree !== record.tree) failures.push('commit tree does not match the marker tree');
    if (identity.transactionId !== record.transactionId) failures.push('commit transaction trailer does not match the marker');
    if (identity.eventSha256 !== record.eventSha256) failures.push('commit event trailer does not match the marker');
    if (identity.stateSha256 !== record.stateSha256) failures.push('commit state trailer does not match the marker');
    if (identity.publicationMode !== record.publicationMode) failures.push('commit publication-mode trailer does not match the marker');
    if (!candidateIdentityMatches(identity.candidate, record.candidate)) {
      failures.push('commit Candidate trailers do not match the marker');
    }
    if (record.candidate != null && record.candidate.candidateTree !== record.tree) {
      failures.push('Candidate tree does not match the governed commit tree');
    }
    if (identity.parents.length === 1
      && fullObjectId(record.tree)
      && String(record.transactionId ?? '').trim()
      && sha256Digest(record.eventSha256)
      && publicationModes.includes(record.publicationMode)) {
      const stateSha256 = `sha256:${recordSha256({
        transactionId: record.transactionId,
        expectedHead: identity.parents[0],
        branch: record.branch,
        tree: record.tree,
        eventSha256: record.eventSha256,
        publicationMode: record.publicationMode,
        ...(record.candidate ? { candidate: record.candidate } : {}),
        ...(record.remoteFingerprint ? { remoteFingerprint: record.remoteFingerprint } : {}),
        ...(record.expectedRemoteSha !== undefined
          ? { expectedRemoteSha: record.expectedRemoteSha }
          : {})
      })}`;
      if (record.stateSha256 !== stateSha256) failures.push('state digest does not match the governed transaction identity');
    }
  }
  const candidateVerified = failures.length === 0 && record.candidate != null;
  return Object.freeze({
    valid: failures.length === 0,
    failures: Object.freeze(failures),
    identity,
    candidateVerified,
    // Exact legacy commits remain recoverable, but recovery never invents a Candidate receipt.
    legacyUnverified: failures.length === 0 && record.candidate == null
  });
}

/**
 * Prove that a Candidate-bearing recovery receipt still has its immutable Candidate authority.
 *
 * Commit trailers and a pending marker can prove that their fields agree with each other, but they
 * cannot prove that a Candidate was actually retained and passed the installed verifier. Recovery
 * therefore reopens the content-addressed retained record and verification receipt before any
 * remote operation. Pre-Candidate receipts deliberately remain exact-but-unverified compatibility
 * authority; this function never fabricates a Candidate for them.
 */
export async function verifyPendingPublicationCandidateAuthority(root, record) {
  if (record?.candidate == null) {
    return Object.freeze({
      valid: true,
      candidateVerified: false,
      legacyUnverified: true,
      failures: Object.freeze([])
    });
  }
  try {
    const verified = await verifySgosLifecycleCandidateBinding(root, record.candidate, {
      publishedCommit: record.commit
    });
    return Object.freeze({
      valid: true,
      candidateVerified: true,
      legacyUnverified: false,
      failures: Object.freeze([]),
      lifecycleAdmission: structuredClone(verified.receipt.lifecycleAdmission)
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      candidateVerified: false,
      legacyUnverified: false,
      failures: Object.freeze([
        `Candidate authority is unavailable or invalid (${error?.code ?? 'SGOS_CANDIDATE_BINDING_INVALID'})`
      ])
    });
  }
}

export function isPendingStoryBranchPromotion(record) {
  return record?.recoveryKind === 'story-branch-promotion';
}

/**
 * Finish one machine-sealed Story child-to-canonical promotion using its exact verified Candidate.
 * The caller owns the Story subject lock. A durable transport-indeterminate marker is written
 * before the remote compare-and-swap so process death can reconcile only exact remote equality.
 */
export async function completePendingStoryBranchPromotion(root, pending, {
  subject, targetBranch, remote
} = {}) {
  const record = pending?.record;
  const failures = [];
  if (!isPendingStoryBranchPromotion(record)) failures.push('recovery kind is invalid');
  if (pending?.integrityVerified !== true) failures.push('machine-local recovery integrity is invalid');
  if (record?.subject?.kind !== 'story' || record.subject.id !== subject?.id) {
    failures.push('Story subject does not match the requested promotion');
  }
  if (!String(record?.sourceBranch ?? '').trim()
      || !String(record?.targetBranch ?? '').trim()
      || record.sourceBranch === record.targetBranch) failures.push('promotion branch identity is invalid');
  if (targetBranch && record?.targetBranch !== targetBranch) failures.push('canonical target branch changed');
  if (remote && record?.remote !== remote) failures.push('publication remote changed');
  if (!fullObjectId(record?.commit)) failures.push('promotion commit is invalid');
  if (record?.expectedRemoteSha !== null && !fullObjectId(record?.expectedRemoteSha)) {
    failures.push('promotion remote lease is invalid');
  }
  const candidateAuthority = failures.length
    ? null : await verifyPendingPublicationCandidateAuthority(root, record);
  if (candidateAuthority && !candidateAuthority.valid) failures.push(...candidateAuthority.failures);
  const admission = candidateAuthority?.lifecycleAdmission;
  if (candidateAuthority?.valid
      && (admission?.subject?.kind !== 'story' || admission.subject.id !== subject.id
        || !['work-completed', 'impact-finalized'].includes(admission.eventType))) {
    failures.push('Candidate is not the exact finalized Story lifecycle publication');
  }
  let authority = null;
  try { authority = configuredRemoteAuthority(root, record?.remote); } catch { /* fail below */ }
  if (!record?.remoteFingerprint || !authority?.url
      || authority.fingerprint !== record.remoteFingerprint) {
    failures.push('promotion remote authority changed');
  }
  if (failures.length) {
    throw new SingularityFlowError(
      `Story '${subject?.id ?? 'unknown'}' branch promotion recovery is invalid: ${failures.join('; ')}. `
      + 'The marker was retained and no ref was pushed.',
      {
        code: 'STORY_PROMOTION_RECOVERY_INVALID',
        details: { subject, failures }
      }
    );
  }

  const priorOutcome = record.pushOutcome ?? 'not-attempted';
  await writePendingPublication(root, {
    ...subject,
    record: { ...record, pushOutcome: 'transport-indeterminate' }
  });
  const published = await publishVerifiedSgosLifecycleCandidate(root, {
    binding: record.candidate,
    commit: record.commit,
    branch: record.targetBranch,
    remote: record.remote,
    expectedRemoteSha: record.expectedRemoteSha,
    transportRemote: authority.url,
    upstreamRemote: authority.remote,
    advanceLocalRef: false
  });
  if (published.result.status !== 0) {
    const outcome = publicationPushOutcome(published.result);
    const mayReconcile = priorOutcome === 'transport-indeterminate'
      || outcome === 'transport-indeterminate';
    const observed = mayReconcile
      ? await exactRemoteBranchObservationAsync(root, authority.url, record.targetBranch) : null;
    if (!observed || !observed.reachable || observed.malformed || observed.sha !== record.commit) {
      if (outcome !== 'transport-indeterminate') {
        await writePendingPublication(root, {
          ...subject,
          record: { ...record, pushOutcome: 'rejected' }
        });
      }
      throw new SingularityFlowError(
        `Story '${subject.id}' branch promotion push failed. The exact Candidate and recovery marker were retained.`,
        {
          code: 'STORY_PROMOTION_PUSH_FAILED',
          details: { subject, targetBranch: record.targetBranch, outcome }
        }
      );
    }
  }
  await clearPendingPublication(root, subject);
  return Object.freeze({
    mode: 'direct',
    pending: false,
    pushed: record.commit,
    commit: record.commit,
    branch: record.sourceBranch,
    canonicalBranch: record.targetBranch,
    recovered: priorOutcome === 'transport-indeterminate'
  });
}

/**
 * Read the machine-local recovery marker, migrating the pre-kernel governed-tree
 * marker on first access. The rename to .git was deliberately a state-plane
 * change, not permission to forget an unpublished commit created by an older
 * release.
 */
export async function readPendingPublication(root, { kind, id, legacyPath = null, roots = {}, migrate = true } = {}) {
  const local = localPendingPublicationPath(root, kind, id);
  const shared = await sharedPendingPublication(root, kind, id, { migrate });
  if (shared) return {
    path: shared.path, record: shared.value, migrated: shared.migrated,
    integrityVerified: shared.integrityVerified,
    ...(shared.schemaMigrated ? { schemaMigrated: true } : {}),
    ...(shared.migratedFrom?.length ? { migratedFrom: shared.migratedFrom } : {})
  };
  const subject = { kind, id };
  const journal = await readPublicationJournal(root, subject, { migrate });
  if (journal) {
    // State validation runs inside the transaction after its journal is durable. That transaction
    // must not diagnose its own marker as a previous crash; every other process still sees it.
    if (publicationJournalOwnedByCurrentProcess(journal.record, root)) return null;
    const recorded = journal.record;
    // Goal mutations run in a linked lifecycle worktree so the developer's Story checkout never
    // changes. Their recovery authority is the exact Goal ref, not whichever branch happens to be
    // checked out in the caller that later runs `goal sync`.
    const goalRef = recorded.subject?.kind === 'goal'
      ? `refs/heads/${recorded.branch}` : null;
    const currentHead = goalRef && refExists(root, goalRef) ? refHead(root, goalRef) : head(root);
    const currentBranch = goalRef ? recorded.branch : branch(root);
    if (currentBranch !== recorded.branch) {
      return {
        path: journal.path,
        record: divergentRecovery(recorded, `the checkout is on branch '${currentBranch}', not transaction branch '${recorded.branch}'`),
        migrated: false,
        journal: true,
        journalRecord: recorded
      };
    }
    if (!recorded.commit) {
      const record = currentHead === recorded.expectedHead
        ? recoveryRecord(recorded, {
            recoveryStage: 'interrupted-before-branch-ref-advanced',
            error: 'The process stopped before the governed commit completed; exact pre-transaction recovery is available.'
          })
        : divergentRecovery(recorded, `HEAD changed from ${recorded.expectedHead} to ${currentHead} without an identified transaction commit`);
      return { path: journal.path, record, migrated: false, journal: true, journalRecord: recorded };
    }
    const verification = verifiedJournalCommit(root, recorded);
    if (!verification.valid) {
      return {
        path: journal.path,
        record: divergentRecovery(recorded, verification.reason),
        migrated: false,
        journal: true,
        journalRecord: recorded
      };
    }
    const refAdvanced = currentHead !== recorded.expectedHead
      && commitIsAncestor(root, recorded.commit, currentHead);
    if (!refAdvanced) {
      if (currentHead !== recorded.expectedHead || recorded.refAdvanced === true) {
        return {
          path: journal.path,
          record: divergentRecovery(recorded, `branch '${recorded.branch}' does not contain the exact transaction commit ${recorded.commit}`),
          migrated: false,
          journal: true,
          journalRecord: recorded
        };
      }
      const record = recoveryRecord(recorded, {
        recoveryStage: 'interrupted-before-branch-ref-advanced',
        error: 'The transaction commit object was created, but the branch ref was not advanced; exact pre-transaction recovery is available.'
      });
      return { path: journal.path, record, migrated: false, journal: true, journalRecord: recorded };
    }
    if (recorded.publicationMode === 'off') {
      if (migrate) await clearPublicationJournal(root, subject, { transactionId: recorded.transactionId });
      return null;
    }
    // A create-only publication cannot infer ownership from reachability. Another actor may have
    // created the same ref (or a descendant) while this process was down. Always materialize its
    // receipt so sync can distinguish an in-flight transport from a known rejection and compare the
    // exact remote tip rather than accepting ancestry.
    if (recorded.expectedRemoteSha !== null
      && remoteContains(root, recorded.commit, recorded.remote, recorded.branch)) {
      if (migrate) await clearPublicationJournal(root, subject, { transactionId: recorded.transactionId });
      return null;
    }
    const record = recoveryRecord(recorded, {
      recoveryStage: 'branch-ref-advanced-before-publication',
      error: 'The process stopped after creating the exact governed commit and before publication completed.'
    });
    if (migrate) {
      await prepareSharedPublicationStorage(
        root, 'pending-publication', `Pending publication for ${kind} '${id}'`
      );
      await writeSealedPendingPublication(root, local, record);
      await clearPublicationJournal(root, subject, { transactionId: recorded.transactionId });
      const sealed = readRecord(PENDING_PUBLICATION_FAMILY, await readJson(local)).record;
      return {
        path: local, record: sealed, migrated: true, migratedFrom: journal.path,
        integrityVerified: true
      };
    }
    return {
      path: journal.path, record, migrated: false, journal: true, journalRecord: journal.record,
      integrityVerified: true
    };
  }
  for (const legacy of legacyCandidates(root, { kind, id, legacyPath, roots })) {
    if (!(await exists(legacy))) continue;
    const record = readRecord(PENDING_PUBLICATION_FAMILY, await readJson(legacy)).record;
    // `migrate: false` for read-only callers. Migration deletes a tracked file, and a snapshot that
    // mutates the working tree while capturing it fails its own did-anything-change check — so the
    // first snapshot after an upgrade hard-errored, blaming a concurrent writer that did not exist.
    if (!migrate) return { path: legacy, record, migrated: false, pendingMigrationFrom: legacy };
    await prepareSharedPublicationStorage(
      root, 'pending-publication', `Pending publication for ${kind} '${id}'`
    );
    await writeSealedPendingPublication(root, local, record);
    await unlink(legacy);
    const sealed = readRecord(PENDING_PUBLICATION_FAMILY, await readJson(local)).record;
    return {
      path: local, record: sealed, migrated: true, migratedFrom: legacy,
      integrityVerified: true
    };
  }
  return null;
}

export async function hasPendingPublication(root, options) {
  return Boolean(await readPendingPublication(root, options));
}

/** Read-only, fail-closed recovery discovery for Home and other projections. */
export async function inspectPendingPublication(root, options = {}) {
  const subject = subjectRef(options, { code: 'WORK_PENDING_SUBJECT_KEY_REQUIRED' });
  let expectedPath = null;
  try {
    expectedPath = localPendingPublicationPath(root, subject.kind, subject.id);
    const pending = await readPendingPublication(root, { ...options, ...subject, migrate: false });
    if (!pending) return Object.freeze({ status: 'absent', subject, path: displayMarkerPath(root, expectedPath) });
    const recordSubject = pending.record?.subject;
    if (recordSubject?.kind !== subject.kind || recordSubject?.id !== subject.id) {
      const error = new Error('Pending publication marker schema or subject identity is invalid.');
      error.code = 'PUBLICATION_MARKER_UNREADABLE';
      throw error;
    }
    return Object.freeze({
      status: 'pending', subject, path: displayMarkerPath(root, pending.path), record: pending.record
    });
  } catch (error) {
    // A projection fixture or ungoverned directory has no Git-local recovery plane at all. This is
    // distinct from a repository whose marker exists but cannot be read.
    if (/not a git repository/i.test(error?.message ?? '')) {
      return Object.freeze({ status: 'absent', subject, path: null });
    }
    return Object.freeze({
      status: 'unreadable', subject, path: displayMarkerPath(root, expectedPath),
      code: 'PUBLICATION_MARKER_UNREADABLE', error: error?.message ?? 'Marker could not be read.'
    });
  }
}

export async function writePendingPublication(root, { kind, id, record } = {}) {
  await sharedPendingPublication(root, kind, id);
  await prepareSharedPublicationStorage(
    root, 'pending-publication', `Pending publication for ${kind} '${id}'`
  );
  const target = localPendingPublicationPath(root, kind, id);
  await writeSealedPendingPublication(root, target, record);
  return target;
}

export async function clearPendingPublication(root, { kind, id, legacyPath = null } = {}) {
  const local = await sharedPendingPublication(root, kind, id);
  if (local) await unlink(local.path);
  for (const legacy of legacyCandidates(root, { kind, id, legacyPath })) {
    if (await exists(legacy)) await unlink(legacy);
  }
  await clearPublicationJournal(root, { kind, id });
}

/**
 * Synchronize one exact Candidate-bound lifecycle commit for subjects without an aggregate-specific
 * recovery tail. Story and Initiative keep their richer wrappers (capability/ledger handling);
 * ad-hoc landing uses this kernel path so it cannot become permanently stuck after a push refusal.
 */
export async function syncPendingLifecyclePublication(root, options = {}) {
  const subject = subjectRef(options);
  return withSubjectLock(root, subject, async () => {
    const pending = await readPendingPublication(root, { ...options, ...subject });
    if (!pending) return Object.freeze({ pending: false, pushed: null, noOp: true, subject });
    const record = pending.record;
    if (record.recoveryStage === 'interrupted-before-branch-ref-advanced'
        || record.recoveryStage === 'publication-recovery-diverged') {
      throw new SingularityFlowError(
        `${subject.kind} '${subject.id}' requires pre-commit recovery before synchronization.`,
        { code: 'PUBLICATION_RECOVERY_REQUIRED', details: { subject, markerPath: pending.path } }
      );
    }
    const localOnly = record.publicationMode === 'off' && record.localCommitted === true;
    const verification = verifyPendingPublicationCommit(root, record, {
      subject,
      branch: options.branch ?? record.branch,
      remote: options.remote ?? record.remote,
      allowPublicationOff: localOnly
    });
    if (!verification.valid || (['adhoc', 'goal'].includes(subject.kind) && !verification.candidateVerified)) {
      throw new SingularityFlowError(
        `${subject.kind} '${subject.id}' pending publication does not prove one exact Candidate-bound commit: `
        + `${verification.failures.join('; ') || 'legacy publication has no Candidate verification'}.`,
        { code: 'PENDING_PUBLICATION_IDENTITY_INVALID', details: { subject, failures: verification.failures } }
      );
    }
    // Ad hoc and Goal recovery were introduced with the Candidate boundary and therefore have no
    // legitimate unsealed marker format. Their local tail metadata controls terminal session/Goal
    // cleanup, so authenticating only the commit while accepting edited progress metadata would
    // let a hand-edited receipt skip or redirect that cleanup.
    if (['adhoc', 'goal'].includes(subject.kind) && pending.integrityVerified !== true) {
      throw new SingularityFlowError(
        `${subject.kind} '${subject.id}' pending publication integrity is invalid.`,
        {
          code: 'PENDING_PUBLICATION_PROGRESS_INTEGRITY_INVALID',
          details: { subject, markerPath: pending.path }
        }
      );
    }
    const candidateAuthority = await verifyPendingPublicationCandidateAuthority(root, record);
    if (!candidateAuthority.valid
        || (['adhoc', 'goal'].includes(subject.kind) && !candidateAuthority.candidateVerified)) {
      throw new SingularityFlowError(
        `${subject.kind} '${subject.id}' pending publication does not retain its exact verified Candidate: `
        + `${candidateAuthority.failures.join('; ') || 'legacy publication has no Candidate verification'}.`,
        {
          code: 'PENDING_PUBLICATION_CANDIDATE_INVALID',
          details: { subject, failures: candidateAuthority.failures }
        }
      );
    }
    if (localOnly) {
      if (typeof options.finalize === 'function') {
        await options.finalize(Object.freeze({
          subject, record, commit: record.commit, localOnly: true
        }));
      }
      await clearPendingPublication(root, subject);
      return Object.freeze({
        pending: false,
        pushed: null,
        commit: record.commit,
        recovered: true,
        localOnly: true,
        subject
      });
    }
    let authority = null;
    try { authority = configuredRemoteAuthority(root, record.remote); } catch { /* fail below */ }
    if (!record.remoteFingerprint || !authority?.url
        || authority.fingerprint !== record.remoteFingerprint) {
      throw new SingularityFlowError(
        `${subject.kind} '${subject.id}' publication remote changed after its exact commit was retained.`,
        { code: 'PENDING_PUBLICATION_REMOTE_CHANGED', details: { subject } }
      );
    }
    if (record.rootPublished === true) {
      const observed = await exactRemoteBranchObservationAsync(root, authority.url, record.branch);
      if (!observed.reachable || observed.malformed || observed.sha !== record.commit) {
        throw new SingularityFlowError('Pending publication claims an unproven remote commit.', {
          code: 'PENDING_PUBLICATION_ROOT_UNPROVEN', details: { subject }
        });
      }
      if (typeof options.finalize === 'function') {
        await options.finalize(Object.freeze({
          subject, record, commit: record.commit, localOnly: false
        }));
      }
      await clearPendingPublication(root, subject);
      return Object.freeze({ pending: false, pushed: record.commit, recovered: true, subject });
    }
    const priorOutcome = pending.integrityVerified === true
      ? record.pushOutcome ?? 'not-attempted' : 'not-attempted';
    await writePendingPublication(root, {
      ...subject,
      record: { ...record, pushOutcome: 'transport-indeterminate' }
    });
    const result = await pushCommitToBranchAsync(root, record.remote, record.commit, record.branch, {
      expectedRemoteSha: record.expectedRemoteSha,
      transportRemote: authority.url,
      upstreamRemote: authority.remote
    });
    if (result.status !== 0) {
      const outcome = publicationPushOutcome(result);
      const mayReconcile = priorOutcome === 'transport-indeterminate'
        || outcome === 'transport-indeterminate';
      const observed = mayReconcile
        ? await exactRemoteBranchObservationAsync(root, authority.url, record.branch) : null;
      if (!observed || !observed.reachable || observed.malformed || observed.sha !== record.commit) {
        if (outcome !== 'transport-indeterminate') {
          await writePendingPublication(root, {
            ...subject, record: { ...record, pushOutcome: 'rejected' }
          });
        }
        throw new SingularityFlowError(
          `Push still fails. ${result.failure?.advice
            ?? 'Run workspace doctor --network and inspect Git access outside SFlow before retrying.'}`,
          { code: 'PUBLICATION_PUSH_FAILED', details: { subject, outcome } }
        );
      }
    }
    if (typeof options.finalize === 'function') {
      await options.finalize(Object.freeze({
        subject, record, commit: record.commit, localOnly: false
      }));
    }
    await clearPendingPublication(root, subject);
    return Object.freeze({ pending: false, pushed: record.commit, recovered: true, subject });
  });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}

function journalLeaseIsLive(root, journal) {
  if (!root || !journal?.owner?.lockToken) return processIsAlive(journal?.owner?.pid) === true;
  const directory = subjectLockPath(root, journal.subject);
  let owner;
  try { owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8')); }
  catch { return false; }
  if (owner.lockToken !== journal.owner.lockToken
    || owner.processToken !== journal.owner.processToken
    || owner.host !== journal.owner.host) return false;
  const acquired = Date.parse(owner.acquiredAt ?? '');
  const expires = Date.parse(owner.expiresAt ?? '');
  const ttlMs = Number.isFinite(acquired) && Number.isFinite(expires) ? expires - acquired : 0;
  let heartbeat = 0;
  try {
    heartbeat = statSync(path.join(directory, `heartbeat-${encodeURIComponent(owner.lockToken).replace(/%/g, '_')}`)).mtimeMs;
  } catch { /* Missing exact-token heartbeat cannot extend the recorded lease. */ }
  const deadline = Math.max(Number.isFinite(expires) ? expires : 0, heartbeat + Math.max(0, ttlMs));
  if (Date.now() > deadline) return false;
  if (owner.host === os.hostname() && processIsAlive(owner.pid) !== true) return false;
  return true;
}

/**
 * Identify a pre-commit journal whose owning process is still running.
 *
 * A live owner is not an interrupted publication. In particular, a CLI command may be waiting at
 * an interactive confirmation while another surface asks to synchronize the same Story. Calling
 * that an interruption sends the operator toward destructive repair even though the transaction
 * still owns its lock. Recovery callers use this distinction to tell the operator to return to the
 * active command; they still fail closed when liveness is unknown.
 */
export function livePreparedPublicationOwner(pending, root = null) {
  const journal = pending?.journalRecord;
  if (!pending?.journal
    || pending.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced'
    || !['prepared', 'commit-created', 'restoring', 'rollback-failed'].includes(journal?.stage)
    || journal?.refAdvanced === true
    || !journalLeaseIsLive(root, journal)) return null;
  return Object.freeze({
    pid: journal.owner.pid,
    processId: journal.owner.processId ?? null,
    createdAt: journal.createdAt ?? null,
    updatedAt: journal.updatedAt ?? null
  });
}

/**
 * Recover a dead pre-commit transaction under the same subject lock used by publication.
 *
 * New journals carry a durable preimage and can restore a partially written governed directory.
 * Legacy journals have no such proof and retain the old clean-tree-only recovery rule. The journal
 * remains in place on every refusal or restore failure, so retrying recovery is idempotent.
 */
export async function recoverPreparedPublication(root, pending) {
  const journal = pending?.journalRecord;
  const commitIsVerifiedPreRef = journal?.commit == null
    || (journal?.refAdvanced !== true && verifiedJournalCommit(root, journal).valid);
  if (!pending?.journal
    || pending.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced'
    || !['prepared', 'commit-created', 'restoring', 'rollback-failed'].includes(journal?.stage)
    || !commitIsVerifiedPreRef
    || head(root) !== journal.expectedHead
    || branch(root) !== journal.branch
    || journalLeaseIsLive(root, journal)) return null;
  const subject = journal.subject;
  if (!subject?.kind || !subject?.id) return null;
  return withSubjectLock(root, subject, async () => {
    const latest = await readPublicationJournal(root, subject);
    if (!latest
      || latest.record.owner?.processId !== journal.owner?.processId
      || latest.record.expectedHead !== journal.expectedHead
      || latest.record.transactionId !== journal.transactionId
      || !['prepared', 'commit-created', 'restoring', 'rollback-failed'].includes(latest.record.stage)
      || latest.record.refAdvanced === true
      || head(root) !== journal.expectedHead) return null;
    let restoration = { restored: false, rescuePath: null, preimageSha256: null };
    try {
      if (!latest.record.recoveryPreimage && changes(root).trim()) return null;
      await updatePublicationJournal(root, subject, {
        stage: 'restoring', recoveryAttemptedAt: new Date().toISOString()
      }, { transactionId: journal.transactionId });
      if (latest.record.recoveryPreimage) {
        restoration = await restorePublicationPreimage(root, latest.record.recoveryPreimage, {
          subject,
          preserveCurrent: true
        });
      }
    } catch (error) {
      await updatePublicationJournal(root, subject, {
        stage: 'rollback-failed',
        rollbackError: error?.message ?? String(error),
        rollbackFailedAt: new Date().toISOString()
      }, { transactionId: journal.transactionId }).catch(() => {});
      throw error;
    }
    await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
    return Object.freeze({ recovered: true, ...restoration });
  });
}

/**
 * Recover a dead pre-commit transaction using only its Git-local subject identity.
 *
 * This deliberately does not load workflow.json or state.json. A process can die halfway through
 * writing either aggregate, and requiring that damaged file to parse before its own write-ahead
 * journal can be read makes the recovery path unreachable at the exact failure it exists for.
 */
export async function recoverPreparedPublicationBySubject(root, subject) {
  const pending = await readPendingPublication(root, { ...subject, migrate: false });
  if (!pending?.journal || pending.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced') {
    return Object.freeze({ status: pending ? 'not-precommit' : 'absent', subject, pending });
  }
  const active = livePreparedPublicationOwner(pending, root);
  if (active) return Object.freeze({ status: 'active', subject, active, pending });
  const recovery = await recoverPreparedPublication(root, pending);
  return recovery
    ? Object.freeze({ status: 'recovered', subject, ...recovery })
    : Object.freeze({ status: 'manual', subject, pending });
}

/** Backward-compatible boolean wrapper used by older clean-journal recovery callers and tests. */
export async function discardCleanPreparedPublication(root, pending) {
  return Boolean(await recoverPreparedPublication(root, pending));
}

/** Find legacy markers that no active subject read has migrated. */
export async function findLegacyPendingPublications(root, roots = {}) {
  // Every configured root, not just `singularity/`. A marker for a Story that has since been
  // deleted is never migrated by a subject read, so this scan is the only thing that can surface
  // it — and it was blind to exactly the repositories that had moved their roots.
  const bases = [...new Set([
    path.join(root, 'singularity'),
    path.join(root, roots.workItemRoot ?? 'singularity/work-items'),
    path.join(root, roots.initiativeRoot ?? 'singularity/initiatives')
  ].map((base) => path.resolve(base)))]
    .filter((base, _index, all) => !all.some((other) => other !== base && base.startsWith(`${other}${path.sep}`)));
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === 'publication-pending.json') found.push(absolute);
    }
  }
  for (const base of bases) if (await exists(base)) await visit(base);
  return found.sort();
}
