import path from 'node:path';
import { rm } from 'node:fs/promises';

import { gitCommonDir } from '../git.mjs';
import { runRemoteGitAsync } from '../git-execution.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import {
  canonicalJson as canonicalLedgerJson, stateBranchPublicationTargetIdentity
} from '../ledger.mjs';
import { frozenRemoteTransport } from '../git-remote-diagnostics.mjs';
import {
  listPrivateSidecar, readPrivateSidecar, writeImmutablePrivateSidecar
} from '../private-sidecar.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError, run } from '../util.mjs';
import { canonicalJson, sealRecord, sha256 } from './canonicalize.mjs';
import { WMP_MAXIMUM_OBJECT_BYTES } from './history/identity.mjs';
import {
  publishMigratedV1WorldModelRecoveryTransaction, publishWorldModelTransaction,
  validateMigratedV1StagedWorldModelPublication, validateStagedWorldModelPublication
} from './publish/transaction.mjs';

const FAMILY = 'world-model-publication-recovery';
const KIND = 'world-model-publication-recovery';
const MAXIMUM_RECOVERY_BYTES = 128 * 1024 * 1024;
const RECOVERY_ID = /^wmb4-[a-f0-9]{32}$/;
const INITIAL_LEDGER_README = '# Singularity Flow Capability Ledger\n\n'
  + 'This orphan branch is an append-only workflow ledger. It has no shared ancestry with application branches and must never be merged into them.\n';

function git(root, args, {
  allowFailure = false, env = process.env, encoding = 'utf8', maxBuffer = undefined
} = {}) {
  return run('git', args, {
    cwd: root, allowFailure, env, encoding,
    ...(maxBuffer === undefined ? {} : { maxBuffer })
  });
}

