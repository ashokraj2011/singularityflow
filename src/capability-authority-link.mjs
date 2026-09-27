/**
 * Portable capability-authority routing for delivery repositories.
 *
 * A link on a repository's state branch is not authority. It is a credential-free routing hint
 * that lets a fresh machine find the one configuration repository it must verify. Consumers must
 * still observe the current `sflow/config` ref and prove the repository mapping from that exact
 * approved catalog before using it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { frozenRemoteTransport, remoteFingerprint, sanitizeRemote,
  assertCredentialFreeRemote } from './git-remote-diagnostics.mjs';
import {
  GitRemoteSession, requireRemoteObservation, runRemoteGitAsync, sealTemporaryGitReadTransport
} from './git-execution.mjs';
import { enterpriseGitEnvironment, inheritEnterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { publishToStateBranch } from './ledger.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { processResultCompleted, processResultSucceeded } from './process-result.mjs';
import { readRefTreeResult } from './git-ref-tree.mjs';
import {
  mapLimit, removeTemporaryTree, run, SingularityFlowError, writeAtomic
} from './util.mjs';
import { gitRepositoryComparisonKey } from './git-repository-identity.mjs';
import { gitDisabledHooksPath } from './git-isolation-paths.mjs';

export const CAPABILITY_AUTHORITY_LINK_PATH = 'singularity/capability-authority.json';
export const CAPABILITY_AUTHORITY_BRANCH = 'sflow/config';
export const DEFAULT_CAPABILITY_STATE_BRANCH = 'state';
const AUTHORITY_CACHE_REF = 'refs/sflow/cache/state';
const AUTHORITY_CACHE_FAMILY = 'capability-authority-cache-entry';
const DEFAULT_AUTHORITY_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const AUTHORITY_LINK_FETCH_BLOB_LIMIT = 256 * 1024;

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function repositoryIdentity(remote) {
  const accepted = assertCredentialFreeRemote(remote);
  const key = gitRepositoryComparisonKey(accepted);
  return `sha256:${recordSha256({ repositoryKey: key ?? `exact:${accepted}` })}`;
}

function legacyRepositoryIdentity(remote) {
  return `sha256:${remoteFingerprint(assertCredentialFreeRemote(remote))}`;
}

function authorityCachePaths(repository, branch, env) {
  const key = recordSha256({ repositoryIdentity: repositoryIdentity(repository), stateBranch: branch });
  const configured = String(env.SINGULARITY_FLOW_AUTHORITY_CACHE ?? '').trim();
  if (configured.toLowerCase() === 'off') return null;
  const registry = String(env.SINGULARITY_FLOW_LEAD_REGISTRY ?? '').trim();
  const root = configured
    ? path.resolve(configured)
    : registry
      ? path.join(path.dirname(path.resolve(registry)), '.cache', 'capability-authority', 'v1')
      : path.join(os.homedir(), '.singularity-flow', 'cache', 'capability-authority', 'v1');
  return Object.freeze({ root, directory: path.join(root, key), record: path.join(root, `${key}.json`) });
}

async function refuseAuthorityCacheSymlinks(cache) {
  for (const candidate of [cache.root, cache.directory, cache.record]) {
    const info = await lstat(candidate).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new SingularityFlowError(
      'The capability-authority cache contains a symbolic link and was refused.', {
        code: 'CAPABILITY_AUTHORITY_CACHE_PATH_INVALID'
      }
    );
  }
}

function createAuthorityCacheEntry(repository, branch, stateCommit, result) {
  const core = {
    schemaVersion: currentSchemaVersion(AUTHORITY_CACHE_FAMILY),
    kind: AUTHORITY_CACHE_FAMILY,
    repositoryIdentity: repositoryIdentity(repository),
    stateBranch: branch,
    stateCommit,
    status: result.status,
    link: result.link ?? null
  };
  return Object.freeze({ ...core, cacheSha256: `sha256:${recordSha256(core)}` });
}

function validateAuthorityCacheEntry(value, repository, branch, stateCommit) {
  const record = readRecord(AUTHORITY_CACHE_FAMILY, value).record;
  const core = record && typeof record === 'object' ? { ...record } : null;
  if (core) delete core.cacheSha256;
  const valid = record?.kind === AUTHORITY_CACHE_FAMILY
    && record.repositoryIdentity === repositoryIdentity(repository)
    && record.stateBranch === branch
    && record.stateCommit === stateCommit
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(record.stateCommit ?? '')
    && ['current', 'missing'].includes(record.status)
    && (record.status !== 'missing' || record.link === null)
    && record.cacheSha256 === `sha256:${recordSha256(core)}`;
  if (!valid) throw new Error('Capability authority cache entry does not match the observed ref.');
  return record.status === 'missing'
    ? { status: 'missing', link: null }
    : { status: 'current', link: validateCapabilityAuthorityLink(record.link, repository) };
}

async function cachedAuthorityLink(file, repository, branch, stateCommit, directory) {
  try {
    if (await authorityStoreIncomplete(directory)) return null;
    const bytes = await readFile(file, 'utf8');
    if (await authorityStoreIncomplete(directory)) return null;
    return validateAuthorityCacheEntry(bytes, repository, branch, stateCommit);
  } catch {
    return null;
  }
}

function initializeAuthorityObjectStore(directory, stateCommit, env, runCommand) {
  const existing = runCommand('git', ['rev-parse', '--is-bare-repository'], {
    cwd: directory, env, allowFailure: true, timeoutClass: 'local-read'
  });
  if (!processResultCompleted(existing)) return false;
  if (processResultSucceeded(existing) && existing.stdout.trim() === 'true') return true;
  return processResultSucceeded(runCommand('git', [
    'init', '--quiet', '--bare',
    ...(stateCommit.length === 64 ? ['--object-format=sha256'] : []),
    directory
  ], { cwd: directory, env, allowFailure: true, timeoutClass: 'local-read' }));
}

function authorityCacheMaximumBytes(env) {
  const configured = Number(env.SINGULARITY_FLOW_AUTHORITY_CACHE_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured >= 1024 * 1024
    ? Math.min(configured, 2 * 1024 * 1024 * 1024)
    : DEFAULT_AUTHORITY_CACHE_MAX_BYTES;
}

function authorityObjectStoreBytes(directory, env, runCommand) {
  const measured = runCommand('git', ['count-objects', '-v'], {
    cwd: directory, env, allowFailure: true, timeoutClass: 'local-read'
  });
  if (!processResultSucceeded(measured)) return null;
  const values = new Map(String(measured.stdout ?? '').split('\n').map((row) => {
    const [key, value] = row.trim().split(/:\s*/, 2);
    return [key, Number(value)];
  }));
  const looseKiB = values.get('size');
  const packedKiB = values.get('size-pack');
  return Number.isFinite(looseKiB) && Number.isFinite(packedKiB)
    ? (looseKiB + packedKiB) * 1024
    : null;
}

