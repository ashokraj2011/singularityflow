/** Optional L2 shared Derived-Memory cache for exact, already validated WMB view bundles. */
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  deriveWorldModelViewCacheKey, readWorldModelViewCache, writeWorldModelViewCache
} from './cache.mjs';
import { canonicalJson, sha256 } from './canonicalize.mjs';

const FAMILY = 'world-model-shared-cache-bundle';
const KIND = 'world-model-shared-cache-bundle';
const MAXIMUM_BUNDLE_BYTES = 10 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function fail(message, code = 'WMB_SHARED_CACHE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} contains missing or unknown fields.`, 'WMB_SHARED_CACHE_INVALID', { actual, expected: wanted });
  }
}

function without(value, field) {
  const copy = structuredClone(value);
  delete copy[field];
  return copy;
}

function configuredDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    fail('WMB shared-cache directory must be an explicit absolute path.', 'WMB_SHARED_CACHE_CONFIGURATION_INVALID');
  }
  return path.resolve(value);
}

async function safeDirectory(directory, { create = false } = {}) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`WMB shared-cache path is not a real directory: ${directory}`,
      'WMB_SHARED_CACHE_PATH_UNSAFE');
  }
  return true;
}

async function bundlePath(directory, cacheKeySha256, { create = false } = {}) {
  if (!SHA256.test(String(cacheKeySha256 ?? ''))) fail('WMB shared-cache key is invalid.');
  const root = configuredDirectory(directory);
  if (!await safeDirectory(root, { create })) return null;
  const hex = cacheKeySha256.slice('sha256:'.length);
  const version = path.join(root, 'wmb-v4');
  const entries = path.join(version, 'entries');
  const prefix = path.join(entries, hex.slice(0, 2));
  for (const child of [version, entries, prefix]) {
    if (!await safeDirectory(child, { create })) return null;
  }
  return path.join(prefix, `${hex}.json`);
}

export function validateSharedWorldModelCacheBundle(value, expectedComponents = null) {
  let bundle;
  try { bundle = readRecord(FAMILY, value).record; }
  catch (error) { fail(`WMB shared-cache bundle schema is invalid: ${error.message}`); }
  exactKeys(bundle, [
    'schemaVersion', 'kind', 'cacheKeySha256', 'components', 'view', 'candidate',
    'validationReceipt', 'createdAt', 'bundleSha256'
  ], 'WMB shared-cache bundle');
  if (bundle.kind !== KIND || !SHA256.test(bundle.cacheKeySha256)
      || !SHA256.test(bundle.bundleSha256) || !ISO_UTC.test(bundle.createdAt)
      || typeof bundle.view !== 'string' || !bundle.view.length
      || !bundle.candidate || typeof bundle.candidate !== 'object' || Array.isArray(bundle.candidate)
      || !bundle.validationReceipt || typeof bundle.validationReceipt !== 'object'
      || Array.isArray(bundle.validationReceipt)) {
    fail('WMB shared-cache bundle fields are invalid.');
  }
  const derived = deriveWorldModelViewCacheKey(bundle.components);
  if (derived.cacheKeySha256 !== bundle.cacheKeySha256) {
    fail('WMB shared-cache bundle key does not bind its exact components.',
      'WMB_SHARED_CACHE_BINDING_INVALID');
  }
  if (expectedComponents
      && canonicalJson(derived.components)
        !== canonicalJson(deriveWorldModelViewCacheKey(expectedComponents).components)) {
    fail('WMB shared-cache bundle does not match the requested exact key.',
      'WMB_SHARED_CACHE_BINDING_INVALID');
  }
  if (sha256(without(bundle, 'bundleSha256')) !== bundle.bundleSha256) {
    fail('WMB shared-cache bundle self hash does not verify.', 'WMB_SHARED_CACHE_CORRUPT');
  }
  return Object.freeze(bundle);
}

function bundleFromLocalCache(local) {
  if (!local?.hit) fail('Only a verified local cache hit can enter the shared cache.');
  const core = {
    schemaVersion: currentSchemaVersion(FAMILY),
    kind: KIND,
    cacheKeySha256: local.cacheKeySha256,
    components: structuredClone(local.components),
    view: Buffer.from(local.viewBytes).toString('utf8'),
    candidate: structuredClone(local.candidate),
    validationReceipt: structuredClone(local.validationReceipt),
    createdAt: local.record.createdAt
  };
  return validateSharedWorldModelCacheBundle({ ...core, bundleSha256: sha256(core) });
}

export async function readSharedWorldModelViewCache(directory, keyComponents) {
  const { cacheKeySha256, components } = deriveWorldModelViewCacheKey(keyComponents);
  const target = await bundlePath(directory, cacheKeySha256);
  if (!target) return Object.freeze({ hit: false, status: 'miss', cacheKeySha256 });
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ hit: false, status: 'miss', cacheKeySha256 });
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAXIMUM_BUNDLE_BYTES) {
    return Object.freeze({ hit: false, status: 'corrupt', cacheKeySha256,
      reason: 'shared-cache-entry-is-not-a-bounded-regular-file' });
  }
  try {
    const bytes = await readFile(target);
    const bundle = validateSharedWorldModelCacheBundle(bytes, components);
    if (!Buffer.from(canonicalJson(bundle)).equals(bytes)) {
      fail('WMB shared-cache bundle is not canonical JSON.', 'WMB_SHARED_CACHE_CORRUPT');
    }
    return Object.freeze({ hit: true, status: 'hit', cacheKeySha256, path: target, bundle });
  } catch (error) {
    return Object.freeze({ hit: false, status: 'corrupt', cacheKeySha256,
      reason: error?.message ?? String(error) });
  }
}

export async function publishWorldModelViewToSharedCache(directory, repositoryRoot, keyComponents) {
  const local = await readWorldModelViewCache(repositoryRoot, keyComponents);
  if (!local.hit) fail('The exact local WMB cache entry is unavailable for shared publication.',
    'WMB_SHARED_CACHE_LOCAL_MISS');
  const bundle = bundleFromLocalCache(local);
  const bytes = Buffer.from(canonicalJson(bundle));
  if (bytes.length > MAXIMUM_BUNDLE_BYTES) fail('WMB shared-cache bundle exceeds its byte ceiling.');
  const target = await bundlePath(directory, bundle.cacheKeySha256, { create: true });
  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(target,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    return Object.freeze({ written: true, path: target, bundleSha256: bundle.bundleSha256 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const winner = await readSharedWorldModelViewCache(directory, keyComponents);
    if (!winner.hit || winner.bundle.bundleSha256 !== bundle.bundleSha256) {
      fail('A conflicting or corrupt shared-cache winner already exists.',
        'WMB_SHARED_CACHE_CONFLICT', { path: target });
    }
    return Object.freeze({ written: false, path: target, bundleSha256: bundle.bundleSha256 });
  } finally {
    await handle?.close();
  }
}

/** Hydrate L1 through its normal validator; runtime still revalidates semantics before use. */
export async function hydrateLocalWorldModelViewCacheFromShared(
  repositoryRoot, directory, keyComponents
) {
  const shared = await readSharedWorldModelViewCache(directory, keyComponents);
  if (!shared.hit) return shared;
  const installed = await writeWorldModelViewCache(repositoryRoot, keyComponents, {
    view: shared.bundle.view,
    candidate: shared.bundle.candidate,
    validationReceipt: shared.bundle.validationReceipt,
    createdAt: shared.bundle.createdAt
  });
  return Object.freeze({ ...installed, shared: true, sharedPath: shared.path });
}
