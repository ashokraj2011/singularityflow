import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { BUILD_INFO } from './build-info.mjs';
import {
  canonicalConfigurationAssets, configurationAssetPaths, CONFIGURATION_BRANCH,
  configurationAssetPolicyFromDirectory, configurationAssetPolicyFromRef,
  ensureConfigurationBranch, isConfigurationAsset, prepareConfigurationBootstrapWorktree,
  retainStateConfigurationHistory,
  stateConfigurationHistoryBranch
} from './configuration-branch.mjs';
import {
  configurationAssetPolicy, configurationAssetSearchRoots, mergeConfigurationAssetPolicies,
  portableConfigurationPath, portableFilesystemPathIdentity
} from './configuration-assets.mjs';
import { loadDefinition, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { gitCommitIdentity } from './git.mjs';
import {
  enterpriseGitEnvironment, withoutGitProcessOverrides
} from './git-enterprise-environment.mjs';
import { resolvedGitRepositoryComparisonKey } from './git-repository-identity.mjs';
import { publishToStateBranch } from './ledger.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import {
  assertCredentialFreeRemote, configuredRemoteAuthority, frozenRemoteTransport,
  redactDiagnosticText, remoteFingerprint, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import {
  gitWorkerCount, isGitRefName, mapLimit, removeTemporaryTree, SingularityFlowError, run, writeAtomic
} from './util.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { VERSION } from './version.mjs';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from './workspace.mjs';
import {
  isKnownPackagedAssetHash, isRetiredPackagedAssetHash
} from './packaged-asset-history.mjs';
import { isKnownPackagedWorkflowValue } from './packaged-workflow-history.mjs';

export const PACKAGE_BASELINE_PATH = 'singularity/.product/configuration-baseline.yml';
export const STATE_CONFIGURATION_ROOT = 'configuration';
export const STATE_CONFIGURATION_MANIFEST = `${STATE_CONFIGURATION_ROOT}/manifest.json`;
const BASELINE_FORMAT = 'singularity-flow-configuration-baseline/v1';
const PACKAGE_OWNERSHIP_FRAMEWORK = 'framework';
const PACKAGE_OWNERSHIP_REPOSITORY = 'repository';
const PACKAGE_OWNERSHIP_VALUES = new Set([
  PACKAGE_OWNERSHIP_FRAMEWORK, PACKAGE_OWNERSHIP_REPOSITORY
]);
const MIRROR_FORMAT = 'singularity-flow-configuration-mirror/v2';
const REFRESH_CACHE_FORMAT = 'singularity-flow-configuration-refresh-cache/v1';
const REFRESH_CACHE_OWNER_FORMAT = 'singularity-flow-configuration-refresh-cache-owner/v1';
const REFRESH_CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const REFRESH_CACHE_MAX_PLANS = 8;
const REFRESH_CACHE_RECORD_MAX_BYTES = 1024 * 1024;
const REFRESH_CACHE_OWNER_FILE = '.owner.json';
const REFRESH_CACHE_CLAIM_FORMAT = 'singularity-flow-configuration-refresh-cache-claim/v1';
const REFRESH_CACHE_CLAIM_FILE = '.git/sflow-cache-claim.json';
const REFRESH_CACHE_LOCK_FORMAT = 'singularity-flow-configuration-refresh-cache-lock/v1';
const REFRESH_CACHE_LOCK_FILE = '.owner.json';
// A just-created lock may briefly exist before its owner receipt is durable. Never reclaim that
// window. Once the receipt/directory is older than this grace period, only a proven-dead owner may
// be reclaimed; a live PID is never stolen, regardless of age.
const REFRESH_CACHE_LOCK_STALE_MS = 60 * 1000;
const REFRESH_CACHE_PROCESS_STARTED_AT = new Date(
  Date.now() - Math.max(0, Math.round(process.uptime() * 1000))
).toISOString();
const REFRESH_CACHE_PROCESS_TOKEN = randomUUID();
// Ordinary configuration refresh retains its established three-way behavior. These two standard
// profiles are the only historical exception: the product has always restored them when absent.
// The broader seeded-only replacement contract is opt-in and used by workspace reinitialize.
const REQUIRED_PACKAGED_WORK_TYPES = Object.freeze(['spec-driven-standard', 'reference-driven-build']);
const FIXED_PACKAGE_ASSETS = Object.freeze([
  ['agent-mappings.yml', 'singularity/agent-mappings.yml'],
  ['impact.yml', 'singularity/impact.yml'],
  ['modelTiers.yml', 'singularity/modelTiers.yml'],
  ['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md'],
  ['copilot-planning.md', 'singularity/prompts/copilot-planning.md']
]);
// These files have package-provided starting bytes, but their documented contract explicitly
// invites organisation-owned entries. A filename match therefore cannot prove that the whole file
// is a replaceable seed. Reinitialize must retain the ordinary baseline/hash conflict boundary for
// them; otherwise adding one agent mapping or changing model policy is silently destructive.
const USER_CONFIGURABLE_PACKAGE_ASSETS = new Set([
  'singularity/agent-mappings.yml',
  'singularity/impact.yml',
  'singularity/modelTiers.yml'
]);

function packageAssetAllowsExactSeedRestore(relative) {
  return !USER_CONFIGURABLE_PACKAGE_ASSETS.has(relative);
}

function packagedAssetOwner(baseline, relative, {
  exists, currentHash, bundledHash, priorHash, retiredPackagedAsset, strictProvenance = false,
  templatesRoot = 'singularity/templates'
}) {
  const recorded = baseline?.ownership?.assets?.[relative] ?? null;
  if (!strictProvenance) {
    if (recorded === PACKAGE_OWNERSHIP_FRAMEWORK
        || recorded === PACKAGE_OWNERSHIP_REPOSITORY) return recorded;
    return !exists || currentHash === bundledHash
      || (priorHash != null && currentHash === priorHash) || retiredPackagedAsset
      ? PACKAGE_OWNERSHIP_FRAMEWORK
      : PACKAGE_OWNERSHIP_REPOSITORY;
  }
  // A repository-owned receipt is a durable opt-out. A framework label or baseline hash is not
  // independent provenance: either can be copied or edited in the same Git change as a custom
  // file. Safe reinitialization therefore requires the observed bytes to match the current package
  // or the path-scoped historical package registry. Unknown/customized bytes remain repository
  // owned even when an older receipt called them framework-owned.
  if (recorded === PACKAGE_OWNERSHIP_REPOSITORY) return PACKAGE_OWNERSHIP_REPOSITORY;
  return !exists || currentHash === bundledHash
    || isKnownPackagedAssetHash(relative, currentHash, { templatesRoot }) || retiredPackagedAsset
    ? PACKAGE_OWNERSHIP_FRAMEWORK
    : PACKAGE_OWNERSHIP_REPOSITORY;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function refreshErrorMessage(error) {
  return error?.message == null ? null : redactDiagnosticText(error.message);
}

function remoteFailureMessage(result, fallback = 'Git remote access failed. Inspect repository access and retry.') {
  // Provider output can contain proxy URLs, CA paths, credential-helper commands/output, and hook
  // diagnostics. Configuration refresh records are durable and UI-visible, so expose only the
  // closed-vocabulary classifier/advice produced by the shared Git boundary.
  return result?.failure?.advice ?? fallback;
}

const EXACT_GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Observe one exact local ref without dereferencing symbolic aliases.
 *
 * Configuration refresh owns a few private cache/tracking refs. They are not general revision
 * expressions: following a symbolic ref here could overwrite an unrelated branch while appearing
 * to update the requested cache name. A dangling symbolic ref is omitted by `for-each-ref`, so the
 * empty case receives one bounded `symbolic-ref` probe before it can be treated as absent.
 */
function observeExactRefreshRef(root, ref, { env = process.env } = {}) {
  const observed = run('git', [
    'for-each-ref', '--count=1', '--format=%(refname)%00%(objectname)%00%(symref)', ref
  ], {
    cwd: root, env, allowFailure: true, encoding: 'buffer', maxBuffer: 1024, timeoutMs: 5_000
  });
  if (observed.status !== 0 || observed.error || observed.timedOut
      || observed.outputOverflow || !Buffer.isBuffer(observed.stdout)) {
    return { status: 'unavailable', commit: null };
  }
  if (observed.stdout.length === 0) {
    const symbolic = run('git', ['symbolic-ref', '--quiet', ref], {
      cwd: root, env, allowFailure: true, encoding: 'buffer', maxBuffer: 1024,
      timeoutMs: 5_000
    });
    if (symbolic.status === 0) return { status: 'symbolic', commit: null };
    return symbolic.status === 1 && !symbolic.error && !symbolic.timedOut
      && !symbolic.outputOverflow
      ? { status: 'absent', commit: null }
      : { status: 'unavailable', commit: null };
  }
  const match = /^([^\x00\n]+)\x00([0-9a-f]{40}|[0-9a-f]{64})\x00([^\x00\n]*)\n$/u
    .exec(observed.stdout.toString('utf8'));
  if (!match || match[1] !== ref) return { status: 'unavailable', commit: null };
  return match[3]
    ? { status: 'symbolic', commit: null }
    : { status: 'direct', commit: match[2] };
}

function refreshRefError(ref, status, action) {
  return new SingularityFlowError(
    `Configuration refresh cannot ${action} '${ref}' because its exact direct-ref state is ${status}.`,
    {
      code: status === 'symbolic'
        ? 'CONFIGURATION_REFRESH_REF_SYMBOLIC'
        : 'CONFIGURATION_REFRESH_REF_UNAVAILABLE',
      details: { ref, status }
    }
  );
}

/** Install one exact private ref with an absent-or-expected compare-and-swap. */
function installExactRefreshRef(root, ref, commit, {
  env = process.env, expectedCommit = null
} = {}) {
  if (!EXACT_GIT_OID.test(String(commit ?? ''))
      || (expectedCommit != null && !EXACT_GIT_OID.test(String(expectedCommit)))) {
    throw new SingularityFlowError('Configuration refresh received an invalid exact Git object ID.', {
      code: 'CONFIGURATION_REFRESH_REF_INVALID', details: { ref }
    });
  }
  const before = observeExactRefreshRef(root, ref, { env });
  if (before.status === 'symbolic' || before.status === 'unavailable') {
    throw refreshRefError(ref, before.status, 'install');
  }
  if (before.commit === commit) return { commit, created: false };
  if (before.commit !== expectedCommit) {
    throw new SingularityFlowError(
      `Configuration refresh did not overwrite '${ref}' because it changed concurrently.`, {
        code: 'CONFIGURATION_REFRESH_REF_CHANGED',
        details: { ref, expectedCommit, observedCommit: before.commit }
      }
    );
  }
  const expected = expectedCommit ?? '0'.repeat(commit.length);
  const updated = run('git', ['update-ref', '--no-deref', ref, commit, expected], {
    cwd: root, env, allowFailure: true, maxBuffer: 4096, timeoutMs: 5_000
  });
  const after = observeExactRefreshRef(root, ref, { env });
  if (after.status === 'direct' && after.commit === commit) {
    // A failed update can race with another owner installing the same object. Reconcile that as an
    // idempotent join, but do not claim ownership: callers must not later delete the other owner's
    // ref during cleanup.
    const created = updated.status === 0 && !updated.error
      && !updated.timedOut && !updated.outputOverflow;
    return { commit, created, reconciled: !created };
  }
  if (after.status === 'symbolic' || after.status === 'unavailable') {
    throw refreshRefError(ref, after.status, 'reconcile');
  }
  throw new SingularityFlowError(
    `Configuration refresh could not install '${ref}' with its expected-object lease.`, {
      code: 'CONFIGURATION_REFRESH_REF_CHANGED',
      details: { ref, expectedCommit, observedCommit: after.commit, exitCode: updated.status }
    }
  );
}

/** Remove only the exact private ref installed by this operation. */
function removeExactRefreshRef(root, ref, expectedCommit, { env = process.env } = {}) {
  const before = observeExactRefreshRef(root, ref, { env });
  if (before.status === 'absent') return;
  if (before.status === 'symbolic' || before.status === 'unavailable') {
    throw refreshRefError(ref, before.status, 'remove');
  }
  if (before.commit !== expectedCommit) {
    throw new SingularityFlowError(
      `Configuration refresh did not remove '${ref}' because it changed concurrently.`, {
        code: 'CONFIGURATION_REFRESH_REF_CHANGED',
        details: { ref, expectedCommit, observedCommit: before.commit }
      }
    );
  }
  run('git', ['update-ref', '--no-deref', '-d', ref, expectedCommit], {
    cwd: root, env, allowFailure: true, maxBuffer: 4096, timeoutMs: 5_000
  });
  const after = observeExactRefreshRef(root, ref, { env });
  if (after.status === 'absent') return;
  if (after.status === 'symbolic' || after.status === 'unavailable') {
    throw refreshRefError(ref, after.status, 'reconcile removal of');
  }
  throw new SingularityFlowError(
    `Configuration refresh could not remove '${ref}' with its expected-object lease.`, {
      code: 'CONFIGURATION_REFRESH_REF_CHANGED',
      details: { ref, expectedCommit, observedCommit: after.commit }
    }
  );
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Apply semantic changes without reserializing untouched repository-owned YAML nodes. */
function patchWorkflowDocument(currentText, before, after) {
  const document = YAML.parseDocument(currentText);
  if (document.errors.length) throw document.errors[0];
  const visit = (pathParts, previous, next) => {
    if (equal(previous, next)) return;
    if (plainObject(previous) && plainObject(next)) {
      for (const key of Object.keys(previous)) {
        if (!Object.hasOwn(next, key)) document.deleteIn([...pathParts, key]);
      }
      for (const [key, value] of Object.entries(next)) {
        if (!Object.hasOwn(previous, key)) document.setIn([...pathParts, key], clone(value));
        else visit([...pathParts, key], previous[key], value);
      }
      return;
    }
    document.setIn(pathParts, clone(next));
  };
  visit([], before, after);
  return String(document);
}

function displayPath(parts) {
  return ['workflow', ...parts].join('.');
}

function requiredPackagedWorkflowPaths(current, incoming) {
  const paths = new Set();
  for (const workTypeId of REQUIRED_PACKAGED_WORK_TYPES) {
    const profile = incoming.workTypes?.[workTypeId];
    if (!profile || current.workTypes?.[workTypeId]) continue;
    paths.add(`workflow.workTypes.${workTypeId}`);
    for (const phaseId of profile.phases ?? []) {
      if (!current.phases?.[phaseId]) paths.add(`workflow.phases.${phaseId}`);
      for (const authorityId of incoming.phases?.[phaseId]?.approval?.authorities ?? []) {
        if (!current.approvalAuthorities?.[authorityId]) {
          paths.add(`workflow.approvalAuthorities.${authorityId}`);
        }
      }
    }
  }
  return paths;
}

/**
 * Resolve the configuration nodes owned by the currently installed package catalog.
 *
 * Reinitialization is an ownership operation, not a whole-file replacement. Exact current or
 * registered historical package nodes can move with the package; modified and repository-only
 * nodes remain repository-owned. Approval authorities are wholly organisation-owned once present,
 * although a missing authority dependency still has to be restored for a seeded workflow to remain
 * valid.
 */
function packagedWorkflowOwnership(current, incoming, baseline) {
  const candidates = {
    workTypes: new Set(Object.keys(incoming.workTypes ?? {})),
    phases: new Set(),
    artifactSets: new Set(),
    mcpServers: new Set()
  };
  const requiredAuthorities = new Set();

  const collectContractDependencies = (contract) => {
    if (!plainObject(contract)) return;
    if (typeof contract.artifactSet === 'string') candidates.artifactSets.add(contract.artifactSet);
    for (const authorityId of [
      ...(contract.approval?.authorities ?? []),
      ...(contract.approval?.requiredAuthorities ?? [])
    ]) {
      if (typeof authorityId === 'string') requiredAuthorities.add(authorityId);
    }
    for (const serverId of contract.mcp?.requiredServers ?? []) {
      if (typeof serverId === 'string') candidates.mcpServers.add(serverId);
    }
  };

  for (const profile of Object.values(incoming.workTypes ?? {})) {
    for (const phaseId of profile?.phases ?? []) {
      if (typeof phaseId !== 'string') continue;
      candidates.phases.add(phaseId);
      collectContractDependencies(incoming.phases?.[phaseId]);
      collectContractDependencies(profile?.phaseOverrides?.[phaseId]);
    }
  }

  // A packaged MCP contract may be selected indirectly by the phase allowlist rather than a
  // requiredServers entry. Keep it with the seed when any packaged phase can invoke it.
  for (const [serverId, server] of Object.entries(incoming.mcpServers ?? {})) {
    if ((server?.phases ?? []).some((phaseId) => candidates.phases.has(phaseId))) {
      candidates.mcpServers.add(serverId);
    }
  }

  const framework = {};
  const repository = {};
  const receipt = {};
  const priorReceipt = baseline?.ownership?.workflow ?? {};
  for (const [section, ids] of Object.entries(candidates)) {
    framework[section] = new Set();
    repository[section] = new Set();
    receipt[section] = {};
    for (const id of ids) {
      const recorded = priorReceipt?.[section]?.[id] ?? null;
      const currentPresent = Object.hasOwn(current?.[section] ?? {}, id);
      const currentValue = current?.[section]?.[id];
      const inferredFramework = !currentPresent
        || equal(currentValue, incoming?.[section]?.[id])
        || isKnownPackagedWorkflowValue(section, id, currentValue);
      const owner = recorded === PACKAGE_OWNERSHIP_REPOSITORY
        ? PACKAGE_OWNERSHIP_REPOSITORY
        : inferredFramework
          ? PACKAGE_OWNERSHIP_FRAMEWORK
          : PACKAGE_OWNERSHIP_REPOSITORY;
      receipt[section][id] = owner;
      (owner === PACKAGE_OWNERSHIP_FRAMEWORK ? framework : repository)[section].add(id);
    }

    // A repository-created ID is outside the package catalog and therefore repository-owned even
    // if a forged baseline claims the package once contained it. Conversely, an exact registered
    // historical node that the current package retired may be removed as a framework seed.
    for (const [id, currentValue] of Object.entries(current?.[section] ?? {})) {
      if (ids.has(id)) continue;
      const owner = isKnownPackagedWorkflowValue(section, id, currentValue)
        ? PACKAGE_OWNERSHIP_FRAMEWORK : PACKAGE_OWNERSHIP_REPOSITORY;
      receipt[section][id] = owner;
      (owner === PACKAGE_OWNERSHIP_FRAMEWORK ? framework : repository)[section].add(id);
    }

    // Keep an explicit repository-owned namespace reservation when a package later retires a
    // colliding ID. Otherwise one collision-free refresh would erase the receipt and a later
    // package could reintroduce that ID as though the repository had never owned it.
    for (const [id, owner] of Object.entries(priorReceipt?.[section] ?? {})) {
      if (owner !== PACKAGE_OWNERSHIP_REPOSITORY || ids.has(id)
          || !Object.hasOwn(current?.[section] ?? {}, id)) continue;
      receipt[section][id] = PACKAGE_OWNERSHIP_REPOSITORY;
      repository[section].add(id);
    }
  }

  return { framework, repository, receipt, requiredAuthorities };
}

function applyPackagedWorkflowOwnership(value, current, incoming, ownership) {
  const exactRoots = new Set();
  const collisionRoots = new Set();
  const conflicts = [];
  for (const [section, ids] of Object.entries(ownership.framework)) {
    if (!plainObject(value[section])) value[section] = {};
    for (const id of ids) {
      if (Object.hasOwn(incoming[section] ?? {}, id)) {
        value[section][id] = clone(incoming[section][id]);
      } else delete value[section][id];
      exactRoots.add(`workflow.${section}.${id}`);
    }
  }
  for (const [section, ids] of Object.entries(ownership.repository)) {
    if (!plainObject(value[section])) value[section] = {};
    for (const id of ids) {
      const root = `workflow.${section}.${id}`;
      const currentPresent = Object.hasOwn(current?.[section] ?? {}, id);
      const incomingPresent = Object.hasOwn(incoming?.[section] ?? {}, id);
      if (currentPresent) value[section][id] = clone(current[section][id]);
      else delete value[section][id];
      collisionRoots.add(root);
      if (!incomingPresent || !currentPresent
          || !equal(current[section][id], incoming[section][id])) {
        conflicts.push({
          path: root,
          local: currentPresent ? clone(current[section][id]) : undefined,
          bundled: incomingPresent ? clone(incoming[section][id]) : undefined,
          resolution: currentPresent ? 'preserved-local' : 'preserved-local-deletion'
        });
      }
    }
  }
  if (!plainObject(value.approvalAuthorities)) value.approvalAuthorities = {};
  // Authority IDs, labels, membership, and local policy are organisation contracts. A package ID
  // collision cannot transfer ownership merely because an older repository has no node receipt.
  for (const [authorityId, authority] of Object.entries(current.approvalAuthorities ?? {})) {
    value.approvalAuthorities[authorityId] = clone(authority);
  }
  for (const authorityId of ownership.requiredAuthorities) {
    if (Object.hasOwn(value.approvalAuthorities, authorityId)) continue;
    if (!Object.hasOwn(incoming.approvalAuthorities ?? {}, authorityId)) continue;
    value.approvalAuthorities[authorityId] = clone(incoming.approvalAuthorities[authorityId]);
    exactRoots.add(`workflow.approvalAuthorities.${authorityId}`);
  }
  // The baseline receipt lives in the repository and is not independent ownership evidence.
  // Outside the path-scoped seed catalogs above, retain the migrated current value exactly. This
  // prevents a forged baseline from resetting organisation policy such as auto, logging, Git,
  // world-model, or session settings while still permitting the explicit v1 migration to supply
  // its validated replacement shape.
  const nodeSections = new Set([
    'workTypes', 'phases', 'artifactSets', 'mcpServers', 'approvalAuthorities'
  ]);
  for (const key of new Set([...Object.keys(value), ...Object.keys(current)])) {
    if (nodeSections.has(key)) continue;
    if (Object.hasOwn(current, key)) value[key] = clone(current[key]);
    else if (Object.hasOwn(incoming, key)) value[key] = clone(incoming[key]);
    else delete value[key];
  }
  return { exactRoots, collisionRoots, conflicts };
}

function isWithinOwnedConfigurationPath(candidate, roots) {
  return [...roots].some((root) => candidate === root || candidate.startsWith(`${root}.`));
}

// Registered workflow v1 used role-prompt personas. Keep the exact historical package catalog
// here so migration can distinguish framework metadata from repository-created role semantics.
// An ID match alone is not ownership evidence: repositories could customize a packaged persona
// in place, and silently deleting that definition would be just as destructive as deleting a new
// persona ID.
const LEGACY_FRAMEWORK_PERSONAS = Object.freeze({
  developer: Object.freeze({
    label: 'Developer',
    description: 'Implement scoped changes and tests.',
    prompt: 'developer.md',
    suggestedPhases: Object.freeze(['implementation']),
    worldModelViews: Object.freeze(['development', 'testing'])
  }),
  architect: Object.freeze({
    label: 'Architect',
    description: 'Define boundaries, contracts, risks, and implementation specifications.',
    prompt: 'architect.md',
    suggestedPhases: Object.freeze(['design', 'implementation-spec', 'fix-design', 'fix-spec']),
    worldModelViews: Object.freeze(['architecture', 'security'])
  }),
  'product-owner': Object.freeze({
    label: 'Product owner',
    description: 'Define the problem, scope, and measurable acceptance criteria.',
    prompt: 'product-owner.md',
    suggestedPhases: Object.freeze(['intake', 'requirements']),
    worldModelViews: Object.freeze(['business'])
  }),
  qa: Object.freeze({
    label: 'QA',
    description: 'Verify acceptance criteria and collect reproducible evidence.',
    prompt: 'qa.md',
    suggestedPhases: Object.freeze([
      'reproduction', 'verification', 'visual-verification', 'conformance'
    ]),
    worldModelViews: Object.freeze(['testing', 'development', 'security'])
  }),
  'product-designer': Object.freeze({
    label: 'Product designer',
    description: 'Turn exported design evidence into explicit screens, states, interactions, tokens, and review decisions.',
    prompt: 'product-designer.md',
    suggestedPhases: Object.freeze(['design-intake', 'design-inventory', 'visual-verification']),
    worldModelViews: Object.freeze(['business', 'architecture', 'testing'])
  }),
  'mobile-architect': Object.freeze({
    label: 'Mobile architect',
    description: 'Map approved designs to a maintainable mobile design system, navigation model, implementation contract, and test strategy.',
    prompt: 'mobile-architect.md',
    suggestedPhases: Object.freeze(['component-mapping', 'mobile-spec']),
    worldModelViews: Object.freeze(['architecture', 'development', 'testing', 'security'])
  })
});

const LEGACY_FRAMEWORK_PHASE_PERSONAS = Object.freeze({
  intake: Object.freeze(['product-owner']),
  requirements: Object.freeze(['product-owner']),
  design: Object.freeze(['architect']),
  'implementation-spec': Object.freeze(['architect', 'developer']),
  reproduction: Object.freeze(['qa', 'developer']),
  'fix-design': Object.freeze(['architect', 'developer']),
  'fix-spec': Object.freeze(['architect', 'developer']),
  'design-intake': Object.freeze(['product-designer']),
  'design-inventory': Object.freeze(['product-designer']),
  'component-mapping': Object.freeze(['mobile-architect', 'product-designer']),
  'mobile-spec': Object.freeze(['mobile-architect', 'developer']),
  implementation: Object.freeze(['developer']),
  verification: Object.freeze(['qa']),
  'visual-verification': Object.freeze(['product-designer', 'qa']),
  conformance: Object.freeze(['qa', 'architect'])
});

function unsafeLegacyPersonaMigration(message, details = {}) {
  return new SingularityFlowError(
    `Legacy role-prompt configuration cannot be migrated safely: ${message} `
      + 'Convert the repository-owned role to governed Agent Markdown and review its phase routing before reinitializing.',
    { code: 'LEGACY_PERSONA_MIGRATION_UNSAFE', details }
  );
}

function assertFrameworkPersonaReferences(value, { label, expected = null }) {
  if (!Array.isArray(value)) {
    throw unsafeLegacyPersonaMigration(`${label} must be an array.`, { label });
  }
  const custom = value.filter((personaId) =>
    typeof personaId !== 'string' || !Object.hasOwn(LEGACY_FRAMEWORK_PERSONAS, personaId));
  if (custom.length) {
    throw unsafeLegacyPersonaMigration(
      `${label} contains custom or unknown persona reference(s): ${custom.join(', ')}.`,
      { label, personas: custom }
    );
  }
  if (expected && !equal(value, expected)) {
    throw unsafeLegacyPersonaMigration(
      `${label} was customized from the packaged v1 routing (${value.join(', ') || 'none'}).`,
      { label, personas: value, expected }
    );
  }
}

async function assertLegacyPersonaMigrationSafe(root, current) {
  if (current.personaPromptsRoot != null
      && current.personaPromptsRoot !== 'singularity/personas') {
    throw unsafeLegacyPersonaMigration(
      `personaPromptsRoot '${current.personaPromptsRoot}' is repository-defined.`,
      { path: 'personaPromptsRoot', value: current.personaPromptsRoot }
    );
  }
  if (current.personas != null && !plainObject(current.personas)) {
    throw unsafeLegacyPersonaMigration('personas must be an object.', { path: 'personas' });
  }
  for (const [personaId, persona] of Object.entries(current.personas ?? {})) {
    const packaged = LEGACY_FRAMEWORK_PERSONAS[personaId];
    if (!packaged) {
      throw unsafeLegacyPersonaMigration(
        `persona '${personaId}' is repository-created.`,
        { path: `personas.${personaId}`, persona: personaId }
      );
    }
    if (!equal(persona, packaged)) {
      throw unsafeLegacyPersonaMigration(
        `persona '${personaId}' differs from the packaged v1 definition.`,
        { path: `personas.${personaId}`, persona: personaId }
      );
    }
    const relativePrompt = `singularity/personas/${persona.prompt}`;
    const promptPath = await assertSafeTarget(root, relativePrompt);
    const promptInfo = await lstat(promptPath).catch((error) =>
      error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!promptInfo) continue;
    if (!promptInfo.isFile() || promptInfo.isSymbolicLink()) {
      throw unsafeLegacyPersonaMigration(
        `persona '${personaId}' prompt is not a regular framework file.`,
        { path: relativePrompt, persona: personaId }
      );
    }
    const promptHash = sha256(await readFile(promptPath));
    if (!isKnownPackagedAssetHash(relativePrompt, promptHash)) {
      throw unsafeLegacyPersonaMigration(
        `persona '${personaId}' prompt differs from every packaged v1 revision.`,
        { path: relativePrompt, persona: personaId, sha256: promptHash }
      );
    }
  }

  const sessionDefaults = {
    personaSelection: 'prompt', promptOnNewSession: true, promptOnResume: false
  };
  for (const [field, packaged] of Object.entries(sessionDefaults)) {
    if (!Object.hasOwn(current.session ?? {}, field)) continue;
    if (!equal(current.session[field], packaged)) {
      throw unsafeLegacyPersonaMigration(
        `session.${field} differs from the packaged v1 policy.`,
        { path: `session.${field}`, value: current.session[field] }
      );
    }
  }

  for (const [phaseId, phase] of Object.entries(current.phases ?? {})) {
    if (!plainObject(phase) || !Object.hasOwn(phase, 'suggestedPersonas')) continue;
    const expected = LEGACY_FRAMEWORK_PHASE_PERSONAS[phaseId] ?? null;
    if (!expected && Array.isArray(phase.suggestedPersonas)
        && phase.suggestedPersonas.length === 0) continue;
    if (!expected) {
      throw unsafeLegacyPersonaMigration(
        `repository phase '${phaseId}' defines suggestedPersonas.`,
        { path: `phases.${phaseId}.suggestedPersonas`, phase: phaseId }
      );
    }
    assertFrameworkPersonaReferences(phase.suggestedPersonas, {
      label: `Phase '${phaseId}' suggestedPersonas`, expected
    });
  }
  for (const [workTypeId, workType] of Object.entries(current.workTypes ?? {})) {
    for (const [phaseId, override] of Object.entries(workType?.phaseOverrides ?? {})) {
      if (!plainObject(override) || !Object.hasOwn(override, 'suggestedPersonas')) continue;
      if (Array.isArray(override.suggestedPersonas)
          && override.suggestedPersonas.length === 0) continue;
      throw unsafeLegacyPersonaMigration(
        `work type '${workTypeId}' phase override '${phaseId}' defines suggestedPersonas.`,
        { path: `workTypes.${workTypeId}.phaseOverrides.${phaseId}.suggestedPersonas`,
          workType: workTypeId, phase: phaseId }
      );
    }
  }

  for (const [index, rule] of (current.worldModel?.injection?.rules ?? []).entries()) {
    if (!plainObject(rule?.when) || !Object.hasOwn(rule.when, 'persona')) continue;
    throw unsafeLegacyPersonaMigration(
      `worldModel.injection.rules[${index}] is repository-authored persona routing.`,
      { path: `worldModel.injection.rules.${index}.when.persona`, persona: rule.when.persona }
    );
  }
}

// These built-in identities map to the v2 human approval authorities. Repository-created roles
// are refused above; only framework role references reach this conversion.
const LEGACY_PERSONA_APPROVAL_AUTHORITIES = Object.freeze({
  'product-owner': 'product-approvers',
  architect: 'architecture-reviewers',
  'mobile-architect': 'architecture-reviewers',
  developer: 'engineering-reviewers',
  qa: 'quality-reviewers',
  'product-designer': 'design-reviewers'
});

function migrateLegacyApprovalPolicy(value, {
  label, availableAuthorities
}) {
  if (!plainObject(value) || !Object.hasOwn(value, 'personas')) return value;
  assertFrameworkPersonaReferences(value.personas, { label });
  const migrated = clone(value);
  const legacyPersonas = migrated.personas;
  delete migrated.personas;
  if (Array.isArray(migrated.authorities) && migrated.authorities.length) return migrated;

  const unresolved = [];
  const authorities = [];
  for (const personaId of legacyPersonas) {
    const candidates = [
      LEGACY_PERSONA_APPROVAL_AUTHORITIES[personaId],
      personaId,
      `${personaId}-approvers`
    ].filter(Boolean);
    const authorityId = candidates.find((candidate) => availableAuthorities.has(candidate));
    if (!authorityId) unresolved.push(personaId);
    else if (!authorities.includes(authorityId)) authorities.push(authorityId);
  }
  if (unresolved.length) {
    throw new SingularityFlowError(
      `${label} uses legacy approval persona(s) with no safe human-authority mapping: ${unresolved.join(', ')}. Define an approval authority with the same ID or '<persona>-approvers', then reinitialize again.`
    );
  }
  if (authorities.length) migrated.authorities = authorities;
  if (Number.isInteger(migrated.minimum) && migrated.minimum > authorities.length) {
    throw new SingularityFlowError(
      `${label} requires ${migrated.minimum} approvals but its legacy personas map to only ${authorities.length} distinct human authorit${authorities.length === 1 ? 'y' : 'ies'}. Review that approval policy before reinitializing.`
    );
  }
  return migrated;
}

function migrateLegacyPhaseRoleFields(phase, options) {
  if (!plainObject(phase)) return phase;
  const migrated = clone(phase);
  delete migrated.suggestedPersonas;
  if (Object.hasOwn(migrated, 'approval')) {
    migrated.approval = migrateLegacyApprovalPolicy(migrated.approval, options);
  }
  return migrated;
}

function legacyPhaseRolePaths(contract, prefix) {
  if (!plainObject(contract)) return [];
  const paths = [];
  if (Object.hasOwn(contract, 'suggestedPersonas')) paths.push(`${prefix}.suggestedPersonas`);
  if (plainObject(contract.approval) && Object.hasOwn(contract.approval, 'personas')) {
    paths.push(`${prefix}.approval.personas`);
  }
  return paths;
}

function assertRepositoryContractNeedsNoLegacyRoleRewrite(contract, prefix) {
  const paths = legacyPhaseRolePaths(contract, prefix);
  if (!paths.length) return;
  throw unsafeLegacyPersonaMigration(
    `repository-owned contract '${prefix}' contains legacy role field(s): ${paths.join(', ')}.`,
    { path: prefix, fields: paths }
  );
}

/**
 * Migrate the registered version-1 role-prompt shape into the governed-agent schema.
 *
 * This is intentionally a field migration rather than a replacement with today's package file.
 * Repository-only work types, phases and policy remain byte-equivalent at the data-model level;
 * only fields that version 2 removed or renamed are changed. Unknown persona-to-authority mappings
 * fail closed instead of silently broadening who may approve work.
 */
async function migrateLegacyWorkflowForSeedRestore(root, current, incoming, enabled) {
  if (!enabled || !plainObject(current) || current.version !== 1) return current;
  // Prove that every role field belongs to the historical package before removing it. This runs
  // before workflow.yml, package assets, or the ownership receipt can be written.
  await assertLegacyPersonaMigrationSafe(root, current);
  const migrated = clone(current);
  const availableAuthorities = new Set([
    ...Object.keys(incoming.approvalAuthorities ?? {}),
    ...Object.keys(migrated.approvalAuthorities ?? {})
  ]);

  migrated.version = incoming.version;
  delete migrated.personaPromptsRoot;
  delete migrated.personas;

  if (plainObject(migrated.session)) {
    delete migrated.session.personaSelection;
    delete migrated.session.promptOnNewSession;
    delete migrated.session.promptOnResume;
  }

  for (const [phaseId, phase] of Object.entries(migrated.phases ?? {})) {
    if (!isKnownPackagedWorkflowValue('phases', phaseId, current.phases?.[phaseId])) {
      assertRepositoryContractNeedsNoLegacyRoleRewrite(
        phase, `phases.${phaseId}`
      );
      continue;
    }
    migrated.phases[phaseId] = migrateLegacyPhaseRoleFields(phase, {
      label: `Phase '${phaseId}' approval`, availableAuthorities
    });
  }
  for (const [workTypeId, workType] of Object.entries(migrated.workTypes ?? {})) {
    if (!plainObject(workType?.phaseOverrides)) continue;
    const frameworkOwned = isKnownPackagedWorkflowValue(
      'workTypes', workTypeId, current.workTypes?.[workTypeId]
    );
    for (const [phaseId, override] of Object.entries(workType.phaseOverrides)) {
      if (!frameworkOwned) {
        assertRepositoryContractNeedsNoLegacyRoleRewrite(
          override, `workTypes.${workTypeId}.phaseOverrides.${phaseId}`
        );
        continue;
      }
      workType.phaseOverrides[phaseId] = migrateLegacyPhaseRoleFields(override, {
        label: `Work type '${workTypeId}' phase override '${phaseId}' approval`,
        availableAuthorities
      });
    }
  }

  return migrated;
}

/**
 * Three-way merge one packaged value into approved repository configuration.
 *
 * The package baseline is the version last examined by a refresh. A repository value that still
 * equals that baseline can move automatically; a value changed by both the repository and the new
 * package is retained and reported. With no baseline, recursive additions and compatible closed
 * string-list expansions are safe; other differing values remain explicit customizations.
 */
export function mergePackagedConfiguration(base, local, incoming, {
  acceptBundledConflicts = false,
  resolutions = {}
} = {}) {
  const conflicts = [];
  const resolutionFor = (parts) => resolutions[displayPath(parts)]
    ?? (acceptBundledConflicts ? 'bundled' : 'local');

  const primitiveStringArray = (value) => Array.isArray(value)
    && value.every((entry) => typeof entry === 'string');

  const additiveArray = (left, right) => [...new Set([...left, ...right])];

  const conflict = (parts, localValue, bundledValue, resolution) => {
    conflicts.push({
      path: displayPath(parts),
      local: clone(localValue),
      bundled: clone(bundledValue),
      resolution
    });
  };

  const mergeNode = ({
    basePresent, localPresent, incomingPresent,
    baseValue, localValue, incomingValue, parts
  }) => {
    if (!incomingPresent) {
      if (!basePresent || !localPresent) return { present: localPresent, value: clone(localValue) };
      if (equal(localValue, baseValue)) return { present: false, value: undefined };
      const resolution = resolutionFor(parts);
      if (resolution === 'merge') {
        throw new SingularityFlowError(`Configuration conflict '${displayPath(parts)}' cannot be merged; choose local or bundled.`);
      }
      conflict(parts, localValue, undefined,
        resolution === 'bundled' ? 'accepted-bundled-deletion' : 'preserved-local');
      return resolution === 'bundled'
        ? { present: false, value: undefined }
        : { present: true, value: clone(localValue) };
    }

    if (!localPresent) {
      if (!basePresent) return { present: true, value: clone(incomingValue) };
      const resolution = resolutionFor(parts);
      if (equal(incomingValue, baseValue)) {
        // A missing local node normally represents an intentional repository deletion. An exact
        // reviewed `bundled` resolution must still be able to restore it; previously the early
        // return ignored both --resolve PATH=bundled and --accept-bundled-conflicts.
        if (resolution !== 'bundled') return { present: false, value: undefined };
        conflict(parts, undefined, incomingValue, 'accepted-bundled');
        return { present: true, value: clone(incomingValue) };
      }
      if (resolution === 'merge') {
        throw new SingularityFlowError(`Configuration conflict '${displayPath(parts)}' cannot be merged; choose local or bundled.`);
      }
      conflict(parts, undefined, incomingValue,
        resolution === 'bundled' ? 'accepted-bundled' : 'preserved-local-deletion');
      return resolution === 'bundled'
        ? { present: true, value: clone(incomingValue) }
        : { present: false, value: undefined };
    }

    if (!basePresent) {
      if (equal(localValue, incomingValue)) return { present: true, value: clone(localValue) };
      if (plainObject(localValue) && plainObject(incomingValue)) {
        return { present: true, value: mergeObject({}, localValue, incomingValue, parts) };
      }
      // First-upgrade repositories have no package baseline. A common safe case is a package
      // expanding a closed string allowlist (agents, phases, tools). Retain every local addition and
      // add every packaged requirement; this avoids producing a cross-field-invalid intermediate
      // workflow merely because the previous package revision did not record its baseline.
      if (primitiveStringArray(localValue) && primitiveStringArray(incomingValue)
        && (localValue.every((entry) => incomingValue.includes(entry))
          || incomingValue.every((entry) => localValue.includes(entry)))) {
        return { present: true, value: additiveArray(localValue, incomingValue) };
      }
      const resolution = resolutionFor(parts);
      if (resolution === 'merge'
        && !(primitiveStringArray(localValue) && primitiveStringArray(incomingValue))) {
        throw new SingularityFlowError(`Configuration conflict '${displayPath(parts)}' cannot be merged; choose local or bundled.`);
      }
      const selected = resolution === 'bundled' ? incomingValue
        : resolution === 'merge' && primitiveStringArray(localValue) && primitiveStringArray(incomingValue)
          ? additiveArray(localValue, incomingValue)
          : localValue;
      conflict(parts, localValue, incomingValue,
        resolution === 'bundled' ? 'accepted-bundled'
          : resolution === 'merge' ? 'merged-additively' : 'preserved-local');
      return { present: true, value: clone(selected) };
    }

    if (equal(localValue, baseValue)) return { present: true, value: clone(incomingValue) };
    if (plainObject(baseValue) && plainObject(localValue) && plainObject(incomingValue)) {
      return { present: true, value: mergeObject(baseValue, localValue, incomingValue, parts) };
    }
    if (equal(incomingValue, baseValue) || equal(localValue, incomingValue)) {
      return { present: true, value: clone(localValue) };
    }
    const resolution = resolutionFor(parts);
    if (resolution === 'merge'
      && !(primitiveStringArray(localValue) && primitiveStringArray(incomingValue))) {
      throw new SingularityFlowError(`Configuration conflict '${displayPath(parts)}' cannot be merged; choose local or bundled.`);
    }
    const selected = resolution === 'bundled' ? incomingValue
      : resolution === 'merge' && primitiveStringArray(localValue) && primitiveStringArray(incomingValue)
        ? additiveArray(localValue, incomingValue)
        : localValue;
    conflict(parts, localValue, incomingValue,
      resolution === 'bundled' ? 'accepted-bundled'
        : resolution === 'merge' ? 'merged-additively' : 'preserved-local');
    return { present: true, value: clone(selected) };
  };

  const mergeObject = (baseObject, localObject, incomingObject, parts) => {
    const output = {};
    const keys = [...new Set([
      ...Object.keys(baseObject ?? {}), ...Object.keys(localObject ?? {}), ...Object.keys(incomingObject ?? {})
    ])].sort();
    for (const key of keys) {
      const merged = mergeNode({
        basePresent: Object.hasOwn(baseObject ?? {}, key),
        localPresent: Object.hasOwn(localObject ?? {}, key),
        incomingPresent: Object.hasOwn(incomingObject ?? {}, key),
        baseValue: baseObject?.[key],
        localValue: localObject?.[key],
        incomingValue: incomingObject?.[key],
        parts: [...parts, key]
      });
      if (merged.present) output[key] = merged.value;
    }
    return output;
  };

  if (!plainObject(local) || !plainObject(incoming)) {
    throw new SingularityFlowError('Workflow configuration refresh requires object-valued YAML documents.');
  }
  const baseline = plainObject(base) ? base : {};
  return { value: mergeObject(baseline, local, incoming, []), conflicts };
}

async function walkPackageDirectory(sourceRoot, targetRoot, output) {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const target = path.posix.join(targetRoot, entry.name);
    if (entry.isDirectory()) await walkPackageDirectory(source, target, output);
    else if (entry.isFile() && !entry.isSymbolicLink()) output.set(target, await readFile(source));
  }
}

async function packagedAssets(templatesRoot) {
  const output = new Map();
  for (const [source, target] of FIXED_PACKAGE_ASSETS) {
    output.set(target, await readFile(path.join(PACKAGE_ROOT, 'templates', source)));
  }
  await walkPackageDirectory(
    path.join(PACKAGE_ROOT, 'templates', 'artifacts'),
    String(templatesRoot ?? 'singularity/templates').replaceAll('\\', '/'), output
  );
  await walkPackageDirectory(
    path.join(PACKAGE_ROOT, 'templates', 'agents'), '.github/agents', output
  );
  return new Map([...output.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function productIdentity() {
  const revision = BUILD_INFO.commit ?? BUILD_INFO.sourceSha256 ?? `version-${VERSION}`;
  return { version: VERSION, revision };
}

function safeRelative(value) {
  const relative = String(value ?? '').replaceAll('\\', '/');
  if (portableConfigurationPath(relative) !== relative) {
    throw new SingularityFlowError(
      `Packaged configuration target must use a portable path outside Git internals and runtime aliases: ${value}`,
      { code: 'CONFIGURATION_ASSET_PATH_INVALID' }
    );
  }
  return relative;
}

function pathsOverlap(left, right) {
  // Windows and the default macOS filesystem fold path case even though Git paths retain it.
  // Compare portable path identities case-insensitively so a case variant cannot move package
  // writes or retired-asset deletion into runtime evidence.
  const leftIdentity = portableFilesystemPathIdentity(left);
  const rightIdentity = portableFilesystemPathIdentity(right);
  return leftIdentity === rightIdentity
    || leftIdentity.startsWith(`${rightIdentity}/`)
    || rightIdentity.startsWith(`${leftIdentity}/`);
}

async function refreshConfigurationAssetPolicy(root, workflow) {
  const portfolioFile = await assertSafeTarget(root, 'singularity/portfolio.yml');
  const info = await lstat(portfolioFile)
    .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new SingularityFlowError(
      'Configuration policy source must be a regular file: singularity/portfolio.yml'
    );
  }
  let portfolio = {};
  if (info) {
    try { portfolio = YAML.parse(await readFile(portfolioFile, 'utf8')) ?? {}; }
    catch (error) {
      throw new SingularityFlowError(`Configuration policy source is invalid YAML: ${error.message}`);
    }
  }
  return configurationAssetPolicy(workflow, portfolio);
}

function assertPackagedAssetBoundary(templatesRoot, assets, policy) {
  const root = safeRelative(templatesRoot ?? 'singularity/templates');
  // `.sflow/**` is disposable execution/test evidence rather than approved configuration. It is
  // intentionally outside the general configuration policy because it is not otherwise searched
  // or mirrored, but a redirected template root must still never turn it into a package target.
  const runtimeRoots = [...new Set([...policy.runtimeRoots, '.sflow'])];
  const overlap = runtimeRoots.find((runtimeRoot) => pathsOverlap(root, runtimeRoot));
  if (overlap) {
    throw new SingularityFlowError(
      `Packaged templates root '${root}' overlaps runtime state '${overlap}'.`,
      { code: 'CONFIGURATION_ASSET_TARGET_RUNTIME_OVERLAP' }
    );
  }
  for (const relative of assets.keys()) {
    if (!isConfigurationAsset(relative, policy)) {
      throw new SingularityFlowError(
        `Packaged configuration target is outside the approved configuration asset policy: ${relative}`,
        { code: 'CONFIGURATION_ASSET_TARGET_UNMANAGED' }
      );
    }
  }
}

function assertRetiredPackagedAssetBoundary(priorAssets, assets, policy, {
  historicalRuntimeRoots = []
} = {}) {
  // Baselines are repository-controlled input, including legacy receipts that predate explicit
  // ownership. Never let a stale or forged baseline turn runtime evidence into a retired package
  // asset. Validate the complete retired set before workflow.yml or any current package asset is
  // written so rejection is atomic from the repository's point of view.
  const runtimeRoots = [...new Set([
    ...policy.runtimeRoots, ...historicalRuntimeRoots, '.sflow'
  ])];
  for (const candidate of Object.keys(priorAssets)) {
    if (assets.has(candidate)) continue;
    const relative = safeRelative(candidate);
    const overlap = runtimeRoots.find((runtimeRoot) => pathsOverlap(relative, runtimeRoot));
    if (overlap) {
      throw new SingularityFlowError(
        `Retired packaged configuration target '${relative}' overlaps runtime state '${overlap}'.`,
        { code: 'CONFIGURATION_RETIRED_ASSET_RUNTIME_OVERLAP' }
      );
    }
    if (!isConfigurationAsset(relative, policy)) {
      throw new SingularityFlowError(
        `Retired packaged configuration target is outside the approved current or historical configuration asset policy: ${relative}`,
        { code: 'CONFIGURATION_RETIRED_ASSET_TARGET_UNMANAGED' }
      );
    }
  }
}

function assertResolutionPolicy(resolutions, policy) {
  for (const conflictPath of Object.keys(resolutions)) {
    if (conflictPath.startsWith('workflow.')) continue;
    if (!isConfigurationAsset(conflictPath, policy)) {
      throw new SingularityFlowError(
        `Configuration conflict path is not managed by this repository: ${conflictPath}`,
        { code: 'CONFIGURATION_CONFLICT_PATH_UNMANAGED' }
      );
    }
  }
}

export function normalizeRefreshResolutions(value = {}) {
  if (!plainObject(value)) throw new SingularityFlowError('Configuration conflict resolutions must be an object.');
  const output = {};
  for (const [rawPath, rawResolution] of Object.entries(value)) {
    const conflictPath = String(rawPath).trim();
    const resolution = String(rawResolution).trim();
    // Filesystem conflicts are checked against each candidate repository's effective policy after
    // its approved workflow and portfolio have been read. Doing that against the static default
    // here rejected valid exact resolutions below a custom templatesRoot; accepting only a portable
    // spelling here preserves fail-closed, per-repository validation for multi-repository plans.
    if (!conflictPath || (!conflictPath.startsWith('workflow.')
      && portableConfigurationPath(conflictPath) !== conflictPath)) {
      throw new SingularityFlowError(`Configuration conflict path is not managed: ${rawPath}`);
    }
    if (!['local', 'bundled', 'merge'].includes(resolution)) {
      throw new SingularityFlowError(`Configuration conflict '${conflictPath}' must resolve to local, bundled, or merge.`);
    }
    output[conflictPath] = resolution;
  }
  return output;
}

async function assertSafeTarget(root, relative) {
  const parts = safeRelative(relative).split('/');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) {
      throw new SingularityFlowError(
        `Packaged configuration target cannot traverse a symbolic link: ${relative}`, {
          code: 'CONFIGURATION_ASSET_TARGET_SYMBOLIC_LINK'
        }
      );
    }
  }
  return path.join(root, ...parts);
}

async function existingPortablePathIndex(root) {
  const index = new Map();
  const visit = async (directory, parent = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = parent ? `${parent}/${entry.name}` : entry.name;
      if (relative === '.git') continue;
      const identity = portableFilesystemPathIdentity(relative);
      const values = index.get(identity) ?? [];
      values.push(relative);
      index.set(identity, values);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path.join(directory, entry.name), relative);
      }
    }
  };
  await visit(root);
  return index;
}

