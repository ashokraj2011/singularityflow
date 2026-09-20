/**
 * A machine-private, non-cyclic receipt for a selected REV head used by a Story publication.
 *
 * The prepared record is written before the governed commit can advance its ref. The second,
 * immutable record only claims that one exact governed commit was retained locally; it does not
 * claim a remote push, approval, or phase publication. Neither record is included in the governed
 * tree, lifecycle event, or its commit digest. A crash between the two leaves a prepared record
 * that can only be completed from the exact publication journal/pending marker.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { commitIsAncestor, gitCommonDir, governedCommitIdentity, refHead } from '../git.mjs';
import {
  readPendingPublication, verifyPendingPublicationCandidateAuthority,
  verifyPendingPublicationCommit
} from '../publication-pending.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { readRecord, stampCurrentRecord } from '../schema-migrations.mjs';
import {
  readPrivateSidecar, safePrivateSidecarDirectory, writeImmutablePrivateSidecar
} from '../private-sidecar.mjs';
import { currentSubjectLockOwner } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';

const SHA = /^sha256:[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_BYTES = 16 * 1024;
const SELECTION_KEYS = [
  'schemaVersion', 'kind', 'workId', 'phaseId', 'phaseGeneration', 'loopId', 'loopRevision',
  'journalEntrySha256', 'candidateId', 'candidateSha256', 'candidateRefSha256',
  'candidateTree', 'headTransitionSha256', 'headSnapshotSha256', 'precheckSha256',
  'contextSha256', 'applicationProjectionSha256', 'prospectiveTree', 'selectionSha256'
];

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function branchName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\s\\~^:?*\[\x00-\x1f]/.test(value) && !value.includes('..')
    && !value.includes('@{') && !value.startsWith('-') && !value.endsWith('.');
}
function assertSelection(selection, subject) {
  try { readRecord('revision-publication-selection', selection); }
  catch { fail('REV_ATTESTATION_SELECTION_INVALID', 'REV publication selection schema is invalid.'); }
  if (!exactKeys(selection, SELECTION_KEYS)
      || selection.kind !== 'revision-publication-selection'
      || selection.workId !== subject.id || !identifier(selection.phaseId)
      || !identifier(selection.loopId) || !identifier(selection.candidateId)
      || !Number.isSafeInteger(selection.phaseGeneration) || selection.phaseGeneration < 1
      || !Number.isSafeInteger(selection.loopRevision) || selection.loopRevision < 1
      || !OID.test(selection.candidateTree) || !OID.test(selection.prospectiveTree)) {
    fail('REV_ATTESTATION_SELECTION_INVALID', 'REV publication selection has invalid identity or scope.');
  }
  for (const key of SELECTION_KEYS.filter((name) => name.endsWith('Sha256'))) {
    if (!SHA.test(selection[key])) {
      fail('REV_ATTESTATION_SELECTION_INVALID', `REV publication selection ${key} is invalid.`);
    }
  }
  const { selectionSha256, ...core } = selection;
  if (hash(core) !== selectionSha256) {
    fail('REV_ATTESTATION_SELECTION_INVALID', 'REV publication selection digest does not match its fields.');
  }
}
function assertLock(root, subject) {
  if (!currentSubjectLockOwner(root, subject)) {
    fail('REV_ATTESTATION_LOCK_REQUIRED', 'REV publication attestation needs the Story publication subject lock.');
  }
}
function recordKey(subject, transactionId) {
  return createHash('sha256').update(canonicalJson({
    subject: { kind: subject.kind, id: subject.id }, transactionId
  })).digest('hex');
}
export function revisionPublicationAttestationPaths(root, { subject, transactionId } = {}) {
  if (!subject || subject.kind !== 'story' || !identifier(subject.id)
      || !identifier(transactionId)) {
    fail('REV_ATTESTATION_SCOPE_INVALID', 'Attestation requires one exact Story and transaction.');
  }
  const base = path.join(gitCommonDir(root), 'singularity-flow', 'revision-publication-attestations');
  const key = recordKey(subject, transactionId);
  return Object.freeze({
    prepared: path.join(base, `${key}.prepared.json`),
    committed: path.join(base, `${key}.committed.json`)
  });
}
async function readImmutable(file, kind, digestField) {
  const root = await rootFromAttestationPath(file);
  const bytes = await readPrivateSidecar(root, file, {
    maximumBytes: MAX_BYTES, optional: true, enforceWindowsAcl: true
  });
  if (bytes === null) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail('REV_ATTESTATION_CORRUPT', 'REV publication attestation is not valid JSON.'); }
  try { readRecord(kind, value); }
  catch { fail('REV_ATTESTATION_CORRUPT', 'REV publication attestation schema is invalid.'); }
  if (value?.kind !== kind || !SHA.test(value?.[digestField])) {
    fail('REV_ATTESTATION_CORRUPT', 'REV publication attestation kind or digest is invalid.');
  }
  const { [digestField]: digest, ...core } = value;
  if (hash(core) !== digest) {
    fail('REV_ATTESTATION_CORRUPT', 'REV publication attestation content digest is invalid.');
  }
  return value;
}
// The common directory is already embedded in every generated sidecar path. Never derive a root
// from user-controlled JSON; this helper only peels our own fixed, one-level directory suffix.
async function rootFromAttestationPath(file) {
  const directory = path.dirname(file);
  if (path.basename(directory) !== 'revision-publication-attestations') {
    fail('REV_ATTESTATION_UNSAFE', 'REV publication attestation path is invalid.');
  }
  const common = path.dirname(path.dirname(directory));
  return common;
}
async function writeImmutable(file, value, kind, digestField) {
  const root = await rootFromAttestationPath(file);
  const existing = await readImmutable(file, kind, digestField);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(value)) {
      fail('REV_ATTESTATION_CONFLICT', 'REV publication attestation already records a different identity.');
    }
    return existing;
  }
  const directory = path.dirname(file);
  await safePrivateSidecarDirectory(root, directory, {
    create: true, enforceWindowsAcl: true
  });
  const content = canonicalJson(value);
  if (Buffer.byteLength(content) > MAX_BYTES) {
    fail('REV_ATTESTATION_LIMIT', 'REV publication attestation exceeds its byte limit.');
  }
  await writeImmutablePrivateSidecar(root, file, Buffer.from(content), {
    maximumBytes: MAX_BYTES, enforceWindowsAcl: true
  });
  return value;
}

/** Durable pre-commit intent. This does not claim that any governed commit exists. */
export async function prepareRevisionPublicationAttestation(root, {
  subject, selection, transactionId, expectedHead, branch, publicationMode
} = {}) {
  const paths = revisionPublicationAttestationPaths(root, { subject, transactionId });
  assertLock(root, subject);
  assertSelection(selection, subject);
  if (!OID.test(expectedHead) || !branchName(branch)
      || !['off', 'required', 'warn'].includes(publicationMode)) {
    fail('REV_ATTESTATION_SCOPE_INVALID', 'REV publication intent lacks exact parent, branch, or mode.');
  }
  const core = stampCurrentRecord('revision-publication-prepared', {
    kind: 'revision-publication-prepared', subject: { kind: subject.kind, id: subject.id },
    transactionId, expectedHead, branch, publicationMode, selection
  });
  return writeImmutable(paths.prepared, { ...core, preparedSha256: hash(core) },
    'revision-publication-prepared', 'preparedSha256');
}

