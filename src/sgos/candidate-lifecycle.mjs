/**
 * Immutable Git-backed SGOS Candidate lifecycle.
 *
 * Candidate data is retained by a hidden Git ref. Lifecycle verification uses hook/filter-free Git
 * object and temporary-index proofs, and publication advances the selected local branch with
 * compare-and-swap. Nothing in
 * this module gives a candidate authority merely because it is self-hashed: publication requires
 * a passed verification receipt and an exact publication-plan confirmation.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  branch, exactRemoteBranchObservation, gitCommonDir, governedCommitIdentity, head, hasRemote,
  publicationPushOutcome, pushCommitToBranch
} from '../git.mjs';
import { configuredRemoteAuthority } from '../git-remote-diagnostics.mjs';
import { configurationReadRoot } from '../configuration-read-scope.mjs';
import {
  sealMachineLocalPublicationReceipt, verifyMachineLocalPublicationReceipt
} from '../publication-machine-integrity.mjs';
import { canonicalJson } from '../records.mjs';
import { buildRepositorySubjectIndex } from '../repository-subject-index.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import { resolvePlatformProcess, tryWindowsTaskkill } from '../platform-process.mjs';
import { withTrustedSgosConfigurationRead } from './authority-trust.mjs';
import {
  createCandidateSnapshot, sha256, validateCandidateSnapshot
} from './contracts.mjs';
import { compareSgosCodePoints } from './order.mjs';
import {
  listPrivateSidecar, readPrivateSidecar, safePrivateSidecarDirectory,
  writeImmutablePrivateSidecar, writeMutablePrivateSidecar
} from './private-sidecar.mjs';

const CANDIDATE_ID = /^CAN-[A-Za-z0-9._:-]{6,127}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const BRANCH = /^(?!-)(?!.*(?:\.\.|@\{|\\|\s|[~^:?*\[]))(?!.*\.$)[A-Za-z0-9._/-]+$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CANDIDATE_FILES = 20_000;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_CANDIDATE_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_COMMANDS = 32;
const MAX_COMMAND_ARGUMENTS = 256;
const MAX_COMMAND_ARGUMENT_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const CANDIDATE_RECORD_FORMAT = 'sflow.sgos.candidate-private';
const CANDIDATE_RECORD_VERSION = 1;
const CANDIDATE_VERIFIER_POLICY_FORMAT = 'sflow.sgos.candidate-verifier-policy/v1';
const LIFECYCLE_VERIFIER_PROFILE_FORMAT = 'sflow.sgos.lifecycle-candidate-verifier/v1';
const CANDIDATE_TRANSPORT_RECEIPT_FORMAT = 'sflow.sgos.candidate-transport-receipt/v1';
const CANDIDATE_TRANSPORT_RECEIPT_PURPOSE = 'candidate-publication-transport';
export const SGOS_CANDIDATE_VERIFIER_POLICY_PATH =
  'singularity/sgos/candidate-verifier-policy.json';

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function candidateRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'candidates');
}

function candidateDirectory(root, candidateId) {
  if (!CANDIDATE_ID.test(String(candidateId ?? ''))) {
    fail('Candidate ID is invalid.', 'SGOS_CANDIDATE_ID_INVALID', { candidateId });
  }
  return path.join(candidateRoot(root), candidateId);
}

function candidateRecordPath(root, candidateId) {
  return path.join(candidateDirectory(root, candidateId), 'candidate.json');
}

function verificationDirectory(root, candidateId) {
  return path.join(candidateDirectory(root, candidateId), 'verification');
}

function publicationDirectory(root, candidateId) {
  return path.join(candidateDirectory(root, candidateId), 'publication');
}

function publicationPlanDirectory(root, candidateId) {
  return path.join(candidateDirectory(root, candidateId), 'publication-plans');
}

function publicationTransportReceiptPath(root, candidateId, packetSha256) {
  if (!HASH.test(String(packetSha256 ?? ''))) {
    fail('Candidate publication packet SHA-256 is invalid.',
      'SGOS_CANDIDATE_PUBLICATION_CONFIRMATION_REQUIRED');
  }
  return path.join(publicationDirectory(root, candidateId),
    `transport-${packetSha256.slice('sha256:'.length)}.json`);
}

function gitResult(root, args, { env = process.env, input = null, maximumBytes = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    input,
    encoding: null,
    maxBuffer: maximumBytes,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const diagnostic = Buffer.from(result.stderr ?? '').toString('utf8').slice(0, 4096).trim();
    fail(`Git candidate operation failed${diagnostic ? `: ${diagnostic}` : '.'}`,
      'SGOS_CANDIDATE_GIT_FAILED', { status: result.status, signal: result.signal ?? null });
  }
  return Buffer.from(result.stdout ?? '');
}

function tryGitResult(root, args, { env = process.env, input = null, maximumBytes = 32 * 1024 * 1024 } = {}) {
  return spawnSync('git', args, {
    cwd: root,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    input,
    encoding: null,
    maxBuffer: maximumBytes,
    windowsHide: true
  });
}

function gitText(root, args, options = {}) {
  return gitResult(root, args, options).toString('utf8').trim();
}

function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const from = fields[index++];
      const to = fields[index++];
      if (!from || !to) fail('Git returned an incomplete rename/copy record.', 'SGOS_CANDIDATE_GIT_INVALID');
      changes.push({ kind, from, path: to });
    } else {
      const changedPath = fields[index++];
      if (!changedPath) fail('Git returned an incomplete candidate path record.', 'SGOS_CANDIDATE_GIT_INVALID');
      changes.push({ kind, from: null, path: changedPath });
    }
  }
  return changes;
}

function treeEntry(root, tree, relative, { env = process.env } = {}) {
  const raw = gitResult(root, ['ls-tree', '-z', tree, '--', relative], { env }).toString('utf8');
  if (!raw) return null;
  const tab = raw.indexOf('\t');
  const header = raw.slice(0, tab).split(' ');
  const actual = raw.slice(tab + 1).replace(/\0$/, '');
  if (header.length !== 3 || actual !== relative) {
    fail('Candidate tree returned an ambiguous path entry.', 'SGOS_CANDIDATE_GIT_INVALID', { path: relative });
  }
  const [mode, objectType, object] = header;
  if (!['100644', '100755', '120000'].includes(mode) || objectType !== 'blob' || !GIT_OBJECT.test(object)) {
    fail(`Candidate path '${relative}' has unsupported Git type or mode.`,
      'SGOS_CANDIDATE_RESOURCE_UNSUPPORTED', { path: relative, mode, objectType });
  }
  const bytes = gitResult(root, ['cat-file', 'blob', object], {
    env, maximumBytes: MAX_CANDIDATE_BYTES
  });
  return { mode, object, bytes };
}

function candidateResources(root, baseline, tree, { env = process.env } = {}) {
  const changes = parseNameStatus(gitResult(root, [
    'diff', '--name-status', '-z', '--find-renames', '--find-copies', baseline, tree, '--'
  ], { env }));
  if (changes.length > MAX_CANDIDATE_FILES) {
    fail('Candidate exceeds the installed file-count ceiling.', 'SGOS_CANDIDATE_LIMIT', {
      files: changes.length, maximumFiles: MAX_CANDIDATE_FILES
    });
  }
  let totalBytes = 0;
  const resources = changes.map((change) => {
    if (change.kind === 'D') {
      const prior = treeEntry(root, baseline, change.path, { env });
      if (!prior) {
        fail(`Deleted Candidate path '${change.path}' is absent from its bound baseline.`,
          'SGOS_CANDIDATE_GIT_INVALID');
      }
      return {
        path: change.path, type: prior.mode === '120000' ? 'symlink' : 'file',
        mode: null, contentSha256: null,
        operation: 'deleted', renameFrom: null, renameTo: null, deletion: true
      };
    }
    const entry = treeEntry(root, tree, change.path, { env });
    if (!entry) fail(`Candidate path '${change.path}' disappeared from its retained tree.`, 'SGOS_CANDIDATE_GIT_INVALID');
    totalBytes += entry.bytes.length;
    if (totalBytes > MAX_CANDIDATE_BYTES) {
      fail('Candidate exceeds the installed byte ceiling.', 'SGOS_CANDIDATE_LIMIT', {
        bytes: totalBytes, maximumBytes: MAX_CANDIDATE_BYTES
      });
    }
    const operation = change.kind === 'A' ? 'added'
      : change.kind === 'R' ? 'renamed'
        : change.kind === 'C' ? 'copied'
          : change.kind === 'T' ? 'type-changed' : 'modified';
    // The core Candidate contract intentionally has no copy-from field. A copy is represented as
    // a copied target with no rename endpoints; the retained Git tree remains the byte authority.
    return {
      path: change.path,
      type: entry.mode === '120000' ? 'symlink' : 'file',
      mode: entry.mode,
      contentSha256: digestBytes(entry.bytes),
      operation,
      renameFrom: operation === 'renamed' ? change.from : null,
      renameTo: operation === 'renamed' ? change.path : null,
      deletion: false
    };
  }).sort((left, right) => compareSgosCodePoints(left.path, right.path));
  return { resources, totalBytes };
}

function temporaryIndexEnvironment(index) {
  return {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'Singularity Flow',
    GIT_AUTHOR_EMAIL: 'singularity-flow@localhost.invalid',
    GIT_COMMITTER_NAME: 'Singularity Flow',
    GIT_COMMITTER_EMAIL: 'singularity-flow@localhost.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
  };
}

async function worktreeTree(root) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-index-'));
  const index = path.join(temporary, 'index');
  const env = temporaryIndexEnvironment(index);
  try {
    gitResult(root, ['read-tree', 'HEAD'], { env });
    gitResult(root, ['add', '-A', '--', '.'], { env });
    const tree = gitText(root, ['write-tree'], { env });
    if (!GIT_OBJECT.test(tree)) fail('Git did not produce a retained candidate tree.', 'SGOS_CANDIDATE_GIT_INVALID');
    return tree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Build the exact prospective tree an existing lifecycle transaction will commit.
 *
 * Unlike the interactive Candidate command, an ordinary Story transaction owns a bounded set of
 * paths and must leave an operator's unrelated staged or working-tree bytes alone. Reading HEAD
 * into a private index and adding only those roots reproduces `commitIsolated` without borrowing
 * or changing the contributor's real index.
 */