async function assertNoPortableConfigurationAliases(root, targets) {
  const index = await existingPortablePathIndex(root);
  const targetIdentities = new Map();
  for (const rawTarget of targets) {
    const target = safeRelative(rawTarget);
    const components = target.split('/');
    for (let length = 1; length <= components.length; length += 1) {
      const prefix = components.slice(0, length).join('/');
      const identity = portableFilesystemPathIdentity(prefix);
      const priorTarget = targetIdentities.get(identity);
      if (priorTarget && priorTarget !== prefix) {
        throw new SingularityFlowError(
          `Packaged configuration paths '${priorTarget}' and '${prefix}' collide on a portable filesystem.`, {
            code: 'CONFIGURATION_ASSET_PORTABLE_COLLISION',
            details: { target: prefix, collision: priorTarget }
          }
        );
      }
      targetIdentities.set(identity, prefix);
      const collision = (index.get(identity) ?? []).find((candidate) => candidate !== prefix);
      if (collision) {
        throw new SingularityFlowError(
          `Packaged configuration target '${prefix}' aliases existing repository path '${collision}' on a portable filesystem.`, {
            code: 'CONFIGURATION_ASSET_PORTABLE_COLLISION',
            details: { target: prefix, collision }
          }
        );
      }
    }
  }
}

