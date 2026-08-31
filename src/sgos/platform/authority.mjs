/** Runtime-owned authority for the experimental SGOS platform profile. */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import {
  matchApprovalAuthority, normalizeApprovalAuthorities, normalizeApprovalSecurity
} from '../../approval-authority.mjs';
import {
  configurationReadRoot, isConfigurationReadPath
} from '../../configuration-read-scope.mjs';
import { stateConfigurationHistoryBranch } from '../../configuration-branch.mjs';
import { identity } from '../../git.mjs';
import { runRemoteGit } from '../../git-execution.mjs';
import { frozenRemoteTransport } from '../../git-remote-diagnostics.mjs';
import { SingularityFlowError, run } from '../../util.mjs';
import { withTrustedSgosConfigurationRead } from '../authority-trust.mjs';
import {
  createPlatformMutationAuthorization, platformSha256
} from './contracts.mjs';

export const PLATFORM_MUTATION_AUTHORITIES = Object.freeze({
  'intent.confirm': 'product-approvers',
  'workflow.ratify': 'architecture-reviewers',
  'program-authority.approve': 'architecture-reviewers',
  'policy.amend': 'architecture-reviewers',
  'pack.propose': 'engineering-reviewers',
  'pack.review': 'architecture-reviewers',
  'pack.activate': 'architecture-reviewers',
  'pack.revoke': 'architecture-reviewers',
  'memory.register': 'engineering-reviewers',
  'memory.promote': 'architecture-reviewers',
  'meta-tool.propose': 'engineering-reviewers',
  'meta-tool.evaluation': 'quality-reviewers',
  'meta-tool.promote': 'architecture-reviewers',
  'meta-tool.activate': 'architecture-reviewers',
  'meta-tool.observe': 'quality-reviewers',
  'meta-tool.revoke': 'architecture-reviewers',
  'meta-tool.rollback': 'architecture-reviewers'
});

const OPERATION_IDS = new Set(Object.keys(PLATFORM_MUTATION_AUTHORITIES));
const AUTHORITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const WORKFLOW_PATH = 'singularity/workflow.yml';

function fail(message, code = 'SGOS_PLATFORM_AUTHORITY_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function nulPaths(value) {
  return value.split('\0').filter(Boolean);
}

function configurationPaths(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    fail('SGOS platform mutation could not verify the protected configuration boundary.',
      'SGOS_PLATFORM_CONFIGURATION_UNVERIFIED', {
        command: ['git', ...args], stderr: result.stderr.trim()
      });
  }
  return nulPaths(result.stdout).filter((relative) => isConfigurationReadPath(relative));
}

async function assertApprovedConfigurationBoundary(root, approvedRoot) {
  const dirty = [...new Set([
    ...configurationPaths(root, ['diff', '--name-only', '-z']),
    ...configurationPaths(root, ['diff', '--cached', '--name-only', '-z']),
    ...configurationPaths(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])].sort();
  if (dirty.length) {
    fail('SGOS platform mutation refuses dirty protected configuration. Publish configuration changes through sflow/config or restore these paths.',
      'SGOS_PLATFORM_CONFIGURATION_DIRTY', { paths: dirty });
  }

  const present = configurationPaths(root, [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z'
  ]).sort();
  const divergent = [];
  for (const relative of present) {
    const applicationPath = path.join(root, relative);
    const applicationStat = await lstat(applicationPath).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    });
    if (applicationStat == null) continue;
    const approvedPath = path.join(approvedRoot, relative);
    const approvedStat = await lstat(approvedPath).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!applicationStat.isFile() || !approvedStat?.isFile()) {
      divergent.push(relative);
      continue;
    }
    const [applicationBytes, approvedBytes] = await Promise.all([
      readFile(applicationPath), readFile(approvedPath)
    ]);
    if (sha256(applicationBytes) !== sha256(approvedBytes)) divergent.push(relative);
  }
  if (divergent.length) {
    fail('SGOS platform mutation refuses protected configuration that is stale or differs from the exact approved configuration authority.',
      'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', { paths: divergent });
  }
}

