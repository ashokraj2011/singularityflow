/**
 * Deterministic, projection-only SGOS Command Center read model.
 *
 * This module owns no mutation entry point.  Every action is a stable operation descriptor bound
 * to the exact Process bytes from which it was projected; a host must send the operation back to
 * the kernel, which re-reads authority before doing anything.  Keeping this projection in the
 * engine lets the CLI, desktop snapshot, and VS Code render the same answer without independently
 * interpreting runtime state.
 */
import { recordSha256 } from '../records.mjs';
import { compareSgosCodePoints } from './order.mjs';
import { projectSgosWorkObjects } from './projection.mjs';
import {
  listSgosProcesses, readSgosImmutableRecord
} from './store.mjs';

const STATUS_LABELS = Object.freeze({
  queued: 'Queued',
  running: 'Running',
  'waiting-human': 'Needs you',
  blocked: 'Blocked',
  paused: 'Paused',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  'recovery-required': 'Recovery required',
  unavailable: 'Unavailable'
});

/**
 * Capabilities are reported by the runtime, not guessed by a product surface.  Adding a runtime
 * feature therefore changes this one projection and every UI follows it.  Staged entries are
 * intentionally visible but are never rendered as executable actions.
 */
export const SGOS_RUNTIME_CAPABILITIES = Object.freeze({
  commandCenter: Object.freeze({ status: 'available', reason: 'Projection-only Process inventory and diagnosis are installed.' }),
  processGraph: Object.freeze({ status: 'available', reason: 'The installed bounded runtime exposes an exact Process graph.' }),
  humanResponse: Object.freeze({ status: 'available', reason: 'Human responses use request-hash and Process-revision compare-and-swap.' }),
  recovery: Object.freeze({ status: 'available', reason: 'Interrupted execution has an exact, confirmation-bound recovery plan.' }),
  parallelExecution: Object.freeze({ status: 'available', reason: 'One deterministic, statically bounded ready wave is installed with exact resource leases and joins.' }),
  replay: Object.freeze({ status: 'available', reason: 'Confirmation-bound replay is installed for pure suffixes from an ancestor checkpoint.' }),
  fork: Object.freeze({ status: 'available', reason: 'Confirmation-bound fork is installed for independent genesis-only Processes.' }),
  agentExecution: Object.freeze({ status: 'staged', reason: 'Governed AGENT execution-unit adapters are not installed.' }),
  deviceExecution: Object.freeze({ status: 'staged', reason: 'Typed DEVICE mediation is not installed.' }),
  taskRetry: Object.freeze({ status: 'staged', reason: 'Independent task retry is not installed.' })
});

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function exactAction(id, operation, process, { enabled = true, reason = null } = {}) {
  return {
    id,
    operation,
    enabled,
    reason,
    source: {
      processId: process.processId,
      processRevision: process.processRevision,
      processSha256: process.processSha256
    }
  };
}