async function assertRegularConfigurationTargets(root, targets) {
  for (const relative of targets) {
    const target = await assertSafeTarget(root, relative);
    const info = await lstat(target)
      .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new SingularityFlowError(
        `Packaged configuration target must be a regular file: ${relative}`, {
          code: 'CONFIGURATION_ASSET_TARGET_NOT_REGULAR'
        }
      );
    }
  }
}

async function readBaseline(root) {
  const file = await assertSafeTarget(root, PACKAGE_BASELINE_PATH);
  const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SingularityFlowError(`${PACKAGE_BASELINE_PATH} must be a regular file.`);
  }
  let baseline;
  try { baseline = YAML.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`Packaged configuration baseline is invalid YAML: ${error.message}`); }
  if (baseline?.format !== BASELINE_FORMAT || !plainObject(baseline.workflow) || !plainObject(baseline.assets)) {
    throw new SingularityFlowError(`Packaged configuration baseline must use ${BASELINE_FORMAT}.`);
  }
  if (baseline.ownership != null) {
    const workflowOwnership = baseline.ownership?.workflow;
    const assetOwnership = baseline.ownership?.assets;
    if (!plainObject(baseline.ownership) || !plainObject(workflowOwnership)
        || !plainObject(assetOwnership)) {
      throw new SingularityFlowError('Packaged configuration baseline ownership receipt is invalid.');
    }
    for (const section of ['workTypes', 'phases', 'artifactSets', 'mcpServers']) {
      if (!plainObject(workflowOwnership[section])) {
        throw new SingularityFlowError(
          `Packaged configuration baseline ownership receipt is missing workflow.${section}.`
        );
      }
      for (const owner of Object.values(workflowOwnership[section])) {
        if (!PACKAGE_OWNERSHIP_VALUES.has(owner)) {
          throw new SingularityFlowError(
            `Packaged configuration baseline workflow ownership must be '${PACKAGE_OWNERSHIP_FRAMEWORK}' or '${PACKAGE_OWNERSHIP_REPOSITORY}'.`
          );
        }
      }
    }
    for (const owner of Object.values(assetOwnership)) {
      if (!PACKAGE_OWNERSHIP_VALUES.has(owner)) {
        throw new SingularityFlowError(
          `Packaged configuration baseline asset ownership must be '${PACKAGE_OWNERSHIP_FRAMEWORK}' or '${PACKAGE_OWNERSHIP_REPOSITORY}'.`
        );
      }
    }
  }
  return baseline;
}

