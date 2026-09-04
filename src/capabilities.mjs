import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeSourceRoots } from './source-scope.mjs';
import { exists, secureRepositoryPath, SingularityFlowError, YAML_OUTPUT } from './util.mjs';
import { foldCapabilityAutoPolicy, normalizeCapabilityAutoPolicy } from './auto/auto-policy.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';

export const CAPABILITIES_PATH = 'singularity/capabilities.yml';
export const IMPLICIT_CAPABILITY_ID = 'repository-root';
export const EFFECTIVE_CAPABILITY_RESOLVER = Object.freeze({
  id: 'sflow-effective-capability',
  version: 1,
  implementationSha256: `sha256:${createHash('sha256')
    .update('sflow-effective-capability:v1:longest-canonical-prefix:repository-root-fallback')
    .digest('hex')}`
});

const GATE_ORDER = ['off', 'warn', 'block'];
const GROUNDING_ORDER = ['off', 'warn', 'enforce'];
const STALENESS_ORDER = ['ignore', 'warn', 'fail'];
const PUBLICATION_ORDER = ['off', 'warn', 'required'];
const CONTEXT_ORDER = ['keep', 'compact', 'new'];

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${label} must be an object.`);
  return value;
}

function uniqueStrings(value, label) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new SingularityFlowError(`${label} must be an array of non-empty strings.`);
  return [...new Set(value.map((item) => item.trim()))];
}

/**
 * Convert the one user-facing ownership shorthand into the existing source-root contract.
 * Only a trailing `/**` is accepted; every other glob would make prefix ownership ambiguous.
 */
export function normalizeCapabilityOwnership(value, label = 'Capability ownership') {
  let candidate = String(value ?? '').trim().replaceAll('\\', '/');
  if (candidate.endsWith('/**')) candidate = candidate.slice(0, -3);
  candidate = candidate.replace(/^\.\//, '').replace(/\/$/, '');
  if (!candidate || candidate === '.') return '';
  if (candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)
      || candidate.split('/').includes('..') || /[*?\[\]{}]/.test(candidate)) {
    throw new SingularityFlowError(
      `${label} must be one repository-relative directory prefix; only a trailing /** shorthand is allowed.`,
      { code: 'PCD_PATH_INVALID' }
    );
  }
  return candidate.split('/').filter((segment) => segment && segment !== '.').join('/');
}

export function capabilityMapMode(definition) {
  if (!definition) return 'implicit';
  return definition.version === 2 && definition.management?.mode === 'sflow-cli'
    ? 'explicit-managed'
    : 'explicit-legacy';
}

function sha(value) { return `sha256:${recordSha256(value)}`; }

function capabilityRepositoryIdentity(repositoryId, repositoryIdentitySha256) {
  const id = String(repositoryId ?? '').trim();
  const identitySha256 = String(repositoryIdentitySha256 ?? '').trim();
  if (!id || !/^sha256:[a-f0-9]{64}$/.test(identitySha256)) {
    throw new SingularityFlowError(
      'The repository identity is not complete enough to resolve its implicit capability.',
      { code: 'PCD_REPOSITORY_IDENTITY_REQUIRED' }
    );
  }
  return { id, identitySha256 };
}

/** Stable, clone-independent zero-configuration capability record. */
export function resolveImplicitCapability({
  repositoryId,
  repositoryIdentitySha256,
  approvedConfigurationSha256,
  approvalProfile = 'team',
  basePolicy = {}
} = {}) {
  const repository = capabilityRepositoryIdentity(repositoryId, repositoryIdentitySha256);
  const policy = foldCapabilityPolicy({}, basePolicy);
  const core = {
    schemaVersion: currentSchemaVersion('effective-capability-resolution'),
    kind: 'effective-capability-resolution',
    mode: 'implicit',
    repository,
    capability: {
      id: IMPLICIT_CAPABILITY_ID,
      label: 'This repository',
      kind: 'delivery',
      sourceRoots: [],
      sharedRoots: [],
      teams: [],
      dependencies: []
    },
    approvedConfigurationSha256: approvedConfigurationSha256 ?? null,
    approvalProfileSha256: sha({ profile: approvalProfile || 'team' }),
    policySha256: sha(policy),
    sourceScopeSha256: sha({ sourceRoots: [], sharedRoots: [] }),
    approvalRequirementSha256: sha({ requiredAuthorityGroups: policy.requiredAuthorityGroups ?? [] }),
    dependencyContractSha256: sha([]),
    resolver: EFFECTIVE_CAPABILITY_RESOLVER
  };
  return Object.freeze({ ...core, resolutionSha256: sha(core), policy });
}