function taskCounts(process) {
  return Object.fromEntries(Object.entries(Object.values(process.taskInstances ?? {}).reduce((counts, task) => {
    counts[task.state] = (counts[task.state] ?? 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => compareSgosCodePoints(left, right)));
}

function taskRank(task) {
  const ranks = {
    'waiting-human': 0,
    running: 1,
    verifying: 2,
    ready: 3,
    blocked: 4,
    'recovery-required': 5,
    waiting: 6,
    planned: 7,
    failed: 8,
    succeeded: 9,
    skipped: 10
  };
  return ranks[task?.state] ?? 50;
}

function currentTask(process) {
  const task = Object.values(process.taskInstances ?? {}).sort((left, right) =>
    taskRank(left) - taskRank(right)
      || compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId)
      || compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId))[0];
  return task == null ? null : {
    taskInstanceId: task.taskInstanceId,
    taskTemplateId: task.taskTemplateId,
    state: task.state,
    revision: task.revision,
    receiptSha256: task.receiptSha256
  };
}

function healthyCard(process) {
  const authority = process.authorityBinding ?? {};
  const tasks = Object.values(process.taskInstances ?? {});
  return {
    kind: 'sgos-process-card',
    processId: process.processId,
    processRevision: process.processRevision,
    processSha256: process.processSha256,
    programSha256: process.programSha256,
    status: process.status,
    statusLabel: STATUS_LABELS[process.status] ?? process.status,
    subject: {
      kind: authority.kind ?? null,
      id: authority.subjectId ?? null,
      branch: authority.branch ?? null,
      baselineRevision: authority.baselineRevision ?? null
    },
    taskCounts: taskCounts(process),
    currentTask: currentTask(process),
    taskCount: tasks.length,
    evidenceReady: tasks.filter((task) => task.receiptSha256 != null).length,
    openRequestCount: (process.openHumanRequests ?? []).length,
    currentCheckpointSha256: process.currentCheckpointSha256,
    updatedAt: process.updatedAt ?? process.createdAt ?? null,
    available: true,
    successClaimed: process.status === 'succeeded',
    resumable: process.status === 'paused',
    actions: [
      exactAction('process.inspect', 'process.status', process),
      exactAction('process.graph', 'process.graph', process),
      exactAction('process.integrity', 'process.fsck', process),
      exactAction('process.recovery-plan', 'process.recover.plan', process)
    ]
  };
}

function unavailableCard(process) {
  return {
    kind: 'sgos-process-unavailable-card',
    processId: process.processId,
    processRevision: null,
    processSha256: null,
    status: 'unavailable',
    statusLabel: STATUS_LABELS.unavailable,
    available: false,
    successClaimed: false,
    resumable: false,
    error: {
      code: process.error?.code ?? 'SGOS_PROCESS_UNAVAILABLE',
      message: process.error?.message ?? 'The Process cannot be read safely.'
    },
    actions: [{
      id: 'process.quarantine-plan',
      operation: 'process.quarantine.plan',
      enabled: true,
      reason: 'Inspect preserved private bytes before choosing whether to quarantine them.',
      source: { processId: process.processId, processRevision: null, processSha256: null }
    }]
  };
}

async function humanRequests(root, process) {
  const requests = [];
  for (const reference of process.openHumanRequests ?? []) {
    requests.push((await readSgosImmutableRecord(
      root, process.processId, 'human-request', reference
    )).record);
  }
  return requests.sort((left, right) => compareSgosCodePoints(left.requestId, right.requestId));
}

/** Build one stable board from exact Process snapshots. No files are written. */
export function projectSgosCommandCenter(listed, { humanRequestsByProcess = {} } = {}) {
  const processes = [];
  const needsYou = [];
  const unavailable = [];

  for (const process of listed) {
    if (process.kind !== 'gvm-process' || process.available === false) {
      unavailable.push(unavailableCard(process));
      continue;
    }
    try {
      const requests = humanRequestsByProcess[process.processId] ?? [];
      const workObjects = projectSgosWorkObjects(process, { humanRequests: requests });
      processes.push(healthyCard(process));
      needsYou.push(...workObjects.filter((entry) => entry.view?.type === 'form'));
    } catch (error) {
      unavailable.push(unavailableCard({
        processId: process.processId,
        error: { code: error?.code ?? 'SGOS_PROCESS_UNAVAILABLE', message: error?.message ?? String(error) }
      }));
    }
  }

  processes.sort((left, right) => compareSgosCodePoints(left.processId, right.processId));
  needsYou.sort((left, right) => compareSgosCodePoints(left.objectId, right.objectId));
  unavailable.sort((left, right) => compareSgosCodePoints(left.processId, right.processId));
  const counts = Object.fromEntries(Object.entries(processes.reduce((result, process) => {
    result[process.status] = (result[process.status] ?? 0) + 1;
    return result;
  }, {})).sort(([left], [right]) => compareSgosCodePoints(left, right)));
  if (unavailable.length) counts.unavailable = unavailable.length;

  const core = {
    projectionVersion: 1,
    kind: 'sgos-command-center',
    runtimeProfile: {
      id: 'bounded-static-parallel-lineage',
      capabilities: SGOS_RUNTIME_CAPABILITIES
    },
    counts,
    processes,
    needsYou,
    unavailable
  };
  return freezeDeep({ ...core, contentSha256: `sha256:${recordSha256(core)}` });
}

/** Load exact Process/request records, then pass them through the shared pure projection. */
export async function loadSgosCommandCenter(root) {
  const listed = await listSgosProcesses(root);
  const readable = [];
  const humanRequestsByProcess = {};
  for (const process of listed) {
    if (process.kind !== 'gvm-process' || process.available === false) {
      readable.push(process);
      continue;
    }
    try {
      humanRequestsByProcess[process.processId] = await humanRequests(root, process);
      readable.push(process);
    } catch (error) {
      readable.push({
        kind: 'sgos-process-unavailable', processId: process.processId, available: false,
        error: { code: error?.code ?? 'SGOS_PROCESS_UNAVAILABLE', message: error?.message ?? String(error) }
      });
    }
  }
  return projectSgosCommandCenter(readable, { humanRequestsByProcess });
}
