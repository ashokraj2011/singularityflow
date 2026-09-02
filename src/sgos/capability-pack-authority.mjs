/**
 * Exact Capability Pack authority consumed by the SGOS compiler and execution admission.
 *
 * The Authority Store remains private Git-common runtime state. Approved configuration supplies
 * publisher trust; explicit v2 signed transport or v3 Git-trusted state projection can move its
 * complete Pack lineage between machines. A signed Pack is usable only while all of those exact
 * records remain verifiable in this repository's local Store. The built-in core profile is
 * separate: it is a versioned code authority and never opens or accepts a caller-provided Store.
 */
import { createPublicKey } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { configurationReadRoot } from '../configuration-read-scope.mjs';
import { gitCommonDir } from '../git.mjs';
import { configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import { canonicalJson } from '../records.mjs';
import { run, SingularityFlowError } from '../util.mjs';
import { withTrustedSgosConfigurationRead } from './authority-trust.mjs';
import {
  assertPortableAuthorityStoreId, openFilesystemAuthorityStore
} from './platform/authority-store.mjs';
import {
  PLATFORM_AUTHORITY_TRANSPORT_ATTESTATION, platformSha256
} from './platform/contracts.mjs';
import { createCapabilityPackRegistry } from './platform/packs.mjs';

export const SGOS_CAPABILITY_PACK_TRUST_PATH = 'singularity/sgos/capability-pack-trust.json';
export const SGOS_CAPABILITY_PACK_TRUST_FORMAT = 'singularity-flow-sgos-capability-pack-trust/v1';
export const SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2 = 'singularity-flow-sgos-capability-pack-trust/v2';
export const SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3 = 'singularity-flow-sgos-capability-pack-trust/v3';
export const SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED = 'signed';
export const SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED = 'git-trusted';
export const SGOS_CAPABILITY_PACK_AUTHORITY_FORMAT = 'singularity-flow-sgos-capability-pack-authority/v1';

const SGOS_CAPABILITY_PACK_REPOSITORY_BINDING_FORMAT_V2 =
  'singularity-flow-sgos-capability-pack-repository-binding/v2';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const DOMAIN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const MAX_TRUST_MANIFEST_BYTES = 256 * 1024;
const MAX_APPROVED_WORKFLOW_BYTES = 2 * 1024 * 1024;
const verifiedSelections = new WeakMap();

function fail(code, message, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail('SGOS_CAPABILITY_PACK_AUTHORITY_INVALID', `${label} must be an object.`);
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_INVALID', `${label} has missing or unsupported fields.`, {
      expected, actual
    });
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sortedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length > 4096
      || value.some((entry) => typeof entry !== 'string' || !entry)) {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_INVALID', `${label} must be a bounded string array.`);
  }
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1] >= value[index]) {
      fail('SGOS_CAPABILITY_PACK_AUTHORITY_INVALID', `${label} must be sorted and unique.`);
    }
  }
  return value;
}

const CORE_MANIFEST = Object.freeze({
  format: 'singularity-flow-sgos-builtin-core-pack/v1',
  packId: 'sflow-core',
  version: '1.0.0',
  domain: 'core',
  operationsPolicy: 'exact-registry-bound'
});

export const SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY = deepFreeze({
  format: SGOS_CAPABILITY_PACK_AUTHORITY_FORMAT,
  kind: 'built-in-core',
  profile: CORE_MANIFEST.format,
  domain: CORE_MANIFEST.domain,
  packId: CORE_MANIFEST.packId,
  version: CORE_MANIFEST.version,
  packSha256: platformSha256(CORE_MANIFEST),
  operationsPolicy: CORE_MANIFEST.operationsPolicy
});

function validateSignedAuthority(value, label) {
  exactKeys(value, [
    'format', 'kind', 'profile', 'domain', 'packId', 'version', 'packSha256',
    'operations', 'authorityStoreId', 'repositoryBindingSha256', 'reviewSha256',
    'activationSha256', 'publisherKeyId', 'publisherKeySha256'
  ], label);
  if (value.format !== SGOS_CAPABILITY_PACK_AUTHORITY_FORMAT
      || value.kind !== 'signed-declarative'
      || value.profile !== 'signed-declarative-local-v1') {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_INVALID', `${label} is not a supported signed declarative authority.`);
  }
  if (!DOMAIN.test(value.domain) || !IDENTIFIER.test(value.packId) || !VERSION.test(value.version)
      || !IDENTIFIER.test(value.authorityStoreId) || !IDENTIFIER.test(value.publisherKeyId)) {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_INVALID', `${label} contains a non-canonical identifier.`);
  }
  for (const field of [
    'packSha256', 'repositoryBindingSha256', 'reviewSha256', 'activationSha256',
    'publisherKeySha256'
  ]) {
    if (!DIGEST.test(value[field])) {
      fail('SGOS_CAPABILITY_PACK_AUTHORITY_INVALID', `${label}.${field} must be an exact digest.`);
    }
  }
  sortedUniqueStrings(value.operations, `${label}.operations`);
  return value;
}

