/** Pure, authority-free Work Object projections over an SGOS process snapshot. */
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { compareSgosCodePoints } from './order.mjs';

export const SGOS_PROJECTED_VIEW_TYPES = Object.freeze([
  'overview', 'graph', 'board', 'timeline', 'table', 'document', 'form', 'evidence',
  'diff', 'matrix', 'chart', 'log', 'metrics', 'simulation', 'approval'
]);

const HEAVY_VIEW_TYPES = new Set([
  'graph', 'document', 'evidence', 'diff', 'matrix', 'chart', 'log', 'metrics',
  'simulation'
]);
const APPROVAL_VIEW_REQUEST_TYPES = new Set([
  'approval', 'exception', 'evidence-review', 'scope-expansion', 'production-authority',
  'scientific-judgment', 'legal-judgment'
]);
const MAXIMUM_RENDER_ROWS = 200;

const VIEW_LABELS = Object.freeze({
  overview: 'Process overview',
  graph: 'Task dependency graph',
  board: 'Task board',
  timeline: 'Process timeline',
  table: 'Task table',
  document: 'Process document',
  form: 'Human request form',
  evidence: 'Evidence ledger',
  diff: 'State comparison',
  matrix: 'Task evidence matrix',
  chart: 'Task-state chart',
  log: 'Process log',
  metrics: 'Process metrics',
  simulation: 'Simulation result',
  approval: 'Approval request'
});

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

function sortedTasks(process) {
  return Object.values(process.taskInstances ?? {}).sort((left, right) =>
    compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId)
      || compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId));
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

function requestViewType(request) {
  return APPROVAL_VIEW_REQUEST_TYPES.has(request?.requestType) ? 'approval' : 'form';
}