function remoteGit(root, args, { allowFailure = false, env = process.env } = {}) {
  return runRemoteGitAsync(args, {
    cwd: root,
    operation: args[0] === 'ls-remote' ? 'remote-probe' : 'remote-configuration',
    allowFailure,
    env
  });
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

/**
 * Bind the additive history envelope independently of the replaceable current projection.
 *
 * A recovery marker predating persisted history legitimately has no history fields. Once any
 * history field is present, validateStagedWorldModelPublication has already proved that all four
 * fields are present, canonical, and describe the same exact UTF-8 bytes.
 */
function exactHistorySha256(publication) {
  if (!publication.historyAdditions) return null;
  return sha256({
    historyDir: publication.historyDir,
    historyAdditions: publication.historyAdditions,
    historyExpectations: publication.historyExpectations,
    exactBlobSha256: publication.exactBlobSha256
  });
}

function recoveryId({
  createdAt, requestSha256, planSha256, manifestSha256, projectionSha256, historySha256,
  ledger, publicationOptions
}) {
  const identity = {
    createdAt, requestSha256, planSha256, manifestSha256, projectionSha256,
    ...(historySha256 === null ? {} : { historySha256 }),
    ledger, publicationOptions
  };
  return `wmb4-${sha256(identity).slice('sha256:'.length, 'sha256:'.length + 32)}`;
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
  const historySha256 = exactHistorySha256(verified);
  const ledger = canonicalLedgerConfig(ledgerConfig);
  const exactPublicationOptions = canonicalPublicationOptions(publicationOptions);
  const id = recoveryId({
    createdAt: exactCreatedAt,
    ...identity,
    manifestSha256: verified.manifest.manifestSha256,
    projectionSha256,
    historySha256,
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
    historySha256,
    ledger,
    publicationOptions: exactPublicationOptions,
    publication: verified
  }, 'recoverySha256');
}

function validateRecoveryEnvelope(value) {
  const migrated = readRecord(FAMILY, value);
  const record = migrated.record;
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
  let publication;
  try {
    publication = migrated.storedVersion === 1
      ? validateMigratedV1StagedWorldModelPublication(record.publication)
      : validateStagedWorldModelPublication(record.publication);
  } catch (error) {
    throw new SingularityFlowError(
      'WMB v4 publication recovery marker does not bind its exact projection and history.',
      {
        code: 'WMB_PUBLICATION_RECOVERY_INVALID',
        details: { causeCode: error?.code ?? null },
        cause: error
      }
    );
  }
  const identity = exactBuildIdentity(publication);
  const projectionSha256 = sha256({
    outputDir: publication.outputDir,
    manifestPath: publication.manifestPath,
    replaceRoots: publication.replaceRoots,
    files: publication.files
  });
  const historySha256 = exactHistorySha256(publication);
  if (record.requestSha256 !== identity.requestSha256
      || record.planSha256 !== identity.planSha256
      || record.manifestSha256 !== publication.manifest.manifestSha256
      || record.projectionSha256 !== projectionSha256
      || record.historySha256 !== historySha256) {
    throw new SingularityFlowError('WMB v4 publication recovery marker does not bind its exact projection and history.', {
      code: 'WMB_PUBLICATION_RECOVERY_INVALID'
    });
  }
  const expectedId = recoveryId({
    createdAt: record.createdAt,
    requestSha256: record.requestSha256,
    planSha256: record.planSha256,
    manifestSha256: record.manifestSha256,
    projectionSha256: record.projectionSha256,
    historySha256: record.historySha256,
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
  const reviewedEndpointSha256 = options.publicationOptions?.remoteEndpointSha256 ?? null;
  if (reviewedEndpointSha256 !== null
      && reviewedEndpointSha256 !== endpoint.effectiveUrlSha256) {
    throw new SingularityFlowError(
      'The registered world-model publication endpoint changed before recovery was prepared.',
      {
        code: 'WMB_GATEWAY_PLAN_DRIFTED',
        details: {
          expectedEndpointSha256: reviewedEndpointSha256,
          currentEndpointSha256: endpoint.effectiveUrlSha256
        }
      }
    );
  }
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
  const storedVersion = parsed?.schemaVersion;
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
    historySha256: record.historySha256,
    storedVersion,
    ledger: record.ledger,
    publicationOptions: record.publicationOptions,
    record
  });
}

export async function inspectWorldModelPublicationRecovery(root, id) {
  const {
    record: _record, storedVersion: _storedVersion, ...inspection
  } = await readWorldModelPublicationRecovery(root, id);
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
        manifestSha256: null, projectionSha256: null, historySha256: null, ledger: null,
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

async function advertisedCommit(root, remote, ref, { env = process.env } = {}) {
  const observed = await remoteGit(root, ['ls-remote', '--heads', '--', remote, ref], {
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

async function fetchObservedCommit(root, recovery, observedCommit, {
  env = process.env, transport = null
} = {}) {
  const ref = `refs/heads/${recovery.ledger.branch}`;
  const inspectionRef = `refs/singularity/recovery-observations/${recovery.id}`;
  git(root, ['update-ref', '-d', inspectionRef], { allowFailure: true, env });
  try {
    const fetched = await remoteGit(root, [
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

function commitHasExactProjection(root, commit, publication, { env = process.env } = {}) {
  const listed = git(root, [
    'ls-tree', '-r', '-z', '--name-only', commit, '--', publication.outputDir
  ], { env }).stdout.split('\0').filter(Boolean).sort();
  const expected = Object.keys(publication.files).sort();
  if (canonicalJson(listed) !== canonicalJson(expected)) return false;
  for (const target of expected) {
    const expectedBytes = Buffer.from(publication.files[target], 'utf8');
    const blob = exactRegularTreeBlob(root, commit, target, {
      env, expectedBytes: expectedBytes.length, maximumBytes: expectedBytes.length
    });
    if (!blob || !blob.equals(expectedBytes)) return false;
  }
  return true;
}

function commitHasExactHistory(root, commit, publication, { env = process.env } = {}) {
  if (!publication.historyAdditions) return true;
  for (const target of Object.keys(publication.historyAdditions).sort()) {
    const listed = git(root, ['ls-tree', '-z', commit, '--', target], {
      allowFailure: true, env
    });
    const rows = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
    if (rows.length !== 1) return false;
    const separator = rows[0].indexOf('\t');
    const [mode, type, oid] = separator < 0
      ? [] : rows[0].slice(0, separator).split(/\s+/);
    if (rows[0].slice(separator + 1) !== target
        || mode !== publication.historyExpectations[target].gitMode
        || type !== 'blob'
        || !/^[a-f0-9]{40,64}$/i.test(oid ?? '')) return false;
    const expected = publication.historyExpectations[target];
    const blob = git(root, ['cat-file', 'blob', oid], {
      allowFailure: true, env, encoding: 'buffer', maxBuffer: expected.bytes + 1024
    });
    const bytes = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.alloc(0);
    if (blob.status !== 0
        || bytes.length !== expected.bytes
        || sha256(bytes) !== expected.sha256
        || sha256(bytes) !== publication.exactBlobSha256[target]
        || !bytes.equals(Buffer.from(publication.historyAdditions[target], 'utf8'))) return false;
  }
  return true;
}

function commitParents(root, commit, { env = process.env } = {}) {
  const line = git(root, ['rev-list', '--parents', '-n', '1', commit], {
    allowFailure: true, env
  });
  if (line.status !== 0) return null;
  const values = line.stdout.trim().split(/\s+/).filter(Boolean)
    .map((value) => value.toLowerCase());
  return values[0] === commit.toLowerCase() ? values.slice(1) : null;
}

function recognizedInitialLedgerRoot(root, commit, { env = process.env } = {}) {
  const parents = commitParents(root, commit, { env });
  if (!parents || parents.length !== 0) return false;
  const paths = git(root, ['ls-tree', '-r', '-z', '--name-only', commit], {
    allowFailure: true, env
  });
  if (paths.status !== 0 || canonicalJson(paths.stdout.split('\0').filter(Boolean).sort())
      !== canonicalJson(['README.md', 'ledger/head.json'])) return false;
  const readme = exactRegularTreeBlob(root, commit, 'README.md', {
    env,
    expectedBytes: Buffer.byteLength(INITIAL_LEDGER_README, 'utf8'),
    maximumBytes: Buffer.byteLength(INITIAL_LEDGER_README, 'utf8')
  });
  const head = exactRegularTreeBlob(root, commit, 'ledger/head.json', {
    env, maximumBytes: 64 * 1024
  });
  if (!readme || readme.toString('utf8') !== INITIAL_LEDGER_README || !head) {
    return false;
  }
  try {
    const headText = head.toString('utf8');
    const parsed = JSON.parse(headText);
    const migrated = readRecord('ledger-entry', parsed).record;
    canonicalTimestamp(migrated.updatedAt);
    return headText === canonicalLedgerJson({
      schemaVersion: currentSchemaVersion('ledger-entry'),
      sequence: 0,
      previousHeadHash: null,
      entryHash: null,
      updatedAt: migrated.updatedAt
    });
  } catch {
    return false;
  }
}

function exactTreeEntry(root, commit, target, { env = process.env } = {}) {
  const listed = git(root, ['ls-tree', '-z', commit, '--', target], {
    allowFailure: true, env
  });
  const rows = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
  if (rows.length !== 1) return null;
  const separator = rows[0].indexOf('\t');
  if (separator < 0 || rows[0].slice(separator + 1) !== target) return null;
  const [mode, type, oid] = rows[0].slice(0, separator).split(/\s+/);
  return /^[a-f0-9]{40,64}$/i.test(oid ?? '')
    ? Object.freeze({ mode, type, oid: oid.toLowerCase() }) : null;
}

function exactRegularTreeBlob(root, commit, target, {
  env = process.env, expectedBytes = null, maximumBytes
} = {}) {
  const entry = exactTreeEntry(root, commit, target, { env });
  if (!entry || entry.mode !== '100644' || entry.type !== 'blob'
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return null;
  const sized = git(root, ['cat-file', '-s', entry.oid], { allowFailure: true, env });
  const size = sized.status === 0 ? Number(sized.stdout.trim()) : NaN;
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes
      || (expectedBytes !== null && size !== expectedBytes)) return null;
  const shown = git(root, ['cat-file', 'blob', entry.oid], {
    allowFailure: true, env, encoding: 'buffer', maxBuffer: size + 1024
  });
  const bytes = Buffer.isBuffer(shown.stdout) ? shown.stdout : Buffer.alloc(0);
  return shown.status === 0 && bytes.length === size ? bytes : null;
}

function additionalContentAddressedHistoryObject(target, historyDir) {
  if (!historyDir || !target.startsWith(`${historyDir}/`)) return false;
  const relative = target.slice(historyDir.length + 1);
  const object = relative.match(/^objects\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/);
  return object !== null && object[2].startsWith(object[1]);
}

function validAdditionalHistoryBlob(root, commit, target, historyDir, {
  env = process.env
} = {}) {
  // A content-addressed object is inert: its path proves its exact bytes without changing which
  // model, view, or handoff a reader resolves. A keyed record is authority-bearing. Accepting a
  // concurrently added keyed record merely because it is canonical does not prove its CAS copy,
  // complete retained-object closure, or semantic binding. Until that whole graph is verified as
  // one unit, fail closed and let the caller retry against the newly reviewed authority tip.
  if (!additionalContentAddressedHistoryObject(target, historyDir)) return false;
  const entry = exactTreeEntry(root, commit, target, { env });
  if (!entry || entry.mode !== '100644' || entry.type !== 'blob') return false;
  const sized = git(root, ['cat-file', '-s', entry.oid], { allowFailure: true, env });
  const size = sized.status === 0 ? Number(sized.stdout.trim()) : NaN;
  if (!Number.isSafeInteger(size) || size < 1 || size > WMP_MAXIMUM_OBJECT_BYTES) return false;
  const shown = git(root, ['cat-file', 'blob', entry.oid], {
    allowFailure: true, env, encoding: 'buffer', maxBuffer: size + 1024
  });
  const bytes = Buffer.isBuffer(shown.stdout) ? shown.stdout : Buffer.alloc(0);
  if (shown.status !== 0 || bytes.length !== size) return false;
  const relative = target.slice(historyDir.length + 1);
  const object = relative.match(/^objects\/sha256\/[a-f0-9]{2}\/([a-f0-9]{64})$/);
  return object !== null && sha256(bytes) === `sha256:${object[1]}`;
}

function recoveryComparisonBase(root, observed, expected, recovery, { env = process.env } = {}) {
  const retained = recovery.publicationOptions.baseRef ?? expected;
  if (retained !== null) {
    if (localCommit(root, retained, { env }) !== retained) return null;
    const ancestor = git(root, ['merge-base', '--is-ancestor', retained, observed], {
      allowFailure: true, env
    });
    return ancestor.status === 0 ? retained : null;
  }
  const roots = git(root, ['rev-list', '--max-parents=0', observed], {
    allowFailure: true, env
  });
  const candidates = roots.status === 0
    ? roots.stdout.split(/\r?\n/).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    : [];
  return candidates.length === 1 && recognizedInitialLedgerRoot(root, candidates[0], { env })
    ? candidates[0] : null;
}

function commitChangesOnlyPublicationScope(root, observed, expected, recovery, {
  env = process.env
} = {}) {
  const base = recoveryComparisonBase(root, observed, expected, recovery, { env });
  if (!base) return false;
  const changed = git(root, [
    'diff', '--no-renames', '--name-only', '-z', base, observed, '--'
  ], { allowFailure: true, env });
  if (changed.status !== 0) return false;
  const outputDir = recovery.publication.outputDir;
  const additions = recovery.publication.historyAdditions ?? {};
  const historyDir = recovery.publication.historyDir ?? null;
  for (const target of changed.stdout.split('\0').filter(Boolean)) {
    if (target.startsWith(`${outputDir}/`)) continue;
    if (Object.hasOwn(additions, target)) {
      const before = exactTreeEntry(root, base, target, { env });
      if (!before) continue;
      const expectedHistory = recovery.publication.historyExpectations[target];
      const blob = git(root, ['cat-file', 'blob', before.oid], {
        allowFailure: true, env, encoding: 'buffer', maxBuffer: expectedHistory.bytes + 1024
      });
      const bytes = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.alloc(0);
      if (before.mode !== expectedHistory.gitMode || before.type !== 'blob'
          || blob.status !== 0 || bytes.length !== expectedHistory.bytes
          || sha256(bytes) !== expectedHistory.sha256) return false;
      continue;
    }
    if (exactTreeEntry(root, base, target, { env }) !== null
        || !validAdditionalHistoryBlob(root, observed, target, historyDir, { env })) return false;
  }
  return true;
}

async function assertGuardedAuthority(root, recovery, {
  env = process.env, transport = null
} = {}) {
  if (!transport && !remoteIsConfigured(root, recovery.ledger.remote, { env })) return;
  for (const [ref, expected] of Object.entries(recovery.publicationOptions.guardedRemoteRefs)) {
    const observed = await advertisedCommit(
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
 * proves the current tip, complete replacement-root bytes, and every immutable history addition
 * before recovery calls the writer again. A concurrent writer that landed byte-identical output is
 * a valid winner even when it used a different parent or message: content and guarded authority,
 * rather than candidate-commit identity, are the durable publication contract.
 */
async function reconcileWorldModelPublicationRecovery(root, recovery, {
  env = process.env
} = {}) {
  const transport = recoveryTransport(root, recovery, { env });
  const remoteConfigured = transport !== null;
  const stateRef = `refs/heads/${recovery.ledger.branch}`;
  const observed = remoteConfigured
    ? await advertisedCommit(root, transport.remote, stateRef, { env: transport.env })
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
  if (remoteConfigured) await fetchObservedCommit(root, recovery, observed, { env, transport });
  const projectionMatches = commitHasExactProjection(
    root, observed, recovery.publication, { env }
  );
  const historyMatches = commitHasExactHistory(
    root, observed, recovery.publication, { env }
  );
  const exactBytesMatch = projectionMatches && historyMatches;
  // The generic state writer initializes an absent state branch before it creates the WMP
  // projection commit. A crash or second-push failure in that narrow interval leaves only this
  // exact two-file orphan root. It is not an unrelated concurrent publication: adopt it as the
  // retry CAS/base so the retained transaction can append its originally reviewed bytes. Never
  // extend this exception to a descendant or to a marker that already retained another base.
  if (expected === null
      && recovery.publicationOptions.baseRef == null
      && recognizedInitialLedgerRoot(root, observed, { env })) {
    return Object.freeze({
      status: 'not-landed', commit: observed, changed: null,
      retryPublicationBase: observed
    });
  }
  if (observed === expected) {
    if (!exactBytesMatch) {
      return Object.freeze({ status: 'not-landed', commit: observed, changed: null });
    }
    await assertGuardedAuthority(root, recovery, { env, transport });
    if (remoteConfigured
        && await advertisedCommit(root, transport.remote, stateRef, { env: transport.env }) !== observed) {
      throw new SingularityFlowError(
        'The state branch advanced while its exact WMB v4 projection was being reconciled.',
        { code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED' }
      );
    }
    return Object.freeze({ status: 'landed', commit: observed, changed: false });
  }
  if (!exactBytesMatch) {
    throw new SingularityFlowError(
      'The state branch advanced to an unrelated projection before WMB v4 recovery.',
      {
        code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED',
        details: { expectedCommit: expected, observedCommit: observed }
      }
    );
  }
  if (!commitChangesOnlyPublicationScope(root, observed, expected, recovery, { env })) {
    throw new SingularityFlowError(
      'The state branch winner also changed paths outside the exact WMB v4 publication scope.',
      {
        code: 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED',
        details: { expectedCommit: expected, observedCommit: observed }
      }
    );
  }

  await assertGuardedAuthority(root, recovery, { env, transport });
  if (remoteConfigured
      && await advertisedCommit(root, transport.remote, stateRef, { env: transport.env }) !== observed) {
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
    const reconciled = await reconcileWorldModelPublicationRecovery(root, inspected.record, {
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
    const publisher = inspected.storedVersion === 1
      ? publishMigratedV1WorldModelRecoveryTransaction
      : publishWorldModelTransaction;
    // This override exists only for the exact pristine root recognized above. The state writer
    // still performs its normal compare-and-swap against that observed commit, so any subsequent
    // advance remains a refusal. All other authority, endpoint, and payload fields stay bound to
    // the immutable recovery marker.
    const recoveredInitialization = reconciled.retryPublicationBase
      ? {
        expectedRemoteSha: reconciled.retryPublicationBase,
        baseRef: reconciled.retryPublicationBase,
        refreshRemote: false
      }
      : {};
    const publication = await publisher(
      root, inspected.record.ledger, inspected.record.publication,
      {
        ...inspected.record.publicationOptions,
        ...recoveredInitialization,
        ...runtimeOverrides
      }
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