async function scopedWorktreeTree(root, baselineCommit, paths) {
  if (!GIT_OBJECT.test(String(baselineCommit ?? ''))) {
    fail('Lifecycle Candidate baseline is invalid.', 'SGOS_CANDIDATE_BASELINE_INVALID');
  }
  const requested = [...new Set((paths ?? []).filter(
    (entry) => typeof entry === 'string' && entry
  ))];
  const scope = [];
  for (const candidate of requested) {
    let present = false;
    try {
      await lstat(path.join(root, candidate));
      present = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!present) {
      const tracked = tryGitResult(root, ['ls-files', '-z', '--', candidate]);
      present = !tracked.error && tracked.status === 0 && Buffer.from(tracked.stdout ?? '').length > 0;
    }
    if (present) scope.push(candidate);
  }
  if (!scope.length) {
    fail('Lifecycle Candidate requires at least one governed path.', 'SGOS_CANDIDATE_SCOPE_INVALID');
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-scope-'));
  const env = temporaryIndexEnvironment(path.join(temporary, 'index'));
  try {
    gitResult(root, ['read-tree', baselineCommit], { env });
    gitResult(root, ['add', '-A', '--', ...scope], { env });
    const tree = gitText(root, ['write-tree'], { env });
    if (!GIT_OBJECT.test(tree)) {
      fail('Git did not produce a scoped Candidate tree.', 'SGOS_CANDIDATE_GIT_INVALID');
    }
    return tree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const lifecycleVerifierCore = Object.freeze({
  format: LIFECYCLE_VERIFIER_PROFILE_FORMAT,
  profileId: 'universal-lifecycle-publication',
  authority: 'installed-kernel',
  subjectKinds: Object.freeze(['story', 'initiative', 'adhoc', 'goal']),
  checks: Object.freeze([
    'lifecycle-event-normalized', 'publication-scope-admitted',
    'lifecycle-state-validated', 'lifecycle-before-commit-validated',
    'retained-ref-exact', 'candidate-commit-tree-exact', 'temporary-index-tree-exact',
    'candidate-resource-digests-exact', 'repository-hooks-not-invoked',
    'working-tree-filters-not-invoked'
  ])
});

/** Closed installed authority used by ordinary Story publication; existing repositories need no new config. */
export const SGOS_LIFECYCLE_VERIFIER_PROFILE = freezeDeep({
  ...lifecycleVerifierCore,
  profileSha256: sha256(lifecycleVerifierCore)
});

export function sgosLifecycleCandidateIdentity(event) {
  const eventId = String(event?.eventId ?? '').trim();
  const subject = event?.subject;
  if (!eventId || !['story', 'initiative', 'adhoc', 'goal'].includes(subject?.kind)
      || !String(subject?.id ?? '').trim()) {
    fail('Lifecycle Candidate identity requires an exact governed lifecycle event.',
      'SGOS_CANDIDATE_EVENT_INVALID');
  }
  const payload = structuredClone(event.payload ?? {});
  delete payload.sgosCandidate;
  const normalized = {
    ...structuredClone(event),
    subject: { ...subject, id: String(subject.id).trim() },
    payload,
    sourceCommit: null,
    idempotencyKey: null,
    idempotencyHash: null
  };
  const normalizedEventSha256 = digestBytes(Buffer.from(canonicalJson(normalized)));
  return Object.freeze({
    candidateId: `CAN-${normalizedEventSha256.slice('sha256:'.length, 'sha256:'.length + 26).toUpperCase()}`,
    normalizedEventSha256
  });
}

export function sgosLifecycleCandidateId(event) {
  return sgosLifecycleCandidateIdentity(event).candidateId;
}

function seal(kind, hashField, value) {
  // Candidate sidecars are private content-addressed Git-common records, not migration-registry
  // families. Keep that boundary explicit so a literal schemaVersion cannot masquerade as a
  // registered durable writer version.
  const core = {
    candidateRecordFormat: CANDIDATE_RECORD_FORMAT,
    candidateRecordVersion: CANDIDATE_RECORD_VERSION,
    kind,
    ...structuredClone(value)
  };
  delete core[hashField];
  return freezeDeep({ ...core, [hashField]: sha256(core) });
}

async function writeImmutable(root, target, record, hashField) {
  try {
    await writeImmutablePrivateSidecar(root, target, canonicalJson(record), {
      maximumBytes: MAX_CANDIDATE_RECORD_BYTES
    });
  } catch (error) {
    if (error?.code === 'SGOS_SIDECAR_RECORD_CONFLICT') {
      fail('An immutable candidate record already exists with different bytes.',
        'SGOS_CANDIDATE_RECORD_CONFLICT', { hash: record[hashField] });
    }
    throw error;
  }
  return record;
}

function candidateTransportAuthority(plan, remoteFingerprint) {
  return {
    format: CANDIDATE_TRANSPORT_RECEIPT_FORMAT,
    candidateId: plan.candidateId,
    packetSha256: plan.packetSha256,
    candidateSha256: plan.candidateSha256,
    candidateCommit: plan.candidateCommit,
    candidateTree: plan.candidateTree,
    targetBranch: plan.targetBranch,
    remote: plan.remote,
    remoteFingerprint,
    expectedRemoteSha: plan.preconditions.remoteTargetCommit
  };
}

async function readCandidateTransportReceipt(root, plan, remoteFingerprint) {
  const target = publicationTransportReceiptPath(root, plan.candidateId, plan.packetSha256);
  const bytes = await readPrivateSidecar(root, target, {
    maximumBytes: MAX_CANDIDATE_RECORD_BYTES, optional: true
  });
  if (!bytes) return null;
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch {
    fail('Candidate publication transport receipt is invalid.',
      'SGOS_CANDIDATE_TRANSPORT_RECEIPT_INVALID');
  }
  const expected = candidateTransportAuthority(plan, remoteFingerprint);
  const exact = Object.entries(expected).every(([key, value]) => receipt?.[key] === value);
  if (!exact || !['transport-indeterminate', 'published', 'rejected'].includes(receipt?.pushOutcome)
      || !await verifyMachineLocalPublicationReceipt(
        root, CANDIDATE_TRANSPORT_RECEIPT_PURPOSE, receipt
      )) {
    fail('Candidate publication transport receipt failed its machine-local authority binding.',
      'SGOS_CANDIDATE_TRANSPORT_RECEIPT_INVALID');
  }
  return freezeDeep(receipt);
}

async function writeCandidateTransportReceipt(root, plan, remoteFingerprint, pushOutcome, at) {
  const record = await sealMachineLocalPublicationReceipt(
    root, CANDIDATE_TRANSPORT_RECEIPT_PURPOSE, {
      ...candidateTransportAuthority(plan, remoteFingerprint),
      pushOutcome,
      updatedAt: at
    }
  );
  await writeMutablePrivateSidecar(
    root,
    publicationTransportReceiptPath(root, plan.candidateId, plan.packetSha256),
    canonicalJson(record),
    { maximumBytes: MAX_CANDIDATE_RECORD_BYTES }
  );
  return record;
}

export async function freezeSgosCandidate(root, {
  subjectId = path.basename(root), createdBy, createdAt = nowIso(), candidateId = null,
  expectedBaseline = null, baselineCommit: suppliedBaselineCommit = null, paths = null,
  exactCandidateCommit = null, expectedCandidateTree = null
} = {}) {
  if (!createdBy?.id || !createdBy?.kind) {
    fail('Candidate freeze requires a typed creator.', 'SGOS_CANDIDATE_CREATOR_REQUIRED');
  }
  // Establish the private authority path before creating the retained Git object/ref. A poisoned
  // sidecar parent must fail before any partial Candidate authority can be left behind.
  await safePrivateSidecarDirectory(root, candidateRoot(root), { create: true });
  const observedHead = head(root);
  const baselineCommit = suppliedBaselineCommit ?? exactCandidateCommit ?? observedHead;
  if (!GIT_OBJECT.test(String(baselineCommit ?? ''))) {
    fail('Candidate baseline commit is invalid.', 'SGOS_CANDIDATE_BASELINE_INVALID');
  }
  if (exactCandidateCommit != null) {
    const resolved = gitText(root, ['rev-parse', '--verify', `${exactCandidateCommit}^{commit}`]);
    if (resolved !== exactCandidateCommit) {
      fail('Exact lifecycle Candidate commit does not resolve to the supplied full object ID.',
        'SGOS_CANDIDATE_BASELINE_INVALID');
    }
    const baselineResolved = gitText(root, ['rev-parse', '--verify', `${baselineCommit}^{commit}`]);
    if (baselineResolved !== baselineCommit) {
      fail('Exact lifecycle Candidate baseline does not resolve to the supplied full object ID.',
        'SGOS_CANDIDATE_BASELINE_INVALID');
    }
    if (baselineCommit !== exactCandidateCommit) {
      const parents = gitText(root, ['rev-list', '--parents', '-n', '1', exactCandidateCommit])
        .split(/\s+/).slice(1);
      if (!parents.includes(baselineCommit)) {
        fail('Exact lifecycle Candidate does not have the supplied baseline as a direct parent.',
          'SGOS_CANDIDATE_BASELINE_INVALID');
      }
    }
  }
  if (expectedBaseline != null && observedHead !== expectedBaseline) {
    fail('Lifecycle Candidate baseline changed before freeze.', 'SGOS_CANDIDATE_BASELINE_CHANGED', {
      expectedBaseline, observedBaseline: observedHead
    });
  }
  const baselineTree = gitText(root, ['rev-parse', `${baselineCommit}^{tree}`]);
  const candidateTree = exactCandidateCommit != null
    ? gitText(root, ['rev-parse', `${exactCandidateCommit}^{tree}`]) : paths == null
    ? await worktreeTree(root)
    : paths.length === 0 ? baselineTree
      : await scopedWorktreeTree(root, baselineCommit, paths);
  if (expectedCandidateTree != null && candidateTree !== expectedCandidateTree) {
    fail('Lifecycle Candidate bytes changed after exact publication admission.',
      'SGOS_CANDIDATE_SCOPE_DRIFT', { expectedCandidateTree, observedCandidateTree: candidateTree });
  }
  const { resources, totalBytes } = exactCandidateCommit != null
    ? (baselineCommit === exactCandidateCommit
      ? { resources: [], totalBytes: 0 }
      : candidateResources(root, baselineCommit, candidateTree))
    : candidateResources(root, baselineCommit, candidateTree);
  const snapshot = createCandidateSnapshot({
    ...(candidateId ? { candidateId } : {}),
    subject: { kind: 'repository-tree', id: subjectId },
    baseline: { revision: baselineCommit, snapshotSha256: digestBytes(Buffer.from(baselineTree)) },
    resources,
    createdBy,
    createdAt
  });
  const env = temporaryIndexEnvironment(path.join(os.tmpdir(), `unused-sflow-${process.pid}`));
  const message = `SGOS Candidate ${snapshot.candidateId}\n\nCandidate-SHA256: ${snapshot.candidateSha256}\n`;
  const candidateCommit = exactCandidateCommit ?? gitText(
    root, ['commit-tree', candidateTree, '-p', baselineCommit], { env, input: Buffer.from(message) }
  );
  if (!GIT_OBJECT.test(candidateCommit)) fail('Git did not retain the candidate commit.', 'SGOS_CANDIDATE_GIT_INVALID');
  const retainedRef = `refs/singularity-flow/candidates/${snapshot.candidateId}`;
  // Candidate refs are immutable retention roots. A blind update would let a concurrent freeze
  // replace the ref before the immutable sidecar conflict is noticed, corrupting the older record.
  const zeroObject = '0'.repeat(candidateCommit.length);
  const created = tryGitResult(root, ['update-ref', retainedRef, candidateCommit, zeroObject]);
  if (created.error || created.status !== 0) {
    let observed = null;
    try { observed = gitText(root, ['rev-parse', '--verify', retainedRef]); } catch { /* report below */ }
    if (observed !== candidateCommit) {
      fail('Candidate retention ref already exists with different immutable bytes.',
        'SGOS_CANDIDATE_RECORD_CONFLICT', { retainedRef, observed, candidateCommit });
    }
  }
  const record = seal('sgos-retained-candidate', 'retainedCandidateSha256', {
    candidate: snapshot,
    repository: { baselineCommit, baselineTree, candidateTree, candidateCommit, retainedRef },
    totals: { files: resources.length, bytes: totalBytes }
  });
  await writeImmutable(root, candidateRecordPath(root, snapshot.candidateId), record,
    'retainedCandidateSha256');
  return record;
}

/**
 * Verify an ordinary lifecycle Candidate using only installed, hook-free Git object checks.
 *
 * This profile intentionally executes no Candidate-owned command. Story publication has already
 * run its lifecycle validators; this boundary proves that the immutable retained commit, tree and
 * resource manifest reconstruct exactly. It deliberately never checks out files: checkout can run
 * repository/global post-checkout hooks and smudge filters, invalidating a zero-command receipt.
 */
export async function verifySgosLifecycleCandidate(root, candidateId, {
  signal = null, verifiedAt = nowIso(), lifecycleAdmission = null
} = {}) {
  const retained = await readSgosRetainedCandidate(root, candidateId);
  const admissionKeys = [
    'normalizedEventSha256', 'subject', 'eventType', 'scopeAdmission',
    'stateValidation', 'beforeCommitValidation'
  ];
  const admissionValid = lifecycleAdmission && typeof lifecycleAdmission === 'object'
    && !Array.isArray(lifecycleAdmission)
    && Object.keys(lifecycleAdmission).length === admissionKeys.length
    && admissionKeys.every((key) => Object.hasOwn(lifecycleAdmission, key))
    && HASH.test(String(lifecycleAdmission.normalizedEventSha256 ?? ''))
    && lifecycleAdmission.candidateId === undefined
    && candidateId === `CAN-${lifecycleAdmission.normalizedEventSha256
      .slice('sha256:'.length, 'sha256:'.length + 26).toUpperCase()}`
    && ['story', 'initiative', 'adhoc', 'goal'].includes(lifecycleAdmission.subject?.kind)
    && String(lifecycleAdmission.subject?.id ?? '').trim()
    && typeof lifecycleAdmission.eventType === 'string' && lifecycleAdmission.eventType
    && lifecycleAdmission.scopeAdmission === 'passed'
    && ['passed', 'not-required'].includes(lifecycleAdmission.stateValidation)
    && ['passed', 'not-required'].includes(lifecycleAdmission.beforeCommitValidation);
  if (!admissionValid) {
    fail('Lifecycle Candidate requires one exact passed installed-kernel admission packet.',
      'SGOS_CANDIDATE_LIFECYCLE_ADMISSION_REQUIRED', { candidateId });
  }
  await safePrivateSidecarDirectory(root, verificationDirectory(root, candidateId), { create: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-lifecycle-candidate-index-'));
  const env = {
    ...temporaryIndexEnvironment(path.join(temporary, 'index')),
    // Do not let repository-local replace refs make another commit appear to be the Candidate.
    GIT_NO_REPLACE_OBJECTS: '1',
    // A partial/promisor repository may otherwise contact its remote implicitly from cat-file or
    // read-tree. Missing objects are a closed verification failure, never a hidden network read.
    GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: os.devNull
  };
  try {
    if (signal?.aborted) fail('Lifecycle Candidate verification was cancelled.', 'AUTO_STOP_REQUESTED');
    // `rev-parse`, `read-tree`, `write-tree`, `diff`, `ls-tree`, and `cat-file` operate only on Git
    // objects/index bytes. None checks out a path, invokes a hook/filter, or contacts a remote.
    const observedCommit = gitText(root, [
      'rev-parse', '--verify', `${retained.repository.candidateCommit}^{commit}`
    ], { env });
    const observedCommitTree = gitText(root, [
      'rev-parse', '--verify', `${observedCommit}^{tree}`
    ], { env });
    gitResult(root, ['read-tree', observedCommit], { env });
    const observedIndexTree = gitText(root, ['write-tree'], { env });
    const reconstructed = candidateResources(
      root, retained.repository.baselineCommit, retained.repository.candidateTree, { env }
    );
    const resourcesMatch = canonicalJson(reconstructed.resources)
      === canonicalJson(retained.candidate.resources);
    const totalsMatch = reconstructed.resources.length === retained.totals.files
      && reconstructed.totalBytes === retained.totals.bytes;
    if (signal?.aborted) fail('Lifecycle Candidate verification was cancelled.', 'AUTO_STOP_REQUESTED');
    const passed = observedCommit === retained.repository.candidateCommit
      && observedCommitTree === retained.repository.candidateTree
      && observedIndexTree === retained.repository.candidateTree
      && resourcesMatch && totalsMatch;
    const receipt = seal('lifecycle-candidate-verification-receipt',
      'verificationReceiptSha256', {
        candidateId,
        candidateSha256: retained.candidate.candidateSha256,
        retainedCandidateSha256: retained.retainedCandidateSha256,
        candidateTree: retained.repository.candidateTree,
        verificationProfile: SGOS_LIFECYCLE_VERIFIER_PROFILE,
        lifecycleAdmission: lifecycleAdmission == null ? null : structuredClone(lifecycleAdmission),
        observations: {
          isolation: 'hook-free-object-and-temporary-index',
          networkUsed: false,
          cloneUsed: false,
          worktreeCheckoutUsed: false,
          repositoryHooksExecuted: 0,
          workingTreeFiltersExecuted: 0,
          candidateCommandsExecuted: 0,
          expectedTree: retained.repository.candidateTree,
          observedCommit,
          observedCommitTree,
          observedIndexTree,
          resourcesMatch,
          totalsMatch
        },
        status: passed ? 'passed' : 'failed',
        verifiedAt
      });
    await writeImmutable(root, path.join(verificationDirectory(root, candidateId),
      `${receipt.verificationReceiptSha256.slice('sha256:'.length)}.json`), receipt,
    'verificationReceiptSha256');
    if (!passed) {
      fail('Lifecycle Candidate failed isolated exact-tree verification.',
        'SGOS_CANDIDATE_VERIFICATION_FAILED', {
          candidateId, verificationReceiptSha256: receipt.verificationReceiptSha256
        });
    }
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function freezeAndVerifySgosLifecycleCandidate(root, {
  event, paths, createdBy, expectedBaseline, expectedCandidateTree = null,
  signal = null, lifecycleAdmission = null
} = {}) {
  const identity = sgosLifecycleCandidateIdentity(event);
  const candidateId = identity.candidateId;
  const retained = await freezeSgosCandidate(root, {
    candidateId,
    subjectId: `${event.subject.kind}:${event.subject.id}:${identity.normalizedEventSha256}`,
    createdBy,
    createdAt: event.createdAt,
    expectedBaseline,
    paths,
    expectedCandidateTree
  });
  const verification = await verifySgosLifecycleCandidate(root, candidateId, {
    signal, verifiedAt: nowIso(), lifecycleAdmission
  });
  return freezeDeep({ identity, retained, verification });
}

/** Admit an unchanged exact commit as a create-only lifecycle branch Candidate. */
export async function freezeAndVerifySgosExistingLifecycleCommit(root, {
  event, candidateCommit, baselineCommit = candidateCommit, createdBy, signal = null
} = {}) {
  const identity = sgosLifecycleCandidateIdentity(event);
  const retained = await freezeSgosCandidate(root, {
    candidateId: identity.candidateId,
    subjectId: `${event.subject.kind}:${event.subject.id}:${identity.normalizedEventSha256}`,
    createdBy,
    createdAt: event.createdAt,
    baselineCommit,
    exactCandidateCommit: candidateCommit
  });
  const verification = await verifySgosLifecycleCandidate(root, identity.candidateId, {
    signal,
    verifiedAt: nowIso(),
    lifecycleAdmission: {
      normalizedEventSha256: identity.normalizedEventSha256,
      subject: { kind: event.subject.kind, id: event.subject.id },
      eventType: event.type,
      scopeAdmission: 'passed',
      stateValidation: 'not-required',
      beforeCommitValidation: 'not-required'
    }
  });
  return freezeDeep({ identity, retained, verification });
}

export function sgosLifecycleCandidateBinding(boundary) {
  if (!boundary?.identity || boundary.verification?.status !== 'passed') {
    fail('Lifecycle Candidate boundary is not passed.', 'SGOS_CANDIDATE_VERIFICATION_REQUIRED');
  }
  return freezeDeep({
    candidateId: boundary.retained.candidate.candidateId,
    normalizedEventSha256: boundary.identity.normalizedEventSha256,
    candidateSha256: boundary.retained.candidate.candidateSha256,
    retainedCandidateSha256: boundary.retained.retainedCandidateSha256,
    candidateTree: boundary.retained.repository.candidateTree,
    candidateCommit: boundary.retained.repository.candidateCommit,
    verificationReceiptSha256: boundary.verification.verificationReceiptSha256,
    verificationProfileSha256: boundary.verification.verificationProfile.profileSha256
  });
}

export async function verifySgosLifecycleCandidateBinding(root, binding, {
  publishedCommit = null
} = {}) {
  const bindingValid = binding && typeof binding === 'object' && !Array.isArray(binding)
    && CANDIDATE_ID.test(String(binding.candidateId ?? ''))
    && HASH.test(String(binding.normalizedEventSha256 ?? ''))
    && HASH.test(String(binding.candidateSha256 ?? ''))
    && HASH.test(String(binding.retainedCandidateSha256 ?? ''))
    && GIT_OBJECT.test(String(binding.candidateTree ?? ''))
    && GIT_OBJECT.test(String(binding.candidateCommit ?? ''))
    && HASH.test(String(binding.verificationReceiptSha256 ?? ''))
    && HASH.test(String(binding.verificationProfileSha256 ?? ''));
  if (!bindingValid) {
    fail('Lifecycle Candidate binding shape is invalid.',
      'SGOS_CANDIDATE_BINDING_INVALID');
  }
  const retained = await readSgosRetainedCandidate(root, binding?.candidateId);
  const expected = {
    candidateId: retained.candidate.candidateId,
    candidateSha256: retained.candidate.candidateSha256,
    retainedCandidateSha256: retained.retainedCandidateSha256,
    candidateTree: retained.repository.candidateTree,
    candidateCommit: retained.repository.candidateCommit
  };
  for (const [field, value] of Object.entries(expected)) {
    if (binding?.[field] !== value) {
      fail(`Lifecycle Candidate binding has a different ${field}.`,
        'SGOS_CANDIDATE_BINDING_INVALID', { field });
    }
  }
  if (publishedCommit != null && publishedCommit !== retained.repository.candidateCommit) {
    // Ordinary lifecycle commits add transaction/Candidate trailers after the tree is frozen, so
    // their commit object intentionally differs from the retention commit. Prove the published
    // commit carries the same tree and exact Candidate trailer identity. Exact create-only sibling
    // publication still takes the simpler equality path above.
    const identity = governedCommitIdentity(root, publishedCommit);
    if (!identity || identity.tree !== binding.candidateTree
        || identity.candidate?.invalid === true
        || identity.candidate?.candidateId !== binding.candidateId
        || identity.candidate?.candidateSha256 !== binding.candidateSha256
        || identity.candidate?.verificationReceiptSha256 !== binding.verificationReceiptSha256
        || identity.candidate?.verificationProfileSha256 !== binding.verificationProfileSha256) {
      fail('Lifecycle branch publication does not bind the exact verified Candidate tree and receipt.',
        'SGOS_CANDIDATE_BINDING_INVALID');
    }
  }
  const receiptPath = path.join(verificationDirectory(root, binding.candidateId),
    `${String(binding.verificationReceiptSha256 ?? '').replace(/^sha256:/, '')}.json`);
  let receipt;
  try {
    receipt = JSON.parse((await readPrivateSidecar(root, receiptPath, {
      maximumBytes: MAX_CANDIDATE_RECORD_BYTES
    })).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('Lifecycle Candidate verification receipt is unavailable.',
        'SGOS_CANDIDATE_VERIFICATION_REQUIRED');
    }
    throw error;
  }
  const receiptCore = Object.fromEntries(Object.entries(receipt).filter(
    ([key]) => key !== 'verificationReceiptSha256'
  ));
  if (receipt.kind !== 'lifecycle-candidate-verification-receipt'
      || receipt.status !== 'passed'
      || receipt.verificationReceiptSha256 !== binding.verificationReceiptSha256
      || sha256(receiptCore) !== receipt.verificationReceiptSha256
      || receipt.candidateId !== binding.candidateId
      || receipt.candidateSha256 !== binding.candidateSha256
      || receipt.candidateTree !== binding.candidateTree
      || receipt.verificationProfile?.profileSha256 !== binding.verificationProfileSha256
      || receipt.lifecycleAdmission?.normalizedEventSha256 !== binding.normalizedEventSha256) {
    fail('Lifecycle Candidate verification binding is corrupt.',
      'SGOS_CANDIDATE_BINDING_INVALID');
  }
  return freezeDeep({ retained, receipt });
}

/**
 * Recover the complete immutable Candidate binding carried by one governed commit.
 *
 * Commit trailers intentionally contain only the public verification identity. The retained
 * Candidate supplies its exact tree/commit hashes and the receipt supplies the normalized event
 * digest. Reconstructing through both records prevents callers such as branch promotion from
 * treating a self-authored trailer set as verification authority.
 */
export async function verifiedSgosLifecycleCandidateForCommit(root, publishedCommit) {
  const identity = governedCommitIdentity(root, publishedCommit);
  if (!identity?.candidate || identity.candidate.invalid === true) {
    fail('Governed commit has no complete lifecycle Candidate binding.',
      'SGOS_CANDIDATE_VERIFICATION_REQUIRED');
  }
  const retained = await readSgosRetainedCandidate(root, identity.candidate.candidateId);
  const receiptPath = path.join(verificationDirectory(root, identity.candidate.candidateId),
    `${identity.candidate.verificationReceiptSha256.replace(/^sha256:/, '')}.json`);
  let receipt;
  try {
    receipt = JSON.parse((await readPrivateSidecar(root, receiptPath, {
      maximumBytes: MAX_CANDIDATE_RECORD_BYTES
    })).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('Lifecycle Candidate verification receipt is unavailable.',
        'SGOS_CANDIDATE_VERIFICATION_REQUIRED');
    }
    throw error;
  }
  const binding = freezeDeep({
    candidateId: identity.candidate.candidateId,
    normalizedEventSha256: receipt?.lifecycleAdmission?.normalizedEventSha256 ?? null,
    candidateSha256: identity.candidate.candidateSha256,
    retainedCandidateSha256: retained.retainedCandidateSha256,
    candidateTree: retained.repository.candidateTree,
    candidateCommit: retained.repository.candidateCommit,
    verificationReceiptSha256: identity.candidate.verificationReceiptSha256,
    verificationProfileSha256: identity.candidate.verificationProfileSha256
  });
  const verified = await verifySgosLifecycleCandidateBinding(root, binding, { publishedCommit });
  return freezeDeep({ binding, retained: verified.retained, receipt: verified.receipt });
}

/**
 * Advance and publish one exact lifecycle Candidate.
 *
 * Cross-repository Story starts cannot use the checked-out aggregate unit of work in every sibling
 * repository. This adapter is the same authority boundary for their already-frozen reference
 * Candidates: verification, local compare-and-swap, and the remote lease are one ordered operation.
 * `allowLegacyUnverified` exists only so an older durable recovery receipt can finish the exact
 * commit it recorded; callers must never set it while creating new publication authority.
 */
export async function publishVerifiedSgosLifecycleCandidate(root, {
  binding = null,
  commit = binding?.candidateCommit ?? null,
  branch: targetBranch,
  remote = 'origin',
  expectedLocalSha = undefined,
  expectedRemoteSha = undefined,
  transportRemote = undefined,
  upstreamRemote = undefined,
  advanceLocalRef = true,
  allowLegacyUnverified = false
} = {}) {
  if (!GIT_OBJECT.test(String(commit ?? ''))) {
    fail('Lifecycle Candidate publication requires one exact commit.',
      'SGOS_CANDIDATE_PUBLICATION_INVALID');
  }
  if (!BRANCH.test(String(targetBranch ?? '')) || !REMOTE.test(String(remote ?? ''))) {
    fail('Lifecycle Candidate publication target is invalid.',
      'SGOS_CANDIDATE_PUBLICATION_INVALID');
  }
  if (binding) {
    await verifySgosLifecycleCandidateBinding(root, binding, { publishedCommit: commit });
  } else if (!allowLegacyUnverified) {
    fail('Lifecycle publication requires a verified Candidate binding.',
      'SGOS_CANDIDATE_VERIFICATION_REQUIRED');
  }
  if (advanceLocalRef !== true && advanceLocalRef !== false) {
    fail('Lifecycle Candidate local-ref publication mode is invalid.',
      'SGOS_CANDIDATE_PUBLICATION_INVALID');
  }
  if (!advanceLocalRef && expectedLocalSha !== undefined) {
    fail('A remote-only Candidate publication cannot carry local-ref compare-and-swap authority.',
      'SGOS_CANDIDATE_PUBLICATION_INVALID');
  }

  const localRef = `refs/heads/${targetBranch}`;
  let currentLocal = null;
  try { currentLocal = gitText(root, ['rev-parse', '--verify', localRef]); } catch { /* absent */ }
  // A v1 recovery receipt predates local-ref Candidate CAS. It authorizes only its exact retained
  // commit object and create-only remote lease; do not invent a new local branch as part of legacy
  // recovery. Every new Candidate publication supplies an explicit local lease.
  if (advanceLocalRef && (binding || expectedLocalSha !== undefined) && currentLocal !== commit) {
    const expected = expectedLocalSha === null
      ? '0'.repeat(String(commit).length)
      : String(expectedLocalSha ?? '');
    if (!GIT_OBJECT.test(expected)) {
      fail('Lifecycle Candidate local compare-and-swap authority is unavailable.',
        'SGOS_CANDIDATE_PUBLICATION_LOCAL_LEASE_REQUIRED', { targetBranch });
    }
    if ((currentLocal ?? '0'.repeat(String(commit).length)) !== expected) {
      fail('Lifecycle Candidate local branch changed after verification.',
        'SGOS_CANDIDATE_PUBLICATION_LOCAL_LEASE_LOST', {
          targetBranch, expectedLocalSha: expectedLocalSha ?? null, currentLocal
        });
    }
    const advanced = tryGitResult(root, ['update-ref', localRef, commit, expected]);
    if (advanced.error || advanced.status !== 0) {
      fail('Lifecycle Candidate local branch lost its compare-and-swap race.',
        'SGOS_CANDIDATE_PUBLICATION_LOCAL_LEASE_LOST', { targetBranch });
    }
  }

  const result = pushCommitToBranch(root, remote, commit, targetBranch, {
    ...(expectedRemoteSha !== undefined ? { expectedRemoteSha } : {}),
    ...(transportRemote !== undefined ? { transportRemote } : {}),
    ...(upstreamRemote !== undefined ? { upstreamRemote } : {})
  });
  return Object.freeze({
    result,
    commit,
    branch: targetBranch,
    candidateVerified: Boolean(binding),
    legacyUnverified: !binding
  });
}

export async function readSgosRetainedCandidate(root, candidateId) {
  const target = candidateRecordPath(root, candidateId);
  let record;
  try {
    record = JSON.parse((await readPrivateSidecar(root, target, {
      maximumBytes: MAX_CANDIDATE_RECORD_BYTES
    })).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`Candidate '${candidateId}' was not found.`, 'SGOS_CANDIDATE_NOT_FOUND');
    throw error;
  }
  if (record?.candidateRecordFormat !== CANDIDATE_RECORD_FORMAT
      || record.candidateRecordVersion !== CANDIDATE_RECORD_VERSION
      || record?.kind !== 'sgos-retained-candidate'
      || record.retainedCandidateSha256 !== sha256(Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== 'retainedCandidateSha256')
      ))) {
    fail('Retained Candidate record failed its content hash.', 'SGOS_CANDIDATE_CORRUPT');
  }
  validateCandidateSnapshot(record.candidate);
  const repository = record.repository ?? {};
  for (const field of ['baselineCommit', 'baselineTree', 'candidateTree', 'candidateCommit']) {
    if (!GIT_OBJECT.test(String(repository[field] ?? ''))) {
      fail('Retained Candidate has an invalid Git object binding.', 'SGOS_CANDIDATE_CORRUPT', { field });
    }
  }
  const observedCommit = gitText(root, ['rev-parse', repository.retainedRef]);
  const observedTree = gitText(root, ['rev-parse', `${observedCommit}^{tree}`]);
  if (observedCommit !== repository.candidateCommit || observedTree !== repository.candidateTree) {
    fail('Candidate retention ref no longer names the frozen tree.', 'SGOS_CANDIDATE_RETENTION_LOST');
  }
  return freezeDeep(record);
}

export async function listSgosCandidates(root) {
  const entries = await listPrivateSidecar(root, candidateRoot(root), { optional: true });
  const records = [];
  for (const entry of entries.sort((a, b) => compareSgosCodePoints(a.name, b.name))) {
    if (!CANDIDATE_ID.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('Candidate sidecar contains an unsafe record entry.',
        'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
    }
    try { records.push(await readSgosRetainedCandidate(root, entry.name)); } catch (error) {
      records.push(freezeDeep({
        kind: 'sgos-candidate-unavailable', candidateId: entry.name,
        code: error?.code ?? 'SGOS_CANDIDATE_UNAVAILABLE', successClaimed: false
      }));
    }
  }
  return Object.freeze(records);
}

function normalizeVerificationCommands(commands) {
  if (!Array.isArray(commands) || !commands.length || commands.length > MAX_COMMANDS) {
    fail('Candidate verification requires a bounded non-empty command list.',
      'SGOS_CANDIDATE_VERIFICATION_INVALID', { maximumCommands: MAX_COMMANDS });
  }
  return commands.map((command, index) => {
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) {
      fail(`Candidate verification command ${index + 1} must be a non-empty argv array.`,
        'SGOS_CANDIDATE_VERIFICATION_INVALID');
    }
    if (!path.isAbsolute(command[0])) {
      fail(`Candidate verification command ${index + 1} executable must be an absolute path.`,
        'SGOS_CANDIDATE_VERIFICATION_INVALID');
    }
    if (command.length > MAX_COMMAND_ARGUMENTS
        || command.reduce((bytes, part) => bytes + Buffer.byteLength(part), 0)
          > MAX_COMMAND_ARGUMENT_BYTES) {
      fail(`Candidate verification command ${index + 1} exceeds the installed argument ceiling.`,
        'SGOS_CANDIDATE_VERIFICATION_INVALID', {
          maximumArguments: MAX_COMMAND_ARGUMENTS,
          maximumArgumentBytes: MAX_COMMAND_ARGUMENT_BYTES
        });
    }
    return [...command];
  });
}

export function createSgosCandidateVerifierPolicy({
  policyId = 'default', commands, timeoutMs = 15 * 60 * 1000,
  approvedBy, approvedAt
} = {}) {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(String(policyId ?? ''))) {
    fail('Candidate verifier policy ID must be a canonical lower-case identifier.',
      'SGOS_CANDIDATE_VERIFICATION_POLICY_INVALID');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) {
    fail('Candidate verifier policy timeout is outside the installed bounds.',
      'SGOS_CANDIDATE_VERIFICATION_POLICY_INVALID');
  }
  if (!approvedBy || typeof approvedBy !== 'object' || Array.isArray(approvedBy)
      || typeof approvedBy.id !== 'string' || !approvedBy.id
      || typeof approvedBy.kind !== 'string' || !approvedBy.kind) {
    fail('Candidate verifier policy requires a typed approving principal.',
      'SGOS_CANDIDATE_VERIFICATION_POLICY_INVALID');
  }
  if (typeof approvedAt !== 'string' || !Number.isFinite(Date.parse(approvedAt))) {
    fail('Candidate verifier policy requires an ISO approval timestamp.',
      'SGOS_CANDIDATE_VERIFICATION_POLICY_INVALID');
  }
  const core = {
    format: CANDIDATE_VERIFIER_POLICY_FORMAT,
    policyId,
    decision: 'approved',
    commands: normalizeVerificationCommands(commands),
    timeoutMs,
    approvedBy: structuredClone(approvedBy),
    approvedAt
  };
  return freezeDeep({ ...core, policySha256: sha256(core) });
}

function validateSgosCandidateVerifierPolicy(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('Approved Candidate verifier policy must be a JSON object.',
      'SGOS_CANDIDATE_VERIFICATION_POLICY_INVALID');
  }
  const expectedKeys = [
    'approvedAt', 'approvedBy', 'commands', 'decision', 'format', 'policyId',
    'policySha256', 'timeoutMs'
  ];
  if (canonicalJson(Object.keys(record).sort()) !== canonicalJson(expectedKeys)) {
    fail('Approved Candidate verifier policy has missing or unsupported fields.',
      'SGOS_CANDIDATE_VERIFICATION_POLICY_INVALID');
  }
  const rebuilt = createSgosCandidateVerifierPolicy(record);
  if (record.format !== CANDIDATE_VERIFIER_POLICY_FORMAT || record.decision !== 'approved'
      || canonicalJson(rebuilt) !== canonicalJson(record)) {
    fail('Approved Candidate verifier policy failed its exact content binding.',
      'SGOS_CANDIDATE_VERIFICATION_POLICY_INVALID');
  }
  return rebuilt;
}

async function loadApprovedCandidateVerifierPolicy(root, { refreshAuthority = true } = {}) {
  try {
    return await withTrustedSgosConfigurationRead(root, async (authority, authorityTrust) => {
      if (!authority?.ref || !/^[a-f0-9]{40,64}$/.test(authority.commit ?? '')
          || !['approved-configuration-ref', 'verified-state-mirror'].includes(authority.kind)
          || !authorityTrust) {
        fail('Candidate verification requires an exact verifier policy from approved sflow/config authority.',
          'SGOS_CANDIDATE_VERIFICATION_POLICY_UNAVAILABLE', {
            path: SGOS_CANDIDATE_VERIFIER_POLICY_PATH
          });
      }
      const approvedRoot = configurationReadRoot(root);
      let workflowBytes;
      let policyBytes;
      try {
        [workflowBytes, policyBytes] = await Promise.all([
          readFile(path.join(approvedRoot, 'singularity', 'workflow.yml')),
          readFile(path.join(approvedRoot, SGOS_CANDIDATE_VERIFIER_POLICY_PATH))
        ]);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
        fail(`Approved configuration does not contain '${SGOS_CANDIDATE_VERIFIER_POLICY_PATH}'.`,
          'SGOS_CANDIDATE_VERIFICATION_POLICY_UNAVAILABLE', {
            path: SGOS_CANDIDATE_VERIFIER_POLICY_PATH,
            ref: authority.ref,
            commit: authority.commit
          });
      }
      let parsed;
      try { parsed = JSON.parse(policyBytes.toString('utf8')); } catch (error) {
        fail(`Approved Candidate verifier policy is not valid JSON: ${error.message}`,
          'SGOS_CANDIDATE_VERIFICATION_POLICY_INVALID');
      }
      const policy = validateSgosCandidateVerifierPolicy(parsed);
      return freezeDeep({
        policy,
        commandSetSha256: sha256(policy.commands),
        source: {
          kind: authority.kind,
          ref: authority.ref,
          commit: authority.commit,
          sourceCommit: authority.manifest?.source?.commit ?? authority.commit,
          path: SGOS_CANDIDATE_VERIFIER_POLICY_PATH,
          blobSha256: digestBytes(policyBytes),
          workflowBlobSha256: digestBytes(workflowBytes),
          trust: structuredClone(authorityTrust)
        }
      });
    }, {
      refreshAuthority,
      selectPaths: ['singularity/workflow.yml', SGOS_CANDIDATE_VERIFIER_POLICY_PATH]
    });
  } catch (error) {
    if (error?.code === 'APPROVED_CONFIGURATION_INCOMPLETE'
        && error?.details?.missing?.includes(SGOS_CANDIDATE_VERIFIER_POLICY_PATH)) {
      fail(`Approved configuration does not contain '${SGOS_CANDIDATE_VERIFIER_POLICY_PATH}'.`,
        'SGOS_CANDIDATE_VERIFICATION_POLICY_UNAVAILABLE', {
          path: SGOS_CANDIDATE_VERIFIER_POLICY_PATH
        });
    }
    throw error;
  }
}

async function runBoundedCommand(command, cwd, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const allowedEnvironment = [
      'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec',
      'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'CI'
    ];
    const childEnvironment = {
      ...Object.fromEntries(allowedEnvironment
        .filter((key) => Object.hasOwn(process.env, key))
        .map((key) => [key, process.env[key]])),
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'
    };
    let launch;
    try {
      launch = resolvePlatformProcess(command[0], command.slice(1), {
        platform: process.platform, environment: childEnvironment, cwd
      });
    } catch (error) {
      return reject(new SingularityFlowError(`Candidate verifier executable is unavailable: ${error.message}`, {
        code: 'SGOS_CANDIDATE_VERIFICATION_COMMAND_UNAVAILABLE', cause: error
      }));
    }
    const child = spawn(launch.executable, launch.arguments, {
      cwd,
      env: childEnvironment,
      ...launch.spawnOptions,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const chunks = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let forceTimer = null;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32' && child.pid) {
        if (!tryWindowsTaskkill(child.pid, {
          environment: process.env, spawnSyncCommand: spawnSync, timeoutMs: 5_000
        })) child.kill('SIGTERM');
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      }
      forceTimer ??= setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === 'win32' && child.pid) {
          if (!tryWindowsTaskkill(child.pid, {
            force: true, environment: process.env, spawnSyncCommand: spawnSync,
            timeoutMs: 5_000
          })) child.kill('SIGKILL');
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, 2_000);
      forceTimer.unref?.();
    };
    const append = (chunk) => {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        overflow = true;
        terminate();
      } else chunks.push(value);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', reject);
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const abort = () => terminate();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) terminate();
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      const output = Buffer.concat(chunks);
      resolve({
        status: code ?? 1, signal: terminationSignal ?? null, timedOut,
        aborted: signal?.aborted === true, overflow, outputBytes: output.length,
        outputSha256: digestBytes(output)
      });
    });
  });
}