/** Build the same immutable Story pin for an approved explicit map. */
export function resolveExplicitCapability({
  mode = 'explicit-legacy', repositoryId, repositoryIdentitySha256,
  approvedConfigurationSha256 = null, capabilityStateSha256,
  capabilityId, label, kind = 'delivery', sourceScope = {}, teams = [], dependencies = [],
  policy = {}, approvalProfile = 'team'
} = {}) {
  const repository = capabilityRepositoryIdentity(repositoryId, repositoryIdentitySha256);
  if (!['explicit-legacy', 'explicit-managed'].includes(mode)) {
    throw new SingularityFlowError(`Unsupported explicit capability mode '${mode}'.`);
  }
  if (!capabilityId || !/^sha256:[a-f0-9]{64}$/.test(capabilityStateSha256 ?? '')) {
    throw new SingularityFlowError('Explicit capability resolution requires an ID and exact capability-state digest.', {
      code: 'PCD_CAPABILITY_STATE_REQUIRED'
    });
  }
  const normalizedScope = {
    sourceRoots: normalizeSourceRoots(sourceScope?.sourceRoots),
    sharedRoots: normalizeSourceRoots(sourceScope?.sharedRoots)
  };
  const exactDependencies = structuredClone(dependencies ?? []);
  const effectivePolicy = foldCapabilityPolicy({}, policy);
  const core = {
    schemaVersion: currentSchemaVersion('effective-capability-resolution'),
    kind: 'effective-capability-resolution',
    mode,
    repository,
    capability: {
      id: capabilityId, label: label ?? capabilityId, kind,
      ...normalizedScope, teams: [...teams], dependencies: exactDependencies
    },
    capabilityStateSha256,
    approvedConfigurationSha256,
    approvalProfileSha256: sha({ profile: approvalProfile || 'team' }),
    policySha256: sha(effectivePolicy),
    sourceScopeSha256: sha(normalizedScope),
    approvalRequirementSha256: sha({
      requiredAuthorityGroups: effectivePolicy.requiredAuthorityGroups ?? [],
      approvalMinimum: effectivePolicy.approvalMinimum ?? null,
      allowSelfApproval: effectivePolicy.allowSelfApproval ?? null
    }),
    dependencyContractSha256: sha(exactDependencies),
    resolver: EFFECTIVE_CAPABILITY_RESOLVER
  };
  return Object.freeze({ ...core, resolutionSha256: sha(core), policy: effectivePolicy });
}

/** Materialize the implicit root without changing its ID, fallback scope, or policy. */
export function materializeImplicitCapability(resolution) {
  if (resolution?.mode !== 'implicit' || resolution.capability?.id !== IMPLICIT_CAPABILITY_ID) {
    throw new SingularityFlowError('Only an implicit repository-root capability can be materialized.', {
      code: 'PCD_MATERIALIZATION_INVALID'
    });
  }
  return {
    version: 2,
    management: {
      mode: 'sflow-cli',
      materializedFrom: {
        kind: 'implicit-repository',
        resolutionSha256: resolution.resolutionSha256
      }
    },
    capabilities: {
      [IMPLICIT_CAPABILITY_ID]: {
        name: resolution.capability.label,
        kind: 'delivery',
        parent: null,
        repository: resolution.repository.id,
        sourceRoots: [],
        sharedRoots: [],
        teams: [],
        policy: resolution.policy,
        dependencies: []
      }
    }
  };
}

function prefixMatches(prefix, subject) {
  return !prefix || subject === prefix || subject.startsWith(`${prefix}/`);
}

/** Resolve a path owner by the one canonical longest-prefix rule. */
export function resolveCapabilityOwner(definition, subject = '') {
  validateCapabilities(definition);
  const canonicalPath = normalizeCapabilityOwnership(subject, 'Capability path');
  const candidates = [];
  for (const [id, capability] of Object.entries(definition.capabilities)) {
    if (capability.kind !== 'delivery') continue;
    for (const raw of capability.sourceRoots ?? []) {
      const prefix = normalizeCapabilityOwnership(raw, `Capability '${id}'.sourceRoots`);
      if (prefix && prefixMatches(prefix, canonicalPath)) candidates.push({ id, prefix });
    }
  }
  candidates.sort((left, right) => right.prefix.length - left.prefix.length || left.id.localeCompare(right.id));
  const best = candidates[0] ?? null;
  if (best) {
    const tied = candidates.filter((entry) => entry.prefix.length === best.prefix.length);
    if (new Set(tied.map((entry) => entry.id)).size > 1) {
      throw new SingularityFlowError(
        `Capability ownership is ambiguous for '${canonicalPath || '.'}': ${tied.map((entry) => entry.id).join(', ')}.`,
        { code: 'PCD_OWNERSHIP_AMBIGUOUS', details: { path: canonicalPath, candidates: tied } }
      );
    }
    return { capabilityId: best.id, canonicalPath, canonicalPrefix: best.prefix, resolution: 'most-specific-prefix' };
  }
  if (definition.capabilities[IMPLICIT_CAPABILITY_ID]?.kind === 'delivery') {
    return { capabilityId: IMPLICIT_CAPABILITY_ID, canonicalPath, canonicalPrefix: '', resolution: 'repository-root-fallback' };
  }
  const deliveries = Object.entries(definition.capabilities)
    .filter(([, capability]) => capability.kind === 'delivery')
    .map(([id]) => id);
  if (deliveries.length === 1) {
    return { capabilityId: deliveries[0], canonicalPath, canonicalPrefix: '', resolution: 'only-delivery' };
  }
  return { capabilityId: null, canonicalPath, canonicalPrefix: null, resolution: 'unowned' };
}