/**
 * Read a historical workflow only from the object store that supplied the verified authority.
 *
 * An application repository can share history with configuration authority while still owning
 * extra commits of its own. Asking that application object store to prove ancestry would let a
 * B-only object participate in an A-authority decision. Remote authority objects are therefore
 * fetched through the exact advertised branch that supplied it into a disposable bare store.
 * State mirrors use a source-specific immutable history branch so deleting `sflow/config` cannot
 * strand older approved policy. Offline local authority heads use their own object store directly.
 */
async function historicalAuthorityWorkflow(root, authority, sourceCommit, revision) {
  let objectStore = root;
  let temporary = null;
  if (authority.remote) {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-platform-authority-'));
    run('git', ['init', '--quiet', '--bare'], { cwd: temporary });
    const transport = frozenRemoteTransport(authority.remote);
    const retainedHistory = authority.kind === 'verified-state-mirror'
      ? authority.manifest?.history ?? null : null;
    const expectedHistoryBranch = stateConfigurationHistoryBranch(sourceCommit);
    const namedBranch = authority.kind === 'approved-configuration-ref'
      ? 'sflow/config'
      : retainedHistory?.branch === expectedHistoryBranch
          && retainedHistory?.commit === sourceCommit
        ? retainedHistory.branch
        : null;
    // New state mirrors retain source history behind an immutable advertised branch. Existing v2
    // mirrors predate that receipt; retain their legacy raw-object lookup only for compatibility,
    // with a precise repair if the server refuses unadvertised wants or has collected the object.
    const fetched = runRemoteGit(namedBranch ? [
      'fetch', '--quiet', '--no-tags', '--force', '--', transport.remote,
      `+refs/heads/${namedBranch}:refs/sgos-authority/source`
    ] : [
      'fetch', '--quiet', '--no-tags', '--force', '--', transport.remote,
      `+${sourceCommit}:refs/sgos-authority/source`
    ], {
      cwd: temporary,
      env: transport.env,
      operation: 'remote-configuration'
    });
    if (fetched.status !== 0) {
      await rm(temporary, { recursive: true, force: true });
      fail(namedBranch
        ? 'Pinned policy authorityRevision cannot be verified through its advertised configuration history ref.'
        : 'This legacy state mirror does not retain advertised configuration history, and its source object is unavailable. Refresh workspace configuration to publish an immutable history ref, then retry.',
        'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', {
          policyAuthorityRevision: revision,
          approvedConfigurationCommit: sourceCommit,
          configurationHistoryBranch: namedBranch,
          legacyStateMirror: authority.kind === 'verified-state-mirror' && namedBranch == null,
          classification: fetched.failure?.classification ?? 'unknown'
        });
    }
    objectStore = temporary;
  } else if (authority.kind === 'verified-state-mirror' && authority.manifest?.history != null) {
    const expectedHistoryBranch = stateConfigurationHistoryBranch(sourceCommit);
    if (authority.manifest.history.branch !== expectedHistoryBranch
        || authority.manifest.history.commit !== sourceCommit) {
      fail('Verified state authority contains an invalid configuration history receipt.',
        'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', {
          approvedConfigurationCommit: sourceCommit
        });
    }
    const retained = run('git', [
      'rev-parse', '--verify', `refs/heads/${expectedHistoryBranch}^{commit}`
    ], { cwd: root, allowFailure: true }).stdout.trim();
    if (retained !== sourceCommit) {
      fail('Verified local state authority is missing its retained configuration history ref.',
        'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', {
          approvedConfigurationCommit: sourceCommit,
          configurationHistoryBranch: expectedHistoryBranch
        });
    }
  }

  try {
    const retainedSource = run('git', [
      'rev-parse', '--verify', authority.remote
        ? 'refs/sgos-authority/source^{commit}' : `${sourceCommit}^{commit}`
    ], { cwd: objectStore, allowFailure: true }).stdout.trim();
    if (retainedSource !== sourceCommit) {
      fail('The selected configuration authority object store does not contain its verified source commit.',
        'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', {
          policyAuthorityRevision: revision,
          approvedConfigurationCommit: sourceCommit
        });
    }
    const ancestry = run('git', [
      'merge-base', '--is-ancestor', revision, sourceCommit
    ], { cwd: objectStore, allowFailure: true });
    if (ancestry.status !== 0) {
      fail('Pinned policy authorityRevision is not an ancestor of the refreshed approved configuration.',
        'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', {
          policyAuthorityRevision: revision,
          approvedConfigurationCommit: sourceCommit
        });
    }
    const pinned = run('git', [
      'show', `${revision}:${WORKFLOW_PATH}`
    ], { cwd: objectStore, allowFailure: true, encoding: 'buffer' });
    if (pinned.status !== 0) {
      fail(`Pinned policy authorityRevision does not contain ${WORKFLOW_PATH}.`,
        'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', { policyAuthorityRevision: revision });
    }
    return pinned.stdout;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

function operationAuthorityMap(definition) {
  const configured = definition?.sgos?.platformAuthorities ?? {};
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    fail('sgos.platformAuthorities must be an object in approved configuration.',
      'SGOS_PLATFORM_AUTHORITY_POLICY_INVALID');
  }
  for (const [operation, authorityId] of Object.entries(configured)) {
    if (!OPERATION_IDS.has(operation)) {
      fail(`Approved configuration declares unknown SGOS platform mutation '${operation}'.`,
        'SGOS_PLATFORM_AUTHORITY_POLICY_INVALID', { operation });
    }
    if (typeof authorityId !== 'string' || !AUTHORITY_ID.test(authorityId)) {
      fail(`Approved SGOS platform authority for '${operation}' must be a lower-case kebab-case group ID.`,
        'SGOS_PLATFORM_AUTHORITY_POLICY_INVALID', { operation, authorityId });
    }
  }
  return Object.freeze({ ...PLATFORM_MUTATION_AUTHORITIES, ...configured });
}

/**
 * Convert the observed Git/GitHub identity into the private platform record identifier vocabulary.
 * Raw email addresses are deliberately not copied into the local Authority Store.
 */
export function platformPrincipalId(actor) {
  const login = String(actor?.login ?? '').trim().toLowerCase();
  if (login) return `github:${login}`;
  const email = String(actor?.email ?? '').trim().toLowerCase();
  if (email) return `git-email:${createHash('sha256').update(email).digest('hex')}`;
  fail('SGOS platform mutation requires a configured local Git email or authenticated Git identity.',
    'SGOS_PLATFORM_MUTATION_UNAUTHORIZED');
}

/**
 * Resolve one mutation from the exact refreshed configuration authority and the identity actually
 * active in this repository. No caller-provided actor, reviewer, or group assertion participates.
 */
export async function loadApprovedPlatformMutationAuthority(root, operation, {
  policyAuthorityRevision = null
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    fail('SGOS platform mutation requires an explicit absolute repository root.',
      'SGOS_PLATFORM_REPOSITORY_REQUIRED');
  }
  if (!OPERATION_IDS.has(operation)) {
    fail(`Unknown SGOS platform mutation '${operation}'.`, 'SGOS_PLATFORM_AUTHORITY_POLICY_INVALID', {
      operation
    });
  }
  return withTrustedSgosConfigurationRead(root, async (authority, authorityTrust) => {
    if (!authority?.ref || !/^[a-f0-9]{40,64}$/.test(authority.commit ?? '')
        || !['approved-configuration-ref', 'verified-state-mirror'].includes(authority.kind)
        || authorityTrust == null) {
      fail('SGOS platform mutation requires a refreshed approved sflow/config or verified state authority.',
        'SGOS_PLATFORM_APPROVED_CONFIGURATION_REQUIRED');
    }
    const approvedRoot = configurationReadRoot(root);
    await assertApprovedConfigurationBoundary(root, approvedRoot);
    let workflowBytes = await readFile(path.join(approvedRoot, 'singularity', 'workflow.yml'));
    let authorityCommit = authority.commit;
    if (policyAuthorityRevision != null) {
      if (!/^[a-f0-9]{40,64}$/.test(policyAuthorityRevision)) {
        fail('Pinned policy authorityRevision must be an exact Git object ID.',
          'SGOS_PLATFORM_AUTHORITY_POLICY_INVALID', { policyAuthorityRevision });
      }
      const authoritySourceCommit = authority.kind === 'verified-state-mirror'
        ? authority.manifest?.source?.commit : authority.commit;
      if (!GIT_OBJECT.test(authoritySourceCommit ?? '')) {
        fail('Refreshed approved configuration does not identify an exact source commit.',
          'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED');
      }
      // Equal-current means exactly the bytes already mounted from the verified snapshot. This is
      // true for direct sflow/config as well as state transport; looking up the same SHA in member
      // repository B is both redundant and wrong when authority lives in external repository A.
      if (policyAuthorityRevision !== authoritySourceCommit) {
        workflowBytes = await historicalAuthorityWorkflow(
          root, authority, authoritySourceCommit, policyAuthorityRevision
        );
      }
      authorityCommit = policyAuthorityRevision;
    }
    let definition;
    try {
      definition = YAML.parse(workflowBytes.toString('utf8')) ?? {};
    } catch (error) {
      fail(`Approved workflow configuration cannot be parsed: ${error.message}.`,
        'SGOS_PLATFORM_AUTHORITY_POLICY_INVALID');
    }
    const security = normalizeApprovalSecurity(definition.approvalSecurity);
    const approvalAuthorities = normalizeApprovalAuthorities(
      definition.approvalAuthorities, security
    );
    const authorityGroup = operationAuthorityMap(definition)[operation];
    const authorityDefinition = approvalAuthorities[authorityGroup];
    if (authorityDefinition == null) {
      fail(`Approved configuration does not define SGOS platform authority '${authorityGroup}' for '${operation}'.`,
        'SGOS_PLATFORM_AUTHORITY_REQUIRED', { operation, authorityGroup });
    }
    const current = identity(root, { offline: true });
    const matched = matchApprovalAuthority(
      approvalAuthorities, { authorities: [authorityGroup] }, current
    );
    if (!matched.authorized) {
      fail(matched.reason, 'SGOS_PLATFORM_MUTATION_UNAUTHORIZED', {
        operation, authorityGroup
      });
    }
    const configurationAuthority = Object.freeze({
      kind: authority.kind,
      ref: authority.ref,
      commit: authorityCommit,
      workflowSha256: sha256(workflowBytes)
    });
    // Bind the durable principal to the credential that actually satisfied the configured group.
    // A cached GitHub login must not replace an email membership (or vice versa) after matching.
    const actorId = platformPrincipalId(matched.identityAssurance === 'configured-local'
      ? { email: matched.email }
      : { login: matched.githubLogin });
    const authoritySha256 = platformSha256({
      kind: 'approved-platform-mutation-authority',
      operation,
      authorityGroup,
      authority: authorityDefinition,
      configurationAuthority
    });
    return createPlatformMutationAuthorization({
      operation,
      authorityGroup,
      actorId,
      identityAssurance: matched.identityAssurance,
      configurationKind: configurationAuthority.kind,
      configurationRef: configurationAuthority.ref,
      configurationCommit: configurationAuthority.commit,
      workflowSha256: configurationAuthority.workflowSha256,
      authoritySha256,
      authorizedAt: new Date().toISOString()
    });
  }, { refreshAuthority: true, requireFreshRemote: true });
}
