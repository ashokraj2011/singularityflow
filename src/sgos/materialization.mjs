/** Deterministic Program-to-Process task materialization shared by runtime and durable upgrades. */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sgosSha256 } from './evidence.mjs';
import { compareSgosCodePoints } from './order.mjs';

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function edgeDependencies(program) {
  const dependencies = new Map(program.taskTemplates.map((task) => [
    task.taskTemplateId, new Set(task.dependsOn ?? [])
  ]));
  for (const edge of program.edges ?? []) {
    const from = Array.isArray(edge) ? edge[0] : (edge?.from ?? edge?.source ?? edge?.predecessor);
    const to = Array.isArray(edge) ? edge[1] : (edge?.to ?? edge?.target ?? edge?.successor);
    if (from && to && dependencies.has(to)) dependencies.get(to).add(from);
  }
  return dependencies;
}

function stableId(prefix, value) {
  return `${prefix}-${recordSha256(value).slice(0, 24).toUpperCase()}`;
}

function templateRefs(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => {
    if (typeof value === 'string') return value;
    if (typeof value?.ref === 'string') return value.ref;
    return sgosSha256(value);
  }))].sort(compareSgosCodePoints);
}

export function taskInstancesForSgosProgram(program, processId) {
  const dependencies = edgeDependencies(program);
  const taskIds = new Map(program.taskTemplates.map((task) => [
    task.taskTemplateId,
    stableId('TSK', { processId, taskTemplateId: task.taskTemplateId })
  ]));
  return Object.fromEntries([...program.taskTemplates]
    .sort((left, right) => compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId))
    .map((template) => {
      const taskInstanceId = taskIds.get(template.taskTemplateId);
      const predecessors = [...(dependencies.get(template.taskTemplateId) ?? [])]
        .map((id) => taskIds.get(id))
        .filter(Boolean)
        .sort(compareSgosCodePoints);
      return [taskInstanceId, {
        taskInstanceId,
        taskTemplateId: template.taskTemplateId,
        state: predecessors.length ? 'waiting' : 'ready',
        predecessorTaskInstanceIds: predecessors,
        inputRefs: templateRefs(template.inputs ?? template.inputRefs ?? []),
        outputRefs: [],
        attemptIds: [],
        receiptSha256: null,
        invalidatedBy: null,
        revision: 1
      }];
    }));
}

export function assertSgosProcessMaterialization(program, process) {
  const expected = taskInstancesForSgosProgram(program, process.processId);
  const expectedIds = Object.keys(expected).sort(compareSgosCodePoints);
  const observedIds = Object.keys(process.taskInstances ?? {}).sort(compareSgosCodePoints);
  if (canonicalJson(expectedIds) !== canonicalJson(observedIds)) {
    fail('Process task instances are not the deterministic materialization of the approved Program.',
      'SGOS_PROCESS_MATERIALIZATION_INVALID', {
        expectedTaskIds: expectedIds,
        observedTaskIds: observedIds
      });
  }
  for (const taskInstanceId of expectedIds) {
    const baseline = expected[taskInstanceId];
    const observed = process.taskInstances[taskInstanceId];
    for (const field of [
      'taskInstanceId', 'taskTemplateId', 'predecessorTaskInstanceIds', 'inputRefs'
    ]) {
      if (canonicalJson(observed[field]) !== canonicalJson(baseline[field])) {
        fail(`Process task '${taskInstanceId}' changed compiled field '${field}'.`,
          'SGOS_PROCESS_MATERIALIZATION_INVALID', { taskInstanceId, field });
      }
    }
    if (observed.state === 'skipped') {
      fail(`Process task '${taskInstanceId}' claims an unsupported skipped transition.`,
        'SGOS_PROCESS_MATERIALIZATION_INVALID', { taskInstanceId, state: observed.state });
    }
    if (observed.invalidatedBy !== null) {
      fail(`Process task '${taskInstanceId}' claims unsupported invalidation semantics.`,
        'SGOS_PROCESS_MATERIALIZATION_INVALID', { taskInstanceId });
    }
  }
  return process;
}