function validateDependency(id, dependency) {
  object(dependency, `Capability '${id}' dependency`);
  const allowed = new Set(['capability', 'contract']);
  for (const key of Object.keys(dependency)) if (!allowed.has(key)) {
    throw new SingularityFlowError(`Capability '${id}' dependency contains unknown key '${key}'.`);
  }
  if (typeof dependency.capability !== 'string' || !dependency.capability.trim()) {
    throw new SingularityFlowError(`Capability '${id}' dependency requires capability.`);
  }
  const contract = object(dependency.contract, `Capability '${id}' dependency contract`);
  const contractKeys = new Set(['id', 'version', 'sha256', 'publicationSha256', 'publisherAuthority']);
  for (const key of Object.keys(contract)) if (!contractKeys.has(key)) {
    throw new SingularityFlowError(`Capability '${id}' dependency contract contains unknown key '${key}'.`);
  }
  for (const key of contractKeys) if (typeof contract[key] !== 'string' || !contract[key].trim()) {
    throw new SingularityFlowError(`Capability '${id}' dependency contract requires ${key}.`);
  }
  if (/^(?:latest|current|next|head|main|master)$/i.test(contract.version.trim())
      || /[*~^<>=]/.test(contract.version)) {
    throw new SingularityFlowError(
      `Capability '${id}' dependency contract version must be an exact published version, not '${contract.version}'.`,
      { code: 'PCD_MOVABLE_REFERENCE_UNRESOLVED' }
    );
  }
  for (const key of ['sha256', 'publicationSha256']) if (!/^sha256:[a-f0-9]{64}$/.test(contract[key])) {
    throw new SingularityFlowError(`Capability '${id}' dependency contract ${key} must be an exact SHA-256 identity.`);
  }
}

function stricterEnum(parent, child, order, label) {
  if (parent == null) return child;
  if (child == null) return parent;
  if (!order.includes(parent) || !order.includes(child)) throw new SingularityFlowError(`${label} contains an unsupported value.`);
  return order[Math.max(order.indexOf(parent), order.indexOf(child))];
}

function intersect(parent, child) {
  if (parent == null) return child == null ? null : [...child];
  if (child == null) return [...parent];
  return parent.filter((item) => child.includes(item));
}

function union(parent, child) {
  return [...new Set([...(parent ?? []), ...(child ?? [])])];
}

function min(parent, child) {
  if (parent == null) return child ?? null;
  if (child == null) return parent;
  return Math.min(parent, child);
}

function max(parent, child) {
  if (parent == null) return child ?? null;
  if (child == null) return parent;
  return Math.max(parent, child);
}

function nonNegativeInteger(value, label, { positive = false } = {}) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < (positive ? 1 : 0)) {
    throw new SingularityFlowError(`${label} must be ${positive ? 'a positive' : 'a non-negative'} integer.`);
  }
  return value;
}

export function foldCapabilityPolicy(parent = {}, child = {}) {
  object(parent, 'Parent capability policy');
  object(child, 'Child capability policy');
  const allowed = new Set([
    'gateSeverity', 'approvalMinimum', 'allowSelfApproval', 'maxDocumentBytes',
    'allowedPhases', 'requiredChecks', 'requiredAuthorityGroups', 'jiraProjects', 'jiraHosts', 'jiraOperations', 'jiraFields',
    'protectedPaths', 'worldModelGrounding', 'worldModelStaleness', 'requiredWorldModelViews',
    'writeScopes', 'qualityCommands', 'storageProviders', 'allowedMimeTypes', 'tokenBudget',
    'gitPublication', 'contextBoundary', 'contextMaxBytes', 'auto'
  ]);
  for (const key of Object.keys(child)) if (!allowed.has(key)) throw new SingularityFlowError(`Capability policy contains unknown key '${key}'.`);
  const array = (key) => uniqueStrings(child[key], `Capability policy.${key}`);
  const parentArray = (key) => uniqueStrings(parent[key], `Parent capability policy.${key}`);
  const parentApprovalMinimum = nonNegativeInteger(parent.approvalMinimum, 'Parent capability policy.approvalMinimum', { positive: true });
  const childApprovalMinimum = nonNegativeInteger(child.approvalMinimum, 'Capability policy.approvalMinimum', { positive: true });
  const parentMaxDocumentBytes = nonNegativeInteger(parent.maxDocumentBytes, 'Parent capability policy.maxDocumentBytes', { positive: true });
  const childMaxDocumentBytes = nonNegativeInteger(child.maxDocumentBytes, 'Capability policy.maxDocumentBytes', { positive: true });
  const parentTokenBudget = nonNegativeInteger(parent.tokenBudget, 'Parent capability policy.tokenBudget', { positive: true });
  const childTokenBudget = nonNegativeInteger(child.tokenBudget, 'Capability policy.tokenBudget', { positive: true });
  const parentContextMaxBytes = nonNegativeInteger(parent.contextMaxBytes, 'Parent capability policy.contextMaxBytes', { positive: true });
  const childContextMaxBytes = nonNegativeInteger(child.contextMaxBytes, 'Capability policy.contextMaxBytes', { positive: true });
  if (parent.allowSelfApproval != null && typeof parent.allowSelfApproval !== 'boolean') throw new SingularityFlowError('Parent capability policy.allowSelfApproval must be boolean.');
  if (child.allowSelfApproval != null && typeof child.allowSelfApproval !== 'boolean') throw new SingularityFlowError('Capability policy.allowSelfApproval must be boolean.');
  const parentAuto = parent.auto == null ? null : normalizeCapabilityAutoPolicy(parent.auto, 'Parent capability policy.auto');
  const childAuto = child.auto == null ? null : normalizeCapabilityAutoPolicy(child.auto, 'Capability policy.auto');
  const result = {
    gateSeverity: stricterEnum(parent.gateSeverity, child.gateSeverity, GATE_ORDER, 'gateSeverity'),
    approvalMinimum: max(parentApprovalMinimum, childApprovalMinimum),
    allowSelfApproval: parent.allowSelfApproval == null
      ? child.allowSelfApproval ?? null
      : child.allowSelfApproval == null ? parent.allowSelfApproval : parent.allowSelfApproval && child.allowSelfApproval,
    maxDocumentBytes: min(parentMaxDocumentBytes, childMaxDocumentBytes),
    allowedPhases: intersect(parentArray('allowedPhases'), array('allowedPhases')),
    requiredChecks: union(parentArray('requiredChecks'), array('requiredChecks')),
    requiredAuthorityGroups: union(parentArray('requiredAuthorityGroups'), array('requiredAuthorityGroups')),
    jiraProjects: intersect(parentArray('jiraProjects'), array('jiraProjects')),
    jiraHosts: intersect(parentArray('jiraHosts'), array('jiraHosts')),
    jiraOperations: intersect(parentArray('jiraOperations'), array('jiraOperations')),
    jiraFields: intersect(parentArray('jiraFields'), array('jiraFields')),
    protectedPaths: union(parentArray('protectedPaths'), array('protectedPaths')),
    worldModelGrounding: stricterEnum(parent.worldModelGrounding, child.worldModelGrounding, GROUNDING_ORDER, 'worldModelGrounding'),
    worldModelStaleness: stricterEnum(parent.worldModelStaleness, child.worldModelStaleness, STALENESS_ORDER, 'worldModelStaleness'),
    requiredWorldModelViews: union(parentArray('requiredWorldModelViews'), array('requiredWorldModelViews')),
    writeScopes: intersect(parentArray('writeScopes'), array('writeScopes')),
    qualityCommands: union(parentArray('qualityCommands'), array('qualityCommands')),
    storageProviders: intersect(parentArray('storageProviders'), array('storageProviders')),
    allowedMimeTypes: intersect(parentArray('allowedMimeTypes'), array('allowedMimeTypes')),
    tokenBudget: min(parentTokenBudget, childTokenBudget),
    gitPublication: stricterEnum(parent.gitPublication, child.gitPublication, PUBLICATION_ORDER, 'gitPublication'),
    contextBoundary: stricterEnum(parent.contextBoundary, child.contextBoundary, CONTEXT_ORDER, 'contextBoundary'),
    contextMaxBytes: min(parentContextMaxBytes, childContextMaxBytes),
    auto: foldCapabilityAutoPolicy(parentAuto, childAuto)
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value != null));
}

