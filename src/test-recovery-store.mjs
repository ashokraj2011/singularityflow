/**
 * Append-only TRP storage and the governed terminal authorization adapter.
 *
 * Callers own the Story lock and publication transaction. These functions never
 * commit, push, infer authority from actor strings, or execute repository commands.
 * The workflow snapshot, delegation and acknowledged commit supplied to the loader
 * must already have been authenticated by the host; they are not CLI arguments.
 */
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { consumeActionAuthorization } from './action-authorization.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { canonicalJson } from './records.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { exactFileAtObject, gitDir } from './git.mjs';
import { gitIsAncestor } from './git-ancestry.mjs';
import { readRecord } from './schema-migrations.mjs';
import { sealTrpRecord, validateTrpRecord, trpDigest } from './test-recovery-policy.mjs';

const DIRECTORIES = Object.freeze({
  'story-test-recovery-agreement': 'agreements', 'test-baseline-manifest': 'baselines',
  'test-selection-manifest': 'selections', 'phase-validation-observation': 'runs',
  'phase-risk-decision': 'decisions', 'phase-gate-evaluation': 'evaluations',
  'story-test-policy-amendment': 'amendments', 'phase-repair-receipt': 'repairs',
  'trp-authority-receipt': 'authorizations'
});
const WITNESSES = new WeakMap();
const HASH = /^sha256:[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
function fail(message, code = 'TRP_STORAGE_INVALID') { const error = new Error(message); error.code = code; throw error; }
function safeId(value) { if (!ID.test(value ?? '') || value.includes('..')) fail('Invalid TRP storage identifier'); return value; }
function principal(actor) { return String(actor?.email ?? actor?.login ?? '').trim().toLowerCase(); }
function relativeRecordPath(recordOrReference) {
  const directory = DIRECTORIES[recordOrReference.kind];
  if (!directory) fail('Unknown TRP record family');
  let filename = safeId(recordOrReference.id);
  if (recordOrReference.kind === 'story-test-recovery-agreement') {
    if (!Number.isSafeInteger(recordOrReference.revision) || recordOrReference.revision < 1) fail('Agreement revision is required');
    filename = `revision-${recordOrReference.revision}`;
  }
  return path.join('context', 'test-recovery', directory, `${filename}.json`);
}

async function safeFile(workRoot, relative, { createParents = false, parentMode = 0o755 } = {}) {
  const root = await realpath(workRoot);
  const parts = relative.split(path.sep);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (createParents) await mkdir(parent, { mode: parentMode }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('TRP storage parent must be an ordinary directory');
  }
  const target = path.join(root, relative);
  const info = await lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) fail('TRP record must be an ordinary file');
  return { target, info };
}
async function readSafe(workRoot, relative) {
  const { target, info } = await safeFile(workRoot, relative);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !info || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 4 * 1024 * 1024) fail('TRP record changed during read or exceeds its size bound');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function installImmutableBytes(workRoot, relative, bytes, readExisting) {
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) fail('TRP record exceeds bounded storage size');
  const { target, info } = await safeFile(workRoot, relative, { createParents: true });
  const existing = async () => {
    if (canonicalJson(await readExisting()) !== bytes) fail('Append-only TRP record already exists with different content', 'TRP_IMMUTABLE_RECORD');
    return { path: target, relativePath: relative, created: false };
  };
  if (info) return existing();
  // Publish only complete fsynced bytes. An interrupted writer leaves an owned
  // .pending file for diagnosis, never a partial immutable .json destination.
  const temporary = `${target}.pending-${randomUUID()}`;
  let handle;
  let published = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await safeFile(workRoot, relative);
    try { await link(temporary, target); published = true; }
    catch (error) { if (error.code === 'EEXIST') { const result = await existing(); published = true; return result; } throw error; }
    // Directory fsync is supported by POSIX hosts. Windows can reject directory
    // handles; its later governed Git transaction is the durable publication boundary.
    let directory;
    try { directory = await open(path.dirname(target), constants.O_RDONLY); await directory.sync(); }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes(error.code)) throw error; }
    finally { await directory?.close(); }
    return { path: target, relativePath: relative, created: true };
  } finally {
    await handle?.close();
    if (published) await unlink(temporary);
  }
}

