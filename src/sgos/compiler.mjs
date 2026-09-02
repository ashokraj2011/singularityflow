/**
 * Deterministic SGOS Workflow IR -> GVM Program compiler.
 *
 * This module deliberately has no clock, random, filesystem, network, model, or
 * environment dependency. A Program is a function only of a confirmed Intent IR,
 * a ratified Workflow IR, and the exact policy/registry/storage snapshot digests.
 */
import { canonicalJson, recordSha256 } from '../records.mjs';
import {
  GVM_OPCODES as CONTRACT_GVM_OPCODES,
  createGvmProgram,
  validateGvmProgram,
  validateIntentIr,
  validateWorkflowIr,
  validateWorkflowRatification
} from './contracts.mjs';
import { compareSgosCodePoints as codePointCompare } from './order.mjs';
import { canonicalSgosJoins } from './joins.mjs';
import { canonicalSgosResourceEntries } from './resource-contracts.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import {
  normalizeSgosFanout, sgosFanoutChildTemplateId
} from './fanout.mjs';
import {
  assertSgosCapabilityPackOperations, capabilityPackAuthoritiesForCompilation,
  loadApprovedSgosCapabilityPackAuthority, sgosCapabilityPackAuthoritiesSha256,
  sgosCapabilityPackRepositoryBinding
} from './capability-pack-authority.mjs';
import { simulateSgosProgramAssurance } from './simulation.mjs';

export const SGOS_COMPILER_ID = 'sflow-gvm-compiler';
export const SGOS_COMPILER_VERSION = '3';

export const GVM_OPCODES = CONTRACT_GVM_OPCODES;

const GVM_OPCODE_SET = new Set(GVM_OPCODES);
const RUNTIME_UNSUPPORTED_OPCODES = new Set(['MERGE', 'SPAWN', 'COMPENSATE']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const CONSTRUCT_OPCODE = Object.freeze({
  task: 'KERNEL',
  kernel: 'KERNEL',
  agent: 'AGENT',
  device: 'DEVICE',
  verify: 'VERIFY',
  'human-request': 'HUMAN_REQUEST',
  human_request: 'HUMAN_REQUEST',
  join: 'JOIN',
  merge: 'MERGE',
  checkpoint: 'CHECKPOINT',
  foreach: 'SPAWN',
  'bounded-loop': 'SPAWN',
  loop: 'SPAWN',
  subprocess: 'SPAWN',
  spawn: 'SPAWN',
  compensation: 'COMPENSATE',
  compensate: 'COMPENSATE',
  sequence: 'NOOP',
  parallel: 'NOOP',
  condition: 'MERGE',
  noop: 'NOOP',
  end: 'END'
});

const NON_MATERIAL_OPCODES = new Set(['CHECKPOINT', 'NOOP', 'JOIN', 'END']);
const CONFIRMED_PROVENANCE = new Set([
  'explicit',
  'human-confirmed',
  'source-imported',
  'policy-derived',
  'domain-derived',
  'deterministic-derived',
  'defaulted',
  'reverse-converged'
]);

const CLAUSE_FIELDS = Object.freeze([
  'objective',
  'outcomes',
  'successCriteria',
  'constraints',
  'invariants',
  'preferences',
  'nonGoals',
  'assumptions',
  'unknowns',
  'contradictions',
  'risks',
  'evidenceExpectations',
  'authorityRequirements',
  'budgets'
]);

export class SgosCompilerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SgosCompilerError';
    this.code = code;
    this.details = details;
  }
}

// Compatibility spelling for callers that capitalize the initialism.
export const SGOSCompilerError = SgosCompilerError;

