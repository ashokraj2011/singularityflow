import path from 'node:path';
import { rm } from 'node:fs/promises';

import { gitCommonDir } from '../git.mjs';
import { runRemoteGit } from '../git-execution.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import { stateBranchPublicationTargetIdentity } from '../ledger.mjs';
import { frozenRemoteTransport } from '../git-remote-diagnostics.mjs';
import {
  listPrivateSidecar, readPrivateSidecar, writeImmutablePrivateSidecar
} from '../private-sidecar.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError, run } from '../util.mjs';
import { canonicalJson, sealRecord, sha256 } from './canonicalize.mjs';
import {
  publishWorldModelTransaction, validateStagedWorldModelPublication
} from './publish/transaction.mjs';

const FAMILY = 'world-model-publication-recovery';
const KIND = 'world-model-publication-recovery';
const MAXIMUM_RECOVERY_BYTES = 128 * 1024 * 1024;
const RECOVERY_ID = /^wmb4-[a-f0-9]{32}$/;

function git(root, args, { allowFailure = false, env = process.env } = {}) {
  if (['fetch', 'ls-remote'].includes(args[0])) {
    return runRemoteGit(args, {
      cwd: root,
      operation: args[0] === 'ls-remote' ? 'remote-probe' : 'remote-configuration',
      allowFailure,
      env
    });
  }
  return run('git', args, { cwd: root, allowFailure, env });
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || Number.isNaN(Date.parse(value))) {
    throw new SingularityFlowError('WMB v4 publication recovery timestamp is invalid.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  return value;
}

function recoveryRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'world-model-v4-recovery');
}

function recoveryPath(root, id) {
  if (!RECOVERY_ID.test(String(id ?? ''))) {
    throw new SingularityFlowError('WMB v4 publication recovery ID is invalid.', {
      code: 'WMB_PUBLICATION_RECOVERY_ID_INVALID'
    });
  }
  return path.join(recoveryRoot(root), `${id}.json`);
}