function assertGovernedCommit(root, prepared, { commit, eventSha256, stateSha256, candidateBinding }) {
  if (!OID.test(commit) || !SHA.test(eventSha256) || !SHA.test(stateSha256)) {
    fail('REV_ATTESTATION_COMMIT_INVALID', 'REV attestation requires exact commit and event/state digests.');
  }
  const identity = governedCommitIdentity(root, commit);
  const candidate = identity?.candidate;
  if (!identity || identity.commit !== commit || identity.parents.length !== 1
      || identity.parents[0] !== prepared.expectedHead
      || identity.tree !== prepared.selection.prospectiveTree
      || identity.transactionId !== prepared.transactionId
      || identity.eventSha256 !== eventSha256 || identity.stateSha256 !== stateSha256
      || identity.publicationMode !== prepared.publicationMode
      || identity.revisionSelectionSha256 !== prepared.selection.selectionSha256
      || !candidateBinding || candidate?.candidateId !== candidateBinding.candidateId
      || candidate?.candidateSha256 !== candidateBinding.candidateSha256
      || candidate?.verificationReceiptSha256 !== candidateBinding.verificationReceiptSha256
      || candidate?.verificationProfileSha256 !== candidateBinding.verificationProfileSha256
      || candidateBinding.candidateTree !== identity.tree) {
    fail('REV_ATTESTATION_COMMIT_MISMATCH',
      'The exact governed commit does not bind the selected REV head and publication transaction.');
  }
  return identity;
}