/**
 * What a capability delivers, who runs it, and where its work is tracked.
 *
 * A delivery capability names one or more repositories it ships from. A collection groups related
 * capabilities and names none. `kind` is the authority for that distinction; validation keeps its
 * repository declaration consistent so the two cannot drift apart.
 *
 * Jira and teams belong here rather than to the workspace. A workspace is a local convenience — a
 * directory holding checkouts of whatever someone is working on this week — while which board tracks
 * a capability and who runs it are properties of the capability itself, true regardless of who has
 * cloned what.
 */
/**
 * The two structural capability kinds exposed by every surface.
 */
export const CAPABILITY_KINDS = Object.freeze(['collection', 'delivery']);

/** Optional domain classification, separate from the structural kind. */
export const CAPABILITY_TYPES = Object.freeze(['tech', 'business']);

/** Fields that are sets of named links, where an edit changes entries rather than replacing all. */
const MERGED_MAPS = Object.freeze(['metadata', 'documentation', 'resources']);

function validateCapabilityTextMap(id, field, value) {
  if (value == null) return;
  object(value, `Capability '${id}'.${field}`);
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) throw new SingularityFlowError(`Capability '${id}'.${field} keys must be non-empty text.`);
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new SingularityFlowError(
        `Capability '${id}'.${field}.${key} must be non-empty text.`);
    }
  }
}

/**
 * Every repository a capability ships from.
 *
 * `repository` is the single-repository shorthand and stays valid — most capabilities have one, and
 * making them all write a list would be noise. `repositories` is the list form. Both read the same.
 */
export function capabilityRepositories(capability) {
  const listed = Array.isArray(capability?.repositories) ? capability.repositories : [];
  const single = capability?.repository != null ? [capability.repository] : [];
  return [...new Set([...single, ...listed])];
}

/** The repository holding this capability's governed state: the declared lead, or its only one. */
export function capabilityLeadRepository(capability) {
  const repositories = capabilityRepositories(capability);
  if (capability?.leadRepository) return capability.leadRepository;
  return repositories.length === 1 ? repositories[0] : null;
}

