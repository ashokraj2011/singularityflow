import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';

import { gitCommonDir } from './git.mjs';
import { prepareSharedPublicationStorage } from './publication-storage.mjs';
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const MACHINE_LOCAL_PUBLICATION_INTEGRITY_SCHEME =
  'machine-local-hmac-sha256-v1';

function unsafeStorage(target) {
  return new SingularityFlowError(
    `Pending-publication integrity storage must use real Git-local directories and a regular key file: ${target}`,
    { code: 'PUBLICATION_RECOVERY_STORAGE_UNSAFE' }
  );
}

async function safeRuntime(root, { create = false } = {}) {
  const common = gitCommonDir(root);
  const runtime = path.join(common, 'singularity-flow');
  if (create) {
    // Reuse the publication storage boundary rather than recursively creating a raw path. Besides
    // preparing the pending store used by the same transaction, this proves that every controlled
    // component is a real directory below the canonical Git common directory.
    await prepareSharedPublicationStorage(
      root, 'pending-publication', 'Pending-publication integrity'
    );
    return runtime;
  }
  let info;
  try { info = await lstat(runtime); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeStorage(runtime);
  const expected = path.join(await realpath(common), 'singularity-flow');
  if (await realpath(runtime) !== expected) throw unsafeStorage(runtime);
  return runtime;
}

export async function machineLocalPublicationIntegrityKey(root, { create = false } = {}) {
  const runtime = await safeRuntime(root, { create });
  if (!runtime) return null;
  const target = path.join(runtime, 'pending-publication-integrity.key');
  let info;
  try {
    info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw unsafeStorage(target);
    const key = Buffer.from((await readFile(target, 'utf8')).trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch (error) {
    if (error?.code === 'ENOENT' && create) {
      // Continue into the atomic create below.
    } else if (error?.code === 'ENOENT') return null;
    else throw error;
  }
  const encoded = randomBytes(32).toString('base64');
  try { await writeFile(target, `${encoded}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw unsafeStorage(target);
  const key = Buffer.from((await readFile(target, 'utf8')).trim(), 'base64');
  return key.length === 32 ? key : null;
}

function payload(purpose, record) {
  const { machineLocalIntegrity: _integrity, ...value } = record ?? {};
  return `sha256:${recordSha256({ purpose, payload: value })}`;
}

/** Seal machine-local publication/recovery evidence with a purpose-separated repository key. */
export async function sealMachineLocalPublicationReceipt(root, purpose, record) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(String(purpose ?? ''))
      || !record || typeof record !== 'object' || Array.isArray(record)) {
    throw new SingularityFlowError('Machine-local publication receipt input is invalid.');
  }
  const key = await machineLocalPublicationIntegrityKey(root, { create: true });
  if (!key) throw new SingularityFlowError('Machine-local publication integrity key is unavailable.');
  return {
    ...record,
    machineLocalIntegrity: {
      scheme: MACHINE_LOCAL_PUBLICATION_INTEGRITY_SCHEME,
      purpose,
      keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
      mac: `sha256:${createHmac('sha256', key).update(payload(purpose, record)).digest('hex')}`
    }
  };
}

export async function verifyMachineLocalPublicationReceipt(root, purpose, record) {
  const integrity = record?.machineLocalIntegrity;
  const key = await machineLocalPublicationIntegrityKey(root);
  if (!key || integrity?.scheme !== MACHINE_LOCAL_PUBLICATION_INTEGRITY_SCHEME
      || integrity.purpose !== purpose
      || integrity.keyId !== createHash('sha256').update(key).digest('hex').slice(0, 16)
      || !/^sha256:[0-9a-f]{64}$/.test(integrity.mac ?? '')) return false;
  const expected = Buffer.from(
    createHmac('sha256', key).update(payload(purpose, record)).digest('hex'), 'hex'
  );
  const actual = Buffer.from(integrity.mac.slice('sha256:'.length), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
