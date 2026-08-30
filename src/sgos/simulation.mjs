/**
 * Deterministic, read-only SGOS Program simulation.
 *
 * This module deliberately makes no filesystem, Git, clock, model, adapter, Device, or runtime
 * calls. It can describe only what is encoded in an immutable GVM Program. Runtime availability,
 * cost, elapsed time, and recovery success therefore remain explicit unknowns.
 */
import { canonicalJson } from '../records.mjs';
import {
  cloneSgosValue, sha256, validateGvmProgram
} from './contracts.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';
import {
  canonicalSgosResourceEntries, sgosResourceConflictDetails
} from './resource-contracts.mjs';

export const SGOS_SIMULATION_ASSURANCE = Object.freeze([
  'deterministically-proven',
  'historically-estimated',
  'model-advised',
  'unknown'
]);

export const SGOS_FAULT_FAILURES = Object.freeze([
  'interrupted',
  'malformed-result',
  'permission-denied',
  'timeout',
  'unavailable',
  'verification-failed'
]);

const PROVEN = SGOS_SIMULATION_ASSURANCE[0];
const UNKNOWN = SGOS_SIMULATION_ASSURANCE[3];
const DEVICE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REPORT_VERSION = 1;

export class SgosSimulationError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'SgosSimulationError';
    this.exitCode = 1;
    this.code = code;
    if (details != null) this.details = details;
  }
}

