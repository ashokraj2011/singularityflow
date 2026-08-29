/** Pure, authority-free Work Object projections over an SGOS process snapshot. */
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { compareSgosCodePoints } from './order.mjs';

function clone(value) {
  return structuredClone(value);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function sha256(value) {
  return `sha256:${recordSha256(value)}`;
}

const STATUS_LABELS = Object.freeze({
  queued: 'Queued',
  running: 'Running',
  'waiting-human': 'Needs you',
  blocked: 'Blocked',
  paused: 'Paused',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  'recovery-required': 'Recovery required'
});

function taskRank(task) {
  const rank = {
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
  return rank[task?.state] ?? 50;
}

function selectedTask(process, taskInstanceId = null) {
  if (taskInstanceId != null) return process.taskInstances?.[taskInstanceId] ?? null;
  return Object.values(process.taskInstances ?? {}).sort((left, right) =>
    taskRank(left) - taskRank(right)
      || compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId)
      || compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId))[0] ?? null;
}

function requestFor(process, task, requests) {
  const open = new Set(process.openHumanRequests ?? []);
  return requests
    .filter((request) => open.has(request?.requestSha256)
      && (!task || request.taskInstanceId === task.taskInstanceId))
    .sort((left, right) => compareSgosCodePoints(left.requestId, right.requestId))[0] ?? null;
}

function humanView(process, task, request) {
  return {
    type: 'form',
    schema: {
      type: 'object',
      title: request.prompt?.title ?? 'Human decision required',
      description: request.prompt?.detail ?? '',
      properties: {
        decision: {
          type: 'string',
          enum: ['approved', 'rejected', 'selected', 'provided', 'cancelled']
        },
        input: clone(request.inputSchema ?? { type: ['object', 'null'] })
      },
      required: ['decision'],
      'x-sgos': {
        requestType: request.requestType,
        authorityRequired: clone(request.authorityRequired),
        options: clone(request.options ?? []),
        expiresAt: request.expiresAt,
        processStatus: STATUS_LABELS[process.status] ?? process.status
      }
    },
    dataRef: `sfref:sgos-human-request:${request.requestSha256}`,
    actions: [{
      id: 'request.respond',
      label: 'Respond',
      operation: 'request.respond',
      inputSchema: {
        type: 'object',
        properties: {
          processId: { const: process.processId },
          requestId: { const: request.requestId },
          requestSha256: { const: request.requestSha256 },
          expectedRevision: { const: process.processRevision },
          decision: { type: 'string' },
          input: request.inputSchema ?? {}
        },
        required: ['processId', 'requestId', 'requestSha256', 'expectedRevision', 'decision']
      }
    }]
  };
}

function dashboardView(process, task) {
  const taskStates = Object.values(process.taskInstances ?? {}).reduce((counts, entry) => {
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    return counts;
  }, {});
  return {
    type: 'dashboard',
    schema: {
      type: 'object',
      title: STATUS_LABELS[process.status] ?? process.status,
      properties: {
        processStatus: { const: process.status },
        processRevision: { const: process.processRevision },
        currentTask: { const: task?.taskInstanceId ?? null },
        taskStates: { const: taskStates },
        evidenceReady: { const: Object.values(process.taskInstances ?? {}).filter((entry) => entry.receiptSha256).length }
      }
    },
    dataRef: `sfref:sgos-process:${process.processSha256}`,
    // Projection code never carries a callback or mutation closure.  Future actions must be stable
    // operation IDs and are re-resolved by the kernel against the source revision.
    actions: []
  };
}

/**
 * Return a deeply frozen projection.  There is intentionally no corresponding write function:
 * callers must send the operation ID back through the runtime, which rechecks revision and hash.
 */
export function projectSgosWorkObject(process, {
  taskInstanceId = null,
  humanRequests = []
} = {}) {
  if (process?.kind !== 'gvm-process' || !process.processId || !process.processSha256) {
    throw new SingularityFlowError('A Work Object requires an exact SGOS process snapshot.', {
      code: 'SGOS_WORK_OBJECT_SOURCE_INVALID'
    });
  }
  const task = selectedTask(process, taskInstanceId);
  const request = requestFor(process, task, humanRequests);
  const view = request ? humanView(process, task, request) : dashboardView(process, task);
  const identity = {
    processId: process.processId,
    taskInstanceId: task?.taskInstanceId ?? null,
    processSha256: process.processSha256,
    requestSha256: request?.requestSha256 ?? null
  };
  const core = {
    schemaVersion: currentSchemaVersion('work-object'),
    kind: 'work-object',
    objectId: `WKO-${recordSha256(identity).slice(0, 24).toUpperCase()}`,
    processId: process.processId,
    taskInstanceId: task?.taskInstanceId ?? null,
    view,
    // Stable for the same source revision; recomputing a read projection does not invent activity.
    createdAt: process.updatedAt ?? process.createdAt ?? null
  };
  return freezeDeep({ ...core, objectSha256: sha256(core) });
}

export function projectSgosWorkObjects(process, { humanRequests = [] } = {}) {
  const waiting = Object.values(process?.taskInstances ?? {})
    .filter((task) => task.state === 'waiting-human')
    .sort((left, right) => compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId));
  if (!waiting.length) return Object.freeze([projectSgosWorkObject(process, { humanRequests })]);
  return Object.freeze(waiting.map((task) => projectSgosWorkObject(process, {
    taskInstanceId: task.taskInstanceId,
    humanRequests
  })));
}