/** Refresh one isolated checkout from the package while retaining proven repository customizations. */
export async function refreshPackagedConfiguration(root, {
  dryRun = false,
  acceptBundledConflicts = false,
  resolutions = {},
  restorePackagedSeeds = false
} = {}) {
  resolutions = normalizeRefreshResolutions(resolutions);
  const ownershipTransfers = Object.entries(resolutions)
    .filter(([, resolution]) => resolution !== 'local');
  if (restorePackagedSeeds && (acceptBundledConflicts || ownershipTransfers.length)) {
    throw new SingularityFlowError(
      'Safe reinitialization cannot adopt packaged content over repository-owned configuration. '
        + 'Keep the repository value, or use the separately reviewed workspace refresh-configuration journey to replace it.',
      {
        code: 'WORKSPACE_REINITIALIZE_OWNERSHIP_TRANSFER_UNSUPPORTED',
        details: { paths: ownershipTransfers.map(([conflictPath]) => conflictPath) }
      }
    );
  }
  const workflowFile = await assertSafeTarget(root, WORKFLOW_PATH);
  const workflowInfo = await lstat(workflowFile)
    .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (workflowInfo && (!workflowInfo.isFile() || workflowInfo.isSymbolicLink())) {
    throw new SingularityFlowError(`${WORKFLOW_PATH} must be a regular file.`, {
      code: 'CONFIGURATION_WORKFLOW_NOT_REGULAR'
    });
  }
  if (!workflowInfo && !restorePackagedSeeds) {
    throw new SingularityFlowError(`${WORKFLOW_PATH} must be a regular file.`, {
      code: 'CONFIGURATION_WORKFLOW_NOT_REGULAR'
    });
  }
  const [incomingText, baseline] = await Promise.all([
    readFile(path.join(PACKAGE_ROOT, 'templates', 'workflow.yml'), 'utf8'),
    readBaseline(root)
  ]);
  // An absent workflow file contains no repository-authored nodes to preserve. Seeded-only
  // reinitialization may therefore recreate the packaged workflow container, while ordinary
  // refresh remains fail-closed and every non-regular target is still refused above. Starting the
  // merge from the incoming definition restores top-level schema/default fields as well as the
  // node-scoped work type and phase catalog.
  const workflowMissing = !workflowInfo;
  const currentText = workflowMissing ? incomingText : await readFile(workflowFile, 'utf8');
  let current;
  let incoming;
  try {
    current = YAML.parse(currentText);
    incoming = YAML.parse(incomingText);
  } catch (error) {
    throw new SingularityFlowError(`Workflow configuration refresh requires valid YAML: ${error.message}`);
  }
  if (!restorePackagedSeeds) validateDefinition(structuredClone(current));
  validateDefinition(structuredClone(incoming));
  const mergeCurrent = await migrateLegacyWorkflowForSeedRestore(
    root, current, incoming, restorePackagedSeeds
  );

  const requiredWorkflowPaths = requiredPackagedWorkflowPaths(mergeCurrent, incoming);
  const merged = mergePackagedConfiguration(baseline?.workflow ?? {}, mergeCurrent, incoming, {
    acceptBundledConflicts,
    // A standard product workflow is always restored as packaged when it is absent. Repository
    // customizations inside an installed profile continue through the normal three-way merge.
    resolutions: {
      ...resolutions,
      ...Object.fromEntries([...requiredWorkflowPaths].map((entry) => [entry, 'bundled']))
    }
  });
  // Record ownership even during ordinary refresh so a later reinitialize can distinguish a
  // package seed from a same-ID repository contract. Legacy baselines without this receipt are
  // inferred only from exact current/package or current/prior-package equality.
  // Ownership is proven against the bytes/data as found. A v1 field migration deliberately
  // changes that data shape, so hashing the migrated value would lose otherwise exact historical
  // package provenance and incorrectly preserve stale seeds as repository-owned.
  const workflowOwnership = packagedWorkflowOwnership(current, incoming, baseline);
  const seededWorkflowResult = restorePackagedSeeds
    ? applyPackagedWorkflowOwnership(
      merged.value, mergeCurrent, incoming, workflowOwnership
    ) : { exactRoots: new Set(), collisionRoots: new Set(), conflicts: [] };
  // Required restoration is an invariant, not a choice the preview can switch back to local. Keep
  // ordinary repository customizations visible while avoiding a misleading dropdown for these
  // product-owned missing nodes.
  merged.conflicts = merged.conflicts.filter((entry) =>
    !requiredWorkflowPaths.has(entry.path)
    && !isWithinOwnedConfigurationPath(entry.path, seededWorkflowResult.exactRoots)
    && !isWithinOwnedConfigurationPath(entry.path, seededWorkflowResult.collisionRoots));
  merged.conflicts.push(...seededWorkflowResult.conflicts);
  // Exact framework legacy role fields have been migrated above. Repository-created legacy role
  // fields are refused rather than rewritten. Defer only the live Agent Markdown reference lookup;
  // the complete post-write loadDefinition below validates the restored agent catalog and tools.
  validateDefinition(structuredClone(merged.value), {
    storyBootstrap: restorePackagedSeeds && current.version === 1
  });

  const assets = await packagedAssets(merged.value.templatesRoot);
  const assetPolicy = await refreshConfigurationAssetPolicy(root, merged.value);
  // This check precedes every write, including workflow.yml. A malformed older authority can
  // therefore be diagnosed/reinitialized without ever materializing package templates inside
  // Story/runtime evidence or staging those bytes in a later configuration publication.
  assertPackagedAssetBoundary(merged.value.templatesRoot, assets, assetPolicy);
  assertResolutionPolicy(resolutions, assetPolicy);
  const priorAssets = baseline?.assets ?? {};
  // A legitimately retired asset can belong to the currently approved roots or to the package's
  // trusted default historical roots. The repository-controlled baseline may contribute runtime
  // exclusions (for example its former workItemRoot), but may not authorize a new writable root:
  // otherwise a forged templatesRoot plus asset key could delete arbitrary application source.
  // Runtime exclusions from both generations remain absolute.
  const retiredAssetPolicy = mergeConfigurationAssetPolicies(
    assetPolicy, configurationAssetPolicy()
  );
  const historicalRuntimePolicy = configurationAssetPolicy(baseline?.workflow ?? {});
  assertRetiredPackagedAssetBoundary(priorAssets, assets, retiredAssetPolicy, {
    historicalRuntimeRoots: historicalRuntimePolicy.runtimeRoots
  });
  const managedTargets = [...new Set([
    WORKFLOW_PATH, PACKAGE_BASELINE_PATH, ...assets.keys(), ...Object.keys(priorAssets)
  ])];
  // A Git tree can contain two spellings that alias on Windows or default macOS filesystems even
  // when the Linux build host keeps them distinct. Reject the entire candidate before the first
  // write so reinitialization never publishes a configuration branch another machine cannot
  // materialize safely.
  await assertNoPortableConfigurationAliases(root, managedTargets);
  await assertRegularConfigurationTargets(root, [
    ...assets.keys(), ...Object.keys(priorAssets)
  ]);
  const conflicts = [...merged.conflicts];
  const changedFiles = new Set();
  const removedFiles = new Set();
  const assetOwnership = {};

  if (workflowMissing || !equal(current, merged.value)) {
    changedFiles.add(WORKFLOW_PATH);
    if (!dryRun) {
      await writeAtomic(workflowFile, workflowMissing
        ? YAML.stringify(merged.value)
        : patchWorkflowDocument(currentText, current, merged.value));
    }
  }

  for (const [relative, bundled] of assets) {
    const target = await assertSafeTarget(root, relative);
    const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new SingularityFlowError(`Packaged configuration asset must be a regular file: ${relative}`);
    }
    const currentBytes = info ? await readFile(target) : null;
    const currentHash = currentBytes ? sha256(currentBytes) : null;
    const bundledHash = sha256(bundled);
    const priorHash = priorAssets[relative]?.sha256 ?? null;
    const retiredPackagedAsset = isRetiredPackagedAssetHash(relative, currentHash, {
      templatesRoot: merged.value.templatesRoot
    });
    let owner = packagedAssetOwner(baseline, relative, {
      exists: Boolean(info), currentHash, bundledHash, priorHash, retiredPackagedAsset,
      strictProvenance: restorePackagedSeeds,
      templatesRoot: merged.value.templatesRoot
    });
    const explicitResolution = resolutions[relative] ?? null;
    if (explicitResolution === 'merge') {
      throw new SingularityFlowError(`Configuration asset conflict '${relative}' cannot be merged; choose local or bundled.`);
    }
    if (!restorePackagedSeeds && owner === PACKAGE_OWNERSHIP_REPOSITORY
        && explicitResolution === 'bundled') {
      owner = PACKAGE_OWNERSHIP_FRAMEWORK;
    }
    assetOwnership[relative] = owner;
    const ordinarilySafe = !info || currentHash === bundledHash
      || (priorHash && currentHash === priorHash) || retiredPackagedAsset;
    const exactSeedRestore = restorePackagedSeeds
      && owner === PACKAGE_OWNERSHIP_FRAMEWORK
      && packageAssetAllowsExactSeedRestore(relative);
    const safeToWrite = owner === PACKAGE_OWNERSHIP_FRAMEWORK
      && (ordinarilySafe || exactSeedRestore);
    if (currentHash === bundledHash) continue;
    // A broad "accept bundled" switch may resolve an ordinary package conflict, but it must not
    // convert a proven repository-owned same-path collision into a framework seed. Only the exact
    // path resolution reviewed in this plan may transfer that ownership.
    const resolution = owner === PACKAGE_OWNERSHIP_REPOSITORY
      ? 'local' : explicitResolution ?? (acceptBundledConflicts ? 'bundled' : 'local');
    if (resolution === 'merge') {
      throw new SingularityFlowError(`Configuration asset conflict '${relative}' cannot be merged; choose local or bundled.`);
    }
    if (!safeToWrite && resolution !== 'bundled') {
      conflicts.push({
        path: relative,
        localSha256: currentHash,
        bundledSha256: bundledHash,
        resolution: 'preserved-local'
      });
      continue;
    }
    if (!safeToWrite) {
      conflicts.push({
        path: relative,
        localSha256: currentHash,
        bundledSha256: bundledHash,
        resolution: 'accepted-bundled'
      });
    }
    changedFiles.add(relative);
    if (!dryRun) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, bundled);
    }
  }

  // A package may retire a managed asset. Remove it only when its bytes still equal the baseline;
  // otherwise it has become repository-owned and is retained as a visible conflict.
  for (const [relative, prior] of Object.entries(priorAssets)) {
    if (assets.has(relative)) continue;
    const target = await assertSafeTarget(root, relative);
    const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SingularityFlowError(`Retired packaged configuration asset must be a regular file: ${relative}`);
    }
    const currentHash = sha256(await readFile(target));
    // Reinitialize may remove only an exact historical package revision registered by this build.
    // A repository-controlled baseline receipt (including an exact hash copied from the current
    // file) is not independent provenance and must never turn an arbitrary configuration file into
    // a disposable framework seed. Ordinary reviewed refresh retains its existing three-way
    // retirement behavior; the stronger rule applies to the seeded-only reinitialization mode.
    if (restorePackagedSeeds && !isRetiredPackagedAssetHash(relative, currentHash, {
      templatesRoot: baseline?.workflow?.templatesRoot ?? merged.value.templatesRoot
    })) {
      conflicts.push({
        path: relative, localSha256: currentHash, bundledSha256: null,
        resolution: 'preserved-local'
      });
      assetOwnership[relative] = PACKAGE_OWNERSHIP_REPOSITORY;
      continue;
    }
    const recordedOwner = baseline?.ownership?.assets?.[relative] ?? null;
    const inferredOwner = recordedOwner === PACKAGE_OWNERSHIP_FRAMEWORK
      || recordedOwner === PACKAGE_OWNERSHIP_REPOSITORY
      ? recordedOwner
      : currentHash === prior.sha256
        ? PACKAGE_OWNERSHIP_FRAMEWORK : PACKAGE_OWNERSHIP_REPOSITORY;
    const explicitResolution = resolutions[relative] ?? null;
    if (explicitResolution === 'merge') {
      throw new SingularityFlowError(`Configuration asset conflict '${relative}' cannot be merged; choose local or bundled.`);
    }
    const repositoryOwned = inferredOwner === PACKAGE_OWNERSHIP_REPOSITORY
      && (restorePackagedSeeds || explicitResolution !== 'bundled');
    if (restorePackagedSeeds && repositoryOwned) {
      assetOwnership[relative] = PACKAGE_OWNERSHIP_REPOSITORY;
      continue;
    }
    const resolution = explicitResolution ?? (acceptBundledConflicts ? 'bundled' : 'local');
    if (currentHash !== prior.sha256 && resolution !== 'bundled') {
      conflicts.push({ path: relative, localSha256: currentHash, bundledSha256: null, resolution: 'preserved-local' });
      assetOwnership[relative] = PACKAGE_OWNERSHIP_REPOSITORY;
      continue;
    }
    if (currentHash !== prior.sha256) {
      conflicts.push({ path: relative, localSha256: currentHash, bundledSha256: null, resolution: 'accepted-bundled-deletion' });
    }
    changedFiles.add(relative);
    removedFiles.add(relative);
    if (!dryRun) await rm(target, { force: true });
  }

  const lock = {
    format: BASELINE_FORMAT,
    product: productIdentity(),
    workflow: incoming,
    assets: Object.fromEntries([...assets.entries()].map(([relative, contents]) => [relative, { sha256: sha256(contents) }])),
    ownership: {
      workflow: workflowOwnership.receipt,
      assets: Object.fromEntries(Object.entries(assetOwnership).sort(([left], [right]) =>
        left.localeCompare(right)))
    }
  };
  // Product revision identifies the build that supplied these seeds, but a developer checkout or
  // an incorrectly assembled distribution can retain that revision while its packaged bytes move.
  // Bind refresh confirmation to the complete package payload as well as to the build identity.
  const packageContentDigest = sha256(JSON.stringify(canonical({
    workflow: incoming,
    assets: Object.fromEntries([...assets.entries()].map(([relative, contents]) => [
      relative, sha256(contents)
    ]))
  })));
  const lockText = YAML.stringify(lock);
  const previousLockText = await readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8').catch(() => null);
  if (previousLockText !== lockText) {
    changedFiles.add(PACKAGE_BASELINE_PATH);
    if (!dryRun) {
      const lockTarget = await assertSafeTarget(root, PACKAGE_BASELINE_PATH);
      await mkdir(path.dirname(lockTarget), { recursive: true });
      await writeAtomic(lockTarget, lockText);
    }
  }

  if (!dryRun) {
    try {
      // Workflow fields, agents, templates and prompts are one executable contract. Validating only
      // the merged workflow allowed a preserved, older agent to omit a newly introduced phase and
      // still be pushed to sflow/config; every later Story then failed while loading configuration.
      await loadDefinition(root);
    } catch (error) {
      const preserved = conflicts.filter((entry) => entry.resolution === 'preserved-local'
        || entry.resolution === 'preserved-local-deletion').map((entry) => entry.path);
      const guidance = preserved.length
        ? ` Resolve the relevant preserved conflict with --resolve PATH=bundled and preview again. Preserved: ${preserved.join(', ')}.`
        : '';
      const cause = String(error.message).replace(/[.\s]+$/, '');
      throw new SingularityFlowError(
        `The refreshed configuration is not operational: ${cause}.${guidance}`,
        {
          code: 'CONFIGURATION_REFRESH_INVALID',
          details: { conflicts, cause: error.message }
        }
      );
    }
  }

  return {
    product: lock.product,
    packageContentDigest,
    changed: changedFiles.size > 0,
    files: [...changedFiles].sort(),
    removed: [...removedFiles].sort(),
    conflicts,
    dryRun
  };
}

async function remoteHeads(remote, branches, { env = process.env, cwd = undefined } = {}) {
  const requested = [...new Set(branches.filter(Boolean))];
  const transport = frozenRemoteTransport(remote, { env });
  const observed = await runRemoteGitAsync([
    // `--symref` makes a symbolic branch visible instead of silently accepting its dereferenced
    // object as direct authority. Configuration/state authority branches must be direct refs.
    'ls-remote', '--symref', '--heads', '--', transport.remote,
    ...requested.map((branch) => `refs/heads/${branch}`)
  ], { cwd, operation: 'remote-probe', env: transport.env });
  if (observed.status !== 0) {
    throw new SingularityFlowError(
      `Cannot read '${sanitizeRemote(remote)}'. ${observed.failure?.advice ?? 'Git remote access failed.'}`,
      { code: observed.failure?.code ?? 'REMOTE_UNKNOWN' }
    );
  }
  const heads = new Map(requested.map((branch) => [branch, null]));
  const lines = observed.stdout.split(/\r?\n/u).filter(Boolean);
  const seen = new Set();
  let objectLength = null;
  for (const line of lines) {
    const match = /^([^\t\r\n]+)\t([^\t\r\n]+)$/u.exec(line);
    const prefix = 'refs/heads/';
    const value = match?.[1] ?? '';
    const ref = match?.[2] ?? '';
    const branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
    if (!match || !branch || !heads.has(branch) || seen.has(ref)
        || value.startsWith('ref: ') || !EXACT_GIT_OID.test(value)
        || (objectLength != null && value.length !== objectLength)) {
      throw new SingularityFlowError(
        `Cannot interpret the exact branch authority returned by '${sanitizeRemote(remote)}'.`, {
          code: 'REMOTE_REF_PROTOCOL_INVALID'
        }
      );
    }
    objectLength ??= value.length;
    seen.add(ref);
    heads.set(branch, value);
  }
  return heads;
}

async function cloneConfiguration(remote, { env = process.env } = {}) {
  // Keep one alias/environment for the clone and every later fetch/push from the ephemeral
  // candidate. Git persists the user-supplied clone argument as origin, so retaining the alias here
  // lets named-origin ledger operations share the same frozen authority without consulting a
  // mutable url.* rewrite again.
  const transport = frozenRemoteTransport(remote, { push: true, env });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-refresh-'));
  const cloned = await runRemoteGitAsync([
    'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
    '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
  ], { operation: 'remote-configuration', env: transport.env });
  if (cloned.status !== 0) {
    await removeTemporaryTree(scratch);
    throw new SingularityFlowError(
      `Cannot clone '${sanitizeRemote(remote)}' branch '${CONFIGURATION_BRANCH}'. `
        + remoteFailureMessage(cloned)
    );
  }
  return { root: scratch, env: transport.env };
}

/**
 * Build the configuration candidate that a first-authority apply would create, without publishing
 * the branch. Reinitialization uses this disposable checkout for schema-root/state inspection so a
 * missing sflow/config branch cannot fall back to stale application-checkout policy during preview.
 */