function validateCapabilityDelivery(id, capability, capabilities, portfolio) {
  if (!CAPABILITY_KINDS.includes(capability.kind)) {
    throw new SingularityFlowError(
      `Capability '${id}'.kind must be one of: ${CAPABILITY_KINDS.join(', ')}.`);
  }

  // `type` remains an optional domain classification. It must never be confused with structural
  // kind: collection/delivery determines hierarchy and repository responsibility.
  if (capability.type != null && !CAPABILITY_TYPES.includes(capability.type)) {
    throw new SingularityFlowError(
      `Capability '${id}'.type must be one of: ${CAPABILITY_TYPES.join(', ')}.`);
  }

  // A capability may ship from several repositories and still contain other capabilities. Both were
  // forbidden: one repository each, and naming one made the capability a leaf. Neither holds — a
  // product with a web app and a service is one capability with two repositories, and it may still
  // group the capabilities beneath it.
  const repositories = capabilityRepositories(capability);
  if (capability.kind === 'collection' && repositories.length) {
    throw new SingularityFlowError(
      `Capability '${id}' is a collection and cannot name repositories. Change kind to delivery or remove its repositories.`);
  }
  if (capability.kind === 'delivery' && !repositories.length) {
    throw new SingularityFlowError(
      `Capability '${id}' is a delivery and must name at least one repository.`);
  }
  for (const repository of repositories) {
    if (typeof repository !== 'string' || !repository.trim()) {
      throw new SingularityFlowError(`Capability '${id}' repository must be a repository identifier.`);
    }
    if (portfolio && !portfolio.repositories?.[repository]) {
      throw new SingularityFlowError(`Capability '${id}' ships from repository '${repository}', which the portfolio does not declare.`);
    }
  }
  if (new Set(repositories).size !== repositories.length) {
    throw new SingularityFlowError(`Capability '${id}' names the same repository more than once.`);
  }
  // One lead per capability: it is where that capability's governed state and world model live, so
  // "which one" cannot be left to whichever happens to be listed first.
  if (capability.leadRepository != null) {
    if (!repositories.includes(capability.leadRepository)) {
      throw new SingularityFlowError(
        `Capability '${id}' leads with '${capability.leadRepository}', which is not one of its repositories.`);
    }
  }

  normalizeSourceRoots(capability.sourceRoots, `Capability '${id}'.sourceRoots`);
  normalizeSourceRoots(capability.sharedRoots, `Capability '${id}'.sharedRoots`);

  for (const field of MERGED_MAPS) validateCapabilityTextMap(id, field, capability[field]);

  if (capability.jira != null) {
    object(capability.jira, `Capability '${id}'.jira`);
    for (const field of ['projectKey', 'board', 'component']) {
      if (capability.jira[field] != null && typeof capability.jira[field] !== 'string') {
        throw new SingularityFlowError(`Capability '${id}'.jira.${field} must be text.`);
      }
    }
  }

  if (capability.teams != null) uniqueStrings(capability.teams, `Capability '${id}'.teams`);
}

/**
 * @param portfolio when given, a delivery capability's repository must be one the portfolio
 *   declares. A capability pointing at a repository nobody configured looks fine until something
 *   tries to clone it.
 */
export function validateCapabilities(definition, portfolio = null) {
  object(definition, 'capabilities.yml');
  if (![1, 2].includes(definition.version)) throw new SingularityFlowError('capabilities.yml version must be 1 or 2.');
  if (definition.version === 1 && definition.management != null) {
    throw new SingularityFlowError('capabilities.yml version 1 cannot declare management metadata.');
  }
  if (definition.version === 2) {
    object(definition.management, 'capabilities.yml management');
    if (!['sflow-cli', 'legacy-mixed'].includes(definition.management.mode)) {
      throw new SingularityFlowError("capabilities.yml management.mode must be 'sflow-cli' or 'legacy-mixed'.");
    }
    if (definition.management.materializedFrom != null) {
      object(definition.management.materializedFrom, 'capabilities.yml management.materializedFrom');
      if (definition.management.materializedFrom.kind !== 'implicit-repository'
          || !/^sha256:[a-f0-9]{64}$/.test(definition.management.materializedFrom.resolutionSha256 ?? '')) {
        throw new SingularityFlowError('Managed capability materialization requires an exact implicit resolution digest.');
      }
    }
  }
  const capabilities = object(definition.capabilities, 'capabilities');
  if (!Object.keys(capabilities).length) throw new SingularityFlowError('capabilities must define at least one node.');
  for (const [id, capability] of Object.entries(capabilities)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new SingularityFlowError(`Capability '${id}' must be lower-case kebab-case.`);
    object(capability, `Capability '${id}'`);
    if (!capability.kind || typeof capability.kind !== 'string') throw new SingularityFlowError(`Capability '${id}' requires kind.`);
    if (capability.parent != null && !capabilities[capability.parent]) throw new SingularityFlowError(`Capability '${id}' references unknown parent '${capability.parent}'.`);
    uniqueStrings(capability.owns, `Capability '${id}'.owns`);
    for (const sourceRoot of capability.sourceRoots ?? []) {
      normalizeCapabilityOwnership(sourceRoot, `Capability '${id}'.sourceRoots`);
    }
    if (capability.dependencies != null) {
      if (!Array.isArray(capability.dependencies)) throw new SingularityFlowError(`Capability '${id}'.dependencies must be an array.`);
      if (definition.version === 1 && capability.dependencies.length) {
        throw new SingularityFlowError(`Capability '${id}' dependencies require capabilities.yml version 2.`);
      }
      for (const dependency of capability.dependencies) validateDependency(id, dependency);
    }
    foldCapabilityPolicy({}, capability.policy ?? {});
    validateCapabilityDelivery(id, capability, capabilities, portfolio);
  }
  for (const id of Object.keys(capabilities)) {
    const visited = new Set();
    let cursor = id;
    while (cursor) {
      if (visited.has(cursor)) throw new SingularityFlowError(`Capability tree contains a cycle at '${cursor}'.`);
      visited.add(cursor);
      cursor = capabilities[cursor]?.parent ?? null;
    }
  }
  if (definition.version === 2) {
    const visiting = new Set();
    const visitedDependencies = new Set();
    const visit = (id, trail = []) => {
      if (visiting.has(id)) {
        throw new SingularityFlowError(
          `Capability dependency cycle is prohibited: ${[...trail, id].join(' -> ')}.`,
          { code: 'PCD_DEPENDENCY_CYCLE', details: { capabilityIds: [...trail, id] } }
        );
      }
      if (visitedDependencies.has(id)) return;
      visiting.add(id);
      for (const dependency of capabilities[id]?.dependencies ?? []) {
        if (capabilities[dependency.capability]) visit(dependency.capability, [...trail, id]);
      }
      visiting.delete(id);
      visitedDependencies.add(id);
    };
    for (const id of Object.keys(capabilities)) visit(id);
  }
  if (definition.version === 2) {
    const owners = [];
    for (const [id, capability] of Object.entries(capabilities)) {
      if (capability.kind !== 'delivery') continue;
      for (const raw of capability.sourceRoots ?? []) {
        const prefix = normalizeCapabilityOwnership(raw, `Capability '${id}'.sourceRoots`);
        if (prefix) owners.push({ id, prefix });
      }
    }
    for (let leftIndex = 0; leftIndex < owners.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex += 1) {
        const left = owners[leftIndex];
        const right = owners[rightIndex];
        if (left.prefix === right.prefix) {
          throw new SingularityFlowError(
            `Capabilities '${left.id}' and '${right.id}' both own '${left.prefix}/**'.`,
            { code: 'PCD_OWNERSHIP_AMBIGUOUS', details: { prefix: left.prefix, capabilityIds: [left.id, right.id].sort() } }
          );
        }
        const [broader, narrower] = prefixMatches(left.prefix, right.prefix)
          ? [left, right]
          : prefixMatches(right.prefix, left.prefix) ? [right, left] : [null, null];
        let cursor = narrower?.id ?? null;
        let nestedUnderBroader = false;
        while (cursor) {
          if (cursor === broader?.id) nestedUnderBroader = true;
          cursor = capabilities[cursor]?.parent ?? null;
        }
        if (broader && !nestedUnderBroader) {
          throw new SingularityFlowError(
            `Capability '${narrower.id}' owns '${narrower.prefix}/**' inside unrelated owner '${broader.id}'.`,
            {
              code: 'PCD_OWNERSHIP_AMBIGUOUS',
              details: { broader, narrower, reason: 'nested-owners-are-unrelated' }
            }
          );
        }
      }
    }
  }
  return definition;
}

