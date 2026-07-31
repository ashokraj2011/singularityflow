import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { exists, SingularityFlowError } from './util.mjs';

export const CAPABILITIES_PATH = 'singularity/capabilities.yml';

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
    'gitPublication', 'contextBoundary', 'contextMaxBytes'
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
    contextMaxBytes: min(parentContextMaxBytes, childContextMaxBytes)
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value != null));
}

export function validateCapabilities(definition) {
  object(definition, 'capabilities.yml');
  if (definition.version !== 1) throw new SingularityFlowError('capabilities.yml version must be 1.');
  const capabilities = object(definition.capabilities, 'capabilities');
  if (!Object.keys(capabilities).length) throw new SingularityFlowError('capabilities must define at least one node.');
  for (const [id, capability] of Object.entries(capabilities)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new SingularityFlowError(`Capability '${id}' must be lower-case kebab-case.`);
    object(capability, `Capability '${id}'`);
    if (!capability.kind || typeof capability.kind !== 'string') throw new SingularityFlowError(`Capability '${id}' requires kind.`);
    if (capability.parent != null && !capabilities[capability.parent]) throw new SingularityFlowError(`Capability '${id}' references unknown parent '${capability.parent}'.`);
    uniqueStrings(capability.owns, `Capability '${id}'.owns`);
    foldCapabilityPolicy({}, capability.policy ?? {});
  }
  const roots = Object.entries(capabilities).filter(([, capability]) => capability.parent == null).map(([id]) => id);
  if (roots.length !== 1) throw new SingularityFlowError(`Capability tree requires exactly one root; found ${roots.length}.`);
  for (const id of Object.keys(capabilities)) {
    const visited = new Set();
    let cursor = id;
    while (cursor) {
      if (visited.has(cursor)) throw new SingularityFlowError(`Capability tree contains a cycle at '${cursor}'.`);
      visited.add(cursor);
      cursor = capabilities[cursor]?.parent ?? null;
    }
  }
  return definition;
}

export async function loadCapabilities(root, { required = false } = {}) {
  const file = path.join(root, CAPABILITIES_PATH);
  if (!(await exists(file))) {
    if (required) throw new SingularityFlowError(`Missing ${CAPABILITIES_PATH}.`);
    return null;
  }
  return validateCapabilities(YAML.parse(await readFile(file, 'utf8')));
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