export async function verifySgosCandidate(root, candidateId, {
  commands = null, timeoutMs = null, signal = null, verifiedAt = nowIso()
} = {}) {
  const retained = await readSgosRetainedCandidate(root, candidateId);
  const approvedVerifier = await loadApprovedCandidateVerifierPolicy(root);
  if (commands != null
      && canonicalJson(normalizeVerificationCommands(commands))
        !== canonicalJson(approvedVerifier.policy.commands)) {
    fail(`Caller-selected verifier commands do not equal approved '${SGOS_CANDIDATE_VERIFIER_POLICY_PATH}'.`,
      'SGOS_CANDIDATE_VERIFIER_CALLER_REFUSED');
  }
  if (timeoutMs != null && timeoutMs !== approvedVerifier.policy.timeoutMs) {
    fail(`Caller-selected verifier timeout does not equal approved '${SGOS_CANDIDATE_VERIFIER_POLICY_PATH}'.`,
      'SGOS_CANDIDATE_VERIFIER_CALLER_REFUSED');
  }
  await safePrivateSidecarDirectory(root, verificationDirectory(root, candidateId), {
    create: true
  });
  const normalized = approvedVerifier.policy.commands;
  const effectiveTimeoutMs = approvedVerifier.policy.timeoutMs;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-verify-'));
  const workspace = path.join(temporary, 'worktree');
  const results = [];
  try {
    // A linked worktree shares the application's Git common directory. Test code running there
    // could therefore mutate application refs or forge SGOS sidecars through ordinary Git
    // discovery. A non-local clone has an independent object database and ref namespace.
    gitResult(root, [
      'clone', '--no-local', '--no-checkout', '--no-tags', '--single-branch',
      '--branch', branch(root), '--', root, workspace
    ], { maximumBytes: MAX_CANDIDATE_BYTES });
    gitResult(workspace, [
      'fetch', '--no-tags', '--no-write-fetch-head', '--', root,
      `${retained.repository.retainedRef}:refs/singularity-flow/verification-candidate`
    ], { maximumBytes: MAX_CANDIDATE_BYTES });
    gitResult(workspace, ['remote', 'remove', 'origin']);
    gitResult(workspace, ['checkout', '--detach', retained.repository.candidateCommit, '--']);
    for (const command of normalized) {
      let executableInfo;
      try { executableInfo = await lstat(command[0]); } catch (error) {
        fail(`Candidate verification executable '${command[0]}' is unavailable.`,
          'SGOS_CANDIDATE_VERIFICATION_INVALID', { causeCode: error?.code ?? null });
      }
      if (!executableInfo.isFile() || executableInfo.isSymbolicLink()
          || executableInfo.size > MAX_CANDIDATE_BYTES) {
        fail(`Candidate verification executable '${command[0]}' is not a bounded regular file.`,
          'SGOS_CANDIDATE_VERIFICATION_INVALID');
      }
      const executableSha256 = digestBytes(await readFile(command[0]));
      const result = await runBoundedCommand(command, workspace, {
        timeoutMs: effectiveTimeoutMs, signal
      });
      results.push({ argvSha256: sha256(command), executableSha256, ...result });
      if (result.status !== 0 || result.timedOut || result.aborted || result.overflow) break;
    }
    const observedTree = gitText(workspace, ['rev-parse', 'HEAD^{tree}']);
    const observedWorkingTree = await worktreeTree(workspace);
    const untrackedOrModified = gitResult(workspace, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--'
    ]).length > 0;
    const passed = results.length === normalized.length
      && results.every((entry) => entry.status === 0 && !entry.timedOut && !entry.aborted && !entry.overflow)
      && observedTree === retained.repository.candidateTree
      && observedWorkingTree === retained.repository.candidateTree
      && !untrackedOrModified;
    const receipt = seal('candidate-verification-receipt', 'verificationReceiptSha256', {
      candidateId,
      candidateSha256: retained.candidate.candidateSha256,
      retainedCandidateSha256: retained.retainedCandidateSha256,
      candidateTree: retained.repository.candidateTree,
      commandSetSha256: sha256(normalized),
      verificationPolicy: {
        policyId: approvedVerifier.policy.policyId,
        policySha256: approvedVerifier.policy.policySha256,
        source: approvedVerifier.source
      },
      results,
      workspaceIntegrity: {
        expectedTree: retained.repository.candidateTree,
        observedHeadTree: observedTree,
        observedWorkingTree,
        clean: !untrackedOrModified
      },
      status: passed ? 'passed' : 'failed',
      verifiedAt
    });
    const target = path.join(verificationDirectory(root, candidateId),
      `${receipt.verificationReceiptSha256.slice('sha256:'.length)}.json`);
    await writeImmutable(root, target, receipt, 'verificationReceiptSha256');
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function passedVerificationReceipts(root, candidateId) {
  const entries = await listPrivateSidecar(root, verificationDirectory(root, candidateId), {
    optional: true
  });
  const values = [];
  for (const entry of entries.sort((a, b) => compareSgosCodePoints(a.name, b.name))) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail('Candidate verification sidecar contains an unsafe record entry.',
        'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
    }
    const value = JSON.parse((await readPrivateSidecar(
      root, path.join(verificationDirectory(root, candidateId), entry.name), {
        maximumBytes: MAX_CANDIDATE_RECORD_BYTES
      }
    )).toString('utf8'));
    const hash = sha256(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'verificationReceiptSha256')));
    const expectedKeys = [
      'candidateId', 'candidateRecordFormat', 'candidateRecordVersion', 'candidateSha256',
      'candidateTree', 'commandSetSha256', 'kind', 'results', 'retainedCandidateSha256',
      'status', 'verificationPolicy', 'verificationReceiptSha256', 'verifiedAt',
      'workspaceIntegrity'
    ];
    const exactShape = value && typeof value === 'object' && !Array.isArray(value)
      && canonicalJson(Object.keys(value).sort()) === canonicalJson(expectedKeys.sort());
    const filenameDigest = `sha256:${entry.name.slice(0, -'.json'.length)}`;
    if (!exactShape || value.kind !== 'candidate-verification-receipt'
        || value.candidateRecordFormat !== CANDIDATE_RECORD_FORMAT
        || value.candidateRecordVersion !== CANDIDATE_RECORD_VERSION
        || value.candidateId !== candidateId || value.verificationReceiptSha256 !== hash
        || value.verificationReceiptSha256 !== filenameDigest
        || !HASH.test(String(value.candidateSha256 ?? ''))
        || !GIT_OBJECT.test(String(value.candidateTree ?? ''))
        || !HASH.test(String(value.commandSetSha256 ?? ''))
        || typeof value.verificationPolicy?.policyId !== 'string'
        || !HASH.test(String(value.verificationPolicy?.policySha256 ?? ''))
        || value.verificationPolicy?.source?.path !== SGOS_CANDIDATE_VERIFIER_POLICY_PATH
        || !['approved-configuration-ref', 'verified-state-mirror']
          .includes(value.verificationPolicy?.source?.kind)
        || !/^refs\/(?:heads|remotes)\/[A-Za-z0-9._/-]+$/
          .test(String(value.verificationPolicy?.source?.ref ?? ''))
        || !GIT_OBJECT.test(String(value.verificationPolicy?.source?.commit ?? ''))
        || !GIT_OBJECT.test(String(value.verificationPolicy?.source?.sourceCommit ?? ''))
        || !HASH.test(String(value.verificationPolicy?.source?.blobSha256 ?? ''))
        || !HASH.test(String(value.verificationPolicy?.source?.workflowBlobSha256 ?? ''))
        || !Array.isArray(value.results) || !value.results.length || value.results.length > MAX_COMMANDS
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(value.verifiedAt ?? ''))) {
      fail('Candidate verification receipt is corrupt.', 'SGOS_CANDIDATE_VERIFICATION_CORRUPT');
    }
    const integrity = value.workspaceIntegrity;
    const passedShape = integrity && integrity.clean === true
      && integrity.expectedTree === value.candidateTree
      && integrity.observedHeadTree === value.candidateTree
      && integrity.observedWorkingTree === value.candidateTree
      && value.results.every((result) => result?.status === 0 && result.timedOut === false
        && result.aborted === false && result.overflow === false
        && HASH.test(String(result.argvSha256 ?? ''))
        && HASH.test(String(result.executableSha256 ?? ''))
        && HASH.test(String(result.outputSha256 ?? '')));
    if (value.status === 'passed' && !passedShape) {
      fail('Candidate passed-verification receipt contradicts its bound evidence.',
        'SGOS_CANDIDATE_VERIFICATION_CORRUPT');
    }
    if (value.status === 'passed') values.push(freezeDeep(value));
  }
  return values.sort((left, right) => compareSgosCodePoints(left.verifiedAt, right.verifiedAt)
    || compareSgosCodePoints(left.verificationReceiptSha256, right.verificationReceiptSha256));
}

