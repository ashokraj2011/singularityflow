/** Candidate-bound, bounded exact-source expansion for observe-only CMP reads. */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readlink } from 'node:fs/promises';

import { recordSha256 } from '../records.mjs';
import { SingularityFlowError, run, secureRepositoryPath } from '../util.mjs';
import { validateChangeRegionManifest } from './contracts.mjs';

export const CMP_SOURCE_EXPANSION_LIMITS = Object.freeze({
  defaultPageBytes: 16 * 1024,
  maximumPageBytes: 64 * 1024,
  maximumSourceBytes: 1024 * 1024
});

const SIDES = new Set(['before', 'after']);
const EXPANDABLE_TYPES = new Set(['regular-file', 'symlink']);
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/u;
const REFERENCE = /^sfref:comprehension:source:([^:]+):(before|after):([a-f0-9]{64})$/u;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalSha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function assertManifest(manifest) {
  const result = validateChangeRegionManifest(manifest);
  if (!result.valid) {
    fail('Exact source expansion requires one hash-valid current change-region manifest.',
      'CMP_SOURCE_MANIFEST_INVALID', { failures: result.failures });
  }
  return manifest;
}

function sourceDescriptor(manifest, region, side) {
  if (!SIDES.has(side)) fail(`Unknown source side '${side}'. Use before or after.`, 'CMP_SOURCE_SIDE_INVALID');
  const suffix = side === 'before' ? 'Before' : 'After';
  const path = region?.location?.[`path${suffix}`] ?? null;
  const fileType = region?.location?.[`fileType${suffix}`] ?? 'missing';
  const gitObject = region?.location?.[`gitObject${suffix}`] ?? null;
  const contentSha256 = region?.location?.[`content${suffix}Sha256`] ?? null;
  if (!path || !EXPANDABLE_TYPES.has(fileType)) return null;
  if (side === 'before' && !GIT_OBJECT.test(String(gitObject ?? ''))) return null;
  if (side === 'after' && !SHA256.test(String(contentSha256 ?? ''))) return null;
  return {
    schemaVersion: 1, // schema-transient: opaque read reference; never persisted or authorized
    kind: 'comprehension-source-reference',
    candidateSha256: manifest.compatibilityCandidateSha256,
    manifestSha256: manifest.manifestSha256,
    regionId: region.regionId,
    regionSha256: region.regionSha256,
    side,
    path,
    fileType,
    gitObject: GIT_OBJECT.test(String(gitObject ?? '')) ? gitObject : null,
    contentSha256: SHA256.test(String(contentSha256 ?? '')) ? contentSha256 : null
  };
}

/** Produce an opaque reference only for bytes represented by the exact current manifest. */
export function comprehensionSourceReference(manifest, region, side) {
  assertManifest(manifest);
  const current = manifest.regions.find((entry) => entry.regionId === region?.regionId
    && entry.regionSha256 === region?.regionSha256);
  if (!current) fail('Source reference region is not present in the exact manifest.', 'CMP_SOURCE_REGION_INVALID');
  const descriptor = sourceDescriptor(manifest, current, side);
  if (!descriptor) return null;
  const referenceSha256 = canonicalSha256(descriptor);
  return Object.freeze({
    ...descriptor,
    referenceSha256,
    ref: `sfref:comprehension:source:${encodeURIComponent(current.regionId)}:${side}:${referenceSha256.slice(7)}`
  });
}

export function comprehensionSourceReferences(manifest, region) {
  return Object.freeze(['before', 'after']
    .map((side) => comprehensionSourceReference(manifest, region, side))
    .filter(Boolean));
}

function parseReference(reference) {
  const match = REFERENCE.exec(String(reference ?? ''));
  if (!match) fail('Comprehension source reference is malformed.', 'CMP_SOURCE_REFERENCE_INVALID');
  let regionId;
  try { regionId = decodeURIComponent(match[1]); }
  catch { fail('Comprehension source reference contains invalid encoding.', 'CMP_SOURCE_REFERENCE_INVALID'); }
  if (encodeURIComponent(regionId) !== match[1]) {
    fail('Comprehension source reference is not canonical.', 'CMP_SOURCE_REFERENCE_INVALID');
  }
  return { regionId, side: match[2], referenceSha256: `sha256:${match[3]}` };
}

