/** Repository-independent local deliverable lifecycle and offline audit. */
import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod, link, lstat, mkdir, open, readFile, realpath, rm, stat
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createLocalAuthorityTransportSigner, loadLocalAuthorityTransportSigner
} from '../sgos/authority-transport.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { VERSION } from '../version.mjs';
import {
  artifactRef, exactFields, LOC_AUDIT_PROFILE, LOC_BUNDLE_SCHEMA, LOC_LIMITS,
  LOC_PACKAGING_PROFILE, LOC_PAYLOAD_TYPE, LOC_REVIEW_PAYLOAD_TYPE,
  LOC_SIGNATURE_PROFILE, localSignerId, locDigest, locFail, locSha256,
  portablePath
} from './contracts.mjs';
import { inspectLocArchive, writeLocArchive } from './archive.mjs';
import { canonicalJcs, parseCanonicalJcs } from './jcs.mjs';
import { createDsseEnvelope, verifyDsseEnvelope } from './signatures.mjs';
import {
  listLocalStories, localRecord, lockedStory, openLocalStory, writeLocalState
} from './store.mjs';

const EXPORT_ROOT_ENV = 'SINGULARITY_FLOW_LOCAL_EXPORT_ROOT';
const RECORD_PATH = /^records\/([a-f0-9]{64})\.json$/;

async function readDurableRecord(paths, relative, family) {
  const match = RECORD_PATH.exec(String(relative ?? ''));
  if (!match) locFail('Local Story contains an invalid record reference.', 'LOCAL_STATE_INVALID');
  const bytes = await readFile(path.join(paths.ledger, relative));
  if (locSha256(bytes) !== `sha256:${match[1]}`) {
    locFail('Local Story record bytes no longer match their address.', 'LOCAL_STATE_INVALID');
  }
  const parsed = parseCanonicalJcs(bytes);
  const migrated = readRecord(family, parsed).record;
  if (migrated.kind !== family) {
    locFail(`Local Story record '${relative}' is not ${family}.`, 'LOCAL_STATE_INVALID');
  }
  return Object.freeze({ record: migrated, bytes, sha256: locSha256(bytes), path: relative });
}

async function referenceForLedgerPath(paths, relative) {
  const bytes = await readFile(path.join(paths.ledger, relative));
  const sha256 = locSha256(bytes);
  if (relative !== `records/${sha256.slice(7)}.json`) {
    locFail('Content-addressed record path does not match its bytes.', 'LOCAL_STATE_INVALID');
  }
  return Object.freeze({ path: relative, sha256, sizeBytes: bytes.length });
}

async function writeExclusive(target, bytes, mode = 0o600) {
  const handle = await open(target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0), mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error?.code)) {
      throw error;
    }
  } finally { await handle?.close().catch(() => {}); }
}

export async function createLocalSigner(storyId, signerId, options = {}) {
  const id = localSignerId(signerId);
  return lockedStory(storyId, options, async (paths) => {
    const result = await createLocalAuthorityTransportSigner(paths.ledger, id);
    return Object.freeze({
      storyId: paths.id,
      signerId: result.keyId,
      created: result.created,
      algorithm: result.algorithm,
      publicKeySha256: result.publicKeySha256,
      trustScope: 'standalone'
    });
  });
}

export async function exportLocalTrustKey(storyId, signerId, target, options = {}) {
  const id = localSignerId(signerId);
  if (!path.isAbsolute(String(target ?? ''))) {
    locFail('Trust-key output must be an explicit absolute path.', 'LOCAL_PATH_INVALID');
  }
  return lockedStory(storyId, options, async (paths) => {
    const signer = await loadLocalAuthorityTransportSigner(paths.ledger, id);
    const targetFile = path.resolve(target);
    const expected = Buffer.from(signer.publicKeyPem);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let created = true;
    try {
      await writeExclusive(targetFile, expected, 0o644);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readStableRegularFile(targetFile, 64 * 1024,
        'Trust-key output');
      if (!existing.equals(expected)) {
        locFail('Trust-key output already contains different bytes.',
          'EXPORT_DESTINATION_EXISTS');
      }
      created = false;
    }
    await syncDirectory(path.dirname(targetFile));
    return Object.freeze({
      storyId: paths.id,
      signerId: id,
      publicKeySha256: signer.publicKeySha256,
      trustKey: targetFile,
      created,
      idempotent: !created
    });
  });
}

export async function reviewLocalCandidate(storyId, candidateDigest, signerId, options = {}) {
  locDigest(candidateDigest, 'candidate digest');
  const id = localSignerId(signerId);
  return lockedStory(storyId, options, async (paths, state) => {
    if (state.roots.candidateDigest !== candidateDigest
        || state.verification?.status !== 'passed') {
      locFail('Only the exact currently verified candidate can be reviewed.',
        'REVIEW_SUBJECT_MISMATCH');
    }
    if (state.review) {
      if (state.review.candidateDigest === candidateDigest
          && state.review.signerId === id) {
        return Object.freeze({
          storyId: state.storyId,
          status: state.status,
          candidateDigest,
          reviewSubjectDigest: state.roots.reviewSubjectDigest,
          approvalsRoot: state.roots.approvalsRoot,
          signerId: id,
          idempotent: true
        });
      }
      locFail('The candidate already has a different exact review. Freeze a new generation to change it.',
        'REVIEW_ALREADY_RECORDED');
    }
    const signer = await loadLocalAuthorityTransportSigner(paths.ledger, id);
    const reviewedAt = new Date().toISOString();
    const reviewAuthority = await localRecord(paths, 'local-review-authority', {
      authorityDomainId: state.authorityDomainId,
      trustScope: state.trustScope,
      policyRoot: state.roots.policyRoot,
      role: 'local-output-owner',
      eligibleSigner: {
        keyId: id,
        keySha256: signer.publicKeySha256,
        algorithm: 'ed25519'
      },
      capturedAt: reviewedAt
    });
    const subject = await localRecord(paths, 'local-review-subject', {
      storyId: state.storyId,
      generationId: state.generationId,
      candidateDigest,
      claimsRoot: state.roots.claimsRoot,
      evidenceRoot: state.roots.evidenceRoot,
      policyRoot: state.roots.policyRoot,
      workflowRoot: state.roots.workflowRoot,
      classificationRoot: state.roots.classificationRoot,
      disclosurePlanRoot: state.roots.disclosurePlanRoot,
      reviewAuthorityRoot: reviewAuthority.sha256,
      releaseProfile: LOC_PACKAGING_PROFILE
    });
    const decision = await localRecord(paths, 'local-review-decision', {
      reviewSubjectDigest: subject.sha256,
      decision: 'approved',
      role: 'local-output-owner',
      signerId: id,
      keySha256: signer.publicKeySha256,
      decidedAt: reviewedAt
    });
    const signed = createDsseEnvelope(decision.record
      ? Buffer.from(canonicalJcs(decision.record)) : await readFile(decision.absolute),
    LOC_REVIEW_PAYLOAD_TYPE, signer);
    const envelope = await localRecord(paths, 'local-review-envelope', {
      decisionDigest: decision.sha256,
      payloadType: LOC_REVIEW_PAYLOAD_TYPE,
      envelope: signed.envelope
    });
    const approvals = await localRecord(paths, 'local-approval-index', {
      reviewSubjectDigest: subject.sha256,
      quorum: 1,
      statements: [{
        decisionDigest: decision.sha256,
        envelopeDigest: envelope.sha256,
        signerId: id,
        keySha256: signer.publicKeySha256
      }],
      eligibility: 'approved'
    });
    const next = {
      ...state,
      revision: state.revision + 1,
      status: 'reviewed',
      updatedAt: reviewedAt,
      records: {
        ...state.records,
        reviewAuthority: reviewAuthority.path,
        reviewSubject: subject.path,
        reviewDecision: decision.path,
        reviewEnvelope: envelope.path,
        approvals: approvals.path
      },
      roots: {
        ...state.roots,
        reviewAuthorityRoot: reviewAuthority.sha256,
        reviewSubjectDigest: subject.sha256,
        approvalsRoot: approvals.sha256
      },
      review: {
        candidateDigest,
        signerId: id,
        keySha256: signer.publicKeySha256,
        reviewedAt,
        decision: 'approved'
      }
    };
    const written = await writeLocalState(paths, next,
      '[local-mode] approve exact candidate ' + candidateDigest.slice(0, 19));
    return Object.freeze({
      storyId: state.storyId,
      status: written.state.status,
      candidateDigest,
      reviewSubjectDigest: subject.sha256,
      approvalsRoot: approvals.sha256,
      signerId: id,
      ledgerCommit: written.commit,
      nextAction: 'singularity-flow local publish --story ' + state.storyId
        + ' --candidate ' + candidateDigest + ' --signer ' + id
        + ' --destination <APPROVED-LOCAL-DIRECTORY>'
    });
  });
}