function taskStateCounts(process) {
  return Object.fromEntries(Object.entries(sortedTasks(process).reduce((counts, entry) => {
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => compareSgosCodePoints(left, right)));
}

function boundedRows(rows) {
  return {
    rows: rows.slice(0, MAXIMUM_RENDER_ROWS),
    truncated: rows.length > MAXIMUM_RENDER_ROWS
  };
}

function viewData(viewType, process, task, request) {
  const tasks = sortedTasks(process);
  const counts = taskStateCounts(process);
  const requestChoices = (request?.options ?? []).map((option) => ({
    id: option.id,
    label: option.label,
    consequence: option.consequence ?? 'No consequence was declared by the Program.'
  }));
  switch (viewType) {
    case 'overview':
      return {
        fields: [['status', 'Status'], ['revision', 'Revision'], ['current', 'Current task'], ['checkpoint', 'Checkpoint']],
        rows: [{ id: process.processId, cells: [
          STATUS_LABELS[process.status] ?? process.status,
          process.processRevision,
          task?.taskTemplateId ?? 'No current task',
          process.currentCheckpointSha256 ?? 'No checkpoint'
        ] }],
        edges: [], notes: []
      };
    case 'graph':
      return {
        fields: [['task', 'Task'], ['state', 'State'], ['predecessors', 'Depends on']],
        rows: tasks.map((entry) => ({
          id: entry.taskInstanceId,
          cells: [entry.taskTemplateId, entry.state,
            (entry.predecessorTaskInstanceIds ?? []).join(', ') || 'None']
        })),
        edges: tasks.flatMap((entry) => (entry.predecessorTaskInstanceIds ?? []).map((from) => ({
          id: `${from}->${entry.taskInstanceId}`, from, to: entry.taskInstanceId, label: 'precedes'
        }))),
        notes: ['The tabular task list is the accessible equivalent of this dependency graph.']
      };
    case 'board':
      return {
        fields: [['task', 'Task'], ['lane', 'Lane'], ['revision', 'Revision'], ['evidence', 'Evidence']],
        rows: tasks.map((entry) => ({ id: entry.taskInstanceId, cells: [
          entry.taskTemplateId, entry.state, entry.revision,
          entry.receiptSha256 ?? 'Not available'
        ] })),
        edges: [], notes: ['Board lanes are a read-only projection of exact task states.']
      };
    case 'timeline':
      return {
        fields: [['event', 'Event'], ['time', 'Time'], ['reference', 'Exact reference']],
        rows: [
          { id: 'created', cells: ['Process created', process.createdAt ?? 'Unknown', process.processSha256] },
          { id: 'updated', cells: ['Process updated', process.updatedAt ?? process.createdAt ?? 'Unknown', process.processSha256] },
          { id: 'checkpoint', cells: ['Current checkpoint', process.updatedAt ?? 'Unknown', process.currentCheckpointSha256 ?? 'Not available'] }
        ],
        edges: [], notes: []
      };
    case 'table':
      return {
        fields: [['task', 'Task'], ['instance', 'Instance'], ['state', 'State'], ['revision', 'Revision']],
        rows: tasks.map((entry) => ({ id: entry.taskInstanceId, cells: [
          entry.taskTemplateId, entry.taskInstanceId, entry.state, entry.revision
        ] })),
        edges: [], notes: []
      };
    case 'document':
      return {
        fields: [['section', 'Section'], ['value', 'Value']],
        rows: [
          { id: 'identity', cells: ['Identity', process.processId] },
          { id: 'status', cells: ['Status', STATUS_LABELS[process.status] ?? process.status] },
          { id: 'program', cells: ['Program', process.programSha256] },
          { id: 'policy', cells: ['Pinned policy', process.policySnapshotSha256] },
          { id: 'checkpoint', cells: ['Checkpoint', process.currentCheckpointSha256 ?? 'Not available'] }
        ],
        edges: [], notes: ['This is a generated read-only document, not an editable source artifact.']
      };
    case 'form':
    case 'approval': {
      const applicable = request && requestViewType(request) === viewType;
      return {
        fields: [['choice', 'Choice'], ['consequence', 'Consequence']],
        rows: applicable ? requestChoices.map((option) => ({
          id: option.id, cells: [option.label, option.consequence]
        })) : [],
        edges: [],
        notes: applicable
          ? ['Submitting a choice requires a separate exact, confirmed kernel operation.']
          : [`No open ${viewType} request is projected for this task.`]
      };
    }
    case 'evidence':
      return {
        fields: [['task', 'Task'], ['receipt', 'Exact receipt']],
        rows: tasks.filter((entry) => entry.receiptSha256 != null).map((entry) => ({
          id: entry.taskInstanceId, cells: [entry.taskTemplateId, entry.receiptSha256]
        })),
        edges: [], notes: tasks.some((entry) => entry.receiptSha256 != null)
          ? [] : ['No task receipt has been published.']
      };
    case 'diff':
      return {
        fields: [['field', 'Field'], ['before', 'Before'], ['after', 'After']],
        rows: [], edges: [],
        notes: ['No comparison baseline is present in this projection; no diff is inferred.']
      };
    case 'matrix':
      return {
        fields: [['task', 'Task'], ['state', 'State'], ['receipt', 'Receipt']],
        rows: tasks.map((entry) => ({ id: entry.taskInstanceId, cells: [
          entry.taskTemplateId, entry.state, entry.receiptSha256 ?? 'Missing'
        ] })),
        edges: [], notes: []
      };
    case 'chart':
      return {
        fields: [['state', 'Task state'], ['count', 'Count']],
        rows: Object.entries(counts).map(([state, count]) => ({ id: state, cells: [state, count] })),
        edges: [], notes: ['A text table is the canonical accessible representation of this chart.']
      };
    case 'log':
      return {
        fields: [['sequence', 'Sequence'], ['event', 'Event'], ['reference', 'Reference']],
        rows: [
          { id: 'revision', cells: [process.processRevision, `Process is ${process.status}`, process.processSha256] },
          { id: 'control', cells: [process.processRevision, 'Latest control event', process.controlEventSha256 ?? 'Not available'] },
          { id: 'index', cells: [process.processRevision, 'Latest record index', process.recordIndexSha256 ?? 'Not available'] }
        ],
        edges: [], notes: ['This bounded projection is not a raw terminal or provider log.']
      };
    case 'metrics':
      return {
        fields: [['metric', 'Metric'], ['value', 'Value']],
        rows: [
          { id: 'tasks', cells: ['Tasks', tasks.length] },
          { id: 'evidence', cells: ['Tasks with receipts', tasks.filter((entry) => entry.receiptSha256).length] },
          { id: 'requests', cells: ['Open Human Requests', (process.openHumanRequests ?? []).length] },
          { id: 'executions', cells: ['Active executions', (process.activeExecutions ?? []).length] },
          { id: 'leases', cells: ['Active leases', (process.activeLeases ?? []).length] }
        ],
        edges: [], notes: []
      };
    case 'simulation':
      return {
        fields: [['result', 'Result'], ['authority', 'Authority']], rows: [], edges: [],
        notes: ['No simulation result is attached. This view never executes or predicts the Process.']
      };
    default:
      throw new SingularityFlowError(`Unknown SGOS Work Object view '${viewType}'.`, {
        code: 'SGOS_WORK_OBJECT_VIEW_UNKNOWN'
      });
  }
}

function renderDescriptor(viewType, process, task, request) {
  const data = viewData(viewType, process, task, request);
  const bounded = boundedRows(data.rows);
  const role = viewType === 'form' || viewType === 'approval'
    ? 'form' : viewType === 'document' ? 'document' : viewType === 'log' ? 'log' : 'region';
  return {
    descriptorVersion: 1,
    viewType,
    title: VIEW_LABELS[viewType],
    summary: `${VIEW_LABELS[viewType]} for ${process.processId} at revision ${process.processRevision}.`,
    accessibility: {
      role,
      label: `${VIEW_LABELS[viewType]} for ${process.processId}`,
      keyboard: 'Focus the region, then use native Tab and Shift+Tab navigation for any controls.'
    },
    delivery: {
      mode: HEAVY_VIEW_TYPES.has(viewType) ? 'lazy' : 'inline',
      slice: 'sgos',
      release: 'panel-dispose'
    },
    fields: data.fields.map(([id, label]) => ({ id, label })),
    rows: bounded.rows,
    edges: data.edges,
    notes: [...data.notes, ...(bounded.truncated
      ? [`Only the first ${MAXIMUM_RENDER_ROWS} rows are projected.`] : [])],
    truncated: bounded.truncated
  };
}

function humanSemantics(process, task, request) {
  const evidenceRefs = task?.receiptSha256 ? [task.receiptSha256] : [];
  const choices = (request.options ?? []).map((option) => ({
    id: option.id,
    label: option.label,
    consequence: option.consequence ?? 'No consequence was declared by the Program.'
  }));
  const active = process.activeExecutions?.length ?? 0;
  return {
    needsYou: true,
    requestType: request.requestType,
    why: request.prompt?.detail ?? 'The Program requires an explicit Human Response.',
    exactSubject: {
      processId: process.processId,
      processSha256: process.processSha256,
      taskInstanceId: task?.taskInstanceId ?? request.taskInstanceId,
      requestId: request.requestId,
      requestSha256: request.requestSha256,
      checkpointSha256: request.checkpointSha256 ?? process.currentCheckpointSha256 ?? null,
      subjectSha256: request.subjectSha256 ?? null,
      policySnapshotSha256: request.policySnapshotSha256 ?? process.policySnapshotSha256 ?? null,
      evidenceRefs
    },
    authorityRequired: clone(request.authorityRequired),
    choices,
    whatRemainsRunning: active > 0
      ? `${active} active execution${active === 1 ? '' : 's'} remain governed until a runtime boundary; this response does not cancel them.`
      : 'No execution remains active in this Process; unrelated Processes are unaffected.',
    resumeBehavior: 'After a valid response, the kernel rechecks the exact Process revision, request digest, authority, and Program dependencies before any task becomes runnable.',
    expiresAt: request.expiresAt,
    processStatus: STATUS_LABELS[process.status] ?? process.status,
    sensitiveMode: request.sensitiveMode ?? 'none'
  };
}

function projectedView(process, task, request, viewType) {
  const humanRequest = request && requestViewType(request) === viewType ? request : null;
  const render = renderDescriptor(viewType, process, task, humanRequest);
  if (!humanRequest) {
    return {
      type: viewType,
      schema: {
        type: 'object', title: render.title, description: render.summary, readOnly: true,
        additionalProperties: false, 'x-sgos-render': render
      },
      dataRef: `sfref:sgos-process:${process.processSha256}`,
      actions: []
    };
  }
  return {
    type: viewType,
    schema: {
      type: 'object',
      title: humanRequest.prompt?.title ?? 'Human decision required',
      description: humanRequest.prompt?.detail ?? '',
      properties: {
        decision: {
          type: 'string', enum: ['approved', 'rejected', 'selected', 'provided', 'cancelled']
        },
        input: clone(humanRequest.inputSchema ?? { type: ['object', 'null'] })
      },
      required: ['decision'],
      additionalProperties: false,
      'x-sgos': humanSemantics(process, task, humanRequest),
      'x-sgos-render': render
    },
    dataRef: `sfref:sgos-human-request:${humanRequest.requestSha256}`,
    actions: [{
      id: 'request.respond',
      label: 'Respond',
      operation: 'request.respond',
      inputSchema: {
        type: 'object',
        properties: {
          processId: { const: process.processId },
          processSha256: { const: process.processSha256 },
          requestId: { const: humanRequest.requestId },
          requestSha256: { const: humanRequest.requestSha256 },
          expectedRevision: { const: process.processRevision },
          decision: { type: 'string' },
          input: clone(humanRequest.inputSchema ?? {})
        },
        required: [
          'processId', 'processSha256', 'requestId', 'requestSha256',
          'expectedRevision', 'decision'
        ]
      }
    }]
  };
}

function assertProcess(process) {
  if (process?.kind !== 'gvm-process' || !process.processId || !process.processSha256) {
    throw new SingularityFlowError('A Work Object requires an exact SGOS process snapshot.', {
      code: 'SGOS_WORK_OBJECT_SOURCE_INVALID'
    });
  }
}

/**
 * Return a deeply frozen projection. There is intentionally no corresponding write function:
 * callers send only a stable operation ID back through the runtime, which rechecks revision/hash.
 */
export function projectSgosWorkObject(process, {
  taskInstanceId = null,
  humanRequests = [],
  viewType = null
} = {}) {
  assertProcess(process);
  const task = selectedTask(process, taskInstanceId);
  const request = requestFor(process, task, humanRequests);
  const selectedViewType = viewType ?? (request ? requestViewType(request) : 'overview');
  if (!SGOS_PROJECTED_VIEW_TYPES.includes(selectedViewType)) {
    throw new SingularityFlowError(`Unknown SGOS Work Object view '${selectedViewType}'.`, {
      code: 'SGOS_WORK_OBJECT_VIEW_UNKNOWN'
    });
  }
  const view = projectedView(process, task, request, selectedViewType);
  const identity = {
    processId: process.processId,
    taskInstanceId: task?.taskInstanceId ?? null,
    processSha256: process.processSha256,
    requestSha256: request?.requestSha256 ?? null,
    viewType: selectedViewType
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

/** All canonical view descriptors for one exact Process revision. */
export function projectSgosViewCatalog(process, { humanRequests = [] } = {}) {
  assertProcess(process);
  return Object.freeze(SGOS_PROJECTED_VIEW_TYPES.map((viewType) => projectSgosWorkObject(process, {
    humanRequests, viewType
  })));
}

/** Human-request objects, or one overview object when the Process does not need a response. */
export function projectSgosWorkObjects(process, { humanRequests = [] } = {}) {
  const waiting = Object.values(process?.taskInstances ?? {})
    .filter((task) => task.state === 'waiting-human')
    .sort((left, right) => compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId));
  if (!waiting.length) return Object.freeze([projectSgosWorkObject(process, { humanRequests })]);
  return Object.freeze(waiting.map((task) => projectSgosWorkObject(process, {
    taskInstanceId: task.taskInstanceId, humanRequests
  })));
}
