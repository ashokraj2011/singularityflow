/** A same-checkout live review witness. Git/JSON hashes alone cannot manufacture human consent. */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink, readdir } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { gitDir } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { consumeActionAuthorization } from './action-authorization.mjs';

const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = () => { throw new SingularityFlowError('Live human review origin is unavailable. Re-present the exact retained decision in an authorized human terminal.', { code: 'PHASE_APPEAL_REATTEST_REQUIRED' }); };
async function syncDirectory(parent) {
  let handle;
  try { handle = await open(parent, constants.O_RDONLY); await handle.sync(); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}
async function directory(root, create) {
  let value = await realpath(gitDir(root));
  for (const name of ['singularity-flow', 'phase-appeal-review-origins']) {
    value = path.join(value, name);
    if (create) { try { await mkdir(value, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = await lstat(value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (name === 'phase-appeal-review-origins' && process.platform !== 'win32'
        && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) fail();
  }
  return value;
}
async function privateFile(parent, name, initial = null) {
  if (!/^[a-z0-9.-]+$/u.test(name) || /[. ]$/u.test(name)) fail();
  const target = path.join(parent, name);
  if (initial !== null) {
    const temporary = `${target}.${randomUUID()}`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(initial); await handle.sync();
      try { await link(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { await handle.close(); await unlink(temporary); }
    await syncDirectory(parent);
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128
      || (process.platform !== 'win32' && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())))) fail();
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (before.ino !== stat.ino || before.dev !== stat.dev) fail();
    const value = await handle.readFile('utf8');
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
    return value;
  } finally { await handle.close(); }
}
async function proofBinding(root, record) {
  return canonicalJson({ purpose: 'phase-appeal-review/v1', repository: await realpath(root), recordSha256: digest(record) });
}
const proofName = (record, key) => `${digest(record)}-${createHash('sha256').update(key).digest('hex')}.origin`;
async function retain(root, record) {
  const parent = await directory(root, true);
  // Each live ceremony has a fresh private key. Key loss/corruption never traps the operator in
  // a re-attestation loop, and a new review does not overwrite older witnesses.
  const seed = randomBytes(32).toString('hex');
  const keyId = createHash('sha256').update(seed).digest('hex');
  const key = await privateFile(parent, `${keyId}.key`, seed);
  if (!/^[a-f0-9]{64}$/u.test(key)) fail();
  const proof = createHmac('sha256', Buffer.from(key, 'hex')).update(await proofBinding(root, record)).digest('hex');
  if (await privateFile(parent, proofName(record, key), proof) !== proof) fail();
}
/** The live terminal witness is consumed here, not inferred from the record supplied by callers. */
export async function consumeAndRetainHumanReview(root, record, card, token) {
  const grant = await consumeActionAuthorization(root, token, card.plan, card.action, { requireTerminalPresentation: true });
  const reviewer = card.plan.reviewer ?? record.actor;
  if (String(reviewer).toLowerCase() !== String(grant.actor.login ?? grant.actor.email ?? grant.actor.name ?? '').trim().toLowerCase()) fail();
  await retain(root, record);
  return grant;
}
export async function humanReviewOriginPresent(root, record) {
  try {
    const parent = await directory(root, false);
    const prefix = `${digest(record)}-`;
    const candidates = (await readdir(parent)).filter(name => name.startsWith(prefix) && /^[a-f0-9]{64}-[a-f0-9]{64}\.origin$/u.test(name)).slice(0, 128);
    for (const name of candidates) {
      try {
        const keyId = name.slice(prefix.length, -7);
        const key = await privateFile(parent, `${keyId}.key`);
        const proof = await privateFile(parent, name);
        if (!/^[a-f0-9]{64}$/u.test(key) || !/^[a-f0-9]{64}$/u.test(proof)
            || createHash('sha256').update(key).digest('hex') !== keyId) continue;
        const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(await proofBinding(root, record)).digest();
        if (timingSafeEqual(expected, Buffer.from(proof, 'hex'))) return true;
      } catch { /* A missing/invalid older witness needs fresh live review, not history repair. */ }
    }
    return false;
  } catch { return false; }
}