export async function loadCapabilities(root, { required = false } = {}) {
  const located = await secureRepositoryPath(root, CAPABILITIES_PATH, {
    label: 'Capability map', type: 'file'
  });
  if (!located.exists) {
    if (required) throw new SingularityFlowError(`Missing ${CAPABILITIES_PATH}.`);
    return null;
  }
  return validateCapabilities(YAML.parse(await readFile(located.absolute, 'utf8')));
}

/**
 * Add, change, or remove one capability, in place.
 *
 * The file is edited as a document rather than parsed into objects and re-emitted, so the comments
 * and ordering a person put there survive a change made from a screen. A map that people hand-edit
 * and a tool also writes has to be readable after the tool has written it.
 *
 * Only the fields a caller names are touched; an empty string clears a field rather than setting it
 * to nothing. Changing a delivery to a collection is an explicit paired edit: change `kind` and clear
 * its repository declaration. Policy is deliberately not editable here — it folds, so the value that
 * applies is rarely the value written, and a field-by-field form would teach the wrong model. The
 * screen shows the fold and sends the reader to the file.
 *
 * @param mode `add` refuses an identifier that exists, `set` refuses one that does not. A screen
 *   knows which it meant, and a typo that silently creates a sibling is the expensive mistake.
 */
export async function editCapability(root, capabilityId, changes = {}, {
  mode = 'set', portfolio = null, reparentChildrenTo = undefined, managedMutation = false
} = {}) {
  const file = path.join(root, CAPABILITIES_PATH);
  const existing = (await exists(file)) ? await readFile(file, 'utf8') : null;
  const document = existing == null
    ? YAML.parseDocument('version: 1\ncapabilities: {}\n')
    : YAML.parseDocument(existing);

  const before = document.toJS() ?? {};
  if (before.version === 2 && before.management?.mode === 'sflow-cli' && !managedMutation) {
    throw new SingularityFlowError(
      'This capability map is managed by SFlow. Use capability add, capability protect, or capability depend so the change carries a reviewed mutation receipt.',
      { code: 'PCD_MANAGED_EDIT_REQUIRED' }
    );
  }
  const present = Boolean(before.capabilities?.[capabilityId]);
  if (mode === 'add' && present) throw new SingularityFlowError(`Capability '${capabilityId}' already exists.`);
  if (mode !== 'add' && !present) throw new SingularityFlowError(`Unknown capability '${capabilityId}'.`);

  if (mode === 'remove') {
    const children = Object.entries(before.capabilities ?? {})
      .filter(([, capability]) => capability.parent === capabilityId)
      .map(([id]) => id);
    if (children.length && reparentChildrenTo === undefined) {
      throw new SingularityFlowError(
        `Capability '${capabilityId}' still contains ${children.map((id) => `'${id}'`).join(', ')}. `
        + 'Move or remove them first, or choose where they should move when removing the parent.');
    }
    if (reparentChildrenTo !== undefined) {
      const target = reparentChildrenTo == null || reparentChildrenTo === ''
        ? null
        : String(reparentChildrenTo);
      if (target != null && !before.capabilities?.[target]) {
        throw new SingularityFlowError(`Unknown replacement parent capability '${target}'.`);
      }
      // A destination inside the subtree being removed would make at least one child its own
      // ancestor. Refuse it explicitly rather than relying on the later whole-map cycle message.
      let cursor = target;
      while (cursor) {
        if (cursor === capabilityId) {
          throw new SingularityFlowError(
            `Capability '${target}' is inside '${capabilityId}' and cannot become its children's replacement parent.`);
        }
        cursor = before.capabilities?.[cursor]?.parent ?? null;
      }
      for (const child of children) {
        document.setIn(['capabilities', child, 'parent'], target);
      }
    }
    document.deleteIn(['capabilities', capabilityId]);
  } else {
    // createNode rather than a bare object: setIn writes a plain value as an opaque scalar, and the
    // field-by-field writes below need a collection to descend into.
    if (mode === 'add') document.setIn(['capabilities', capabilityId], document.createNode({}));
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;

      // Metadata and named links are maps, and editing a map means changing the
      // entries you named — not replacing the set. Adding a runbook should not silently drop the
      // Confluence page somebody recorded last month. An entry given an empty value is removed,
      // which is how one is cleared.
      if (MERGED_MAPS.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [entry, link] of Object.entries(value)) {
          const at = ['capabilities', capabilityId, key, entry];
          if (link === '' || link == null) document.deleteIn(at);
          else document.setIn(at, link);
        }
        // A map emptied of every entry is an absent map rather than an empty one.
        const remaining = document.getIn(['capabilities', capabilityId, key]);
        if (remaining && typeof remaining.toJSON === 'function' && !Object.keys(remaining.toJSON()).length) {
          document.deleteIn(['capabilities', capabilityId, key]);
        }
        continue;
      }

      const empty = value === null || value === '' || (Array.isArray(value) && !value.length);
      // `parent: null` is meaningful — it is the root — so it is written rather than deleted.
      if (empty && !(key === 'parent' && value === null)) document.deleteIn(['capabilities', capabilityId, ...key.split('.')]);
      else document.setIn(['capabilities', capabilityId, ...key.split('.')], value);
    }
  }

  // Validated before anything is written: a refused edit must leave the file as it was.
  const after = validateCapabilities(document.toJS(), portfolio);
  await mkdir(path.dirname(file), { recursive: true });
  // Unpadded flow collections, because that is how this file is written by hand and by the starter
  // template. Without it every `[a, b]` in the file comes back as `[ a, b ]` and one edit shows up in
  // review as a diff against lines nobody touched.
  await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');
  return {
    path: CAPABILITIES_PATH,
    capabilityId,
    removed: mode === 'remove',
    reparentedChildren: mode === 'remove'
      ? Object.entries(before.capabilities ?? {})
        .filter(([, capability]) => capability.parent === capabilityId)
        .map(([id]) => id)
      : [],
    capabilities: after.capabilities
  };
}

