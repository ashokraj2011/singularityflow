/** Same-host origin for explicit TCA review. Public JSON/Git bytes are never human consent. */
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { consumeActionAuthorization } from './action-authorization.mjs';
import { gitDir } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { testCommandAmendmentDigest, validateTestCommandAmendmentRecord } from './test-command-amendment-contracts.mjs';

function fail(message) { throw new SingularityFlowError(message, { code: 'TCA_AUTHORITY_ORIGIN_UNAVAILABLE' }); }
function principal(actor) { return String(actor?.email ?? actor?.login ?? '').trim().toLowerCase(); }
// Proof identity includes the private-key generation. Losing/replacing the key leaves old
// evidence untouched, while an explicitly reviewed replacement can publish a fresh local proof.
function proofName(review, secret) {
  return `${testCommandAmendmentDigest(review).slice(7)}-${createHash('sha256').update(secret).digest('hex')}.origin`;
}
async function privateFile(directory, name, bytes = null) {
  if (!/^[a-z0-9.-]+$/u.test(name)) fail('Invalid review origin name.');
  const target = path.join(directory, name);
  let info;
  try { info = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!info && bytes !== null) {
    const temporary = `${target}.pending-${randomUUID()}`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let complete = false;
    try {
      await handle.writeFile(bytes); await handle.sync();
      try { await link(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      let parent;
      try { parent = await open(directory, constants.O_RDONLY); await parent.sync(); }
      catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes(error.code)) throw error; }
      finally { await parent?.close(); }
      complete = true;
    } finally { await handle.close(); if (complete) await unlink(temporary); }
    info = await lstat(target);
  }
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 128
      || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())))) fail('Review origin is not a private ordinary file.');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) fail('Review origin changed while opening.');
    const value = await handle.readFile('utf8');
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('Review origin changed while reading.');
    return value;
  } finally { await handle.close(); }
}
async function originDirectory(root, create = false) {
  let directory = await realpath(gitDir(root));
  for (const name of ['singularity-flow', 'test-command-review-origins']) {
    directory = path.join(directory, name);
    if (create) { try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('Review origin directory is unsafe.');
    if (name === 'test-command-review-origins' && process.platform !== 'win32'
        && ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) fail('Review origin directory is not private.');
  }
  return directory;
}
async function originBinding(root, workRoot, review) {
  const repository = await realpath(root);
  const work = await realpath(workRoot);
  const relative = path.relative(repository, work);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('Review origin belongs to another Story checkout.');
  return canonicalJson({ purpose: 'test-command-adoption/v1', repository, work,
    reviewSha256: testCommandAmendmentDigest(review) });
}
export function testCommandReviewAuthorization(review) {
  validateTestCommandAmendmentRecord(review, { reviewCore: true });
  const planHash = testCommandAmendmentDigest(review);
  return { plan: { planId: `tca-${planHash.slice(7, 31)}`, planHash,
    subject: { workId: review.workId, phaseId: review.phaseId }, revision: review.to.validationEpoch, review },
  action: { actionId: `adopt-${review.id}`, kind: 'test-command-adoption', confirmation: { required: true } } };
}
export async function consumeTestCommandReviewAuthorization(root, workRoot, { review, token }) {
  const card = testCommandReviewAuthorization(review);
  const authorization = await consumeActionAuthorization(root, token, card.plan, card.action, { requireTerminalPresentation: true });
  if (!principal(authorization.actor) || principal(authorization.actor) !== principal(review.actor)) fail('Review actor differs from the live terminal witness.');
  const completed = { ...structuredClone(review), authorization: {
    authorizationId: authorization.authorizationId, questionId: authorization.questionId,
    answerReceipt: authorization.answerReceipt, assurance: authorization.assurance,
    planSha256: card.plan.planHash, actionId: card.action.actionId } };
  validateTestCommandAmendmentRecord(completed);
  await retainReviewOrigin(root, workRoot, completed);
  return completed;
}
async function retainReviewOrigin(root, workRoot, completed) {
  const directory = await originDirectory(root, true);
  const secret = await privateFile(directory, 'origin.key', randomBytes(32).toString('hex'));
  if (!/^[a-f0-9]{64}$/u.test(secret)) fail('Review origin key is invalid.');
  const proof = createHmac('sha256', Buffer.from(secret, 'hex')).update(await originBinding(root, workRoot, completed)).digest('hex');
  if (await privateFile(directory, proofName(completed, secret), proof) !== proof) fail('Review origin differs from the live witness.');
}

/** A different checkout re-presents the exact immutable review; no accepted record is rewritten. */
export function testCommandReviewReattestationAuthorization(review) {
  validateTestCommandAmendmentRecord(review);
  if (review.kind !== 'test-command-adoption-review') fail('Only an immutable test-command review can be re-attested.');
  const planHash = testCommandAmendmentDigest({ operation: 'reattest-test-command-review-origin', review });
  return { plan: { planId: `tca-reattest-${planHash.slice(7, 31)}`, planHash,
    subject: { workId: review.workId, phaseId: review.phaseId }, revision: review.to.validationEpoch,
    reviewSha256: testCommandAmendmentDigest(review), review },
  action: { actionId: `reattest-${review.id}`, kind: 'test-command-review-reattest', confirmation: { required: true } } };
}
export async function reattestTestCommandReviewOrigin(root, workRoot, { review, token }) {
  const card = testCommandReviewReattestationAuthorization(review);
  const authorization = await consumeActionAuthorization(root, token, card.plan, card.action, { requireTerminalPresentation: true });
  if (!principal(authorization.actor) || principal(authorization.actor) !== principal(review.actor)) fail('Only the retained reviewer can re-attest this exact local review origin.');
  await retainReviewOrigin(root, workRoot, review);
  return { reviewSha256: testCommandAmendmentDigest(review), originPresent: true };
}
export async function verifyTestCommandReviewOrigin(root, workRoot, review) {
  try {
    validateTestCommandAmendmentRecord(review);
    const core = structuredClone(review); delete core.authorization;
    const card = testCommandReviewAuthorization(core);
    if (review.authorization.planSha256 !== card.plan.planHash || review.authorization.actionId !== card.action.actionId) return false;
    const directory = await originDirectory(root);
    const secret = await privateFile(directory, 'origin.key');
    const proof = await privateFile(directory, proofName(review, secret));
    if (!/^[a-f0-9]{64}$/u.test(secret) || !/^[a-f0-9]{64}$/u.test(proof)) return false;
    const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update(await originBinding(root, workRoot, review)).digest();
    return timingSafeEqual(expected, Buffer.from(proof, 'hex'));
  } catch { return false; }
}
