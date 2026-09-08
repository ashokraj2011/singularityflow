import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitCommitIdentity } from './git.mjs';
import {
  GitRemoteSession, requireRemoteObservation, runRemoteGitAsync
} from './git-execution.mjs';
import { assertCredentialFreeRemote } from './git-remote-diagnostics.mjs';
import { recordSha256 } from './records.mjs';
import { createRepoContext } from './repo-context.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { nowIso, run, SingularityFlowError, writeJson } from './util.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REF = /^refs\/heads\/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, ...(details == null ? {} : { details }) });
}

function journalFile(identity, operationId) {
  return path.join(identity.commonDir, 'singularity-flow', 'fos', 'remote-publications',
    `${operationId}.json`);
}

function normalizeInput(input, actor) {
  const remote = String(input?.remote ?? '').trim();
  const ref = String(input?.ref ?? '').trim();
  const candidateOid = String(input?.candidateOid ?? '').trim();
  const expectedOid = input?.expectedOid == null ? null : String(input.expectedOid).trim();
  if (!remote || !REF.test(ref) || ref.includes('..') || ref.endsWith('.lock')
      || !OID.test(candidateOid) || (expectedOid != null && !OID.test(expectedOid))
      || !SHA256.test(input?.authorizationSha256 ?? '')) {
    fail('FOS remote publication requires one remote, branch ref, full candidate/expected OID and authorization digest.',
      'FOS_REMOTE_PUBLICATION_INVALID');
  }
  return Object.freeze({
    kind: 'fos-remote-publication',
    remote: assertCredentialFreeRemote(remote),
    ref,
    candidateOid,
    expectedOid,
    authorizationSha256: input.authorizationSha256,
    actorBinding: Object.freeze({ name: actor.name ?? null, email: actor.email ?? null })
  });
}

function requestIdentity(request) {
  const requestDigest = `sha256:${recordSha256(request)}`;
  return Object.freeze({
    requestDigest,
    operationId: `fos-remote-${requestDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`
  });
}

function exactLocalCommit(root, oid, label) {
  const result = run('git', ['rev-parse', '--verify', `${oid}^{commit}`], {
    cwd: root, allowFailure: true
  });
  if (result.status !== 0 || result.stdout.trim() !== oid) fail(
    `${label} '${oid}' is not an available exact local commit.`, 'FOS_REMOTE_PUBLICATION_INVALID'
  );
}

function proveAncestry(root, expectedOid, candidateOid) {
  if (!expectedOid) return;
  exactLocalCommit(root, expectedOid, 'Expected parent');
  const result = run('git', ['merge-base', '--is-ancestor', expectedOid, candidateOid], {
    cwd: root, allowFailure: true
  });
  if (result.status !== 0) fail(
    `Candidate ${candidateOid.slice(0, 12)} does not extend expected parent ${expectedOid.slice(0, 12)}.`,
    'FOS_REMOTE_NON_FAST_FORWARD'
  );
}

async function observedOid(session, remote, ref, { refresh = true } = {}) {
  const observed = await session.observeAsync(remote, {
    refs: [ref], includeHead: false, refresh
  });
  requireRemoteObservation(observed, 'FOS publication authority');
  return observed.refs.get(ref) ?? null;
}