function fail(code, message, details = {}) {
  throw new SgosCompilerError(code, message, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

function present(value) {
  if (value == null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(present);
  if (plainObject(value)) return Object.values(value).some(present);
  return true;
}

function canonicalCompare(left, right) {
  const a = typeof left === 'string' ? left : canonicalJson(left);
  const b = typeof right === 'string' ? right : canonicalJson(right);
  return codePointCompare(a, b);
}

function sortedUniqueStrings(values) {
  return [...new Set((values ?? [])
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => value != null && String(value).trim())
    .map((value) => String(value).trim()))].sort(codePointCompare);
}

function sha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function hashableRecord(value, hashFields) {
  const copy = clone(value);
  for (const field of [...hashFields, 'recordSha256']) delete copy[field];
  return copy;
}

function recordDigest(value, field, label) {
  const actual = sha256(hashableRecord(value, [field]));
  const supplied = value?.[field];
  if (supplied != null && supplied !== actual) {
    fail('SGOS_CONTENT_HASH_MISMATCH', `${label} ${field} does not match its canonical content.`, {
      field, expected: actual, received: supplied
    });
  }
  return actual;
}

function requireDigest(value, label) {
  if (!SHA256.test(String(value ?? ''))) {
    fail('SGOS_PINNED_DIGEST_REQUIRED', `${label} must be an exact sha256: digest.`, {
      field: label, received: value ?? null
    });
  }
  return String(value);
}

function validateCompileContract(record, validator, label, code) {
  try {
    return validator(record);
  } catch (error) {
    fail(code, `${label} violates its strict SGOS v1 contract: ${error.message}`, {
      causeCode: error?.code ?? null
    });
  }
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== '');
}

function normalizeRequest(request) {
  if (!plainObject(request)) fail('SGOS_COMPILE_INPUT_INVALID', 'Compiler input must be an object.');
  const intentIr = request.intentIr ?? request.intent;
  const workflow = request.workflow ?? request.workflowIr;
  const ratification = request.ratification ?? request.workflowRatification;
  const pins = request.pins ?? request.pinnedPolicyDigests ?? {};
  const registrySnapshot = plainObject(request.registrySnapshot) ? request.registrySnapshot : null;

  return {
    intentIr,
    workflow,
    ratification,
    registrySnapshot,
    policySnapshotSha256: firstValue(
      request.policySnapshotSha256, pins.policySnapshotSha256, pins.policy, workflow?.policySnapshotSha256
    ),
    registrySnapshotSha256: firstValue(
      request.registrySnapshotSha256,
      pins.registrySnapshotSha256,
      pins.registry,
      registrySnapshot?.registrySnapshotSha256,
      registrySnapshot?.snapshotSha256
    ),
    storageProfileSha256: firstValue(
      request.storageProfileSha256,
      pins.storageProfileSha256,
      pins.storage,
      workflow?.storageProfileSha256
    ),
    capabilityPackAuthority: request.capabilityPackAuthority ?? null,
    intentWorkflowMap: request.intentWorkflowMap ?? null
  };
}

function ratificationDecision(ratification) {
  if (ratification.ratified === true || ratification.approved === true) return 'ratified';
  return String(ratification.decision ?? ratification.status ?? '').trim().toLowerCase();
}

function ratificationBinding(ratification, names) {
  for (const name of names) if (ratification[name] != null) return ratification[name];
  const bindings = ratification.bindings ?? ratification.approvedBindings ?? {};
  for (const name of names) if (bindings[name] != null) return bindings[name];
  return null;
}

function assertRatificationBindings(ratification, expected) {
  const decision = ratificationDecision(ratification);
  if (!['approved', 'ratified', 'accepted'].includes(decision)) {
    fail('SGOS_WORKFLOW_NOT_RATIFIED', 'Workflow compilation requires an approved ratification.', { decision });
  }

  const required = [
    ['intentIrSha256', ['intentIrSha256', 'intentSha256']],
    ['workflowSha256', ['workflowSha256', 'approvedWorkflowSha256']],
    ['policySnapshotSha256', ['policySnapshotSha256', 'policySha256']]
  ];
  for (const [field, aliases] of required) {
    const received = ratificationBinding(ratification, aliases);
    if (received == null) {
      fail('SGOS_RATIFICATION_BINDING_MISSING', `Ratification is missing its exact ${field} binding.`, { field });
    }
    if (received !== expected[field]) {
      fail('SGOS_RATIFICATION_BINDING_MISMATCH', `Ratification ${field} does not match the compiler input.`, {
        field, expected: expected[field], received
      });
    }
  }

  for (const [field, aliases] of [
    ['registrySnapshotSha256', ['registrySnapshotSha256', 'registrySha256']],
    ['storageProfileSha256', ['storageProfileSha256', 'storageSha256']]
  ]) {
    const received = ratificationBinding(ratification, aliases);
    if (received != null && received !== expected[field]) {
      fail('SGOS_RATIFICATION_BINDING_MISMATCH', `Ratification ${field} does not match the compiler input.`, {
        field, expected: expected[field], received
      });
    }
  }
}

function assertRequestCoverageWasRatified(request, workflow, ratification) {
  if (request.intentWorkflowMap == null) return;
  const supplied = canonicalJson(request.intentWorkflowMap);
  const ratifiedSources = [
    ratification.intentWorkflowMap,
    ratification.coverage,
    workflow.intentWorkflowMap,
    workflow.coverage,
    workflow.spec?.intentWorkflowMap,
    workflow.spec?.coverage
  ].filter(plainObject);
  if (!ratifiedSources.some((value) => canonicalJson(value) === supplied)) {
    fail('SGOS_UNRATIFIED_COVERAGE',
      'Compiler-request Intent-to-Workflow coverage must exactly duplicate coverage already bound by the Workflow or ratification.',
      { supplied: request.intentWorkflowMap });
  }
}

function clauseProvenance(value) {
  const provenance = value?.provenance;
  if (typeof provenance === 'string') return provenance;
  if (plainObject(provenance)) return provenance.kind ?? provenance.type ?? provenance.source ?? null;
  return null;
}

function clauseIdentifier(intentIr, field, value, index) {
  const explicit = value?.clauseId ?? value?.id;
  if (explicit != null && String(explicit).trim()) return String(explicit).trim();
  const intentId = String(intentIr.intentId ?? 'intent');
  return field === 'objective' ? `${intentId}:objective` : `${intentId}:${field}:${index + 1}`;
}

function extractConfirmedClauses(intentIr) {
  const clauses = [];
  const ids = new Set();
  for (const field of CLAUSE_FIELDS) {
    const raw = intentIr[field];
    if (raw == null) continue;
    const values = field === 'objective' ? [raw] : Array.isArray(raw) ? raw : [raw];
    values.forEach((value, index) => {
      // Plain budget/evidence maps may be aggregate contracts rather than clauses.
      if (!plainObject(value)) {
        fail('SGOS_INTENT_PROVENANCE_MISSING', `Intent clause '${field}[${index}]' has no field-level provenance.`, {
          field, index
        });
      }
      const provenance = clauseProvenance(value);
      const confirmed = value.confirmed === true || CONFIRMED_PROVENANCE.has(provenance);
      if (provenance === 'model-proposed' && value.confirmed !== true) return;
      if (!confirmed) {
        fail('SGOS_INTENT_PROVENANCE_INVALID', `Intent clause '${field}[${index}]' is not confirmed.`, {
          field, index, provenance: provenance ?? null
        });
      }
      const clauseId = clauseIdentifier(intentIr, field, value, index);
      if (!SAFE_ID.test(clauseId)) {
        fail('SGOS_INTENT_CLAUSE_ID_INVALID', `Intent clause ID '${clauseId}' is invalid.`, { clauseId });
      }
      if (ids.has(clauseId)) fail('SGOS_INTENT_CLAUSE_DUPLICATE', `Intent clause '${clauseId}' is duplicated.`, { clauseId });
      ids.add(clauseId);
      clauses.push({
        clauseId,
        field,
        provenance,
        required: value.required !== false && value.deferred !== true,
        value: clone(value)
      });
    });
  }
  if (!clauses.length) fail('SGOS_INTENT_EMPTY', 'Confirmed Intent IR contains no confirmed clauses.');
  return clauses.sort((a, b) => codePointCompare(a.clauseId, b.clauseId));
}

/** Canonical compiler preflight reused by proposal-only authoring surfaces. */
export function confirmedSgosIntentClauses(intentValue) {
  return deepFreeze(extractConfirmedClauses(validateIntentIr(intentValue)));
}

function rawTaskEntries(workflow) {
  const raw = workflow.spec?.tasks;
  if (Array.isArray(raw)) {
    return raw.map((task, index) => [
      String(task?.taskId ?? task?.id ?? task?.taskTemplateId ?? `task-${String(index + 1).padStart(3, '0')}`),
      task
    ]);
  }
  if (plainObject(raw)) return Object.entries(raw);
  fail('SGOS_WORKFLOW_TASKS_INVALID', 'Workflow spec.tasks must be an object or array.');
}

function inheritedFanoutChild(parent, body) {
  const child = { ...clone(parent), ...clone(body) };
  for (const field of [
    'items', 'body', 'maximumItems', 'maximumParallel', 'maximumIterations',
    'dynamicFanout', 'bounds'
  ]) delete child[field];
  child.kind = body.kind ?? body.type ?? 'task';
  delete child.opcode;
  return child;
}

/** Expand approved inline collections into one finite Program graph before hashing the Program. */
function expandedTaskEntries(workflow) {
  const result = [];
  for (const [taskId, rawTask] of rawTaskEntries(workflow)) {
    const kind = String(rawTask?.kind ?? rawTask?.type ?? 'task').toLowerCase();
    if (kind !== 'foreach') {
      result.push([taskId, rawTask]);
      continue;
    }
    const maximumItems = numericBound(rawTask, 'maximumItems', 'maxItems', 'maximumFanout', 'maximumIterations');
    if (!Number.isInteger(maximumItems) || maximumItems < 0) {
      fail('SGOS_UNBOUNDED_CONSTRUCT', `Task '${taskId}' has unbounded fan-out.`, {
        taskId, construct: kind
      });
    }
    if (!plainObject(rawTask.body)) {
      fail('SGOS_FANOUT_BODY_REQUIRED', `Fan-out '${taskId}' requires one finite body task.`);
    }
    const childKind = String(rawTask.body.kind ?? rawTask.body.type ?? 'task').toLowerCase();
    if (['foreach', 'bounded-loop', 'loop', 'spawn', 'subprocess'].includes(childKind)) {
      fail('SGOS_FANOUT_NESTED_UNSUPPORTED',
        `Fan-out '${taskId}' cannot contain nested dynamic control flow.`, { taskId, childKind });
    }
    const maximumParallel = numericBound(rawTask, 'maximumParallel', 'maxParallel') ?? 1;
    let fanout;
    try {
      fanout = normalizeSgosFanout({
        taskId, items: rawTask.items, maximumItems, maximumParallel
      });
    } catch (error) {
      fail(error?.code ?? 'SGOS_FANOUT_INVALID', error?.message ?? String(error), error?.details ?? {});
    }
    const childIds = [];
    for (const item of fanout.items) {
      const childId = sgosFanoutChildTemplateId(taskId, item.itemKey, item.itemSha256);
      childIds.push(childId);
      const child = inheritedFanoutChild(rawTask, rawTask.body);
      child.dependsOn = clone(rawTask.dependsOn ?? rawTask.after ?? rawTask.predecessors ?? []);
      child.inputs = [
        ...clone(rawTask.body.inputs ?? rawTask.inputs ?? []),
        { fanoutItemKey: item.itemKey, fanoutItemSha256: item.itemSha256 }
      ];
      child.metadata = {
        ...clone(rawTask.metadata ?? {}),
        ...clone(rawTask.body.metadata ?? {}),
        fanout: {
          parentTaskId: taskId,
          itemKey: item.itemKey,
          itemSha256: item.itemSha256,
          itemValue: clone(item.value),
          collectionSha256: fanout.collectionSha256,
          maximumItems: fanout.maximumItems,
          maximumParallel: fanout.maximumParallel
        }
      };
      result.push([childId, child]);
    }
    const coordinator = {
      kind: childIds.length ? 'join' : 'noop',
      dependsOn: childIds,
      material: false,
      intentClauseIds: [],
      metadata: {
        joinPolicy: childIds.length ? 'all-success' : null,
        fanoutCoordinator: {
          parentTaskId: taskId,
          collectionSha256: fanout.collectionSha256,
          maximumItems: fanout.maximumItems,
          maximumParallel: fanout.maximumParallel
        }
      }
    };
    result.push([taskId, coordinator]);
  }
  return result;
}

function registryEntries(snapshot, names) {
  const found = new Map();
  if (!snapshot) return found;
  for (const name of names) {
    const raw = snapshot[name];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.name ?? entry?.kind;
        if (id) found.set(String(id), plainObject(entry) ? entry : { id: String(id) });
      }
    } else if (plainObject(raw)) {
      for (const [id, entry] of Object.entries(raw)) found.set(id, plainObject(entry) ? entry : { id, value: entry });
    }
  }
  return found;
}

const REGISTRY_FIELDS = Object.freeze([
  'kind', 'operations', 'taskKinds', 'devices', 'executionUnits',
  'registrySnapshotSha256'
]);
const REGISTRY_ENTRY_FIELDS = Object.freeze([
  'id', 'version', 'status', 'manifestSha256', 'opcode', 'kind'
]);

function exactRegistryKeys(value, allowed, label) {
  if (!plainObject(value)) fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `${label} must be an object.`);
  const vocabulary = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!vocabulary.has(key)) {
      fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `${label} contains unknown field '${key}'.`, { field: key });
    }
  }
}

function registryCollection(snapshot, field) {
  const source = snapshot[field];
  const entries = [];
  if (Array.isArray(source)) {
    for (const entry of source) entries.push([entry?.id, entry]);
  } else if (plainObject(source)) {
    for (const [id, entry] of Object.entries(source)) entries.push([id, entry]);
  } else {
    fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `Registry snapshot ${field} must be an array or object map.`);
  }
  const seen = new Set();
  for (const [mapId, entry] of entries) {
    exactRegistryKeys(entry, REGISTRY_ENTRY_FIELDS, `registrySnapshot.${field} entry`);
    const id = String(entry.id ?? mapId ?? '').trim();
    if (!SAFE_ID.test(id)) fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `Registry ${field} entry has no stable ID.`, { id });
    if (mapId && entry.id != null && String(mapId) !== id) {
      fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `Registry ${field} map key '${mapId}' does not match entry ID '${id}'.`);
    }
    if (seen.has(id)) fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `Registry ${field} contains duplicate ID '${id}'.`);
    seen.add(id);
    if (typeof entry.version !== 'string' || !entry.version.trim()) {
      fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `Registry ${field} entry '${id}' requires a version.`);
    }
    if (entry.status !== 'active') {
      fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `Registry ${field} entry '${id}' must be active in a compiler snapshot.`);
    }
    requireDigest(entry.manifestSha256, `registrySnapshot.${field}.${id}.manifestSha256`);
    if (entry.opcode != null && !GVM_OPCODE_SET.has(String(entry.opcode).toUpperCase())) {
      fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `Registry ${field} entry '${id}' names unknown opcode '${entry.opcode}'.`);
    }
  }
  return entries;
}