function fail(message, code, details = null) {
  throw new SgosSimulationError(message, code, details);
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!plain(value)) fail(`${label} must be an object.`, 'SGOS_SIMULATION_INPUT_INVALID');
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !accepted.has(key));
  if (unexpected.length) {
    fail(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`,
      'SGOS_SIMULATION_INPUT_INVALID', { unexpected });
  }
}

function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function sorted(values) {
  return [...new Set(values)].sort(compareSgosCodePoints);
}

function programInput(value) {
  return plain(value?.program) ? value.program : value;
}

function validatedProgram(value) {
  const input = programInput(value);
  let program;
  try {
    program = validateGvmProgram(input);
  } catch (error) {
    fail(`Program simulation requires a valid immutable GVM Program: ${error.message}`,
      'SGOS_SIMULATION_PROGRAM_INVALID', { causeCode: error?.code ?? null });
  }
  const bytes = Buffer.byteLength(canonicalJson(program), 'utf8');
  if (bytes > SGOS_INSTALLED_LIMITS.maximumProgramBytes) {
    fail(`Program exceeds the installed ${SGOS_INSTALLED_LIMITS.maximumProgramBytes}-byte simulation ceiling.`,
      'SGOS_SIMULATION_PROGRAM_TOO_LARGE', {
        bytes, maximumBytes: SGOS_INSTALLED_LIMITS.maximumProgramBytes
      });
  }
  if (program.taskTemplates.length > SGOS_INSTALLED_LIMITS.maximumTasks
      || program.edges.length > SGOS_INSTALLED_LIMITS.maximumEdges) {
    fail('Program exceeds the installed simulation graph ceiling.',
      'SGOS_SIMULATION_GRAPH_TOO_LARGE', {
        tasks: program.taskTemplates.length,
        edges: program.edges.length,
        maximumTasks: SGOS_INSTALLED_LIMITS.maximumTasks,
        maximumEdges: SGOS_INSTALLED_LIMITS.maximumEdges
      });
  }
  return program;
}

function graphFor(program) {
  const taskById = new Map();
  for (const task of program.taskTemplates) {
    if (taskById.has(task.taskTemplateId)) {
      fail(`Program contains duplicate task '${task.taskTemplateId}'.`,
        'SGOS_SIMULATION_GRAPH_INVALID', { taskTemplateId: task.taskTemplateId });
    }
    taskById.set(task.taskTemplateId, task);
    const declaredDevices = task.resources?.devices ?? [];
    if (declaredDevices.some((id) => typeof id !== 'string' || !DEVICE_ID.test(id))) {
      fail(`Task '${task.taskTemplateId}' has an invalid Device dependency ID.`,
        'SGOS_SIMULATION_DEPENDENCY_INVALID', { taskTemplateId: task.taskTemplateId });
    }
  }
  const ids = [...taskById.keys()].sort(compareSgosCodePoints);
  const forward = new Map(ids.map((id) => [id, []]));
  const reverse = new Map(ids.map((id) => [id, []]));
  const seenEdges = new Set();
  for (const edge of program.edges) {
    if (edge.condition != null) {
      fail('Program simulation does not support conditional edges.',
        'SGOS_SIMULATION_GRAPH_INVALID', { edge });
    }
    if (!taskById.has(edge.from) || !taskById.has(edge.to)) {
      fail(`Program edge '${edge.from}' -> '${edge.to}' references an unknown task.`,
        'SGOS_SIMULATION_GRAPH_INVALID', { edge });
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) {
      fail(`Program contains duplicate edge '${edge.from}' -> '${edge.to}'.`,
        'SGOS_SIMULATION_GRAPH_INVALID', { edge });
    }
    seenEdges.add(key);
    forward.get(edge.from).push(edge.to);
    reverse.get(edge.to).push(edge.from);
  }
  for (const values of [...forward.values(), ...reverse.values()]) values.sort(compareSgosCodePoints);
  for (const id of ids) {
    const declared = sorted(taskById.get(id).dependsOn ?? []);
    if (canonicalJson(declared) !== canonicalJson(reverse.get(id))) {
      fail(`Task '${id}' dependencies do not match the immutable Program edges.`,
        'SGOS_SIMULATION_GRAPH_INVALID', {
          taskTemplateId: id, declaredDependsOn: declared, edgePredecessors: reverse.get(id)
        });
    }
  }

  const indegree = new Map(ids.map((id) => [id, reverse.get(id).length]));
  const remaining = new Set(ids);
  const waves = [];
  const order = [];
  while (remaining.size) {
    const ready = [...remaining].filter((id) => indegree.get(id) === 0)
      .sort(compareSgosCodePoints);
    if (!ready.length) {
      fail('Program simulation cannot make deterministic progress because the graph contains a cycle.',
        'SGOS_SIMULATION_GRAPH_CYCLE', { remainingTaskIds: [...remaining].sort(compareSgosCodePoints) });
    }
    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      order.push(id);
      for (const successor of forward.get(id)) indegree.set(successor, indegree.get(successor) - 1);
    }
  }
  const roots = ids.filter((id) => reverse.get(id).length === 0);
  const leaves = ids.filter((id) => forward.get(id).length === 0);
  for (const wave of waves) {
    for (let left = 0; left < wave.length; left += 1) {
      for (let right = left + 1; right < wave.length; right += 1) {
        const leftId = wave[left];
        const rightId = wave[right];
        const conflicts = sgosResourceConflictDetails(
          canonicalSgosResourceEntries(taskById.get(leftId).resources),
          canonicalSgosResourceEntries(taskById.get(rightId).resources)
        );
        if (conflicts.length) {
          fail(`Dependency-ready tasks '${leftId}' and '${rightId}' have conflicting resources.`,
            'SGOS_SIMULATION_PARALLEL_UNSAFE', { leftTaskId: leftId, rightTaskId: rightId, conflicts });
        }
      }
    }
  }
  const terminalTaskIds = program.taskTemplates.filter((task) => task.opcode === 'END')
    .map((task) => task.taskTemplateId).sort(compareSgosCodePoints);
  if (!terminalTaskIds.length || terminalTaskIds.some((id) => forward.get(id).length)) {
    fail('Program simulation requires terminal END tasks with no successors.',
      'SGOS_SIMULATION_TERMINAL_INVALID', { terminalTaskIds });
  }
  const canReachTerminal = new Set();
  const terminalQueue = [...terminalTaskIds];
  while (terminalQueue.length) {
    const id = terminalQueue.shift();
    if (canReachTerminal.has(id)) continue;
    canReachTerminal.add(id);
    for (const predecessor of reverse.get(id) ?? []) {
      if (!canReachTerminal.has(predecessor)) terminalQueue.push(predecessor);
    }
    terminalQueue.sort(compareSgosCodePoints);
  }
  const strandedTaskIds = ids.filter((id) => !canReachTerminal.has(id));
  if (strandedTaskIds.length) {
    fail('Program contains tasks that cannot reach a terminal END task.',
      'SGOS_SIMULATION_TERMINAL_INVALID', { strandedTaskIds, terminalTaskIds });
  }
  return { taskById, ids, forward, reverse, roots, leaves, waves, order };
}

function comparePaths(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareSgosCodePoints(left[index], right[index]);
    if (compared) return compared;
  }
  return left.length - right.length;
}

function criticalPath(graph) {
  const best = new Map();
  for (const id of graph.order) {
    const predecessors = graph.reverse.get(id);
    if (!predecessors.length) {
      best.set(id, [id]);
      continue;
    }
    const candidates = predecessors.map((predecessor) => [...best.get(predecessor), id]);
    candidates.sort((left, right) => right.length - left.length || comparePaths(left, right));
    best.set(id, candidates[0]);
  }
  const terminalCandidates = graph.leaves.map((id) => best.get(id));
  terminalCandidates.sort((left, right) => right.length - left.length || comparePaths(left, right));
  return terminalCandidates[0] ?? [];
}

function descendants(graph, startIds) {
  const seen = new Set();
  const queue = sorted(startIds);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of graph.forward.get(id) ?? []) if (!seen.has(next)) queue.push(next);
    queue.sort(compareSgosCodePoints);
  }
  return [...seen].sort(compareSgosCodePoints);
}

function deviceIdsForTask(task) {
  return sorted([
    ...(task.resources?.devices ?? []),
    ...(typeof task.metadata?.deviceId === 'string' && DEVICE_ID.test(task.metadata.deviceId)
      ? [task.metadata.deviceId] : [])
  ]);
}

function digestOrNull(value) {
  return typeof value === 'string' && SHA256.test(value) ? value : null;
}

function taskDependencies(program) {
  const dependencies = [];
  for (const task of program.taskTemplates) {
    const deviceIds = deviceIdsForTask(task);
    for (const deviceId of deviceIds) {
      dependencies.push({
        dependencyKind: 'device',
        dependencyId: deviceId,
        taskTemplateId: task.taskTemplateId,
        manifestSha256: task.metadata?.deviceId === deviceId
          ? digestOrNull(task.metadata?.deviceManifestSha256) : null,
        availability: 'unknown',
        assurance: UNKNOWN,
        reason: 'A Program pins the dependency declaration; current adapter availability requires runtime authority.'
      });
    }
    if (task.opcode === 'DEVICE' && !deviceIds.length) {
      dependencies.push({
        dependencyKind: 'device',
        dependencyId: null,
        taskTemplateId: task.taskTemplateId,
        manifestSha256: null,
        availability: 'unknown',
        assurance: UNKNOWN,
        reason: 'This legacy DEVICE task does not expose an exact dependency identity.'
      });
    }
    if (task.opcode === 'AGENT') {
      const executionUnitId = typeof task.metadata?.executionUnitId === 'string'
        && DEVICE_ID.test(task.metadata.executionUnitId)
        ? task.metadata.executionUnitId : null;
      dependencies.push({
        dependencyKind: 'execution-unit',
        dependencyId: executionUnitId,
        taskTemplateId: task.taskTemplateId,
        manifestSha256: digestOrNull(task.metadata?.executionUnitManifestSha256),
        availability: 'unknown',
        assurance: UNKNOWN,
        reason: executionUnitId
          ? 'A Program pins the dependency declaration; current adapter availability requires runtime authority.'
          : 'This legacy AGENT task does not expose an exact Execution Unit identity.'
      });
    }
  }
  return dependencies.sort((left, right) =>
    compareSgosCodePoints(left.dependencyKind, right.dependencyKind)
    || compareSgosCodePoints(left.dependencyId, right.dependencyId)
    || compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId));
}

function collectAssurance(value, counts = Object.fromEntries(
  SGOS_SIMULATION_ASSURANCE.map((classification) => [classification, 0])
)) {
  if (Array.isArray(value)) {
    for (const entry of value) collectAssurance(entry, counts);
  } else if (plain(value)) {
    if (typeof value.assurance === 'string' && Object.hasOwn(counts, value.assurance)) {
      counts[value.assurance] += 1;
    }
    for (const child of Object.values(value)) collectAssurance(child, counts);
  }
  return counts;
}

function sealReport(report) {
  const core = cloneSgosValue({ ...report, reportSha256: null });
  const output = { ...core, reportSha256: sha256(core) };
  const bytes = Buffer.byteLength(canonicalJson(output), 'utf8');
  if (bytes > SGOS_INSTALLED_LIMITS.maximumRecordBytes) {
    fail(`Simulation output exceeds the installed ${SGOS_INSTALLED_LIMITS.maximumRecordBytes}-byte ceiling.`,
      'SGOS_SIMULATION_OUTPUT_TOO_LARGE', {
        bytes, maximumBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes
      });
  }
  return frozen(output);
}

function sealClassifiedReport(report) {
  return sealReport({
    ...report,
    assuranceVocabulary: [...SGOS_SIMULATION_ASSURANCE],
    assuranceSummary: {
      scope: 'classified-claim-objects',
      counts: collectAssurance(report),
      assurance: PROVEN
    }
  });
}

function simulationClaims(program, graph) {
  const waveByTask = new Map();
  graph.waves.forEach((wave, index) => wave.forEach((id) => waveByTask.set(id, index + 1)));
  const path = criticalPath(graph);
  const reads = sorted(program.taskTemplates.flatMap((task) => task.resources?.reads ?? []));
  const writes = sorted(program.taskTemplates.flatMap((task) => task.resources?.writes ?? []));
  const externalEffects = program.taskTemplates.flatMap((task) =>
    (task.resources?.externalEffects ?? []).map((effect) => ({
      taskTemplateId: task.taskTemplateId,
      effect,
      assurance: PROVEN
    }))).sort((left, right) =>
    compareSgosCodePoints(left.effect, right.effect)
    || compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId));
  const devices = program.taskTemplates.flatMap((task) =>
    deviceIdsForTask(task).map((deviceId) => ({
      taskTemplateId: task.taskTemplateId,
      deviceId,
      deviceManifestSha256: task.metadata?.deviceId === deviceId
        ? digestOrNull(task.metadata?.deviceManifestSha256) : null,
      assurance: PROVEN
    }))).sort((left, right) =>
    compareSgosCodePoints(left.deviceId, right.deviceId)
    || compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId));
  const networkEffects = externalEffects.filter(({ effect }) => effect.startsWith('network:'));
  const unclassifiedExternalEffects = externalEffects.filter(({ effect }) => !effect.startsWith('network:'));
  const failureAndRecovery = program.taskTemplates.map((task) => ({
    taskTemplateId: task.taskTemplateId,
    directFailureSuccessorTaskIds: [...graph.forward.get(task.taskTemplateId)],
    maximumAttempts: task.retry?.maximumAttempts ?? 1,
    recoveryContract: cloneSgosValue(task.recovery ?? {}),
    assurance: PROVEN,
    recoveryOutcome: {
      value: null,
      assurance: UNKNOWN,
      reason: 'A declared recovery contract does not prove that recovery will succeed at runtime.'
    }
  }));

  return {
    schedule: {
      assurance: PROVEN,
      tasks: program.taskTemplates.map((task) => ({
        taskTemplateId: task.taskTemplateId,
        opcode: task.opcode,
        operation: task.operation ?? null,
        wave: waveByTask.get(task.taskTemplateId),
        predecessorTaskIds: [...graph.reverse.get(task.taskTemplateId)],
        successorTaskIds: [...graph.forward.get(task.taskTemplateId)],
        assurance: PROVEN
      })),
      criticalPath: {
        taskTemplateIds: path,
        taskCount: path.length,
        edgeCount: Math.max(0, path.length - 1),
        basis: 'longest-dependency-path-by-task-count',
        assurance: PROVEN
      },
      parallelGroups: graph.waves.filter((wave) => wave.length > 1).map((wave) => ({
        wave: graph.waves.indexOf(wave) + 1,
        taskTemplateIds: [...wave],
        basis: 'dependency-ready-and-resource-nonconflicting',
        assurance: PROVEN
      }))
    },
    humanStops: {
      items: program.taskTemplates.filter((task) => task.opcode === 'HUMAN_REQUEST').map((task) => ({
        taskTemplateId: task.taskTemplateId,
        authority: cloneSgosValue(task.authority ?? {}),
        assurance: PROVEN
      })),
      assurance: PROVEN
    },
    effects: {
      devices: { items: devices, assurance: PROVEN },
      external: { items: externalEffects, assurance: PROVEN },
      network: {
        items: networkEffects,
        assurance: unclassifiedExternalEffects.length ? UNKNOWN : PROVEN,
        reason: unclassifiedExternalEffects.length
          ? 'Only external effects with the exact network: resource prefix can be classified as network effects.'
          : null
      },
      performed: false,
      assurance: PROVEN
    },
    storage: {
      profileSha256: program.storageProfileSha256,
      readResources: reads,
      writeResources: writes,
      assurance: PROVEN,
      capacitySufficiency: {
        value: null,
        assurance: UNKNOWN,
        reason: 'The immutable Program pins a storage profile but carries no live capacity attestation.'
      }
    },
    estimates: {
      cost: {
        value: null,
        unit: null,
        assurance: UNKNOWN,
        reason: 'No reviewed historical estimator was supplied; simulation does not invent a cost.'
      },
      elapsedTime: {
        value: null,
        unit: null,
        assurance: UNKNOWN,
        reason: 'No reviewed historical estimator was supplied; simulation does not invent a duration.'
      },
      assurance: UNKNOWN
    },
    blastRadius: {
      writableResources: writes,
      externalEffects: externalEffects.map(({ taskTemplateId, effect }) => ({ taskTemplateId, effect })),
      maximumReadyWidth: Math.max(0, ...graph.waves.map((wave) => wave.length)),
      assurance: PROVEN,
      runtimeReachability: {
        value: null,
        assurance: UNKNOWN,
        reason: 'Declared scope is proven; live credentials and reachable systems are not inspected.'
      }
    },
    failureAndRecovery: {
      items: failureAndRecovery,
      assurance: PROVEN
    },
    unavailableDependencies: {
      items: taskDependencies(program),
      assurance: UNKNOWN,
      reason: 'Read-only Program simulation does not inspect the runtime registry or start adapters.'
    }
  };
}

/**
 * Produce an assurance-classified schedule and impact report without reading or mutating runtime
 * state. Legacy scheduling fields remain at the top level for existing `simulateSgosProgram`
 * consumers.
 */
export function simulateSgosProgramAssurance(value) {
  const program = validatedProgram(value);
  const graph = graphFor(program);
  const claims = simulationClaims(program, graph);
  const terminalTaskIds = program.taskTemplates.filter((task) => task.opcode === 'END')
    .map((task) => task.taskTemplateId).sort(compareSgosCodePoints);
  return sealClassifiedReport({
    reportVersion: REPORT_VERSION,
    kind: 'gvm-program-simulation',
    programId: program.programId,
    programSha256: program.programSha256,
    bounded: true,
    readOnly: true,
    consequentialEffectsPerformed: false,
    // Compatibility view from the original model-free simulator.
    waves: graph.waves.map((wave) => [...wave]),
    topologicalOrder: [...graph.order],
    maximumReadyWidth: Math.max(0, ...graph.waves.map((wave) => wave.length)),
    terminalTaskIds,
    receiptRequiredTaskIds: [...graph.order],
    compatibilityAssurance: PROVEN,
    claims
  });
}

function exactDeviceIds(options) {
  exactKeys(options, ['withoutDeviceIds'], 'What-if options');
  if (!Array.isArray(options.withoutDeviceIds) || options.withoutDeviceIds.length < 1
      || options.withoutDeviceIds.length > 64) {
    fail('What-if simulation requires one to 64 exact device IDs.',
      'SGOS_SIMULATION_INPUT_INVALID');
  }
  const result = [...options.withoutDeviceIds];
  if (result.some((value) => typeof value !== 'string' || !DEVICE_ID.test(value))
      || new Set(result).size !== result.length) {
    fail('What-if device IDs must be unique lower-case identifiers.',
      'SGOS_SIMULATION_INPUT_INVALID');
  }
  return result.sort(compareSgosCodePoints);
}

/** Describe the exact structural impact of removing one or more declared Devices. */
export function whatIfSgosProgram(value, options) {
  const program = validatedProgram(value);
  const graph = graphFor(program);
  const withoutDeviceIds = exactDeviceIds(options);
  const knownDeviceIds = sorted(program.taskTemplates.flatMap(deviceIdsForTask));
  const absent = withoutDeviceIds.filter((id) => !knownDeviceIds.includes(id));
  if (absent.length) {
    fail(`What-if target device is not declared by this Program: ${absent.join(', ')}.`,
      'SGOS_SIMULATION_DEVICE_NOT_FOUND', { absent, knownDeviceIds });
  }
  const directTaskIds = program.taskTemplates.filter((task) =>
    deviceIdsForTask(task).some((id) => withoutDeviceIds.includes(id)))
    .map((task) => task.taskTemplateId).sort(compareSgosCodePoints);
  const blockedTaskIds = descendants(graph, directTaskIds);
  const blocked = new Set(blockedTaskIds);
  const terminalTaskIds = program.taskTemplates.filter((task) => task.opcode === 'END')
    .map((task) => task.taskTemplateId).sort(compareSgosCodePoints);
  const blockedTerminalTaskIds = terminalTaskIds.filter((id) => blocked.has(id));
  const diagnostics = [{
    code: 'device-removed',
    deviceIds: withoutDeviceIds,
    directlyBlockedTaskIds: directTaskIds,
    assurance: PROVEN
  }];
  if (blockedTerminalTaskIds.length) diagnostics.push({
    code: 'terminal-path-blocked',
    terminalTaskIds: blockedTerminalTaskIds,
    assurance: PROVEN
  });
  return sealClassifiedReport({
    reportVersion: REPORT_VERSION,
    kind: 'gvm-program-what-if',
    programId: program.programId,
    programSha256: program.programSha256,
    readOnly: true,
    consequentialEffectsPerformed: false,
    without: { kind: 'device', ids: withoutDeviceIds, assurance: PROVEN },
    impact: {
      directTaskIds,
      blockedTaskIds,
      unaffectedTaskIds: graph.ids.filter((id) => !blocked.has(id)),
      blockedTerminalTaskIds,
      allTerminalPathsBlocked: terminalTaskIds.length > 0
        && blockedTerminalTaskIds.length === terminalTaskIds.length,
      assurance: PROVEN
    },
    diagnostics,
    estimates: {
      costDelta: { value: null, assurance: UNKNOWN, reason: 'No reviewed cost estimator was supplied.' },
      elapsedTimeDelta: { value: null, assurance: UNKNOWN, reason: 'No reviewed duration estimator was supplied.' },
      assurance: UNKNOWN
    }
  });
}

function exactFaultOptions(options) {
  exactKeys(options, ['target', 'failure'], 'Fault-plan options');
  exactKeys(options.target, ['kind', 'id'], 'Fault-plan target');
  if (!['task', 'device'].includes(options.target.kind)) {
    fail("Fault-plan target.kind must be 'task' or 'device'.", 'SGOS_SIMULATION_INPUT_INVALID');
  }
  const id = options.target.id;
  const pattern = options.target.kind === 'device' ? DEVICE_ID : TASK_ID;
  if (typeof id !== 'string' || !pattern.test(id)) {
    fail(`Fault-plan ${options.target.kind} target is invalid.`, 'SGOS_SIMULATION_INPUT_INVALID');
  }
  if (typeof options.failure !== 'string') {
    fail(`Fault-plan failure must be one of: ${SGOS_FAULT_FAILURES.join(', ')}.`,
      'SGOS_SIMULATION_FAILURE_INVALID', { allowed: SGOS_FAULT_FAILURES });
  }
  if (!SGOS_FAULT_FAILURES.includes(options.failure)) {
    fail(`Unsupported simulated failure '${options.failure}'. Allowed: ${SGOS_FAULT_FAILURES.join(', ')}.`,
      'SGOS_SIMULATION_FAILURE_INVALID', { allowed: SGOS_FAULT_FAILURES });
  }
  return { target: { kind: options.target.kind, id }, failure: options.failure };
}

/**
 * Plan a closed-vocabulary fault scenario. This never injects the fault and never accepts a
 * callback, Process identifier, adapter, model, or execution handle.
 */
export function planSgosProgramFault(value, options) {
  const program = validatedProgram(value);
  const graph = graphFor(program);
  const { target, failure } = exactFaultOptions(options);
  let directTaskIds;
  if (target.kind === 'task') {
    if (!graph.taskById.has(target.id)) {
      fail(`Fault-plan task '${target.id}' is not present in this Program.`,
        'SGOS_SIMULATION_TASK_NOT_FOUND', { taskTemplateId: target.id });
    }
    directTaskIds = [target.id];
  } else {
    directTaskIds = program.taskTemplates.filter((task) => deviceIdsForTask(task).includes(target.id))
      .map((task) => task.taskTemplateId).sort(compareSgosCodePoints);
    if (!directTaskIds.length) {
      fail(`Fault-plan device '${target.id}' is not declared by this Program.`,
        'SGOS_SIMULATION_DEVICE_NOT_FOUND', { deviceId: target.id });
    }
  }
  const affectedTaskIds = descendants(graph, directTaskIds);
  const affected = new Set(affectedTaskIds);
  const terminalTaskIds = program.taskTemplates.filter((task) => task.opcode === 'END')
    .map((task) => task.taskTemplateId).filter((id) => affected.has(id))
    .sort(compareSgosCodePoints);
  const recovery = directTaskIds.map((id) => {
    const task = graph.taskById.get(id);
    return {
      taskTemplateId: id,
      maximumAttempts: task.retry?.maximumAttempts ?? 1,
      recoveryContract: cloneSgosValue(task.recovery ?? {}),
      assurance: PROVEN,
      recoveryOutcome: {
        value: null,
        assurance: UNKNOWN,
        reason: 'Fault planning proves only the declared route; it does not execute or verify recovery.'
      }
    };
  });
  return sealClassifiedReport({
    reportVersion: REPORT_VERSION,
    kind: 'gvm-program-fault-plan',
    programId: program.programId,
    programSha256: program.programSha256,
    target: { ...target, assurance: PROVEN },
    failure: { id: failure, assurance: PROVEN },
    planOnly: true,
    readOnly: true,
    faultInjected: false,
    executionPerformed: false,
    impact: {
      directTaskIds,
      affectedTaskIds,
      affectedTerminalTaskIds: terminalTaskIds,
      assurance: PROVEN
    },
    recovery: { items: recovery, assurance: PROVEN }
  });
}
