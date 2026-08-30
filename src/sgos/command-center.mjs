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
import {
  projectSgosViewCatalog, projectSgosWorkObjects, SGOS_PROJECTED_VIEW_TYPES
} from './projection.mjs';
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
  stopQuiescence: Object.freeze({ status: 'available', reason: 'Stop records paused authority immediately and execution must settle before resume.' }),
  replay: Object.freeze({ status: 'available', reason: 'Confirmation-bound replay is installed for pure suffixes from an ancestor checkpoint.' }),
  fork: Object.freeze({ status: 'available', reason: 'Confirmation-bound fork is installed for independent genesis-only Processes.' }),
  agentExecution: Object.freeze({ status: 'available', reason: 'The exact deterministic-translator manifest is installed; model-backed agents remain proposal-only.' }),
  deviceExecution: Object.freeze({ status: 'available', reason: 'The exact read-only filesystem Device is installed with durable Tool Intent and Tool Result evidence.' }),
  taskRetry: Object.freeze({ status: 'available', reason: 'A failed pure/read-only task can be retried through an exact preview, confirmation, and Process CAS while preserving parent-attempt lineage.' })
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
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(process.status);
  const quiescent = (process.activeExecutions?.length ?? 0) === 0
    && (process.activeLeases?.length ?? 0) === 0;
  const resumable = process.status === 'paused' && quiescent
    && process.currentCheckpointSha256 != null;
  const dispatchable = process.status === 'running' && quiescent
    && (process.openHumanRequests?.length ?? 0) === 0
    && tasks.some((task) => task.state === 'ready');
  const lineagePreviewable = quiescent && process.currentCheckpointSha256 != null;
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
    // A stop records `paused` before an in-flight owner settles.  Do not project that intermediate
    // state as resumable: the runtime will refuse it, and the UI must not imply otherwise.
    resumable,
    actions: [
      exactAction('process.inspect', 'process.status', process),
      exactAction('process.graph', 'process.graph', process),
      exactAction('process.integrity', 'process.fsck', process),
      exactAction('process.pause', 'process.pause', process, {
        enabled: !terminal && process.status !== 'paused' && quiescent,
        reason: terminal
          ? 'Terminal Processes cannot be paused.'
          : process.status === 'paused'
            ? 'The Process is already paused.'
            : !quiescent ? 'Use stop while execution is active.' : null
      }),
      exactAction('process.stop', 'process.stop', process, {
        enabled: !terminal,
        reason: terminal
          ? 'Terminal Processes cannot be stopped.' : null
      }),
      exactAction('process.resume', 'process.resume', process, {
        enabled: resumable,
        reason: process.status !== 'paused'
          ? 'Only a paused Process can resume.'
          : !quiescent ? 'Execution must quiesce before resume.'
            : process.currentCheckpointSha256 == null
              ? 'No exact checkpoint is available for resume.' : null
      }),
      exactAction('process.step', 'process.step', process, {
        enabled: dispatchable,
        reason: dispatchable ? null
          : 'Step requires a running, quiescent Process with a ready task and no open Human Request.'
      }),
      exactAction('process.run', 'process.run', process, {
        enabled: dispatchable,
        reason: dispatchable ? null
          : 'Run requires a running, quiescent Process with a ready task and no open Human Request.'
      }),
      exactAction('process.recovery-plan', 'process.recover.plan', process),
      exactAction('process.replay-plan', 'process.replay.plan', process, {
        enabled: lineagePreviewable,
        reason: lineagePreviewable ? null
          : 'Replay preview requires a quiescent Process with a checkpoint.'
      }),
      exactAction('process.fork-plan', 'process.fork.plan', process, {
        enabled: lineagePreviewable,
        reason: lineagePreviewable ? null
          : 'Fork preview requires a quiescent Process with a checkpoint.'
      })
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
  const views = [];
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
      needsYou.push(...workObjects.filter((entry) =>
        entry.view?.schema?.['x-sgos']?.needsYou === true));
      views.push(...projectSgosViewCatalog(process, { humanRequests: requests }));
    } catch (error) {
      unavailable.push(unavailableCard({
        processId: process.processId,
        error: { code: error?.code ?? 'SGOS_PROCESS_UNAVAILABLE', message: error?.message ?? String(error) }
      }));
    }
  }

  processes.sort((left, right) => compareSgosCodePoints(left.processId, right.processId));
  needsYou.sort((left, right) => compareSgosCodePoints(left.objectId, right.objectId));
  views.sort((left, right) => compareSgosCodePoints(left.processId, right.processId)
    || SGOS_PROJECTED_VIEW_TYPES.indexOf(left.view.type)
      - SGOS_PROJECTED_VIEW_TYPES.indexOf(right.view.type)
    || compareSgosCodePoints(left.objectId, right.objectId));
  unavailable.sort((left, right) => compareSgosCodePoints(left.processId, right.processId));
  const counts = Object.fromEntries(Object.entries(processes.reduce((result, process) => {
    result[process.status] = (result[process.status] ?? 0) + 1;
    return result;
  }, {})).sort(([left], [right]) => compareSgosCodePoints(left, right)));
  if (unavailable.length) counts.unavailable = unavailable.length;

  const core = {
    projectionVersion: 2,
    kind: 'sgos-command-center',
    runtimeProfile: {
      id: 'bounded-static-parallel-lineage',
      capabilities: SGOS_RUNTIME_CAPABILITIES
    },
    counts,
    processes,
    needsYou,
    views,
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