export async function planSgosCandidatePublication(root, candidateId, {
  targetBranch = branch(root), remote = null
} = {}) {
  const retained = await readSgosRetainedCandidate(root, candidateId);
  if (!BRANCH.test(String(targetBranch ?? ''))) fail('Candidate target branch is invalid.', 'SGOS_CANDIDATE_TARGET_INVALID');
  if (remote !== null && !REMOTE.test(String(remote))) {
    fail('Candidate remote name is invalid.', 'SGOS_CANDIDATE_REMOTE_INVALID');
  }
  const subjects = await buildRepositorySubjectIndex(root);
  const governedTarget = subjects.subjects.find((entry) =>
    entry.canonicalBranch === targetBranch || entry.branches.includes(targetBranch));
  if (governedTarget) {
    fail(
      `Branch '${targetBranch}' is governed by ${governedTarget.kind} '${governedTarget.id}'. `
      + 'Publish it through the lifecycle transaction so its installed admission packet, exact '
      + 'Candidate, and recovery receipt remain one authority.',
      'SGOS_CANDIDATE_LIFECYCLE_ADMISSION_REQUIRED',
      { subject: { kind: governedTarget.kind, id: governedTarget.id }, targetBranch }
    );
  }
  const approvedVerifier = await loadApprovedCandidateVerifierPolicy(root);
  const receipts = await passedVerificationReceipts(root, candidateId);
  const verification = receipts.filter((entry) =>
    entry.verificationPolicy.policySha256 === approvedVerifier.policy.policySha256
      && entry.commandSetSha256 === approvedVerifier.commandSetSha256).at(-1) ?? null;
  if (!verification || verification.candidateSha256 !== retained.candidate.candidateSha256
      || verification.candidateTree !== retained.repository.candidateTree) {
    fail('Candidate has no exact passed verification receipt from the current approved verifier policy.',
      'SGOS_CANDIDATE_VERIFICATION_REQUIRED', {
        verificationPolicySha256: approvedVerifier.policy.policySha256
      });
  }
  const currentBranch = branch(root);
  const currentHead = head(root);
  const currentTree = await worktreeTree(root);
  let remoteTargetCommit = null;
  let remoteAuthorityFingerprint = null;
  if (remote !== null) {
    if (!hasRemote(root, remote)) fail(`Git remote '${remote}' is not configured.`, 'SGOS_CANDIDATE_REMOTE_INVALID');
    const authority = configuredRemoteAuthority(root, remote, { direction: 'push' });
    if (!authority.url || !authority.fingerprint) {
      fail(`Git remote '${remote}' has no exact push authority.`, 'SGOS_CANDIDATE_REMOTE_INVALID');
    }
    const observed = exactRemoteBranchObservation(root, authority.url, targetBranch);
    if (!observed.reachable || observed.malformed) {
      fail(`Git remote '${remote}' cannot provide one exact '${targetBranch}' tip.`,
        'SGOS_CANDIDATE_REMOTE_INVALID');
    }
    remoteTargetCommit = observed.sha;
    remoteAuthorityFingerprint = authority.fingerprint;
  }
  const plan = seal('candidate-publication-plan', 'packetSha256', {
    candidateId,
    candidateSha256: retained.candidate.candidateSha256,
    verificationReceiptSha256: verification.verificationReceiptSha256,
    verificationPolicySha256: approvedVerifier.policy.policySha256,
    targetBranch,
    expectedTargetCommit: retained.repository.baselineCommit,
    candidateCommit: retained.repository.candidateCommit,
    candidateTree: retained.repository.candidateTree,
    remote,
    preconditions: {
      currentBranch,
      currentHead,
      worktreeTree: currentTree,
      remoteTargetCommit,
      remoteAuthorityFingerprint,
      branchMatches: currentBranch === targetBranch,
      baselineMatches: currentHead === retained.repository.baselineCommit,
      worktreeMatches: currentTree === retained.repository.candidateTree
    }
  });
  await writeImmutable(root, path.join(publicationPlanDirectory(root, candidateId),
    `${plan.packetSha256.slice('sha256:'.length)}.json`), plan, 'packetSha256');
  return plan;
}