export function capabilityPath(definition, capabilityId) {
  const capabilities = validateCapabilities(definition).capabilities;
  if (!capabilities[capabilityId]) throw new SingularityFlowError(`Unknown capability '${capabilityId}'.`);
  const result = [];
  let cursor = capabilityId;
  while (cursor) {
    result.unshift(cursor);
    cursor = capabilities[cursor].parent ?? null;
  }
  return result;
}

export function resolveCapabilityPolicy(definition, capabilityId) {
  const capabilities = validateCapabilities(definition).capabilities;
  const pathIds = capabilityPath(definition, capabilityId);
  return {
    capabilityId,
    path: pathIds,
    policy: pathIds.reduce((policy, id) => foldCapabilityPolicy(policy, capabilities[id].policy ?? {}), {})
  };
}

/**
 * The repository slice a capability's world model describes.
 *
 * A child may replace the application roots selected by its ancestors; shared roots accumulate so
 * platform contracts remain visible. The result is pinned into lifecycle state, so changing the map
 * later never silently changes an active Story's grounding boundary.
 */
export function resolveCapabilitySourceScope(definition, capabilityId) {
  const capabilities = validateCapabilities(definition).capabilities;
  const pathIds = capabilityPath(definition, capabilityId);
  let sourceRoots = [];
  const sharedRoots = [];
  let configured = false;
  for (const id of pathIds) {
    const capability = capabilities[id];
    if (capability.sourceRoots != null) {
      sourceRoots = normalizeSourceRoots(capability.sourceRoots, `Capability '${id}'.sourceRoots`);
      configured = true;
    }
    for (const root of normalizeSourceRoots(capability.sharedRoots, `Capability '${id}'.sharedRoots`)) {
      if (!sharedRoots.includes(root)) sharedRoots.push(root);
    }
  }
  return configured || sharedRoots.length
    ? { sourceRoots: sourceRoots.sort(), sharedRoots: sharedRoots.sort() }
    : null;
}