function canonicalLedgerConfig(value = {}) {
  const normalized = normalizeLedgerConfig(value);
  if (normalized.branch.length > 512 || normalized.remote.length > 512
      || /[\u0000-\u001f\u007f]/.test(`${normalized.branch}${normalized.remote}`)
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized.branch)
      || normalized.branch.includes('..') || normalized.branch.includes('@{')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized.remote)) {
    throw new SingularityFlowError('WMB v4 publication recovery requires a safe state branch and remote.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  return Object.freeze(normalized);
}

function canonicalPublicationOptions(value = {}) {
  const message = String(value.message ?? '[world-model][wmb-v4] publish registered views');
  if (!message.trim() || message.length > 512 || /[\u0000-\u001f\u007f]/.test(message)) {
    throw new SingularityFlowError('WMB v4 publication recovery commit message is invalid.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  const digest = (entry, label, { nullable = false } = {}) => {
    if (nullable && entry === null) return null;
    if (entry == null) return undefined;
    const result = String(entry);
    if (!/^[a-f0-9]{40,64}$/.test(result)) {
      throw new SingularityFlowError(`WMB v4 publication recovery ${label} is invalid.`, {
        code: 'WMB_PUBLICATION_RECOVERY_INVALID'
      });
    }
    return result;
  };
  const guardedRemoteRefs = {};
  const guardedEntries = Object.entries(value.guardedRemoteRefs ?? {});
  if (guardedEntries.length > 64) {
    throw new SingularityFlowError('WMB v4 publication recovery contains too many guarded refs.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  for (const [ref, commit] of guardedEntries) {
    if (ref.length > 512 || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
        || ref.includes('..')) {
      throw new SingularityFlowError('WMB v4 publication recovery contains an unsafe guarded ref.', {
        code: 'WMB_PUBLICATION_RECOVERY_INVALID'
      });
    }
    guardedRemoteRefs[ref] = digest(commit, `guarded commit for ${ref}`);
  }
  const remoteEndpointSha256 = value.remoteEndpointSha256 == null
    ? null
    : String(value.remoteEndpointSha256);
  if (remoteEndpointSha256 !== null && !/^sha256:[a-f0-9]{64}$/.test(remoteEndpointSha256)) {
    throw new SingularityFlowError('WMB v4 publication recovery endpoint identity is invalid.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  return Object.freeze({
    message,
    ...(Object.hasOwn(value, 'expectedRemoteSha')
      ? { expectedRemoteSha: digest(value.expectedRemoteSha, 'expected remote SHA', { nullable: true }) }
      : {}),
    ...(value.baseRef != null ? { baseRef: digest(value.baseRef, 'publication base') } : {}),
    remoteEndpointSha256,
    refreshRemote: value.refreshRemote !== false,
    guardedRemoteRefs: Object.freeze(guardedRemoteRefs)
  });
}

function exactBuildIdentity(publication) {
  const outputDir = publication.outputDir;
  const parse = (relative) => JSON.parse(publication.files[path.posix.join(outputDir, relative)]);
  const request = parse('requests/build-request.json');
  const plan = parse('plans/build-plan.json');
  if (plan.requestSha256 !== request.requestSha256) {
    throw new SingularityFlowError('WMB v4 recovery projection has mismatched request and Plan identities.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  return Object.freeze({ requestSha256: request.requestSha256, planSha256: plan.planSha256 });
}

function recoveryId({
  createdAt, requestSha256, planSha256, manifestSha256, projectionSha256, ledger,
  publicationOptions
}) {
  return `wmb4-${sha256({
    createdAt, requestSha256, planSha256, manifestSha256, projectionSha256, ledger,
    publicationOptions
  }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function recoveryEnvelope(publication, ledgerConfig, {
  createdAt = new Date().toISOString(), publicationOptions = {}
} = {}) {
  const exactCreatedAt = canonicalTimestamp(createdAt);
  const verified = validateStagedWorldModelPublication(publication);
  const identity = exactBuildIdentity(verified);
  const projectionSha256 = sha256({
    outputDir: verified.outputDir,
    manifestPath: verified.manifestPath,
    replaceRoots: verified.replaceRoots,
    files: verified.files
  });
  const ledger = canonicalLedgerConfig(ledgerConfig);
  const exactPublicationOptions = canonicalPublicationOptions(publicationOptions);
  const id = recoveryId({
    createdAt: exactCreatedAt,
    ...identity,
    manifestSha256: verified.manifest.manifestSha256,
    projectionSha256,
    ledger,
    publicationOptions: exactPublicationOptions
  });
  return sealRecord({
    schemaVersion: currentSchemaVersion(FAMILY),
    kind: KIND,
    id,
    createdAt: exactCreatedAt,
    requestSha256: identity.requestSha256,
    planSha256: identity.planSha256,
    manifestSha256: verified.manifest.manifestSha256,
    projectionSha256,
    ledger,
    publicationOptions: exactPublicationOptions,
    publication: verified
  }, 'recoverySha256');
}

function validateRecoveryEnvelope(value) {
  const record = readRecord(FAMILY, value).record;
  if (record.kind !== KIND || !RECOVERY_ID.test(record.id)) {
    throw new SingularityFlowError('WMB v4 publication recovery marker is malformed.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  canonicalTimestamp(record.createdAt);
  const withoutHash = { ...record };
  delete withoutHash.recoverySha256;
  const resealed = sealRecord(withoutHash, 'recoverySha256');
  if (canonicalJson(resealed) !== canonicalJson(record)) {
    throw new SingularityFlowError('WMB v4 publication recovery marker failed its integrity check.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  const ledger = canonicalLedgerConfig(record.ledger);
  const publicationOptions = canonicalPublicationOptions(record.publicationOptions);
  if (canonicalJson(ledger) !== canonicalJson(record.ledger)
      || canonicalJson(publicationOptions) !== canonicalJson(record.publicationOptions)) {
    throw new SingularityFlowError('WMB v4 publication recovery marker has non-canonical publication authority.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  const publication = validateStagedWorldModelPublication(record.publication);
  const identity = exactBuildIdentity(publication);
  const projectionSha256 = sha256({
    outputDir: publication.outputDir,
    manifestPath: publication.manifestPath,
    replaceRoots: publication.replaceRoots,
    files: publication.files
  });
  if (record.requestSha256 !== identity.requestSha256
      || record.planSha256 !== identity.planSha256
      || record.manifestSha256 !== publication.manifest.manifestSha256
      || record.projectionSha256 !== projectionSha256) {
    throw new SingularityFlowError('WMB v4 publication recovery marker does not bind its exact projection.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  const expectedId = recoveryId({
    createdAt: record.createdAt,
    requestSha256: record.requestSha256,
    planSha256: record.planSha256,
    manifestSha256: record.manifestSha256,
    projectionSha256: record.projectionSha256,
    ledger,
    publicationOptions
  });
  if (record.id !== expectedId) {
    throw new SingularityFlowError('WMB v4 publication recovery identity does not match its authority.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  return Object.freeze({ ...record, ledger, publicationOptions, publication });
}

/**
 * Persist the complete verified projection before its state-branch CAS begins.
 *
 * The marker is immutable and content-addressed. It is therefore safe to create before publication,
 * and an interrupted retry can publish the same verified bytes without rebuilding any view.
 */
export async function prepareWorldModelPublicationRecovery(root, ledgerConfig, publication, options = {}) {
  const endpoint = stateBranchPublicationTargetIdentity(root, ledgerConfig);
  const record = validateRecoveryEnvelope(recoveryEnvelope(publication, ledgerConfig, {
    ...options,
    publicationOptions: {
      ...(options.publicationOptions ?? {}),
      remoteEndpointSha256: endpoint.effectiveUrlSha256
    }
  }));
  const target = recoveryPath(root, record.id);
  const bytes = Buffer.from(canonicalJson(record), 'utf8');
  await writeImmutablePrivateSidecar(root, target, bytes, { maximumBytes: MAXIMUM_RECOVERY_BYTES });
  return Object.freeze({ id: record.id, path: target, record });
}

async function readWorldModelPublicationRecovery(root, id) {
  const target = recoveryPath(root, id);
  const bytes = await readPrivateSidecar(root, target, {
    maximumBytes: MAXIMUM_RECOVERY_BYTES, optional: true
  });
  if (!bytes) {
    throw new SingularityFlowError(`WMB v4 publication recovery '${id}' does not exist.`, {
      code: 'WMB_PUBLICATION_RECOVERY_UNKNOWN'
    });
  }
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    throw new SingularityFlowError(`WMB v4 publication recovery '${id}' is not valid JSON.`, {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID', cause: error
    });
  }
  const record = validateRecoveryEnvelope(parsed);
  if (record.id !== id) {
    throw new SingularityFlowError('WMB v4 publication recovery filename does not match its identity.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  return Object.freeze({
    id: record.id,
    status: 'pending',
    createdAt: record.createdAt,
    requestSha256: record.requestSha256,
    planSha256: record.planSha256,
    manifestSha256: record.manifestSha256,
    projectionSha256: record.projectionSha256,
    ledger: record.ledger,
    publicationOptions: record.publicationOptions,
    record
  });
}

export async function inspectWorldModelPublicationRecovery(root, id) {
  const { record: _record, ...inspection } = await readWorldModelPublicationRecovery(root, id);
  return Object.freeze(inspection);
}

export async function listWorldModelPublicationRecoveries(root) {
  const entries = await listPrivateSidecar(root, recoveryRoot(root), { optional: true });
  const ids = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name.replace(/\.json$/, ''))
    .filter((id) => RECOVERY_ID.test(id)).sort();
  const recoveries = [];
  for (const id of ids.slice(0, 100)) {
    try { recoveries.push(await inspectWorldModelPublicationRecovery(root, id)); }
    catch (error) {
      recoveries.push(Object.freeze({
        id, status: 'invalid', createdAt: null, requestSha256: null, planSha256: null,
        manifestSha256: null, projectionSha256: null, ledger: null,
        error: Object.freeze({ code: error.code ?? 'WMB_PUBLICATION_RECOVERY_INVALID' })
      }));
    }
  }
  return Object.freeze({ recoveries: Object.freeze(recoveries), total: ids.length, truncated: ids.length > 100 });
}

export async function clearWorldModelPublicationRecovery(root, id) {
  await rm(recoveryPath(root, id), { force: true });
}

function remoteIsConfigured(root, remote, { env = process.env } = {}) {
  return git(root, ['remote', 'get-url', '--all', remote], { allowFailure: true, env }).status === 0;
}

function recoveryTransport(root, recovery, { env = process.env } = {}) {
  const endpoint = stateBranchPublicationTargetIdentity(root, recovery.ledger);
  const expected = recovery.publicationOptions.remoteEndpointSha256;
  if (endpoint.effectiveUrlSha256 !== expected) {
    throw new SingularityFlowError(
      'The state publication endpoint changed after the WMB v4 recovery marker was retained.',
      {
        code: 'WMB_PUBLICATION_RECOVERY_ENDPOINT_CHANGED',
        details: {
          expectedEndpointSha256: expected,
          observedEndpointSha256: endpoint.effectiveUrlSha256
        }
      }
    );
  }
  return endpoint.effectiveUrl ? frozenRemoteTransport(endpoint.effectiveUrl, { env }) : null;
}

function localCommit(root, ref, { env = process.env } = {}) {
  const observed = git(root, ['rev-parse', '--verify', `${ref}^{commit}`], {
    allowFailure: true, env
  });
  return observed.status === 0 && /^[a-f0-9]{40,64}$/i.test(observed.stdout.trim())
    ? observed.stdout.trim().toLowerCase() : null;
}

function advertisedCommit(root, remote, ref, { env = process.env } = {}) {
  const observed = git(root, ['ls-remote', '--heads', '--', remote, ref], {
    allowFailure: true, env
  });
  if (observed.status !== 0) {
    throw new SingularityFlowError(
      `Unable to observe the '${ref}' authority before WMB v4 recovery.`,
      { code: 'WMB_PUBLICATION_RECOVERY_OBSERVATION_UNAVAILABLE' }
    );
  }
  const rows = observed.stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (!rows.length) return null;
  if (rows.length !== 1) {
    throw new SingularityFlowError('The WMB v4 recovery remote returned an ambiguous state ref.', {
      code: 'WMB_PUBLICATION_RECOVERY_OBSERVATION_UNAVAILABLE'
    });
  }
  const match = rows[0].match(/^([a-f0-9]{40,64})\s+(refs\/heads\/[^\s]+)$/i);
  if (!match || match[2] !== ref) {
    throw new SingularityFlowError('The WMB v4 recovery remote returned a malformed state ref.', {
      code: 'WMB_PUBLICATION_RECOVERY_OBSERVATION_UNAVAILABLE'
    });
  }
  return match[1].toLowerCase();
}

function fetchObservedCommit(root, recovery, observedCommit, {
  env = process.env, transport = null
} = {}) {
  const ref = `refs/heads/${recovery.ledger.branch}`;
  const inspectionRef = `refs/singularity/recovery-observations/${recovery.id}`;
  git(root, ['update-ref', '-d', inspectionRef], { allowFailure: true, env });
  try {
    const fetched = git(root, [
      'fetch', '--no-tags', '--force', '--no-write-fetch-head',
      transport?.remote ?? recovery.ledger.remote,
      `${ref}:${inspectionRef}`
    ], { allowFailure: true, env: transport?.env ?? env });
    if (fetched.status !== 0) {
      throw new SingularityFlowError(
        'Unable to fetch the observed state commit before WMB v4 recovery.',
        { code: 'WMB_PUBLICATION_RECOVERY_OBSERVATION_UNAVAILABLE' }
      );
    }
    const fetchedCommit = localCommit(root, inspectionRef, { env });
    if (fetchedCommit !== observedCommit) {
      throw new SingularityFlowError(
        'The state branch changed while WMB v4 recovery was observing its exact remote tip.',
        {
          code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED',
          details: { observedCommit, fetchedCommit }
        }
      );
    }
    return fetchedCommit;
  } finally {
    git(root, ['update-ref', '-d', inspectionRef], { allowFailure: true, env });
  }
}

function commitParents(root, commit, { env = process.env } = {}) {
  const line = git(root, ['rev-list', '--parents', '-n', '1', commit], { env }).stdout.trim();
  const values = line.split(/\s+/).filter(Boolean).map((value) => value.toLowerCase());
  if (values[0] !== commit.toLowerCase()) {
    throw new SingularityFlowError('The observed WMB v4 recovery commit could not be inspected.', {
      code: 'WMB_PUBLICATION_RECOVERY_OBSERVATION_UNAVAILABLE'
    });
  }
  return values.slice(1);
}

function commitMessage(root, commit, { env = process.env } = {}) {
  return git(root, ['show', '-s', '--format=%B', commit], { env }).stdout.replace(/\r?\n+$/, '');
}

function commitHasExactProjection(root, commit, publication, { env = process.env } = {}) {
  const listed = git(root, [
    'ls-tree', '-r', '-z', '--name-only', commit, '--', publication.outputDir
  ], { env }).stdout.split('\0').filter(Boolean).sort();
  const expected = Object.keys(publication.files).sort();
  if (canonicalJson(listed) !== canonicalJson(expected)) return false;
  for (const target of expected) {
    const blob = git(root, ['show', `${commit}:${target}`], { allowFailure: true, env });
    if (blob.status !== 0 || blob.stdout !== publication.files[target]) return false;
  }
  return true;
}

function assertGuardedAuthority(root, recovery, {
  env = process.env, transport = null
} = {}) {
  if (!transport && !remoteIsConfigured(root, recovery.ledger.remote, { env })) return;
  for (const [ref, expected] of Object.entries(recovery.publicationOptions.guardedRemoteRefs)) {
    const observed = advertisedCommit(
      root, transport?.remote ?? recovery.ledger.remote, ref,
      { env: transport?.env ?? env }
    );
    if (observed !== expected) {
      throw new SingularityFlowError(
        `The source authority '${ref}' changed before WMB v4 publication recovery reconciled.`,
        {
          code: 'WMB_PUBLICATION_RECOVERY_SOURCE_AUTHORITY_CHANGED',
          details: { ref, expectedCommit: expected, observedCommit: observed }
        }
      );
    }
  }
}

/**
 * Determine whether the immutable projection already became the exact state authority.
 *
 * A successful `git push` can be followed by process termination, a post-push guard error, or a
 * local marker-cleanup failure. Replaying the marker's pre-push lease in those cases always fails
 * and, worse, cannot distinguish our landed commit from an unrelated advance. This observation
 * proves the current tip, complete replacement-root bytes, commit message and parent authority
 * before recovery calls the writer again. It never accepts an ancestor or a matching projection at
 * a later unrelated tip.
 */
function reconcileWorldModelPublicationRecovery(root, recovery, {
  env = process.env
} = {}) {
  const transport = recoveryTransport(root, recovery, { env });
  const remoteConfigured = transport !== null;
  const stateRef = `refs/heads/${recovery.ledger.branch}`;
  const observed = remoteConfigured
    ? advertisedCommit(root, transport.remote, stateRef, { env: transport.env })
    : localCommit(root, stateRef, { env });
  const expected = Object.hasOwn(recovery.publicationOptions, 'expectedRemoteSha')
    ? recovery.publicationOptions.expectedRemoteSha : recovery.publicationOptions.baseRef ?? null;

  if (observed === null) {
    if (expected !== null) {
      throw new SingularityFlowError('The state authority disappeared before WMB v4 recovery.', {
        code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED',
        details: { expectedCommit: expected, observedCommit: null }
      });
    }
    return Object.freeze({ status: 'not-landed', commit: null, changed: null });
  }
  if (remoteConfigured) fetchObservedCommit(root, recovery, observed, { env, transport });
  const projectionMatches = commitHasExactProjection(
    root, observed, recovery.publication, { env }
  );
  if (observed === expected) {
    if (!projectionMatches) {
      return Object.freeze({ status: 'not-landed', commit: observed, changed: null });
    }
    assertGuardedAuthority(root, recovery, { env, transport });
    if (remoteConfigured
        && advertisedCommit(root, transport.remote, stateRef, { env: transport.env }) !== observed) {
      throw new SingularityFlowError(
        'The state branch advanced while its exact WMB v4 projection was being reconciled.',
        { code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED' }
      );
    }
    return Object.freeze({ status: 'landed', commit: observed, changed: false });
  }
  if (!projectionMatches) {
    throw new SingularityFlowError(
      'The state branch advanced to an unrelated projection before WMB v4 recovery.',
      {
        code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED',
        details: { expectedCommit: expected, observedCommit: observed }
      }
    );
  }

  const parents = commitParents(root, observed, { env });
  const expectedParent = recovery.publicationOptions.baseRef ?? expected;
  const exactParent = expectedParent
    ? parents.length === 1 && parents[0] === expectedParent
    : parents.length === 1 && commitParents(root, parents[0], { env }).length === 0;
  if (!exactParent || commitMessage(root, observed, { env }) !== recovery.publicationOptions.message) {
    throw new SingularityFlowError(
      'The state branch contains the same files but not the exact WMB v4 candidate commit.',
      {
        code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED',
        details: { expectedCommit: expected, observedCommit: observed }
      }
    );
  }
  assertGuardedAuthority(root, recovery, { env, transport });
  if (remoteConfigured
      && advertisedCommit(root, transport.remote, stateRef, { env: transport.env }) !== observed) {
    throw new SingularityFlowError(
      'The state branch advanced while its exact WMB v4 candidate was being reconciled.',
      { code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED' }
    );
  }
  return Object.freeze({ status: 'landed', commit: observed, changed: true });
}

/** Resume one exact staged publication. No extraction, composition, model call, or cache rewrite occurs. */
export async function resumeWorldModelPublication(root, id, {
  confirm,
  publicationOptions = {}
} = {}) {
  if (confirm !== id) {
    throw new SingularityFlowError(
      `Publishing retained WMB v4 projection '${id}' requires --confirm ${id}.`,
      { code: 'WMB_PUBLICATION_RECOVERY_CONFIRMATION_REQUIRED' }
    );
  }
  const inspected = await readWorldModelPublicationRecovery(root, id);
  try {
    // Tests and embedded hosts may replace only the transport process/environment. The exact
    // reviewed CAS base, guarded refs and commit message always come from the immutable marker.
    const runtimeOverrides = {};
    if (typeof publicationOptions.publisher === 'function') runtimeOverrides.publisher = publicationOptions.publisher;
    if (publicationOptions.env && typeof publicationOptions.env === 'object') runtimeOverrides.env = publicationOptions.env;
    const endpoint = stateBranchPublicationTargetIdentity(root, inspected.record.ledger);
    if (endpoint.effectiveUrlSha256 !== inspected.record.publicationOptions.remoteEndpointSha256) {
      throw new SingularityFlowError(
        'The state publication endpoint changed after the WMB v4 recovery marker was retained.',
        { code: 'WMB_PUBLICATION_RECOVERY_ENDPOINT_CHANGED' }
      );
    }
    if (endpoint.effectiveUrl) runtimeOverrides.transportRemote = endpoint.effectiveUrl;
    const reconciled = reconcileWorldModelPublicationRecovery(root, inspected.record, {
      env: runtimeOverrides.env ?? process.env
    });
    if (reconciled.status === 'landed') {
      await clearWorldModelPublicationRecovery(root, id);
      return Object.freeze({
        recovery: id,
        status: 'published',
        reconciled: true,
        providerInvoked: false,
        cacheChanged: false,
        requestSha256: inspected.requestSha256,
        planSha256: inspected.planSha256,
        manifestSha256: inspected.manifestSha256,
        publication: Object.freeze({
          branch: inspected.record.ledger.branch,
          commit: reconciled.commit,
          changed: reconciled.changed,
          published: Object.freeze([]),
          removed: Object.freeze([]),
          manifestSha256: inspected.manifestSha256,
          manifestPath: inspected.record.publication.manifestPath
        })
      });
    }
    const publication = await publishWorldModelTransaction(
      root, inspected.record.ledger, inspected.record.publication,
      { ...inspected.record.publicationOptions, ...runtimeOverrides }
    );
    await clearWorldModelPublicationRecovery(root, id);
    return Object.freeze({
      recovery: id,
      status: 'published',
      reconciled: false,
      providerInvoked: false,
      cacheChanged: false,
      requestSha256: inspected.requestSha256,
      planSha256: inspected.planSha256,
      manifestSha256: inspected.manifestSha256,
      publication
    });
  } catch (error) {
    throw new SingularityFlowError(
      `WMB v4 publication recovery '${id}' remains retained because publication failed: ${error.message}`,
      {
        code: 'WMB_PUBLICATION_RECOVERY_REQUIRED',
        details: {
          recoveryId: id,
          recoveryCommand: `singularity-flow wm recovery publish ${id} --confirm ${id}`,
          causeCode: error.code ?? null
        },
        cause: error
      }
    );
  }
}
