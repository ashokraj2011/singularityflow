/**
 * Deterministic, checkpoint-bound SGOS working-set composition.
 *
 * These envelopes are transport contracts, not a new authority store.  They contain immutable
 * references and explicitly admitted non-secret payload slices.  Long-term promotion remains the
 * responsibility of the reviewed platform Memory service.
 */
import { Buffer } from 'node:buffer';

import { canonicalJson } from '../records.mjs';
import { scanText } from '../secrets.mjs';
import { SingularityFlowError } from '../util.mjs';
import { SHA256_PATTERN, sha256 } from './contracts.mjs';
import { compareSgosCodePoints } from './order.mjs';

export const SGOS_MEMORY_CLASSES = Object.freeze([
  'program', 'process', 'input', 'harness-working', 'shared-artifact', 'evidence',
  'derived', 'cache', 'approved-guidance', 'external', 'secret-handle'
]);

export const SGOS_WORKING_SET_PRIORITIES = Object.freeze([
  'active-human-instruction',
  'task-contract',
  'pinned-law',
  'objective-acceptance',
  'verification-gap',
  'direct-source-context',
  'dependency-output',
  'derived-memory',
  'approved-guidance',
  'historical-context'
]);

export const MAXIMUM_SGOS_WORKING_SET_BYTES = 1024 * 1024;
export const MAXIMUM_SGOS_WORKING_SET_ITEMS = 256;
export const MINIMUM_SGOS_WORKING_SET_BYTES = 4096;
const MAXIMUM_SLICE_BYTES = 256 * 1024;
const SENSITIVITIES = new Set(['public', 'internal', 'confidential', 'restricted']);
const AUTHORITIES = new Set([
  'program-authority', 'process-boundary', 'immutable-input', 'verified-output',
  'authoritative-evidence', 'derived-rebuildable', 'approved-guidance',
  'external-observation', 'non-authoritative', 'secret-broker'
]);
const SECRET_SHAPED_KEY = /(?:^|[-_.])(secret|password|passwd|credential|private[-_.]?key|access[-_.]?token|refresh[-_.]?token)(?:$|[-_.])/i;
const SECRET_HANDLE_REFERENCE = /^sfref:v1:secret-handle:sha256:[a-f0-9]{64}$/;

export function isSgosSecretHandleReference(value) {
  return SECRET_HANDLE_REFERENCE.test(String(value ?? ''));
}

function fail(message, code = 'SGOS_MEMORY_CONTRACT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, location = '$', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${location} contains a non-finite number.`);
    return value;
  }
  if (typeof value !== 'object') fail(`${location} must be JSON-safe.`);
  if (seen.has(value)) fail(`${location} contains a cycle.`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => cloneJson(entry, `${location}[${index}]`, seen));
  } else {
    if (!plain(value)) fail(`${location} must contain only plain objects.`);
    result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        fail(`${location} contains unsafe key '${key}'.`);
      }
      result[key] = cloneJson(entry, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
  return result;
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  if (!plain(value)) fail(`${label} must be an object.`);
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !accepted.has(key));
  if (unexpected.length) fail(`${label} contains unknown field(s): ${unexpected.sort().join(', ')}.`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty string.`);
  return value;
}

function requireDigest(value, label) {
  if (!SHA256_PATTERN.test(String(value ?? ''))) fail(`${label} must be an exact sha256 digest.`);
  return value;
}

function payloadBytes(payload) {
  if (payload === null) return Buffer.alloc(0);
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  return Buffer.from(canonicalJson(cloneJson(payload)), 'utf8');
}

function refuseSecretText(value, location) {
  const findings = scanText(String(value ?? ''), { path: location });
  // A working-set payload has no reviewed source line on which a waiver can be authorized. Treat
  // every scanner finding as blocking so a waiver-looking string cannot smuggle a credential into
  // the model boundary.
  if (findings.length) {
    fail(`Working-set payload '${location}' contains text classified as secret material (${findings[0].rule}). Use an opaque Secret Broker handle instead.`,
      'SGOS_WORKING_SET_SECRET_REFUSED', {
        location,
        rules: [...new Set(findings.map((finding) => finding.rule))].sort()
      });
  }
}

function assertNoSecretShapedPayload(value, location = '$', { serialized = true } = {}) {
  if (typeof value === 'string') {
    refuseSecretText(value, location);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  // Scan the exact JSON representation as well as individual string leaves. This catches formats
  // whose credential signal spans an otherwise innocuous field name and value while the recursive
  // scan still catches strings whose newlines are escaped by JSON serialization.
  if (serialized) refuseSecretText(canonicalJson(cloneJson(value)), `${location}#serialized`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretShapedPayload(
      entry, `${location}[${index}]`, { serialized: false }
    ));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_SHAPED_KEY.test(key)) {
      fail(`Working-set payload '${location}.${key}' resembles secret material. Use an opaque Secret Broker handle instead.`,
        'SGOS_WORKING_SET_SECRET_REFUSED');
    }
    assertNoSecretShapedPayload(entry, `${location}.${key}`, { serialized: false });
  }
}