async function readSgosCandidatePublicationPlan(root, candidateId, packetSha256) {
  if (!HASH.test(String(packetSha256 ?? ''))) {
    fail('Candidate publication packet SHA-256 is invalid.',
      'SGOS_CANDIDATE_PUBLICATION_CONFIRMATION_REQUIRED');
  }
  let plan;
  try {
    plan = JSON.parse((await readPrivateSidecar(root,
      path.join(publicationPlanDirectory(root, candidateId),
        `${packetSha256.slice('sha256:'.length)}.json`), {
        maximumBytes: MAX_CANDIDATE_RECORD_BYTES
      })).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('Candidate publication plan is missing; preview it again.',
        'SGOS_CANDIDATE_PUBLICATION_STALE', { packetSha256 });
    }
    throw error;
  }
  const expected = sha256(Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== 'packetSha256')
  ));
  if (plan.candidateRecordFormat !== CANDIDATE_RECORD_FORMAT
      || plan.candidateRecordVersion !== CANDIDATE_RECORD_VERSION
      || plan.kind !== 'candidate-publication-plan' || plan.packetSha256 !== expected
      || plan.packetSha256 !== packetSha256 || plan.candidateId !== candidateId) {
    fail('Candidate publication plan failed its exact content binding.',
      'SGOS_CANDIDATE_PUBLICATION_STALE', { packetSha256 });
  }
  return freezeDeep(plan);
}