/** Writes exact validated bytes once; identical repeats are idempotent. */
async function appendRecordBytes(workRoot, record) {
  validateTrpRecord(record);
  const relative = relativeRecordPath(record);
  const bytes = canonicalJson(record);
  const stored = await installImmutableBytes(workRoot, relative, bytes,
    () => readTrpRecord(workRoot, { kind: record.kind, id: record.id, revision: record.revision }));
  return { ...stored, recordSha256: record.recordSha256 };
}

export async function appendTrpRecord(workRoot, record) {
  if (record?.kind === 'trp-authority-receipt') fail('Use a live authorization witness to append an authority receipt', 'TRP_AUTHORITY_REQUIRED');
  return appendRecordBytes(workRoot, record);
}

export async function readTrpRecord(workRoot, reference) {
  const result = JSON.parse(await readSafe(workRoot, relativeRecordPath(reference)));
  validateTrpRecord(result, { kind: reference.kind });
  if (result.id !== reference.id || (reference.recordSha256 && result.recordSha256 !== reference.recordSha256)
    || (reference.revision != null && result.revision !== reference.revision)) fail('TRP record does not match its requested identity');
  return result;
}

function validateRepairEvidence(receipt) {
  const { receiptSha256, ...core } = receipt ?? {};
  if (receipt?.kind !== 'repository-readiness-receipt' || !HASH.test(receiptSha256 ?? '')
    || trpDigest(core) !== receiptSha256) fail('Repair evidence has an invalid receipt identity', 'TRP_REPAIR_EVIDENCE_INVALID');
  return path.join('context', 'test-recovery', 'repair-evidence', `${receiptSha256.slice(7)}.json`);
}

/** Preserve the runner's exact receipt, without turning its self-hash into authority. */
export async function appendTrpRepairEvidence(workRoot, receipt) {
  const relative = validateRepairEvidence(receipt);
  return installImmutableBytes(workRoot, relative, canonicalJson(receipt), () => readTrpRepairEvidence(workRoot, receipt.receiptSha256));
}

export async function readTrpRepairEvidence(workRoot, receiptSha256) {
  if (!HASH.test(receiptSha256 ?? '')) fail('Invalid repair evidence digest');
  const relative = path.join('context', 'test-recovery', 'repair-evidence', `${receiptSha256.slice(7)}.json`);
  const receipt = JSON.parse(await readSafe(workRoot, relative));
  if (validateRepairEvidence(receipt) !== relative) fail('Repair evidence does not match its requested digest');
  return receipt;
}

function originalBaselinePath(baseline) {
  baseline = readRecord('repository-test-baseline', baseline).record;
  const { baselineSha256, ...core } = baseline;
  if (baseline.kind !== 'repository-test-baseline' || !HASH.test(baselineSha256 ?? '')
    || trpDigest(core) !== baselineSha256) fail('Original baseline failed its content identity check');
  return path.join('context', 'test-recovery', 'original-baselines', `${baselineSha256.slice(7)}.json`);
}

/** Historical runner bytes only: this does not establish case-level acceptance eligibility. */
export async function appendTrpOriginalBaseline(workRoot, baseline) {
  const relative = originalBaselinePath(baseline);
  return installImmutableBytes(workRoot, relative, canonicalJson(baseline), () => readTrpOriginalBaseline(workRoot, baseline.baselineSha256));
}

export async function readTrpOriginalBaseline(workRoot, baselineSha256) {
  if (!HASH.test(baselineSha256 ?? '')) fail('Invalid original baseline digest');
  const relative = path.join('context', 'test-recovery', 'original-baselines', `${baselineSha256.slice(7)}.json`);
  const baseline = JSON.parse(await readSafe(workRoot, relative));
  if (originalBaselinePath(baseline) !== relative) fail('Original baseline does not match its requested digest');
  return baseline;
}