async function prepareBootstrapInspectionCandidate(observation, options, {
  env = process.env,
  identityEnv = withoutGitProcessOverrides(process.env)
} = {}) {
  const { repository, bootstrapCommit } = observation;
  const transport = frozenRemoteTransport(repository.remote, { push: true, env });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-bootstrap-preview-'));
  try {
    const cloned = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--branch', repository.defaultBranch, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) throw new SingularityFlowError(
      `Cannot inspect the would-be configuration authority for '${repository.displayRemote}'. `
        + remoteFailureMessage(cloned),
      { code: 'CONFIGURATION_BOOTSTRAP_PREVIEW_UNAVAILABLE' }
    );
    const clonedCommit = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    if (clonedCommit !== bootstrapCommit) throw new SingularityFlowError(
      'The application source branch changed while its configuration bootstrap was being previewed.', {
        code: 'CONFIGURATION_BOOTSTRAP_SOURCE_CHANGED'
      }
    );
    // Derive identity from the registered checkout, not the transport-isolated temporary clone.
    // The exact value becomes part of both the previewed bytes (approval membership) and the
    // deterministic parentless commit, so apply must reuse it rather than rediscovering identity.
    // Remote transport intentionally hides system/global config. Commit identity is local
    // authoring metadata, so read it through the ordinary Git scopes after stripping inherited
    // process-level Git selectors. This preserves a user's globally configured identity without
    // admitting GIT_CONFIG_* overrides into the reviewed candidate.
    const authorIdentity = gitCommitIdentity(repository.localPath, { env: identityEnv });
    const frameworkApprovalAuthoritySeeds = {
      workflow: YAML.parse(await readFile(
        path.join(PACKAGE_ROOT, 'templates', 'workflow.yml'), 'utf8'
      )).approvalAuthorities ?? {},
      portfolio: YAML.parse(await readFile(
        path.join(PACKAGE_ROOT, 'templates', 'portfolio.yml'), 'utf8'
      )).approvalAuthorities ?? {}
    };
    await prepareConfigurationBootstrapWorktree(scratch, {
      sourceRef: 'HEAD', remote: repository.remote,
      defaultBranch: repository.defaultBranch, authorIdentity, env: transport.env,
      preserveImportedApprovalAuthorities: options.restorePackagedSeeds === true,
      preserveImportedRepositoryPolicy: options.restorePackagedSeeds === true,
      preserveImportedLedgerPolicy: options.restorePackagedSeeds === true,
      frameworkApprovalAuthoritySeeds
    });
    const refresh = await refreshPackagedConfiguration(scratch, options);
    const desired = await desiredStateProjection(scratch, { env: transport.env });
    assertDedicatedStateAuthority(repository, desired);
    const stateCommit = await fetchStateRefAsync(scratch, desired.stateConfig, {
      env: transport.env
    });
    assertExistingStateAuthority(scratch, repository, desired, stateCommit, {
      env: transport.env
    });
    const stateBefore = observeStateProjection(
      scratch, desired, null, refresh.product, { stateCommit, env: transport.env }
    );
    // Commit locally during preview with source-bound deterministic metadata.  This does not make
    // a remote mutation, but it gives confirmation one exact Git identity.  Apply reconstructs the
    // same commit and ensureConfigurationBranch pushes only that reviewed object under an absent-ref
    // CAS; there is no intermediate unreviewed bootstrap branch.
    const sourceDate = run('git', ['show', '-s', '--format=%aI', bootstrapCommit], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    const commitEnv = {
      ...transport.env,
      GIT_AUTHOR_DATE: sourceDate,
      GIT_COMMITTER_DATE: sourceDate
    };
    run('git', ['add', '-A'], { cwd: scratch, env: commitEnv });
    run('git', [
      '-c', `user.name=${authorIdentity.name || 'Singularity Flow'}`,
      '-c', `user.email=${authorIdentity.email || 'unknown@invalid'}`,
      '-c', 'commit.gpgSign=false',
      'commit', '--no-verify', '-m', '[configuration] establish reviewed Singularity configuration authority'
    ], { cwd: scratch, env: commitEnv });
    const bootstrapCandidateCommit = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    const bootstrapCandidateTree = run('git', ['rev-parse', '--verify', 'HEAD^{tree}'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    return {
      repository,
      root: scratch,
      sourceCommit: null,
      bootstrapCommit,
      bootstrapCandidateCommit,
      bootstrapCandidateTree,
      bootstrapAuthorIdentity: authorIdentity,
      refresh,
      desired,
      stateBefore,
      gitEnv: transport.env
    };
  } catch (error) {
    await removeTemporaryTree(scratch);
    throw error;
  }
}

function refreshCacheRoot(registryFile) {
  if (process.platform === 'win32') {
    // Node does not expose Windows ACL ownership through lstat. Keep reusable cache bytes under the
    // OS-provided per-user application-data boundary instead of beside a registry that may live on
    // a shared drive. Without that boundary the optional optimization is disabled, fail-closed.
    const localAppData = String(process.env.LOCALAPPDATA ?? '').trim();
    if (!localAppData) return null;
    return path.join(
      path.resolve(localAppData), 'Singularity Flow', 'configuration-refresh-cache',
      sha256(path.resolve(registryFile)).slice(0, 32)
    );
  }
  return path.join(path.dirname(path.resolve(registryFile)), '.configuration-refresh-cache');
}

function refreshCacheRepositoryKey(remote) {
  return remoteFingerprint(assertCredentialFreeRemote(remote)).slice(0, 32);
}

async function boundedCacheRecord(file, maxBytes = REFRESH_CACHE_RECORD_MAX_BYTES) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

function cacheAclIsSafe(target, { privatePath = false } = {}) {
  // Windows cache placement is already restricted to the per-user LocalAppData boundary because
  // Node does not expose its ACLs. Keep that platform's documented fail-closed placement contract.
  if (process.platform === 'win32') return true;
  const listed = run('ls', [process.platform === 'darwin' ? '-lde' : '-ld', target], {
    allowFailure: true
  });
  if (listed.status !== 0) return false;
  const mode = listed.stdout.split(/\s+/, 1)[0] ?? '';
  if (process.platform !== 'darwin') {
    if (!mode.includes('+')) return true;
    // GNU `ls` exposes the presence, but not the effective/default ACL. The optional cache is safer
    // to skip than to guess whether a named or inherited ACL defeats classic mode bits.
    return false;
  }
  const accessEntries = listed.stdout.split(/\r?\n/).slice(1)
    .map((line) => line.trim()).filter((line) => /^\d+:/.test(line));
  return !accessEntries.some((entry) => {
    if (!/\ballow\b/i.test(entry)) return false;
    if (privatePath) return true;
    // Traversal-only ACLs do not authorize replacing a private descendant. Mutation, deletion, ACL
    // inheritance, or ownership rights do, so an ancestor carrying one is not a safe pathname root.
    return /\b(?:add_file|add_subdirectory|delete_child|delete|write|writeattr|writeextattr|writesecurity|chown|file_inherit|directory_inherit)\b/i
      .test(entry);
  });
}

async function securePrivateCachePath(target, { directory, mode }) {
  let info = await lstat(target).catch(() => null);
  const expectedKind = directory ? info?.isDirectory() : info?.isFile();
  if (!expectedKind || info.isSymbolicLink()) return null;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
  try { await chmod(target, mode); } catch { return null; }
  info = await lstat(target).catch(() => null);
  const securedKind = directory ? info?.isDirectory() : info?.isFile();
  if (!securedKind || info.isSymbolicLink()) return null;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
  // POSIX permission bits are not meaningful on Windows. On platforms that expose a uid, however,
  // a cache is reusable only when other users cannot mutate the directory or its ownership receipt.
  if (typeof process.getuid === 'function' && (info.mode & 0o077) !== 0) return null;
  if (!cacheAclIsSafe(target, { privatePath: true })) return null;
  return info;
}

async function approvedCacheAncestorChain(start) {
  if (process.platform === 'win32') {
    const info = await lstat(start).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const canonical = await realpath(start).catch(() => null);
    return canonical ? { path: canonical, dev: info.dev, ino: info.ino } : null;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let current = start;
  let childInfo = null;
  let first = null;
  while (true) {
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    if (await realpath(current).catch(() => null) !== current) return null;
    if (!cacheAclIsSafe(current)) return null;
    if (!first) first = { path: current, dev: info.dev, ino: info.ino };
    if (uid !== null) {
      const sharedWritable = (info.mode & 0o022) !== 0;
      const sticky = (info.mode & 0o1000) !== 0;
      if (sharedWritable && !sticky) return null;
      // Sticky semantics protect only entries owned by this principal (or the directory owner). A
      // shared temp ancestor therefore cannot safely anchor a child belonging to somebody else.
      if (sharedWritable && childInfo && childInfo.uid !== uid && info.uid !== uid) return null;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    const rebound = await lstat(path.join(parent, path.basename(current))).catch(() => null);
    if (!rebound || rebound.dev !== info.dev || rebound.ino !== info.ino) return null;
    childInfo = info;
    current = parent;
  }
  return first;
}

async function approvedRefreshCacheParent(target, { create = false } = {}) {
  const parent = path.dirname(target);
  if (create) {
    try { await mkdir(parent, { recursive: true, mode: 0o700 }); }
    catch { return null; }
  }
  const canonical = await realpath(parent).catch(() => null);
  if (!canonical) return null;
  return approvedCacheAncestorChain(canonical);
}

async function approvedRefreshCacheRoot(registryFile, { create = false } = {}) {
  const requested = refreshCacheRoot(registryFile);
  if (!requested) return null;
  const parentBoundary = await approvedRefreshCacheParent(requested, { create });
  if (!parentBoundary) return null;
  const securedRequest = path.join(parentBoundary.path, path.basename(requested));
  let created = false;
  if (create) {
    try {
      await mkdir(securedRequest, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
    }
  }
  const rootInfo = await securePrivateCachePath(securedRequest, { directory: true, mode: 0o700 });
  if (!rootInfo) return null;
  const registryBinding = sha256(path.resolve(registryFile));
  const ownerFile = path.join(securedRequest, REFRESH_CACHE_OWNER_FILE);
  if (created) {
    try {
      await writeFile(ownerFile, `${JSON.stringify({
        format: REFRESH_CACHE_OWNER_FORMAT,
        registrySha256: registryBinding,
        createdAt: new Date().toISOString()
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch {
      await rm(securedRequest, { recursive: true, force: true });
      return null;
    }
  }
  const ownerInfo = await securePrivateCachePath(ownerFile, { directory: false, mode: 0o600 });
  if (!ownerInfo) return null;
  const owner = await boundedCacheRecord(ownerFile, 4096);
  if (owner?.format !== REFRESH_CACHE_OWNER_FORMAT
    || owner?.registrySha256 !== registryBinding) return null;
  // Return the canonical directory, rather than requiring textual equality. On macOS `/tmp` is a
  // system alias for `/private/tmp`; ownership and the private marker above establish the boundary.
  const canonicalRoot = await realpath(securedRequest).catch(() => null);
  if (!canonicalRoot || path.dirname(canonicalRoot) !== parentBoundary.path) return null;
  const reboundParent = await approvedCacheAncestorChain(parentBoundary.path);
  if (!reboundParent || reboundParent.dev !== parentBoundary.dev || reboundParent.ino !== parentBoundary.ino) return null;
  return {
    path: canonicalRoot,
    dev: rootInfo.dev,
    ino: rootInfo.ino,
    parent: parentBoundary,
    owner: { path: ownerFile, dev: ownerInfo.dev, ino: ownerInfo.ino },
    registrySha256: registryBinding
  };
}

async function refreshCacheBoundaryCurrent(boundary) {
  if (!boundary?.path) return false;
  const parent = await approvedCacheAncestorChain(boundary.parent?.path);
  if (!parent || parent.dev !== boundary.parent.dev || parent.ino !== boundary.parent.ino) return false;
  const rootInfo = await securePrivateCachePath(boundary.path, { directory: true, mode: 0o700 });
  if (!rootInfo || rootInfo.dev !== boundary.dev || rootInfo.ino !== boundary.ino) return false;
  const ownerInfo = await securePrivateCachePath(boundary.owner?.path, { directory: false, mode: 0o600 });
  if (!ownerInfo || ownerInfo.dev !== boundary.owner.dev || ownerInfo.ino !== boundary.owner.ino) return false;
  const owner = await boundedCacheRecord(boundary.owner.path, 4096);
  return owner?.format === REFRESH_CACHE_OWNER_FORMAT
    && owner?.registrySha256 === boundary.registrySha256;
}

function refreshCacheOwnerAlive(pid) {
  const ownerPid = Number(pid);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    // EPERM proves that a process owns the PID even when this principal cannot signal it.
    return error?.code === 'EPERM';
  }
}

function refreshCacheLockIdentity(record, info) {
  const token = /^[A-Za-z0-9-]{20,80}$/.test(String(record?.token ?? ''))
    ? record.token : null;
  return token ?? sha256(JSON.stringify({
    dev: String(info?.dev ?? ''), ino: String(info?.ino ?? ''),
    birthtimeMs: Number(info?.birthtimeMs ?? 0), mtimeMs: Number(info?.mtimeMs ?? 0)
  })).slice(0, 32);
}

async function refreshCacheLockState(boundary, lock) {
  if (!(await refreshCacheBoundaryCurrent(boundary))) return null;
  const info = await securePrivateCachePath(lock, { directory: true, mode: 0o700 });
  if (!info || await realpath(lock).catch(() => null) !== lock) return null;
  const record = await boundedCacheRecord(path.join(lock, REFRESH_CACHE_LOCK_FILE), 4096);
  const acquiredAt = record?.format === REFRESH_CACHE_LOCK_FORMAT
    ? Date.parse(record.acquiredAt) : Number.NaN;
  const ageBasis = Number.isFinite(acquiredAt) ? acquiredAt : info.mtimeMs;
  const oldEnough = Number.isFinite(ageBasis)
    && Date.now() - ageBasis >= REFRESH_CACHE_LOCK_STALE_MS;
  return {
    info,
    record,
    stale: oldEnough && !refreshCacheOwnerAlive(record?.pid),
    identity: refreshCacheLockIdentity(record, info)
  };
}

/**
 * Move one proven-dead lock out of the acquisition pathname.
 *
 * The tombstone name is deterministic for the old lock identity and intentionally remains in the
 * private cache. Two reclaimers that inspected the same stale inode therefore race to the same
 * destination: only one can move it, and a paused loser can never rename a newly acquired live lock
 * after the winner frees `.operation-lock`. Each crashed owner leaves at most one tiny tombstone.
 */
async function reclaimStaleRefreshCacheLock(boundary, lock) {
  const state = await refreshCacheLockState(boundary, lock);
  if (!state?.stale) return false;
  const tombstone = path.join(boundary.path, `.operation-lock-reclaimed-${state.identity}`);
  try {
    await rename(lock, tombstone);
  } catch {
    return false;
  }
  const moved = await lstat(tombstone).catch(() => null);
  // `rename` moved one directory atomically. Retain rather than delete even on an unexpected inode
  // mismatch: deleting an object we did not inspect would violate the cache's fail-closed boundary.
  return Boolean(moved?.isDirectory() && !moved.isSymbolicLink()
    && moved.dev === state.info.dev && moved.ino === state.info.ino);
}

async function acquireRefreshCacheLock(boundary) {
  const lock = path.join(boundary.path, '.operation-lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await refreshCacheBoundaryCurrent(boundary))) return null;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0
        || !(await reclaimStaleRefreshCacheLock(boundary, lock))) return null;
      continue;
    }
    const owner = {
      format: REFRESH_CACHE_LOCK_FORMAT,
      pid: process.pid,
      processStartedAt: REFRESH_CACHE_PROCESS_STARTED_AT,
      processToken: REFRESH_CACHE_PROCESS_TOKEN,
      token: randomUUID(),
      acquiredAt: new Date().toISOString()
    };
    try {
      await writeFile(path.join(lock, REFRESH_CACHE_LOCK_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
        flag: 'wx', mode: 0o600
      });
      const state = await refreshCacheLockState(boundary, lock);
      if (state?.record?.token !== owner.token || state.record?.pid !== owner.pid) throw new Error('lock receipt changed');
      return { path: lock, owner };
    } catch {
      const current = await boundedCacheRecord(path.join(lock, REFRESH_CACHE_LOCK_FILE), 4096);
      if (!current || current.token === owner.token) await rm(lock, { recursive: true, force: true });
      return null;
    }
  }
  return null;
}

async function releaseRefreshCacheLock(lease) {
  if (!lease) return;
  const current = await boundedCacheRecord(path.join(lease.path, REFRESH_CACHE_LOCK_FILE), 4096);
  // Never remove a successor's lease if the pathname was replaced while the action was running.
  if (current?.token === lease.owner.token && current?.processToken === lease.owner.processToken) {
    await rm(lease.path, { recursive: true, force: true });
  }
}

async function withRefreshCacheLock(boundary, action) {
  const lease = await acquireRefreshCacheLock(boundary);
  if (!lease) return null;
  try {
    if (!(await refreshCacheBoundaryCurrent(boundary))) return null;
    return await action(boundary.path);
  }
  finally { await releaseRefreshCacheLock(lease); }
}

async function maintainRefreshPlanCache(base, now = Date.now()) {
  const claims = path.join(base, '.claims');
  const claimsInfo = await lstat(claims).catch(() => null);
  if (claimsInfo?.isDirectory() && !claimsInfo.isSymbolicLink()
    && await realpath(claims).catch(() => null) === claims) {
    for (const entry of await readdir(claims, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || !/^\.claim-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      const directory = path.join(claims, entry.name);
      const info = await lstat(directory).catch(() => null);
      const record = await boundedCacheRecord(path.join(directory, REFRESH_CACHE_CLAIM_FILE), 4096);
      const claimedAt = record?.format === REFRESH_CACHE_CLAIM_FORMAT
        ? Date.parse(record.claimedAt) : Number.NaN;
      const pid = Number(record?.pid);
      let alive = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; }
        catch (error) { alive = error?.code === 'EPERM'; }
      }
      const ageBasis = Number.isFinite(claimedAt) ? claimedAt : info?.mtimeMs;
      if (!alive && Number.isFinite(ageBasis) && now - ageBasis > REFRESH_CACHE_MAX_AGE_MS) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  const retained = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || !/^cfgp-[a-f0-9]{24}$/.test(entry.name)) continue;
    const directory = path.join(base, entry.name);
    const record = await boundedCacheRecord(path.join(directory, 'plan.json'));
    const createdAt = record?.format === REFRESH_CACHE_FORMAT && record?.planId === entry.name
      ? Date.parse(record.createdAt) : Number.NaN;
    if (!Number.isFinite(createdAt) || now - createdAt > REFRESH_CACHE_MAX_AGE_MS) {
      // This directory is beneath the private cache root, has an exact generated plan name, and is
      // either malformed or past its documented reuse window. It is never authority or user data.
      await rm(directory, { recursive: true, force: true });
    } else {
      retained.push({ directory, createdAt });
    }
  }
  retained.sort((left, right) => right.createdAt - left.createdAt);
  await Promise.all(retained.slice(REFRESH_CACHE_MAX_PLANS)
    .map((entry) => rm(entry.directory, { recursive: true, force: true })));
}

async function readRefreshPlanCache(registryFile, planId) {
  if (!/^cfgp-[a-f0-9]{24}$/.test(String(planId ?? ''))) return null;
  const boundary = await approvedRefreshCacheRoot(registryFile);
  if (!boundary) return null;
  const base = boundary.path;
  const directory = path.join(base, planId);
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return null;
  try {
    const record = await boundedCacheRecord(path.join(directory, 'plan.json'));
    if (record?.format !== REFRESH_CACHE_FORMAT || record?.planId !== planId
      || !Array.isArray(record.repositories)
      || !Number.isFinite(Date.parse(record.createdAt))
      || Date.now() - Date.parse(record.createdAt) > REFRESH_CACHE_MAX_AGE_MS) return null;
    const repositories = new Map();
    for (const entry of record.repositories) {
      const operationalRemote = assertCredentialFreeRemote(entry?.remote);
      if (operationalRemote !== entry.remote
        || entry.remoteFingerprint !== remoteFingerprint(operationalRemote)
        || repositories.has(operationalRemote)) return null;
      repositories.set(operationalRemote, entry);
    }
    return { base, boundary, directory, repositories };
  } catch {
    return null;
  }
}

/**
 * Retain the already-validated shallow clone between UI preview and apply.
 *
 * This is an untrusted, disposable acceleration cache, never authority. Apply re-observes the
 * exact configuration and state SHAs, recomputes the complete plan ID, and force-with-lease binds
 * publication to those SHAs before any cached object can affect a remote ref.
 */
async function retainRefreshPlanCache(registryFile, planId, candidates) {
  const boundary = await approvedRefreshCacheRoot(registryFile, { create: true });
  if (!boundary) return false;
  const env = isolatedCacheGitEnvironment();
  return await withRefreshCacheLock(boundary, async (base) => {
    await maintainRefreshPlanCache(base);
    const existing = path.join(base, planId);
    const existingInfo = await lstat(existing).catch(() => null);
    if (existingInfo) return existingInfo.isDirectory() && !existingInfo.isSymbolicLink();
    const staging = await mkdtemp(path.join(base, `.${planId}-`));
    const repositories = [];
    try {
      await mkdir(path.join(staging, 'repositories'), { mode: 0o700 });
      for (const candidate of candidates.filter((entry) => entry?.root && entry.sourceCommit)) {
        const key = refreshCacheRepositoryKey(candidate.repository.remote);
        const destination = path.join(staging, 'repositories', key);
        // Clone from the local object database so preview's uncommitted candidate bytes are not
        // retained as authority. This is local I/O: no second remote clone or credential exchange.
        const cacheStateRef = 'refs/heads/sflow-cache-state';
        const retainedState = candidate.stateBefore.stateCommit
          ? installExactRefreshRef(candidate.root, cacheStateRef,
            candidate.stateBefore.stateCommit, { env })
          : null;
        try {
          run('git', [
            'clone', '--quiet', '--no-hardlinks', '--branch', CONFIGURATION_BRANCH,
            candidate.root, destination
          ], { env });
        } finally {
          // Do not delete a same-object ref that predated this optional retention operation.
          if (retainedState?.created) {
            removeExactRefreshRef(candidate.root, cacheStateRef,
              candidate.stateBefore.stateCommit, { env });
          }
        }
        if (candidate.stateBefore.stateCommit) {
          installExactRefreshRef(destination, cacheStateRef,
            candidate.stateBefore.stateCommit, { env });
        }
        // The operational URL is credential-free but otherwise byte-for-byte exact. A display-safe
        // URL is not transport authority: local and SCP-like paths may legitimately contain `?` or
        // `#`, for which diagnostic redaction would name a different repository.
        run('git', ['remote', 'set-url', 'origin', candidate.repository.remote], {
          cwd: destination, env
        });
        repositories.push({
          key,
          remote: candidate.repository.remote,
          remoteFingerprint: remoteFingerprint(candidate.repository.remote),
          configurationCommit: candidate.sourceCommit,
          stateBranch: candidate.desired.stateConfig.branch,
          stateCommit: candidate.stateBefore.stateCommit,
          productRevision: candidate.refresh.product.revision
        });
      }
      await writeAtomic(path.join(staging, 'plan.json'), `${JSON.stringify({
        // Schema-transient: this cache is optional and authority is revalidated before reuse.
        format: REFRESH_CACHE_FORMAT,
        planId,
        createdAt: new Date().toISOString(),
        repositories
      }, null, 2)}\n`);
      try {
        await rename(staging, existing);
        return true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
        return true;
      }
    } catch {
      return false;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }) ?? false;
}

async function hardenClaimedRefreshCheckout(root, { env = isolatedCacheGitEnvironment() } = {}) {
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) return false;
  const gitPath = path.join(canonicalRoot, '.git');
  const gitInfo = await lstat(gitPath).catch(() => null);
  if (!gitInfo?.isDirectory() || gitInfo.isSymbolicLink()) return false;
  const canonicalGit = await realpath(gitPath).catch(() => null);
  if (canonicalGit !== gitPath) return false;
  // A retained checkout is always an ordinary clone with its own complete .git directory. Git's
  // `commondir` indirection is valid for linked worktrees, but it has no legitimate place here and
  // can redirect objects, repository config and hooks outside this private disposable cache.
  // Refuse it before invoking Git at all; merely rewriting .git/config would otherwise rewrite the
  // wrong (per-worktree) file while Git continued to trust the external common directory.
  if (await lstat(path.join(gitPath, 'commondir')).catch(() => null)) return false;
  for (const name of ['objects', 'refs', 'info']) {
    const info = await lstat(path.join(gitPath, name)).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
    if (await realpath(path.join(gitPath, name)).catch(() => null) !== path.join(gitPath, name)) return false;
  }
  if (await lstat(path.join(gitPath, 'objects/info/alternates')).catch(() => null)) return false;
  const configFile = path.join(gitPath, 'config');
  const configInfo = await lstat(configFile).catch(() => null);
  if (!configInfo?.isFile() || configInfo.isSymbolicLink() || configInfo.size > 64 * 1024) return false;
  const previous = await readFile(configFile, 'utf8').catch(() => '');
  const objectFormat = previous.match(/^\s*objectformat\s*=\s*(sha1|sha256)\s*$/im)?.[1] ?? 'sha1';
  const fileMode = previous.match(/^\s*filemode\s*=\s*(true|false)\s*$/im)?.[1] ?? 'true';
  const ignoreCase = previous.match(/^\s*ignorecase\s*=\s*(true|false)\s*$/im)?.[1] ?? 'false';
  // Treat the cache as an object bag only. All mutable repository metadata is rebuilt after the
  // claim so replacement refs, grafts, index flags, ignore rules and reflogs cannot change the
  // meaning or visible bytes of the exact remote commit observed for this apply.
  await rm(path.join(gitPath, 'refs'), { recursive: true, force: true });
  await mkdir(path.join(gitPath, 'refs/heads'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(gitPath, 'refs/remotes'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(gitPath, 'refs/tags'), { recursive: true, mode: 0o700 });
  await rm(path.join(gitPath, 'packed-refs'), { force: true });
  await rm(path.join(gitPath, 'logs'), { recursive: true, force: true });
  await rm(path.join(gitPath, 'index'), { force: true });
  await rm(path.join(gitPath, 'index.lock'), { force: true });
  await rm(path.join(gitPath, 'info/grafts'), { force: true });
  await writeAtomic(path.join(gitPath, 'info/exclude'), '');
  await writeAtomic(path.join(gitPath, 'info/attributes'), '');
  await rm(path.join(gitPath, 'sflow-empty-hooks'), { recursive: true, force: true });
  await mkdir(path.join(gitPath, 'sflow-empty-hooks'), { mode: 0o700 });
  await writeAtomic(configFile, [
    '[core]',
    `\trepositoryformatversion = ${objectFormat === 'sha256' ? '1' : '0'}`,
    `\tfilemode = ${fileMode}`,
    '\tbare = false',
    '\tlogallrefupdates = true',
    `\tignorecase = ${ignoreCase}`,
    '\tfsmonitor = false',
    '\thooksPath = .git/sflow-empty-hooks',
    ...(objectFormat === 'sha256' ? ['[extensions]', '\tobjectFormat = sha256'] : []),
    '[remote "origin"]',
    '\turl = invalid://untrusted-cache',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    `[branch "${CONFIGURATION_BRANCH}"]`,
    '\tremote = origin',
    `\tmerge = refs/heads/${CONFIGURATION_BRANCH}`,
    ''
  ].join('\n'));
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: canonicalRoot, env, allowFailure: true
  });
  if (common.status !== 0) return false;
  const canonicalCommon = await realpath(common.stdout.trim()).catch(() => null);
  if (canonicalCommon !== canonicalGit) return false;
  return true;
}

async function claimRefreshPlanRoot(cache, entry, { env = isolatedCacheGitEnvironment() } = {}) {
  if (!cache || !entry?.key || !/^[a-f0-9]{32}$/.test(entry.key)) return null;
  try {
    const claimed = await withRefreshCacheLock(cache.boundary, async () => {
      const repositoriesRoot = path.join(cache.directory, 'repositories');
      const repositoriesInfo = await lstat(repositoriesRoot).catch(() => null);
      if (!repositoriesInfo?.isDirectory() || repositoriesInfo.isSymbolicLink()) return null;
      if (await realpath(repositoriesRoot).catch(() => null) !== repositoriesRoot) return null;
      const repositoryRoot = path.join(repositoriesRoot, entry.key);
      const info = await lstat(repositoryRoot).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) return null;
      if (await realpath(repositoryRoot).catch(() => null) !== repositoryRoot) return null;
      const claims = path.join(cache.base, '.claims');
      await mkdir(claims, { recursive: true, mode: 0o700 });
      const claimsInfo = await lstat(claims);
      if (!claimsInfo.isDirectory() || claimsInfo.isSymbolicLink()) return null;
      if (await realpath(claims).catch(() => null) !== claims) return null;
      const claim = await mkdtemp(path.join(claims, '.claim-'));
      await rm(claim, { recursive: true, force: true });
      try {
        await rename(repositoryRoot, claim);
        await writeAtomic(path.join(claim, REFRESH_CACHE_CLAIM_FILE), `${JSON.stringify({
          format: REFRESH_CACHE_CLAIM_FORMAT,
          claimedAt: new Date().toISOString(),
          pid: process.pid
        }, null, 2)}\n`);
        return claim;
      } catch {
        await rm(claim, { recursive: true, force: true });
        return null;
      }
    });
    if (!claimed) return null;
    if (!(await hardenClaimedRefreshCheckout(claimed, { env }))) {
      await rm(claimed, { recursive: true, force: true });
      return null;
    }
    return claimed;
  } catch {
    return null;
  }
}

/**
 * Isolate confirmed-refresh Git metadata without discarding enterprise transport and auth.
 *
 * Only effective system/global proxy, CA and credential-helper controls are copied into a fresh
 * command-scoped configuration. Values remain private child-process environment bytes: they are
 * never returned in refresh results, cache records, diagnostics, timing labels, or repository
 * files. Exported so the transport boundary can be exercised without contacting a real provider.
 */
export function isolatedCacheGitEnvironment(sourceEnv = process.env, { runCommand = run } = {}) {
  return enterpriseGitEnvironment(sourceEnv, { runCommand });
}

function stateConfiguration(approved) {
  return {
    ...(approved.ledger ?? {}),
    enabled: true,
    remote: 'origin',
    branch: approved.ledger?.branch ?? 'state'
  };
}

function assertDedicatedStateAuthority(repository, desired) {
  const branch = String(desired?.stateConfig?.branch ?? '').trim();
  const reserved = new Set([CONFIGURATION_BRANCH, String(repository.defaultBranch ?? '').trim()]);
  const configurationNamespace = branch.startsWith('sflow/config-refresh/')
    || branch.startsWith('sflow/config-history/');
  if (!branch || reserved.has(branch) || configurationNamespace) {
    throw new SingularityFlowError(
      `Configuration state branch '${branch || '(empty)'}' is not a dedicated state authority. It would overlap the application or configuration ref and is refused before preview or publication.`, {
        code: 'CONFIGURATION_STATE_BRANCH_UNSAFE',
        details: {
          branch: branch || null,
          applicationBranch: repository.defaultBranch,
          configurationBranch: CONFIGURATION_BRANCH,
          preserved: ['application-branches', 'configuration-authority', 'state-authority']
        }
      }
    );
  }
}

function assertExistingStateAuthority(root, repository, desired, stateCommit, {
  env = process.env
} = {}) {
  if (!stateCommit) return;
  const fail = (reason) => {
    throw new SingularityFlowError(
      `Configured branch '${desired.stateConfig.branch}' is not a proven dedicated Singularity Flow state authority: ${reason}. No branch was changed.`, {
        code: 'CONFIGURATION_STATE_AUTHORITY_UNPROVEN',
        details: {
          branch: desired.stateConfig.branch,
          commit: stateCommit,
          applicationBranch: repository.defaultBranch,
          preserved: ['application-branches', 'configuration-authority', 'state-authority']
        }
      }
    );
  };
  const roots = run('git', ['rev-list', '--max-parents=0', stateCommit], {
    cwd: root, env, allowFailure: true, maxBuffer: 64 * 1024, timeoutMs: 10_000
  });
  const rootCommits = roots.status === 0
    ? roots.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean) : [];
  if (rootCommits.length !== 1) fail('its complete history does not have one orphan root');
  const merges = run('git', ['rev-list', '--min-parents=2', stateCommit], {
    cwd: root, env, allowFailure: true, maxBuffer: 1024, timeoutMs: 10_000
  });
  if (merges.status !== 0 || merges.stdout.trim()) fail('its history is not linear');
  const rootCommit = rootCommits[0];
  const paths = run('git', ['ls-tree', '-r', '--name-only', rootCommit], {
    cwd: root, env, allowFailure: true, maxBuffer: 4096, timeoutMs: 5_000
  });
  const rootPaths = paths.status === 0
    ? paths.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).sort() : [];
  if (!equal(rootPaths, ['README.md', 'ledger/head.json'])) {
    fail('its orphan root is not the canonical ledger root');
  }
  const readme = run('git', ['show', `${rootCommit}:README.md`], {
    cwd: root, env, allowFailure: true, maxBuffer: 4096, timeoutMs: 5_000
  });
  if (readme.status !== 0 || !readme.stdout.startsWith('# Singularity Flow Capability Ledger\n')) {
    fail('its orphan root has no canonical ledger marker');
  }
  const head = run('git', ['show', `${rootCommit}:ledger/head.json`], {
    cwd: root, env, allowFailure: true, maxBuffer: 4096, timeoutMs: 5_000
  });
  let initialHead = null;
  try { initialHead = JSON.parse(head.stdout); } catch { /* handled below */ }
  if (head.status !== 0 || initialHead?.sequence !== 0 || initialHead?.entryHash !== null
      || initialHead?.previousHeadHash !== null || !Number.isSafeInteger(initialHead?.schemaVersion)) {
    fail('its orphan root has no valid initial ledger head');
  }
}

function stateTree(root, ref, policy, { env = process.env } = {}) {
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', ref, '--',
    'configuration', ...configurationAssetSearchRoots(policy)
  ], { cwd: root, env });
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return {
      mode: line.slice(0, first),
      oid: line.slice(first + 1, second),
      file: line.slice(second + 1)
    };
  });
  if (!entries.length) return new Map();
  const batch = run('git', ['cat-file', '--batch'], {
    cwd: root, env, encoding: 'buffer', input: `${entries.map((entry) => entry.oid).join('\n')}\n`
  });
  const output = new Map();
  let cursor = 0;
  for (const entry of entries) {
    const newline = batch.stdout.indexOf(0x0a, cursor);
    if (newline < 0) throw new SingularityFlowError(`State configuration object '${entry.file}' was truncated.`);
    const header = batch.stdout.toString('utf8', cursor, newline).trim().split(' ');
    const size = Number(header[2]);
    if (header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new SingularityFlowError(`State configuration path '${entry.file}' is not a readable file.`);
    }
    const start = newline + 1;
    const end = start + size;
    if (end > batch.stdout.length) {
      throw new SingularityFlowError(`State configuration object '${entry.file}' was truncated.`);
    }
    output.set(entry.file, {
      mode: entry.mode,
      object: entry.oid,
      contents: batch.stdout.subarray(start, end)
    });
    cursor = end + 1;
  }
  return output;
}