function memoryRefCore(value) {
  exactKeys(value, [
    'protocolVersion', 'kind', 'address', 'memoryClass', 'object', 'authority',
    'sensitivity', 'storage', 'dependencies', 'expansionHandle', 'memoryRefSha256'
  ], 'memory-ref');
  if (value.protocolVersion !== 1 || value.kind !== 'gvm-memory-ref') {
    fail('Memory reference version or kind is unsupported.');
  }
  requireString(value.address, 'memory-ref.address');
  if (!value.address.startsWith('sfref:v1:')) fail('memory-ref.address must use sfref:v1.');
  if (!SGOS_MEMORY_CLASSES.includes(value.memoryClass)) fail('memory-ref.memoryClass is invalid.');
  exactKeys(value.object, ['schema', 'revision', 'sha256', 'bytes'], 'memory-ref.object');
  requireString(value.object.schema, 'memory-ref.object.schema');
  if (!Number.isSafeInteger(value.object.revision) || value.object.revision < 1) {
    fail('memory-ref.object.revision must be a positive safe integer.');
  }
  requireDigest(value.object.sha256, 'memory-ref.object.sha256');
  if (!Number.isSafeInteger(value.object.bytes) || value.object.bytes < 0
      || value.object.bytes > MAXIMUM_SLICE_BYTES) {
    fail(`memory-ref.object.bytes must be between 0 and ${MAXIMUM_SLICE_BYTES}.`);
  }
  if (!AUTHORITIES.has(value.authority)) fail('memory-ref.authority is invalid.');
  if (!SENSITIVITIES.has(value.sensitivity)) fail('memory-ref.sensitivity is invalid.');
  exactKeys(value.storage, ['storeId'], 'memory-ref.storage');
  requireString(value.storage.storeId, 'memory-ref.storage.storeId');
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 128) {
    fail('memory-ref.dependencies must be a bounded array.');
  }
  let previous = null;
  for (const [index, dependency] of value.dependencies.entries()) {
    exactKeys(dependency, ['address', 'revision', 'memoryRefSha256'], `memory-ref.dependencies[${index}]`);
    requireString(dependency.address, `memory-ref.dependencies[${index}].address`);
    if (!Number.isSafeInteger(dependency.revision) || dependency.revision < 1) {
      fail(`memory-ref.dependencies[${index}].revision must be a positive integer.`);
    }
    requireDigest(dependency.memoryRefSha256, `memory-ref.dependencies[${index}].memoryRefSha256`);
    const key = `${dependency.address}\u0000${dependency.revision}`;
    if (previous !== null && compareSgosCodePoints(previous, key) >= 0) {
      fail('memory-ref.dependencies must be unique and canonically sorted.');
    }
    previous = key;
  }
  requireString(value.expansionHandle, 'memory-ref.expansionHandle');
  requireDigest(value.memoryRefSha256, 'memory-ref.memoryRefSha256');
  if (value.memoryClass === 'secret-handle') {
    if (value.authority !== 'secret-broker' || value.sensitivity !== 'restricted'
        || value.object.bytes !== 0 || !isSgosSecretHandleReference(value.address)) {
      fail('Secret memory may contain only a restricted, zero-byte opaque broker handle.',
        'SGOS_MEMORY_SECRET_HANDLE_INVALID');
    }
  } else if (value.authority === 'secret-broker') {
    fail('Secret Broker authority is reserved for opaque secret handles.');
  }
  const core = cloneJson(value);
  delete core.memoryRefSha256;
  return core;
}

