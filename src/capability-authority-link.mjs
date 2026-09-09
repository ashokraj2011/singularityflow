/**
 * Portable capability-authority routing for delivery repositories.
 *
 * A link on a repository's state branch is not authority. It is a credential-free routing hint
 * that lets a fresh machine find the one configuration repository it must verify. Consumers must
 * still observe the current `sflow/config` ref and prove the repository mapping from that exact
 * approved catalog before using it.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { frozenRemoteTransport, remoteFingerprint, sanitizeRemote,
  assertCredentialFreeRemote } from './git-remote-diagnostics.mjs';
import { GitRemoteSession, requireRemoteObservation, runRemoteGitAsync } from './git-execution.mjs';
import { publishToStateBranch } from './ledger.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { partialCloneConfigured, partialCloneFallbackDecision } from './clone-strategy.mjs';
import { mapLimit, run, SingularityFlowError } from './util.mjs';

export const CAPABILITY_AUTHORITY_LINK_PATH = 'singularity/capability-authority.json';
export const CAPABILITY_AUTHORITY_BRANCH = 'sflow/config';
export const DEFAULT_CAPABILITY_STATE_BRANCH = 'state';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function repositoryIdentity(remote) {
  return `sha256:${remoteFingerprint(assertCredentialFreeRemote(remote))}`;
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
  const gitEnv = remoteSession?.env ?? env;
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

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-authority-'));
  try {
    const { cloned, transport } = await cloneOneBranch(repository, branch, scratch, {
      env: gitEnv, runRemoteCommand
    });
    if (cloned.status !== 0) return Object.freeze({
      status: 'unavailable', repository: sanitizeRemote(repository), stateBranch: branch,
      stateCommit, link: null, failure: cloned.failure ?? null
    });
    const clonedCommit = run('git', ['rev-parse', 'HEAD'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    if (clonedCommit !== stateCommit) return Object.freeze({
      status: 'stale', repository: sanitizeRemote(repository), stateBranch: branch,
      stateCommit, observedCommit: clonedCommit, link: null, failure: null
    });
    const shown = run('git', ['show', `HEAD:${CAPABILITY_AUTHORITY_LINK_PATH}`], {
      cwd: scratch, env: transport.env, allowFailure: true
    });
    if (shown.status !== 0) return Object.freeze({
      status: 'missing', repository: sanitizeRemote(repository), stateBranch: branch,
      stateCommit, link: null, failure: null
    });
    try {
      return Object.freeze({
        status: 'current', repository: sanitizeRemote(repository), stateBranch: branch,
        stateCommit, link: validateCapabilityAuthorityLink(shown.stdout, repository), failure: null
      });
    } catch (error) {
      return Object.freeze({
        status: 'invalid', repository: sanitizeRemote(repository), stateBranch: branch,
        stateCommit, link: null, failure: {
          code: error?.code ?? 'CAPABILITY_AUTHORITY_LINK_INVALID',
          message: error?.message ?? String(error)
        }
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Publish one canonical link through the ordinary exact state-branch CAS. */
export async function publishCapabilityAuthorityLink(repositoryRemote, link, {
  defaultBranch = 'main',
  stateBranch = DEFAULT_CAPABILITY_STATE_BRANCH,
  env = process.env
} = {}) {
  const repository = assertCredentialFreeRemote(repositoryRemote);
  const validated = validateCapabilityAuthorityLink(link, repository);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-link-publish-'));
  try {
    const { cloned, transport } = await cloneOneBranch(repository, defaultBranch, scratch, {
      env, operation: 'remote-configuration'
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
