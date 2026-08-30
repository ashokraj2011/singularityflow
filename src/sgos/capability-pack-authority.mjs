/**
 * Exact Capability Pack authority consumed by the SGOS compiler and execution admission.
 *
 * The experimental Authority Store is machine-local. Approved configuration supplies publisher
 * trust, but does not transport Pack bytes, reviews, activations, or revocations. A signed Pack is
 * usable only while all of those exact records remain verifiable in this repository's Git-common
 * store. The built-in core profile is separate: it is a versioned code authority and never opens or
 * accepts a caller-provided Authority Store.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { configurationReadRoot } from '../configuration-read-scope.mjs';
import { gitCommonDir } from '../git.mjs';
import { configuredRemoteAuthority } from '../git-remote-diagnostics.mjs';
import { canonicalJson } from '../records.mjs';
import { run, SingularityFlowError } from '../util.mjs';
import { withTrustedSgosConfigurationRead } from './authority-trust.mjs';
import { openFilesystemAuthorityStore } from './platform/authority-store.mjs';
import { platformSha256 } from './platform/contracts.mjs';
import { createCapabilityPackRegistry } from './platform/packs.mjs';

export const SGOS_CAPABILITY_PACK_TRUST_PATH = 'singularity/sgos/capability-pack-trust.json';
export const SGOS_CAPABILITY_PACK_TRUST_FORMAT = 'singularity-flow-sgos-capability-pack-trust/v1';
export const SGOS_CAPABILITY_PACK_AUTHORITY_FORMAT = 'singularity-flow-sgos-capability-pack-authority/v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const DOMAIN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const MAX_TRUST_MANIFEST_BYTES = 256 * 1024;
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

function validateTrustManifest(value) {
  exactKeys(value, ['format', 'storeId', 'publishers'], 'Capability Pack trust manifest');
  if (value.format !== SGOS_CAPABILITY_PACK_TRUST_FORMAT || !IDENTIFIER.test(value.storeId)) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Approved Capability Pack trust manifest is invalid.');
  }
  if (!plainObject(value.publishers) || Object.keys(value.publishers).length > 64) {
    fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Approved Capability Pack publishers must be a bounded object.');
  }
  for (const [keyId, publicKeyPem] of Object.entries(value.publishers)) {
    if (!IDENTIFIER.test(keyId) || typeof publicKeyPem !== 'string' || !publicKeyPem.trim()) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Approved Capability Pack publisher entry is invalid.', { keyId });
    }
  }
  return deepFreeze(structuredClone(value));
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
    const authority = configuredRemoteAuthority(root, selectedRemote, { direction: 'fetch' });
    if (!authority.fingerprint) {
      fail('SGOS_CAPABILITY_PACK_REPOSITORY_UNVERIFIED',
        'Capability Pack authority could not resolve the canonical credential-free repository remote.');
    }
    identity = { kind: 'remote-fingerprint', sha256: `sha256:${authority.fingerprint}` };
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

async function safeConfigurationJson(configurationRoot, relative) {
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
        `Approved configuration does not contain '${SGOS_CAPABILITY_PACK_TRUST_PATH}'.`);
    }
    if (info.isSymbolicLink() || (final ? !info.isFile() : !info.isDirectory())) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        'Approved Capability Pack trust path must contain only ordinary directories and one regular file.');
    }
  }
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_TRUST_MANIFEST_BYTES) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID',
        `Approved Capability Pack trust manifest must be a regular file no larger than ${MAX_TRUST_MANIFEST_BYTES} bytes.`);
    }
    const canonicalTarget = await realpath(target);
    const canonicalRelation = path.relative(root, canonicalTarget);
    if (!canonicalRelation || canonicalRelation.startsWith('..') || path.isAbsolute(canonicalRelation)) {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Capability Pack trust path escapes approved configuration.');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') {
      fail('SGOS_CAPABILITY_PACK_TRUST_INVALID', 'Approved Capability Pack trust manifest must not be a symbolic link.');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function approvedTrustManifest(configurationRoot) {
  let parsed;
  try {
    parsed = JSON.parse(await safeConfigurationJson(configurationRoot, SGOS_CAPABILITY_PACK_TRUST_PATH));
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
  return validateTrustManifest(parsed);
}

async function localAuthorityStore(root, storeId) {
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
        `Capability Pack Authority Store '${storeId}' is not available in this repository.`, {
          storeId,
          portability: 'machine-local-authority-store-not-transported-by-approved-configuration'
        });
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
      `Capability Pack Authority Store '${storeId}' is not available in this repository.`, {
        storeId,
        portability: 'machine-local-authority-store-not-transported-by-approved-configuration'
      });
  }
  return openFilesystemAuthorityStore({ root: authorityRoot, storeId });
}

async function resolveMountedSignedSelection(root, selector, configurationRoot) {
  const trust = await approvedTrustManifest(configurationRoot);
  const store = await localAuthorityStore(root, trust.storeId);
  const registry = createCapabilityPackRegistry({
    authorityStore: store,
    trustedPublishers: trust.publishers,
    repositoryRoot: root
  });
  const resolved = await registry.resolveActiveSelection(selector.domain, selector.packSha256);
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