export function validateSgosCapabilityPackAuthorities(value, {
  allowLegacyCore = false
} = {}) {
  if (!Array.isArray(value) || value.length !== 1) {
    fail('SGOS_CAPABILITY_PACK_MULTI_DOMAIN_UNSUPPORTED',
      'The installed SGOS profile requires exactly one Capability Pack authority.', {
        received: Array.isArray(value) ? value.length : null
      });
  }
  const authority = value[0];
  if (authority?.kind === 'built-in-core') {
    if (canonicalJson(authority) !== canonicalJson(SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY)) {
      fail('SGOS_CAPABILITY_PACK_CORE_COUNTERFEIT',
        'Built-in core Capability Pack authority does not equal the installed versioned authority.');
    }
  } else {
    validateSignedAuthority(authority, 'capabilityPackAuthorities[0]');
  }
  if (!allowLegacyCore && authority?.kind === 'legacy-core') {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_INVALID', 'Legacy core is not a writable Capability Pack authority.');
  }
  return deepFreeze(structuredClone(value));
}

export function sgosCapabilityPackAuthoritiesSha256(authorities) {
  const validated = validateSgosCapabilityPackAuthorities(authorities);
  return platformSha256({
    format: SGOS_CAPABILITY_PACK_AUTHORITY_FORMAT,
    authorities: validated
  });
}

export function workflowCapabilityPackSelector(workflow) {
  const name = String(workflow?.metadata?.domainPack ?? '').trim();
  const packSha256 = workflow?.metadata?.domainPackSha256 ?? null;
  if (name === 'core' || name === 'core@1') {
    if (packSha256 != null && packSha256 !== SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY.packSha256) {
      fail('SGOS_CAPABILITY_PACK_SELECTION_MISMATCH',
        'Workflow core Pack digest does not equal the installed versioned core authority.', {
          expected: SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY.packSha256,
          received: packSha256
        });
    }
    return Object.freeze({ kind: 'built-in-core', domain: 'core', packSha256: null });
  }
  if (!DOMAIN.test(name) || !DIGEST.test(String(packSha256 ?? ''))) {
    fail('SGOS_CAPABILITY_PACK_SELECTION_REQUIRED',
      'A non-core Workflow must bind one canonical domain and exact domainPackSha256.');
  }
  return Object.freeze({ kind: 'signed-declarative', domain: name, packSha256 });
}

function validatePublicKeyMap(value, label, { ed25519 = false, required = false } = {}) {
  if (!plainObject(value) || Object.keys(value).length > 64
      || (required && Object.keys(value).length === 0)) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', `${label} must be a bounded object${required ? ' with at least one entry' : ''}.`);
  }
  for (const [keyId, publicKeyPem] of Object.entries(value)) {
    if (!IDENTIFIER.test(keyId) || typeof publicKeyPem !== 'string' || !publicKeyPem.trim()
        || (ed25519 && publicKeyPem.length > 16 * 1024)) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', `${label} entry is invalid.`, { keyId });
    }
    if (ed25519) {
      try {
        if (/PRIVATE KEY/u.test(publicKeyPem)) throw new Error('private key material is forbidden');
        const key = createPublicKey(publicKeyPem);
        if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
          throw new Error('key is not an Ed25519 public key');
        }
      } catch {
        fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
          `${label} '${keyId}' must contain an Ed25519 public key and no private key material.`,
          { keyId });
      }
    }
  }
}

function validateTransportRepositoryBinding(value) {
  exactKeys(value, ['remoteFingerprints', 'offlineRootCommitsSha256'],
    'Capability Pack transport repository binding');
  sortedUniqueStrings(value.remoteFingerprints,
    'Capability Pack transport repository binding.remoteFingerprints');
  if (value.remoteFingerprints.length > 64
      || value.remoteFingerprints.some((entry) => !DIGEST.test(entry))) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
      'Capability Pack transport remote fingerprints must be a bounded sorted digest array.');
  }
  if (value.offlineRootCommitsSha256 !== null
      && !DIGEST.test(String(value.offlineRootCommitsSha256 ?? ''))) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
      'Capability Pack transport offline root commits binding must be null or an exact digest.');
  }
  if (!value.remoteFingerprints.length && value.offlineRootCommitsSha256 == null) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
      'Capability Pack transport trust must bind at least one remote fingerprint or offline repository root.');
  }
}

function validateMinimumAuthority(value, { receiptField = 'exportSha256' } = {}) {
  if (value === null) return;
  exactKeys(value, ['revision', 'stateSha256', receiptField],
    'Capability Pack transport minimum authority');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0
      || !DIGEST.test(String(value.stateSha256 ?? ''))
      || !DIGEST.test(String(value[receiptField] ?? ''))) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
      `Capability Pack transport minimum authority must contain a non-negative revision and exact state/${receiptField} digests.`);
  }
}

