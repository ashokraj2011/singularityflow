/**
 * Fail-closed execution admission for immutable GVM Programs.
 *
 * A Program self-hash proves only that its bytes are internally consistent. It does not prove that
 * those bytes were emitted by the deterministic SGOS compiler. Execution therefore requires a
 * separate provenance witness loaded from the approved configuration authority. Deterministic
 * recompilation is useful corroboration, but caller-supplied compiler inputs or a naked digest can
 * never authorize execution by themselves.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  configurationReadRoot, isConfigurationReadPath
} from '../configuration-read-scope.mjs';
import { canonicalJson } from '../records.mjs';
import { compileSgosProgram, registrySnapshotDigest, SGOS_COMPILER_ID, SGOS_COMPILER_VERSION } from './compiler.mjs';
import { SHA256_PATTERN, validateGvmProgram } from './contracts.mjs';
import { withTrustedSgosConfigurationRead } from './authority-trust.mjs';
import { compareSgosCodePoints } from './order.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { canonicalSgosJoins } from './joins.mjs';
import {
  normalizeSgosFanout, sgosFanoutChildTemplateId
} from './fanout.mjs';
import {
  canonicalSgosResourceEntries, normalizeSgosResourceKey
} from './resource-contracts.mjs';

export const SGOS_EXECUTION_ADMISSION_OPCODES = Object.freeze([
  'NOOP', 'KERNEL', 'VERIFY', 'HUMAN_REQUEST', 'JOIN', 'CHECKPOINT', 'END'
]);

const EXECUTION_OPERATION_OPCODES = new Set(['KERNEL', 'AGENT', 'DEVICE', 'VERIFY', 'COMPENSATE']);
const HUMAN_JUDGMENT_KINDS = new Set(['human-judgment', 'human', 'judgment']);
const NON_MATERIAL_OPCODES = new Set(['NOOP', 'JOIN', 'CHECKPOINT', 'END']);
const PROGRAM_AUTHORITY_FORMAT = 'singularity-flow-sgos-program-authority/v1';
const verifiedProgramAuthorities = new WeakSet();

export class SgosProgramTrustError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SgosProgramTrustError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SgosProgramTrustError(code, message, details);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function present(value) {
  if (value == null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(present);
  if (plainObject(value)) return Object.values(value).some(present);
  return true;
}

function requireDigest(value, label, code = 'SGOS_PROGRAM_PIN_INVALID') {
  if (!SHA256_PATTERN.test(String(value ?? ''))) {
    fail(code, `${label} must be an exact sha256: digest.`, { label, received: value ?? null });
  }
  return String(value);
}

function canonicalCompare(left, right) {
  return compareSgosCodePoints(
    typeof left === 'string' ? left : canonicalJson(left),
    typeof right === 'string' ? right : canonicalJson(right)
  );
}

function assertCanonicalOrder(values, label, compare = canonicalCompare) {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1], values[index]) >= 0) {
      fail('SGOS_PROGRAM_NOT_CANONICAL', `${label} must be strictly ordered without duplicates.`, {
        label, index
      });
    }
  }
}

function normalizedResource(value) {
  return normalizeSgosResourceKey(value);
}

function resourceOverlap(left, right) {
  const a = normalizedResource(left);
  const b = normalizedResource(right);
  if (!a || !b) return false;
  return a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function bitsetWords(taskCount) {
  return Math.ceil(taskCount / 32);
}

function setTaskBit(bits, taskIndex) {
  const word = taskIndex >>> 5;
  bits[word] = (bits[word] | (1 << (taskIndex & 31))) >>> 0;
}

function hasTaskBit(bits, taskIndex) {
  return (bits[taskIndex >>> 5] & (1 << (taskIndex & 31))) !== 0;
}

function orTaskBits(target, source) {
  for (let word = 0; word < target.length; word += 1) {
    target[word] = (target[word] | source[word]) >>> 0;
  }
}

function fillTaskBits(target, taskIndexes = []) {
  target.fill(0);
  for (const taskIndex of taskIndexes) setTaskBit(target, taskIndex);
  return target;
}

function reachabilityRows(graph) {
  const taskIndex = new Map(graph.taskIds.map((taskId, index) => [taskId, index]));
  const rows = Array.from(
    { length: graph.taskIds.length },
    () => new Uint32Array(bitsetWords(graph.taskIds.length))
  );
  for (let index = graph.topologicalOrder.length - 1; index >= 0; index -= 1) {
    const taskId = graph.topologicalOrder[index];
    const row = rows[taskIndex.get(taskId)];
    for (const successorId of graph.forward.get(taskId)) {
      const successorIndex = taskIndex.get(successorId);
      setTaskBit(row, successorIndex);
      orTaskBits(row, rows[successorIndex]);
    }
  }
  return rows;
}

function graphFacts(program) {
  const taskIds = program.taskTemplates.map((task) => task.taskTemplateId);
  const known = new Set(taskIds);
  if (known.size !== taskIds.length) {
    fail('SGOS_PROGRAM_TASK_DUPLICATE', 'GVM Program contains duplicate taskTemplateId values.');
  }
  assertCanonicalOrder(taskIds, 'gvm-program.taskTemplates', compareSgosCodePoints);

  const forward = new Map(taskIds.map((id) => [id, []]));
  const reverse = new Map(taskIds.map((id) => [id, []]));
  const edgeKeys = [];
  for (const edge of program.edges) {
    if (edge.condition != null) {
      fail('SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', 'Conditional GVM edges are not executable in the sequential SGOS profile.', {
        semantic: 'conditional-edge', edge: clone(edge)
      });
    }
    if (!known.has(edge.from) || !known.has(edge.to)) {
      fail('SGOS_PROGRAM_EDGE_UNKNOWN_TASK', `Program edge '${edge.from}' -> '${edge.to}' references an unknown task.`, {
        edge: clone(edge)
      });
    }
    if (edge.from === edge.to) {
      fail('SGOS_PROGRAM_GRAPH_CYCLE', `Task '${edge.from}' depends on itself.`, { taskTemplateId: edge.from });
    }
    const key = `${edge.from}\u0000${edge.to}`;
    edgeKeys.push(key);
    forward.get(edge.from).push(edge.to);
    reverse.get(edge.to).push(edge.from);
  }
  assertCanonicalOrder(edgeKeys, 'gvm-program.edges', compareSgosCodePoints);
  for (const values of [...forward.values(), ...reverse.values()]) values.sort(compareSgosCodePoints);

  const indegree = new Map(taskIds.map((id) => [id, reverse.get(id).length]));
  const ready = taskIds.filter((id) => indegree.get(id) === 0).sort(compareSgosCodePoints);
  const topologicalOrder = [];
  while (ready.length) {
    const current = ready.shift();
    topologicalOrder.push(current);
    for (const next of forward.get(current)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort(compareSgosCodePoints);
      }
    }
  }
  if (topologicalOrder.length !== taskIds.length) {
    fail('SGOS_PROGRAM_GRAPH_CYCLE', 'GVM Program dependency graph contains a cycle.', {
      taskTemplateIds: taskIds.filter((id) => !topologicalOrder.includes(id))
    });
  }

  const endTaskIds = program.taskTemplates
    .filter((task) => task.opcode === 'END')
    .map((task) => task.taskTemplateId)
    .sort(compareSgosCodePoints);
  if (!endTaskIds.length) fail('SGOS_PROGRAM_TERMINAL_INVALID', 'GVM Program has no END task.');
  for (const taskId of endTaskIds) {
    if (forward.get(taskId).length) {
      fail('SGOS_PROGRAM_TERMINAL_INVALID', `END task '${taskId}' has successors.`, {
        taskTemplateId: taskId, successors: [...forward.get(taskId)]
      });
    }
  }

  const canReachEnd = new Set();
  const pending = [...endTaskIds];
  while (pending.length) {
    const current = pending.shift();
    if (canReachEnd.has(current)) continue;
    canReachEnd.add(current);
    pending.push(...reverse.get(current));
  }
  const stranded = taskIds.filter((id) => !canReachEnd.has(id));
  if (stranded.length) {
    fail('SGOS_PROGRAM_TERMINAL_INVALID', 'Every GVM task must be able to reach an END task.', {
      taskTemplateIds: stranded
    });
  }

  return { taskIds, known, forward, reverse, topologicalOrder, endTaskIds };
}

function assertTerminalConditions(program, graph) {
  if (!Array.isArray(program.terminalConditions) || !program.terminalConditions.length) {
    fail('SGOS_PROGRAM_TERMINAL_INVALID', 'GVM Program has no terminal conditions.');
  }
  const terminalIds = [];
  for (const condition of program.terminalConditions) {
    if (!plainObject(condition)
        || Object.keys(condition).some((key) => !['taskTemplateId', 'state'].includes(key))
        || condition.state !== 'succeeded'
        || !graph.endTaskIds.includes(condition.taskTemplateId)) {
      fail('SGOS_PROGRAM_TERMINAL_INVALID', 'Terminal conditions must bind an END task to state succeeded.', {
        condition: clone(condition)
      });
    }
    terminalIds.push(condition.taskTemplateId);
  }
  terminalIds.sort(compareSgosCodePoints);
  if (new Set(terminalIds).size !== terminalIds.length
      || canonicalJson(terminalIds) !== canonicalJson(graph.endTaskIds)) {
    fail('SGOS_PROGRAM_TERMINAL_INVALID', 'Every END task requires exactly one succeeded terminal condition.', {
      expected: graph.endTaskIds, received: terminalIds
    });
  }
  assertCanonicalOrder(program.terminalConditions, 'gvm-program.terminalConditions');
}

function assertDependenciesMatchEdges(program, graph) {
  for (const task of program.taskTemplates) {
    const dependencies = task.dependsOn ?? [];
    assertCanonicalOrder(dependencies, `task '${task.taskTemplateId}' dependsOn`, compareSgosCodePoints);
    const expected = graph.reverse.get(task.taskTemplateId);
    if (canonicalJson(dependencies) !== canonicalJson(expected)) {
      fail('SGOS_PROGRAM_DEPENDENCY_MISMATCH', `Task '${task.taskTemplateId}' dependencies do not match Program edges.`, {
        taskTemplateId: task.taskTemplateId, expected, received: dependencies
      });
    }
  }
}

function assertEvidenceAuthorityAndRecovery(program) {
  for (const task of program.taskTemplates) {
    if (task.policySnapshotSha256 !== program.policySnapshotSha256) {
      fail('SGOS_PROGRAM_POLICY_MISMATCH', `Task '${task.taskTemplateId}' is not pinned to the Program policy snapshot.`, {
        taskTemplateId: task.taskTemplateId,
        expected: program.policySnapshotSha256,
        received: task.policySnapshotSha256 ?? null
      });
    }
    if (!NON_MATERIAL_OPCODES.has(task.opcode) && task.material !== true) {
      fail('SGOS_PROGRAM_MATERIALITY_INVALID', `Executable task '${task.taskTemplateId}' must be material.`, {
        taskTemplateId: task.taskTemplateId, opcode: task.opcode
      });
    }
    if (task.material === true && !present(task.evidence)) {
      fail('SGOS_PROGRAM_EVIDENCE_REQUIRED', `Material task '${task.taskTemplateId}' has no evidence contract.`, {
        taskTemplateId: task.taskTemplateId
      });
    }
    const verificationKind = String(task.metadata?.verification?.kind ?? task.metadata?.verification?.type ?? '').toLowerCase();
    if ((task.opcode === 'HUMAN_REQUEST' || HUMAN_JUDGMENT_KINDS.has(verificationKind)) && !present(task.authority)) {
      fail('SGOS_PROGRAM_AUTHORITY_REQUIRED', `Task '${task.taskTemplateId}' requires human judgment but has no authority contract.`, {
        taskTemplateId: task.taskTemplateId
      });
    }
    if ((task.resources?.externalEffects ?? []).length && !present(task.recovery)) {
      fail('SGOS_PROGRAM_RECOVERY_REQUIRED', `Task '${task.taskTemplateId}' has external effects but no recovery contract.`, {
        taskTemplateId: task.taskTemplateId,
        externalEffects: [...task.resources.externalEffects]
      });
    }
    if (EXECUTION_OPERATION_OPCODES.has(task.opcode) && !task.operation) {
      fail('SGOS_PROGRAM_OPERATION_REQUIRED', `Task '${task.taskTemplateId}' has no versioned operation.`, {
        taskTemplateId: task.taskTemplateId, opcode: task.opcode
      });
    }
    if (task.operation) {
      if (typeof task.metadata?.operationVersion !== 'string' || !task.metadata.operationVersion.trim()) {
        fail('SGOS_PROGRAM_OPERATION_VERSION_REQUIRED', `Task '${task.taskTemplateId}' has no pinned operation version.`, {
          taskTemplateId: task.taskTemplateId, operation: task.operation
        });
      }
      requireDigest(
        task.metadata?.operationManifestSha256,
        `task '${task.taskTemplateId}' operationManifestSha256`,
        'SGOS_PROGRAM_OPERATION_MANIFEST_REQUIRED'
      );
    }
    const verification = task.metadata?.verification;
    const verificationOperation = typeof verification?.operation === 'string'
      ? verification.operation
      : verification?.operation?.id ?? verification?.operationId ?? null;
    if (verificationOperation != null) {
      if (typeof task.metadata?.verificationOperationVersion !== 'string'
          || !task.metadata.verificationOperationVersion.trim()) {
        fail('SGOS_PROGRAM_OPERATION_VERSION_REQUIRED', `Task '${task.taskTemplateId}' has no pinned verification operation version.`, {
          taskTemplateId: task.taskTemplateId, operation: String(verificationOperation), role: 'verification'
        });
      }
      requireDigest(
        task.metadata?.verificationOperationManifestSha256,
        `task '${task.taskTemplateId}' verificationOperationManifestSha256`,
        'SGOS_PROGRAM_OPERATION_MANIFEST_REQUIRED'
      );
    }
    if (task.metadata?.condition != null) {
      fail('SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', `Task '${task.taskTemplateId}' retains unsupported conditional semantics.`, {
        taskTemplateId: task.taskTemplateId, semantic: 'condition'
      });
    }
  }
}

function assertBudgets(program, {
  maximumTasks = SGOS_INSTALLED_LIMITS.maximumTasks,
  maximumAttempts = SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
} = {}) {
  const taskCeiling = program.budgets?.maximumTasks;
  if (!Number.isSafeInteger(taskCeiling) || taskCeiling < 1) {
    fail('SGOS_PROGRAM_BUDGET_INVALID', 'Program budgets require a positive maximumTasks ceiling.');
  }
  if (program.taskTemplates.length > taskCeiling) {
    fail('SGOS_PROGRAM_BUDGET_EXCEEDED', 'Program task count exceeds maximumTasks.', {
      maximumTasks: taskCeiling, actualTasks: program.taskTemplates.length
    });
  }
  if (maximumTasks != null && program.taskTemplates.length > maximumTasks) {
    fail('SGOS_PROGRAM_BUDGET_EXCEEDED', 'Program task count exceeds the execution admission ceiling.', {
      maximumTasks, actualTasks: program.taskTemplates.length
    });
  }

  const declaredAttempts = program.budgets.maximumAttemptsPerTask ?? program.budgets.maximumAttempts;
  if (!Number.isSafeInteger(declaredAttempts) || declaredAttempts < 1) {
    fail('SGOS_PROGRAM_BUDGET_INVALID', 'Program budgets require a positive maximumAttempts ceiling.');
  }
  if (program.budgets.maximumAttemptsPerTask != null && program.budgets.maximumAttempts != null
      && program.budgets.maximumAttemptsPerTask !== program.budgets.maximumAttempts) {
    fail('SGOS_PROGRAM_BUDGET_INVALID', 'Program retry ceilings disagree.');
  }
  if (declaredAttempts > maximumAttempts) {
    fail('SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', 'Program retry ceiling exceeds the installed runtime profile.', {
      semantic: 'retry', maximumAttempts: declaredAttempts, installedMaximumAttempts: maximumAttempts
    });
  }
  for (const task of program.taskTemplates) {
    const taskAttempts = task.retry?.maximumAttempts;
    if (!Number.isSafeInteger(taskAttempts) || taskAttempts < 1 || taskAttempts > declaredAttempts) {
      fail('SGOS_PROGRAM_BUDGET_INVALID', `Task '${task.taskTemplateId}' has an invalid retry ceiling.`, {
        taskTemplateId: task.taskTemplateId, maximumAttempts: taskAttempts ?? null,
        programMaximumAttempts: declaredAttempts
      });
    }
  }
  const possibleAttemptRecords = 2 * program.taskTemplates.reduce(
    (total, task) => total + task.retry.maximumAttempts, 0
  );
  if (possibleAttemptRecords > SGOS_INSTALLED_LIMITS.maximumAttemptRecords) {
    fail('SGOS_PROGRAM_BUDGET_EXCEEDED',
      'Program retry envelope exceeds the installed immutable-attempt record capacity.', {
        possibleAttemptRecords,
        maximumAttemptRecords: SGOS_INSTALLED_LIMITS.maximumAttemptRecords
      });
  }
  // Each attempt can require dispatch, Human-wait, and terminal/recovery Process transitions.
  // Reserve additional transitions for initialization and operator pause/resume without admitting
  // a Program whose valid execution cannot fit the installed control-lineage replay envelope.
  const possibleControlRecords = 2
    + SGOS_INSTALLED_LIMITS.maximumOperatorControlTransitions
    + 3 * program.taskTemplates.reduce(
      (total, task) => total + task.retry.maximumAttempts, 0
    );
  if (possibleControlRecords > SGOS_INSTALLED_LIMITS.maximumControlRecords) {
    fail('SGOS_PROGRAM_BUDGET_EXCEEDED',
      'Program retry envelope exceeds the installed immutable control-lineage capacity.', {
        possibleControlRecords,
        maximumControlRecords: SGOS_INSTALLED_LIMITS.maximumControlRecords
      });
  }
}

export function assertSgosInstalledProgramLimits(program) {
  const bytes = Buffer.byteLength(JSON.stringify(program), 'utf8');
  if (bytes > SGOS_INSTALLED_LIMITS.maximumProgramBytes) {
    fail('SGOS_PROGRAM_BUDGET_EXCEEDED', 'Program exceeds the installed byte ceiling.', {
      actualBytes: bytes, maximumBytes: SGOS_INSTALLED_LIMITS.maximumProgramBytes
    });
  }
  if (program.taskTemplates.length > SGOS_INSTALLED_LIMITS.maximumTasks) {
    fail('SGOS_PROGRAM_BUDGET_EXCEEDED', 'Program exceeds the installed task ceiling.', {
      actualTasks: program.taskTemplates.length,
      maximumTasks: SGOS_INSTALLED_LIMITS.maximumTasks
    });
  }
  if (program.edges.length > SGOS_INSTALLED_LIMITS.maximumEdges) {
    fail('SGOS_PROGRAM_BUDGET_EXCEEDED', 'Program exceeds the installed edge ceiling.', {
      actualEdges: program.edges.length,
      maximumEdges: SGOS_INSTALLED_LIMITS.maximumEdges
    });
  }
  for (const task of program.taskTemplates) {
    try { canonicalSgosResourceEntries(task.resources); } catch (error) {
      fail(error?.code ?? 'SGOS_RESOURCE_LEASE_LIMIT',
        `Task '${task.taskTemplateId}' cannot fit one installed resource lease.`, {
          taskTemplateId: task.taskTemplateId,
          cause: error?.message ?? String(error),
          ...(error?.details ?? {})
        });
    }
  }
  const resourceDeclarations = program.taskTemplates.reduce((total, task) => total
    + ['reads', 'writes', 'devices', 'externalEffects'].reduce(
      (count, field) => count + (task.resources?.[field]?.length ?? 0), 0
    ), 0);
  if (resourceDeclarations > SGOS_INSTALLED_LIMITS.maximumResourceDeclarations) {
    fail('SGOS_PROGRAM_BUDGET_EXCEEDED', 'Program exceeds the installed resource ceiling.', {
      actualResourceDeclarations: resourceDeclarations,
      maximumResourceDeclarations: SGOS_INSTALLED_LIMITS.maximumResourceDeclarations
    });
  }
  assertBudgets(program);
  return program;
}

const RESOURCE_FIELDS = Object.freeze(['reads', 'writes', 'devices', 'externalEffects']);

function addActiveTasks(active, taskIndexes = []) {
  for (const taskIndex of taskIndexes) {
    active.counts[taskIndex] += 1;
    if (active.counts[taskIndex] === 1) setTaskBit(active.bits, taskIndex);
  }
}

function removeActiveTasks(active, taskIndexes = []) {
  for (const taskIndex of taskIndexes) {
    active.counts[taskIndex] -= 1;
    if (active.counts[taskIndex] === 0) {
      const word = taskIndex >>> 5;
      active.bits[word] = (active.bits[word] & ~(1 << (taskIndex & 31))) >>> 0;
    }
  }
}

function compareResourceHierarchy(left, right) {
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  const length = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareSgosCodePoints(leftSegments[index], rightSegments[index]);
    if (compared !== 0) return compared;
  }
  return leftSegments.length - rightSegments.length;
}

/**
 * Build one task-level conflict relation without multiplying every task pair by every declaration
 * pair. Normalized resource paths form a prefix tree. Sorting the declared nodes lets one stack
 * retain exactly the active ancestors, while task bitsets collapse repeated declarations into a
 * bounded relation over at most the installed 2,000 tasks.
 */
