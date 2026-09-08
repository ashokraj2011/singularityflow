import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { assertFosFeature } from './fos-features.mjs';
import { nowIso, SingularityFlowError, writeAtomic } from './util.mjs';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SAFE_MEDIA_TYPES = new Set([
  'text/plain', 'text/markdown', 'application/json', 'application/pdf',
  'image/png', 'image/jpeg', 'image/webp'
]);
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLAUSE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function fail(message, code) { throw new SingularityFlowError(message, { code }); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function unsafeBytes(bytes) {
  if (bytes.subarray(0, 2).toString('binary') === 'MZ') return 'windows-executable';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'elf-executable';
  if (bytes.subarray(0, 2).toString('utf8') === '#!') return 'script';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'archive';
  const magic = bytes.subarray(0, 4).readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe].includes(magic)) return 'mach-executable';
  return null;
}

async function safeStoreBoundary(commonDir, target) {
  const boundary = path.resolve(commonDir);
  const relative = path.relative(boundary, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(
    'Evidence storage target escaped the Git common directory.', 'FOS_EVIDENCE_PATH_INVALID'
  );
  let current = path.dirname(target);
  while (current !== boundary) {
    const info = await lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) fail('Evidence storage path contains a symbolic link.', 'FOS_EVIDENCE_PATH_INVALID');
    const parent = path.dirname(current);
    if (parent === current) fail('Evidence storage boundary could not be verified.', 'FOS_EVIDENCE_PATH_INVALID');
    current = parent;
  }
}

async function stableRead(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) fail('Evidence input must be one regular non-symbolic-link file.', 'FOS_EVIDENCE_INPUT_INVALID');
  if (info.size > MAX_ATTACHMENT_BYTES) fail(`Evidence exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit.`, 'LIMIT_EXCEEDED');
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size) {
      fail('Evidence source changed while it was being ingested.', 'SNAPSHOT_CHANGED');
    }
    return bytes;
  } finally { await handle.close(); }
}

export async function ingestFosEvidence(root, {
  file = null, bytes: suppliedBytes = null, mediaType, workId, clauseIds = [],
  origin = 'drop', actor, consent, features = {}
} = {}) {
  assertFosFeature(features, 'evidence-ingestion');
  if (!consent?.localStorage || consent?.externalTransmission === true) fail(
    'Evidence ingestion requires explicit local-storage consent and never accepts implicit external transmission.',
    'FOS_EVIDENCE_CONSENT_REQUIRED'
  );
  if (!WORK_ID.test(workId ?? '') || !Array.isArray(clauseIds) || !clauseIds.length
      || clauseIds.some((id) => !CLAUSE_ID.test(id))) fail(
    'Evidence must be associated with one Work ID and one or more explicit clause IDs.',
    'FOS_EVIDENCE_SCOPE_REQUIRED'
  );
  if (!SAFE_MEDIA_TYPES.has(mediaType)) fail(`Evidence media type '${mediaType ?? ''}' is not allowed.`, 'FOS_EVIDENCE_TYPE_UNSUPPORTED');
  if ((file == null) === (suppliedBytes == null)) fail('Supply exactly one evidence file or in-memory paste.', 'FOS_EVIDENCE_INPUT_INVALID');
  const bytes = file == null
    ? Buffer.isBuffer(suppliedBytes) ? Buffer.from(suppliedBytes) : Buffer.from(String(suppliedBytes), 'utf8')
    : await stableRead(path.resolve(file));
  if (bytes.length > MAX_ATTACHMENT_BYTES) fail(`Evidence exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit.`, 'LIMIT_EXCEEDED');
  const unsafe = bytes.length >= 4 ? unsafeBytes(bytes) : null;
  if (unsafe) fail(`Evidence input is an unsupported executable or archive (${unsafe}).`, 'FOS_EVIDENCE_TYPE_UNSUPPORTED');
  const digest = sha256(bytes);
  const commonDir = path.resolve(root, gitCommonDir(root));
  const base = path.join(commonDir, 'singularity-flow', 'evidence', 'fos', 'v1');
  const object = path.join(base, 'objects', 'sha256', digest.slice(0, 2), digest);
  await safeStoreBoundary(commonDir, object);
  await mkdir(path.dirname(object), { recursive: true, mode: 0o700 });
  const existing = await readFile(object).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && !existing.equals(bytes)) fail('Evidence content-address collision.', 'FOS_EVIDENCE_STORE_COLLISION');
  if (!existing) await writeAtomic(object, bytes, { mode: 0o600 });
  const receipt = {
    schemaVersion: currentSchemaVersion('fos-evidence-attachment'),
    kind: 'fos-evidence-attachment',
    receiptId: `fos-evidence-${randomUUID()}`,
    workId,
    clauseIds: [...new Set(clauseIds)].sort(),
    contentSha256: `sha256:${digest}`,
    mediaType,
    byteCount: bytes.length,
    origin,
    attachmentActor: { principalId: String(actor?.principalId ?? '').trim() || null },
    recordedAt: nowIso(),
    assurance: 'attached/unverified',
    authoritative: false,
    executed: false,
    transmittedExternally: false
  };
  const withDigest = { ...receipt, receiptSha256: `sha256:${recordSha256(receipt)}` };
  const receiptPath = path.join(base, 'receipts', workId, `${withDigest.receiptId}.json`);
  await safeStoreBoundary(commonDir, receiptPath);
  await writeAtomic(receiptPath, `${JSON.stringify(withDigest, null, 2)}\n`, { mode: 0o600 });
  const verified = readRecord('fos-evidence-attachment', await readFile(receiptPath)).record;
  const { receiptSha256, ...receiptBody } = verified;
  if (receiptSha256 !== withDigest.receiptSha256
      || receiptSha256 !== `sha256:${recordSha256(receiptBody)}`) {
    fail('Evidence receipt verification failed.', 'FOS_EVIDENCE_STORE_VERIFY_FAILED');
  }
  return Object.freeze({ status: 'attached/unverified', receipt: Object.freeze(verified) });
}

export { MAX_ATTACHMENT_BYTES as FOS_MAX_ATTACHMENT_BYTES, SAFE_MEDIA_TYPES as FOS_SAFE_MEDIA_TYPES };
