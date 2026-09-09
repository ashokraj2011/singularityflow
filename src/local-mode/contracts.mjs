import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalJcs } from './jcs.mjs';
import { SingularityFlowError } from '../util.mjs';

export const LOC_BUNDLE_SCHEMA = 'loc.bundle.v1';
export const LOC_PAYLOAD_TYPE = 'application/vnd.sflow.local-bundle.v1+json';
export const LOC_REVIEW_PAYLOAD_TYPE = 'application/vnd.sflow.local-review.v1+json';
export const LOC_PACKAGING_PROFILE = 'loc.zip.store.v1';
export const LOC_SIGNATURE_PROFILE = 'loc.ed25519.dsse.v1';
export const LOC_AUDIT_PROFILE = 'record-audit-v1';
export const LOC_LIMITS = Object.freeze({
  maximumFiles: 10_000,
  maximumFileBytes: 512 * 1024 * 1024,
  maximumContentBytes: 2 * 1024 * 1024 * 1024,
  maximumManifestBytes: 16 * 1024 * 1024,
  maximumEnvelopeBytes: 32 * 1024 * 1024,
  maximumArchiveBytes: 2 * 1024 * 1024 * 1024 + 64 * 1024 * 1024,
  maximumSignatures: 4_096
});

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const STORY = /^LOC-[0-9A-F]{32}$/;
const SIGNER = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$/;

export function locFail(message, code = 'LOCAL_RECORD_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

export function locSha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : typeof value === 'string' ? Buffer.from(value) : Buffer.from(canonicalJcs(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function locDigest(value, label = 'digest') {
  if (!DIGEST.test(String(value ?? ''))) locFail(`${label} must be a sha256 digest.`);
  return String(value);
}

export function localStoryId(value) {
  if (!STORY.test(String(value ?? ''))) locFail('Local Story ID is invalid.', 'LOCAL_STORY_INVALID');
  return String(value);
}

export function localSignerId(value) {
  const normalized = String(value ?? '');
  if (!SIGNER.test(normalized) || WINDOWS_RESERVED.test(normalized)) {
    locFail('Signer ID must be a portable lower-case identifier.', 'LOCAL_SIGNER_INVALID');
  }
  return normalized;
}

export function portablePath(value, { control = false } = {}) {
  const input = String(value ?? '');
  if (!input || input !== input.normalize('NFC') || input.includes('\\')
      || path.posix.isAbsolute(input) || /^[a-z]:/i.test(input) || input.startsWith('//')) {
    locFail(`Bundle path '${input}' is not portable.`, 'LOCAL_PATH_INVALID');
  }
  const parts = input.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'
      || part !== part.normalize('NFC') || /[\u0000-\u001f\u007f]/u.test(part)
      || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part)
      || (!control && part.toLowerCase() === '.git'))) {
    locFail(`Bundle path '${input}' contains a forbidden component.`, 'LOCAL_PATH_INVALID');
  }
  return input;
}

export function assertUniquePortablePaths(values) {
  const seen = new Map();
  for (const value of values) {
    const valid = portablePath(value, { control: ['manifest.json', 'manifest.dsse.json'].includes(value) });
    const identity = valid.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(identity)) locFail(`Bundle paths '${seen.get(identity)}' and '${valid}' collide.`, 'LOCAL_PATH_COLLISION');
    seen.set(identity, valid);
  }
}

export function artifactRef(entry) {
  return { path: entry.path, sha256: entry.sha256, sizeBytes: entry.sizeBytes };
}

export function exactFields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) locFail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    locFail(`${label} has missing or unknown fields.`, 'BUNDLE_SCHEMA_UNSUPPORTED');
  }
}
