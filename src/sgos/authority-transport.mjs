/** Trusted, path-neutral Authority Store transport services used by the model-free CLI. */
import {
  createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { safePrivateSidecarDirectory } from '../private-sidecar.mjs';
import { canonicalJson } from '../records.mjs';
import { scanText } from '../secrets.mjs';
import { run, SingularityFlowError } from '../util.mjs';
import {
  loadApprovedSgosCapabilityPackTransportTrust,
  SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED
} from './capability-pack-authority.mjs';
import {
  loadApprovedPlatformMutationAuthority
} from './platform/authority.mjs';
import {
  assertPortableAuthorityStoreId, openFilesystemAuthorityStore, platformSha256
} from './platform/index.mjs';
import {
  validateCapabilityPackTransportEntries, validateCapabilityPackTransportLineage,
  validateCapabilityPackTransportRollback
} from './platform/packs.mjs';

export const SGOS_AUTHORITY_TRANSPORT_MAXIMUM_BYTES = 64 * 1024 * 1024;
export const SGOS_AUTHORITY_SIGNER_FORMAT = 'sflow.sgos.authority-transport-signer';
export const SGOS_AUTHORITY_SIGNER_VERSION = process.platform === 'win32' ? 2 : 1;

const SIGNER_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;
const PRIVATE_KEY_LIMIT = 64 * 1024;
const WINDOWS_DPAPI_PROTECTION = 'windows-dpapi-current-user';
const WINDOWS_DPAPI_ENTROPY = 'singularity-flow:local-ed25519-signer:v1';

function fail(message, code = 'SGOS_AUTHORITY_TRANSPORT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function signerId(value) {
  if (typeof value !== 'string' || !SIGNER_ID.test(value) || WINDOWS_RESERVED.test(value)) {
    fail('Authority transport signer ID must be a portable canonical lower-case identifier.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  return value;
}

async function secureSignerRoot(root) {
  const directory = path.join(
    gitCommonDir(root), 'singularity-flow', 'sgos', 'authority-signers'
  );
  try {
    await safePrivateSidecarDirectory(root, directory, { create: true });
  } catch (error) {
    if (error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE') {
      fail('Local Authority transport signer path must remain in ordinary Git-common directories.',
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
    }
    throw error;
  }
  const info = await lstat(directory);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    fail('Local Authority transport signer directory must have mode 0700.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  return realpath(directory);
}

function signerFile(directory, keyId) {
  return path.join(directory, `${signerId(keyId)}.json`);
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
  } finally {
    await handle?.close().catch(() => {});
  }
}

function windowsDpapi(mode, bytes) {
  const operation = mode === 'protect' ? 'Protect' : 'Unprotect';
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$encoded = [Console]::In.ReadToEnd().Trim()',
    '$bytes = [Convert]::FromBase64String($encoded)',
    `$entropy = [Text.Encoding]::UTF8.GetBytes("${WINDOWS_DPAPI_ENTROPY}")`,
    `$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))'
  ].join('; ');
  const input = Buffer.from(bytes).toString('base64');
  let result = null;
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    result = run(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
    ], { allowFailure: true, input, timeoutMs: 30_000, maxBuffer: PRIVATE_KEY_LIMIT * 2 });
    if (result.status === 0 && result.stdout.trim()) break;
  }
  if (!result || result.status !== 0) {
    fail(`Windows DPAPI could not ${mode} the local signing key.`,
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_PLATFORM_UNSUPPORTED');
  }
  const encoded = result.stdout.trim();
  let output;
  try { output = Buffer.from(encoded, 'base64'); } catch { output = Buffer.alloc(0); }
  if (!output.length || output.toString('base64') !== encoded || output.length > PRIVATE_KEY_LIMIT) {
    fail('Windows DPAPI returned invalid local signing material.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  return output;
}

function signerPrivateKey(value) {
  if (value.signerVersion === 1) {
    if (process.platform === 'win32') {
      fail('A plaintext legacy signer cannot be loaded on Windows. Create a DPAPI-protected signer.',
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
    }
    return value.privateKeyPem;
  }
  if (process.platform !== 'win32' || value.signerVersion !== 2
      || value.protection !== WINDOWS_DPAPI_PROTECTION
      || typeof value.protectedPrivateKeyBase64 !== 'string') {
    fail('Local Authority transport signer protection is not supported on this platform.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  const protectedBytes = Buffer.from(value.protectedPrivateKeyBase64, 'base64');
  if (!protectedBytes.length
      || protectedBytes.toString('base64') !== value.protectedPrivateKeyBase64) {
    fail('Local Authority transport signer protected key is invalid.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  return windowsDpapi('unprotect', protectedBytes).toString('utf8');
}

function validateSignerRecord(value, expectedKeyId) {
  const expectedFields = value?.signerVersion === 2
    ? ['algorithm', 'keyId', 'protectedPrivateKeyBase64', 'protection', 'publicKeyPem',
      'signerFormat', 'signerVersion']
    : ['algorithm', 'keyId', 'privateKeyPem', 'publicKeyPem', 'signerFormat', 'signerVersion'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== expectedFields.sort().join(',')
      || value.signerFormat !== SGOS_AUTHORITY_SIGNER_FORMAT
      || ![1, 2].includes(value.signerVersion)
      || value.algorithm !== 'ed25519'
      || value.keyId !== expectedKeyId) {
    fail('Local Authority transport signer record is invalid.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  const privateKeyPem = signerPrivateKey(value);
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
    publicKey = createPublicKey(value.publicKeyPem);
  } catch {
    fail('Local Authority transport signer material is invalid.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    fail('Local Authority transport signer must use Ed25519.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (String(derived) !== value.publicKeyPem) {
    fail('Local Authority transport signer public and private keys do not match.',
      'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
  }
  return Object.freeze({
    keyId: value.keyId,
    privateKeyPem,
    publicKeyPem: value.publicKeyPem,
    publicKeySha256: platformSha256(publicKey.export({ type: 'spki', format: 'der' }))
  });
}

export async function createLocalAuthorityTransportSigner(root, keyId) {
  const id = signerId(keyId);
  const directory = await secureSignerRoot(root);
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const record = process.platform === 'win32' ? {
    signerFormat: SGOS_AUTHORITY_SIGNER_FORMAT,
    signerVersion: 2,
    algorithm: 'ed25519',
    keyId: id,
    protection: WINDOWS_DPAPI_PROTECTION,
    protectedPrivateKeyBase64: windowsDpapi('protect', Buffer.from(privateKeyPem)).toString('base64'),
    publicKeyPem
  } : {
    signerFormat: SGOS_AUTHORITY_SIGNER_FORMAT,
    signerVersion: SGOS_AUTHORITY_SIGNER_VERSION,
    algorithm: 'ed25519',
    keyId: id,
    privateKeyPem,
    publicKeyPem
  };
  const file = signerFile(directory, id);
  const temporary = path.join(directory,
    `.${id}.pending-${process.pid}-${randomUUID()}`);
  let handle;
  let created = false;
  try {
    // Write and sync a private, unreferenced inode first. A crash can therefore leave only an
    // ignorable pending file, never a truncated signer at the stable name. `link` is the final
    // no-replace publication step and also makes concurrent/retried creation idempotent.
    handle = await open(temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(canonicalJson(record), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, file);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await syncDirectory(directory);
  } catch (error) {
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    await syncDirectory(directory);
  }
  // Re-open the stable inode through the same bounded/no-follow validation used by export. A
  // losing concurrent creator returns the winner's public key, so an exact retry is a no-op.
  const validated = await loadLocalAuthorityTransportSigner(root, id);
  return Object.freeze({
    created,
    keyId: id,
    algorithm: 'ed25519',
    publicKeyPem: validated.publicKeyPem,
    publicKeySha256: validated.publicKeySha256
  });
}

export async function loadLocalAuthorityTransportSigner(root, keyId) {
  const id = signerId(keyId);
  const directory = await secureSignerRoot(root);
  const file = signerFile(directory, id);
  let handle;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > PRIVATE_KEY_LIMIT) {
      fail('Local Authority transport signer must be one bounded regular file.',
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
    }
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      fail('Local Authority transport signer permissions must be 0600.',
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
    }
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.ino !== 0 && opened.ino !== info.ino)
        || (opened.dev !== 0 && opened.dev !== info.dev)) {
      fail('Local Authority transport signer changed while it was opened.',
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
    }
    const parsed = JSON.parse(await handle.readFile('utf8'));
    return validateSignerRecord(parsed, id);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`Authority transport signer '${id}' is unavailable. Create it locally first.`,
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_UNAVAILABLE');
    }
    if (error instanceof SyntaxError) {
      fail('Local Authority transport signer is not valid JSON.',
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_INVALID');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function visitPortableFields(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitPortableFields(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    const platformSignatureValue = key === 'value'
      && value.algorithm === 'ed25519'
      && Object.keys(value).sort().join(',')
        === 'algorithm,keyId,keySha256,payloadSha256,value'
      && typeof child === 'string'
      && /^[A-Za-z0-9+/]{86}==$/u.test(child);
    if (typeof child === 'string' && child.length
        && /^(?:password|secret|privateKey|accessToken|refreshToken|apiKey|credential)$/iu.test(key)) {
      fail('Authority transport contains credential material and cannot be moved between machines.',
        'SGOS_AUTHORITY_TRANSPORT_CREDENTIAL_REFUSED', { location: childLocation });
    }
    if (typeof child === 'string' && !platformSignatureValue
        && (child.startsWith('/') || /^[a-z]:[\\/]/iu.test(child) || /^\\\\/u.test(child)
          || /^file:/iu.test(child)
          || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(child))) {
      fail('Authority transport contains a machine-local or escaping path-shaped value.',
        'SGOS_AUTHORITY_TRANSPORT_PATH_UNSAFE', { location: childLocation });
    }
    visitPortableFields(child, childLocation);
  }
}

export function authorityTransportEntryValidator(trustedPublishers) {
  return (entries, events = null) => {
    const serialized = canonicalJson(events === null ? entries : { entries, events });
    const findings = scanText(serialized, { path: '<authority-transport>' });
    if (findings.length) {
      fail('Authority transport contains credential-shaped material and cannot be exported or imported.',
        'SGOS_AUTHORITY_TRANSPORT_CREDENTIAL_REFUSED', {
          findingCount: findings.length,
          rules: [...new Set(findings.map((finding) => finding.rule))].sort()
        });
    }
    visitPortableFields(events === null ? entries : { entries, events });
    return events === null
      ? validateCapabilityPackTransportEntries(entries, trustedPublishers)
      : validateCapabilityPackTransportLineage(events, entries, trustedPublishers);
  };
}

export function authorityTransportRollbackValidator(trustedPublishers) {
  return (rollbackEntries, currentEntries, rollbackEvents, currentEvents) =>
    validateCapabilityPackTransportRollback(
      rollbackEntries, currentEntries, rollbackEvents, currentEvents, trustedPublishers
  );
}

export function serializeAuthorityTransport(signedTransport) {
  const text = canonicalJson(signedTransport);
  if (Buffer.byteLength(text, 'utf8') > SGOS_AUTHORITY_TRANSPORT_MAXIMUM_BYTES) {
    fail('Authority transport exceeds the installed portable bundle limit.',
      'SGOS_AUTHORITY_TRANSPORT_LIMIT');
  }
  return text;
}

export function parseAuthorityTransport(bytes) {
  const input = Buffer.from(bytes);
  if (!input.length || input.length > SGOS_AUTHORITY_TRANSPORT_MAXIMUM_BYTES) {
    fail('Authority transport is empty or exceeds the installed portable bundle limit.',
      'SGOS_AUTHORITY_TRANSPORT_LIMIT');
  }
  let parsed;
  try { parsed = JSON.parse(input.toString('utf8')); } catch {
    fail('Authority transport is truncated or is not valid JSON.',
      'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
  }
  const canonical = Buffer.from(canonicalJson(parsed), 'utf8');
  if (input.length !== canonical.length || !input.equals(canonical)) {
    fail('Authority transport must use the exact canonical serialized form.',
      'SGOS_AUTHORITY_TRANSPORT_BUNDLE_INVALID');
  }
  return parsed;
}

export async function authorityTransportContext(root, operation, { signer = null } = {}) {
  const trust = await loadApprovedSgosCapabilityPackTransportTrust(root, {
    refreshAuthority: true
  });
  assertPortableAuthorityStoreId(trust.storeId);
  const authorization = operation == null
    ? null
    : await loadApprovedPlatformMutationAuthority(root, operation);
  if (authorization !== null
      && authorization.configurationCommit !== trust.configurationAuthority.commit) {
    fail('Approved transport trust and mutation authority changed between verified reads. Retry against one current configuration revision.',
      'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE', {
        trustCommit: trust.configurationAuthority.commit,
        authorizationCommit: authorization.configurationCommit
      });
  }
  let localSigner = null;
  if (signer !== null) {
    if (trust.mode !== SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED) {
      fail('Approved Authority Store transport is git-trusted and does not use an export signer. Use authority-store publish.',
        'SGOS_AUTHORITY_TRANSPORT_MODE_MISMATCH');
    }
    localSigner = await loadLocalAuthorityTransportSigner(root, signer);
    const approved = trust.exporters[localSigner.keyId];
    if (!approved || approved.trim() !== localSigner.publicKeyPem.trim()) {
      fail(`Authority transport signer '${localSigner.keyId}' is not trusted by approved configuration.`,
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_UNTRUSTED');
    }
  }
  return Object.freeze({
    trust,
    authorization,
    signer: localSigner,
    validateEntries: authorityTransportEntryValidator(trust.publishers),
    validateRollback: authorityTransportRollbackValidator(trust.publishers)
  });
}

export async function openApprovedAuthorityTransportStore(root, trust) {
  const common = await realpath(gitCommonDir(root));
  const parent = path.join(common, 'singularity-flow', 'sgos', 'platform-authority');
  try {
    await safePrivateSidecarDirectory(root, parent, { create: true });
  } catch (error) {
    if (error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE') {
      fail('Authority Store path must remain inside ordinary Git-common directories.',
        'SGOS_AUTHORITY_PATH_UNSAFE');
    }
    throw error;
  }
  const authorityRoot = path.join(parent, trust.storeId);
  return openFilesystemAuthorityStore({ root: authorityRoot, storeId: trust.storeId });
}