function boundedInteger(value, fallback, { minimum, maximum, label }) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`, 'CMP_SOURCE_LIMIT_INVALID', {
      label, value: value ?? null, minimum, maximum
    });
  }
  return candidate;
}

function readBeforeBytes(root, descriptor) {
  if (!GIT_OBJECT.test(String(descriptor.gitObject ?? ''))) {
    fail('The selected before-source has no exact immutable Git blob.', 'CMP_SOURCE_UNAVAILABLE');
  }
  const type = run('git', ['cat-file', '-t', descriptor.gitObject], {
    cwd: root, allowFailure: true, maxBuffer: 128
  });
  if (type.status !== 0 || type.stdout.trim() !== 'blob') {
    fail('The selected before-source Git blob is unavailable.', 'CMP_SOURCE_UNAVAILABLE');
  }
  const sizeResult = run('git', ['cat-file', '-s', descriptor.gitObject], {
    cwd: root, allowFailure: true, maxBuffer: 128
  });
  const size = Number(sizeResult.stdout.trim());
  if (sizeResult.status !== 0 || !Number.isSafeInteger(size) || size < 0) {
    fail('The selected before-source Git blob size is unavailable.', 'CMP_SOURCE_UNAVAILABLE');
  }
  if (size > CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes) {
    fail(`The selected source exceeds the ${CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes}-byte exact-read ceiling.`,
      'CMP_SOURCE_LIMIT', { bytes: size, maximumBytes: CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes });
  }
  const result = run('git', ['cat-file', 'blob', descriptor.gitObject], {
    cwd: root, allowFailure: true, encoding: 'buffer', maxBuffer: size + 1
  });
  if (result.status !== 0 || result.stdout.length !== size) {
    fail('The selected before-source Git blob could not be read exactly.', 'CMP_SOURCE_UNAVAILABLE');
  }
  return result.stdout;
}

async function readAfterBytes(root, descriptor) {
  const secured = await secureRepositoryPath(root, descriptor.path, {
    label: 'Comprehension exact source', mustExist: true, allowFinalSymlink: true
  });
  const before = secured.entry;
  let bytes;
  if (before.isSymbolicLink()) {
    bytes = await readlink(secured.absolute, { encoding: 'buffer' });
  } else {
    if (!before.isFile() || descriptor.fileType !== 'regular-file') {
      fail('The selected after-source is no longer the regular file described by the manifest.',
        'CMP_SOURCE_CHANGED');
    }
    if (before.size > CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes) {
      fail(`The selected source exceeds the ${CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes}-byte exact-read ceiling.`,
        'CMP_SOURCE_LIMIT', { bytes: before.size, maximumBytes: CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes });
    }
    let handle;
    try {
      handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs) {
        fail('The selected after-source changed while it was read.', 'CMP_SOURCE_CHANGED');
      }
    } catch (error) {
      if (error instanceof SingularityFlowError) throw error;
      if (['ELOOP', 'EMLINK'].includes(error?.code)) {
        fail('The selected after-source changed to a symbolic link.', 'CMP_SOURCE_CHANGED');
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  if (bytes.length > CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes) {
    fail(`The selected source exceeds the ${CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes}-byte exact-read ceiling.`,
      'CMP_SOURCE_LIMIT', { bytes: bytes.length, maximumBytes: CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes });
  }
  const rebound = await secureRepositoryPath(root, descriptor.path, {
    label: 'Comprehension exact source', mustExist: true, allowFinalSymlink: true
  });
  if (before.dev !== rebound.entry.dev || before.ino !== rebound.entry.ino
      || before.size !== rebound.entry.size || before.mtimeMs !== rebound.entry.mtimeMs
      || descriptor.fileType !== (rebound.entry.isSymbolicLink() ? 'symlink' : 'regular-file')) {
    fail('The selected after-source changed while it was verified.', 'CMP_SOURCE_CHANGED');
  }
  if (sha256(bytes) !== descriptor.contentSha256) {
    fail('The selected after-source bytes no longer match the exact change-region manifest.',
      'CMP_SOURCE_DIGEST_MISMATCH', {
        expected: descriptor.contentSha256, actual: sha256(bytes)
      });
  }
  return bytes;
}

/** Read one exact Candidate-bound source in bounded binary-safe pages. */
export async function readComprehensionSourceExpansion(root, manifest, reference, {
  offset = 0,
  maximumBytes = CMP_SOURCE_EXPANSION_LIMITS.defaultPageBytes
} = {}) {
  assertManifest(manifest);
  const parsed = parseReference(reference);
  const region = manifest.regions.find((entry) => entry.regionId === parsed.regionId);
  if (!region) fail('Comprehension source reference names a region outside the current manifest.', 'CMP_SOURCE_REGION_INVALID');
  const exactReference = comprehensionSourceReference(manifest, region, parsed.side);
  if (!exactReference || exactReference.ref !== reference
      || exactReference.referenceSha256 !== parsed.referenceSha256) {
    fail('Comprehension source reference does not match the exact current Candidate.',
      'CMP_SOURCE_REFERENCE_STALE');
  }
  const start = boundedInteger(offset, 0, {
    minimum: 0, maximum: CMP_SOURCE_EXPANSION_LIMITS.maximumSourceBytes, label: 'Source offset'
  });
  const limit = boundedInteger(maximumBytes, CMP_SOURCE_EXPANSION_LIMITS.defaultPageBytes, {
    minimum: 1, maximum: CMP_SOURCE_EXPANSION_LIMITS.maximumPageBytes, label: 'Source page size'
  });
  const bytes = parsed.side === 'before'
    ? readBeforeBytes(root, exactReference)
    : await readAfterBytes(root, exactReference);
  if (start > bytes.length) {
    fail('Source offset is beyond the exact source length.', 'CMP_SOURCE_OFFSET_INVALID', {
      offset: start, totalBytes: bytes.length
    });
  }
  const end = Math.min(bytes.length, start + limit);
  const page = bytes.subarray(start, end);
  const contentSha256 = sha256(bytes);
  const pageCore = {
    reference,
    contentSha256,
    range: { startByte: start, endByte: end },
    content: page.toString('base64')
  };
  return Object.freeze({
    schemaVersion: 1, // schema-transient: exact read response; never persisted or authorized
    kind: 'comprehension-source-expansion',
    mode: 'observe-only',
    authoritative: false,
    lifecycleGate: false,
    reference,
    referenceSha256: exactReference.referenceSha256,
    candidateSha256: manifest.compatibilityCandidateSha256,
    manifestSha256: manifest.manifestSha256,
    regionId: region.regionId,
    regionSha256: region.regionSha256,
    side: parsed.side,
    path: exactReference.path,
    fileType: exactReference.fileType,
    gitObject: exactReference.gitObject,
    contentSha256,
    totalBytes: bytes.length,
    encoding: 'base64',
    offset: start,
    bytes: page.length,
    content: pageCore.content,
    pageSha256: canonicalSha256(pageCore),
    complete: end >= bytes.length,
    nextOffset: end < bytes.length ? end : null
  });
}