export function registrySnapshotDigest(snapshotValue) {
  if (!plainObject(snapshotValue)) {
    fail('SGOS_REGISTRY_SNAPSHOT_REQUIRED', 'Compilation requires actual registry snapshot content.');
  }
  const snapshot = clone(snapshotValue);
  delete snapshot.registrySnapshotSha256;
  return sha256(snapshot);
}

function validateRegistrySnapshot(snapshotValue, pinnedSha256) {
  if (!plainObject(snapshotValue)) {
    fail('SGOS_REGISTRY_SNAPSHOT_REQUIRED', 'Compilation requires actual registry snapshot content, not only a digest.');
  }
  const snapshot = clone(snapshotValue);
  exactRegistryKeys(snapshot, REGISTRY_FIELDS, 'registrySnapshot');
  if (snapshot.kind !== 'registry-snapshot') {
    fail('SGOS_REGISTRY_SNAPSHOT_INVALID', "registrySnapshot.kind must be 'registry-snapshot'.");
  }
  for (const field of ['operations', 'taskKinds', 'devices']) {
    if (!Object.hasOwn(snapshot, field)) {
      fail('SGOS_REGISTRY_SNAPSHOT_INVALID', `registrySnapshot is missing '${field}'.`, { field });
    }
    registryCollection(snapshot, field);
  }
  if (Object.hasOwn(snapshot, 'executionUnits')) {
    registryCollection(snapshot, 'executionUnits');
  }
  const catalog = registryCatalog(snapshot);
  if (!catalog.operations.size) {
    fail('SGOS_REGISTRY_CATALOG_EMPTY', 'Registry snapshot has no active operation manifests.');
  }
  const actual = registrySnapshotDigest(snapshot);
  if (snapshot.registrySnapshotSha256 !== actual || pinnedSha256 !== actual) {
    fail('SGOS_PINNED_REGISTRY_MISMATCH', 'Registry snapshot content does not match its pinned digest.', {
      expected: actual,
      snapshot: snapshot.registrySnapshotSha256 ?? null,
      pinned: pinnedSha256
    });
  }
  return { snapshot, catalog };
}

/** Validate actual registry-snapshot bytes, including their canonical self digest. */
export function validateSgosRegistrySnapshot(snapshotValue) {
  const pinnedSha256 = requireDigest(
    snapshotValue?.registrySnapshotSha256,
    'registrySnapshot.registrySnapshotSha256'
  );
  return deepFreeze(validateRegistrySnapshot(snapshotValue, pinnedSha256).snapshot);
}

function registryCatalog(snapshot) {
  return {
    taskKinds: registryEntries(snapshot, ['taskKinds', 'tasks', 'taskTypes']),
    operations: registryEntries(snapshot, ['operations', 'kernelOperations', 'domainOperations']),
    devices: registryEntries(snapshot, ['devices', 'deviceKinds', 'deviceManifests']),
    executionUnits: registryEntries(snapshot, ['executionUnits'])
  };
}

function taskKindAndOpcode(task, catalog) {
  const explicitOpcode = task.opcode ?? task.execution?.opcode;
  if (explicitOpcode != null) {
    const opcode = String(explicitOpcode).trim().toUpperCase();
    if (!GVM_OPCODE_SET.has(opcode)) {
      fail('SGOS_OPCODE_UNKNOWN', `Unknown GVM opcode '${explicitOpcode}'.`, { opcode: explicitOpcode });
    }
    const sourceKind = String(task.kind ?? 'task').trim();
    const normalizedKind = sourceKind.toLowerCase();
    if (!CONSTRUCT_OPCODE[normalizedKind] && !GVM_OPCODE_SET.has(sourceKind.toUpperCase())
        && !catalog.taskKinds.has(sourceKind)) {
      fail('SGOS_TASK_KIND_UNKNOWN', `Unknown workflow task kind '${sourceKind}'.`, { taskKind: sourceKind });
    }
    return { sourceKind, opcode };
  }

  const sourceKind = String(task.kind ?? task.type ?? 'task').trim();
  const normalizedKind = sourceKind.toLowerCase();
  if (GVM_OPCODE_SET.has(sourceKind.toUpperCase())) return { sourceKind, opcode: sourceKind.toUpperCase() };
  if (CONSTRUCT_OPCODE[normalizedKind]) return { sourceKind, opcode: CONSTRUCT_OPCODE[normalizedKind] };
  const registered = catalog.taskKinds.get(sourceKind);
  if (registered) {
    const opcode = String(registered.opcode ?? 'KERNEL').toUpperCase();
    if (!GVM_OPCODE_SET.has(opcode)) {
      fail('SGOS_OPCODE_UNKNOWN', `Registered task kind '${sourceKind}' uses unknown opcode '${opcode}'.`, {
        taskKind: sourceKind, opcode
      });
    }
    return { sourceKind, opcode };
  }
  fail('SGOS_TASK_KIND_UNKNOWN', `Unknown workflow task kind '${sourceKind}'.`, { taskKind: sourceKind });
}

function operationContract(task) {
  const raw = task.operation ?? task.operationRef ?? task.taskKind ?? task.execution?.operation ?? null;
  if (typeof raw === 'string') {
    return {
      id: raw,
      version: String(task.operationVersion ?? task.metadata?.operationVersion ?? '1')
    };
  }
  if (plainObject(raw)) {
    const result = clone(raw);
    if (!result.id && result.name) result.id = result.name;
    if (result.version != null) result.version = String(result.version);
    return result;
  }
  return null;
}

function resourceKey(value) {
  if (typeof value === 'string') return value.trim();
  if (plainObject(value)) return String(value.key ?? value.resource ?? value.ref ?? value.id ?? '').trim();
  return '';
}

function normalizeResourceList(value) {
  const items = value == null ? [] : Array.isArray(value) ? value : [value];
  const keyed = new Map();
  for (const item of items) {
    const key = resourceKey(item);
    if (!key) fail('SGOS_RESOURCE_INVALID', 'Resource contracts require stable keys.', { resource: item });
    keyed.set(key, key);
  }
  return [...keyed.values()].sort(codePointCompare);
}

function normalizeResources(task) {
  const resources = plainObject(task.resources) ? task.resources : {};
  return {
    reads: normalizeResourceList(resources.reads ?? task.reads),
    writes: normalizeResourceList(resources.writes ?? task.writes),
    devices: normalizeResourceList(resources.devices ?? task.devices),
    externalEffects: normalizeResourceList(resources.externalEffects ?? task.externalEffects)
  };
}

function numericBound(task, ...names) {
  for (const name of names) {
    const value = task[name] ?? task.bounds?.[name] ?? task.budgets?.[name];
    if (value != null) return Number(value);
  }
  return null;
}

function assertBounded(taskId, task, sourceKind) {
  const kind = String(sourceKind).toLowerCase();
  if (kind === 'foreach' || task.dynamicFanout === true) {
    const maximumItems = numericBound(task, 'maximumItems', 'maxItems', 'maximumFanout', 'maximumIterations');
    if (!Number.isInteger(maximumItems) || maximumItems < 0) {
      fail('SGOS_UNBOUNDED_CONSTRUCT', `Task '${taskId}' has unbounded fan-out.`, { taskId, construct: kind });
    }
  }
  if (kind === 'bounded-loop' || kind === 'loop' || task.while != null || task.repeat === true) {
    const maximumIterations = numericBound(task, 'maximumIterations', 'maxIterations');
    if (!Number.isInteger(maximumIterations) || maximumIterations < 0) {
      fail('SGOS_UNBOUNDED_CONSTRUCT', `Task '${taskId}' has an unbounded loop.`, { taskId, construct: kind });
    }
  }
  const maximumParallel = numericBound(task, 'maximumParallel', 'maxParallel');
  if (maximumParallel != null && (!Number.isInteger(maximumParallel) || maximumParallel < 1)) {
    fail('SGOS_BOUND_INVALID', `Task '${taskId}' maximumParallel must be a positive integer.`, {
      taskId, maximumParallel
    });
  }
}

function taskEvidence(workflow, taskId, task) {
  const global = workflow.spec?.evidence;
  return firstValue(
    task.evidence,
    task.evidenceContract,
    global?.tasks?.[taskId],
    global?.[taskId],
    global?.default,
    plainObject(global) && !global.tasks ? global : null
  );
}