function resourceConflictRows(program) {
  const taskCount = program.taskTemplates.length;
  const words = bitsetWords(taskCount);
  const rows = Array.from({ length: taskCount }, () => new Uint32Array(words));
  const all = Object.fromEntries(RESOURCE_FIELDS.map((field) => [field, new Uint32Array(words)]));
  const wildcards = Object.fromEntries(RESOURCE_FIELDS.map((field) => [field, []]));
  const groups = new Map();

  for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
    const resources = program.taskTemplates[taskIndex].resources ?? {};
    for (const field of RESOURCE_FIELDS) {
      for (const resource of resources[field] ?? []) {
        const normalized = normalizedResource(resource);
        if (!normalized) continue;
        setTaskBit(all[field], taskIndex);
        if (normalized === '*') {
          if (wildcards[field].at(-1) !== taskIndex) wildcards[field].push(taskIndex);
          continue;
        }
        let group = groups.get(normalized);
        if (!group) {
          group = {};
          groups.set(normalized, group);
        }
        const members = group[field] ??= [];
        // Task iteration is monotonic, so normalization aliases remain adjacent and cheap to fold.
        if (members.at(-1) !== taskIndex) members.push(taskIndex);
      }
    }
  }

  const active = Object.fromEntries(RESOURCE_FIELDS.map((field) => [field, {
    bits: new Uint32Array(words), counts: new Uint32Array(taskCount)
  }]));
  const current = Object.fromEntries(
    RESOURCE_FIELDS.map((field) => [field, new Uint32Array(words)])
  );
  const stack = [];
  const orderedGroups = [...groups.entries()]
    // Segment-wise preorder keeps every descendant contiguous with its declared ancestor. Plain
    // string order does not: `a-b` sorts between `a` and `a/c` and would retire `a` too early.
    .sort(([left], [right]) => compareResourceHierarchy(left, right));

  for (const [resource, group] of orderedGroups) {
    while (stack.length && !resource.startsWith(`${stack.at(-1).resource}/`)) {
      const retired = stack.pop().group;
      for (const field of RESOURCE_FIELDS) removeActiveTasks(active[field], retired[field]);
    }
    for (const field of RESOURCE_FIELDS) fillTaskBits(current[field], group[field]);

    for (const taskIndex of group.writes ?? []) {
      orTaskBits(rows[taskIndex], active.writes.bits);
      orTaskBits(rows[taskIndex], active.reads.bits);
      orTaskBits(rows[taskIndex], current.writes);
      orTaskBits(rows[taskIndex], current.reads);
    }
    for (const taskIndex of group.reads ?? []) {
      orTaskBits(rows[taskIndex], active.writes.bits);
      orTaskBits(rows[taskIndex], current.writes);
    }
    for (const taskIndex of group.devices ?? []) {
      orTaskBits(rows[taskIndex], active.devices.bits);
      orTaskBits(rows[taskIndex], current.devices);
    }
    for (const taskIndex of group.externalEffects ?? []) {
      orTaskBits(rows[taskIndex], active.externalEffects.bits);
      orTaskBits(rows[taskIndex], current.externalEffects);
    }

    for (const field of RESOURCE_FIELDS) addActiveTasks(active[field], group[field]);
    stack.push({ resource, group });
  }

  // A normalized wildcard overlaps every non-empty declaration in its resource domain.
  for (const taskIndex of wildcards.writes) {
    orTaskBits(rows[taskIndex], all.writes);
    orTaskBits(rows[taskIndex], all.reads);
  }
  for (const taskIndex of wildcards.reads) orTaskBits(rows[taskIndex], all.writes);
  for (const taskIndex of wildcards.devices) orTaskBits(rows[taskIndex], all.devices);
  for (const taskIndex of wildcards.externalEffects) {
    orTaskBits(rows[taskIndex], all.externalEffects);
  }
  return rows;
}