function checkpointPath(checkpoint) {
  checkpoint = readRecord('trp-readiness-checkpoint', checkpoint).record;
  const { checkpointSha256, ...core } = checkpoint ?? {};
  if (!HASH.test(core.agreementSha256 ?? '')
    || core.evidencePurpose !== 'baseline-admission-only' || !Array.isArray(core.repositories) || !core.repositories.length
    || Object.keys(core).some((key) => !['schemaVersion', 'agreementSha256', 'evidencePurpose', 'repositories'].includes(key))
    || !HASH.test(checkpointSha256 ?? '') || trpDigest(core) !== checkpointSha256) fail('Invalid readiness repair checkpoint', 'TRP_REPAIR_EVIDENCE_INVALID');
  const required = ['repositoryId', 'status', 'baseCommit', 'originalBaseCommit', 'featureBaseCommit',
    'receiptSha256', 'sourceManifestSha256', 'planId', 'platform', 'arch', 'originalBaselineRefs', 'repairedBaselineRefs'];
  if (new Set(core.repositories.map((row) => row?.repositoryId)).size !== core.repositories.length) fail('Readiness checkpoint repeats a repository');
  for (const row of core.repositories) {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== required.length
      || required.some((key) => !Object.hasOwn(row, key)) || !ID.test(row.repositoryId ?? '') || row.status !== 'pass'
      || ['baseCommit', 'originalBaseCommit', 'featureBaseCommit'].some((key) => !OID.test(row[key] ?? ''))
      || ['receiptSha256', 'sourceManifestSha256', 'planId'].some((key) => !HASH.test(row[key] ?? ''))
      || ['platform', 'arch'].some((key) => typeof row[key] !== 'string' || !row[key])
      || ['originalBaselineRefs', 'repairedBaselineRefs'].some((key) => !Array.isArray(row[key])
        || row[key].some((value) => !HASH.test(value)) || new Set(row[key]).size !== row[key].length)
      || !row.repairedBaselineRefs.length) fail('Readiness checkpoint contains an invalid repository binding', 'TRP_REPAIR_EVIDENCE_INVALID');
  }
  return path.join('context', 'test-recovery', 'readiness-checkpoints', `${checkpointSha256.slice(7)}.json`);
}

export async function appendTrpReadinessCheckpoint(workRoot, checkpoint) {
  const relative = checkpointPath(checkpoint);
  return installImmutableBytes(workRoot, relative, canonicalJson(checkpoint), () => readTrpReadinessCheckpoint(workRoot, checkpoint.checkpointSha256));
}

export async function readTrpReadinessCheckpoint(workRoot, checkpointSha256) {
  if (!HASH.test(checkpointSha256 ?? '')) fail('Invalid readiness checkpoint digest');
  const relative = path.join('context', 'test-recovery', 'readiness-checkpoints', `${checkpointSha256.slice(7)}.json`);
  const checkpoint = JSON.parse(await readSafe(workRoot, relative));
  if (checkpointPath(checkpoint) !== relative) fail('Readiness checkpoint does not match its requested digest');
  return checkpoint;
}