function taskAuthority(workflow, taskId, task) {
  const global = workflow.spec?.authority;
  return firstValue(
    task.authority,
    task.authorityRequirement,
    global?.tasks?.[taskId],
    global?.[taskId],
    global?.default,
    plainObject(global) && !global.tasks ? global : null
  );
}

function taskRecovery(workflow, taskId, task) {
  const global = workflow.spec?.recovery;
  return firstValue(
    task.recovery,
    task.recoveryPolicy,
    global?.tasks?.[taskId],
    global?.[taskId],
    global?.default,
    plainObject(global) && !global.tasks ? global : null
  );
}

function humanJudgment(task, opcode) {
  const verification = task.verification ?? task.metadata?.verification;
  const verificationKind = String(verification?.kind ?? verification?.type ?? '').toLowerCase();
  return opcode === 'HUMAN_REQUEST' || verificationKind === 'human-judgment' || task.requiresHumanJudgment === true;
}

function normalizeRetry(taskId, task) {
  const supplied = task.retry ?? task.retryPolicy;
  if (supplied == null) return { maximumAttempts: 1 };
  if (!plainObject(supplied)) {
    fail('SGOS_RETRY_CEILING_INVALID', `Task '${taskId}' retry contract must be an object.`, { taskId });
  }
  const maximumAttempts = Number(supplied.maximumAttempts ?? supplied.maxAttempts);
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
    fail('SGOS_RETRY_CEILING_REQUIRED',
      `Task '${taskId}' retry contract requires a positive maximumAttempts ceiling.`, {
        taskId, maximumAttempts: supplied.maximumAttempts ?? supplied.maxAttempts ?? null
      });
  }
  const result = clone(supplied);
  delete result.maxAttempts;
  result.maximumAttempts = maximumAttempts;
  return result;
}

function taskTemplate(workflow, taskId, rawTask, catalog) {
  if (!SAFE_ID.test(taskId)) fail('SGOS_TASK_ID_INVALID', `Workflow task ID '${taskId}' is invalid.`, { taskId });
  if (!plainObject(rawTask)) fail('SGOS_WORKFLOW_TASK_INVALID', `Workflow task '${taskId}' must be an object.`, { taskId });
  const task = clone(rawTask);
  const { sourceKind, opcode } = taskKindAndOpcode(task, catalog);
  assertBounded(taskId, task, sourceKind);
  if (task.condition != null || task.when != null) {
    fail('SGOS_CONDITIONAL_EDGE_UNSUPPORTED',
      `Task '${taskId}' declares conditional control flow, which the SGOS v1 runtime does not implement.`, {
        taskId
      });
  }
  if (RUNTIME_UNSUPPORTED_OPCODES.has(opcode)) {
    fail('SGOS_OPCODE_RUNTIME_UNSUPPORTED',
      `Task '${taskId}' uses ${opcode}, which the SGOS v1 runtime does not implement.`, {
        taskId, opcode
      });
  }
  const operation = operationContract(task);
  const operationId = operation?.id == null ? null : String(operation.id);

  if (['KERNEL', 'AGENT', 'DEVICE', 'VERIFY', 'COMPENSATE'].includes(opcode) && !operationId) {
    fail('SGOS_TASK_OPERATION_MISSING', `Task '${taskId}' with opcode ${opcode} has no versioned operation.`, {
      taskId, opcode
    });
  }
  if (operationId && !catalog.operations.has(operationId)) {
    fail('SGOS_TASK_OPERATION_UNKNOWN', `Task '${taskId}' references unknown operation '${operationId}'.`, {
      taskId, operationId
    });
  }
  const registeredOperation = operationId ? catalog.operations.get(operationId) : null;
  if (registeredOperation && operation?.version != null
      && String(operation.version) !== String(registeredOperation.version)) {
    fail('SGOS_TASK_OPERATION_VERSION_MISMATCH',
      `Task '${taskId}' operation '${operationId}' version does not match the pinned registry.`, {
        taskId, operationId,
        expected: String(registeredOperation.version),
        received: String(operation.version)
      });
  }
  const verification = task.verification ?? task.metadata?.verification;
  const verificationOperation = typeof verification?.operation === 'string'
    ? verification.operation
    : verification?.operation?.id ?? verification?.operationId ?? null;
  if (verificationOperation != null && !catalog.operations.has(String(verificationOperation))) {
    fail('SGOS_TASK_OPERATION_UNKNOWN',
      `Task '${taskId}' references unknown verification operation '${verificationOperation}'.`, {
        taskId, operationId: String(verificationOperation), role: 'verification'
      });
  }
  const registeredVerificationOperation = verificationOperation == null
    ? null
    : catalog.operations.get(String(verificationOperation));
  const requestedVerificationVersion = typeof verification?.operation === 'object'
    ? verification.operation.version
    : verification?.operationVersion;
  if (registeredVerificationOperation && requestedVerificationVersion != null
      && String(requestedVerificationVersion) !== String(registeredVerificationOperation.version)) {
    fail('SGOS_TASK_OPERATION_VERSION_MISMATCH',
      `Task '${taskId}' verification operation '${verificationOperation}' version does not match the pinned registry.`, {
        taskId, operationId: String(verificationOperation), role: 'verification',
        expected: String(registeredVerificationOperation.version),
        received: String(requestedVerificationVersion)
      });
  }
  let registeredDevice = null;
  let resolvedDeviceId = null;
  if (opcode === 'DEVICE') {
    // The operation is the registry-pinned action (for example
    // `filesystem.read-file`); the Device is the separately versioned adapter
    // that performs it (for example `filesystem-read`). Workflow IR only
    // permits extension data below metadata, so never require an invalid
    // top-level deviceId field or conflate the two identities.
    resolvedDeviceId = String(
      task.metadata?.deviceId
      ?? task.metadata?.device?.id
      ?? operationId
      ?? ''
    );
    registeredDevice = catalog.devices.get(resolvedDeviceId) ?? null;
    if (!resolvedDeviceId || !registeredDevice) {
      fail('SGOS_DEVICE_UNKNOWN', `Task '${taskId}' references an unknown device.`, {
        taskId, deviceId: resolvedDeviceId || null
      });
    }
  }

  const resources = normalizeResources(task);
  const material = task.material == null ? !NON_MATERIAL_OPCODES.has(opcode) : task.material === true;
  const evidence = taskEvidence(workflow, taskId, task);
  const authority = taskAuthority(workflow, taskId, task);
  const recovery = taskRecovery(workflow, taskId, task);
  if (material && !present(evidence)) {
    fail('SGOS_EVIDENCE_REQUIRED', `Material task '${taskId}' has no evidence contract.`, { taskId });
  }
  if (humanJudgment(task, opcode) && !present(authority)) {
    fail('SGOS_HUMAN_AUTHORITY_REQUIRED', `Task '${taskId}' requires judgment but has no authority contract.`, { taskId });
  }
  if (resources.externalEffects.length && !present(recovery)) {
    fail('SGOS_EXTERNAL_EFFECT_RECOVERY_REQUIRED', `Task '${taskId}' has external effects but no recovery contract.`, {
      taskId, externalEffects: resources.externalEffects.map(resourceKey)
    });
  }

  const metadata = {
    ...clone(task.metadata ?? {}),
    sourceConstruct: String(sourceKind).toLowerCase()
  };
  if (registeredOperation) {
    metadata.operationVersion = String(registeredOperation.version);
    metadata.operationManifestSha256 = registeredOperation.manifestSha256;
  }
  if (task.verification != null) metadata.verification = clone(task.verification);
  if (registeredVerificationOperation) {
    metadata.verificationOperationVersion = String(registeredVerificationOperation.version);
    metadata.verificationOperationManifestSha256 = registeredVerificationOperation.manifestSha256;
  }
  if (task.budgets != null) metadata.budgets = clone(task.budgets);
  if (task.parameters != null || task.arguments != null) metadata.parameters = clone(task.parameters ?? task.arguments);
  // Adapter identity is distinct from the operation name. Preserve it in the immutable Program
  // so runtime admission can bind an AGENT/DEVICE task to one installed, reviewed manifest rather
  // than guessing from prose or ambient provider configuration. The operation remains the
  // registry-pinned action exposed by that adapter.
  if (opcode === 'AGENT') {
    // Execution Unit identity is deliberately separate from operation
    // identity. Both are immutable Program inputs: the registry binds the
    // operation while the installed-adapter admission check binds this exact
    // manifest before dispatch. Keeping the adapter declaration in metadata
    // also respects the strict Workflow IR vocabulary.
    const declaredUnit = plainObject(task.metadata?.executionUnit)
      ? task.metadata.executionUnit : {};
    const executionUnitId = task.metadata?.executionUnitId ?? declaredUnit.id;
    const registeredExecutionUnit = executionUnitId == null
      ? null : catalog.executionUnits.get(String(executionUnitId));
    if (!executionUnitId || !registeredExecutionUnit) {
      fail('SGOS_EXECUTION_UNIT_BINDING_REQUIRED',
        `Task '${taskId}' requires an Execution Unit from the pinned registry.`, {
          taskId, executionUnitId: executionUnitId ?? null
        });
    }
    const requestedVersion = task.metadata?.executionUnitVersion ?? declaredUnit.version;
    const requestedManifestSha256 = task.metadata?.executionUnitManifestSha256
      ?? declaredUnit.manifestSha256;
    if (requestedVersion != null
        && String(requestedVersion) !== String(registeredExecutionUnit.version)) {
      fail('SGOS_EXECUTION_UNIT_VERSION_MISMATCH',
        `Task '${taskId}' Execution Unit version does not match the pinned registry.`, {
          taskId, executionUnitId: String(executionUnitId),
          expected: String(registeredExecutionUnit.version), received: String(requestedVersion)
        });
    }
    if (requestedManifestSha256 != null
        && requestedManifestSha256 !== registeredExecutionUnit.manifestSha256) {
      fail('SGOS_EXECUTION_UNIT_MANIFEST_MISMATCH',
        `Task '${taskId}' Execution Unit manifest does not match the pinned registry.`, {
          taskId, executionUnitId: String(executionUnitId),
          expected: registeredExecutionUnit.manifestSha256,
          received: requestedManifestSha256
        });
    }
    metadata.executionUnitId = String(executionUnitId);
    metadata.executionUnitVersion = String(registeredExecutionUnit.version);
    metadata.executionUnitManifestSha256 = registeredExecutionUnit.manifestSha256;
    delete metadata.executionUnit;
  }
  if (opcode === 'DEVICE') {
    metadata.deviceId = resolvedDeviceId;
    metadata.deviceVersion = String(registeredDevice.version);
    metadata.deviceManifestSha256 = registeredDevice.manifestSha256;
  }
  if (task.condition != null || task.when != null) metadata.condition = clone(task.condition ?? task.when);
  if (task.bounds != null) metadata.bounds = clone(task.bounds);
  if (task.joinPolicy != null) metadata.joinPolicy = clone(task.joinPolicy);
  // Strict Workflow IR carries construct-specific data only under metadata. Reading a top-level
  // humanRequest/request here advertised an input shape the contract had already (correctly)
  // refused, so keep the compiler and the public contract on one canonical representation.
  if (task.metadata?.humanRequest != null) metadata.humanRequest = clone(task.metadata.humanRequest);
  if (task.compilerInvariant != null || task.insertedByCompiler != null) {
    metadata.compilerInvariant = clone(task.compilerInvariant ?? task.insertedByCompiler);
  }

  const template = {
    taskTemplateId: taskId,
    opcode,
    dependsOn: sortedUniqueStrings(task.dependsOn ?? task.after ?? task.predecessors),
    inputs: clone(task.inputs ?? task.inputRefs ?? []),
    outputs: clone(task.outputs ?? task.outputRefs ?? []),
    resources,
    evidence: clone(evidence ?? {}),
    authority: clone(authority ?? {}),
    recovery: clone(recovery ?? {}),
    retry: normalizeRetry(taskId, task),
    policySnapshotSha256: workflow.policySnapshotSha256,
    intentClauseIds: sortedUniqueStrings(task.intentClauseIds ?? task.clauseIds ?? task.mappedIntentClauseIds),
    material,
    metadata
  };
  if (operationId) template.operation = operationId;
  if (task.timeoutMs != null) template.timeoutMs = Number(task.timeoutMs);
  return template;
}