function lowerBoundResources(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + ((high - low) >>> 1);
    if (compareSgosCodePoints(values[middle], target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexedResourceValues(values = []) {
  const entries = [];
  const byNormalized = new Map();
  for (const value of values) {
    const normalized = normalizedResource(value);
    if (!normalized) continue;
    entries.push({ normalized, value });
    const members = byNormalized.get(normalized) ?? [];
    members.push(value);
    byNormalized.set(normalized, members);
  }
  return {
    entries,
    byNormalized,
    normalized: [...byNormalized.keys()].sort(compareSgosCodePoints)
  };
}

function appendResourceOverlaps(conflicts, leftValues, rightValues, kind) {
  const right = indexedResourceValues(rightValues);
  const append = (left, values = []) => {
    for (const candidate of values) {
      // Retain this final predicate as the semantic oracle for normalization aliases and unusual
      // but contract-valid strings; the index only narrows candidates.
      if (resourceOverlap(left, candidate)) conflicts.push({ kind, left, right: candidate });
    }
  };
  for (const left of leftValues ?? []) {
    const normalized = normalizedResource(left);
    if (!normalized) continue;
    if (normalized === '*') {
      append(left, right.entries.map((entry) => entry.value));
      continue;
    }
    const exactOrAncestors = new Set(['*', normalized]);
    for (let slash = normalized.indexOf('/'); slash >= 0;
      slash = normalized.indexOf('/', slash + 1)) {
      if (slash > 0) exactOrAncestors.add(normalized.slice(0, slash));
    }
    for (const candidate of exactOrAncestors) append(left, right.byNormalized.get(candidate));

    const descendantPrefix = `${normalized}/`;
    for (let index = lowerBoundResources(right.normalized, descendantPrefix);
      index < right.normalized.length && right.normalized[index].startsWith(descendantPrefix);
      index += 1) {
      append(left, right.byNormalized.get(right.normalized[index]));
    }
  }
}

function resourceConflictDetails(left, right) {
  const conflicts = [];
  appendResourceOverlaps(conflicts, left.resources?.writes, right.resources?.writes, 'write/write');
  appendResourceOverlaps(conflicts, left.resources?.writes, right.resources?.reads, 'write/read');
  appendResourceOverlaps(conflicts, left.resources?.reads, right.resources?.writes, 'read/write');
  appendResourceOverlaps(conflicts, left.resources?.devices, right.resources?.devices, 'device/device');
  appendResourceOverlaps(
    conflicts,
    left.resources?.externalEffects,
    right.resources?.externalEffects,
    'effect/effect'
  );
  return conflicts.sort(canonicalCompare);
}

function assertNoUnsafeParallelResources(program, graph) {
  const reachable = reachabilityRows(graph);
  const resourceConflicts = resourceConflictRows(program);
  for (let leftIndex = 0; leftIndex < program.taskTemplates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < program.taskTemplates.length; rightIndex += 1) {
      if (!hasTaskBit(resourceConflicts[leftIndex], rightIndex)
          && !hasTaskBit(resourceConflicts[rightIndex], leftIndex)) continue;
      if (hasTaskBit(reachable[leftIndex], rightIndex)
          || hasTaskBit(reachable[rightIndex], leftIndex)) continue;
      const left = program.taskTemplates[leftIndex];
      const right = program.taskTemplates[rightIndex];
      const conflicts = resourceConflictDetails(left, right);
      // The task-level index is deliberately conservative around normalized aliases. Reconfirm the
      // exact pair before rejecting so an indexing optimization can never create a false denial.
      if (!conflicts.length) continue;
      fail('SGOS_PROGRAM_PARALLEL_CONFLICT', `Unordered tasks '${left.taskTemplateId}' and '${right.taskTemplateId}' have conflicting resources.`, {
        leftTaskTemplateId: left.taskTemplateId, rightTaskTemplateId: right.taskTemplateId,
        conflicts
      });
    }
  }
}

function assertInstalledJoins(program) {
  if (!Array.isArray(program.joins)) {
    fail('SGOS_JOIN_CONTRACT_MISMATCH',
      'Executable Programs require a canonical join-contract array; legacy object maps are read-only.');
  }
  let joins;
  try { joins = canonicalSgosJoins(program.joins ?? []); } catch (error) {
    fail(error?.code ?? 'SGOS_JOIN_INVALID', error?.message ?? String(error), error?.details ?? {});
  }
  if (canonicalJson(joins) !== canonicalJson(program.joins)) {
    fail('SGOS_JOIN_CONTRACT_MISMATCH',
      'Executable Program join contracts are not strict and canonically sorted.');
  }
  const tasks = new Map(program.taskTemplates.map((task) => [task.taskTemplateId, task]));
  const byTask = new Map(joins.map((join) => [join.taskTemplateId, join]));
  for (const task of program.taskTemplates) {
    const join = byTask.get(task.taskTemplateId) ?? null;
    if ((task.opcode === 'JOIN') !== (join !== null)) {
      fail('SGOS_JOIN_CONTRACT_MISMATCH',
        `Task '${task.taskTemplateId}' JOIN opcode and join contract must agree.`, {
          taskTemplateId: task.taskTemplateId
        });
    }
    if (join && canonicalJson(join.predecessorTaskTemplateIds)
        !== canonicalJson([...task.dependsOn].sort(compareSgosCodePoints))) {
      fail('SGOS_JOIN_CONTRACT_MISMATCH',
        `Join '${join.joinId}' predecessors do not match its graph dependencies.`, {
          joinId: join.joinId
        });
    }
  }
  for (const join of joins) {
    if (!tasks.has(join.taskTemplateId)) {
      fail('SGOS_JOIN_CONTRACT_MISMATCH', `Join '${join.joinId}' names an unknown task.`);
    }
  }
}

function assertInstalledFanout(program) {
  const groups = new Map();
  const coordinators = new Map();
  for (const task of program.taskTemplates) {
    const item = task.metadata?.fanout ?? null;
    const coordinator = task.metadata?.fanoutCoordinator ?? null;
    if (item && coordinator) {
      fail('SGOS_FANOUT_MATERIALIZATION_INVALID',
        `Task '${task.taskTemplateId}' cannot be both a fan-out item and coordinator.`);
    }
    if (item) {
      const parentTaskId = String(item.parentTaskId ?? '');
      if (!parentTaskId || typeof item.itemKey !== 'string'
          || !SHA256_PATTERN.test(String(item.itemSha256 ?? ''))
          || sgosFanoutChildTemplateId(parentTaskId, item.itemKey, item.itemSha256)
            !== task.taskTemplateId) {
        fail('SGOS_FANOUT_MATERIALIZATION_INVALID',
          `Task '${task.taskTemplateId}' has invalid deterministic fan-out identity.`);
      }
      const values = groups.get(parentTaskId) ?? [];
      values.push({ task, item });
      groups.set(parentTaskId, values);
    }
    if (coordinator) {
      const parentTaskId = String(coordinator.parentTaskId ?? '');
      if (!parentTaskId || parentTaskId !== task.taskTemplateId
          || coordinators.has(parentTaskId)) {
        fail('SGOS_FANOUT_MATERIALIZATION_INVALID',
          `Fan-out coordinator '${task.taskTemplateId}' is duplicate or mismatched.`);
      }
      coordinators.set(parentTaskId, { task, coordinator });
    }
  }
  if (new Set([...groups.keys(), ...coordinators.keys()]).size
      > SGOS_INSTALLED_LIMITS.maximumFanoutGroupsPerProcess) {
    fail('SGOS_FANOUT_LIMIT',
      'Program fan-out groups cannot fit the initial durable expansion boundary.', {
        maximum: SGOS_INSTALLED_LIMITS.maximumFanoutGroupsPerProcess
      });
  }
  for (const parentTaskId of new Set([...groups.keys(), ...coordinators.keys()])) {
    const children = groups.get(parentTaskId) ?? [];
    const installed = coordinators.get(parentTaskId) ?? null;
    if (!installed) {
      fail('SGOS_FANOUT_MATERIALIZATION_INVALID',
        `Fan-out '${parentTaskId}' has no exact coordinator.`);
    }
    const { task: coordinatorTask, coordinator } = installed;
    let normalized;
    try {
      normalized = normalizeSgosFanout({
        taskId: parentTaskId,
        items: children.map(({ item }) => ({ key: item.itemKey, value: item.itemValue })),
        maximumItems: coordinator.maximumItems,
        maximumParallel: coordinator.maximumParallel
      });
    } catch (error) {
      fail(error?.code ?? 'SGOS_FANOUT_MATERIALIZATION_INVALID',
        error?.message ?? String(error), error?.details ?? {});
    }
    const expectedChildren = normalized.items.map((entry) =>
      sgosFanoutChildTemplateId(parentTaskId, entry.itemKey, entry.itemSha256))
      .sort(compareSgosCodePoints);
    if (normalized.collectionSha256 !== coordinator.collectionSha256
        || canonicalJson([...coordinatorTask.dependsOn].sort(compareSgosCodePoints))
          !== canonicalJson(expectedChildren)
        || children.some(({ item }) => item.collectionSha256 !== normalized.collectionSha256
          || item.maximumItems !== normalized.maximumItems
          || item.maximumParallel !== normalized.maximumParallel)
        || (children.length === 0 ? coordinatorTask.opcode !== 'NOOP'
          : coordinatorTask.opcode !== 'JOIN')) {
      fail('SGOS_FANOUT_MATERIALIZATION_INVALID',
        `Fan-out '${parentTaskId}' does not match its finite approved collection.`);
    }
  }
}

function registryEntries(snapshot, field) {
  const raw = snapshot[field];
  const result = new Map();
  const entries = Array.isArray(raw)
    ? raw.map((entry) => [entry?.id, entry])
    : plainObject(raw) ? Object.entries(raw) : [];
  if (!Array.isArray(raw) && !plainObject(raw)) {
    fail('SGOS_PROGRAM_REGISTRY_INVALID', `Registry ${field} must be an array or object map.`);
  }
  for (const [mapId, entry] of entries) {
    const id = String(entry?.id ?? mapId ?? '');
    if (!id || !plainObject(entry) || entry.status !== 'active'
        || typeof entry.version !== 'string' || !entry.version.trim()) {
      fail('SGOS_PROGRAM_REGISTRY_INVALID', `Registry ${field} contains a malformed or inactive entry.`, { id: id || null });
    }
    const allowed = new Set(['id', 'version', 'status', 'manifestSha256', 'opcode', 'kind']);
    const unknown = Object.keys(entry).find((key) => !allowed.has(key));
    if (unknown) {
      fail('SGOS_PROGRAM_REGISTRY_INVALID', `Registry ${field} entry '${id}' contains unknown field '${unknown}'.`, {
        id, field: unknown
      });
    }
    if (mapId && entry.id != null && String(mapId) !== id) {
      fail('SGOS_PROGRAM_REGISTRY_INVALID', `Registry ${field} map key does not match entry ID '${id}'.`, { id });
    }
    requireDigest(entry.manifestSha256, `registry.${field}.${id}.manifestSha256`, 'SGOS_PROGRAM_REGISTRY_INVALID');
    if (result.has(id)) fail('SGOS_PROGRAM_REGISTRY_INVALID', `Registry ${field} duplicates '${id}'.`, { id });
    result.set(id, entry);
  }
  return result;
}

/** Verify actual registry bytes and all operation bindings retained in a Program. */
export function verifySgosProgramRegistry(programValue, registrySnapshot) {
  const program = programValue?.program ?? programValue;
  if (!plainObject(registrySnapshot) || registrySnapshot.kind !== 'registry-snapshot') {
    fail('SGOS_PROGRAM_REGISTRY_REQUIRED', 'Execution registry verification requires actual registry-snapshot bytes.');
  }
  const allowedRegistryFields = new Set([
    'kind', 'operations', 'taskKinds', 'devices', 'registrySnapshotSha256'
  ]);
  const unknownRegistryField = Object.keys(registrySnapshot)
    .find((key) => !allowedRegistryFields.has(key));
  if (unknownRegistryField) {
    fail('SGOS_PROGRAM_REGISTRY_INVALID', `Registry snapshot contains unknown field '${unknownRegistryField}'.`, {
      field: unknownRegistryField
    });
  }
  let actual;
  try { actual = registrySnapshotDigest(registrySnapshot); } catch (error) {
    fail('SGOS_PROGRAM_REGISTRY_INVALID', `Registry snapshot is invalid: ${error.message}`, {
      causeCode: error?.code ?? null
    });
  }
  if (registrySnapshot.registrySnapshotSha256 !== actual || program.registrySnapshotSha256 !== actual) {
    fail('SGOS_PROGRAM_REGISTRY_MISMATCH', 'Registry snapshot bytes do not match the Program pin.', {
      expected: program.registrySnapshotSha256,
      received: registrySnapshot.registrySnapshotSha256 ?? actual,
      actual
    });
  }
  const operations = registryEntries(registrySnapshot, 'operations');
  if (!operations.size) {
    fail('SGOS_PROGRAM_REGISTRY_INVALID', 'Registry snapshot has no active operation manifests.');
  }
  registryEntries(registrySnapshot, 'taskKinds');
  const devices = registryEntries(registrySnapshot, 'devices');
  for (const task of program.taskTemplates) {
    if (task.operation) {
      const operation = operations.get(task.operation);
      if (!operation) {
        fail('SGOS_PROGRAM_OPERATION_UNKNOWN', `Task '${task.taskTemplateId}' references operation '${task.operation}' absent from the pinned registry.`, {
          taskTemplateId: task.taskTemplateId, operation: task.operation
        });
      }
      const operationVersion = task.metadata?.operationVersion;
      if (operationVersion == null || String(operationVersion) !== String(operation.version)) {
        fail('SGOS_PROGRAM_OPERATION_VERSION_MISMATCH', `Task '${task.taskTemplateId}' operation version does not match the pinned registry.`, {
          taskTemplateId: task.taskTemplateId, operation: task.operation,
          expected: String(operation.version), received: operationVersion ?? null
        });
      }
      if (task.metadata?.operationManifestSha256 !== operation.manifestSha256) {
        fail('SGOS_PROGRAM_OPERATION_MANIFEST_MISMATCH', `Task '${task.taskTemplateId}' operation manifest does not match the pinned registry.`, {
          taskTemplateId: task.taskTemplateId, operation: task.operation,
          expected: operation.manifestSha256,
          received: task.metadata?.operationManifestSha256 ?? null
        });
      }
    }
    const verification = task.metadata?.verification;
    const verificationOperation = typeof verification?.operation === 'string'
      ? verification.operation
      : verification?.operation?.id ?? verification?.operationId ?? null;
    if (verificationOperation != null && !operations.has(String(verificationOperation))) {
      fail('SGOS_PROGRAM_OPERATION_UNKNOWN', `Task '${task.taskTemplateId}' references unknown verification operation '${verificationOperation}'.`, {
        taskTemplateId: task.taskTemplateId, operation: String(verificationOperation), role: 'verification'
      });
    }
    if (verificationOperation != null) {
      const operation = operations.get(String(verificationOperation));
      if (String(task.metadata?.verificationOperationVersion ?? '') !== String(operation.version)) {
        fail('SGOS_PROGRAM_OPERATION_VERSION_MISMATCH', `Task '${task.taskTemplateId}' verification operation version does not match the pinned registry.`, {
          taskTemplateId: task.taskTemplateId, operation: String(verificationOperation), role: 'verification',
          expected: String(operation.version), received: task.metadata?.verificationOperationVersion ?? null
        });
      }
      if (task.metadata?.verificationOperationManifestSha256 !== operation.manifestSha256) {
        fail('SGOS_PROGRAM_OPERATION_MANIFEST_MISMATCH', `Task '${task.taskTemplateId}' verification operation manifest does not match the pinned registry.`, {
          taskTemplateId: task.taskTemplateId, operation: String(verificationOperation), role: 'verification',
          expected: operation.manifestSha256,
          received: task.metadata?.verificationOperationManifestSha256 ?? null
        });
      }
    }
    if (task.opcode === 'DEVICE') {
      const deviceId = String(task.metadata?.deviceId ?? task.operation ?? '');
      if (!devices.has(deviceId)) {
        fail('SGOS_PROGRAM_DEVICE_UNKNOWN', `Task '${task.taskTemplateId}' references unknown device '${deviceId}'.`, {
          taskTemplateId: task.taskTemplateId, deviceId
        });
      }
    }
  }
  return deepFreeze({ verified: true, registrySnapshotSha256: actual });
}

/**
 * Re-run execution-safety invariants over an immutable Program without claiming compiler provenance.
 * Use assertSgosProgramExecutionAdmission before executing anything.
 */
export function validateSgosProgramStaticSafety(programValue, {
  supportedOpcodes = SGOS_EXECUTION_ADMISSION_OPCODES,
  maximumTasks = SGOS_INSTALLED_LIMITS.maximumTasks,
  maximumAttempts = 1,
  registrySnapshot = null
} = {}) {
  const program = programValue?.program ?? programValue;
  try { validateGvmProgram(program); } catch (error) {
    fail('SGOS_PROGRAM_CONTRACT_INVALID', `GVM Program violates its strict contract: ${error.message}`, {
      causeCode: error?.code ?? null
    });
  }
  for (const field of [
    'programSha256', 'intentIrSha256', 'workflowSha256', 'ratificationSha256',
    'policySnapshotSha256', 'registrySnapshotSha256', 'storageProfileSha256'
  ]) requireDigest(program[field], `gvm-program.${field}`);
  assertSgosInstalledProgramLimits(program);

  if (program.compiler?.id !== SGOS_COMPILER_ID || program.compiler?.version !== SGOS_COMPILER_VERSION) {
    fail('SGOS_PROGRAM_COMPILER_UNTRUSTED', 'Program does not name the installed deterministic SGOS compiler profile.', {
      expected: { id: SGOS_COMPILER_ID, version: SGOS_COMPILER_VERSION },
      received: clone(program.compiler ?? null)
    });
  }
  const installedOpcodes = new Set(supportedOpcodes);
  for (const task of program.taskTemplates) {
    if (!installedOpcodes.has(task.opcode)) {
      fail('SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', `Opcode '${task.opcode}' is not installed for execution admission.`, {
        opcode: task.opcode, taskTemplateId: task.taskTemplateId
      });
    }
  }
  const graph = graphFacts(program);
  assertDependenciesMatchEdges(program, graph);
  assertTerminalConditions(program, graph);
  assertInstalledJoins(program);
  assertInstalledFanout(program);
  assertEvidenceAuthorityAndRecovery(program);
  assertBudgets(program, { maximumTasks, maximumAttempts });
  assertNoUnsafeParallelResources(program, graph);
  const registry = registrySnapshot == null
    ? { verified: false, registrySnapshotSha256: program.registrySnapshotSha256 }
    : verifySgosProgramRegistry(program, registrySnapshot);

  return deepFreeze({
    safe: true,
    programId: program.programId,
    programSha256: program.programSha256,
    compiler: clone(program.compiler),
    graph: {
      taskCount: graph.taskIds.length,
      edgeCount: program.edges.length,
      roots: graph.taskIds.filter((id) => graph.reverse.get(id).length === 0),
      terminalTaskIds: [...graph.endTaskIds],
      topologicalOrder: [...graph.topologicalOrder]
    },
    registry
  });
}

export function sgosProgramAuthorityPath(programValue) {
  const program = programValue?.program ?? programValue;
  const digest = requireDigest(program?.programSha256, 'gvm-program.programSha256');
  return `singularity/sgos/program-authorities/${digest.slice('sha256:'.length)}.json`;
}

function validateProgramAuthorityRecord(record, program) {
  if (!plainObject(record)) {
    fail('SGOS_PROGRAM_AUTHORITY_INVALID', 'Approved Program authority must be a JSON object.');
  }
  const allowed = new Set([
    'format', 'programSha256', 'ratificationSha256', 'decision', 'approvedBy', 'approvedAt'
  ]);
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown) {
    fail('SGOS_PROGRAM_AUTHORITY_INVALID', `Approved Program authority contains unsupported field '${unknown}'.`, {
      field: unknown
    });
  }
  for (const field of allowed) {
    if (!Object.hasOwn(record, field)) {
      fail('SGOS_PROGRAM_AUTHORITY_INVALID', `Approved Program authority is missing '${field}'.`, {
        field
      });
    }
  }
  if (record.format !== PROGRAM_AUTHORITY_FORMAT || record.decision !== 'approved') {
    fail('SGOS_PROGRAM_AUTHORITY_INVALID', 'Program authority is not an approved SGOS v1 authority record.');
  }
  requireDigest(record.programSha256, 'program-authority.programSha256', 'SGOS_PROGRAM_AUTHORITY_INVALID');
  requireDigest(record.ratificationSha256, 'program-authority.ratificationSha256', 'SGOS_PROGRAM_AUTHORITY_INVALID');
  if (record.programSha256 !== program.programSha256
      || record.ratificationSha256 !== program.ratificationSha256) {
    fail('SGOS_PROGRAM_AUTHORITY_MISMATCH', 'Approved Program authority does not bind this exact Program and ratification.', {
      expectedProgramSha256: program.programSha256,
      receivedProgramSha256: record.programSha256,
      expectedRatificationSha256: program.ratificationSha256,
      receivedRatificationSha256: record.ratificationSha256
    });
  }
  if (!plainObject(record.approvedBy)
      || typeof record.approvedBy.kind !== 'string' || !record.approvedBy.kind
      || typeof record.approvedBy.id !== 'string' || !record.approvedBy.id) {
    fail('SGOS_PROGRAM_AUTHORITY_INVALID', 'Approved Program authority requires a typed approving principal.');
  }
  if (!Number.isFinite(Date.parse(record.approvedAt))) {
    fail('SGOS_PROGRAM_AUTHORITY_INVALID', 'Approved Program authority requires an ISO approval timestamp.');
  }
  return clone(record);
}

/**
 * Load the exact Program approval only from the fetched approved configuration/state authority.
 * The WeakSet mark is deliberately process-local and non-serializable: callers cannot turn an
 * arbitrary JSON object or the Program's own digest into an execution authority.
 */
export async function loadApprovedSgosProgramAuthority(root, programValue, {
  refreshAuthority = true
} = {}) {
  const program = programValue?.program ?? programValue;
  const relative = sgosProgramAuthorityPath(program);
  if (!isConfigurationReadPath(relative)) {
    fail('SGOS_PROGRAM_AUTHORITY_PATH_INVALID', `Program authority path '${relative}' is outside approved configuration.`);
  }
  return withTrustedSgosConfigurationRead(root, async (authority) => {
    if (!authority || authority.kind === 'working-tree' || !authority.ref || !authority.commit) {
      fail('SGOS_PROGRAM_AUTHORITY_UNAVAILABLE',
        'Execution requires an exact Program approval on the fetched sflow/config authority (or its verified state mirror).');
    }
    const selectedRoot = configurationReadRoot(root);
    let workflowBytes;
    try {
      workflowBytes = await readFile(path.join(selectedRoot, 'singularity', 'workflow.yml'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fail('SGOS_PROGRAM_AUTHORITY_UNAVAILABLE',
        'Approved configuration does not contain singularity/workflow.yml.');
    }
    let bytes;
    try {
      bytes = await readFile(path.join(selectedRoot, relative));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fail('SGOS_PROGRAM_AUTHORITY_UNAVAILABLE',
        `Approved configuration does not contain '${relative}'. Review and publish this exact Program before starting it.`, {
          path: relative, ref: authority.ref, commit: authority.commit
        });
    }
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) {
      fail('SGOS_PROGRAM_AUTHORITY_INVALID', `Approved Program authority '${relative}' is not valid JSON: ${error.message}`);
    }
    const record = validateProgramAuthorityRecord(parsed, program);
    const proof = deepFreeze({
      record,
      source: {
        kind: authority.kind,
        ref: authority.ref,
        commit: authority.commit,
        sourceCommit: authority.manifest?.source?.commit ?? authority.commit,
        path: relative,
        blobSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        configurationAuthority: {
          kind: authority.kind,
          ref: authority.ref,
          commit: authority.commit,
          workflowBlobSha256: `sha256:${createHash('sha256').update(workflowBytes).digest('hex')}`
        }
      }
    });
    verifiedProgramAuthorities.add(proof);
    return proof;
  }, {
    refreshAuthority,
    // Program dispatch needs only these exact authority bytes. Avoid rematerializing every
    // template, prompt, and agent on every Process step.
    selectPaths: ['singularity/workflow.yml', relative]
  });
}

export function createSgosProgramAuthorityRecord(programValue, { approvedBy, approvedAt } = {}) {
  const program = programValue?.program ?? programValue;
  return deepFreeze(validateProgramAuthorityRecord({
    format: PROGRAM_AUTHORITY_FORMAT,
    programSha256: program.programSha256,
    ratificationSha256: program.ratificationSha256,
    decision: 'approved',
    approvedBy: clone(approvedBy),
    approvedAt
  }, program));
}

function proveCompilerProvenance(program, { compilerRequest = null, programAuthority = null } = {}) {
  if (!plainObject(programAuthority) || !verifiedProgramAuthorities.has(programAuthority)) {
    fail('SGOS_PROGRAM_AUTHORITY_REQUIRED',
      'Execution requires a Program authority loaded from the exact approved configuration ref.');
  }
  validateProgramAuthorityRecord(programAuthority.record, program);
  const authorityProvenance = {
    method: 'approved-program-authority',
    programSha256: program.programSha256,
    ratificationSha256: program.ratificationSha256,
    source: clone(programAuthority.source)
  };
  if (compilerRequest != null) {
    let recompiled;
    try { recompiled = compileSgosProgram(compilerRequest).program; } catch (error) {
      fail('SGOS_PROGRAM_RECOMPILATION_FAILED', `Pinned compiler inputs cannot reproduce a Program: ${error.message}`, {
        causeCode: error?.code ?? null
      });
    }
    if (recompiled.programSha256 !== program.programSha256
        || canonicalJson(recompiled) !== canonicalJson(program)) {
      fail('SGOS_PROGRAM_RECOMPILATION_MISMATCH', 'Program bytes do not exactly match deterministic recompilation from the pinned inputs.', {
        expected: recompiled.programSha256, received: program.programSha256
      });
    }
    return {
      ...authorityProvenance,
      method: 'approved-authority+deterministic-recompilation',
      programSha256: program.programSha256,
      intentIrSha256: recompiled.intentIrSha256,
      workflowSha256: recompiled.workflowSha256,
      ratificationSha256: recompiled.ratificationSha256
    };
  }
  return authorityProvenance;
}

/**
 * The only admission API execution surfaces should call.
 *
 * `programAuthority` must be the opaque result of loadApprovedSgosProgramAuthority. A plain object,
 * a caller-supplied digest, or compiler inputs alone are never execution authority.
 */
export function assertSgosProgramExecutionAdmission(programValue, options = {}) {
  const program = programValue?.program ?? programValue;
  const compilerRequest = options.compilerRequest ?? null;
  const staticSafety = validateSgosProgramStaticSafety(program, {
    ...options,
    registrySnapshot: options.registrySnapshot ?? compilerRequest?.registrySnapshot ?? null
  });
  const provenance = proveCompilerProvenance(program, {
    compilerRequest,
    programAuthority: options.programAuthority ?? null
  });
  return deepFreeze({
    admitted: true,
    programId: program.programId,
    programSha256: program.programSha256,
    provenance,
    safety: staticSafety
  });
}
