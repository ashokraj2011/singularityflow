/** Deterministic Program-to-Process task materialization shared by runtime and durable upgrades. */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sgosSha256 } from './evidence.mjs';
import { compareSgosCodePoints } from './order.mjs';
import { sgosDynamicFanoutChildInstanceId } from './fanout.mjs';

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
  const materializable = program.taskTemplates.filter((task) =>
    task.metadata?.dynamicFanoutBody == null);
  const taskIds = new Map(materializable.map((task) => [
    task.taskTemplateId,
    stableId('TSK', { processId, taskTemplateId: task.taskTemplateId })
  ]));
  const templates = new Map(program.taskTemplates.map((task) => [task.taskTemplateId, task]));
  return Object.fromEntries([...materializable]
    .sort((left, right) => compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId))
    .map((template) => {
      const taskInstanceId = taskIds.get(template.taskTemplateId);
      const dependencyTemplates = template.metadata?.dynamicFanoutCoordinator == null
        ? [...(dependencies.get(template.taskTemplateId) ?? [])]
        : [...(templates.get(
            template.metadata.dynamicFanoutCoordinator.bodyTaskTemplateId
          )?.dependsOn ?? [])];
      const predecessors = dependencyTemplates
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
  if (expectedIds.some((id) => !observedIds.includes(id))) {
    fail('Process task instances are not the deterministic materialization of the approved Program.',
      'SGOS_PROCESS_MATERIALIZATION_INVALID', {
        expectedTaskIds: expectedIds,
        observedTaskIds: observedIds
      });
  }
  const templates = new Map(program.taskTemplates.map((task) => [
    task.taskTemplateId, task
  ]));
  for (const taskInstanceId of expectedIds) {
    const baseline = expected[taskInstanceId];
    const observed = process.taskInstances[taskInstanceId];
    const template = templates.get(baseline.taskTemplateId);
    for (const field of ['taskInstanceId', 'taskTemplateId', 'inputRefs']) {
      if (canonicalJson(observed[field]) !== canonicalJson(baseline[field])) {
        fail(`Process task '${taskInstanceId}' changed compiled field '${field}'.`,
          'SGOS_PROCESS_MATERIALIZATION_INVALID', { taskInstanceId, field });
      }
    }
    if (template?.metadata?.dynamicFanoutCoordinator == null
        && canonicalJson(observed.predecessorTaskInstanceIds)
          !== canonicalJson(baseline.predecessorTaskInstanceIds)) {
      fail(`Process task '${taskInstanceId}' changed compiled field 'predecessorTaskInstanceIds'.`,
        'SGOS_PROCESS_MATERIALIZATION_INVALID', {
          taskInstanceId, field: 'predecessorTaskInstanceIds'
        });
    }
    if (observed.state === 'skipped') {
      fail(`Process task '${taskInstanceId}' claims an unsupported skipped transition.`,
        'SGOS_PROCESS_MATERIALIZATION_INVALID', { taskInstanceId, state: observed.state });
    }
    // Replay invalidation is mutable lineage, not compiled Program material. The durable store
    // accepts it only when an exact indexed replay plan authorizes the transition and validates
    // that plan again on every Process read.
  }
  for (const taskInstanceId of observedIds.filter((id) => !expectedIds.includes(id))) {
    const observed = process.taskInstances[taskInstanceId];
    const binding = observed?.fanoutBinding;
    const body = templates.get(observed?.taskTemplateId);
    const descriptor = body?.metadata?.dynamicFanoutBody;
    if (!binding || !descriptor
        || binding.parentTaskTemplateId !== descriptor.parentTaskId
        || binding.maximumParallel !== descriptor.maximumParallel
        || sgosDynamicFanoutChildInstanceId(
          process.processId, descriptor.parentTaskId,
          binding.itemKey, binding.itemSha256
        ) !== taskInstanceId) {
      fail(`Process task '${taskInstanceId}' is not an authorized dynamic fan-out instance.`,
        'SGOS_PROCESS_MATERIALIZATION_INVALID', { taskInstanceId });
    }
    const staticTasks = taskInstancesForSgosProgram(program, process.processId);
    const expectedPredecessors = [...(body.dependsOn ?? [])]
      .map((templateId) => Object.values(staticTasks)
        .find((task) => task.taskTemplateId === templateId)?.taskInstanceId)
      .filter(Boolean).sort(compareSgosCodePoints);
    const expectedInputs = [...new Set([
      ...templateRefs(body.inputs ?? body.inputRefs ?? []),
      binding.collectionRecordSha256,
      binding.itemSha256
    ])].sort(compareSgosCodePoints);
    if (canonicalJson(observed.predecessorTaskInstanceIds)
          !== canonicalJson(expectedPredecessors)
        || canonicalJson(observed.inputRefs) !== canonicalJson(expectedInputs)) {
      fail(`Process task '${taskInstanceId}' changed its dynamic fan-out binding.`,
        'SGOS_PROCESS_MATERIALIZATION_INVALID', { taskInstanceId });
    }
  }
  for (const baseline of Object.values(expected)) {
    const template = templates.get(baseline.taskTemplateId);
    const descriptor = template?.metadata?.dynamicFanoutCoordinator;
    if (!descriptor) continue;
    const coordinator = process.taskInstances[baseline.taskInstanceId];
    const children = Object.values(process.taskInstances)
      .filter((task) => task.fanoutBinding?.parentTaskTemplateId === descriptor.parentTaskId)
      .map((task) => task.taskInstanceId).sort(compareSgosCodePoints);
    const allowed = children.length ? children : baseline.predecessorTaskInstanceIds;
    if (canonicalJson(coordinator.predecessorTaskInstanceIds) !== canonicalJson(allowed)) {
      fail(`Dynamic fan-out coordinator '${descriptor.parentTaskId}' has foreign predecessors.`,
        'SGOS_PROCESS_MATERIALIZATION_INVALID');
    }
  }
  return process;
}