function assertCompileCeilings(workflow, templates) {
  const budgets = workflow.spec?.budgets ?? {};
  const maximumTasks = Number(budgets.maximumTasks);
  if (!Number.isSafeInteger(maximumTasks) || maximumTasks < 1) {
    fail('SGOS_MAXIMUM_TASKS_REQUIRED',
      'Workflow budgets require a positive maximumTasks compile-time ceiling.', {
        maximumTasks: budgets.maximumTasks ?? null
      });
  }
  if (templates.length > maximumTasks) {
    fail('SGOS_MAXIMUM_TASKS_EXCEEDED',
      `Workflow contains ${templates.length} tasks, exceeding maximumTasks ${maximumTasks}.`, {
        taskCount: templates.length, maximumTasks
      });
  }
  const fanoutGroups = new Set(templates.flatMap((task) => {
    const metadata = task.metadata?.fanout ?? task.metadata?.fanoutCoordinator;
    return metadata?.parentTaskId ? [metadata.parentTaskId] : [];
  }));
  if (fanoutGroups.size > SGOS_INSTALLED_LIMITS.maximumFanoutGroupsPerProcess) {
    fail('SGOS_FANOUT_LIMIT',
      'Workflow fan-out groups cannot fit the initial durable expansion boundary.', {
        actual: fanoutGroups.size,
        maximum: SGOS_INSTALLED_LIMITS.maximumFanoutGroupsPerProcess
      });
  }

  const rawMaximumAttempts = budgets.maximumAttemptsPerTask ?? budgets.maximumAttempts;
  const maximumAttempts = Number(rawMaximumAttempts);
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
    fail('SGOS_RETRY_CEILING_REQUIRED',
      'Workflow budgets require a positive maximumAttempts retry ceiling.', {
        maximumAttempts: rawMaximumAttempts ?? null
      });
  }
  for (const task of templates) {
    try { canonicalSgosResourceEntries(task.resources); } catch (error) {
      fail(error?.code ?? 'SGOS_RESOURCE_LEASE_LIMIT',
        `Task '${task.taskTemplateId}' cannot fit one installed resource lease.`, {
          taskId: task.taskTemplateId,
          cause: error?.message ?? String(error),
          ...(error?.details ?? {})
        });
    }
    const taskMaximumAttempts = Number(task.retry?.maximumAttempts);
    if (!Number.isSafeInteger(taskMaximumAttempts) || taskMaximumAttempts < 1) {
      fail('SGOS_RETRY_CEILING_REQUIRED',
        `Task '${task.taskTemplateId}' has no positive maximumAttempts retry ceiling.`, {
          taskId: task.taskTemplateId, maximumAttempts: task.retry?.maximumAttempts ?? null
        });
    }
    if (taskMaximumAttempts > maximumAttempts) {
      fail('SGOS_RETRY_CEILING_EXCEEDED',
        `Task '${task.taskTemplateId}' maximumAttempts ${taskMaximumAttempts} exceeds workflow ceiling ${maximumAttempts}.`, {
          taskId: task.taskTemplateId, maximumAttempts: taskMaximumAttempts,
          workflowMaximumAttempts: maximumAttempts
        });
    }
  }
}

function normalizeEdge(raw, source = 'workflow') {
  if (Array.isArray(raw) && raw.length >= 2) {
    if (raw.length > 2 && raw[2] != null) {
      fail('SGOS_CONDITIONAL_EDGE_UNSUPPORTED',
        'Conditional workflow edges are not supported by the SGOS v1 runtime.', { edge: raw });
    }
    return { from: String(raw[0]), to: String(raw[1]), source };
  }
  if (!plainObject(raw)) fail('SGOS_EDGE_INVALID', 'Workflow edges must be objects or [from,to] pairs.', { edge: raw });
  if (raw.condition != null) {
    fail('SGOS_CONDITIONAL_EDGE_UNSUPPORTED',
      'Conditional workflow edges are not supported by the SGOS v1 runtime.', { edge: raw });
  }
  const from = raw.from ?? raw.predecessor ?? raw.source ?? raw.sourceTaskId;
  const to = raw.to ?? raw.successor ?? raw.target ?? raw.targetTaskId;
  if (!from || !to) fail('SGOS_EDGE_INVALID', 'Workflow edge requires from and to task IDs.', { edge: raw });
  return { from: String(from), to: String(to), source: raw.sourceKind ?? source };
}

function buildEdges(workflow, templates) {
  const ids = new Set(templates.map((task) => task.taskTemplateId));
  const edges = [];
  for (const task of templates) {
    for (const predecessor of task.dependsOn) edges.push({ from: predecessor, to: task.taskTemplateId, source: 'dependsOn' });
  }
  for (const raw of workflow.spec?.edges ?? workflow.edges ?? []) edges.push(normalizeEdge(raw));

  const sequences = workflow.spec?.sequences ?? workflow.spec?.sequence ?? [];
  const sequenceGroups = Array.isArray(sequences) && sequences.every((value) => typeof value === 'string')
    ? [sequences]
    : Array.isArray(sequences) ? sequences : [];
  for (const group of sequenceGroups) {
    const members = Array.isArray(group) ? group : group?.tasks ?? group?.steps ?? [];
    for (let index = 1; index < members.length; index += 1) {
      edges.push({ from: String(members[index - 1]), to: String(members[index]), source: 'sequence' });
    }
  }

  const unique = new Map();
  for (const edge of edges) {
    if (edge.condition != null) {
      fail('SGOS_CONDITIONAL_EDGE_UNSUPPORTED',
        'Conditional workflow edges are not supported by the SGOS v1 runtime.', { edge });
    }
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      fail('SGOS_EDGE_TASK_UNKNOWN', `Workflow edge '${edge.from}' -> '${edge.to}' references an unknown task.`, {
        edge, knownTaskIds: [...ids].sort(codePointCompare)
      });
    }
    if (edge.from === edge.to) fail('SGOS_GRAPH_CYCLE', `Task '${edge.from}' depends on itself.`, { taskId: edge.from });
    const key = `${edge.from}\u0000${edge.to}\u0000${sha256(edge.condition ?? null)}`;
    unique.set(key, {
      from: edge.from,
      to: edge.to,
      ...(edge.condition != null ? { condition: clone(edge.condition) } : {})
    });
  }
  return [...unique.values()].sort((a, b) =>
    codePointCompare(a.from, b.from)
    || codePointCompare(a.to, b.to)
    || canonicalCompare(a.condition ?? null, b.condition ?? null));
}

