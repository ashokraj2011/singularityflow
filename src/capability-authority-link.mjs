/**
 * Portable capability-authority routing for delivery repositories.
 *
 * A link on a repository's state branch is not authority. It is a credential-free routing hint
 * that lets a fresh machine find the one configuration repository it must verify. Consumers must
 * still observe the current `sflow/config` ref and prove the repository mapping from that exact
 * approved catalog before using it.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { frozenRemoteTransport, remoteFingerprint, sanitizeRemote,
  assertCredentialFreeRemote } from './git-remote-diagnostics.mjs';
import { GitRemoteSession, requireRemoteObservation, runRemoteGitAsync } from './git-execution.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { publishToStateBranch } from './ledger.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { partialCloneConfigured, partialCloneFallbackDecision } from './clone-strategy.mjs';
import { readRefTreeResult } from './git-ref-tree.mjs';
import { mapLimit, run, SingularityFlowError, writeAtomic } from './util.mjs';

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

function createAuthorityCacheEntry(repository, branch, stateCommit, link) {
  const core = {
    schemaVersion: currentSchemaVersion(AUTHORITY_CACHE_FAMILY),
    kind: AUTHORITY_CACHE_FAMILY,
    repositoryIdentity: repositoryIdentity(repository),
    stateBranch: branch,
    stateCommit,
    link
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
    && /^[0-9a-f]{40,64}$/i.test(record.stateCommit ?? '')
    && record.cacheSha256 === `sha256:${recordSha256(core)}`;
  if (!valid) throw new Error('Capability authority cache entry does not match the observed ref.');
  return validateCapabilityAuthorityLink(record.link, repository);
}

async function cachedAuthorityLink(file, repository, branch, stateCommit) {
  try {
    const bytes = await readFile(file, 'utf8');
    return validateAuthorityCacheEntry(bytes, repository, branch, stateCommit);
  } catch {
    return null;
  }
}

function initializeAuthorityObjectStore(directory, stateCommit, env) {
  const existing = run('git', ['rev-parse', '--is-bare-repository'], {
    cwd: directory, env, allowFailure: true, timeoutClass: 'local-read'
  });
  if (existing.status === 0 && existing.stdout.trim() === 'true') return;
  run('git', [
    'init', '--quiet', '--bare',
    ...(stateCommit.length === 64 ? ['--object-format=sha256'] : []),
    directory
  ], { env });
}

function authorityCacheMaximumBytes(env) {
  const configured = Number(env.SINGULARITY_FLOW_AUTHORITY_CACHE_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured >= 1024 * 1024
    ? Math.min(configured, 2 * 1024 * 1024 * 1024)
    : DEFAULT_AUTHORITY_CACHE_MAX_BYTES;
}

function authorityObjectStoreBytes(directory, env) {
  const measured = run('git', ['count-objects', '-v'], {
    cwd: directory, env, allowFailure: true, timeoutClass: 'local-read'
  });
  if (measured.status !== 0) return null;
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

async function enforceAuthorityObjectStoreQuota(directory, env) {
  const info = await lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  const bytes = authorityObjectStoreBytes(directory, env);
  if (bytes != null && bytes > authorityCacheMaximumBytes(env)) {
    // This is a derived, identity-keyed cache directory and the caller holds its record lease.
    // Removing it cannot remove an application checkout or any authoritative configuration.
    await rm(directory, { recursive: true, force: true });
  }
}

async function fetchAuthorityLink(repository, branch, stateCommit, directory, {
  env, runRemoteCommand
}) {
  await mkdir(directory, { recursive: true });
  initializeAuthorityObjectStore(directory, stateCommit, env);
  const transport = frozenRemoteTransport(repository, { env });
  const fetched = await runRemoteCommand([
    'fetch', '--quiet', '--no-tags', '--depth', '1',
    `--filter=blob:limit=${AUTHORITY_LINK_FETCH_BLOB_LIMIT}`,
    transport.remote,
    `+refs/heads/${branch}:${AUTHORITY_CACHE_REF}`
  ], { cwd: directory, operation: 'remote-configuration', env: transport.env });
  if (fetched.status !== 0) return { status: 'unavailable', failure: fetched.failure ?? null };
  const fetchedCommit = run('git', ['rev-parse', '--verify', AUTHORITY_CACHE_REF], {
    cwd: directory, env: transport.env, allowFailure: true, timeoutClass: 'local-read'
  }).stdout.trim();
  if (fetchedCommit !== stateCommit) return { status: 'stale', observedCommit: fetchedCommit };
  const tree = readRefTreeResult(directory, AUTHORITY_CACHE_REF, [CAPABILITY_AUTHORITY_LINK_PATH], {
    env: transport.env, maxBatchBytes: 1024 * 1024, maxObjectBytes: 256 * 1024
  });
  if (tree.status !== 'ok') return {
    status: 'unavailable', failure: { code: 'CAPABILITY_AUTHORITY_LINK_READ_FAILED', message: tree.errors[0]?.message }
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
    && link.subject?.repositoryIdentity === repositoryIdentity(repositoryRemote)
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
  const clone = (filtered) => runRemoteCommand([
    'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    ...(filtered ? ['--filter=blob:none'] : []),
    '--no-checkout', '--branch', branch, transport.remote, scratch
  ], { operation, env: transport.env });
  let cloned = await clone(true);
  const partial = partialCloneFallbackDecision(cloned, {
    configured: cloned.status === 0
      ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
          ...options, env: transport.env
        }))
      : null,
    fallback: 'full'
  });
  if (partial.action === 'retry-full') {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    cloned = await clone(false);
  }
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
      .then(() => cachedAuthorityLink(cache.record, repository, branch, stateCommit))
      .catch(() => null)
    : null;
  if (hit) return Object.freeze({
    status: 'current', repository: sanitizeRemote(repository), stateBranch: branch,
    stateCommit, link: hit, failure: null
  });

  let materialized;
  try {
    if (!cache) throw new Error('Capability-authority cache is disabled.');
    await refuseAuthorityCacheSymlinks(cache);
    const { withRegistryFileLease } = await import('./workspace.mjs');
    materialized = await withRegistryFileLease(cache.record, async () => {
      await refuseAuthorityCacheSymlinks(cache);
      const concurrent = await cachedAuthorityLink(cache.record, repository, branch, stateCommit);
      if (concurrent) return { status: 'current', link: concurrent };
      await enforceAuthorityObjectStoreQuota(cache.directory, gitEnv);
      const fetched = await fetchAuthorityLink(repository, branch, stateCommit, cache.directory, {
        env: gitEnv, runRemoteCommand
      });
      if (fetched.status === 'current') {
        const entry = createAuthorityCacheEntry(repository, branch, stateCommit, fetched.link);
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
      await rm(scratch, { recursive: true, force: true });
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
  env = process.env
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
      publication: 'warn'
    }, { [CAPABILITY_AUTHORITY_LINK_PATH]: bytes }, 'Publish capability authority link', {
      env: transport.env,
      transportRemote: repository,
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
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Publish a bounded set concurrently while preserving every per-repository failure. */
export async function publishCapabilityAuthorityLinkSet(entries, {
  workers = 4,
  env = process.env
} = {}) {
  const unique = [...new Map((entries ?? []).map((entry) => [
    assertCredentialFreeRemote(entry.repositoryRemote), entry
  ])).values()];
  const outcomes = await mapLimit(unique, Math.max(1, Math.min(workers, unique.length || 1)),
    async (entry) => {
      try {
        const link = createCapabilityAuthorityLink(entry);
        return {
          status: 'current',
          ...(await publishCapabilityAuthorityLink(entry.repositoryRemote, link, {
            defaultBranch: entry.defaultBranch,
            stateBranch: entry.stateBranch,
            env
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