export function activeCapabilityLeases(definition, capabilityId, ledgerEntries = [], { at = new Date() } = {}) {
  const pathIds = capabilityPath(definition, capabilityId);
  const revoked = new Set(ledgerEntries
    .filter((entry) => entry.eventType === 'capability-lease-revoked')
    .map((entry) => entry.payload?.leaseId)
    .filter(Boolean));
  return ledgerEntries
    .filter((entry) => entry.eventType === 'capability-lease-granted')
    .filter((entry) => pathIds.includes(entry.capabilityId))
    .filter((entry) => !revoked.has(entry.payload?.leaseId))
    .filter((entry) => {
      const expiresAt = Date.parse(entry.payload?.expiresAt ?? '');
      return Number.isFinite(expiresAt) && expiresAt > at.getTime();
    })
    .map((entry) => ({
      leaseId: entry.payload.leaseId,
      capabilityId: entry.capabilityId,
      expiresAt: entry.payload.expiresAt,
      reason: entry.payload.reason,
      authorityGroup: entry.authorityGroup,
      actor: entry.actor,
      relaxation: foldCapabilityPolicy({}, entry.payload.relaxation ?? {})
    }))
    .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt));
}

export function resolveEffectiveCapabilityPolicy(definition, capabilityId, ledgerEntries = [], options = {}) {
  const base = resolveCapabilityPolicy(definition, capabilityId);
  const leases = activeCapabilityLeases(definition, capabilityId, ledgerEntries, options);
  return {
    ...base,
    basePolicy: base.policy,
    policy: leases.reduce((policy, lease) => ({ ...policy, ...lease.relaxation }), base.policy),
    leases
  };
}

/**
 * The capability forest, nested.
 *
 * Stored as a flat map with parent pointers, which is the right shape for editing one node and for
 * validating parent links and cycles. Multiple top-level capabilities are valid. The flat map is the
 * wrong shape for reading, so this is the other view of
 * the same data — every reader wants the hierarchy, and deriving it here means nobody derives it
 * twice.
 */
export function capabilityTree(definition) {
  const capabilities = definition?.capabilities ?? {};

  /**
   * Policy is folded from each top-level capability toward its children, and every fold is monotonic: stricter of two
   * severities, the larger minimum, the smaller budget, the intersection of allowlists, the union of
   * obligations. A child can therefore tighten what an ancestor set and can never loosen it.
   *
   * That is invisible in the file, where a child's `approvalMinimum: 1` looks like it means one — so
   * both are carried: what this capability declared, and what it will actually be held to.
   */
  const effectiveFor = (id) => {
    const chain = [];
    let cursor = id;
    while (cursor) { chain.unshift(cursor); cursor = capabilities[cursor]?.parent ?? null; }
    return chain.reduce((policy, step) => foldCapabilityPolicy(policy, capabilities[step]?.policy ?? {}), {});
  };

  const childrenOf = (parent) => Object.entries(capabilities)
    .filter(([, capability]) => (capability.parent ?? null) === parent)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, capability]) => ({
      id,
      name: capability.name ?? id,
      kind: capability.kind,
      // Optional domain classification, distinct from collection/delivery kind.
      type: capability.type ?? null,
      // Kind is authoritative; validation guarantees every delivery names repositories and every
      // collection names none. A delivery may still contain child capabilities.
      delivery: capability.kind === 'delivery',
      // `repository` stays the first one so every existing reader keeps working; `repositories` is
      // the whole list and `leadRepository` says which holds the governed state.
      repository: capabilityRepositories(capability)[0] ?? null,
      repositories: capabilityRepositories(capability),
      leadRepository: capabilityLeadRepository(capability),
      sourceRoots: normalizeSourceRoots(capability.sourceRoots, `Capability '${id}'.sourceRoots`),
      sharedRoots: normalizeSourceRoots(capability.sharedRoots, `Capability '${id}'.sharedRoots`),
      metadata: capability.metadata ?? {},
      documentation: capability.documentation ?? {},
      resources: capability.resources ?? {},
      jira: capability.jira ?? null,
      // Normalized here rather than stored back: uniqueStrings trims and de-duplicates, which is the
      // convention `owns` already follows, and the reader should see the tidied list.
      teams: uniqueStrings(capability.teams, 'teams') ?? [],
      owns: capability.owns ?? [],
      policy: capability.policy ?? {},
      effectivePolicy: effectiveFor(id),
      children: childrenOf(id)
    }));
  return childrenOf(null);
}

/** Every capability, depth first, each with the ancestors that reach it. */
export function flattenCapabilityTree(tree, ancestors = []) {
  return tree.flatMap((node) => [
    { ...node, depth: ancestors.length, ancestors },
    ...flattenCapabilityTree(node.children, [...ancestors, node.id])
  ]);
}

/** What a capability ships: every delivery capability at or beneath it. */
export function capabilityDeliveries(definition, capabilityId) {
  const rows = flattenCapabilityTree(capabilityTree(definition));
  if (!rows.some((row) => row.id === capabilityId)) {
    throw new SingularityFlowError(`Unknown capability '${capabilityId}'.`);
  }
  return rows
    .filter((row) => row.delivery && (row.id === capabilityId || row.ancestors.includes(capabilityId)))
    .map((row) => ({
      id: row.id, name: row.name, repository: row.repository, repositories: row.repositories
    }));
}

/** Which capability delivers a repository, and the chain of groupings above it. */
export function capabilityForRepository(definition, repositoryId) {
  // Matched against every repository the capability ships from, not only its first.
  const row = flattenCapabilityTree(capabilityTree(definition))
    .find((entry) => entry.repositories.includes(repositoryId));
  return row ? { id: row.id, name: row.name, ancestors: row.ancestors } : null;
}