async function fetchStateRefAsync(root, config, { env = process.env } = {}) {
  const remoteRef = `refs/remotes/${config.remote}/${config.branch}`;
  const before = observeExactRefreshRef(root, remoteRef, { env });
  if (before.status === 'symbolic' || before.status === 'unavailable') {
    throw refreshRefError(remoteRef, before.status, 'refresh');
  }
  // Prove the remote source is itself one exact direct branch. `git fetch` dereferences symbolic
  // source refs, so validating only FETCH_HEAD would make an alias indistinguishable from direct
  // authority when a preview cache is unavailable and apply has to reconstruct its checkout.
  const authority = configuredRemoteAuthority(root, config.remote, { direction: 'fetch', env });
  if (!authority.url) throw refreshRefError(remoteRef, 'unavailable', 'resolve remote authority for');
  const sourceHeads = await remoteHeads(authority.url, [config.branch], { env, cwd: root });
  const expectedSourceCommit = sourceHeads.get(config.branch) ?? null;
  if (expectedSourceCommit == null) return null;

  // Fetch into FETCH_HEAD only. A configured refspec must not mutate the tracking ref before the
  // refresh owner applies its independently observed expected-object lease.
  const transport = frozenRemoteTransport(authority.url, { env });
  const fetched = await runRemoteGitAsync([
    'fetch', '--no-tags', '--refmap=', transport.remote, `refs/heads/${config.branch}`
  ], { cwd: root, operation: 'remote-configuration', env: transport.env });
  if (fetched.status !== 0) return null;
  const fetchedCommit = run('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], {
    cwd: root, env, allowFailure: true, maxBuffer: 1024, timeoutMs: 5_000
  }).stdout.trim();
  if (!EXACT_GIT_OID.test(fetchedCommit) || fetchedCommit !== expectedSourceCommit) {
    throw new SingularityFlowError(
      'Configuration refresh state authority changed after its exact direct-ref observation.', {
        code: 'CONFIGURATION_REFRESH_STATE_AUTHORITY_CHANGED',
        details: {
          ref: remoteRef,
          expectedCommit: expectedSourceCommit,
          observedCommit: EXACT_GIT_OID.test(fetchedCommit) ? fetchedCommit : null
        }
      }
    );
  }
  installExactRefreshRef(root, remoteRef, fetchedCommit, {
    env, expectedCommit: before.commit
  });
  return fetchedCommit;
}

async function desiredStateProjection(root, { env = process.env } = {}) {
  const policy = await configurationAssetPolicyFromDirectory(root);
  const paths = await configurationAssetPaths(root, policy);
  const files = {};
  const hashes = {};
  const assets = {};
  const canonicalAssets = await canonicalConfigurationAssets(root, paths, { env });
  for (const relative of paths) {
    const asset = canonicalAssets.get(relative);
    files[relative] = asset.contents;
    hashes[relative] = asset.sha256;
    assets[relative] = { sha256: asset.sha256, object: asset.object, mode: asset.mode };
  }
  const approved = YAML.parse(await readFile(path.join(root, WORKFLOW_PATH), 'utf8'));
  return {
    paths,
    files,
    hashes: Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))),
    assets: Object.fromEntries(Object.entries(assets).sort(([left], [right]) => left.localeCompare(right))),
    approved,
    policy,
    stateConfig: stateConfiguration(approved)
  };
}

function observeStateProjection(root, desired, sourceCommit, product, {
  stateCommit,
  env = process.env
} = {}) {
  // Remote observation is deliberately not hidden inside this deterministic projection reader.
  // Callers fetch through `fetchStateRefAsync` first and supply the exact observed commit (including
  // null for a missing branch), keeping every remote operation behind the process-tree supervisor.
  if (!stateCommit) {
    return {
      status: 'missing', stateCommit: null, changed: true,
      missingPaths: desired.paths, changedPaths: [], extraPaths: [], legacyPaths: [], manifest: null
    };
  }
  // Search both the incoming policy and the policy currently mirrored on state. A configuration
  // upgrade can move templates or agents from one custom root to another; looking only under the
  // new roots would declare the projection current while silently leaving the retired root behind.
  let statePolicy = desired.policy;
  try {
    statePolicy = mergeConfigurationAssetPolicies(
      desired.policy,
      configurationAssetPolicyFromRef(root, stateCommit, { env })
    );
  } catch {
    // A malformed old state workflow is repairable. The valid incoming policy remains authoritative,
    // and manifest/source mismatch below forces replacement instead of making refresh unrecoverable.
  }
  const tree = stateTree(root, stateCommit, statePolicy, { env });
  const paths = [...tree.keys()].sort();
  const canonical = paths.filter((relative) => isConfigurationAsset(relative, statePolicy));
  const desiredSet = new Set(desired.paths);
  const missingPaths = desired.paths.filter((relative) => !canonical.includes(relative));
  const changedPaths = desired.paths.filter((relative) => {
    const entry = tree.get(relative);
    const expected = desired.assets[relative];
    return entry != null && (sha256(entry.contents) !== expected.sha256
      || entry.object !== expected.object || entry.mode !== expected.mode);
  });
  const extraPaths = canonical.filter((relative) => !desiredSet.has(relative));
  const legacyPaths = paths.filter((relative) => relative.startsWith(`${STATE_CONFIGURATION_ROOT}/files/`));
  let manifest = null;
  const manifestEntry = tree.get(STATE_CONFIGURATION_MANIFEST);
  if (manifestEntry) {
    try { manifest = JSON.parse(manifestEntry.contents.toString('utf8')); }
    catch { manifest = null; }
  }
  const manifestCurrent = manifest?.format === MIRROR_FORMAT
    && manifest?.layout === 'canonical-paths'
    && manifest?.source?.branch === CONFIGURATION_BRANCH
    && manifest?.source?.commit === sourceCommit
    && equal(manifest?.history ?? null, {
      branch: stateConfigurationHistoryBranch(sourceCommit), commit: sourceCommit
    })
    && manifest?.product?.revision === product.revision
    && equal(manifest?.files ?? {}, desired.hashes)
    && equal(manifest?.assets ?? {}, desired.assets);
  const changed = !manifestCurrent || missingPaths.length > 0 || changedPaths.length > 0
    || extraPaths.length > 0 || legacyPaths.length > 0;
  return {
    status: changed ? 'stale' : 'current', stateCommit, changed,
    missingPaths, changedPaths, extraPaths, legacyPaths, manifest
  };
}

async function observeFreshStateProjection(root, desired, sourceCommit, product, {
  env = process.env
} = {}) {
  const stateCommit = await fetchStateRefAsync(root, desired.stateConfig, { env });
  return observeStateProjection(root, desired, sourceCommit, product, { stateCommit, env });
}

function workspaceMatches(entry, reference) {
  if (!reference) return true;
  const raw = String(reference).trim();
  const requested = raw.toLocaleLowerCase('en-US');
  if ([entry.id, entry.name, entry.anchorKey]
    .some((value) => String(value ?? '').toLocaleLowerCase('en-US') === requested)) return true;
  return path.resolve(entry.path) === path.resolve(raw);
}

async function registeredRepositories(registryFile, { workspace = null, repositories = [] } = {}) {
  const entries = (await readWorkspaceRegistry(registryFile)).filter((entry) => !entry.archivedAt);
  const selectedEntries = entries.filter((entry) => workspaceMatches(entry, workspace));
  if (workspace && !selectedEntries.length) {
    throw new SingularityFlowError(`Workspace '${workspace}' is not registered.`);
  }
  const requestedRepositories = new Set((repositories ?? []).map((value) => String(value).trim()).filter(Boolean));
  const manifests = await Promise.all(entries.map(async (entry) => ({
    entry,
    manifest: await readWorkspace(entry.path)
  })));
  const selectedWorkspaceIds = new Set(selectedEntries.map((entry) => entry.id));
  const selected = [];
  for (const { entry, manifest } of manifests) {
    if (!selectedWorkspaceIds.has(entry.id)) continue;
    for (const repository of Object.values(manifest.repositories)
      .sort((left, right) => left.id.localeCompare(right.id))) {
      if (requestedRepositories.size && !requestedRepositories.has(repository.id)) continue;
      const operationalRemote = assertCredentialFreeRemote(repository.url);
      selected.push({ entry, manifest, repository, operationalRemote,
        identity: await resolvedGitRepositoryComparisonKey(operationalRemote)
          ?? `literal:${operationalRemote}` });
    }
  }
  if (requestedRepositories.size) {
    const found = new Set(selected.map(({ repository }) => repository.id));
    const missing = [...requestedRepositories].filter((id) => !found.has(id));
    if (missing.length) {
      throw new SingularityFlowError(`Registered workspaces do not contain repository IDs: ${missing.join(', ')}.`);
    }
  }

  // A repository authority is machine-global even when the operator refreshes one workspace.
  // Scan every active workspace binding for each selected repository identity before any network
  // access. Otherwise selecting workspace A could ignore workspace B's conflicting default branch
  // and publish a shared sflow/config authority from the wrong source. Transport spelling (HTTPS,
  // SSH/SCP, optional .git, or a default port) does not create a separate repository identity.
  const selectedIdentities = new Set(selected.map(({ identity }) => identity));
  const authorityBranches = new Map();
  for (const { manifest } of manifests) {
    for (const repository of Object.values(manifest.repositories)) {
      const operationalRemote = assertCredentialFreeRemote(repository.url);
      const identity = await resolvedGitRepositoryComparisonKey(operationalRemote)
        ?? `literal:${operationalRemote}`;
      if (!selectedIdentities.has(identity)) continue;
      const membership = { workspaceId: manifest.id, workspaceName: manifest.name,
        repositoryId: repository.id };
      const existing = authorityBranches.get(identity);
      if (existing && existing.defaultBranch !== repository.defaultBranch) {
        throw new SingularityFlowError(
          `Registered workspaces bind '${sanitizeRemote(existing.remote)}' to conflicting default branches '${existing.defaultBranch}' and '${repository.defaultBranch}'. Reconcile the workspace definitions before refreshing configuration.`, {
            code: 'WORKSPACE_REPOSITORY_AUTHORITY_CONFLICT',
            details: {
              remote: sanitizeRemote(existing.remote),
              branches: [existing.defaultBranch, repository.defaultBranch],
              repositoryIds: [...new Set([
                ...existing.memberships.map((item) => item.repositoryId), repository.id
              ])]
            }
          }
        );
      }
      if (existing) existing.memberships.push(membership);
      else authorityBranches.set(identity, {
        remote: operationalRemote,
        defaultBranch: repository.defaultBranch,
        memberships: [membership]
      });
    }
  }

  const unique = new Map();
  for (const { manifest, repository, operationalRemote, identity } of selected) {
      const displayRemote = sanitizeRemote(operationalRemote);
      const existing = unique.get(identity);
      const membership = { workspaceId: manifest.id, workspaceName: manifest.name, repositoryId: repository.id };
      if (existing) {
        existing.memberships.push(membership);
        existing.localPaths.push(workspaceRepositoryPath(manifest, repository));
        continue;
      }
      unique.set(identity, {
        id: repository.id,
        remote: operationalRemote,
        remoteFingerprint: remoteFingerprint(operationalRemote),
        displayRemote,
        defaultBranch: repository.defaultBranch,
        localPath: workspaceRepositoryPath(manifest, repository),
        localPaths: [workspaceRepositoryPath(manifest, repository)],
        memberships: [membership]
      });
  }
  return [...unique.values()].sort((left, right) =>
    left.displayRemote.localeCompare(right.displayRemote)
      || left.remote.localeCompare(right.remote));
}