export { listLocalStories, openLocalStory };

function inventorySort(values) {
  return [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function inventoryEntry(ref, role, mode = '0644') {
  return Object.freeze({
    ...artifactRef(ref), role, fileKind: 'regular', mode
  });
}

async function semanticInventory(paths, records) {
  const roleFor = (name) => {
    if (['policy', 'workflow', 'classification', 'disclosurePlan',
      'verificationPlan'].includes(name)) return 'policy';
    if (name === 'claims') return 'claim';
    if (['evidence', 'evidenceReceipt'].includes(name)) return 'evidence';
    if (['reviewSubject', 'reviewDecision', 'reviewEnvelope', 'approvals'].includes(name)) {
      return 'approval';
    }
    if (['reviewAuthority', 'actionAuthority'].includes(name)) return 'authority';
    if (name === 'intent') return 'spec';
    return 'metadata';
  };
  const result = [];
  for (const [name, relative] of Object.entries(records)) {
    const reference = await referenceForLedgerPath(paths, relative);
    result.push({ name, reference, inventory: inventoryEntry(reference, roleFor(name)) });
  }
  return result;
}

function contentEntries(paths, manifest, prefix, role) {
  return manifest.files.map((file) => {
    const bundlePath = portablePath(`${prefix}/${file.path}`);
    const reference = {
      path: bundlePath,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes
    };
    return Object.freeze({
      reference,
      inventory: inventoryEntry(reference, role, file.mode),
      archive: {
        path: bundlePath,
        mode: file.mode,
        source: path.join(paths.ledger, file.object)
      }
    });
  });
}

async function prepareBundle(paths, state, signerId) {
  if (!['reviewed', 'publishing'].includes(state.status)
      || state.review?.decision !== 'approved') {
    locFail('Local Story must have an exact approved review before publication.',
      'LOCAL_PHASE_INVALID');
  }
  if (state.review.signerId !== signerId) {
    locFail('Publication signer must equal the signer of the exact review.',
      'ACTION_AUTHORITY_MISMATCH');
  }
  const signer = await loadLocalAuthorityTransportSigner(paths.ledger, signerId);
  if (signer.publicKeySha256 !== state.review.keySha256) {
    locFail('Publication signer no longer matches the reviewed authority snapshot.',
      'ACTION_AUTHORITY_MISMATCH');
  }
  const inputs = await readDurableRecord(paths, state.records.inputs,
    'local-input-manifest');
  const outputs = await readDurableRecord(paths, state.records.outputs,
    'local-output-manifest');
  const actionAuthority = await localRecord(paths, 'local-action-authority', {
    storyId: state.storyId,
    generationId: state.generationId,
    candidateDigest: state.roots.candidateDigest,
    action: 'publish-local-bundle',
    authorityDomainId: state.authorityDomainId,
    trustScope: state.trustScope,
    signerId,
    keySha256: signer.publicKeySha256,
    reviewSubjectDigest: state.roots.reviewSubjectDigest,
    approvalsRoot: state.roots.approvalsRoot,
    policyRoot: state.roots.policyRoot,
    evaluatedAt: state.review.reviewedAt
  });
  const recordPaths = Object.fromEntries([
    'inputs', 'intent', 'workflow', 'policy', 'classification', 'disclosurePlan',
    'verificationPlan', 'outputs', 'candidate', 'claims', 'evidenceReceipt',
    'evidence', 'reviewAuthority', 'reviewSubject', 'reviewDecision',
    'reviewEnvelope', 'approvals'
  ].map((name) => [name, state.records[name]]));
  if (Object.values(recordPaths).some((value) => typeof value !== 'string')) {
    locFail('Local Story review closure is incomplete.', 'LOCAL_STATE_INVALID');
  }
  recordPaths.actionAuthority = actionAuthority.path;
  const semantic = await semanticInventory(paths, recordPaths);
  const inputFiles = contentEntries(paths, inputs.record, 'inputs', 'input');
  const outputFiles = contentEntries(paths, outputs.record, 'outputs', 'output');
  const preAuthorization = inventorySort([
    ...semantic.map((entry) => entry.inventory),
    ...inputFiles.map((entry) => entry.inventory),
    ...outputFiles.map((entry) => entry.inventory)
  ]);
  if (preAuthorization.length + 1 > LOC_LIMITS.maximumFiles) {
    locFail('Bundle inventory exceeds the registered file ceiling.',
      'LOCAL_RESOURCE_LIMIT');
  }
  const releaseContentRoot = locSha256({
    schema: 'loc.release-content.v1',
    candidateDigest: state.roots.candidateDigest,
    disclosurePlanRoot: state.roots.disclosurePlanRoot,
    inventory: preAuthorization
  });
  const authorizationSubject = {
    schema: 'loc.authorization.v1',
    storyId: state.storyId,
    generationId: state.generationId,
    candidateDigest: state.roots.candidateDigest,
    reviewSubjectDigest: state.roots.reviewSubjectDigest,
    approvalsRoot: state.roots.approvalsRoot,
    actionAuthorityRoot: actionAuthority.sha256,
    releaseContentRoot,
    action: 'publish-local-bundle',
    destinationClass: 'proven-local-filesystem',
    authorizedAt: state.review.reviewedAt
  };
  const authorizationSigned = createDsseEnvelope(
    Buffer.from(canonicalJcs(authorizationSubject)), LOC_REVIEW_PAYLOAD_TYPE, signer
  );
  const authorization = await localRecord(paths, 'local-authorization-envelope', {
    subject: authorizationSubject,
    payloadType: LOC_REVIEW_PAYLOAD_TYPE,
    envelope: authorizationSigned.envelope
  });
  const authorizationRef = await referenceForLedgerPath(paths, authorization.path);
  const finalInventory = inventorySort([
    ...preAuthorization,
    inventoryEntry(authorizationRef, 'authority')
  ]);
  const semanticByName = new Map(semantic.map((entry) => [entry.name, entry.reference]));
  const requiredRef = (name) => {
    const value = semanticByName.get(name);
    if (!value) locFail(`Bundle preparation is missing ${name}.`, 'LOCAL_STATE_INVALID');
    return artifactRef(value);
  };
  const manifest = {
    schemaVersion: currentSchemaVersion('local-bundle-manifest'),
    schema: LOC_BUNDLE_SCHEMA,
    mode: 'local-bundle',
    authorityDomainId: state.authorityDomainId,
    trustScope: state.trustScope,
    storyId: state.storyId,
    generationId: state.generationId,
    candidate: requiredRef('candidate'),
    inputs: requiredRef('inputs'),
    outputs: requiredRef('outputs'),
    intent: requiredRef('intent'),
    workflow: requiredRef('workflow'),
    policy: requiredRef('policy'),
    classification: requiredRef('classification'),
    disclosurePlan: requiredRef('disclosurePlan'),
    verificationPlan: requiredRef('verificationPlan'),
    claims: requiredRef('claims'),
    evidence: requiredRef('evidence'),
    reviewSubject: requiredRef('reviewSubject'),
    approvals: requiredRef('approvals'),
    authoritySnapshot: artifactRef(actionAuthority),
    authorizationReceipt: artifactRef(authorizationRef),
    releaseContentRoot,
    inventory: finalInventory,
    externalReferences: [],
    assurance: {
      auditProfile: LOC_AUDIT_PROFILE,
      auditClosure: 'embedded',
      rerunClosure: 'unsupported',
      recovery: 'deliverable-only'
    },
    producers: [{
      component: 'singularity-flow',
      version: VERSION,
      digest: locSha256(`singularity-flow:${VERSION}`)
    }],
    signatureProfile: LOC_SIGNATURE_PROFILE,
    packagingProfile: LOC_PACKAGING_PROFILE,
    preparedAt: state.review.reviewedAt
  };
  const manifestBytes = Buffer.from(canonicalJcs(manifest));
  if (manifestBytes.length > LOC_LIMITS.maximumManifestBytes) {
    locFail('Bundle manifest exceeds the registered byte ceiling.',
      'EXPORT_PROFILE_UNSUPPORTED');
  }
  const bundleId = locSha256(manifestBytes);
  const manifestEnvelope = createDsseEnvelope(manifestBytes, LOC_PAYLOAD_TYPE, signer);
  const archivesByPath = new Map([
    ...semantic.map((entry) => [entry.inventory.path, {
      path: entry.inventory.path, mode: entry.inventory.mode,
      source: path.join(paths.ledger, entry.reference.path)
    }]),
    ...inputFiles.map((entry) => [entry.archive.path, entry.archive]),
    ...outputFiles.map((entry) => [entry.archive.path, entry.archive]),
    [authorizationRef.path, {
      path: authorizationRef.path, mode: '0644',
      source: path.join(paths.ledger, authorizationRef.path)
    }]
  ]);
  const archiveEntries = finalInventory.map((entry) => archivesByPath.get(entry.path));
  if (archiveEntries.some((entry) => !entry)) {
    locFail('Bundle inventory and retained source map disagree.', 'LOCAL_STATE_INVALID');
  }
  archiveEntries.push(
    { path: 'manifest.json', mode: '0644', bytes: manifestBytes },
    { path: 'manifest.dsse.json', mode: '0644', bytes: manifestEnvelope.bytes }
  );
  const staging = path.join(paths.staging,
    `${bundleId.slice(7)}-${randomUUID()}.sflow-local.zip`);
  await writeLocArchive(staging, archiveEntries);
  const inspected = await inspectLocArchive(staging);
  const archiveSha256 = inspected.archiveSha256;
  const archiveSizeBytes = inspected.sizeBytes;
  await inspected.close();
  return Object.freeze({
    manifest, manifestBytes, manifestEnvelope, bundleId,
    releaseContentRoot, actionAuthority, authorization,
    staging, archiveSha256, archiveSizeBytes
  });
}

async function approvedExportDirectory(requested, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const configured = env[EXPORT_ROOT_ENV];
  if (configured && !path.isAbsolute(configured)) {
    locFail(`${EXPORT_ROOT_ENV} must be an absolute path.`, 'EXPORT_DESTINATION_UNSAFE');
  }
  const root = path.resolve(configured
    || path.join(home, '.singularity-flow', 'local-mode', 'exports'));
  const before = await lstat(root).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (before?.isSymbolicLink() || (before && !before.isDirectory())) {
    locFail('Approved local export root must be an ordinary directory.',
      'EXPORT_DESTINATION_UNSAFE');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(root, 0o700);
  const rootReal = await realpath(root);
  const destination = path.resolve(requested || rootReal);
  const destinationInfo = await lstat(destination).catch((error) => {
    if (error?.code === 'ENOENT') {
      locFail('The requested export directory does not exist.',
        'EXPORT_DESTINATION_UNAVAILABLE');
    }
    throw error;
  });
  if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()) {
    locFail('Export destination must be an ordinary directory.',
      'EXPORT_DESTINATION_UNSAFE');
  }
  const destinationReal = await realpath(destination);
  if (destinationReal !== rootReal
      && !destinationReal.startsWith(rootReal + path.sep)) {
    locFail(`Export destination must remain under ${EXPORT_ROOT_ENV}.`,
      'EXPORT_DESTINATION_UNSAFE');
  }
  const openedInfo = await stat(destinationReal);
  if (process.platform !== 'win32' && (openedInfo.mode & 0o002) !== 0) {
    locFail('Export destination cannot be world-writable.',
      'EXPORT_DESTINATION_UNSAFE');
  }
  return destinationReal;
}

async function regularFileDigest(file) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) locFail('Export object is not an ordinary file.', 'EXPORT_FAILED');
    let position = 0;
    const buffer = Buffer.alloc(1024 * 1024);
    while (position < Number(before.size)) {
      const result = await handle.read(buffer, 0,
        Math.min(buffer.length, Number(before.size) - position), position);
      if (!result.bytesRead) locFail('Export object changed while read.', 'INPUT_CHANGED');
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || after.ino !== before.ino || after.dev !== before.dev) {
      locFail('Export object changed while read.', 'INPUT_CHANGED');
    }
    return Object.freeze({
      sha256: `sha256:${hash.digest('hex')}`,
      sizeBytes: Number(before.size)
    });
  } finally { await handle.close(); }
}