/**
 * Bind the selected head to one locally retained commit. Must run after ref CAS and before the
 * publication journal is cleared. Failure after ref advancement is a pending-publication recovery
 * condition, never permission to roll the Story branch back or try a different commit.
 */
export async function bindRevisionPublicationCommit(root, {
  subject, transactionId, commit, eventSha256, stateSha256, candidateBinding
} = {}) {
  const paths = revisionPublicationAttestationPaths(root, { subject, transactionId });
  assertLock(root, subject);
  const prepared = await readImmutable(paths.prepared, 'revision-publication-prepared', 'preparedSha256');
  if (!prepared || prepared.subject.kind !== subject.kind || prepared.subject.id !== subject.id
      || prepared.transactionId !== transactionId) {
    fail('REV_ATTESTATION_PREPARED_MISSING', 'Exact REV publication intent is missing or belongs to another transaction.');
  }
  assertSelection(prepared.selection, subject);
  const identity = assertGovernedCommit(root, prepared, {
    commit, eventSha256, stateSha256, candidateBinding
  });
  const core = stampCurrentRecord('revision-publication-commit-retained', {
    kind: 'revision-publication-commit-retained',
    subject: { kind: subject.kind, id: subject.id }, transactionId, branch: prepared.branch,
    preparedSha256: prepared.preparedSha256,
    selectionSha256: prepared.selection.selectionSha256,
    selectedCandidateId: prepared.selection.candidateId,
    selectedCandidateSha256: prepared.selection.candidateSha256,
    selectedHeadSnapshotSha256: prepared.selection.headSnapshotSha256,
    precheckSha256: prepared.selection.precheckSha256,
    applicationProjectionSha256: prepared.selection.applicationProjectionSha256,
    commit: identity.commit, parent: identity.parents[0], tree: identity.tree,
    eventSha256, stateSha256,
    lifecycleCandidateId: candidateBinding.candidateId,
    lifecycleCandidateSha256: candidateBinding.candidateSha256,
    lifecycleVerificationReceiptSha256: candidateBinding.verificationReceiptSha256,
    lifecycleVerificationProfileSha256: candidateBinding.verificationProfileSha256,
    outcome: 'commit-retained-local'
  });
  return writeImmutable(paths.committed, { ...core, commitmentSha256: hash(core) },
    'revision-publication-commit-retained', 'commitmentSha256');
}