async function prepareCandidate(repository, options, { env = process.env } = {}) {
  const cloned = await cloneConfiguration(repository.remote, { env });
  const { root } = cloned;
  const gitEnv = cloned.env;
  try {
    const sourceRef = observeExactRefreshRef(root, `refs/heads/${CONFIGURATION_BRANCH}`, {
      env: gitEnv
    });
    if (sourceRef.status !== 'direct') {
      throw refreshRefError(`refs/heads/${CONFIGURATION_BRANCH}`, sourceRef.status, 'read');
    }
    const sourceCommit = sourceRef.commit;
    const refresh = await refreshPackagedConfiguration(root, options);
    const desired = await desiredStateProjection(root, { env: gitEnv });
    assertDedicatedStateAuthority(repository, desired);
    const stateCommit = await fetchStateRefAsync(root, desired.stateConfig, { env: gitEnv });
    assertExistingStateAuthority(root, repository, desired, stateCommit, { env: gitEnv });
    const stateBefore = observeStateProjection(root, desired, sourceCommit, refresh.product, {
      stateCommit, env: gitEnv
    });
    return { repository, root, sourceCommit, refresh, desired, stateBefore, gitEnv };
  } catch (error) {
    await removeTemporaryTree(root);
    throw error;
  }
}

async function prepareCachedCandidate(observation, cache, options, { env = isolatedCacheGitEnvironment() } = {}) {
  const entry = cache?.repositories.get(observation.repository.remote);
  if (!entry
    || entry.remoteFingerprint !== observation.repository.remoteFingerprint
    || entry.configurationCommit !== observation.commit
    || entry.stateCommit !== observation.stateCommit
    || entry.productRevision !== productIdentity().revision) return null;
  const root = await claimRefreshPlanRoot(cache, entry, { env });
  if (!root) return null;
  try {
    // Git normally trusts the pathname of a loose object. A strict fsck is therefore mandatory:
    // without it, replacing the bytes stored at an approved SHA can make cat-file/reset consume a
    // different commit while rev-parse still prints the approved name.
    const objectCheck = run('git', [
      'fsck', '--strict', '--no-reflogs', '--full', '--no-progress',
      entry.configurationCommit, ...(entry.stateCommit ? [entry.stateCommit] : [])
    ], { cwd: root, env, allowFailure: true });
    if (objectCheck.status !== 0) throw new Error('cached Git objects failed strict verification');
    const available = run('git', ['cat-file', '-e', `${entry.configurationCommit}^{commit}`], {
      cwd: root, env, allowFailure: true
    });
    if (available.status !== 0) throw new Error('cached configuration commit is unavailable');
    // The cache supplies objects only. Reconstruct both the branch/index and every tracked byte from
    // the exact re-observed commit after replacing untrusted repository config. This clears hidden
    // assume-unchanged/skip-worktree state and refuses any untracked cache modification.
    const configurationRef = `refs/heads/${CONFIGURATION_BRANCH}`;
    installExactRefreshRef(root, configurationRef, entry.configurationCommit, { env });
    run('git', ['symbolic-ref', 'HEAD', `refs/heads/${CONFIGURATION_BRANCH}`], { cwd: root, env });
    run('git', ['reset', '--hard', entry.configurationCommit], { cwd: root, env });
    run('git', ['clean', '-ffdx'], { cwd: root, env });
    const sourceCommit = observeExactRefreshRef(root, configurationRef, { env }).commit;
    if (sourceCommit !== entry.configurationCommit) throw new Error('cached configuration commit changed');
    if (run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, env }).stdout.trim()) {
      throw new Error('cached configuration checkout is not clean');
    }
    if (entry.stateCommit) {
      const stateObject = run('git', ['cat-file', '-e', `${entry.stateCommit}^{commit}`], {
        cwd: root, env, allowFailure: true
      });
      if (stateObject.status !== 0) throw new Error('cached state commit is unavailable');
      installExactRefreshRef(root, `refs/remotes/origin/${entry.stateBranch}`,
        entry.stateCommit, { env });
    }
    const transport = frozenRemoteTransport(observation.repository.remote, { push: true, env });
    // The claimed checkout is disposable. Store the private alias, not the operational URL, so
    // every later named-origin transport must carry the invocation-local exact rewrite below.
    run('git', ['remote', 'set-url', 'origin', transport.remote], {
      cwd: root, env: transport.env
    });
    const refresh = await refreshPackagedConfiguration(root, options);
    const desired = await desiredStateProjection(root, { env: transport.env });
    assertDedicatedStateAuthority(observation.repository, desired);
    if (desired.stateConfig.branch !== entry.stateBranch) {
      throw new Error('cached state branch no longer matches approved configuration');
    }
    assertExistingStateAuthority(root, observation.repository, desired, entry.stateCommit, {
      env: transport.env
    });
    const stateBefore = observeStateProjection(root, desired, sourceCommit, refresh.product, {
      stateCommit: entry.stateCommit, env: transport.env
    });
    return {
      repository: observation.repository, root, sourceCommit, refresh, desired, stateBefore,
      reusedPreview: true, gitEnv: transport.env
    };
  } catch {
    await removeTemporaryTree(root);
    return null;
  }
}

async function prepareObservedCandidate(observation, options, cache, { env = process.env } = {}) {
  return await prepareCachedCandidate(observation, cache, options, { env })
    ?? await prepareCandidate(observation.repository, options, { env });
}

function refreshPlanId(candidates, {
  resolutions, acceptBundledConflicts, restorePackagedSeeds = false
}) {
  const identity = {
    repositories: candidates.map((candidate) => ({
      remote: candidate.repository.remote,
      remoteFingerprint: candidate.repository.remoteFingerprint,
      configurationCommit: candidate.sourceCommit,
      bootstrapCommit: candidate.bootstrapCommit ?? null,
      bootstrapCandidateCommit: candidate.bootstrapCandidateCommit ?? null,
      bootstrapCandidateTree: candidate.bootstrapCandidateTree ?? null,
      stateCommit: candidate.stateBefore.stateCommit,
      productRevision: candidate.refresh.product.revision,
      packageContentDigest: candidate.refresh.packageContentDigest ?? null,
      // These are the exact approved-configuration bytes/modes the preview would publish. Binding
      // only source SHAs and explicit per-path resolutions allowed a later apply to toggle the
      // default conflict policy while retaining the same confirmation token.
      configurationAssets: candidate.desired?.assets ?? null,
      changedFiles: [...(candidate.refresh?.files ?? [])].sort(),
      removedFiles: [...(candidate.refresh?.removed ?? [])].sort(),
      conflictDecisions: (candidate.refresh?.conflicts ?? []).map((entry) => ({
        path: entry.path, resolution: entry.resolution
      })).sort((left, right) => left.path.localeCompare(right.path))
    })).sort((left, right) => left.remote.localeCompare(right.remote)),
    policy: {
      acceptBundledConflicts: acceptBundledConflicts === true,
      restorePackagedSeeds: restorePackagedSeeds === true,
      resolutions: canonical(resolutions)
    }
  };
  return `cfgp-${sha256(JSON.stringify(identity)).slice(0, 24)}`;
}

function previewResultForCandidate(candidate, status) {
  return {
    status,
    repository: candidate.repository.id,
    remote: candidate.repository.displayRemote,
    memberships: candidate.repository.memberships,
    configurationCommit: candidate.sourceCommit,
    bootstrapCommit: candidate.bootstrapCommit ?? null,
    bootstrapCandidateCommit: candidate.bootstrapCandidateCommit ?? null,
    bootstrapCandidateTree: candidate.bootstrapCandidateTree ?? null,
    configurationChanged: status === 'would-initialize' || candidate.refresh.changed,
    stateChanged: status === 'would-initialize'
      || candidate.refresh.changed || candidate.stateBefore.changed,
    stateStatus: status === 'would-initialize'
      ? 'would-follow-configuration'
      : candidate.refresh.changed ? 'would-follow-configuration' : candidate.stateBefore.status,
    stateCommit: candidate.stateBefore.stateCommit,
    missingStatePaths: candidate.stateBefore.missingPaths,
    changedStatePaths: candidate.stateBefore.changedPaths,
    extraStatePaths: candidate.stateBefore.extraPaths,
    files: candidate.refresh.files,
    changedFiles: candidate.refresh.files,
    removed: candidate.refresh.removed,
    conflicts: candidate.refresh.conflicts,
    packageContentDigest: candidate.refresh.packageContentDigest,
    configurationPaths: candidate.desired.paths,
    configurationAssets: candidate.desired.assets
  };
}

/**
 * Preserve enough of a failed configuration preflight for an editor to offer a reviewed repair.
 *
 * `refreshPackagedConfiguration` validates the workflow, agents, templates, and prompts as one
 * executable contract. A preserved older agent can therefore make the preview fail before the UI
 * receives the conflict list it needs to repair that agent. Keep the refusal, but return only its
 * bounded configuration conflicts and the packaged agent paths that can be selected for a second
 * preview. No resolution is applied here.
 */
function refreshPreflightFailure(observation, error) {
  const conflicts = Array.isArray(error?.details?.conflicts)
    ? error.details.conflicts.filter((entry) => entry && typeof entry.path === 'string')
    : [];
  const repairPaths = conflicts
    .filter((entry) => entry.path.startsWith('.github/agents/')
      && (entry.resolution === 'preserved-local' || entry.resolution === 'preserved-local-deletion'))
    .map((entry) => entry.path)
    .sort();
  return {
    status: 'blocked',
    repository: observation.repository.id,
    remote: observation.repository.displayRemote,
    memberships: observation.repository.memberships,
    configurationChanged: false,
    stateChanged: false,
    conflicts,
    repair: repairPaths.length ? {
      kind: 'packaged-agents',
      label: 'Restore packaged agents',
      paths: repairPaths
    } : null,
    error: refreshErrorMessage(error) ?? 'Configuration refresh preflight failed.'
  };
}

function proposalBranch(candidateCommit, sourceCommit, product) {
  const revision = String(product.revision).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 16);
  return `sflow/config-refresh/${revision}-${sourceCommit.slice(0, 8)}-${candidateCommit.slice(0, 8)}`;
}

/**
 * Recognize the benign publication race where another refresh pushed the same configuration.
 *
 * Git correctly rejects the second sibling commit as non-fast-forward even when its complete tree
 * is byte-identical. Fetch the new authority tip and compare tree objects; only exact identity may
 * join the winner. A genuinely different remote update still takes the review-branch path.
 */
async function identicalConcurrentConfiguration(root, candidateCommit, { env = process.env } = {}) {
  const fetched = await runRemoteGitAsync([
    'fetch', '--quiet', '--no-tags', '--refmap=', 'origin',
    `refs/heads/${CONFIGURATION_BRANCH}`
  ], { cwd: root, operation: 'remote-configuration', env });
  if (fetched.status !== 0) return null;
  const approvedCommit = run('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], {
    cwd: root, env, allowFailure: true
  }).stdout.trim();
  if (!EXACT_GIT_OID.test(approvedCommit)) return null;
  const candidateTree = run('git', ['rev-parse', `${candidateCommit}^{tree}`], { cwd: root, env }).stdout.trim();
  const approvedTree = run('git', ['rev-parse', `${approvedCommit}^{tree}`], { cwd: root, env }).stdout.trim();
  return candidateTree === approvedTree ? approvedCommit : null;
}

async function publishCandidate(candidate) {
  const { root, repository, refresh, sourceCommit, desired } = candidate;
  const env = candidate.gitEnv ?? process.env;
  let approvedCommit = sourceCommit;
  // A first-authority candidate was already published as the exact previewed commit.  Report that
  // durable mutation without authoring a second refresh commit.
  let configurationChanged = candidate.bootstrapConfigurationCreated === true;
  if (refresh.changed) {
    run('git', ['add', '-A', '--', ...refresh.files], { cwd: root, env });
    const staged = run('git', ['diff', '--cached', '--name-only'], { cwd: root, env }).stdout
      .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (staged.length) {
      const actor = gitCommitIdentity(root, { env });
      run('git', [
        '-c', `user.name=${actor.name || 'Singularity Flow'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'commit', '-m', `[configuration][product:${refresh.product.revision}] refresh packaged configuration`
      ], { cwd: root, env });
      const candidateRef = observeExactRefreshRef(root, `refs/heads/${CONFIGURATION_BRANCH}`, { env });
      if (candidateRef.status !== 'direct') {
        throw refreshRefError(`refs/heads/${CONFIGURATION_BRANCH}`, candidateRef.status, 'read');
      }
      const candidateCommit = candidateRef.commit;
      const pushed = await runRemoteGitAsync([
        'push', `--force-with-lease=refs/heads/${CONFIGURATION_BRANCH}:${sourceCommit}`,
        'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`
      ], {
        cwd: root, operation: 'remote-push', env
      });
      if (pushed.status !== 0) {
        const concurrentCommit = await identicalConcurrentConfiguration(root, candidateCommit, { env });
        if (concurrentCommit) {
          approvedCommit = concurrentCommit;
          configurationChanged = true;
        } else {
          const branch = proposalBranch(candidateCommit, sourceCommit, refresh.product);
          const retained = await runRemoteGitAsync([
            'push', `--force-with-lease=refs/heads/${branch}:`,
            'origin', `HEAD:refs/heads/${branch}`
          ], {
            cwd: root, operation: 'remote-push', env
          });
          if (retained.status !== 0) {
            const observed = await remoteHeads(repository.remote, [branch], { env });
            if (observed.get(branch) !== candidateCommit) {
              throw new SingularityFlowError(
                `Configuration update for '${repository.displayRemote}' was rejected and its review branch could not be retained. `
                  + remoteFailureMessage(retained)
              );
            }
          }
          return {
            status: 'review-required',
            repository: repository.id,
            remote: repository.displayRemote,
            memberships: repository.memberships,
            sourceCommit,
            candidateCommit,
            proposalBranch: branch,
            conflicts: refresh.conflicts,
            configurationChanged: false,
            stateChanged: false,
            error: remoteFailureMessage(pushed, 'Git rejected the exact configuration update; review repository policy and retry.')
          };
        }
      } else {
        approvedCommit = candidateCommit;
        configurationChanged = true;
      }
    }
  }

  try {
  const projection = configurationChanged ? await desiredStateProjection(root, { env }) : desired;
  assertDedicatedStateAuthority(repository, projection);
  const stateBefore = observeStateProjection(root, projection, approvedCommit, refresh.product, {
    stateCommit: candidate.stateBefore.stateCommit, env
  });
  const mirrored = { ...projection.files };
  const history = await retainStateConfigurationHistory(
    root, projection.stateConfig.remote, approvedCommit, { env }
  );
  const manifest = {
    format: MIRROR_FORMAT,
    layout: 'canonical-paths',
    source: { branch: CONFIGURATION_BRANCH, commit: approvedCommit },
    history,
    product: refresh.product,
    files: projection.hashes,
    assets: projection.assets
  };
  mirrored[STATE_CONFIGURATION_MANIFEST] = `${JSON.stringify(manifest, null, 2)}\n`;
  let state;
  try {
    const publicationOptions = {
      replaceRoots: [STATE_CONFIGURATION_ROOT],
      removePaths: stateBefore.extraPaths,
      // Absence is an authority value too. A concurrent first state publisher must make this
      // confirmed plan stale rather than becoming an unreviewed base for its projection.
      expectedRemoteSha: stateBefore.stateCommit,
      guardedRemoteRefs: {
        [`refs/heads/${CONFIGURATION_BRANCH}`]: approvedCommit
      },
      env,
      ...(stateBefore.stateCommit ? {
        baseRef: stateBefore.stateCommit,
        refreshRemote: false
      } : {})
    };
    state = await publishToStateBranch(
      root,
      projection.stateConfig,
      mirrored,
      `[configuration][source:${approvedCommit.slice(0, 12)}] mirror approved configuration`,
      publicationOptions
    );
  } catch (error) {
    // The matching configuration race can continue into the state projection: both publishers
    // create the same mirror and one loses the lease. The winner may have created the empty state
    // root but not its mirror commit yet, so wait for that bounded in-flight publication. Join only
    // when a fresh fetch proves that the complete projection, source commit and product identity are
    // exact; a different or stalled publication remains a failure.
    if (error?.code !== 'state_branch.concurrent_publication' && error?.concurrent !== true) throw error;
    let concurrentState = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      concurrentState = await observeFreshStateProjection(
        root, projection, approvedCommit, refresh.product, { env }
      );
      if (concurrentState.status === 'current') break;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
    if (concurrentState.status !== 'current') throw error;
    state = { commit: concurrentState.stateCommit, changed: false, removed: [] };
  }
  const stateTrackingRef = `refs/remotes/origin/${projection.stateConfig.branch}`;
  const observedStateRef = state.commit == null
    ? observeExactRefreshRef(root, stateTrackingRef, { env }) : null;
  if (observedStateRef && observedStateRef.status !== 'direct') {
    throw refreshRefError(stateTrackingRef, observedStateRef.status, 'verify');
  }
  const stateRef = state.commit ?? observedStateRef.commit;
  const verified = run('git', ['show', `${stateRef}:${STATE_CONFIGURATION_MANIFEST}`], { cwd: root, env });
  let verifiedManifest;
  try { verifiedManifest = JSON.parse(verified.stdout); }
  catch { throw new SingularityFlowError(`State configuration mirror for '${repository.displayRemote}' is not valid JSON.`); }
  if (verifiedManifest?.source?.commit !== approvedCommit) {
    throw new SingularityFlowError(`State configuration mirror for '${repository.displayRemote}' does not pin the approved configuration commit.`);
  }
  const stateAfter = observeStateProjection(root, projection, approvedCommit, refresh.product, {
    stateCommit: stateRef, env
  });
  if (stateAfter.status !== 'current') {
    throw new SingularityFlowError(`State configuration projection for '${repository.displayRemote}' did not verify after publication.`);
  }
  const changed = configurationChanged || state.changed;
  return {
    status: changed ? 'updated' : 'current',
    repository: repository.id,
    remote: repository.displayRemote,
    memberships: repository.memberships,
    sourceCommit,
    configurationCommit: approvedCommit,
    stateCommit: stateRef,
    configurationChanged,
    stateChanged: state.changed,
    stateStatus: stateAfter.status,
    removedStatePaths: state.removed,
    files: refresh.files,
    conflicts: refresh.conflicts
  };
  } catch (error) {
    // Configuration and state are two remote publications. If the first succeeded, never report
    // the repository as unchanged merely because the second failed: that hides the exact durable
    // progress a retry must resume from and led operators to repeat configuration publication.
    if (configurationChanged) {
      error.details = {
        ...(error?.details && typeof error.details === 'object' ? error.details : {}),
        partialPublication: {
          configurationChanged: true,
          configurationCommit: approvedCommit,
          stateChanged: false
        }
      };
    }
    throw error;
  }
}