async function readJournal(identity, operationId) {
  try {
    const record = readRecord('fos-remote-publication-journal',
      await readFile(journalFile(identity, operationId), 'utf8')).record;
    if (record.kind !== 'fos-remote-publication-journal') fail(
      'FOS remote publication journal has an invalid kind.', 'FOS_REMOTE_PUBLICATION_INVALID'
    );
    return record;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sealedReceipt(request, identity, { disposition, observedOid: actualOid, recordedAt }) {
  const body = {
    schemaVersion: currentSchemaVersion('fos-remote-publication-receipt'),
    kind: 'fos-remote-publication-receipt',
    operationId: identity.operationId,
    requestDigest: identity.requestDigest,
    ref: request.ref,
    candidateOid: request.candidateOid,
    expectedOid: request.expectedOid,
    observedOid: actualOid,
    authorizationSha256: request.authorizationSha256,
    disposition,
    recordedAt
  };
  return Object.freeze({ ...body, receiptSha256: `sha256:${recordSha256(body)}` });
}

export function fosRemotePublicationIdentity(input, actor) {
  return requestIdentity(normalizeInput(input, actor));
}

/**
 * Publish one exact commit to one exact remote branch. This primitive never derives a tracking-ref
 * lease, never rewrites ancestry and never treats a push error as success without re-observing the
 * exact target. The caller supplies a fresh kernel guard; this transport cannot manufacture it.
 */
export async function publishFosRemoteRef(root, input, {
  operationId = null,
  publicationGuard,
  beforePush = null,
  afterPush = null,
  session = new GitRemoteSession()
} = {}) {
  const context = createRepoContext(root, { cache: false });
  const repository = await context.identity();
  const actor = gitCommitIdentity(root);
  const request = normalizeInput(input, actor);
  const identity = requestIdentity(request);
  if (operationId != null && operationId !== identity.operationId) fail(
    `Operation '${operationId}' does not match this remote publication request '${identity.operationId}'.`,
    'IDEMPOTENCY_CONFLICT', { expectedOperationId: identity.operationId }
  );
  if (typeof publicationGuard !== 'function') fail(
    'FOS remote publication requires a fresh trusted publication guard.', 'TRUST_REQUIRED'
  );
  exactLocalCommit(root, request.candidateOid, 'Candidate');
  proveAncestry(root, request.expectedOid, request.candidateOid);

  const lockId = createHash('sha256').update(`${request.remote}\0${request.ref}`).digest('hex');
  return withSubjectLock(root, { kind: 'fos-remote-publication', id: lockId }, async () => {
    const prior = await readJournal(repository, identity.operationId);
    if (prior && prior.requestDigest !== identity.requestDigest) fail(
      `Operation '${identity.operationId}' was already used with different publication inputs.`,
      'IDEMPOTENCY_CONFLICT'
    );
    const initialOid = await observedOid(session, request.remote, request.ref);
    if (initialOid === request.candidateOid) {
      if (prior?.phase === 'completed' && prior.receipt) {
        return Object.freeze({
          status: 'reconciled', published: false, operationId: identity.operationId,
          receipt: Object.freeze(structuredClone(prior.receipt))
        });
      }
      const authorizedReplay = ['authorized', 'recovery-required'].includes(prior?.phase)
        && prior?.authorization?.authorized === true
        && prior.authorization.requestDigest === identity.requestDigest
        && prior.authorization.authorizationSha256 === request.authorizationSha256;
      if (!authorizedReplay) fail(
        `Remote authority '${request.ref}' already contains the candidate without a matching authorized operation journal.`,
        'IDEMPOTENCY_CONFLICT'
      );
      const receipt = sealedReceipt(request, identity, {
        disposition: 'reconciled-after-interruption',
        observedOid: initialOid,
        recordedAt: nowIso()
      });
      await writeJson(journalFile(repository, identity.operationId), {
        ...prior,
        schemaVersion: currentSchemaVersion('fos-remote-publication-journal'),
        phase: 'completed',
        receipt,
        failureCode: null,
        updatedAt: nowIso()
      });
      return Object.freeze({
        status: receipt.disposition, published: false,
        operationId: identity.operationId, receipt
      });
    }
    if (initialOid !== request.expectedOid) fail(
      `Remote authority '${request.ref}' moved before publication.`, 'AUTHORITY_MOVED', {
        expectedOid: request.expectedOid, actualOid: initialOid
      }
    );
    const startedAt = prior?.startedAt ?? nowIso();
    let journal = {
      schemaVersion: currentSchemaVersion('fos-remote-publication-journal'),
      kind: 'fos-remote-publication-journal',
      operationId: identity.operationId,
      requestDigest: identity.requestDigest,
      request,
      phase: 'prepared',
      startedAt,
      updatedAt: nowIso(),
      receipt: null,
      failureCode: null
    };
    await writeJson(journalFile(repository, identity.operationId), journal);
    try {
      const authorization = await publicationGuard(Object.freeze({
        ...structuredClone(request),
        operationId: identity.operationId,
        requestDigest: identity.requestDigest,
        observedRemoteOid: initialOid
      }));
      if (authorization?.authorized !== true
          || authorization?.requestDigest !== identity.requestDigest
          || authorization?.authorizationSha256 !== request.authorizationSha256) fail(
        'The publication guard did not return an exact, current authorization binding.',
        'NOT_AUTHORIZED'
      );
      journal = {
        ...journal,
        phase: 'authorized',
        authorization: structuredClone(authorization),
        updatedAt: nowIso()
      };
      await writeJson(journalFile(repository, identity.operationId), journal);
      if (beforePush) await beforePush();
      const lease = `--force-with-lease=${request.ref}:${request.expectedOid ?? ''}`;
      const pushed = await runRemoteGitAsync([
        'push', '--porcelain', lease, '--', request.remote,
        `${request.candidateOid}:${request.ref}`
      ], { cwd: root, operation: 'remote-push' });
      if (pushed.status === 0 && afterPush) {
        await afterPush(Object.freeze({ status: pushed.status }));
      }
      session.invalidate(request.remote);
      const actualOid = await observedOid(session, request.remote, request.ref);
      if (actualOid !== request.candidateOid) {
        const failureCode = actualOid !== request.expectedOid
          ? 'AUTHORITY_MOVED' : pushed.failure?.code ?? 'REMOTE_PUBLICATION_FAILED';
        fail(pushed.status === 0
          ? `Remote publication did not retain candidate ${request.candidateOid.slice(0, 12)}.`
          : `Remote publication was rejected and '${request.ref}' is not the recorded candidate.`,
        failureCode, {
          expectedOid: request.expectedOid,
          candidateOid: request.candidateOid,
          actualOid,
          classification: pushed.failure?.classification ?? null
        });
      }
      const receipt = sealedReceipt(request, identity, {
        disposition: pushed.status === 0 ? 'published' : 'reconciled-after-push-error',
        observedOid: actualOid,
        recordedAt: nowIso()
      });
      journal = { ...journal, phase: 'completed', receipt, updatedAt: nowIso() };
      await writeJson(journalFile(repository, identity.operationId), journal);
      return Object.freeze({
        status: receipt.disposition, published: pushed.status === 0,
        operationId: identity.operationId, receipt
      });
    } catch (error) {
      await writeJson(journalFile(repository, identity.operationId), {
        ...journal,
        phase: 'recovery-required',
        failureCode: error?.code ?? 'REMOTE_UNKNOWN',
        updatedAt: nowIso()
      }).catch(() => {});
      throw error;
    }
  });
}