function joinsForProgram(workflow, templates) {
  const raw = workflow.spec?.joins ?? {};
  const configured = new Map(Object.entries(raw));
  const joins = [];
  for (const template of templates.filter((entry) => entry.opcode === 'JOIN')) {
    const supplied = configured.get(template.taskTemplateId) ?? {};
    configured.delete(template.taskTemplateId);
    if (!plainObject(supplied)) {
      fail('SGOS_JOIN_INVALID', `Join '${template.taskTemplateId}' contract must be an object.`);
    }
    const metadataPolicy = template.metadata?.joinPolicy;
    const policy = supplied.policy ?? supplied.mode
      ?? (typeof metadataPolicy === 'string' ? metadataPolicy : metadataPolicy?.policy)
      ?? (typeof metadataPolicy === 'object' ? metadataPolicy?.mode : null);
    joins.push({
      joinId: String(supplied.joinId ?? template.taskTemplateId),
      taskTemplateId: template.taskTemplateId,
      policy,
      predecessorTaskTemplateIds: [...template.dependsOn]
    });
  }
  if (configured.size) {
    fail('SGOS_JOIN_TASK_UNKNOWN', 'Workflow join contracts must name an installed JOIN task.', {
      joinIds: [...configured.keys()].sort(codePointCompare)
    });
  }
  try { return canonicalSgosJoins(joins); } catch (error) {
    fail(error?.code ?? 'SGOS_JOIN_INVALID', error?.message ?? String(error), error?.details ?? {});
  }
}

function graphFacts(templates, edges) {
  const ids = templates.map((task) => task.taskTemplateId).sort(codePointCompare);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const forward = new Map(ids.map((id) => [id, []]));
  const reverse = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    forward.get(edge.from).push(edge.to);
    reverse.get(edge.to).push(edge.from);
  }
  for (const values of [...forward.values(), ...reverse.values()]) values.sort(codePointCompare);
  const queue = ids.filter((id) => indegree.get(id) === 0).sort(codePointCompare);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of forward.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort(codePointCompare);
      }
    }
  }
  if (order.length !== ids.length) {
    const cycleTaskIds = ids.filter((id) => !order.includes(id));
    fail('SGOS_GRAPH_CYCLE', `Workflow dependency graph contains a cycle involving ${cycleTaskIds.join(', ')}.`, {
      cycleTaskIds
    });
  }
  return {
    ids,
    order,
    roots: ids.filter((id) => reverse.get(id).length === 0),
    leaves: ids.filter((id) => forward.get(id).length === 0),
    forward,
    reverse
  };
}

function reachableFrom(start, adjacency) {
  const seen = new Set();
  const queue = [...start].sort(codePointCompare);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adjacency.get(id) ?? []) if (!seen.has(next)) queue.push(next);
    queue.sort(codePointCompare);
  }
  return seen;
}

function assertTerminalReachability(templates, graph) {
  const ends = templates.filter((task) => task.opcode === 'END')
    .map((task) => task.taskTemplateId)
    .sort(codePointCompare);
  if (!ends.length) fail('SGOS_TERMINAL_UNREACHABLE', 'Workflow has no END task.');
  for (const end of ends) {
    if (graph.forward.get(end).length) {
      fail('SGOS_TERMINAL_UNREACHABLE', `END task '${end}' has successors and is not terminal.`, {
        taskId: end, successors: graph.forward.get(end)
      });
    }
  }
  const canReachEnd = reachableFrom(ends, graph.reverse);
  const stranded = templates
    .filter((task) => task.opcode !== 'END' && !canReachEnd.has(task.taskTemplateId))
    .map((task) => task.taskTemplateId)
    .sort(codePointCompare);
  if (stranded.length) {
    fail('SGOS_TERMINAL_UNREACHABLE', `Workflow tasks cannot reach an END task: ${stranded.join(', ')}.`, {
      taskIds: stranded, endTaskIds: ends
    });
  }
  return ends;
}

function verificationOperationId(task) {
  const verification = task.metadata?.verification;
  if (typeof verification === 'string') return verification;
  if (typeof verification?.operation === 'string') return verification.operation;
  if (typeof verification?.operation?.id === 'string') return verification.operation.id;
  return verification?.operationId == null ? null : String(verification.operationId);
}

function assertCopilotProposalGates(templates, graph) {
  const byId = new Map(templates.map((task) => [task.taskTemplateId, task]));
  for (const proposal of templates.filter((task) =>
    task.opcode === 'AGENT' && task.metadata?.executionUnitId === 'copilot-cli')) {
    const resources = proposal.resources ?? {};
    if (['reads', 'writes', 'devices', 'externalEffects']
      .some((field) => (resources[field]?.length ?? 0) !== 0)) {
      fail('SGOS_COPILOT_PROPOSAL_SCOPE_UNSUPPORTED',
        `Copilot proposal task '${proposal.taskTemplateId}' cannot receive repository, Device, or effect scope.`, {
          taskId: proposal.taskTemplateId
        });
    }
    const successors = graph.forward.get(proposal.taskTemplateId) ?? [];
    const gates = successors.map((taskId) => byId.get(taskId));
    if (!gates.length || gates.some((gate) => gate?.opcode !== 'VERIFY')) {
      fail('SGOS_COPILOT_PROPOSAL_VERIFY_REQUIRED',
        `Copilot proposal task '${proposal.taskTemplateId}' must flow directly and exclusively through explicit VERIFY gates.`, {
          taskId: proposal.taskTemplateId, successorTaskIds: successors
        });
    }
    for (const gate of gates) {
      const verifier = verificationOperationId(gate);
      if (gate.material !== true || !gate.operation || !verifier
          || gate.operation === proposal.operation
          || verifier === proposal.operation || verifier === gate.operation) {
        fail('SGOS_COPILOT_PROPOSAL_VERIFY_REQUIRED',
          `VERIFY gate '${gate.taskTemplateId}' is not explicitly independent from Copilot proposal '${proposal.taskTemplateId}'.`, {
            taskId: proposal.taskTemplateId,
            verifyTaskId: gate.taskTemplateId,
            proposalOperation: proposal.operation ?? null,
            verifyOperation: gate.operation ?? null,
            verifierOperation: verifier
          });
      }
    }
  }
}

function normalizedResourcePrefix(value) {
  const key = resourceKey(value).replace(/\\/g, '/').replace(/\/(?:\*\*|\*)$/, '').replace(/\/$/, '');
  return key;
}

function resourceOverlap(left, right) {
  const a = normalizedResourcePrefix(left);
  const b = normalizedResourcePrefix(right);
  if (!a || !b) return false;
  if (a === '*' || b === '*') return true;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function pathExists(from, to, graph) {
  if (from === to) return true;
  const queue = [...(graph.forward.get(from) ?? [])];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(graph.forward.get(id) ?? []));
  }
  return false;
}

function conflictKeys(left, right) {
  const conflicts = [];
  const check = (leftValues, rightValues, type) => {
    for (const a of leftValues) for (const b of rightValues) {
      if (resourceOverlap(a, b)) conflicts.push({ type, left: resourceKey(a), right: resourceKey(b) });
    }
  };
  check(left.resources.writes, right.resources.writes, 'write/write');
  check(left.resources.writes, right.resources.reads, 'write/read');
  check(left.resources.reads, right.resources.writes, 'read/write');
  check(left.resources.devices, right.resources.devices, 'device/device');
  check(left.resources.externalEffects, right.resources.externalEffects, 'effect/effect');
  return conflicts.sort((a, b) => canonicalCompare(a, b));
}

function declaredSafeConcurrency(left, right, conflicts) {
  const leftResources = left.resources ?? {};
  const rightResources = right.resources ?? {};
  const isolationLeft = leftResources.isolationKey ?? left.isolationKey ?? left.workspaceIsolation;
  const isolationRight = rightResources.isolationKey ?? right.isolationKey ?? right.workspaceIsolation;
  if (isolationLeft && isolationRight && isolationLeft !== isolationRight) return true;
  const commutativeLeft = leftResources.commutativityKey ?? left.commutativityKey;
  const commutativeRight = rightResources.commutativityKey ?? right.commutativityKey;
  if ((leftResources.commutative === true && rightResources.commutative === true)
      || (commutativeLeft && commutativeLeft === commutativeRight)) return true;
  const reducerLeft = leftResources.reducer ?? left.deterministicReducer;
  const reducerRight = rightResources.reducer ?? right.deterministicReducer;
  if (reducerLeft && reducerLeft === reducerRight) return true;
  const leasesLeft = normalizeResourceList(leftResources.leases ?? left.leaseKeys ?? []);
  const leasesRight = normalizeResourceList(rightResources.leases ?? right.leaseKeys ?? []);
  return conflicts.every((conflict) => leasesLeft.some((value) => resourceOverlap(value, conflict.left))
    && leasesRight.some((value) => resourceOverlap(value, conflict.right)));
}