export async function publishSgosCandidate(root, candidateId, {
  confirmationSha256, targetBranch = branch(root), remote = null, publishedAt = nowIso(),
  fault = null
} = {}) {
  if (!HASH.test(String(confirmationSha256 ?? ''))) {
    fail('Candidate publication requires the exact publication packet SHA-256.',
      'SGOS_CANDIDATE_PUBLICATION_CONFIRMATION_REQUIRED');
  }
  let plan;
  try {
    plan = await readSgosCandidatePublicationPlan(root, candidateId, confirmationSha256);
  } catch (error) {
    if (error?.code !== 'SGOS_CANDIDATE_PUBLICATION_STALE') throw error;
    const preview = await planSgosCandidatePublication(root, candidateId, { targetBranch, remote });
    if (preview.packetSha256 !== confirmationSha256) {
      fail(`Candidate publication confirmation must equal ${preview.packetSha256}.`,
        'SGOS_CANDIDATE_PUBLICATION_STALE', { expected: preview.packetSha256 });
    }
    plan = preview;
  }
  if (plan.targetBranch !== targetBranch || plan.remote !== remote) {
    fail('Candidate publication target differs from the confirmed plan.',
      'SGOS_CANDIDATE_PUBLICATION_STALE', {
        expected: { targetBranch: plan.targetBranch, remote: plan.remote },
        received: { targetBranch, remote }
      });
  }
  if (!HASH.test(String(plan.verificationPolicySha256 ?? ''))) {
    fail('Candidate publication plan does not bind an approved verifier policy; preview a new exact plan.',
      'SGOS_CANDIDATE_PUBLICATION_STALE');
  }
  const currentBranch = branch(root);
  const currentHead = head(root);
  const currentTree = await worktreeTree(root);
  const branchAdvanced = currentBranch === plan.targetBranch
    && currentHead === plan.candidateCommit;
  const alreadyPublished = branchAdvanced && currentTree === plan.candidateTree;
  const readyToPublish = currentBranch === plan.preconditions.currentBranch
    && currentHead === plan.preconditions.currentHead
    && currentTree === plan.preconditions.worktreeTree
    && plan.preconditions.branchMatches
    && plan.preconditions.baselineMatches
    && plan.preconditions.worktreeMatches;
  if (!readyToPublish && !alreadyPublished) {
    fail('Candidate publication preconditions changed; preview a new exact plan.',
      'SGOS_CANDIDATE_PUBLICATION_STALE', {
        preconditions: plan.preconditions,
        observed: { currentBranch, currentHead, worktreeTree: currentTree }
      });
  }
  // Before the publication boundary, require the policy that authorized verification to remain
  // the current approved policy. After a recovered branch CAS, the authority transition already
  // happened; recovery must finish the exact local transaction rather than strand a dirty index
  // because the configuration remote subsequently became unavailable or advanced.
  if (!branchAdvanced) {
    const approvedVerifier = await loadApprovedCandidateVerifierPolicy(root);
    if (approvedVerifier.policy.policySha256 !== plan.verificationPolicySha256) {
      fail('Approved Candidate verifier policy changed after publication confirmation; preview and verify again.',
        'SGOS_CANDIDATE_VERIFICATION_POLICY_STALE', {
          expected: plan.verificationPolicySha256,
          observed: approvedVerifier.policy.policySha256
      });
    }
  }
  // A publication receipt is part of the local transaction. Refuse a redirected receipt path
  // before the branch compare-and-swap can make the Candidate visible.
  await safePrivateSidecarDirectory(root, publicationDirectory(root, candidateId), {
    create: true
  });
  let remoteObservation = null;
  let remoteAuthority = null;
  let remotePreflightFailure = null;
  let transportReceipt = null;
  if (remote != null) {
    if (!hasRemote(root, remote)) {
      if (!branchAdvanced) {
        fail(`Git remote '${remote}' is not configured.`, 'SGOS_CANDIDATE_REMOTE_INVALID');
      }
      remotePreflightFailure = { code: 'remote-not-configured' };
    } else {
      remoteAuthority = configuredRemoteAuthority(root, remote, { direction: 'push' });
      if (!remoteAuthority.url || remoteAuthority.fingerprint !== plan.preconditions.remoteAuthorityFingerprint) {
        if (!branchAdvanced) {
          fail('Candidate remote authority changed after publication confirmation.',
            'SGOS_CANDIDATE_PUBLICATION_STALE');
        }
        remotePreflightFailure = { code: 'remote-authority-changed' };
      }
      if (!remotePreflightFailure) {
        transportReceipt = await readCandidateTransportReceipt(
          root, plan, remoteAuthority.fingerprint
        );
      }
      remoteObservation = remotePreflightFailure
        ? null
        : exactRemoteBranchObservation(root, remoteAuthority.url, targetBranch);
      if (!remotePreflightFailure && (!remoteObservation.reachable || remoteObservation.malformed)) {
        if (!branchAdvanced) {
          fail(`Git remote '${remote}' cannot provide one exact '${targetBranch}' tip.`,
            'SGOS_CANDIDATE_REMOTE_INVALID');
        }
        remotePreflightFailure = {
          code: remoteObservation.malformed ? 'remote-advertisement-malformed' : 'remote-unreachable'
        };
      } else if (!remotePreflightFailure && remoteObservation.sha !== plan.candidateCommit
          && remoteObservation.sha !== plan.preconditions.remoteTargetCommit) {
        if (!branchAdvanced) {
          fail('Candidate remote target changed after publication confirmation.',
            'SGOS_CANDIDATE_PUBLICATION_STALE', {
              expected: plan.preconditions.remoteTargetCommit,
              observed: remoteObservation.sha
            });
        }
        remotePreflightFailure = {
          code: 'remote-target-changed',
          expectedCommit: plan.preconditions.remoteTargetCommit,
          observedCommit: remoteObservation.sha
        };
      }
    }
  }
  if (!remotePreflightFailure && remoteObservation?.sha === plan.candidateCommit
      && !branchAdvanced
      && transportReceipt?.pushOutcome !== 'transport-indeterminate') {
    fail(
      'Candidate remote target already equals the Candidate, but this machine has no retained '
      + 'indeterminate transport attempt that can own that update. Preview a new plan after '
      + 'reviewing the concurrent remote change; the local ref was not changed.',
      'SGOS_CANDIDATE_PUBLICATION_STALE', {
        expected: plan.preconditions.remoteTargetCommit,
        observed: remoteObservation.sha
      }
    );
  }
  if (!branchAdvanced) {
    gitResult(root, ['update-ref', `refs/heads/${targetBranch}`, plan.candidateCommit, plan.expectedTargetCommit]);
  }
  // The branch ref and index are separate durable boundaries. This is intentionally idempotent:
  // if a process died after update-ref but before read-tree, the confirmed retry repairs the index
  // only after proving that the untouched worktree still equals the exact Candidate tree.
  gitResult(root, ['read-tree', plan.candidateCommit]);
  const publishedTree = gitText(root, ['rev-parse', 'HEAD^{tree}']);
  const publishedIndexTree = gitText(root, ['write-tree']);
  const publishedWorktreeTree = await worktreeTree(root);
  const publishedWorktreeClean = gitResult(root, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--'
  ]).length === 0;
  if (head(root) !== plan.candidateCommit || publishedTree !== plan.candidateTree
      || publishedIndexTree !== plan.candidateTree
      || publishedWorktreeTree !== plan.candidateTree || !publishedWorktreeClean) {
    fail('Local publication does not equal the verified Candidate tree.', 'SGOS_CANDIDATE_PUBLICATION_MISMATCH');
  }
  let remoteResult = null;
  if (remote != null) {
    if (remotePreflightFailure) {
      remoteResult = {
        remote, priorCommit: plan.preconditions.remoteTargetCommit,
        status: 1, pushed: false, recovered: branchAdvanced,
        failure: remotePreflightFailure
      };
    } else if (remoteObservation.sha === plan.candidateCommit) {
      if (transportReceipt?.pushOutcome === 'transport-indeterminate') {
        await writeCandidateTransportReceipt(
          root, plan, remoteAuthority.fingerprint, 'published', publishedAt
        );
      }
      remoteResult = {
        remote, priorCommit: plan.preconditions.remoteTargetCommit,
        status: 0, pushed: true, recovered: true, failure: null
      };
    } else {
      await writeCandidateTransportReceipt(
        root, plan, remoteAuthority.fingerprint, 'transport-indeterminate', publishedAt
      );
      const pushed = pushCommitToBranch(root, remote, plan.candidateCommit, targetBranch, {
        expectedRemoteSha: plan.preconditions.remoteTargetCommit,
        transportRemote: remoteAuthority.url,
        upstreamRemote: remote
      });
      if (fault) await fault('after-remote-push-before-transport-receipt', {
        plan, result: pushed
      });
      const pushOutcome = pushed.status === 0
        ? 'published' : publicationPushOutcome(pushed);
      await writeCandidateTransportReceipt(
        root, plan, remoteAuthority.fingerprint, pushOutcome, publishedAt
      );
      remoteResult = {
        remote, priorCommit: plan.preconditions.remoteTargetCommit,
        status: pushed.status,
        pushed: pushed.status === 0,
        recovered: false,
        failure: pushed.status === 0 ? null : pushed.failure ?? null
      };
    }
  }
  const receipt = seal('candidate-publication-receipt', 'publicationReceiptSha256', {
    candidateId,
    candidateSha256: plan.candidateSha256,
    verificationReceiptSha256: plan.verificationReceiptSha256,
    packetSha256: plan.packetSha256,
    targetBranch,
    priorCommit: plan.expectedTargetCommit,
    publishedCommit: plan.candidateCommit,
    publishedTree,
    publishedIndexTree,
    publishedWorktreeTree,
    publishedWorktreeClean,
    remote: remoteResult,
    status: remoteResult && !remoteResult.pushed ? 'local-published-remote-pending' : 'published',
    publishedAt
  });
  const target = path.join(publicationDirectory(root, candidateId),
    `${receipt.publicationReceiptSha256.slice('sha256:'.length)}.json`);
  await writeImmutable(root, target, receipt, 'publicationReceiptSha256');
  return receipt;
}

export function candidateDiffArguments(retained) {
  return Object.freeze([
    'diff', '--find-renames', retained.repository.baselineCommit, retained.repository.candidateCommit, '--'
  ]);
}
