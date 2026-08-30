/** Runtime-owned authority for the experimental SGOS platform profile. */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

import {
  matchApprovalAuthority, normalizeApprovalAuthorities, normalizeApprovalSecurity
} from '../../approval-authority.mjs';
import {
  configurationReadRoot, isConfigurationReadPath
} from '../../configuration-read-scope.mjs';
import { identity } from '../../git.mjs';
import { SingularityFlowError, run } from '../../util.mjs';
import { withTrustedSgosConfigurationRead } from '../authority-trust.mjs';
import {
  createPlatformMutationAuthorization, platformSha256
} from './contracts.mjs';

export const PLATFORM_MUTATION_AUTHORITIES = Object.freeze({
  'pack.propose': 'engineering-reviewers',
  'pack.review': 'architecture-reviewers',
  'pack.activate': 'architecture-reviewers',
  'pack.revoke': 'architecture-reviewers',
  'memory.register': 'engineering-reviewers',
  'memory.promote': 'architecture-reviewers',
  'meta-tool.propose': 'engineering-reviewers',
  'meta-tool.evaluation': 'quality-reviewers',
  'meta-tool.promote': 'architecture-reviewers'
});

const OPERATION_IDS = new Set(Object.keys(PLATFORM_MUTATION_AUTHORITIES));
const AUTHORITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
export async function loadApprovedPlatformMutationAuthority(root, operation) {
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
    const workflowBytes = await readFile(path.join(approvedRoot, 'singularity', 'workflow.yml'));
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
      commit: authority.commit,
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