async function enforceAuthorityObjectStoreQuota(directory, env, runCommand) {
  const info = await lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  const bytes = authorityObjectStoreBytes(directory, env, runCommand);
  if (bytes != null && bytes > authorityCacheMaximumBytes(env)) {
    // This is a derived, identity-keyed cache directory and the caller holds its record lease.
    // Removing it cannot remove an application checkout or any authoritative configuration.
    await removeTemporaryTree(directory);
  }
}

async function authorityStoreIncomplete(directory) {
  return lstat(`${directory}.incomplete`).then(() => true, (error) => error?.code !== 'ENOENT');
}

function unavailableAuthorityStore(cleanupUnproven, code, message) {
  return { status: 'unavailable', cleanupUnproven, failure: { code, message } };
}

function incompleteAuthorityStore() {
  return unavailableAuthorityStore(true, 'CAPABILITY_AUTHORITY_CACHE_CLEANUP_UNKNOWN',
    'A previous authority object-store read has an unconfirmed process cleanup outcome. The store was preserved.');
}

/** Publish quarantine before dispatch: an interrupted host cannot lose an unknown child's store. */
async function withAuthorityStoreOperation(directory, operation) {
  if (await authorityStoreIncomplete(directory)) return incompleteAuthorityStore();
  await mkdir(directory, { recursive: true });
  const marker = `${directory}.incomplete`;
  const markerBytes = Buffer.from(`Authority object-store operation completion unconfirmed: ${randomUUID()}\n`);
  let handle;
  let owned;
  try {
    handle = await open(marker, 'wx+', 0o600);
    owned = await handle.stat();
    await handle.writeFile(markerBytes);
    await handle.sync();
  } catch {
    await handle?.close().catch(() => {});
    // No Git process starts unless its quarantine marker was successfully persisted. An occupied
    // marker is never replaced, and failed marker publication cannot authorize deleting the store.
    return unavailableAuthorityStore(true, 'CAPABILITY_AUTHORITY_CACHE_QUARANTINE_UNAVAILABLE',
      'The private authority object store could not publish its operation quarantine. The store was preserved.');
  }
  const state = { cleanupUnproven: false };
  const runCommand = (command, args, options) => {
    if (state.cleanupUnproven) return { status: 1, stdout: '', stderr: '', blocked: true };
    let result;
    try {
      if (command !== 'git') throw new TypeError('Authority object stores admit only Git commands.');
      result = run('git', ['-c', `core.hooksPath=${gitDisabledHooksPath()}`, ...args], options);
    } catch {
      state.cleanupUnproven = true;
      return { status: 1, stdout: '', stderr: '', blocked: true };
    }
    if (!processResultCompleted(result)) state.cleanupUnproven = true;
    // The compatibility tree reader historically tests status alone. A poisoned status zero must
    // not be parsed as current bytes, absence proof, or permission to delete this store.
    return result.status === 0 && !processResultSucceeded(result) ? { ...result, status: 1 } : result;
  };
  try {
    return await operation(state, runCommand);
  } catch {
    // A rejected runner can have lost acknowledgement after dispatch. Keep quarantine rather than
    // guessing it threw before starting a child or allowing the fallback's finally to remove it.
    state.cleanupUnproven = true;
    return unavailableAuthorityStore(true, 'CAPABILITY_AUTHORITY_CACHE_OPERATION_UNCONFIRMED',
      'The authority object-store operation did not return a confirmed process outcome. The store was preserved.');
  } finally {
    const completionKnown = !state.cleanupUnproven;
    let markerRemoved = false;
    try {
      if (completionKnown) {
        // Keeping the original handle open prevents unlink/recreate inode reuse from satisfying
        // this CAS. Its bounded nonce bytes also detect an in-place successor marker replacement.
        const observed = Buffer.alloc(markerBytes.length + 1);
        const { bytesRead } = await handle.read(observed, 0, observed.length, 0);
        const current = await lstat(marker).catch(() => null);
        if (bytesRead === markerBytes.length && markerBytes.equals(observed.subarray(0, bytesRead))
            && current?.isFile() && current.nlink === 1
            && current.dev === owned.dev && current.ino === owned.ino) {
          await unlink(marker);
          markerRemoved = true;
        }
      }
    } catch { /* An unverified marker is preserved; no process-death claim follows from I/O. */ }
    finally { await handle.close().catch(() => {}); }
    if (completionKnown && !markerRemoved) return unavailableAuthorityStore(true,
      'CAPABILITY_AUTHORITY_CACHE_QUARANTINE_CHANGED',
      'The authority object-store quarantine could not be released by its exact owner. The store was preserved.');
  }
}