export async function loadTrpRecords(workRoot) {
  const records = [];
  for (const [kind, directory] of Object.entries(DIRECTORIES)) {
    const relativeDirectory = path.join('context', 'test-recovery', directory);
    let entries;
    try {
      // Checking a sentinel path validates all ancestors, including the category directory.
      const checked = await safeFile(workRoot, path.join(relativeDirectory, 'inventory-sentinel.json'));
      entries = await readdir(path.dirname(checked.target), { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) fail('TRP record inventory contains a non-file');
      safeId(entry.name.slice(0, -5));
      const relative = path.join(relativeDirectory, entry.name);
      const record = JSON.parse(await readSafe(workRoot, relative));
      validateTrpRecord(record, { kind });
      if (relativeRecordPath(record) !== relative) fail('TRP record filename does not match record identity');
      records.push(record);
    }
  }
  return records;
}

function assertDelegation(record, policy, delegation) {
  if (!policy?.enabled || record.policyAuthoritySha256 && record.policyAuthoritySha256 !== policy.authoritySha256) fail('TRP authorization must use the pinned policy', 'TRP_AUTHORITY_REQUIRED');
  if (!delegation || delegation.minimumAssurance !== 'configured-local-review' || delegation.minimum !== 1
    || !Array.isArray(delegation.authorities) || !delegation.authorities.length) fail('This host requires explicit single-approver terminal review delegation', 'TRP_AUTHORITY_REQUIRED');
  if (record.kind === 'phase-risk-decision' && (!policy.enabledRiskCategories.includes(record.category)
    || !delegation.categories?.includes(record.category)
    || !record.transitions.every((transition) => delegation.transitions?.includes(transition)))) fail('The exact risk category and transitions are not delegated', 'TRP_AUTHORITY_REQUIRED');
  if (!['story-test-recovery-agreement', 'phase-risk-decision', 'test-selection-manifest'].includes(record.kind)) fail('This record kind has no supported human authorization operation');
}
function capability(record) { return record.kind === 'phase-risk-decision' ? 'trp-risk-decision' : record.kind === 'test-selection-manifest' ? 'trp-scope-confirmation' : 'trp-agreement'; }

/** Deterministic review card; the terminal channel presents these exact sealed bytes. */
export function trpAuthorityReview(record, policy) {
  validateTrpRecord(record);
  const confirmationSha256 = record.confirmationSha256 ?? record.confirmedPlanSha256;
  if (!HASH.test(confirmationSha256 ?? '')) fail('An exact reviewed confirmation digest is required');
  const planHash = trpDigest({ record, policyAuthoritySha256: policy.authoritySha256, confirmationSha256 });
  const plan = { planId: `trp-${planHash.slice(7, 31)}`, planHash, subject: record.subject,
    revision: record.revision ?? record.subject.validationEpoch, record, policyAuthoritySha256: policy.authoritySha256 };
  const action = { actionId: `authorize-${record.id}`, kind: capability(record), recordSha256: record.recordSha256,
    confirmation: { required: true }, permittedTransitions: record.transitions ?? [] };
  return { plan, action };
}

// A committed public receipt is evidence of its bytes, not of terminal presentation.
// This private, checkout-local MAC survives process restarts but is never published.
// Missing origin (including another host/clone) requires fresh terminal review. The
// assurance remains configured-local-review: it does not authenticate a human to a
// remote service or defend against an owner who compromises this host's private key.
async function originRoot(root, { create = false } = {}) {
  const storage = await realpath(gitDir(root));
  const relative = path.join('singularity-flow', 'trp-review-origins', 'sentinel');
  const checked = await safeFile(storage, relative, { createParents: create, parentMode: 0o700 });
  const directory = path.dirname(checked.target);
  const info = await lstat(directory);
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
    fail('Local review origin storage must be private to the current host user', 'TRP_AUTHORITY_ORIGIN_UNAVAILABLE');
  }
  return directory;
}

async function readOriginBytes(directory, name) {
  const { info } = await safeFile(directory, name);
  if (!info || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())))) {
    fail('Local review origin must be an owner-private ordinary file', 'TRP_AUTHORITY_ORIGIN_UNAVAILABLE');
  }
  return readSafe(directory, name);
}