/**
 * Refresh every unique repository remote registered by machine-local workspaces.
 *
 * All reachable existing authorities are prepared and validated before the first update is pushed.
 * A rerun is the recovery protocol: completed repositories become no-ops, failed repositories retry,
 * and the state mirror is verified even when configuration itself was already current.
 */
export async function refreshWorkspaceConfigurations({
  registryFile,
  workspace = null,
  repositories = [],
  dryRun = false,
  acceptBundledConflicts = false,
  resolutions = {},
  restorePackagedSeeds = false,
  confirmPlan = null,
  inspectCandidate = null
} = {}) {
  if (!registryFile) throw new SingularityFlowError('Workspace configuration refresh requires the workspace registry path.');
  const normalizedResolutions = normalizeRefreshResolutions(resolutions);
  // Preview and apply are two halves of one reviewed operation, so they must observe the authority
  // through the same transport/authentication environment. In particular, preview must not succeed
  // through a hostile command-scoped rewrite or fail because it discarded the system/global proxy,
  // CA, or credential helper that apply will use. The isolated snapshot preserves only the reviewed
  // enterprise allowlist and neutralizes repository selectors, hooks, replacements, alternates,
  // trace sinks, and inherited command-scoped configuration for both halves. A rejected cache falls
  // back to a fresh clone under this exact same boundary.
  const gitEnv = isolatedCacheGitEnvironment();
  const targets = await registeredRepositories(registryFile, { workspace, repositories });
  const workers = gitWorkerCount(targets.length);
  const cachedPlan = confirmPlan ? await readRefreshPlanCache(registryFile, confirmPlan) : null;
  const observations = await mapLimit(targets, workers, async (repository) => {
    try {
      const cacheEntry = cachedPlan?.repositories.get(repository.remote) ?? null;
      const cachedStateBranch = isGitRefName(cacheEntry?.stateBranch ?? '')
        ? cacheEntry.stateBranch : null;
      const heads = await remoteHeads(repository.remote, [
        CONFIGURATION_BRANCH, repository.defaultBranch, cachedStateBranch
      ], { env: gitEnv });
      const commit = heads.get(CONFIGURATION_BRANCH) ?? null;
      // A missing configuration authority is seeded from the application default branch. Bind the
      // preview to that exact revision as well: otherwise main can move after preview and the apply
      // operation can silently approve bytes the user never reviewed.
      const bootstrapCommit = commit
        ? null
        : heads.get(repository.defaultBranch) ?? null;
      if (!commit && !bootstrapCommit) {
        throw new SingularityFlowError(
          `Cannot initialize '${repository.id}': remote branch '${repository.defaultBranch}' does not exist.`,
          { code: 'CONFIGURATION_BOOTSTRAP_SOURCE_MISSING' }
        );
      }
      return {
        repository, commit, bootstrapCommit,
        stateCommit: cachedStateBranch ? heads.get(cachedStateBranch) ?? null : undefined,
        error: null
      };
    } catch (error) {
      return { repository, commit: null, bootstrapCommit: null, error };
    }
  });
  const unreachable = observations.filter((item) => item.error);
  if (unreachable.length) {
    return {
      status: 'blocked', dryRun, total: targets.length, updated: 0,
      results: observations.map((item) => ({
        status: item.error ? 'failed' : 'preflight-passed',
        repository: item.repository.id,
        remote: item.repository.displayRemote,
        memberships: item.repository.memberships,
        error: refreshErrorMessage(item.error)
      }))
    };
  }

  if (dryRun) {
    const prepared = await mapLimit(observations, workers, async (observation) => {
      if (!observation.commit) {
        let candidate;
        try {
          // First-authority preview must describe and bind the exact candidate it would publish.
          // A sentinel containing only the application SHA/product revision lets package bytes,
          // conflicts, removals, and the desired state projection change behind one plan ID.
          candidate = await prepareBootstrapInspectionCandidate(observation, {
            dryRun: false, acceptBundledConflicts, resolutions: normalizedResolutions,
            restorePackagedSeeds
          }, { env: gitEnv });
          if (inspectCandidate) await inspectCandidate(candidate);
        } catch (error) {
          if (candidate?.root) await removeTemporaryTree(candidate.root);
          return { planCandidate: null, result: refreshPreflightFailure(observation, error) };
        }
        return {
          planCandidate: candidate,
          result: previewResultForCandidate(candidate, 'would-initialize')
        };
      }
      let candidate;
      try {
        candidate = await prepareCandidate(observation.repository, {
          dryRun: false, acceptBundledConflicts, resolutions: normalizedResolutions,
          restorePackagedSeeds
        }, { env: gitEnv });
        if (inspectCandidate) await inspectCandidate(candidate);
      } catch (error) {
        if (candidate?.root) await removeTemporaryTree(candidate.root);
        return { planCandidate: null, result: refreshPreflightFailure(observation, error) };
      }
      const stateChanged = candidate.refresh.changed || candidate.stateBefore.changed;
      return {
        planCandidate: candidate,
        result: previewResultForCandidate(
          candidate, candidate.refresh.changed || stateChanged ? 'would-update' : 'current'
        )
      };
    });
    const planCandidates = prepared.map((entry) => entry.planCandidate).filter(Boolean);
    const results = prepared.map((entry) => entry.result);
    const blocked = results.some((entry) => entry.status === 'blocked');
    const planId = blocked ? null : refreshPlanId(planCandidates, {
      resolutions: normalizedResolutions, acceptBundledConflicts, restorePackagedSeeds
    });
    if (planId) {
      await retainRefreshPlanCache(registryFile, planId, planCandidates).catch(() => false);
    }
    await Promise.all(planCandidates
      .filter((candidate) => candidate.root)
      .map((candidate) => removeTemporaryTree(candidate.root)));
    return {
      status: blocked ? 'blocked' : 'preview', dryRun: true,
      ...(planId ? { planId } : {}),
      total: targets.length, updated: 0, results
    };
  }

  // A UI apply is bound to the preview even when one repository has not created its configuration
  // authority yet. Existing repositories can be prepared without mutation, while missing ones use
  // the same sentinel identity emitted by dry-run. Validate that combined plan before initialization
  // so a stale page cannot create a branch and only then discover that its confirmation was stale.
  let candidates = [];
  const bootstrapCandidates = new Map();
  let previewBoundPlanId = null;
  if (confirmPlan && observations.some((item) => !item.commit)) {
    const confirmationCandidates = [];
    const confirmationFailures = [];
    const prepared = await mapLimit(observations, workers, async (observation) => {
      if (!observation.commit) {
        try {
          const candidate = await prepareBootstrapInspectionCandidate(observation, {
            dryRun: false, acceptBundledConflicts, resolutions: normalizedResolutions,
            restorePackagedSeeds
          }, { env: gitEnv });
          return { observation, candidate, retained: false, bootstrap: true, error: null };
        } catch (error) {
          return {
            observation, candidate: null, retained: false, bootstrap: true, error
          };
        }
      }
      try {
        const candidate = await prepareObservedCandidate(observation, {
          acceptBundledConflicts, resolutions: normalizedResolutions, restorePackagedSeeds
        }, cachedPlan, { env: gitEnv });
        return { observation, candidate, retained: true, bootstrap: false, error: null };
      } catch (error) {
        return { observation, candidate: null, retained: false, bootstrap: false, error };
      }
    });
    for (const entry of prepared) {
      if (entry.error) confirmationFailures.push({ observation: entry.observation, error: entry.error });
      else {
        confirmationCandidates.push(entry.candidate);
        candidates.push(entry.candidate);
        if (entry.bootstrap) {
          bootstrapCandidates.set(entry.observation.repository.remote, entry.candidate);
        }
      }
    }
    if (confirmationFailures.length) {
      await Promise.all(prepared.filter((entry) => entry.candidate?.root)
        .map((entry) => removeTemporaryTree(entry.candidate.root)));
      return {
        status: 'blocked', dryRun: false, total: targets.length, updated: 0,
        results: observations.map((item) => {
          const failed = confirmationFailures.find((entry) => entry.observation === item);
          return {
            status: failed ? 'failed' : 'preflight-passed', repository: item.repository.id,
            remote: item.repository.displayRemote, memberships: item.repository.memberships,
            error: refreshErrorMessage(failed?.error)
          };
        })
      };
    }
    previewBoundPlanId = refreshPlanId(confirmationCandidates, {
      resolutions: normalizedResolutions, acceptBundledConflicts, restorePackagedSeeds
    });
    if (previewBoundPlanId !== confirmPlan) {
      await Promise.all(prepared.filter((entry) => entry.candidate?.root)
        .map((entry) => removeTemporaryTree(entry.candidate.root)));
      return {
        status: 'blocked', dryRun: false, planId: previewBoundPlanId,
        total: targets.length, updated: 0, failed: 0,
        results: observations.map((item) => ({
          status: 'stale-plan', repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          configurationChanged: false, stateChanged: false,
          error: 'Configuration or state authority changed after preview. Refresh the plan before applying it.'
        }))
      };
    }
  }

  // An unconfirmed terminal invocation still gets the same single-candidate publication path.
  // Build every missing authority before any remote mutation; confirmed invocations reuse the
  // exact reconstruction whose commit was compared with the preview plan above.
  const missingBootstrapCandidates = observations.filter((item) => !item.commit
    && !bootstrapCandidates.has(item.repository.remote));
  const bootstrapPreparation = await mapLimit(
    missingBootstrapCandidates, workers, async (observation) => {
      try {
        const candidate = await prepareBootstrapInspectionCandidate(observation, {
          dryRun: false, acceptBundledConflicts, resolutions: normalizedResolutions,
          restorePackagedSeeds
        }, { env: gitEnv });
        return { observation, candidate, error: null };
      } catch (error) {
        return { observation, candidate: null, error };
      }
    }
  );
  for (const entry of bootstrapPreparation) {
    if (!entry.candidate) continue;
    bootstrapCandidates.set(entry.observation.repository.remote, entry.candidate);
    candidates.push(entry.candidate);
  }
  const bootstrapPreparationFailures = bootstrapPreparation.filter((entry) => entry.error);
  if (bootstrapPreparationFailures.length) {
    await Promise.all(candidates.map((candidate) => removeTemporaryTree(candidate.root)));
    return {
      status: 'blocked', dryRun: false, total: targets.length, updated: 0,
      results: observations.map((item) => {
        const failed = bootstrapPreparationFailures.find((entry) => entry.observation === item);
        return {
          status: failed ? 'failed' : 'preflight-passed', repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          configurationChanged: false, stateChanged: false,
          error: refreshErrorMessage(failed?.error)
        };
      })
    };
  }

  // Establishing a first sflow/config branch is itself a remote publication. Reinitialization's
  // schema/ref preflight therefore has to run against the disposable bootstrap candidate before
  // ensureConfigurationBranch makes that ref visible. The normal post-initialization inspection
  // still runs below against the exact created authority, closing both sides of the bootstrap.
  if (inspectCandidate && observations.some((item) => !item.commit)) {
    const bootstrapInspectionFailures = [];
    await mapLimit(
      observations.filter((item) => !item.commit), workers, async (observation) => {
        const candidate = bootstrapCandidates.get(observation.repository.remote);
        try {
          await inspectCandidate(candidate);
        } catch (error) {
          bootstrapInspectionFailures.push({ observation, error });
        }
      }
    );
    if (bootstrapInspectionFailures.length) {
      await Promise.all(candidates.map((candidate) => removeTemporaryTree(candidate.root)));
      return {
        status: 'blocked', dryRun: false, total: targets.length, updated: 0,
        results: observations.map((item) => {
          const failed = bootstrapInspectionFailures.find((entry) => entry.observation === item);
          return {
            status: failed ? 'failed' : 'preflight-passed', repository: item.repository.id,
            remote: item.repository.displayRemote, memberships: item.repository.memberships,
            configurationChanged: false, stateChanged: false,
            error: failed ? refreshErrorMessage(failed.error) : null
          };
        })
      };
    }
  }

  // New workspace repositories receive the same authority as a normal bootstrap after any bound
  // preview has been validated. Existing authorities remain untouched during this step.
  const initialized = await mapLimit(
    observations.filter((item) => !item.commit), workers, async (observation) => {
    try {
      const bootstrapCandidate = bootstrapCandidates.get(observation.repository.remote);
      const initialization = await ensureConfigurationBranch(observation.repository.remote, {
        sourceBranch: observation.repository.defaultBranch,
        sourceCommit: observation.bootstrapCommit,
        authorIdentity: bootstrapCandidate?.bootstrapAuthorIdentity,
        preparedCandidate: {
          root: bootstrapCandidate?.root,
          commit: bootstrapCandidate?.bootstrapCandidateCommit,
          tree: bootstrapCandidate?.bootstrapCandidateTree
        },
        env: bootstrapCandidate?.gitEnv ?? gitEnv
      });
      return { observation, initialization, error: null };
    } catch (error) {
      return { observation, initialization: null, error };
    }
  });
  const initializationFailures = initialized.filter((entry) => entry.error);
  if (initializationFailures.length) {
    await Promise.all(candidates.map((candidate) => removeTemporaryTree(candidate.root)));
    const createdInitializations = initialized.filter((entry) =>
      !entry.error && entry.initialization?.created === true);
    return {
      // Branch creation is an irreversible remote publication. If one repository succeeded while
      // a peer failed, report that durable progress instead of claiming the whole apply was
      // blocked without changes. A rerun observes the created authority and resumes its state
      // projection while retrying only the missing authority.
      status: createdInitializations.length ? 'partial' : 'blocked',
      dryRun: false,
      ...(previewBoundPlanId ? { planId: previewBoundPlanId } : {}),
      total: targets.length,
      updated: createdInitializations.length,
      failed: initializationFailures.length,
      results: observations.map((item) => {
        const failed = initializationFailures.find((entry) => entry.observation === item);
        const created = createdInitializations.find((entry) => entry.observation === item);
        return {
          status: failed ? 'failed' : created ? 'initialization-created' : 'preflight-passed',
          repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          configurationChanged: Boolean(created),
          configurationCommit: created?.initialization?.commit ?? null,
          stateChanged: false,
          error: refreshErrorMessage(failed?.error)
        };
      })
    };
  }
  const concurrentInitializations = confirmPlan
    ? initialized.filter((entry) => !entry.error && entry.initialization?.created === false)
    : [];
  if (concurrentInitializations.length) {
    await Promise.all(candidates.map((candidate) => removeTemporaryTree(candidate.root)));
    const createdInitializations = initialized.filter((entry) =>
      !entry.error && entry.initialization?.created === true);
    return {
      status: createdInitializations.length ? 'partial' : 'blocked',
      dryRun: false,
      ...(previewBoundPlanId ? { planId: previewBoundPlanId } : {}),
      total: targets.length,
      updated: createdInitializations.length,
      failed: concurrentInitializations.length,
      results: observations.map((item) => {
        const moved = concurrentInitializations.find((entry) => entry.observation === item);
        const created = createdInitializations.find((entry) => entry.observation === item);
        return {
          status: moved ? 'stale-plan' : created ? 'initialization-created' : 'preflight-passed',
          repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          configurationChanged: Boolean(created),
          configurationCommit: created?.initialization?.commit ?? null,
          stateChanged: false,
          error: moved
            ? 'Configuration authority was created concurrently after preview. Create and review a fresh plan before applying it.'
            : null
        };
      })
    };
  }

  // The exact reviewed candidate is now the approved source commit.  Keep its original refresh
  // report for presentation, but do not author or push a second configuration commit; only the
  // state projection remains to publish.
  for (const entry of initialized) {
    const candidate = bootstrapCandidates.get(entry.observation.repository.remote);
    if (!candidate || entry.error) continue;
    candidate.sourceCommit = entry.initialization.commit;
    candidate.refresh = { ...candidate.refresh, changed: false };
    candidate.bootstrapConfigurationCreated = entry.initialization.created === true;
  }

  const toPrepare = observations.filter((observation) =>
    !bootstrapCandidates.has(observation.repository.remote)
      && !(previewBoundPlanId && observation.commit));
  const prepared = await mapLimit(toPrepare, workers, async (observation) => {
    try {
      const candidate = await prepareObservedCandidate(observation, {
        acceptBundledConflicts, resolutions: normalizedResolutions, restorePackagedSeeds
      }, cachedPlan, { env: gitEnv });
      return { observation, candidate, error: null };
    } catch (error) {
      return { observation, candidate: null, error };
    }
  });
  const preparationFailures = prepared.filter((entry) => entry.error);
  for (const entry of prepared) {
    if (entry.candidate) candidates.push(entry.candidate);
  }
  if (preparationFailures.length) {
    await Promise.all(candidates.map((candidate) => removeTemporaryTree(candidate.root)));
    return {
      status: 'blocked', dryRun: false, total: targets.length, updated: 0,
      results: observations.map((item) => {
        const failed = preparationFailures.find((entry) => entry.observation === item);
        return {
          status: failed ? 'failed' : 'preflight-passed', repository: item.repository.id,
          remote: item.repository.displayRemote, memberships: item.repository.memberships,
          error: refreshErrorMessage(failed?.error)
        };
      })
    };
  }

  if (inspectCandidate) {
    const inspectionFailures = [];
    await mapLimit(candidates, workers, async (candidate) => {
      try { await inspectCandidate(candidate); }
      catch (error) { inspectionFailures.push({ candidate, error }); }
    });
    if (inspectionFailures.length) {
      await Promise.all(candidates.map((candidate) => removeTemporaryTree(candidate.root)));
      return {
        status: 'blocked', dryRun: false, total: targets.length, updated: 0,
        results: candidates.map((candidate) => {
          const failed = inspectionFailures.find((entry) => entry.candidate === candidate);
          return {
            status: failed ? 'failed' : 'preflight-passed', repository: candidate.repository.id,
            remote: candidate.repository.displayRemote, memberships: candidate.repository.memberships,
            configurationChanged: false, stateChanged: false,
            error: failed ? refreshErrorMessage(failed.error) : null
          };
        })
      };
    }
  }

  const planId = previewBoundPlanId ?? refreshPlanId(candidates, {
    resolutions: normalizedResolutions, acceptBundledConflicts, restorePackagedSeeds
  });
  if (!previewBoundPlanId && confirmPlan && confirmPlan !== planId) {
    await Promise.all(candidates.map((candidate) => removeTemporaryTree(candidate.root)));
    return {
      status: 'blocked', dryRun: false, planId, total: targets.length, updated: 0, failed: 0,
      results: candidates.map((candidate) => ({
        status: 'stale-plan', repository: candidate.repository.id,
        remote: candidate.repository.displayRemote, memberships: candidate.repository.memberships,
        configurationChanged: false, stateChanged: false,
        error: 'Configuration or state authority changed after preview. Refresh the plan before applying it.'
      }))
    };
  }

  let results = [];
  try {
    results = await mapLimit(candidates, workers, async (candidate) => {
      try { return await publishCandidate(candidate); }
      catch (error) {
        const partial = error?.details?.partialPublication ?? {};
        return {
          status: 'failed', repository: candidate.repository.id,
          remote: candidate.repository.displayRemote, memberships: candidate.repository.memberships,
          configurationChanged: partial.configurationChanged === true,
          configurationCommit: partial.configurationCommit ?? null,
          stateChanged: partial.stateChanged === true,
          error: refreshErrorMessage(error)
        };
      }
    });
  } finally {
    await Promise.all(candidates.map((candidate) => removeTemporaryTree(candidate.root)));
  }
  const failed = results.filter((result) => ['failed', 'review-required'].includes(result.status));
  return {
    status: failed.length ? 'partial' : 'complete',
    dryRun: false, planId,
    total: targets.length,
    updated: results.filter((result) => result.status === 'updated').length,
    failed: failed.length,
    results
  };
}