async function installCreateOnly(source, finalFile, expected) {
  const existing = await lstat(finalFile).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      locFail('Export destination name is already occupied by a non-regular file.',
        'EXPORT_DESTINATION_EXISTS');
    }
    const observed = await regularFileDigest(finalFile);
    if (observed.sha256 !== expected.sha256
        || observed.sizeBytes !== expected.sizeBytes) {
      locFail('Export destination already contains different bytes.',
        'EXPORT_DESTINATION_EXISTS');
    }
    return Object.freeze({ created: false, reconciled: true });
  }
  const directory = path.dirname(finalFile);
  const temporary = path.join(directory,
    `.${path.basename(finalFile)}.pending-${process.pid}-${randomUUID()}`);
  const sourceHandle = await open(source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let targetHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || Number(before.size) !== expected.sizeBytes) {
      locFail('Prepared export bytes are unavailable.', 'EXPORT_FAILED');
    }
    targetHandle = await open(temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const hash = createHash('sha256');
    let position = 0;
    const buffer = Buffer.alloc(1024 * 1024);
    while (position < Number(before.size)) {
      const result = await sourceHandle.read(buffer, 0,
        Math.min(buffer.length, Number(before.size) - position), position);
      if (!result.bytesRead) locFail('Prepared export changed while copied.', 'INPUT_CHANGED');
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const resultWrite = await targetHandle.write(
          chunk, written, chunk.length - written, position + written
        );
        if (!resultWrite.bytesWritten) locFail('Export writer made no progress.', 'EXPORT_FAILED');
        written += resultWrite.bytesWritten;
      }
      position += result.bytesRead;
    }
    const after = await sourceHandle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || after.ino !== before.ino || after.dev !== before.dev
        || `sha256:${hash.digest('hex')}` !== expected.sha256) {
      locFail('Prepared export changed while copied.', 'INPUT_CHANGED');
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = null;
    try {
      await link(temporary, finalFile);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const observed = await regularFileDigest(finalFile);
      if (observed.sha256 !== expected.sha256
          || observed.sizeBytes !== expected.sizeBytes) {
        locFail('A concurrent export created different destination bytes.',
          'EXPORT_DESTINATION_EXISTS');
      }
      return Object.freeze({ created: false, reconciled: true });
    }
    await syncDirectory(directory);
    return Object.freeze({ created: true, reconciled: false });
  } finally {
    await sourceHandle.close().catch(() => {});
    await targetHandle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function publishLocalBundle(storyId, candidateDigest, signerId,
  destination, options = {}) {
  locDigest(candidateDigest, 'candidate digest');
  const id = localSignerId(signerId);
  const destinationDirectory = await approvedExportDirectory(destination, options);
  return lockedStory(storyId, options, async (paths, state) => {
    if (state.roots.candidateDigest !== candidateDigest) {
      locFail('Publication selector does not equal the reviewed candidate.',
        'CANDIDATE_MISMATCH');
    }
    const priorDelivery = state.deliveries.find((entry) =>
      path.dirname(entry.destination) === destinationDirectory);
    if (state.status === 'published' && priorDelivery) {
      const observed = await regularFileDigest(priorDelivery.destination);
      if (observed.sha256 !== priorDelivery.archiveSha256) {
        locFail('Recorded delivery no longer matches its destination bytes.',
          'EXPORT_DESTINATION_MISMATCH');
      }
      return Object.freeze({
        storyId: state.storyId,
        status: state.status,
        operationId: priorDelivery.operationId,
        bundleId: priorDelivery.bundleId,
        archiveSha256: priorDelivery.archiveSha256,
        artifact: priorDelivery.destination,
        idempotent: true
      });
    }
    const prepared = await prepareBundle(paths, state, id);
    const finalFile = path.join(destinationDirectory,
      `${state.storyId}-${prepared.bundleId.slice(7, 23)}.sflow-local.zip`);
    const completed = state.deliveries.find((entry) =>
      entry.bundleId === prepared.bundleId
      && entry.archiveSha256 === prepared.archiveSha256
      && entry.destination === finalFile);
    if (completed) {
      const observed = await regularFileDigest(finalFile);
      if (observed.sha256 !== prepared.archiveSha256
          || observed.sizeBytes !== prepared.archiveSizeBytes) {
        locFail('Recorded delivery no longer matches its destination bytes.',
          'EXPORT_DESTINATION_MISMATCH');
      }
      await rm(prepared.staging, { force: true }).catch(() => {});
      return Object.freeze({
        storyId: state.storyId,
        status: state.status,
        operationId: completed.operationId,
        bundleId: prepared.bundleId,
        archiveSha256: prepared.archiveSha256,
        artifact: finalFile,
        idempotent: true
      });
    }
    const pending = state.operations.find((entry) =>
      entry.kind === 'local-mode-operation'
      && entry.status === 'prepared'
      && entry.candidateDigest === candidateDigest
      && entry.destination === finalFile);
    if (pending && (pending.bundleId !== prepared.bundleId
        || pending.archiveSha256 !== prepared.archiveSha256)) {
      locFail('The retained export operation conflicts with newly prepared bytes.',
        'IDEMPOTENCY_CONFLICT');
    }
    const operation = pending ?? {
      schemaVersion: currentSchemaVersion('local-mode-operation'),
      kind: 'local-mode-operation',
      operationId: 'loce-' + randomUUID(),
      status: 'prepared',
      storyId: state.storyId,
      generationId: state.generationId,
      candidateDigest,
      reviewSubjectDigest: state.roots.reviewSubjectDigest,
      approvalsRoot: state.roots.approvalsRoot,
      releaseContentRoot: prepared.releaseContentRoot,
      bundleId: prepared.bundleId,
      archiveSha256: prepared.archiveSha256,
      archiveSizeBytes: prepared.archiveSizeBytes,
      destination: finalFile,
      profile: LOC_PACKAGING_PROFILE,
      preparedAt: state.review.reviewedAt
    };
    if (!pending) {
      const journaled = {
        ...state,
        revision: state.revision + 1,
        status: 'publishing',
        updatedAt: new Date().toISOString(),
        records: {
          ...state.records,
          actionAuthority: prepared.actionAuthority.path,
          authorizationReceipt: prepared.authorization.path
        },
        roots: {
          ...state.roots,
          actionAuthorityRoot: prepared.actionAuthority.sha256,
          authorizationReceiptRoot: prepared.authorization.sha256,
          releaseContentRoot: prepared.releaseContentRoot,
          bundleId: prepared.bundleId,
          archiveSha256: prepared.archiveSha256
        },
        operations: [...state.operations, operation]
      };
      await writeLocalState(paths, journaled,
        '[local-mode] prepare export ' + operation.operationId);
      state = journaled;
    }
    let installed;
    try {
      installed = await installCreateOnly(prepared.staging, finalFile, {
        sha256: prepared.archiveSha256,
        sizeBytes: prepared.archiveSizeBytes
      });
      const verified = await inspectLocArchive(finalFile);
      if (verified.archiveSha256 !== prepared.archiveSha256
          || verified.sizeBytes !== prepared.archiveSizeBytes) {
        await verified.close();
        locFail('Installed export failed exact post-write verification.', 'EXPORT_FAILED');
      }
      await verified.close();
    } catch (error) {
      // The prepared operation and exact archive remain available for an identical retry.
      throw error;
    }
    const deliveredAt = new Date().toISOString();
    const receipt = await localRecord(paths, 'local-delivery-receipt', {
      operationId: operation.operationId,
      storyId: state.storyId,
      generationId: state.generationId,
      candidateDigest,
      bundleId: prepared.bundleId,
      archiveSha256: prepared.archiveSha256,
      destination: finalFile,
      destinationClass: 'proven-local-filesystem',
      actionAuthorityRoot: prepared.actionAuthority.sha256,
      authorizationReceiptRoot: prepared.authorization.sha256,
      outcome: installed.created ? 'created' : 'reconciled-existing',
      deliveredAt
    });
    const completeOperation = { ...operation, status: 'completed', deliveredAt,
      deliveryReceiptRoot: receipt.sha256 };
    const next = {
      ...state,
      revision: state.revision + 1,
      status: 'published',
      updatedAt: deliveredAt,
      records: { ...state.records, deliveryReceipt: receipt.path },
      roots: { ...state.roots, deliveryReceiptRoot: receipt.sha256 },
      operations: state.operations.map((entry) =>
        entry.operationId === operation.operationId ? completeOperation : entry),
      deliveries: [...state.deliveries, {
        operationId: operation.operationId,
        bundleId: prepared.bundleId,
        archiveSha256: prepared.archiveSha256,
        destination: finalFile,
        deliveredAt,
        receiptSha256: receipt.sha256
      }]
    };
    const written = await writeLocalState(paths, next,
      '[local-mode] complete export ' + operation.operationId);
    await rm(prepared.staging, { force: true }).catch(() => {});
    return Object.freeze({
      storyId: state.storyId,
      status: written.state.status,
      operationId: operation.operationId,
      bundleId: prepared.bundleId,
      archiveSha256: prepared.archiveSha256,
      artifact: finalFile,
      created: installed.created,
      reconciled: installed.reconciled,
      deliveryReceiptRoot: receipt.sha256,
      ledgerCommit: written.commit
    });
  });
}

const MANIFEST_FIELDS = [
  'schemaVersion', 'schema', 'mode', 'authorityDomainId', 'trustScope', 'storyId',
  'generationId', 'candidate', 'inputs', 'outputs', 'intent', 'workflow', 'policy',
  'classification', 'disclosurePlan', 'verificationPlan', 'claims', 'evidence',
  'reviewSubject', 'approvals', 'authoritySnapshot', 'authorizationReceipt',
  'releaseContentRoot', 'inventory', 'externalReferences', 'assurance', 'producers',
  'signatureProfile', 'packagingProfile', 'preparedAt'
];
const MANIFEST_REFS = [
  'candidate', 'inputs', 'outputs', 'intent', 'workflow', 'policy', 'classification',
  'disclosurePlan', 'verificationPlan', 'claims', 'evidence', 'reviewSubject',
  'approvals', 'authoritySnapshot', 'authorizationReceipt'
];
const INVENTORY_ROLES = new Set([
  'output', 'input', 'spec', 'policy', 'claim', 'evidence', 'approval', 'authority',
  'metadata'
]);

async function readStableRegularFile(file, maximumBytes, label) {
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.size > maximumBytes) {
    locFail(`${label} must be one bounded regular file.`,
      'BUNDLE_TRUST_UNAVAILABLE');
  }
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)
        || (before.ino !== 0n && before.ino !== BigInt(info.ino))
        || (before.dev !== 0n && before.dev !== BigInt(info.dev))) {
      locFail(`${label} changed while it was opened.`, 'INPUT_CHANGED');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.length !== Number(before.size) || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ino !== before.ino
        || after.dev !== before.dev) {
      locFail(`${label} changed while it was read.`, 'INPUT_CHANGED');
    }
    return bytes;
  } finally { await handle.close(); }
}