async function installOriginBytes(directory, name, bytes) {
  const { target, info } = await safeFile(directory, name);
  if (info) return readOriginBytes(directory, name);
  const temporary = `${target}.pending-${randomUUID()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let complete = false;
  try {
    await handle.writeFile(bytes); await handle.sync();
    try { await link(temporary, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let parent;
    try { parent = await open(directory, constants.O_RDONLY); await parent.sync(); }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes(error.code)) throw error; }
    finally { await parent?.close(); }
    complete = true;
    return await readOriginBytes(directory, name);
  } finally { await handle.close(); if (complete) await unlink(temporary); }
}

async function originBinding(root, workRoot, receipt) {
  const repository = await realpath(root);
  const work = await realpath(workRoot);
  const relative = path.relative(repository, work);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('Local review origin must belong to the exact Story checkout', 'TRP_AUTHORITY_ORIGIN_UNAVAILABLE');
  }
  return canonicalJson({ purpose: 'trp-configured-local-terminal-review-origin', repository, work,
    receiptSha256: receipt.recordSha256, authorizedRecordSha256: receipt.authorizedRecordSha256 });
}

async function retainReviewOrigin(root, workRoot, receipt) {
  const directory = await originRoot(root, { create: true });
  const secret = await installOriginBytes(directory, 'origin.key', randomBytes(32).toString('hex'));
  if (!/^[a-f0-9]{64}$/u.test(secret)) fail('Local review origin key is invalid', 'TRP_AUTHORITY_ORIGIN_UNAVAILABLE');
  const proof = createHmac('sha256', Buffer.from(secret, 'hex')).update(await originBinding(root, workRoot, receipt)).digest('hex');
  const saved = await installOriginBytes(directory, `${receipt.recordSha256.slice(7)}.origin`, proof);
  if (saved !== proof) fail('Local review origin differs from the live terminal witness', 'TRP_AUTHORITY_ORIGIN_UNAVAILABLE');
}

async function hasReviewOrigin(root, workRoot, receipt) {
  try {
    const directory = await originRoot(root);
    const secret = await readOriginBytes(directory, 'origin.key');
    const proof = await readOriginBytes(directory, `${receipt.recordSha256.slice(7)}.origin`);
    if (!/^[a-f0-9]{64}$/u.test(secret) || !/^[a-f0-9]{64}$/u.test(proof)) return false;
    const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update(await originBinding(root, workRoot, receipt)).digest();
    return timingSafeEqual(expected, Buffer.from(proof, 'hex'));
  } catch { return false; }
}

/** Public JSON receipts and issueActionAuthorization alone cannot produce this witness. */
export async function consumeTrpAuthority(root, { record, policy, pinnedAuthorities, delegation, review, token }) {
  validateTrpRecord(record);
  assertDelegation(record, policy, delegation);
  const expected = trpAuthorityReview(record, policy);
  if (canonicalJson(expected) !== canonicalJson(review)) fail('TRP review changed; present the exact current plan again', 'TRP_REVIEW_STALE');
  const authorization = await consumeActionAuthorization(root, token, expected.plan, expected.action, { requireTerminalPresentation: true });
  const match = requireApprovalAuthority(pinnedAuthorities, { authorities: delegation.authorities }, authorization.actor);
  if (!principal(authorization.actor) || principal(authorization.actor) !== record.issuer.principal.toLowerCase()) fail('Human decision principal does not match the reviewed record', 'TRP_AUTHORITY_REQUIRED');
  const receipt = sealTrpRecord({ schemaVersion: 1, kind: 'trp-authority-receipt', id: authorization.authorizationId,
    subject: record.subject, createdAt: authorization.createdAt, issuer: record.issuer,
    provenance: { authorityRef: record.provenance.authorityRef, evidenceRefs: [record.recordSha256] },
    authorizedRecordSha256: record.recordSha256, policyAuthoritySha256: policy.authoritySha256,
    confirmationSha256: record.confirmationSha256 ?? record.confirmedPlanSha256, capability: capability(record), transitions: record.transitions ?? [],
    issuedAt: authorization.createdAt, authorizationRef: record.authorizationRef ?? authorization.authorizationId,
    authorityGroup: match.authorityGroup, assurance: authorization.assurance, reviewPlanSha256: expected.plan.planHash,
    reviewActionId: expected.action.actionId, actionAuthorizationId: authorization.authorizationId,
    questionId: authorization.questionId, answerReceipt: authorization.answerReceipt,
    actor: { name: authorization.actor.name, email: authorization.actor.email ?? null, login: authorization.actor.login ?? null } });
  const witness = Object.freeze({ authorizationRef: receipt.authorizationRef, authorizedRecordSha256: record.recordSha256 });
  WITNESSES.set(witness, { root, receipt });
  return witness;
}

export async function appendTrpAuthorityReceipt(workRoot, witness) {
  const witnessed = WITNESSES.get(witness);
  if (!witnessed) fail('Only a consumed live human review may create an authority receipt', 'TRP_AUTHORITY_REQUIRED');
  const { root, receipt } = witnessed;
  await retainReviewOrigin(root, workRoot, receipt);
  const stored = await appendRecordBytes(workRoot, receipt);
  return { ...stored, receipt };
}

/**
 * Preloads authenticated immutable receipt bindings. No fetch or push occurs here.
 * remoteAcknowledgedCommit is trusted transport output, not a user assertion. An
 * upstream tracking ref by itself is deliberately insufficient for acknowledgement.
 */
export async function loadTrpAuthorityVerifier({ root, workRoot, policy, pinnedAuthorities, delegation,
  localCommit, remoteAcknowledgedCommit = null, localOnly = false, records = null, revokedAtByRecord = new Map() }) {
  if (!OID.test(localCommit ?? '')) fail('An exact committed transaction is required', 'TRP_PUBLICATION_UNVERIFIED');
  if (localOnly !== true) {
    if (!OID.test(remoteAcknowledgedCommit ?? '')) fail('The exact transaction requires remote acknowledgement', 'TRP_PUBLICATION_PENDING');
    const env = { ...withoutGitProcessOverrides(process.env), GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
    if (!gitIsAncestor(root, localCommit, remoteAcknowledgedCommit, { env })) fail('Acknowledged commit does not contain the exact transaction', 'TRP_PUBLICATION_PENDING');
  }
  const repositoryRoot = await realpath(root);
  const actualWorkRoot = await realpath(workRoot);
  const workRelative = path.relative(repositoryRoot, actualWorkRoot);
  if (workRelative === '..' || workRelative.startsWith(`..${path.sep}`) || path.isAbsolute(workRelative)) fail('TRP work root is outside its governed repository');
  const loaded = records ?? await loadTrpRecords(workRoot);
  const authenticated = new Map();
  const committed = (record) => {
    const relative = path.join(workRelative, relativeRecordPath(record)).split(path.sep).join('/');
    const bytes = exactFileAtObject(root, localCommit, relative, { maximumBytes: 4 * 1024 * 1024 });
    if (!bytes) return false;
    try {
      const saved = JSON.parse(bytes.toString('utf8')); validateTrpRecord(saved, { kind: record.kind });
      return canonicalJson(saved) === canonicalJson(record);
    } catch { return false; }
  };
  for (const receipt of loaded.filter((record) => record.kind === 'trp-authority-receipt')) {
    validateTrpRecord(receipt);
    const record = loaded.find((candidate) => candidate.recordSha256 === receipt.authorizedRecordSha256);
    if (!record || !committed(record) || !committed(receipt) || !await hasReviewOrigin(root, workRoot, receipt)) continue;
    try {
      validateTrpRecord(record); assertDelegation(record, policy, delegation);
      const match = requireApprovalAuthority(pinnedAuthorities, { authorities: delegation.authorities }, receipt.actor);
      const review = trpAuthorityReview(record, policy);
      if (receipt.policyAuthoritySha256 !== policy.authoritySha256 || receipt.authorityGroup !== match.authorityGroup
        || receipt.reviewPlanSha256 !== review.plan.planHash || receipt.reviewActionId !== review.action.actionId
        || receipt.capability !== capability(record) || receipt.confirmationSha256 !== (record.confirmationSha256 ?? record.confirmedPlanSha256)
        || principal(receipt.actor) !== record.issuer.principal.toLowerCase()
        || receipt.issuer.principal !== record.issuer.principal || canonicalJson(receipt.subject) !== canonicalJson(record.subject)
        || canonicalJson([...receipt.transitions].sort()) !== canonicalJson([...(record.transitions ?? [])].sort())
        || (record.authorizationRef && record.authorizationRef !== receipt.authorizationRef)) continue;
      authenticated.set(record.recordSha256, Object.freeze({ recordSha256: record.recordSha256, principal: record.issuer.principal,
        policyAuthoritySha256: policy.authoritySha256, confirmationSha256: receipt.confirmationSha256, capability: receipt.capability,
        transitions: receipt.transitions, issuedAt: receipt.issuedAt, revokedAt: revokedAtByRecord.get(record.recordSha256) ?? null,
        durable: true, authorizationRef: receipt.authorizationRef }));
    } catch { /* A malformed or no-longer-delegated receipt is not an authority. */ }
  }
  return (record, context) => {
    const receipt = authenticated.get(record.recordSha256);
    return receipt && context.policy.authoritySha256 === policy.authoritySha256 ? receipt : null;
  };
}

export const TRP_STORAGE_DIRECTORIES = DIRECTORIES;