function assertParallelSafety(templates, graph) {
  for (let leftIndex = 0; leftIndex < templates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < templates.length; rightIndex += 1) {
      const left = templates[leftIndex];
      const right = templates[rightIndex];
      if (pathExists(left.taskTemplateId, right.taskTemplateId, graph)
          || pathExists(right.taskTemplateId, left.taskTemplateId, graph)) continue;
      const conflicts = conflictKeys(left, right);
      if (conflicts.length && !declaredSafeConcurrency(left, right, conflicts)) {
        fail('SGOS_PARALLEL_WRITE_CONFLICT',
          `Tasks '${left.taskTemplateId}' and '${right.taskTemplateId}' may run concurrently with incompatible resources.`, {
            leftTaskId: left.taskTemplateId,
            rightTaskId: right.taskTemplateId,
            conflicts
          });
      }
    }
  }
}

function normalizeMappingEntry(value, knownTaskIds, fallbackKind = null) {
  if (typeof value === 'string') {
    return knownTaskIds.has(value)
      ? { kind: 'task', targetId: value }
      : { kind: fallbackKind ?? value, targetId: null };
  }
  if (!plainObject(value)) return null;
  const target = plainObject(value.target) ? value.target : value;
  const targetId = firstValue(
    target.targetId, target.taskId, target.workflowTaskId, target.id,
    typeof value.target === 'string' ? value.target : null
  );
  let kind = firstValue(target.targetKind, target.targetType, target.kind, target.type, value.mappingKind, fallbackKind);
  if (!kind && targetId && knownTaskIds.has(String(targetId))) kind = 'task';
  return { kind: String(kind ?? 'unknown'), targetId: targetId == null ? null : String(targetId), raw: clone(value) };
}

function collectCoverageMaps(workflow, ratification, templates, clauses) {
  const knownTaskIds = new Set(templates.map((task) => task.taskTemplateId));
  const knownClauseIds = new Set(clauses.map((clause) => clause.clauseId));
  const byClause = new Map(clauses.map((clause) => [clause.clauseId, []]));
  const byTask = new Map(templates.map((task) => [task.taskTemplateId, []]));
  const sources = [
    ratification.intentWorkflowMap,
    ratification.coverage,
    workflow.intentWorkflowMap,
    workflow.coverage,
    workflow.spec?.intentWorkflowMap,
    workflow.spec?.coverage
  ].filter(plainObject);

  const addClause = (clauseId, raw) => {
    if (!knownClauseIds.has(String(clauseId))) return;
    const entries = (Array.isArray(raw) ? raw : [raw])
      .map((entry) => normalizeMappingEntry(entry, knownTaskIds))
      .filter(Boolean);
    byClause.get(String(clauseId)).push(...entries);
    for (const entry of entries) {
      if (entry.kind === 'task' && entry.targetId && knownTaskIds.has(entry.targetId)) {
        byTask.get(entry.targetId).push({ kind: 'intent-clause', sourceId: String(clauseId) });
      }
    }
  };
  const addTask = (taskId, raw) => {
    if (!knownTaskIds.has(String(taskId))) return;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value === 'string' && knownClauseIds.has(value)) {
        byTask.get(String(taskId)).push({ kind: 'intent-clause', sourceId: value });
        byClause.get(value).push({ kind: 'task', targetId: String(taskId) });
      } else {
        const entry = normalizeMappingEntry(value, knownTaskIds, 'compiler-invariant');
        if (entry) byTask.get(String(taskId)).push({ kind: entry.kind, sourceId: entry.targetId, raw: entry.raw });
      }
    }
  };

  for (const map of sources) {
    if (plainObject(map.clauses)) for (const [clauseId, targets] of Object.entries(map.clauses)) addClause(clauseId, targets);
    if (plainObject(map.tasks)) for (const [taskId, refs] of Object.entries(map.tasks)) addTask(taskId, refs);
    for (const raw of [map.mappings, map.clauseMappings, map.intentToWorkflow].filter(Array.isArray)) {
      for (const mapping of raw) {
        const clauseId = mapping?.clauseId ?? mapping?.intentClauseId ?? mapping?.sourceId;
        const taskId = mapping?.taskId ?? mapping?.targetTaskId;
        if (clauseId) addClause(clauseId, mapping.targets ?? mapping.target ?? mapping);
        if (taskId && clauseId) addTask(taskId, clauseId);
      }
    }
  }
  for (const task of templates) for (const clauseId of task.intentClauseIds) addTask(task.taskTemplateId, clauseId);

  for (const values of [...byClause.values(), ...byTask.values()]) {
    const unique = new Map(values.map((value) => [sha256(value), value]));
    values.splice(0, values.length, ...[...unique.values()].sort(canonicalCompare));
  }
  return { byClause, byTask };
}

function assertCoverage(clauses, templates, coverage) {
  const allowedTargets = new Set([
    'workflow-output', 'output', 'task', 'gate', 'human-decision', 'human-request',
    'evidence-contract', 'explicit-non-goal', 'non-goal', 'approved-deferment', 'deferment'
  ]);
  for (const clause of clauses.filter((entry) => entry.required)) {
    const mappings = coverage.byClause.get(clause.clauseId) ?? [];
    const valid = mappings.some((mapping) => allowedTargets.has(mapping.kind)
      && (mapping.kind !== 'task' || mapping.targetId));
    if (!valid) {
      fail('SGOS_INTENT_CLAUSE_UNMAPPED', `Required intent clause '${clause.clauseId}' is not mapped to the workflow.`, {
        clauseId: clause.clauseId, field: clause.field
      });
    }
  }

  const allowedSources = new Set([
    'intent-clause', 'policy', 'domain-law', 'domain', 'verification', 'recovery',
    'compiler-invariant', 'explicit-non-goal', 'approved-deferment'
  ]);
  for (const task of templates.filter((entry) => entry.material)) {
    const mappings = coverage.byTask.get(task.taskTemplateId) ?? [];
    if (!mappings.some((mapping) => allowedSources.has(mapping.kind))) {
      fail('SGOS_ORPHAN_TASK', `Material task '${task.taskTemplateId}' has no intent, policy, law, verification, recovery, or compiler-invariant source.`, {
        taskId: task.taskTemplateId
      });
    }
  }
}

function compilerExplanation(program, graph = null) {
  const facts = graph ?? graphFacts(program.taskTemplates, program.edges);
  const terminalTaskIds = program.taskTemplates.filter((task) => task.opcode === 'END')
    .map((task) => task.taskTemplateId).sort(codePointCompare);
  return deepFreeze({
    kind: 'gvm-program-explanation',
    programId: program.programId,
    programSha256: program.programSha256,
    compiler: clone(program.compiler),
    deterministic: true,
    pinnedSnapshots: {
      policySnapshotSha256: program.policySnapshotSha256,
      registrySnapshotSha256: program.registrySnapshotSha256,
      storageProfileSha256: program.storageProfileSha256
    },
    graph: {
      taskCount: program.taskTemplates.length,
      edgeCount: program.edges.length,
      roots: [...facts.roots],
      terminalTaskIds,
      topologicalOrder: [...facts.order]
    },
    tasks: program.taskTemplates.map((task) => ({
      taskTemplateId: task.taskTemplateId,
      opcode: task.opcode,
      dependsOn: [...task.dependsOn],
      intentClauseIds: [...task.intentClauseIds],
      material: task.material,
      // Even END is a task transition: the runtime proves the terminal condition and emits a
      // receipt before the Process can become succeeded.
      receiptRequired: true
    }))
  });
}

function programInput(value) {
  return plainObject(value?.program) ? value.program : value;
}

function validateProgramForRead(programValue) {
  const program = programInput(programValue);
  if (!plainObject(program) || program.kind !== 'gvm-program') {
    fail('SGOS_PROGRAM_INVALID', 'Expected a gvm-program.');
  }
  if (!Array.isArray(program.taskTemplates) || !Array.isArray(program.edges)) {
    fail('SGOS_PROGRAM_INVALID', 'GVM Program requires taskTemplates and edges arrays.');
  }
  try {
    validateGvmProgram(program);
  } catch (error) {
    fail('SGOS_PROGRAM_INVALID', `GVM Program violates the SGOS v1 contract: ${error.message}`, {
      causeCode: error?.code ?? null
    });
  }
  for (const task of program.taskTemplates) {
    if (!GVM_OPCODE_SET.has(task.opcode)) fail('SGOS_OPCODE_UNKNOWN', `Unknown GVM opcode '${task.opcode}'.`, { task });
  }
  if (program.programSha256 !== sha256(hashableRecord(program, ['programSha256']))) {
    fail('SGOS_CONTENT_HASH_MISMATCH', 'GVM Program hash does not match its canonical content.', {
      received: program.programSha256
    });
  }
  const graph = graphFacts(program.taskTemplates, program.edges);
  assertTerminalReachability(program.taskTemplates, graph);
  return { program, graph };
}