export function createSgosMemoryRef(value) {
  const prepared = {
    protocolVersion: 1,
    kind: 'gvm-memory-ref',
    ...cloneJson(value),
    dependencies: [...(value.dependencies ?? [])]
      .map((entry) => cloneJson(entry))
      .sort((left, right) => compareSgosCodePoints(
        `${left.address}\u0000${left.revision}`, `${right.address}\u0000${right.revision}`
      )),
    memoryRefSha256: null
  };
  const core = memoryRefCore({ ...prepared, memoryRefSha256: sha256(prepared) });
  const result = { ...core, memoryRefSha256: sha256(core) };
  memoryRefCore(result);
  return freezeDeep(result);
}

export function validateSgosMemoryRef(value) {
  const core = memoryRefCore(value);
  if (sha256(core) !== value.memoryRefSha256) {
    fail('Memory reference failed its exact content hash.', 'SGOS_MEMORY_REFERENCE_TAMPERED');
  }
  return freezeDeep(cloneJson(value));
}

function sourceEntry(value, priority) {
  exactKeys(value, ['ref', 'payload', 'expansionHandle'], `working-set source '${priority}'`);
  const ref = validateSgosMemoryRef(value.ref);
  const payload = cloneJson(value.payload ?? null);
  requireString(value.expansionHandle, `working-set source '${priority}'.expansionHandle`);
  if (value.expansionHandle !== ref.expansionHandle) {
    fail(`Working-set source '${ref.address}' changed its immutable expansion handle.`,
      'SGOS_MEMORY_EXPANSION_HANDLE_MISMATCH');
  }
  if (ref.memoryClass === 'secret-handle' || ref.sensitivity === 'restricted') {
    return Object.freeze({ priority, ref, payload: null, expansionHandle: value.expansionHandle,
      forcedOmission: 'secret-isolated' });
  }
  assertNoSecretShapedPayload(payload);
  const bytes = payloadBytes(payload);
  if (bytes.length !== ref.object.bytes || sha256(bytes) !== ref.object.sha256) {
    fail(`Working-set source '${ref.address}' payload does not match its immutable object binding.`,
      'SGOS_MEMORY_PAYLOAD_MISMATCH');
  }
  return Object.freeze({ priority, ref, payload, expansionHandle: value.expansionHandle,
    forcedOmission: null });
}

function sourceIdentity(source) {
  return `${source.ref.address}@${source.ref.object.revision}#${source.ref.memoryRefSha256}`;
}

function omission(source, reason) {
  return Object.freeze({
    priority: source.priority,
    reason,
    sourceIdentity: sourceIdentity(source),
    size: source.ref.object.bytes,
    expansionHandle: source.expansionHandle
  });
}

function sealWorkingSet(core) {
  const candidate = { ...core, workingSetSha256: null };
  const workingSetSha256 = sha256(candidate);
  const record = freezeDeep({ ...candidate, workingSetSha256 });
  return { record, bytes: Buffer.byteLength(canonicalJson(record), 'utf8') };
}

