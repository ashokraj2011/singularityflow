import { SingularityFlowError } from '../util.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';
import {
  canonicalSgosResourceEntries, sgosResourceEntriesConflict
} from './resource-contracts.mjs';
import { sgosJoinForTask, sgosJoinReadiness } from './joins.mjs';

function fail(message, code = 'SGOS_SCHEDULER_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function templateMap(program) {
  return new Map((program?.taskTemplates ?? []).map((template) => [
    template.taskTemplateId, template
  ]));
}

function activeTaskIds(process) {
  const active = new Set(process?.activeExecutions ?? []);
  return new Set(Object.values(process?.taskInstances ?? {})
    .filter((task) => task.attemptIds.some((attemptId) => active.has(attemptId)))
    .map((task) => task.taskInstanceId));
}

function predecessorTasks(process, task) {
  return task.predecessorTaskInstanceIds.map((id) => process.taskInstances[id]).filter(Boolean);
}

export function sgosTaskReadiness(program, process, task) {
  const template = templateMap(program).get(task.taskTemplateId);
  if (!template) fail(`Task '${task.taskInstanceId}' has no Program template.`);
  const predecessors = predecessorTasks(process, task);
  if (predecessors.length !== task.predecessorTaskInstanceIds.length) {
    fail(`Task '${task.taskInstanceId}' has a missing predecessor.`);
  }
  if (template.opcode !== 'JOIN') {
    return Object.freeze({
      ready: predecessors.every((entry) => entry.state === 'succeeded'),
      impossible: false
    });
  }
  const join = sgosJoinForTask(program, template.taskTemplateId);
  if (!join) fail(`JOIN task '${template.taskTemplateId}' has no installed join contract.`,
    'SGOS_JOIN_CONTRACT_MISSING');
  return sgosJoinReadiness(join, predecessors.map((entry) => entry.state));
}

function taskOrder(left, right) {
  return compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId)
    || compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId);
}

/** Pure, deterministic selection. Completion timing and object insertion order are never inputs. */
export function deterministicSgosDispatchPlan(program, process, {
  maximumParallel = 1
} = {}) {
  if (!Number.isSafeInteger(maximumParallel) || maximumParallel < 1
      || maximumParallel > SGOS_INSTALLED_LIMITS.maximumParallelExecutions) {
    fail('maximumParallel is outside the installed execution bound.',
      'SGOS_PARALLEL_LIMIT', {
        maximumParallel,
        installed: SGOS_INSTALLED_LIMITS.maximumParallelExecutions
      });
  }
  if (['paused', 'blocked', 'failed', 'cancelled', 'succeeded', 'recovery-required']
    .includes(process?.status)) return Object.freeze([]);
  const templates = templateMap(program);
  const activeIds = activeTaskIds(process);
  const active = [...activeIds].map((taskInstanceId) => {
    const task = process.taskInstances[taskInstanceId];
    const template = templates.get(task.taskTemplateId);
    return { taskInstanceId, entries: canonicalSgosResourceEntries(template.resources) };
  });
  const available = Math.max(0, maximumParallel - active.length);
  if (!available) return Object.freeze([]);

  const ready = Object.values(process?.taskInstances ?? {})
    .filter((task) => ['planned', 'waiting', 'ready'].includes(task.state))
    .map((task) => ({ task, readiness: sgosTaskReadiness(program, process, task) }))
    .filter(({ readiness }) => readiness.ready)
    .map(({ task }) => {
      const template = templates.get(task.taskTemplateId);
      return {
        taskInstanceId: task.taskInstanceId,
        taskTemplateId: task.taskTemplateId,
        opcode: template.opcode,
        entries: canonicalSgosResourceEntries(template.resources),
        fanout: template.metadata?.fanout ?? null
      };
    })
    .sort(taskOrder);

  const selected = [];
  const fanoutCounts = new Map();
  for (const candidate of ready) {
    if (selected.length >= available) break;
    if (active.some((entry) => sgosResourceEntriesConflict(candidate.entries, entry.entries))
        || selected.some((entry) => sgosResourceEntriesConflict(candidate.entries, entry.entries))) {
      continue;
    }
    const parent = candidate.fanout?.parentTaskId ?? null;
    if (parent != null) {
      const activeSame = active.filter((entry) => {
        const task = process.taskInstances[entry.taskInstanceId];
        return templates.get(task.taskTemplateId)?.metadata?.fanout?.parentTaskId === parent;
      }).length;
      const selectedSame = fanoutCounts.get(parent) ?? 0;
      if (activeSame + selectedSame >= candidate.fanout.maximumParallel) continue;
      fanoutCounts.set(parent, selectedSame + 1);
    }
    selected.push(candidate);
  }
  return Object.freeze(selected.map(({ entries, fanout, ...entry }) => Object.freeze(entry)));
}