async function trustedKeyBytes(file) {
  if (!path.isAbsolute(String(file ?? ''))) {
    locFail('Offline audit requires an absolute trusted-key path.',
      'BUNDLE_TRUST_UNAVAILABLE');
  }
  const bytes = await readStableRegularFile(file, 64 * 1024,
    'Offline audit trusted key');
  if (!bytes) {
    locFail('Offline audit trusted key is unavailable.', 'BUNDLE_TRUST_UNAVAILABLE');
  }
  return bytes.toString('utf8');
}

function validateArtifactReference(reference, label) {
  exactFields(reference, ['path', 'sha256', 'sizeBytes'], label);
  portablePath(reference.path);
  locDigest(reference.sha256, `${label} digest`);
  if (!Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 0
      || reference.sizeBytes > LOC_LIMITS.maximumFileBytes) {
    locFail(`${label} has an invalid byte count.`, 'BUNDLE_SCHEMA_UNSUPPORTED');
  }
}

function sameStringArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

async function bundleRecord(reader, reference, family) {
  validateArtifactReference(reference, family);
  const metadata = reader.entries.get(reference.path);
  if (!metadata || metadata.sha256 !== reference.sha256
      || metadata.sizeBytes !== reference.sizeBytes) {
    locFail(`Bundle ${family} reference does not match its inventory.`,
      'BUNDLE_INTEGRITY_INVALID');
  }
  const bytes = await reader.read(reference.path);
  const parsed = parseCanonicalJcs(bytes);
  const record = readRecord(family, parsed).record;
  if (record.kind !== family) {
    locFail(`Bundle ${family} record is unsupported.`, 'BUNDLE_SCHEMA_UNSUPPORTED');
  }
  return Object.freeze({ record, bytes, sha256: locSha256(bytes) });
}

