/** Runtime-owned Human Request authority loaded only from approved configuration. */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { matchApprovalAuthority } from '../approval-authority.mjs';
import { loadDefinition } from '../config.mjs';
import {
  configurationReadRoot, isConfigurationReadPath
} from '../configuration-read-scope.mjs';
import { identity } from '../git.mjs';
import { SingularityFlowError, run } from '../util.mjs';
import { withTrustedSgosConfigurationRead } from './authority-trust.mjs';
import { sgosSha256 } from './evidence.mjs';
import { compareSgosCodePoints } from './order.mjs';

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function requirementsFor(program) {
  const requirements = [];
  for (const task of program.taskTemplates ?? []) {
    if (task.opcode !== 'HUMAN_REQUEST') continue;
    const declared = task.metadata?.humanRequest?.authorityRequired
      ?? (task.authority && Object.keys(task.authority).length ? task.authority : null);
    if (typeof declared?.kind !== 'string' || typeof declared?.id !== 'string') continue;
    requirements.push({
      kind: declared.kind,
      id: declared.id,
      minimumAssurance: declared.minimumAssurance ?? null,
      authoritySha256: declared.authoritySha256 ?? null
    });
  }
  return [...new Map(requirements.map((entry) => [
    `${entry.kind}\0${entry.id}\0${entry.minimumAssurance ?? ''}\0${entry.authoritySha256 ?? ''}`,
    entry
  ])).values()].sort((left, right) =>
    compareSgosCodePoints(left.kind, right.kind)
      || compareSgosCodePoints(left.id, right.id));
}

function nulPaths(value) {
  // Git `-z` output is literal. Trimming would change the security decision for valid path bytes.
  return value.split('\0').filter(Boolean);
}

function configurationPaths(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    fail('Could not verify the protected configuration boundary before starting the SGOS process.',
      'SGOS_PROTECTED_CONFIGURATION_UNVERIFIED', {
        command: ['git', ...args], stderr: result.stderr.trim()
      });
  }
  return nulPaths(result.stdout).filter((relative) => isConfigurationReadPath(relative));
}

/**
 * An application checkout may consume its configuration through an approved overlay. Any
 * protected bytes that it does carry must be clean and identical to that exact authority.
 */
async function assertApprovedConfigurationBoundary(root, approvedRoot) {
  const dirty = [...new Set([
    ...configurationPaths(root, ['diff', '--name-only', '-z']),
    ...configurationPaths(root, ['diff', '--cached', '--name-only', '-z']),
    ...configurationPaths(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])].sort(compareSgosCodePoints);
  if (dirty.length) {
    fail('Human Request execution refuses dirty protected configuration. Commit an approved configuration change through sflow/config or restore these paths.',
      'SGOS_PROTECTED_CONFIGURATION_DIRTY', { paths: dirty });
  }

  const present = configurationPaths(root, [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z'
  ]).sort(compareSgosCodePoints);
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
    fail('Human Request execution refuses protected configuration that is not present byte-for-byte in the approved configuration authority.',
      'SGOS_PROTECTED_CONFIGURATION_UNAPPROVED', { paths: divergent });
  }
}

/**
 * Load the exact configuration authority and only the current Git identity's configured Human
 * Request memberships. No caller-provided assertion participates in this decision.
 */
export async function loadApprovedSgosHumanAuthorityContext(root, program, {
  refreshAuthority = true
} = {}) {
  const requirements = requirementsFor(program);
  return withTrustedSgosConfigurationRead(root, async (authority, authorityTrust) => {
    if (!authority?.ref || !/^[a-f0-9]{40,64}$/.test(authority.commit ?? '')
        || !['approved-configuration-ref', 'verified-state-mirror'].includes(authority.kind)) {
      fail('SGOS execution requires a fetched approved sflow/config or verified state authority; mutable working-tree configuration is not authority.',
        'SGOS_APPROVED_CONFIGURATION_REQUIRED');
    }
    const approvedRoot = configurationReadRoot(root);
    const workflowBytes = await readFile(path.join(approvedRoot, 'singularity', 'workflow.yml'));
    const configurationAuthority = Object.freeze({
      kind: authority.kind,
      ref: authority.ref,
      commit: authority.commit,
      workflowBlobSha256: sha256(workflowBytes)
    });
    const definition = await loadDefinition(root);
    const pinnedRequirements = requirements.map((required) => {
      const authorityDefinition = definition.approvalAuthorities?.[required.id];
      if (authorityDefinition == null) {
        fail(`Approved configuration does not define required Human authority '${required.id}'.`,
          'SGOS_HUMAN_AUTHORITY_REQUIRED', { authorityId: required.id });
      }
      const authoritySha256 = sgosSha256({
        kind: 'approved-configured-human-authority',
        configurationAuthority,
        id: required.id,
        authority: authorityDefinition
      });
      if (required.authoritySha256 != null && required.authoritySha256 !== authoritySha256) {
        fail(`Program Human authority '${required.id}' does not match approved configuration.`,
          'SGOS_HUMAN_AUTHORITY_BINDING_INVALID', {
            authorityId: required.id,
            expected: authoritySha256,
            received: required.authoritySha256
          });
      }
      return Object.freeze({
        kind: required.kind,
        id: required.id,
        minimumAssurance: required.minimumAssurance,
        authoritySha256
      });
    });
    if (!requirements.length) {
      return Object.freeze({
        configurationAuthority,
        authorityTrust,
        humanAuthorityRequirements: Object.freeze([]),
        humanAuthorities: Object.freeze([])
      });
    }
    await assertApprovedConfigurationBoundary(root, approvedRoot);

    const current = identity(root, { offline: true });
    const principalId = current.email ?? current.login;
    const assertions = [];
    if (principalId) {
      for (const required of pinnedRequirements) {
        const matched = matchApprovalAuthority(
          definition.approvalAuthorities,
          { authorities: [required.id] },
          current
        );
        if (!matched.authorized) continue;
        // Assurance vocabularies have no implicit ordering. Never upgrade one by inference.
        if (required.minimumAssurance != null
            && required.minimumAssurance !== matched.identityAssurance) continue;
        assertions.push(Object.freeze({
          kind: required.kind,
          id: required.id,
          principalId,
          principalKind: 'human',
          assurance: matched.identityAssurance,
          authoritySha256: required.authoritySha256
        }));
      }
    }
    return Object.freeze({
      configurationAuthority,
      authorityTrust,
      humanAuthorityRequirements: Object.freeze(pinnedRequirements),
      humanAuthorities: Object.freeze(assertions)
    });
  }, { refreshAuthority });
}

/** Bind a runtime response to the Git identity actually active in this repository. */
export function currentSgosHumanActor(root, claimed = null) {
  const current = identity(root, { offline: true });
  const id = current.email ?? current.login;
  if (!id) {
    fail('Human Request response requires a configured local Git email or authenticated Git identity.',
      'SGOS_HUMAN_REQUEST_UNAUTHORIZED');
  }
  const observed = {
    kind: 'human',
    id,
    name: current.name ?? null,
    email: current.email ?? null
  };
  if (claimed != null && (claimed.kind !== observed.kind || claimed.id !== observed.id)) {
    fail('Human Request actor does not match the repository Git identity observed by the runtime.',
      'SGOS_HUMAN_REQUEST_UNAUTHORIZED', {
        claimed: { kind: claimed.kind ?? null, id: claimed.id ?? null },
        observed: { kind: observed.kind, id: observed.id }
      });
  }
  return Object.freeze(observed);
}