/** Validate legacy local trust, signed v2 transport, or explicit Git-trusted v3 transport. */
export function validateSgosCapabilityPackTrustManifest(value) {
  if (!plainObject(value)) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Approved Capability Pack trust manifest must be an object.');
  }
  if (value.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT) {
    exactKeys(value, ['format', 'storeId', 'publishers'], 'Capability Pack trust manifest');
  } else if (value.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2) {
    exactKeys(value, ['format', 'storeId', 'publishers', 'transport'],
      'Capability Pack trust manifest');
  } else if (value.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3) {
    exactKeys(value, ['format', 'storeId', 'publishers', 'transport'],
      'Capability Pack trust manifest');
  } else {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Approved Capability Pack trust manifest has an unsupported format.');
  }
  if (value.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT) {
    // v1 is a machine-local compatibility profile. Its already-issued Store IDs used the
    // platform identifier vocabulary (including `:`), so loading one must not silently become a
    // transport migration. Only explicit v2/v3 profiles may cross a machine boundary.
    if (typeof value.storeId !== 'string' || !IDENTIFIER.test(value.storeId)) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        'Approved legacy Capability Pack trust manifest has an invalid local storeId.');
    }
  } else {
    try { assertPortableAuthorityStoreId(value.storeId); } catch {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        'Approved Capability Pack transport trust has a non-portable storeId.');
    }
  }
  // Preserve the v1 publisher contract. Signed Pack verification independently enforces the
  // algorithm when the key is used, while signed-v2 exporters are admitted eagerly below.
  validatePublicKeyMap(value.publishers, 'Approved Capability Pack publishers');
  if (value.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2) {
    exactKeys(value.transport, [
      'repositoryBinding', 'exporterAuthority', 'exporters', 'minimumAuthority'
    ],
      'Capability Pack transport trust');
    if (value.transport.exporterAuthority !== PLATFORM_AUTHORITY_TRANSPORT_ATTESTATION) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        'Capability Pack transport exporters must be explicitly trusted as complete Authority Store snapshot attestors.');
    }
    validateTransportRepositoryBinding(value.transport.repositoryBinding);
    validatePublicKeyMap(value.transport.exporters,
      'Approved Capability Pack transport exporters', { ed25519: true, required: true });
    validateMinimumAuthority(value.transport.minimumAuthority);
  } else if (value.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3) {
    // v3 is deliberately not a weakened signed profile. Git is the complete transport authority,
    // so exporter/signer fields are forbidden rather than ignored or accepted empty.
    exactKeys(value.transport, ['mode', 'repositoryBinding', 'minimumAuthority'],
      'Git-trusted Capability Pack transport trust');
    if (value.transport.mode !== SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        `Capability Pack trust v3 requires transport.mode '${SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED}'.`);
    }
    validateTransportRepositoryBinding(value.transport.repositoryBinding);
    if (value.transport.repositoryBinding.remoteFingerprints.length === 0
        || value.transport.repositoryBinding.offlineRootCommitsSha256 !== null) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        'Git-trusted Capability Pack transport requires at least one approved remote fingerprint and forbids offline-only repository binding.');
    }
    validateMinimumAuthority(value.transport.minimumAuthority, {
      receiptField: 'projectionSha256'
    });
  }
  return deepFreeze(structuredClone(value));
}

/** Derive transport behavior exclusively from the reviewed manifest version and exact fields. */
export function sgosCapabilityPackTransportMode(value) {
  const manifest = validateSgosCapabilityPackTrustManifest(value);
  if (manifest.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2) {
    return SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED;
  }
  if (manifest.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3) {
    return SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED;
  }
  return null;
}

/**
 * Return the path- and credential-free repository fragment required to bootstrap transport trust.
 * Raw Git remote URLs are consumed only to derive their canonical digest and never leave this
 * process; a remote-less repository is bound to its sorted root-commit digest instead.
 */
export function sgosCapabilityPackTransportRepositoryBinding(root, { remote = null } = {}) {
  const remoteFingerprint = rawRepositoryRemoteFingerprint(root, remote);
  return deepFreeze(remoteFingerprint == null ? {
    remoteFingerprints: [],
    offlineRootCommitsSha256: offlineRepositoryRootsSha256(root)
  } : {
    remoteFingerprints: [remoteFingerprint],
    offlineRootCommitsSha256: null
  });
}

/** Build the complete reviewed-configuration document printed by signer-create. */
export function createSgosCapabilityPackTransportTrustScaffold({
  root, storeId, signerKeyId, signerPublicKeyPem, repositoryBinding = null
}) {
  return validateSgosCapabilityPackTrustManifest({
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2,
    storeId,
    publishers: {},
    transport: {
      repositoryBinding: repositoryBinding
        ?? sgosCapabilityPackTransportRepositoryBinding(root),
      exporterAuthority: PLATFORM_AUTHORITY_TRANSPORT_ATTESTATION,
      exporters: { [signerKeyId]: signerPublicKeyPem },
      minimumAuthority: null
    }
  });
}

/** Build a key-free v3 policy scaffold for a Git-governed state projection. */
export function createSgosCapabilityPackGitTrustedTrustScaffold({
  root, storeId, publishers = {}, repositoryBinding = null, minimumAuthority = null,
  stateRemote = null
}) {
  return validateSgosCapabilityPackTrustManifest({
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3,
    storeId,
    publishers,
    transport: {
      mode: SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED,
      repositoryBinding: repositoryBinding
        ?? sgosCapabilityPackTransportRepositoryBinding(root, { remote: stateRemote }),
      minimumAuthority
    }
  });
}