/** Read and revalidate; absence of the second record means no commit claim. */
export async function readRevisionPublicationAttestation(root, { subject, transactionId } = {}) {
  const paths = revisionPublicationAttestationPaths(root, { subject, transactionId });
  const prepared = await readImmutable(paths.prepared, 'revision-publication-prepared', 'preparedSha256');
  const committed = await readImmutable(paths.committed, 'revision-publication-commit-retained', 'commitmentSha256');
  if (!prepared) {
    if (committed) fail('REV_ATTESTATION_CORRUPT', 'Committed REV receipt lacks its prepared selection.');
    return Object.freeze({ status: 'absent', prepared: null, committed: null });
  }
  if (prepared.subject?.kind !== subject.kind || prepared.subject?.id !== subject.id
      || prepared.transactionId !== transactionId || !OID.test(prepared.expectedHead)
      || !branchName(prepared.branch)
      || !['off', 'required', 'warn'].includes(prepared.publicationMode)) {
    fail('REV_ATTESTATION_CORRUPT', 'REV publication receipt belongs to a different Story transaction.');
  }
  assertSelection(prepared.selection, subject);
  if (!committed) return Object.freeze({ status: 'prepared', prepared, committed: null });
  if (committed.preparedSha256 !== prepared.preparedSha256
      || committed.selectionSha256 !== prepared.selection.selectionSha256
      || committed.subject?.kind !== subject.kind || committed.subject?.id !== subject.id
      || committed.transactionId !== transactionId || committed.branch !== prepared.branch
      || committed.selectedCandidateId !== prepared.selection.candidateId
      || committed.selectedCandidateSha256 !== prepared.selection.candidateSha256
      || committed.selectedHeadSnapshotSha256 !== prepared.selection.headSnapshotSha256
      || committed.precheckSha256 !== prepared.selection.precheckSha256
      || committed.applicationProjectionSha256 !== prepared.selection.applicationProjectionSha256
      || !OID.test(committed.commit)
      || committed.commit !== governedCommitIdentity(root, committed.commit)?.commit
      || committed.outcome !== 'commit-retained-local') {
    fail('REV_ATTESTATION_CORRUPT', 'REV commit receipt does not bind the prepared selection and exact Git object.');
  }
  const identity = governedCommitIdentity(root, committed.commit);
  if (identity.parents.length !== 1 || identity.parents[0] !== committed.parent
      || identity.parents[0] !== prepared.expectedHead
      || identity.tree !== committed.tree || identity.tree !== prepared.selection.prospectiveTree
      || identity.transactionId !== transactionId
      || identity.eventSha256 !== committed.eventSha256
      || identity.stateSha256 !== committed.stateSha256
      || identity.publicationMode !== prepared.publicationMode
      || identity.revisionSelectionSha256 !== prepared.selection.selectionSha256
      || identity.candidate?.candidateId !== committed.lifecycleCandidateId
      || identity.candidate?.candidateSha256 !== committed.lifecycleCandidateSha256
      || identity.candidate?.verificationReceiptSha256 !== committed.lifecycleVerificationReceiptSha256
      || identity.candidate?.verificationProfileSha256 !== committed.lifecycleVerificationProfileSha256) {
    fail('REV_ATTESTATION_CORRUPT', 'REV commit receipt diverges from governed Git commit trailers.');
  }
  return Object.freeze({ status: 'commit-retained-local', prepared, committed });
}

/**
 * Complete an interrupted post-ref binding only from the already-verified exact publication
 * marker. A pre-ref journal, unavailable Candidate authority, or moved branch is not evidence of
 * a retained Story commit. Recovery never pushes or changes the Story ref.
 */
export async function recoverRevisionPublicationAttestation(root, {
  subject, transactionId, pending: suppliedPending = null
} = {}) {
  assertLock(root, subject);
  const current = await readRevisionPublicationAttestation(root, { subject, transactionId });
  if (current.status === 'commit-retained-local') return current.committed;
  if (current.status !== 'prepared') {
    fail('REV_ATTESTATION_PREPARED_MISSING', 'No prepared REV selection exists for this Story transaction.');
  }
  const pending = suppliedPending
    ?? await readPendingPublication(root, { kind: subject.kind, id: subject.id, migrate: false });
  if (pending?.integrityVerified !== true) {
    fail('REV_ATTESTATION_RECOVERY_UNPROVEN',
      'REV publication recovery requires one machine-sealed exact pending marker.');
  }
  const record = pending.record;
  if (!record || record.transactionId !== transactionId
      || ['interrupted-before-branch-ref-advanced', 'publication-recovery-diverged']
        .includes(record.recoveryStage)) {
    fail('REV_ATTESTATION_RECOVERY_UNPROVEN', 'Recovery lacks one exact ref-advanced governed commit.');
  }
  const verification = verifyPendingPublicationCommit(root, record, {
    subject, branch: current.prepared.branch,
    remote: record.remote, allowPublicationOff: record.publicationMode === 'off'
  });
  const candidateAuthority = verification.valid
    ? await verifyPendingPublicationCandidateAuthority(root, record) : null;
  const branchCommit = refHead(root, `refs/heads/${current.prepared.branch}`);
  if (!verification.valid || !verification.candidateVerified
      || !candidateAuthority?.valid || !candidateAuthority.candidateVerified
      || !branchCommit || !commitIsAncestor(root, record.commit, branchCommit)) {
    fail('REV_ATTESTATION_RECOVERY_UNPROVEN',
      'Recovery marker, retained Candidate, or Story branch does not prove the exact REV commit.');
  }
  return bindRevisionPublicationCommit(root, {
    subject, transactionId, commit: record.commit,
    eventSha256: record.eventSha256, stateSha256: record.stateSha256,
    candidateBinding: record.candidate
  });
}