function digestReference(reader, digest) {
  locDigest(digest);
  const reference = {
    path: `records/${digest.slice(7)}.json`,
    sha256: digest,
    sizeBytes: reader.entries.get(`records/${digest.slice(7)}.json`)?.sizeBytes
  };
  if (!Number.isSafeInteger(reference.sizeBytes)) {
    locFail(`Required embedded record ${digest} is missing.`,
      'BUNDLE_INTEGRITY_INVALID');
  }
  return reference;
}

function assertManifestInventory(reader, manifest) {
  if (!Array.isArray(manifest.inventory) || !manifest.inventory.length
      || manifest.inventory.length > LOC_LIMITS.maximumFiles) {
    locFail('Bundle inventory is missing or outside its registered ceiling.',
      'BUNDLE_SCHEMA_UNSUPPORTED');
  }
  let previous = null;
  const names = new Set();
  for (const entry of manifest.inventory) {
    exactFields(entry,
      ['path', 'sha256', 'sizeBytes', 'role', 'fileKind', 'mode'],
      'inventory entry');
    validateArtifactReference({
      path: entry.path, sha256: entry.sha256, sizeBytes: entry.sizeBytes
    }, 'inventory entry');
    if (!INVENTORY_ROLES.has(entry.role) || entry.fileKind !== 'regular'
        || !['0644', '0755'].includes(entry.mode)) {
      locFail('Bundle inventory contains an unsupported role, kind, or mode.',
        'BUNDLE_SCHEMA_UNSUPPORTED');
    }
    if (previous != null
        && Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0) {
      locFail('Bundle inventory is not in unique canonical path order.',
        'BUNDLE_INTEGRITY_INVALID');
    }
    previous = entry.path;
    names.add(entry.path);
    const actual = reader.entries.get(entry.path);
    if (!actual || actual.sha256 !== entry.sha256
        || actual.sizeBytes !== entry.sizeBytes || actual.mode !== entry.mode) {
      locFail(`Bundle member '${entry.path}' does not match its signed inventory.`,
        'BUNDLE_INTEGRITY_INVALID');
    }
  }
  const actualNames = [...reader.entries.keys()].sort();
  const expectedNames = [...names, 'manifest.dsse.json', 'manifest.json'].sort();
  if (actualNames.length !== expectedNames.length
      || actualNames.some((name, index) => name !== expectedNames[index])) {
    locFail('Bundle contains missing or unsigned extra members.',
      'BUNDLE_INTEGRITY_INVALID');
  }
  for (const name of MANIFEST_REFS) {
    const reference = manifest[name];
    validateArtifactReference(reference, name);
    const signed = manifest.inventory.find((entry) => entry.path === reference.path);
    if (!signed || signed.sha256 !== reference.sha256
        || signed.sizeBytes !== reference.sizeBytes) {
      locFail(`Manifest ${name} does not match the signed inventory.`,
        'BUNDLE_INTEGRITY_INVALID');
    }
  }
}