export async function sgosCapabilityPackRepositoryBinding(root) {
  const remotesResult = run('git', ['remote'], { cwd: root, allowFailure: true });
  if (remotesResult.status !== 0) {
    fail('SGOS_CAPABILITY_PACK_REPOSITORY_UNVERIFIED',
      'Capability Pack authority could not inspect repository remotes.');
  }
  const remotes = remotesResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).sort();
  const selectedRemote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
  if (remotes.length > 1 && selectedRemote == null) {
    fail('SGOS_CAPABILITY_PACK_REPOSITORY_UNVERIFIED',
      'Capability Pack authority requires an origin remote when multiple remotes are configured.', { remotes });
  }
  let identity;
  if (selectedRemote) {
    const remoteIdentity = configuredRemoteIdentity(
      root, selectedRemote, { direction: 'fetch' }
    );
    if (!remoteIdentity.configured || remoteIdentity.ambiguous || !remoteIdentity.fingerprint) {
      fail('SGOS_CAPABILITY_PACK_REPOSITORY_UNVERIFIED',
        'Capability Pack authority requires one exact raw credential-free repository remote.', {
          remote: selectedRemote,
          configured: remoteIdentity.configured,
          ambiguous: remoteIdentity.ambiguous
        });
    }
    // The durable Program binding names the reviewed checkout identity, not the transport selected
    // by mutable machine-level url.* rewrite rules. Existing Programs are byte-compatible whenever
    // no rewrite was active; Programs previously compiled under a rewrite fail closed and must be
    // recompiled against this corrected repository identity.
    identity = {
      kind: 'remote-fingerprint', sha256: `sha256:${remoteIdentity.fingerprint}`
    };
  } else {
    const roots = run('git', ['rev-list', '--max-parents=0', '--all'], { cwd: root, allowFailure: true });
    const commits = roots.status === 0
      ? roots.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).sort()
      : [];
    if (!commits.length || commits.some((entry) => !/^[a-f0-9]{40,64}$/.test(entry))) {
      fail('SGOS_CAPABILITY_PACK_REPOSITORY_UNVERIFIED',
        'A remote-less Capability Pack authority requires an established repository root commit.');
    }
    identity = { kind: 'offline-root-commits', sha256: platformSha256(commits) };
  }
  return platformSha256({
    format: 'singularity-flow-sgos-capability-pack-repository-binding/v1',
    identity
  });
}

function rawRepositoryRemoteFingerprint(root, requestedRemote = null) {
  const remotesResult = run('git', ['remote'], { cwd: root, allowFailure: true });
  if (remotesResult.status !== 0) {
    fail('SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_UNVERIFIED',
      'Capability Pack transport could not inspect repository remotes.');
  }
  const remotes = remotesResult.stdout.split(/\r?\n/u)
    .map((entry) => entry.trim()).filter(Boolean).sort();
  if (!remotes.length) return null;
  const selectedRemote = requestedRemote == null
    ? remotes.includes('origin')
      ? 'origin'
      : remotes.length === 1 ? remotes[0] : null
    : remotes.includes(requestedRemote) ? requestedRemote : null;
  if (selectedRemote == null) {
    fail('SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_UNVERIFIED',
      requestedRemote == null
        ? 'Capability Pack transport requires an origin remote when multiple remotes are configured.'
        : `Capability Pack transport state remote '${requestedRemote}' is not configured.`,
      { remotes, requestedRemote });
  }
  // Identity must come from the raw repository-local remote configuration. `get-url` applies
  // machine-local insteadOf rewrites and is therefore a transport selector, not a portable proof.
  const identity = configuredRemoteIdentity(root, selectedRemote, { direction: 'fetch' });
  if (!identity.configured || identity.ambiguous || !identity.fingerprint) {
    fail('SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_UNVERIFIED',
      'Capability Pack transport requires one unambiguous credential-free fetch URL on the canonical remote.', {
        remote: selectedRemote,
        configured: identity.configured,
        ambiguous: identity.ambiguous
      });
  }
  return `sha256:${identity.fingerprint}`;
}

function offlineRepositoryRootsSha256(root) {
  const roots = run('git', ['rev-list', '--max-parents=0', '--all'], {
    cwd: root, allowFailure: true
  });
  const commits = roots.status === 0
    ? [...new Set(roots.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean))].sort()
    : [];
  if (!commits.length || commits.some((entry) => !/^[a-f0-9]{40,64}$/u.test(entry))) {
    fail('SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_UNVERIFIED',
      'Remote-less Capability Pack transport requires an established repository root commit.');
  }
  return platformSha256(commits);
}

function assertTransportRepositoryBinding(root, binding, { remote = null } = {}) {
  const remoteFingerprint = rawRepositoryRemoteFingerprint(root, remote);
  let observedIdentity;
  if (remoteFingerprint != null) {
    if (!binding.remoteFingerprints.includes(remoteFingerprint)) {
      fail('SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_MISMATCH',
        'Approved Capability Pack transport trust belongs to a different repository remote.', {
          observedRemoteFingerprint: remoteFingerprint,
          approvedRemoteFingerprints: binding.remoteFingerprints
        });
    }
    observedIdentity = { kind: 'remote-fingerprint', sha256: remoteFingerprint };
  } else {
    const observed = offlineRepositoryRootsSha256(root);
    if (binding.offlineRootCommitsSha256 == null
        || binding.offlineRootCommitsSha256 !== observed) {
      fail('SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_MISMATCH',
        'Approved Capability Pack transport trust belongs to different offline repository roots.', {
          observedOfflineRootCommitsSha256: observed,
          approvedOfflineRootCommitsSha256: binding.offlineRootCommitsSha256
        });
    }
    observedIdentity = { kind: 'offline-root-commits', sha256: observed };
  }
  return platformSha256({
    format: SGOS_CAPABILITY_PACK_REPOSITORY_BINDING_FORMAT_V2,
    identity: observedIdentity
  });
}