async function fetchAuthorityLink(repository, branch, stateCommit, directory, {
  env, runRemoteCommand, enforceQuota = false
}) {
  return withAuthorityStoreOperation(directory, async (state, runCommand) => {
    if (enforceQuota) {
      await enforceAuthorityObjectStoreQuota(directory, env, runCommand);
      if (state.cleanupUnproven) return incompleteAuthorityStore();
      await mkdir(directory, { recursive: true });
    }
    if (!initializeAuthorityObjectStore(directory, stateCommit, env, runCommand)) return unavailableAuthorityStore(
      state.cleanupUnproven, 'CAPABILITY_AUTHORITY_CACHE_INITIALIZATION_UNCONFIRMED',
      'The private authority object store could not confirm its initialization.');
    const transport = frozenRemoteTransport(repository, { env });
    const seal = () => {
      const result = sealTemporaryGitReadTransport(directory, { env });
      if (result.cleanupUnproven) state.cleanupUnproven = true;
      return result.ok ? null : unavailableAuthorityStore(state.cleanupUnproven,
        'CAPABILITY_AUTHORITY_CACHE_TRANSPORT_UNVERIFIED',
        'The private authority object store could not be sealed for local reads.');
    };
    const beforeRead = seal();
    if (beforeRead) return beforeRead;
    // A receipt can be corrupt/absent while its exact Git objects remain complete. Prove the
    // bounded link read locally with lazy fetching disabled before transferring the same objects.
    const local = authorityLinkAtCommit(directory, stateCommit, repository, transport.env, runCommand);
    if (state.cleanupUnproven) return incompleteAuthorityStore();
    if (['current', 'missing', 'invalid'].includes(local.status)) return local;
    // Keep the existing fetch argv contract while disabling hooks through this owner's narrowly
    // extended, already-attested frozen transport. No caller configuration is admitted here.
    const count = Number(transport.env.GIT_CONFIG_COUNT);
    const fetchEnv = inheritEnterpriseGitEnvironment(transport.env, {
      ...transport.env, GIT_CONFIG_COUNT: String(count + 1),
      [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath',
      [`GIT_CONFIG_VALUE_${count}`]: gitDisabledHooksPath()
    });
    const fetched = await runRemoteCommand([
      'fetch', '--quiet', '--no-tags', '--depth', '1',
      `--filter=blob:limit=${AUTHORITY_LINK_FETCH_BLOB_LIMIT}`,
      transport.remote,
      `+refs/heads/${branch}:${AUTHORITY_CACHE_REF}`
    ], { cwd: directory, operation: 'remote-configuration', env: fetchEnv });
    if (!processResultSucceeded(fetched)) {
      state.cleanupUnproven = !processResultCompleted(fetched);
      return { status: 'unavailable', cleanupUnproven: state.cleanupUnproven, failure: fetched.failure ?? {
        code: 'CAPABILITY_AUTHORITY_LINK_FETCH_FAILED', message: 'The authority-link transfer did not return a completed success.'
      } };
    }
    const afterFetch = seal();
    if (afterFetch) return afterFetch;
    const fetchedTip = runCommand('git', ['rev-parse', '--verify', AUTHORITY_CACHE_REF], {
      cwd: directory, env: transport.env, allowFailure: true, timeoutClass: 'local-read'
    });
    if (!processResultSucceeded(fetchedTip)) return unavailableAuthorityStore(state.cleanupUnproven,
      'CAPABILITY_AUTHORITY_CACHE_REF_UNCONFIRMED', 'The transferred authority object-store ref could not be confirmed.');
    const fetchedCommit = fetchedTip.stdout.trim();
    if (fetchedCommit !== stateCommit) return { status: 'stale', observedCommit: fetchedCommit };
    const result = authorityLinkAtCommit(directory, stateCommit, repository, transport.env, runCommand);
    return state.cleanupUnproven ? incompleteAuthorityStore() : result;
  });
}

function authorityLinkAtCommit(directory, stateCommit, repository, env, runCommand) {
  const tree = readRefTreeResult(directory, stateCommit, [CAPABILITY_AUTHORITY_LINK_PATH], {
    env, runCommand, maxBatchBytes: 1024 * 1024, maxObjectBytes: 256 * 1024
  });
  if (tree.status !== 'ok') return {
    status: 'unavailable',
    failure: { code: 'CAPABILITY_AUTHORITY_LINK_READ_FAILED', message: tree.errors[0]?.message }
  };
  const bytes = tree.contents.get(CAPABILITY_AUTHORITY_LINK_PATH);
  if (bytes == null) return { status: 'missing' };
  try {
    return { status: 'current', link: validateCapabilityAuthorityLink(bytes, repository) };
  } catch (error) {
    return {
      status: 'invalid', failure: {
        code: error?.code ?? 'CAPABILITY_AUTHORITY_LINK_INVALID',
        message: error?.message ?? String(error)
      }
    };
  }
}

export function capabilityAuthorityId(remote, branch = CAPABILITY_AUTHORITY_BRANCH) {
  const authority = assertCredentialFreeRemote(remote);
  const ref = String(branch ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..') || ref.endsWith('/')) {
    throw new SingularityFlowError(`Capability authority branch '${ref}' is invalid.`, {
      code: 'CAPABILITY_AUTHORITY_LINK_INVALID'
    });
  }
  return `sha256:${recordSha256({ remote: authority, branch: ref })}`;
}

export function createCapabilityAuthorityLink({
  authorityRemote,
  authorityBranch = CAPABILITY_AUTHORITY_BRANCH,
  repositoryRemote,
  capabilityIds
}) {
  const authority = assertCredentialFreeRemote(authorityRemote);
  const repository = assertCredentialFreeRemote(repositoryRemote);
  const ids = [...new Set((capabilityIds ?? []).map((entry) => String(entry ?? '').trim()))]
    .filter(Boolean).sort();
  if (!ids.length || ids.some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
    throw new SingularityFlowError('Capability authority link requires lower-kebab capability IDs.', {
      code: 'CAPABILITY_AUTHORITY_LINK_INVALID'
    });
  }
  const core = {
    schemaVersion: currentSchemaVersion('capability-authority-link'),
    kind: 'capability-authority-link',
    authority: {
      id: capabilityAuthorityId(authority, authorityBranch),
      remote: authority,
      branch: authorityBranch,
      catalogPath: 'singularity/capabilities.yml'
    },
    subject: {
      repositoryIdentity: repositoryIdentity(repository),
      capabilityIds: ids
    }
  };
  return Object.freeze({ ...core, linkSha256: `sha256:${recordSha256(core)}` });
}

export function validateCapabilityAuthorityLink(value, repositoryRemote) {
  const link = readRecord('capability-authority-link', value).record;
  const expectedKeys = ['authority', 'kind', 'linkSha256', 'schemaVersion', 'subject'];
  const actualKeys = Object.keys(link ?? {}).sort();
  let authority = null;
  try { authority = assertCredentialFreeRemote(link?.authority?.remote); } catch {}
  const ids = link?.subject?.capabilityIds;
  const core = link && typeof link === 'object' ? { ...link } : null;
  if (core) delete core.linkSha256;
  const valid = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
    && link?.kind === 'capability-authority-link'
    && authority != null
    && link.authority.branch === CAPABILITY_AUTHORITY_BRANCH
    && link.authority.catalogPath === 'singularity/capabilities.yml'
    && link.authority.id === capabilityAuthorityId(authority, link.authority.branch)
    && [repositoryIdentity(repositoryRemote), legacyRepositoryIdentity(repositoryRemote)]
      .includes(link.subject?.repositoryIdentity)
    && Array.isArray(ids) && ids.length > 0 && ids.length <= 256
    && ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    && JSON.stringify(ids) === JSON.stringify([...new Set(ids)].sort())
    && link.linkSha256 === `sha256:${recordSha256(core)}`;
  if (!valid) {
    throw new SingularityFlowError(
      'The capability authority link is incomplete, inconsistent, or belongs to another repository.', {
        code: 'CAPABILITY_AUTHORITY_LINK_INVALID',
        details: { repository: sanitizeRemote(repositoryRemote) }
      }
    );
  }
  return Object.freeze({
    ...link,
    authority: Object.freeze({ ...link.authority, remote: authority }),
    subject: Object.freeze({ ...link.subject, capabilityIds: Object.freeze([...ids]) })
  });
}

async function cloneOneBranch(remote, branch, scratch, {
  env = process.env,
  operation = 'remote-configuration',
  runRemoteCommand = runRemoteGitAsync
} = {}) {
  const transport = frozenRemoteTransport(remote, { env });
  const cloned = await runRemoteCommand([
    'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--no-checkout', '--branch', branch, transport.remote, scratch
  ], { operation, env: transport.env });
  return { cloned, transport };
}

/** Read and subject-bind the routing hint without treating it as an approved map. */
export async function readCapabilityAuthorityLink(repositoryRemote, {
  stateBranch = DEFAULT_CAPABILITY_STATE_BRANCH,
  env = process.env,
  remoteSession = null,
  runRemoteCommand = runRemoteGitAsync
} = {}) {
  const repository = assertCredentialFreeRemote(repositoryRemote);
  const branch = String(stateBranch ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
    throw new SingularityFlowError(`Capability state branch '${branch}' is invalid.`, {
      code: 'CAPABILITY_AUTHORITY_LINK_INVALID'
    });
  }
  const gitEnv = remoteSession?.env ?? enterpriseGitEnvironment(env);
  const session = remoteSession ?? new GitRemoteSession({ env: gitEnv });
  const ref = `refs/heads/${branch}`;
  const observed = await session.observeAsync(repository, { includeHead: false, refs: [ref] });
  if (!observed.ok) {
    return Object.freeze({
      status: 'unavailable', repository: sanitizeRemote(repository), stateBranch: branch,
      stateCommit: null, link: null, failure: observed.failure
    });
  }
  const stateCommit = observed.refs.get(ref) ?? null;
  if (!stateCommit) return Object.freeze({
    status: 'missing', repository: sanitizeRemote(repository), stateBranch: branch,
    stateCommit: null, link: null, failure: null
  });
  const cache = authorityCachePaths(repository, branch, gitEnv);
  const hit = cache
    ? await refuseAuthorityCacheSymlinks(cache)
      .then(() => cachedAuthorityLink(cache.record, repository, branch, stateCommit, cache.directory))
      .catch(() => null)
    : null;
  if (hit) return Object.freeze({
    status: hit.status, repository: sanitizeRemote(repository), stateBranch: branch,
    stateCommit, link: hit.link, failure: null
  });

  let materialized;
  try {
    if (!cache) throw new Error('Capability-authority cache is disabled.');
    await refuseAuthorityCacheSymlinks(cache);
    const { withRegistryFileLease } = await import('./workspace.mjs');
    materialized = await withRegistryFileLease(cache.record, async () => {
      await refuseAuthorityCacheSymlinks(cache);
      const concurrent = await cachedAuthorityLink(cache.record, repository, branch, stateCommit, cache.directory);
      if (concurrent) return concurrent;
      const fetched = await fetchAuthorityLink(repository, branch, stateCommit, cache.directory, {
        env: gitEnv, runRemoteCommand, enforceQuota: true
      });
      if (['current', 'missing'].includes(fetched.status)) {
        const entry = createAuthorityCacheEntry(repository, branch, stateCommit, fetched);
        await writeAtomic(cache.record, canonicalJson(entry), { mode: 0o600 }).catch(() => {});
      }
      return fetched;
    }, { timeoutMs: 10_000 });
  } catch {
    // Cache storage is a performance aid, never authority and never a reason to hide a readable
    // state link. A private one-shot object store preserves the exact-ref proof if the cache is
    // unavailable, corrupted, or contended.
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-authority-'));
    try {
      materialized = await fetchAuthorityLink(repository, branch, stateCommit, scratch, {
        env: gitEnv, runRemoteCommand
      });
    } finally {
      if (!materialized?.cleanupUnproven) await removeTemporaryTree(scratch);
    }
  }
  return Object.freeze({
    status: materialized.status,
    repository: sanitizeRemote(repository),
    stateBranch: branch,
    stateCommit,
    ...(materialized.observedCommit ? { observedCommit: materialized.observedCommit } : {}),
    link: materialized.link ?? null,
    failure: materialized.failure ?? null
  });
}

/** Publish one canonical link through the ordinary exact state-branch CAS. */
export async function publishCapabilityAuthorityLink(repositoryRemote, link, {
  defaultBranch = 'main',
  stateBranch = DEFAULT_CAPABILITY_STATE_BRANCH,
  env = process.env,
  commitIdentity = null,
  commitSigning = null
} = {}) {
  const repository = assertCredentialFreeRemote(repositoryRemote);
  const validated = validateCapabilityAuthorityLink(link, repository);
  const gitEnv = enterpriseGitEnvironment(env);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-link-publish-'));
  try {
    const { cloned, transport } = await cloneOneBranch(repository, defaultBranch, scratch, {
      env: gitEnv, operation: 'remote-configuration'
    });
    if (cloned.status !== 0) throw new SingularityFlowError(
      `Cannot prepare portable capability discovery for '${sanitizeRemote(repository)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`, {
        code: cloned.failure?.code ?? 'CAPABILITY_AUTHORITY_LINK_PUBLICATION_FAILED'
      }
    );
    const bytes = canonicalJson(validated);
    const result = await publishToStateBranch(scratch, {
      enabled: true,
      branch: stateBranch,
      remote: 'origin',
      publication: 'warn',
      signing: commitSigning?.required === true ? 'commit' : 'off'
    }, { [CAPABILITY_AUTHORITY_LINK_PATH]: bytes }, 'Publish capability authority link', {
      env: transport.env,
      transportRemote: repository,
      commitIdentity,
      commitSigning,
      exactBlobSha256: { [CAPABILITY_AUTHORITY_LINK_PATH]: sha256(bytes) }
    });
    return Object.freeze({
      repository: sanitizeRemote(repository), stateBranch,
      published: result.changed === true,
      current: result.changed !== true,
      commit: result.commit ?? null,
      linkSha256: validated.linkSha256
    });
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/**
 * Retire one obsolete routing hint through the state writer's exact branch CAS.
 *
 * This primitive deliberately knows nothing about capability policy. Its caller must first prove
 * that the current approved authority no longer claims the repository. Here we bind that decision
 * to the exact state commit and exact validated link that were reviewed, remove only that path,
 * and preserve every other state-branch byte and ref.
 */
export async function retireCapabilityAuthorityLink(repositoryRemote, {
  stateBranch = DEFAULT_CAPABILITY_STATE_BRANCH,
  expectedStateCommit,
  expectedLinkSha256,
  env = process.env
} = {}) {
  const repository = assertCredentialFreeRemote(repositoryRemote);
  const branch = String(stateBranch ?? '').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(String(expectedStateCommit ?? ''))
      || !/^sha256:[0-9a-f]{64}$/.test(String(expectedLinkSha256 ?? ''))) {
    throw new SingularityFlowError(
      'Capability authority-link retirement requires the exact reviewed state commit and link digest.', {
        code: 'CAPABILITY_AUTHORITY_LINK_RETIREMENT_STALE_PLAN'
      }
    );
  }
  const current = await readCapabilityAuthorityLink(repository, {
    stateBranch: branch, env
  });
  if (current.status !== 'current'
      || current.stateCommit !== expectedStateCommit
      || current.link?.linkSha256 !== expectedLinkSha256) {
    throw new SingularityFlowError(
      'The delivery state branch or capability authority link changed after the retirement plan was reviewed. Nothing was changed.', {
        code: 'CAPABILITY_AUTHORITY_LINK_RETIREMENT_STALE_PLAN',
        details: {
          stateBranch: branch,
          expectedStateCommit,
          observedStateCommit: current.stateCommit ?? null,
          expectedLinkSha256,
          observedLinkSha256: current.link?.linkSha256 ?? null,
          linkStatus: current.status
        }
      }
    );
  }

  const gitEnv = enterpriseGitEnvironment(env);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-link-retire-'));
  try {
    const { cloned, transport } = await cloneOneBranch(repository, branch, scratch, {
      env: gitEnv, operation: 'remote-configuration'
    });
    if (cloned.status !== 0) throw new SingularityFlowError(
      `Cannot prepare stale capability-link retirement for '${sanitizeRemote(repository)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`, {
        code: cloned.failure?.code ?? 'CAPABILITY_AUTHORITY_LINK_RETIREMENT_FAILED'
      }
    );
    const clonedStateCommit = run('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    const clonedLink = run('git', [
      'show', `HEAD:${CAPABILITY_AUTHORITY_LINK_PATH}`
    ], { cwd: scratch, env: transport.env, allowFailure: true });
    let validatedLink = null;
    try {
      if (clonedLink.status === 0) {
        validatedLink = validateCapabilityAuthorityLink(clonedLink.stdout, repository);
      }
    } catch { /* the exact mismatch below owns the stable refusal */ }
    if (clonedStateCommit !== expectedStateCommit
        || validatedLink?.linkSha256 !== expectedLinkSha256) {
      throw new SingularityFlowError(
        'The delivery state bytes changed while the stale-link retirement was being prepared. Nothing was changed.', {
          code: 'CAPABILITY_AUTHORITY_LINK_RETIREMENT_STALE_PLAN',
          details: {
            stateBranch: branch,
            expectedStateCommit,
            observedStateCommit: clonedStateCommit || null,
            expectedLinkSha256,
            observedLinkSha256: validatedLink?.linkSha256 ?? null
          }
        }
      );
    }
    const publication = await publishToStateBranch(scratch, {
      enabled: true,
      branch,
      remote: 'origin',
      publication: 'warn'
    }, {}, 'Retire stale capability authority link', {
      removePaths: [CAPABILITY_AUTHORITY_LINK_PATH],
      expectedRemoteSha: expectedStateCommit,
      baseRef: expectedStateCommit,
      refreshRemote: false,
      env: transport.env,
      transportRemote: repository
    });
    if (publication.changed !== true
        || publication.removed?.length !== 1
        || publication.removed[0] !== CAPABILITY_AUTHORITY_LINK_PATH
        || publication.published?.length !== 0) {
      throw new SingularityFlowError(
        'The stale capability authority link was not retired as the exact one-path state update.', {
          code: 'CAPABILITY_AUTHORITY_LINK_RETIREMENT_FAILED',
          details: { publication }
        }
      );
    }
    return Object.freeze({
      status: 'retired',
      repository: sanitizeRemote(repository),
      stateBranch: branch,
      previousStateCommit: expectedStateCommit,
      commit: publication.commit,
      removed: Object.freeze([...publication.removed]),
      preserved: Object.freeze(['all other state files', 'all other refs', 'application branches'])
    });
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** Publish a bounded set concurrently while preserving every per-repository failure. */
export async function publishCapabilityAuthorityLinkSet(entries, {
  workers = 4,
  env = process.env,
  commitIdentity = null,
  commitSigning = null
} = {}) {
  // A repository may use a custom runtime state branch. Publish the ordinary `state` discovery
  // locator as well as the custom branch so a fresh laptop, which cannot know the custom branch
  // before reading the locator, can still find the approved authority. Therefore de-duplicate by
  // repository *and branch*, not repository alone.
  const unique = [...new Map((entries ?? []).map((entry) => {
    const repository = assertCredentialFreeRemote(entry.repositoryRemote);
    const branch = entry.stateBranch ?? DEFAULT_CAPABILITY_STATE_BRANCH;
    return [JSON.stringify([repository, branch]), entry];
  })).values()];
  const outcomes = await mapLimit(unique, Math.max(1, Math.min(workers, unique.length || 1)),
    async (entry) => {
      try {
        const link = createCapabilityAuthorityLink(entry);
        return {
          status: 'current',
          ...(await publishCapabilityAuthorityLink(entry.repositoryRemote, link, {
            defaultBranch: entry.defaultBranch,
            stateBranch: entry.stateBranch,
            env,
            commitIdentity,
            commitSigning
          }))
        };
      } catch (error) {
        return {
          status: 'pending',
          repository: sanitizeRemote(entry.repositoryRemote),
          stateBranch: entry.stateBranch ?? DEFAULT_CAPABILITY_STATE_BRANCH,
          published: false,
          current: false,
          commit: null,
          code: error?.code ?? 'CAPABILITY_AUTHORITY_LINK_PUBLICATION_FAILED',
          reason: error?.message ?? String(error)
        };
      }
    });
  const pending = outcomes.filter((entry) => entry.status !== 'current');
  return Object.freeze({
    status: pending.length ? 'pending' : 'current',
    portable: pending.length === 0,
    outcomes: Object.freeze(outcomes.map(Object.freeze)),
    pending: Object.freeze(pending.map((entry) => entry.repository))
  });
}