function assertFrozenPayloadMembership(manifestRecord, inventory, prefix, role) {
  if (!Array.isArray(manifestRecord.files)
      || manifestRecord.fileCount !== manifestRecord.files.length
      || manifestRecord.totalBytes !== manifestRecord.files.reduce(
        (sum, entry) => sum + entry.sizeBytes, 0)) {
    locFail(`${prefix} manifest counts are inconsistent.`, 'BUNDLE_INTEGRITY_INVALID');
  }
  const expected = new Set();
  for (const file of manifestRecord.files) {
    exactFields(file, ['path', 'kind', 'mode', 'sizeBytes', 'sha256', 'object'],
      `${prefix} file`);
    const logical = portablePath(file.path);
    portablePath(file.object);
    if (file.kind !== 'regular' || !['0644', '0755'].includes(file.mode)) {
      locFail(`${prefix} manifest contains an unsupported file.`,
        'BUNDLE_SCHEMA_UNSUPPORTED');
    }
    const bundlePath = `${prefix}/${logical}`;
    expected.add(bundlePath);
    const member = inventory.find((entry) => entry.path === bundlePath);
    if (!member || member.role !== role || member.sha256 !== file.sha256
        || member.sizeBytes !== file.sizeBytes || member.mode !== file.mode) {
      locFail(`${prefix} payload does not equal its frozen manifest.`,
        'BUNDLE_INTEGRITY_INVALID');
    }
  }
  const observed = inventory.filter((entry) => entry.role === role);
  if (observed.length !== expected.size
      || observed.some((entry) => !expected.has(entry.path))) {
    locFail(`${prefix} payload membership is not exact.`,
      'BUNDLE_INTEGRITY_INVALID');
  }
}