function compileSgosProgramInternal(requestValue, { repositoryBindingSha256 = null } = {}) {
  const normalized = normalizeRequest(requestValue);
  const request = {
    ...normalized,
    intentIr: validateCompileContract(
      normalized.intentIr, validateIntentIr, 'Intent IR', 'SGOS_INTENT_CONTRACT_INVALID'
    ),
    workflow: validateCompileContract(
      normalized.workflow, validateWorkflowIr, 'Workflow IR', 'SGOS_WORKFLOW_CONTRACT_INVALID'
    ),
    ratification: validateCompileContract(
      normalized.ratification, validateWorkflowRatification,
      'Workflow ratification', 'SGOS_RATIFICATION_CONTRACT_INVALID'
    )
  };
  const capabilityPackAuthorities = capabilityPackAuthoritiesForCompilation(
    request.workflow,
    normalized.capabilityPackAuthority,
    { repositoryBindingSha256 }
  );

  const policySnapshotSha256 = requireDigest(request.policySnapshotSha256, 'policySnapshotSha256');
  const registrySnapshotSha256 = requireDigest(request.registrySnapshotSha256, 'registrySnapshotSha256');
  const storageProfileSha256 = requireDigest(request.storageProfileSha256, 'storageProfileSha256');
  const { catalog } = validateRegistrySnapshot(request.registrySnapshot, registrySnapshotSha256);

  const intentIrSha256 = recordDigest(request.intentIr, 'intentIrSha256', 'Intent IR');
  const workflowSha256 = recordDigest(request.workflow, 'workflowSha256', 'Workflow IR');
  if (request.workflow.intentIrSha256 && request.workflow.intentIrSha256 !== intentIrSha256) {
    fail('SGOS_WORKFLOW_INTENT_MISMATCH', 'Workflow IR is not bound to the supplied Intent IR.', {
      expected: intentIrSha256, received: request.workflow.intentIrSha256
    });
  }
  if (request.workflow.policySnapshotSha256 && request.workflow.policySnapshotSha256 !== policySnapshotSha256) {
    fail('SGOS_WORKFLOW_POLICY_MISMATCH', 'Workflow IR is not bound to the pinned policy snapshot.', {
      expected: policySnapshotSha256, received: request.workflow.policySnapshotSha256
    });
  }
  const workflowStorageProfileSha256 = request.workflow.spec?.storageRequirements?.profileSha256;
  if (workflowStorageProfileSha256 !== storageProfileSha256) {
    fail('SGOS_WORKFLOW_STORAGE_MISMATCH',
      'Workflow IR is not bound to the pinned storage profile.', {
        expected: storageProfileSha256,
        received: workflowStorageProfileSha256 ?? null
      });
  }
  assertRatificationBindings(request.ratification, {
    intentIrSha256,
    workflowSha256,
    policySnapshotSha256,
    registrySnapshotSha256,
    storageProfileSha256
  });
  assertRequestCoverageWasRatified(request, request.workflow, request.ratification);
  const ratificationSha256 = recordDigest(request.ratification, 'ratificationSha256', 'Workflow ratification');
  const clauses = extractConfirmedClauses(request.intentIr);
  const entries = expandedTaskEntries(request.workflow);
  const ids = new Set();
  const templates = entries.map(([rawId, task]) => {
    const taskId = String(rawId).trim();
    if (ids.has(taskId)) fail('SGOS_TASK_ID_DUPLICATE', `Workflow task '${taskId}' is duplicated.`, { taskId });
    ids.add(taskId);
    return taskTemplate(request.workflow, taskId, task, catalog);
  }).sort((a, b) => codePointCompare(a.taskTemplateId, b.taskTemplateId));
  if (!templates.length) fail('SGOS_WORKFLOW_TASKS_INVALID', 'Workflow has no tasks.');
  assertCompileCeilings(request.workflow, templates);

  const edges = buildEdges(request.workflow, templates);
  const graph = graphFacts(templates, edges);
  const terminalTaskIds = assertTerminalReachability(templates, graph);
  assertCopilotProposalGates(templates, graph);
  assertParallelSafety(templates, graph);

  const predecessors = new Map(templates.map((task) => [task.taskTemplateId, []]));
  for (const edge of edges) predecessors.get(edge.to).push(edge.from);
  for (const task of templates) {
    task.dependsOn = sortedUniqueStrings(predecessors.get(task.taskTemplateId));
  }

  const coverage = collectCoverageMaps(request.workflow, request.ratification, templates, clauses);
  assertCoverage(clauses, templates, coverage);

  const joins = joinsForProgram(request.workflow, templates);
  const terminalConditions = clone(request.workflow.spec?.terminalConditions ?? terminalTaskIds.map((taskId) => ({
    taskTemplateId: taskId, state: 'succeeded'
  })));
  if (!Array.isArray(terminalConditions) || !terminalConditions.length) {
    fail('SGOS_TERMINAL_UNREACHABLE', 'Workflow has no terminal conditions.');
  }
  const recoveryPolicy = clone(request.workflow.spec?.recovery ?? {});
  const budgets = clone(request.workflow.spec?.budgets ?? {});
  assertSgosCapabilityPackOperations({ taskTemplates: templates }, capabilityPackAuthorities);

  const programSeed = {
    kind: 'gvm-program',
    intentIrSha256,
    workflowSha256,
    ratificationSha256,
    policySnapshotSha256,
    registrySnapshotSha256,
    storageProfileSha256,
    taskTemplates: templates,
    edges,
    joins,
    budgets,
    recoveryPolicy,
    terminalConditions: terminalConditions.sort(canonicalCompare),
    compiler: {
      id: SGOS_COMPILER_ID,
      version: SGOS_COMPILER_VERSION,
      sourceSha256: sgosCapabilityPackAuthoritiesSha256(capabilityPackAuthorities)
    }
  };
  const program = createGvmProgram(programSeed);
  const explanation = compilerExplanation(program, graph);
  return deepFreeze({
    program,
    capabilityPackAuthorities,
    explanation,
    diagnostics: Object.freeze([])
  });
}

/** Compile a confirmed core Intent/Workflow or a preverified internal Pack selection. */
export function compileSgosProgram(requestValue) {
  return compileSgosProgramInternal(requestValue);
}

/**
 * Canonical signed-Pack compile entry point. It loads current authority and binds compilation to
 * this repository; callers cannot substitute a serialized or cross-repository selection object.
 */
export async function compileSgosProgramWithApprovedCapabilityPack(root, requestValue, {
  refreshAuthority = true
} = {}) {
  const workflow = requestValue?.workflow ?? requestValue?.workflowIr;
  const capabilityPackAuthority = await loadApprovedSgosCapabilityPackAuthority(root, workflow, {
    refreshAuthority
  });
  const repositoryBindingSha256 = capabilityPackAuthority.kind === 'signed-declarative'
    ? await sgosCapabilityPackRepositoryBinding(root)
    : null;
  return compileSgosProgramInternal({ ...requestValue, capabilityPackAuthority }, {
    repositoryBindingSha256
  });
}

/**
 * Recompile from the exact Pack selection freshly revalidated by program-trust. This is not a
 * caller-asserted authority path: signed selections still have to carry the non-serializable
 * loader provenance checked by `capabilityPackAuthoritiesForCompilation`.
 */
export function recompileSgosProgramWithVerifiedCapabilityPack(requestValue, verificationReceipt) {
  if (!verificationReceipt || typeof verificationReceipt !== 'object') {
    fail('SGOS_CAPABILITY_PACK_AUTHORITY_REQUIRED',
      'Deterministic Pack recompilation requires a fresh verified authority receipt.');
  }
  return compileSgosProgramInternal({
    ...requestValue,
    capabilityPackAuthority: verificationReceipt.capabilityPackAuthority
  }, {
    repositoryBindingSha256: verificationReceipt.repositoryBindingSha256 ?? null
  });
}

/** Render deterministic compiler reasoning from an already compiled Program or compile request. */
export function explainSgosProgram(value) {
  if (plainObject(value) && (value.intentIr || value.intent) && (value.workflow || value.workflowIr)) {
    return compileSgosProgram(value).explanation;
  }
  const { program, graph } = validateProgramForRead(value);
  return compilerExplanation(program, graph);
}

/**
 * Pure scheduling simulation. It does not execute tasks or claim that a task verified;
 * it only computes deterministic readiness waves for the finite dependency graph.
 */
export function simulateSgosProgram(value) {
  // Keep the original scheduling fields while adding the assurance-classified, strictly
  // read-only SGOS v1 simulation report. The simulator imports no runtime/adapter/Device code.
  const { program } = validateProgramForRead(value);
  return simulateSgosProgramAssurance(program);
}

// Short aliases make the surface convenient while preserving explicit SGOS names.
export const compileProgram = compileSgosProgram;
export const compileWorkflow = compileSgosProgram;
export const explainProgram = explainSgosProgram;
export const simulateProgram = simulateSgosProgram;