function workingSetCore(value) {
  exactKeys(value, [
    'protocolVersion', 'kind', 'processId', 'taskInstanceId', 'checkpointSha256',
    'programSha256', 'policySnapshotSha256', 'taskContractSha256', 'maximumBytes',
    'payloadBytes', 'entries', 'omissions', 'composer', 'workingSetSha256'
  ], 'working-set');
  if (value.protocolVersion !== 1 || value.kind !== 'gvm-working-set') {
    fail('Working-set version or kind is unsupported.');
  }
  for (const field of ['processId', 'taskInstanceId']) requireString(value[field], `working-set.${field}`);
  for (const field of [
    'checkpointSha256', 'programSha256', 'policySnapshotSha256', 'taskContractSha256'
  ]) requireDigest(value[field], `working-set.${field}`);
  if (!Number.isSafeInteger(value.maximumBytes)
      || value.maximumBytes < MINIMUM_SGOS_WORKING_SET_BYTES
      || value.maximumBytes > MAXIMUM_SGOS_WORKING_SET_BYTES) {
    fail(`working-set.maximumBytes must be between ${MINIMUM_SGOS_WORKING_SET_BYTES} and ${MAXIMUM_SGOS_WORKING_SET_BYTES}.`);
  }
  if (!Number.isSafeInteger(value.payloadBytes) || value.payloadBytes < 0
      || value.payloadBytes > value.maximumBytes) fail('working-set.payloadBytes is invalid.');
  if (!Array.isArray(value.entries) || !Array.isArray(value.omissions)
      || value.entries.length + value.omissions.length > MAXIMUM_SGOS_WORKING_SET_ITEMS) {
    fail('Working-set entries and omissions exceed the installed item bound.');
  }
  let calculatedPayloadBytes = 0;
  let previousKey = null;
  for (const [index, entry] of value.entries.entries()) {
    exactKeys(entry, ['priority', 'ref', 'payload'], `working-set.entries[${index}]`);
    if (!SGOS_WORKING_SET_PRIORITIES.includes(entry.priority)) fail('Working-set entry priority is invalid.');
    const ref = validateSgosMemoryRef(entry.ref);
    if (ref.memoryClass === 'secret-handle' || ref.sensitivity === 'restricted') {
      fail('Secret or restricted memory cannot enter a normal working set.', 'SGOS_WORKING_SET_SECRET_REFUSED');
    }
    assertNoSecretShapedPayload(entry.payload);
    const bytes = payloadBytes(entry.payload);
    if (bytes.length !== ref.object.bytes || sha256(bytes) !== ref.object.sha256) {
      fail('Working-set entry payload does not match its memory reference.', 'SGOS_MEMORY_PAYLOAD_MISMATCH');
    }
    calculatedPayloadBytes += bytes.length;
    const key = `${String(SGOS_WORKING_SET_PRIORITIES.indexOf(entry.priority)).padStart(3, '0')}\u0000${sourceIdentity({ ref })}`;
    if (previousKey !== null && compareSgosCodePoints(previousKey, key) >= 0) {
      fail('Working-set entries must be unique and priority ordered.');
    }
    previousKey = key;
  }
  if (calculatedPayloadBytes !== value.payloadBytes) fail('working-set.payloadBytes does not match entries.');
  previousKey = null;
  for (const [index, entry] of value.omissions.entries()) {
    exactKeys(entry, ['priority', 'reason', 'sourceIdentity', 'size', 'expansionHandle'],
      `working-set.omissions[${index}]`);
    if (!SGOS_WORKING_SET_PRIORITIES.includes(entry.priority)) fail('Working-set omission priority is invalid.');
    if (!['budget-exceeded', 'secret-isolated'].includes(entry.reason)) fail('Working-set omission reason is invalid.');
    requireString(entry.sourceIdentity, `working-set.omissions[${index}].sourceIdentity`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail('Working-set omission size is invalid.');
    requireString(entry.expansionHandle, `working-set.omissions[${index}].expansionHandle`);
    const key = `${String(SGOS_WORKING_SET_PRIORITIES.indexOf(entry.priority)).padStart(3, '0')}\u0000${entry.sourceIdentity}`;
    if (previousKey !== null && compareSgosCodePoints(previousKey, key) >= 0) {
      fail('Working-set omissions must be unique and priority ordered.');
    }
    previousKey = key;
  }
  exactKeys(value.composer, ['id', 'version'], 'working-set.composer');
  if (value.composer.id !== 'sflow-working-set' || value.composer.version !== '1.0.0') {
    fail('Working-set composer is unsupported.');
  }
  requireDigest(value.workingSetSha256, 'working-set.workingSetSha256');
  const core = cloneJson(value);
  delete core.workingSetSha256;
  return core;
}

/** Compose a bounded working set in the normative SGOS priority order. */
export function composeSgosWorkingSet({
  processId,
  taskInstanceId,
  checkpointSha256,
  programSha256,
  policySnapshotSha256,
  taskContractSha256,
  sources = {},
  maximumBytes = 256 * 1024
}) {
  exactKeys(sources, SGOS_WORKING_SET_PRIORITIES, 'working-set sources');
  if (!Number.isSafeInteger(maximumBytes)
      || maximumBytes < MINIMUM_SGOS_WORKING_SET_BYTES
      || maximumBytes > MAXIMUM_SGOS_WORKING_SET_BYTES) {
    fail(`Working-set byte ceiling must be between ${MINIMUM_SGOS_WORKING_SET_BYTES} and ${MAXIMUM_SGOS_WORKING_SET_BYTES}.`,
      'SGOS_WORKING_SET_BUDGET_INVALID');
  }
  const ordered = [];
  for (const priority of SGOS_WORKING_SET_PRIORITIES) {
    const values = sources[priority] ?? [];
    if (!Array.isArray(values)) fail(`Working-set source '${priority}' must be an array.`);
    for (const value of values) ordered.push(sourceEntry(value, priority));
  }
  if (ordered.length > MAXIMUM_SGOS_WORKING_SET_ITEMS) {
    fail(`Working-set has more than ${MAXIMUM_SGOS_WORKING_SET_ITEMS} source items.`,
      'SGOS_WORKING_SET_ITEM_LIMIT');
  }
  ordered.sort((left, right) => SGOS_WORKING_SET_PRIORITIES.indexOf(left.priority)
    - SGOS_WORKING_SET_PRIORITIES.indexOf(right.priority)
    || compareSgosCodePoints(sourceIdentity(left), sourceIdentity(right)));
  for (let index = 1; index < ordered.length; index += 1) {
    if (sourceIdentity(ordered[index - 1]) === sourceIdentity(ordered[index])) {
      fail(`Working-set repeats immutable source '${sourceIdentity(ordered[index])}'.`,
        'SGOS_MEMORY_REFERENCE_DUPLICATE');
    }
  }
  const base = {
    protocolVersion: 1,
    kind: 'gvm-working-set',
    processId: requireString(processId, 'processId'),
    taskInstanceId: requireString(taskInstanceId, 'taskInstanceId'),
    checkpointSha256: requireDigest(checkpointSha256, 'checkpointSha256'),
    programSha256: requireDigest(programSha256, 'programSha256'),
    policySnapshotSha256: requireDigest(policySnapshotSha256, 'policySnapshotSha256'),
    taskContractSha256: requireDigest(taskContractSha256, 'taskContractSha256'),
    maximumBytes,
    payloadBytes: 0,
    entries: [],
    omissions: [],
    composer: { id: 'sflow-working-set', version: '1.0.0' }
  };
  for (const source of ordered) {
    if (source.forcedOmission) {
      base.omissions.push(omission(source, source.forcedOmission));
      continue;
    }
    const entry = { priority: source.priority, ref: source.ref, payload: source.payload };
    const trial = {
      ...base,
      payloadBytes: base.payloadBytes + source.ref.object.bytes,
      entries: [...base.entries, entry],
      omissions: [...base.omissions]
    };
    if (sealWorkingSet(trial).bytes <= maximumBytes) {
      base.entries.push(entry);
      base.payloadBytes += source.ref.object.bytes;
    } else {
      base.omissions.push(omission(source, 'budget-exceeded'));
    }
  }
  // Omissions are mandatory evidence. If their metadata pushes the envelope over budget, evict
  // the lowest-priority admitted entries until the complete auditable record fits.
  let sealed = sealWorkingSet(base);
  while (sealed.bytes > maximumBytes && base.entries.length) {
    const removed = base.entries.pop();
    base.payloadBytes -= removed.ref.object.bytes;
    base.omissions.push(omission({
      priority: removed.priority,
      ref: removed.ref,
      expansionHandle: removed.ref.expansionHandle
    }, 'budget-exceeded'));
    base.omissions.sort((left, right) => SGOS_WORKING_SET_PRIORITIES.indexOf(left.priority)
      - SGOS_WORKING_SET_PRIORITIES.indexOf(right.priority)
      || compareSgosCodePoints(left.sourceIdentity, right.sourceIdentity));
    sealed = sealWorkingSet(base);
  }
  if (sealed.bytes > maximumBytes) {
    fail('Working-set budget is too small to retain the mandatory omission ledger.',
      'SGOS_WORKING_SET_BUDGET_TOO_SMALL_FOR_OMISSIONS', {
        maximumBytes, minimumRequiredBytes: sealed.bytes
      });
  }
  validateSgosWorkingSet(sealed.record);
  return sealed.record;
}

export function validateSgosWorkingSet(value, { checkpointSha256 = null } = {}) {
  const core = workingSetCore(value);
  if (sha256({ ...core, workingSetSha256: null }) !== value.workingSetSha256) {
    fail('Working set failed its exact content hash.', 'SGOS_WORKING_SET_TAMPERED');
  }
  const serializedBytes = Buffer.byteLength(canonicalJson(value), 'utf8');
  if (serializedBytes > value.maximumBytes) {
    fail('Working set exceeds its declared byte ceiling.', 'SGOS_WORKING_SET_BUDGET_EXCEEDED');
  }
  if (checkpointSha256 != null && value.checkpointSha256 !== checkpointSha256) {
    fail('Working set belongs to another Process checkpoint.', 'SGOS_WORKING_SET_CHECKPOINT_STALE');
  }
  return freezeDeep(cloneJson(value));
}

function refPayload({ address, memoryClass, authority, content, sensitivity = 'internal',
  storeId = 'sgos-process', expansionHandle = address }) {
  const bytes = payloadBytes(content);
  return {
    ref: createSgosMemoryRef({
      address,
      memoryClass,
      object: {
        schema: 'sgos-reference-set', revision: 1, sha256: sha256(bytes), bytes: bytes.length
      },
      authority,
      sensitivity,
      storage: { storeId },
      dependencies: [],
      expansionHandle
    }),
    payload: content,
    expansionHandle
  };
}

function exactRefs(values, label, { strict = true } = {}) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`);
  const refs = [...new Set(values)].filter((ref) => {
    const exact = typeof ref === 'string'
      && (SHA256_PATTERN.test(ref) || ref.startsWith('sfref:v1:'));
    if (!exact && strict) {
      fail(`${label} contains a non-exact reference.`, 'SGOS_MEMORY_REFERENCE_INVALID', { ref });
    }
    return exact;
  });
  return refs.sort(compareSgosCodePoints);
}

/**
 * Build the default runtime working set exclusively from exact Program/Process references.
 * No repository search, ambient history, cache, or secret resolution occurs here.
 */
export function composeSgosRuntimeWorkingSet({ process, checkpoint, task, template, program }) {
  if (checkpoint?.checkpointSha256 !== process?.currentCheckpointSha256
      || checkpoint?.processId !== process?.processId
      || checkpoint?.programSha256 !== process?.programSha256
      || checkpoint?.policySnapshotSha256 !== process?.policySnapshotSha256) {
    fail('Runtime working-set composition requires the exact current Process checkpoint.',
      'SGOS_WORKING_SET_CHECKPOINT_STALE');
  }
  const memory = plain(template?.metadata?.memory) ? template.metadata.memory : {};
  const predecessors = exactRefs(task.predecessorTaskInstanceIds.flatMap((taskInstanceId) => {
    const dependency = process.taskInstances[taskInstanceId];
    return dependency?.state === 'succeeded' ? dependency.outputRefs : [];
  }), 'dependency outputs', { strict: false });
  // Earlier Program contracts admitted symbolic input names. They remain valid Process material,
  // but they are not promoted into this exact-reference surface until a resolver supplies an
  // immutable sfref or digest.
  const exactInputs = exactRefs(task.inputRefs, 'task inputs', { strict: false });
  const secretInputs = exactInputs.filter(isSgosSecretHandleReference);
  const inputs = exactInputs.filter((reference) => !isSgosSecretHandleReference(reference));
  const activeInstructions = exactRefs(memory.activeHumanInstructionRefs ?? [], 'active Human instructions');
  const verificationGaps = exactRefs(memory.verificationGapRefs ?? [], 'verification gaps');
  const derived = exactRefs(memory.derivedRefs ?? [], 'derived memory');
  const guidance = exactRefs(memory.approvedGuidanceRefs ?? [], 'approved guidance');
  const historical = exactRefs(memory.historicalRefs ?? [], 'historical context');
  const referenceSlice = (priority, refs, memoryClass, authority) => refs.length ? [refPayload({
    address: `sfref:v1:process:${process.processId}:${priority}`,
    memoryClass,
    authority,
    content: refs,
    expansionHandle: `sfref:v1:process:${process.processId}:expand:${priority}`
  })] : [];
  const secretHandleSlice = secretInputs.map((address) => {
    const objectSha256 = address.slice('sfref:v1:secret-handle:'.length);
    const expansionHandle = `secret-broker:withheld:${objectSha256}`;
    return {
      ref: createSgosMemoryRef({
        address,
        memoryClass: 'secret-handle',
        object: { schema: 'secret-handle', revision: 1, sha256: objectSha256, bytes: 0 },
        authority: 'secret-broker',
        sensitivity: 'restricted',
        storage: { storeId: 'secret-broker' },
        dependencies: [],
        expansionHandle
      }),
      payload: null,
      expansionHandle
    };
  });
  const maximumBytes = memory.maximumBytes ?? program.budgets?.maximumWorkingSetBytes ?? 256 * 1024;
  return composeSgosWorkingSet({
    processId: process.processId,
    taskInstanceId: task.taskInstanceId,
    checkpointSha256: checkpoint.checkpointSha256,
    programSha256: process.programSha256,
    policySnapshotSha256: process.policySnapshotSha256,
    taskContractSha256: process.taskContractSha256,
    maximumBytes,
    sources: {
      'active-human-instruction': referenceSlice(
        'active-human-instruction', activeInstructions, 'process', 'process-boundary'
      ),
      'task-contract': [refPayload({
        address: `sfref:v1:process:${process.processId}:task-contract`,
        memoryClass: 'program', authority: 'program-authority',
        content: [process.taskContractSha256],
        expansionHandle: `sfref:v1:process:${process.processId}:task-contract:expand`
      })],
      'pinned-law': [refPayload({
        address: `sfref:v1:process:${process.processId}:pinned-law`,
        memoryClass: 'program', authority: 'program-authority',
        content: [process.policySnapshotSha256, process.programSha256].sort(compareSgosCodePoints),
        expansionHandle: `sfref:v1:process:${process.processId}:pinned-law:expand`
      })],
      'objective-acceptance': [refPayload({
        address: `sfref:v1:process:${process.processId}:task:${task.taskInstanceId}:objective`,
        memoryClass: 'program', authority: 'program-authority',
        content: {
          objective: String(template.metadata?.parameters?.objective ?? template.operation ?? template.taskTemplateId),
          acceptanceClauseIds: [...(template.intentClauseIds ?? [])].sort(compareSgosCodePoints)
        },
        expansionHandle: `sfref:v1:program:${process.programSha256}:task:${template.taskTemplateId}`
      })],
      'verification-gap': referenceSlice(
        'verification-gap', verificationGaps, 'evidence', 'authoritative-evidence'
      ),
      'direct-source-context': [
        ...referenceSlice('direct-source-context', inputs, 'input', 'immutable-input'),
        ...secretHandleSlice
      ],
      'dependency-output': referenceSlice(
        'dependency-output', predecessors, 'shared-artifact', 'verified-output'
      ),
      'derived-memory': referenceSlice(
        'derived-memory', derived, 'derived', 'derived-rebuildable'
      ),
      'approved-guidance': referenceSlice(
        'approved-guidance', guidance, 'approved-guidance', 'approved-guidance'
      ),
      'historical-context': referenceSlice(
        'historical-context', historical, 'external', 'external-observation'
      )
    }
  });
}