export async function auditLocalBundle(bundle, trustKey, signerId) {
  const id = localSignerId(signerId);
  const trustedPublicKeyPem = await trustedKeyBytes(trustKey);
  const reader = await inspectLocArchive(bundle);
  try {
    const manifestBytes = await reader.read('manifest.json', LOC_LIMITS.maximumManifestBytes);
    const parsedManifest = parseCanonicalJcs(manifestBytes, {
      maximumBytes: LOC_LIMITS.maximumManifestBytes
    });
    const manifest = readRecord('local-bundle-manifest', parsedManifest).record;
    exactFields(manifest, MANIFEST_FIELDS, 'bundle manifest');
    if (manifest.kind != null
        || manifest.schema !== LOC_BUNDLE_SCHEMA || manifest.mode !== 'local-bundle'
        || manifest.trustScope !== 'standalone'
        || manifest.authorityDomainId !== `standalone:${manifest.storyId}`
        || manifest.signatureProfile !== LOC_SIGNATURE_PROFILE
        || manifest.packagingProfile !== LOC_PACKAGING_PROFILE) {
      locFail('Bundle manifest profile or trust domain is unsupported.',
        'BUNDLE_SCHEMA_UNSUPPORTED');
    }
    if (!Array.isArray(manifest.externalReferences)
        || manifest.externalReferences.length !== 0
        || !manifest.assurance || Array.isArray(manifest.assurance)
        || Object.keys(manifest.assurance).sort().join(',')
          !== ['auditClosure', 'auditProfile', 'recovery', 'rerunClosure'].sort().join(',')
        || manifest.assurance?.auditProfile !== LOC_AUDIT_PROFILE
        || manifest.assurance?.auditClosure !== 'embedded'
        || manifest.assurance?.rerunClosure !== 'unsupported'
        || manifest.assurance?.recovery !== 'deliverable-only'
        || !Array.isArray(manifest.producers) || manifest.producers.length !== 1
        || !manifest.producers[0] || Array.isArray(manifest.producers[0])
        || Object.keys(manifest.producers[0]).sort().join(',')
          !== ['component', 'digest', 'version'].sort().join(',')
        || manifest.producers[0].component !== 'singularity-flow'
        || typeof manifest.producers[0].version !== 'string'
        || !manifest.producers[0].version
        || manifest.producers[0].digest
          !== locSha256(`singularity-flow:${manifest.producers[0].version}`)
        || !isIsoTimestamp(manifest.preparedAt)) {
      locFail('Bundle does not contain the complete supported L1 audit closure.',
        'BUNDLE_AUDIT_UNAVAILABLE');
    }
    assertManifestInventory(reader, manifest);
    const envelopeBytes = await reader.read(
      'manifest.dsse.json', LOC_LIMITS.maximumEnvelopeBytes
    );
    const manifestSignature = verifyDsseEnvelope(envelopeBytes, {
      payloadType: LOC_PAYLOAD_TYPE, trustedPublicKeyPem, expectedKeyId: id
    });
    if (!manifestSignature.payload.equals(manifestBytes)) {
      locFail('Signed manifest payload differs from manifest.json.',
        'BUNDLE_INTEGRITY_INVALID');
    }
    const bundleId = locSha256(manifestBytes);
    const inputs = await bundleRecord(reader, manifest.inputs, 'local-input-manifest');
    const outputs = await bundleRecord(reader, manifest.outputs, 'local-output-manifest');
    assertFrozenPayloadMembership(inputs.record, manifest.inventory, 'inputs', 'input');
    assertFrozenPayloadMembership(outputs.record, manifest.inventory, 'outputs', 'output');
    const candidate = await bundleRecord(reader, manifest.candidate, 'local-candidate');
    if (candidate.record.storyId !== manifest.storyId
        || candidate.record.generationId !== manifest.generationId
        || candidate.sha256 !== manifest.candidate.sha256
        || candidate.record.inputRoot !== manifest.inputs.sha256
        || candidate.record.outputRoot !== manifest.outputs.sha256
        || candidate.record.intentRoot !== manifest.intent.sha256
        || candidate.record.workflowRoot !== manifest.workflow.sha256
        || candidate.record.policyRoot !== manifest.policy.sha256
        || candidate.record.classificationRoot !== manifest.classification.sha256
        || candidate.record.disclosurePlanRoot !== manifest.disclosurePlan.sha256
        || candidate.record.verificationPlanRoot !== manifest.verificationPlan.sha256) {
      locFail('Candidate descriptor is not bound to the manifest roots.',
        'BUNDLE_EVIDENCE_INVALID');
    }
    const claims = await bundleRecord(reader, manifest.claims, 'local-claims');
    const evidence = await bundleRecord(reader, manifest.evidence, 'local-evidence-index');
    if (claims.record.candidateDigest !== candidate.sha256
        || !Array.isArray(claims.record.claims)
        || claims.record.claims.length !== 1
        || claims.record.claims[0]?.id !== 'LOC-OUTPUT-001'
        || !sameStringArray(claims.record.claims[0]?.requiredCheckIds,
          ['exact-output-tree'])
        || evidence.record.candidateDigest !== candidate.sha256
        || evidence.record.verificationPlanDigest !== manifest.verificationPlan.sha256
        || !sameStringArray(evidence.record.requiredChecks, ['exact-output-tree'])
        || evidence.record.eligibility !== 'passed'
        || !Array.isArray(evidence.record.attempts)
        || evidence.record.attempts.length !== 1
        || evidence.record.attempts[0]?.checkId !== 'exact-output-tree') {
      locFail('Evidence index is not an eligible exact-candidate observation.',
        'BUNDLE_EVIDENCE_INVALID');
    }
    const evidenceReceipt = await bundleRecord(reader,
      digestReference(reader, evidence.record.attempts[0].receiptSha256),
      'local-evidence-receipt');
    if (evidenceReceipt.record.candidateDigest !== candidate.sha256
        || evidenceReceipt.record.verificationPlanDigest !== manifest.verificationPlan.sha256
        || evidenceReceipt.record.checkId !== 'exact-output-tree'
        || !sameStringArray(evidenceReceipt.record.claimIds, ['LOC-OUTPUT-001'])
        || evidenceReceipt.record.runner?.id !== 'singularity-flow/local-mode'
        || evidenceReceipt.record.runner?.assurance !== 'deterministic-local-integrity'
        || evidenceReceipt.record.result !== 'passed') {
      locFail('Required exact-tree evidence receipt is invalid.',
        'BUNDLE_EVIDENCE_INVALID');
    }
    const reviewSubject = await bundleRecord(
      reader, manifest.reviewSubject, 'local-review-subject'
    );
    if (reviewSubject.record.candidateDigest !== candidate.sha256
        || reviewSubject.record.claimsRoot !== claims.sha256
        || reviewSubject.record.evidenceRoot !== evidence.sha256
        || reviewSubject.record.policyRoot !== manifest.policy.sha256
        || reviewSubject.record.classificationRoot !== manifest.classification.sha256
        || reviewSubject.record.disclosurePlanRoot !== manifest.disclosurePlan.sha256) {
      locFail('Review subject is not bound to the audited candidate and evidence.',
        'BUNDLE_APPROVAL_INVALID');
    }
    const approvals = await bundleRecord(reader, manifest.approvals,
      'local-approval-index');
    if (approvals.record.reviewSubjectDigest !== reviewSubject.sha256
        || approvals.record.eligibility !== 'approved'
        || approvals.record.quorum !== 1
        || !Array.isArray(approvals.record.statements)
        || approvals.record.statements.length !== 1) {
      locFail('Approval index does not satisfy the pinned standalone policy.',
        'BUNDLE_APPROVAL_INVALID');
    }
    const statement = approvals.record.statements[0];
    exactFields(statement,
      ['decisionDigest', 'envelopeDigest', 'signerId', 'keySha256'],
      'approval statement');
    const decision = await bundleRecord(reader,
      digestReference(reader, statement.decisionDigest), 'local-review-decision');
    const reviewEnvelope = await bundleRecord(reader,
      digestReference(reader, statement.envelopeDigest), 'local-review-envelope');
    const reviewSignature = verifyDsseEnvelope(
      Buffer.from(canonicalJcs(reviewEnvelope.record.envelope)), {
        payloadType: LOC_REVIEW_PAYLOAD_TYPE,
        trustedPublicKeyPem,
        expectedKeyId: id
      }
    );
    if (!reviewSignature.payload.equals(decision.bytes)
        || reviewEnvelope.record.decisionDigest !== decision.sha256
        || reviewEnvelope.record.payloadType !== LOC_REVIEW_PAYLOAD_TYPE
        || decision.record.reviewSubjectDigest !== reviewSubject.sha256
        || decision.record.decision !== 'approved'
        || decision.record.role !== 'local-output-owner'
        || decision.record.signerId !== id
        || decision.record.keySha256 !== manifestSignature.keySha256
        || statement.signerId !== id
        || statement.keySha256 !== manifestSignature.keySha256) {
      locFail('Exact review signature or subject binding is invalid.',
        'BUNDLE_APPROVAL_INVALID');
    }
    const reviewAuthority = await bundleRecord(reader,
      digestReference(reader, reviewSubject.record.reviewAuthorityRoot),
      'local-review-authority');
    if (reviewAuthority.record.trustScope !== 'standalone'
        || reviewAuthority.record.authorityDomainId !== manifest.authorityDomainId
        || reviewAuthority.record.policyRoot !== manifest.policy.sha256
        || reviewAuthority.record.role !== 'local-output-owner'
        || reviewAuthority.record.eligibleSigner?.keyId !== id
        || reviewAuthority.record.eligibleSigner?.keySha256 !== manifestSignature.keySha256) {
      locFail('Review authority does not trace to the independently trusted key.',
        'BUNDLE_TRUST_UNAVAILABLE');
    }
    const actionAuthority = await bundleRecord(
      reader, manifest.authoritySnapshot, 'local-action-authority'
    );
    if (actionAuthority.record.candidateDigest !== candidate.sha256
        || actionAuthority.record.approvalsRoot !== approvals.sha256
        || actionAuthority.record.reviewSubjectDigest !== reviewSubject.sha256
        || actionAuthority.record.action !== 'publish-local-bundle'
        || actionAuthority.record.authorityDomainId !== manifest.authorityDomainId
        || actionAuthority.record.trustScope !== 'standalone'
        || actionAuthority.record.policyRoot !== manifest.policy.sha256
        || actionAuthority.record.signerId !== id
        || actionAuthority.record.keySha256 !== manifestSignature.keySha256) {
      locFail('Action authority is not bound to the approved subject.',
        'BUNDLE_AUTHORIZATION_INVALID');
    }
    const preAuthorization = manifest.inventory.filter((entry) =>
      entry.path !== manifest.authorizationReceipt.path);
    const expectedReleaseContentRoot = locSha256({
      schema: 'loc.release-content.v1',
      candidateDigest: candidate.sha256,
      disclosurePlanRoot: manifest.disclosurePlan.sha256,
      inventory: preAuthorization
    });
    if (manifest.releaseContentRoot !== expectedReleaseContentRoot) {
      locFail('Release content root does not match the pre-authorization inventory.',
        'BUNDLE_AUTHORIZATION_INVALID');
    }
    const authorization = await bundleRecord(
      reader, manifest.authorizationReceipt, 'local-authorization-envelope'
    );
    const authorizationSignature = verifyDsseEnvelope(
      Buffer.from(canonicalJcs(authorization.record.envelope)), {
        payloadType: LOC_REVIEW_PAYLOAD_TYPE,
        trustedPublicKeyPem,
        expectedKeyId: id
      }
    );
    if (!authorizationSignature.payload.equals(
      Buffer.from(canonicalJcs(authorization.record.subject)))
        || authorization.record.payloadType !== LOC_REVIEW_PAYLOAD_TYPE
        || authorization.record.subject.storyId !== manifest.storyId
        || authorization.record.subject.generationId !== manifest.generationId
        || authorization.record.subject.reviewSubjectDigest !== reviewSubject.sha256
        || authorization.record.subject.releaseContentRoot !== manifest.releaseContentRoot
        || authorization.record.subject.actionAuthorityRoot !== actionAuthority.sha256
        || authorization.record.subject.approvalsRoot !== approvals.sha256
        || authorization.record.subject.candidateDigest !== candidate.sha256
        || authorization.record.subject.action !== 'publish-local-bundle'
        || authorization.record.subject.destinationClass !== 'proven-local-filesystem'
        || authorization.record.subject.authorizedAt !== decision.record.decidedAt
        || manifest.preparedAt !== decision.record.decidedAt) {
      locFail('Pre-export authorization receipt is invalid.',
        'BUNDLE_AUTHORIZATION_INVALID');
    }
    await bundleRecord(reader, manifest.intent, 'local-intent');
    await bundleRecord(reader, manifest.workflow, 'local-workflow');
    const policy = await bundleRecord(reader, manifest.policy, 'local-policy');
    await bundleRecord(reader, manifest.classification, 'local-classification');
    await bundleRecord(reader, manifest.disclosurePlan, 'local-disclosure-plan');
    await bundleRecord(reader, manifest.verificationPlan, 'local-verification-plan');
    if (policy.record.trustScope !== 'standalone'
        || policy.record.review?.quorum !== 1
        || policy.record.review?.selfReview !== true
        || policy.record.publication?.signatureRequired !== true
        || policy.record.publication?.createOnly !== true) {
      locFail('Pinned historical policy does not authorize this L1 profile.',
        'BUNDLE_POLICY_INVALID');
    }
    return Object.freeze({
      schemaVersion: currentSchemaVersion('local-mode-audit'),
      kind: 'local-mode-audit',
      auditProfile: LOC_AUDIT_PROFILE,
      bundleId,
      archiveSha256: reader.archiveSha256,
      storyId: manifest.storyId,
      generationId: manifest.generationId,
      candidateDigest: candidate.sha256,
      integrity: { state: 'passed', reasonCodes: [] },
      signatureTrust: {
        state: 'passed',
        keyId: id,
        keySha256: manifestSignature.keySha256,
        trustScope: 'standalone'
      },
      evidenceBinding: {
        state: 'passed-recorded-integrity',
        claim: 'exact-output-tree',
        semanticCorrectness: 'not-claimed'
      },
      historicalPolicy: {
        state: 'passed',
        currentPermission: 'not-evaluated-offline'
      },
      completeness: {
        state: 'complete-for-record-audit-v1',
        auditClosure: 'embedded',
        rerun: 'not_requested',
        deliveryProof: 'not-in-bundle'
      },
      completeForProfile: true,
      networkAccess: 'none',
      execution: 'none'
    });
  } finally {
    await reader.close();
  }
}