async function safeConfigurationText(configurationRoot, relative, {
  label, maximumBytes
}) {
  const root = await realpath(configurationRoot);
  const target = path.resolve(root, relative);
  const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Capability Pack trust path escapes approved configuration.');
  }
  let cursor = root;
  const segments = relation.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    });
    const final = index === segments.length - 1;
    if (!info) {
      fail('SGOS_CAPABILITY_PACK_TRUST_UNAVAILABLE',
        `Approved configuration does not contain '${relative}'.`);
    }
    if (info.isSymbolicLink() || (final ? !info.isFile() : !info.isDirectory())) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        `Approved ${label} path must contain only ordinary directories and one regular file.`);
    }
  }
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        `Approved ${label} must be a regular file no larger than ${maximumBytes} bytes.`);
    }
    const canonicalTarget = await realpath(target);
    const canonicalRelation = path.relative(root, canonicalTarget);
    if (!canonicalRelation || canonicalRelation.startsWith('..') || path.isAbsolute(canonicalRelation)) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Capability Pack trust path escapes approved configuration.');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', `Approved ${label} must not be a symbolic link.`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function approvedTrustManifest(configurationRoot) {
  let parsed;
  try {
    parsed = JSON.parse(await safeConfigurationText(
      configurationRoot, SGOS_CAPABILITY_PACK_TRUST_PATH, {
        label: 'Capability Pack trust manifest',
        maximumBytes: MAX_TRUST_MANIFEST_BYTES
      }
    ));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('SGOS_CAPABILITY_PACK_TRUST_UNAVAILABLE',
        `Approved configuration does not contain '${SGOS_CAPABILITY_PACK_TRUST_PATH}'.`);
    }
    if (error instanceof SyntaxError) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        `Approved Capability Pack trust manifest is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  return validateSgosCapabilityPackTrustManifest(parsed);
}

async function approvedStateAuthority(root, configurationRoot) {
  let definition;
  try {
    definition = YAML.parse(await safeConfigurationText(
      configurationRoot, 'singularity/workflow.yml', {
        label: 'workflow definition',
        maximumBytes: MAX_APPROVED_WORKFLOW_BYTES
      }
    ));
  } catch (error) {
    if (error?.name === 'YAMLParseError') {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        `Approved workflow definition is not valid YAML: ${error.message}`);
    }
    throw error;
  }
  if (!plainObject(definition)) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
      'Approved workflow definition must be a YAML object.');
  }
  let ledger;
  try {
    // SGOS authority follows the canonical ledger state plane. World Model compatibility fields
    // may route World Model reuse, but must never redirect Pack authority publication or sync.
    ledger = normalizeLedgerConfig(definition?.ledger ?? {});
  } catch (error) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
      `Approved workflow has an invalid state authority: ${error.message}`);
  }
  const branchRef = `refs/heads/${ledger.branch}`;
  const trackingRef = `refs/remotes/${ledger.remote}/${ledger.branch}`;
  if (run('git', ['check-ref-format', branchRef], { cwd: root, allowFailure: true }).status !== 0
      || run('git', ['check-ref-format', trackingRef], { cwd: root, allowFailure: true }).status !== 0) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
      'Approved workflow state authority must use canonical Git remote and branch names.');
  }
  return deepFreeze({
    remote: ledger.remote,
    branch: ledger.branch,
    targetRef: branchRef,
    trackingRef
  });
}

/** Load only the reviewed state target needed to bootstrap key-free Git trust. */
export async function loadApprovedSgosStateAuthority(root, {
  refreshAuthority = true
} = {}) {
  return withTrustedSgosConfigurationRead(root, async (authority, authorityTrust) => {
    configurationAuthorityMetadata(authority, authorityTrust);
    return approvedStateAuthority(root, configurationReadRoot(root));
  }, {
    refreshAuthority,
    requireFreshRemote: refreshAuthority,
    selectPaths: ['singularity/workflow.yml']
  });
}

/**
 * Load the exact approved local Pack trust policy without upgrading v1 into transport authority.
 * Public maintenance commands use this only to admit an already-existing nonportable v1 Store ID;
 * all v2 transport entry points continue to require the narrower portable identifier contract.
 */
export async function loadApprovedSgosCapabilityPackLocalTrust(root, {
  refreshAuthority = true
} = {}) {
  return withTrustedSgosConfigurationRead(root, async (authority) => {
    if (!authority || authority.kind === 'working-tree' || !authority.ref || !authority.commit) {
      fail('SGOS_CAPABILITY_PACK_TRUST_UNAVAILABLE',
        'Legacy Capability Pack Store maintenance requires refreshed approved configuration trust.');
    }
    return approvedTrustManifest(configurationReadRoot(root));
  }, {
    refreshAuthority,
    requireFreshRemote: refreshAuthority,
    selectPaths: ['singularity/workflow.yml', SGOS_CAPABILITY_PACK_TRUST_PATH]
  });
}

function configurationAuthorityMetadata(authority, authorityTrust) {
  const sourceCommit = authority?.kind === 'verified-state-mirror'
    ? authority.manifest?.source?.commit
    : authority?.commit;
  if (!authority?.ref || !/^[a-f0-9]{40,64}$/u.test(String(authority.commit ?? ''))
      || !/^[a-f0-9]{40,64}$/u.test(String(sourceCommit ?? ''))
      || !['approved-configuration-ref', 'verified-state-mirror'].includes(authority.kind)) {
    fail('SGOS_CAPABILITY_PACK_TRUST_UNAVAILABLE',
      'Capability Pack transport requires an exact approved configuration authority.');
  }
  return deepFreeze({
    kind: authority.kind,
    ref: authority.ref,
    commit: authority.commit,
    sourceCommit,
    trustMode: authorityTrust?.mode ?? null,
    workspaceId: authorityTrust?.workspaceId ?? null,
    repositoryId: authorityTrust?.repositoryId ?? null
  });
}

/**
 * Load the explicit signed-v2 or Git-trusted-v3 policy from one verified configuration view.
 * The returned repository binding is a digest-only policy identity; raw URLs and local paths are
 * never exposed or made part of a portable authority bundle.
 */
export async function loadApprovedSgosCapabilityPackTransportTrust(root, {
  refreshAuthority = true
} = {}) {
  return withTrustedSgosConfigurationRead(root, async (authority, authorityTrust) => {
    const configurationAuthority = configurationAuthorityMetadata(authority, authorityTrust);
    const manifest = await approvedTrustManifest(configurationReadRoot(root));
    const mode = sgosCapabilityPackTransportMode(manifest);
    if (mode == null) {
      fail('SGOS_CAPABILITY_PACK_TRANSPORT_TRUST_REQUIRED',
        `Approved configuration must upgrade '${SGOS_CAPABILITY_PACK_TRUST_PATH}' to ${SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2} or ${SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3} before authority transport.`);
    }
    if (mode === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED) {
      const repositoryBindingSha256 = assertTransportRepositoryBinding(
        root, manifest.transport.repositoryBinding
      );
      // Preserve the exact v2 policy and context identities already present in signed portable
      // bundles. The v2 format itself is the signed-mode discriminator; changing these hashes
      // would strand valid historical exports.
      return deepFreeze({
        mode,
        storeId: manifest.storeId,
        publishers: manifest.publishers,
        exporters: manifest.transport.exporters,
        exporterAuthority: manifest.transport.exporterAuthority,
        minimumAuthority: manifest.transport.minimumAuthority,
        repositoryBindingSha256,
        policySha256: platformSha256({
          format: manifest.format,
          storeId: manifest.storeId,
          publishers: manifest.publishers,
          repositoryBinding: manifest.transport.repositoryBinding,
          exporterAuthority: manifest.transport.exporterAuthority,
          exporters: manifest.transport.exporters
        }),
        authorityContextSha256: platformSha256({
          format: manifest.format,
          storeId: manifest.storeId,
          publishers: manifest.publishers,
          repositoryBindingSha256,
          exporterAuthority: manifest.transport.exporterAuthority,
          exporters: manifest.transport.exporters,
          minimumAuthority: manifest.transport.minimumAuthority,
          configurationAuthority
        }),
        configurationAuthority
      });
    }
    const stateAuthority = await approvedStateAuthority(
      root, configurationReadRoot(root)
    );
    const repositoryBindingSha256 = assertTransportRepositoryBinding(
      root, manifest.transport.repositoryBinding, { remote: stateAuthority.remote }
    );
    return deepFreeze({
      mode,
      storeId: manifest.storeId,
      publishers: manifest.publishers,
      minimumAuthority: manifest.transport.minimumAuthority,
      repositoryBindingSha256,
      stateAuthority,
      // Freshness advances independently after publication. Excluding the checkpoint prevents a
      // self-reference. Publisher trust is also excluded from the deterministic Git envelope:
      // every carried Pack is revalidated against the current approved publishers, so adding a
      // publisher need not rewrite unchanged authority history while removing one still fails
      // closed if any transported Pack depends on it. Repository and state trust roots remain
      // bound because changing either is an explicit authority migration, not an ordinary rotation.
      policySha256: platformSha256({
        format: manifest.format,
        mode,
        storeId: manifest.storeId,
        repositoryBinding: manifest.transport.repositoryBinding,
        stateAuthority
      }),
      authorityContextSha256: platformSha256({
        format: manifest.format,
        mode,
        storeId: manifest.storeId,
        publishers: manifest.publishers,
        repositoryBindingSha256,
        minimumAuthority: manifest.transport.minimumAuthority,
        stateAuthority,
        configurationAuthority
      }),
      configurationAuthority
    });
  }, {
    refreshAuthority,
    requireFreshRemote: refreshAuthority,
    selectPaths: ['singularity/workflow.yml', SGOS_CAPABILITY_PACK_TRUST_PATH]
  });
}

function unavailableLocalStoreDetails(storeId, transportMode) {
  if (transportMode === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED) {
    return {
      storeId,
      portability: 'git-trusted-authority-store-sync-required',
      remediation: [
        'singularity-flow authority-store sync --json',
        'singularity-flow authority-store sync --confirm sha256:<SYNC-PLAN> --json'
      ]
    };
  }
  return {
    storeId,
    portability: 'machine-local-authority-store-not-transported-by-approved-configuration'
  };
}

async function localAuthorityStore(root, storeId, {
  allowLegacyStoreId = false, transportMode = null
} = {}) {
  const common = await realpath(gitCommonDir(root));
  let authorityRoot = common;
  for (const segment of ['singularity-flow', 'sgos', 'platform-authority', storeId]) {
    authorityRoot = path.join(authorityRoot, segment);
    const info = await lstat(authorityRoot).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      fail('SGOS_CAPABILITY_PACK_AUTHORITY_UNAVAILABLE',
        transportMode === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED
          ? `Capability Pack Authority Store '${storeId}' is not available on this laptop. Preview and confirm 'singularity-flow authority-store sync' to install it from the approved state branch.`
          : `Capability Pack Authority Store '${storeId}' is not available in this repository.`,
        unavailableLocalStoreDetails(storeId, transportMode));
    }
  }
  const canonicalAuthorityRoot = await realpath(authorityRoot);
  const relation = path.relative(common, canonicalAuthorityRoot);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_UNAVAILABLE',
      'Capability Pack Authority Store escapes the repository Git-common boundary.');
  }
  const statePath = path.join(authorityRoot, 'state.json');
  const state = await lstat(statePath).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!state?.isFile() || state.isSymbolicLink()) {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_UNAVAILABLE',
      transportMode === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED
        ? `Capability Pack Authority Store '${storeId}' is not available on this laptop. Preview and confirm 'singularity-flow authority-store sync' to install it from the approved state branch.`
        : `Capability Pack Authority Store '${storeId}' is not available in this repository.`,
      unavailableLocalStoreDetails(storeId, transportMode));
  }
  return openFilesystemAuthorityStore({ root: authorityRoot, storeId, allowLegacyStoreId });
}

async function resolveMountedSignedSelection(root, selector, configurationRoot) {
  const trust = await approvedTrustManifest(configurationRoot);
  const transportMode = sgosCapabilityPackTransportMode(trust);
  if (transportMode === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED) {
    const stateAuthority = await approvedStateAuthority(root, configurationRoot);
    assertTransportRepositoryBinding(root, trust.transport.repositoryBinding, {
      remote: stateAuthority.remote
    });
  } else if (transportMode === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED) {
    assertTransportRepositoryBinding(root, trust.transport.repositoryBinding);
  }
  const store = await localAuthorityStore(root, trust.storeId, {
    allowLegacyStoreId: trust.format === SGOS_CAPABILITY_PACK_TRUST_FORMAT,
    transportMode
  });
  const registry = createCapabilityPackRegistry({
    authorityStore: store,
    trustedPublishers: trust.publishers,
    repositoryRoot: root
  });
  let resolved;
  try {
    resolved = await registry.resolveActiveSelection(selector.domain, selector.packSha256, {
      minimumAuthority: trust.transport?.minimumAuthority ?? null
    });
  } catch (error) {
    if (error?.code !== 'SGOS_AUTHORITY_TRANSPORT_STALE') throw error;
    const remediation = transportMode === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED
      ? "Preview 'singularity-flow authority-store sync', then rerun it with the exact --confirm digest."
      : 'Import an approved signed Authority Store transport before retrying.';
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_STALE',
      `Capability Pack Authority Store '${trust.storeId}' is below the approved minimum checkpoint. ${remediation}`,
      { storeId: trust.storeId, transportMode, causeCode: error.code });
  }
  const pack = resolved.pack;
  if (pack.domain !== selector.domain || pack.recordSha256 !== selector.packSha256) {
    fail('SGOS_CAPABILITY_PACK_SELECTION_MISMATCH',
      'Resolved Capability Pack does not equal the Workflow selection.');
  }
  const selection = deepFreeze({
    format: SGOS_CAPABILITY_PACK_AUTHORITY_FORMAT,
    kind: 'signed-declarative',
    profile: resolved.profile,
    domain: pack.domain,
    packId: pack.packId,
    version: pack.version,
    packSha256: pack.recordSha256,
    operations: [...pack.operations],
    authorityStoreId: resolved.authorityStoreId,
    repositoryBindingSha256: await sgosCapabilityPackRepositoryBinding(root),
    reviewSha256: resolved.review.recordSha256,
    activationSha256: resolved.activation.recordSha256,
    publisherKeyId: pack.publisherKeyId,
    publisherKeySha256: resolved.signedPack.signature.keySha256
  });
  validateSignedAuthority(selection, 'Capability Pack selection');
  verifiedSelections.set(selection, {
    repositoryBindingSha256: selection.repositoryBindingSha256,
    authorityStateSha256: resolved.authorityStateSha256
  });
  return selection;
}

/** Load one exact active selection using only this repository's approved trust and local store. */
export async function loadApprovedSgosCapabilityPackAuthority(root, workflow, {
  refreshAuthority = true
} = {}) {
  const selector = workflowCapabilityPackSelector(workflow);
  if (selector.kind === 'built-in-core') {
    return SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY;
  }
  return withTrustedSgosConfigurationRead(root, async (authority) => {
    if (!authority || authority.kind === 'working-tree' || !authority.ref || !authority.commit) {
      fail('SGOS_CAPABILITY_PACK_TRUST_UNAVAILABLE',
        'Signed Capability Pack compilation requires refreshed approved configuration trust.');
    }
    return resolveMountedSignedSelection(root, selector, configurationReadRoot(root));
  }, {
    refreshAuthority,
    requireFreshRemote: refreshAuthority,
    selectPaths: ['singularity/workflow.yml', SGOS_CAPABILITY_PACK_TRUST_PATH]
  });
}

/**
 * Compiler choke point. Signed selections require both an opaque load receipt and an independently
 * computed repository binding from the canonical async compile entry point. The receipt is not
 * treated as authority later: execution admission reopens and verifies every durable record.
 */
export function capabilityPackAuthoritiesForCompilation(workflow, suppliedAuthority, {
  repositoryBindingSha256 = null
} = {}) {
  const selector = workflowCapabilityPackSelector(workflow);
  if (selector.kind === 'built-in-core') {
    if (suppliedAuthority != null
        && canonicalJson(suppliedAuthority) !== canonicalJson(SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY)) {
      fail('SGOS_CAPABILITY_PACK_CORE_COUNTERFEIT',
        'Core compilation accepts only the installed versioned core Pack authority.');
    }
    return [SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY];
  }
  const proof = verifiedSelections.get(suppliedAuthority);
  if (!proof) {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_REQUIRED',
      'Signed Pack compilation requires a selection loaded from approved trust and the active repository Authority Store.');
  }
  if (repositoryBindingSha256 == null
      || proof.repositoryBindingSha256 !== repositoryBindingSha256
      || suppliedAuthority.repositoryBindingSha256 !== repositoryBindingSha256) {
    fail('SGOS_CAPABILITY_PACK_REPOSITORY_MISMATCH',
      'Capability Pack selection belongs to another repository or compile entry point.');
  }
  if (suppliedAuthority.domain !== selector.domain
      || suppliedAuthority.packSha256 !== selector.packSha256) {
    fail('SGOS_CAPABILITY_PACK_SELECTION_MISMATCH',
      'Capability Pack proof does not equal the Workflow selection.');
  }
  return validateSgosCapabilityPackAuthorities([suppliedAuthority]);
}

function referencedProgramOperations(program) {
  const operations = [];
  for (const task of program.taskTemplates ?? []) {
    if (typeof task.operation === 'string') operations.push(task.operation);
    const verification = task.metadata?.verification;
    const verificationOperation = typeof verification?.operation === 'string'
      ? verification.operation
      : verification?.operation?.id ?? verification?.operationId ?? null;
    if (verificationOperation != null) operations.push(String(verificationOperation));
  }
  return [...new Set(operations)].sort();
}

export function assertSgosCapabilityPackOperations(program, authorities) {
  const [authority] = validateSgosCapabilityPackAuthorities(authorities);
  if (authority.kind === 'built-in-core') return referencedProgramOperations(program);
  const allowed = new Set(authority.operations);
  const denied = referencedProgramOperations(program).filter((operation) => !allowed.has(operation));
  if (denied.length) {
    fail('SGOS_CAPABILITY_PACK_OPERATION_NOT_ALLOWED',
      'Program uses operations not declared by its exact signed Capability Pack.', { denied });
  }
  return referencedProgramOperations(program);
}

async function revalidateCapabilityPackAuthorities(root, program, authorities, {
  configurationRoot = configurationReadRoot(root)
} = {}) {
  const validated = validateSgosCapabilityPackAuthorities(authorities);
  const [expected] = validated;
  if (expected.kind === 'built-in-core') {
    assertSgosCapabilityPackOperations(program, validated);
    return {
      authorities: validated,
      capabilityPackAuthority: SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY,
      repositoryBindingSha256: null
    };
  }
  const selector = { kind: 'signed-declarative', domain: expected.domain, packSha256: expected.packSha256 };
  const current = await resolveMountedSignedSelection(root, selector, configurationRoot);
  // State revision is deliberately not part of the binding: unrelated Authority Store changes do
  // not invalidate a Program. Every semantically relevant signed/review/activation field is exact.
  if (canonicalJson(current) !== canonicalJson(expected)) {
    const code = current.activationSha256 !== expected.activationSha256
      ? 'SGOS_CAPABILITY_PACK_ACTIVATION_STALE'
      : 'SGOS_CAPABILITY_PACK_AUTHORITY_CHANGED';
    fail(code, 'Current active Capability Pack authority no longer equals the Program authority.', {
      expected, current
    });
  }
  assertSgosCapabilityPackOperations(program, validated);
  return {
    authorities: validated,
    // `current` retains the process-local loader provenance needed by the compiler choke point.
    // It is never serialized into Program authority and is useful only after this exact durable
    // store/trust/activation revalidation has completed.
    capabilityPackAuthority: current,
    repositoryBindingSha256: current.repositoryBindingSha256
  };
}

/** Revalidate signed Pack authority from durable current state; brands are intentionally ignored. */
export async function verifySgosCapabilityPackAuthorities(root, program, authorities, options = {}) {
  return (await revalidateCapabilityPackAuthorities(root, program, authorities, options)).authorities;
}

/**
 * Internal deterministic-recompilation receipt. The returned selection still carries the
 * process-local provenance established by `resolveMountedSignedSelection`; copying the receipt or
 * its JSON cannot authorize compilation. Callers must first possess an independently approved
 * Program authority, which program-trust enforces before consuming this receipt.
 */
export async function revalidateSgosCapabilityPackAuthoritiesForCompilation(
  root, program, authorities, options = {}
) {
  return Object.freeze(await revalidateCapabilityPackAuthorities(root, program, authorities, options));
}
