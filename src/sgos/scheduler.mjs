import { SingularityFlowError } from '../util.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';
import {
  canonicalSgosResourceEntries, sgosResourceEntriesConflict
} from './resource-contracts.mjs';
import {
  isSgosTerminalTaskState, sgosJoinForTask, sgosJoinReadiness
} from './joins.mjs';

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
    const allPredecessorsSucceeded = predecessors.every((entry) => entry.state === 'succeeded');
    if (template.opcode === 'END') {
      const allOtherTasksTerminal = Object.values(process.taskInstances)
        .filter((entry) => entry.taskInstanceId !== task.taskInstanceId)
        .every((entry) => isSgosTerminalTaskState(entry.state));
      return Object.freeze({
        ready: allPredecessorsSucceeded && allOtherTasksTerminal,
        impossible: false
      });
    }
    return Object.freeze({
      ready: allPredecessorsSucceeded,
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

function taskFanoutMemberships(template) {
  const metadata = template?.metadata ?? {};
  if (metadata.fanoutLineage != null && !Array.isArray(metadata.fanoutLineage)) {
    fail(`Task '${template?.taskTemplateId}' has malformed fan-out lineage.`,
      'SGOS_FANOUT_INVALID');
  }
  const memberships = [
    ...(metadata.fanoutLineage ?? []),
    ...(metadata.fanout ? [metadata.fanout] : [])
  ].map((entry) => ({
    parentTaskId: entry?.parentTaskId,
    itemKey: entry?.itemKey,
    maximumParallel: entry?.maximumParallel
  }));
  for (const membership of memberships) {
    if (typeof membership.parentTaskId !== 'string' || !membership.parentTaskId
        || typeof membership.itemKey !== 'string' || !membership.itemKey
        || !Number.isSafeInteger(membership.maximumParallel)
        || membership.maximumParallel < 1
        || membership.maximumParallel > SGOS_INSTALLED_LIMITS.maximumFanoutParallel) {
      fail(`Task '${template?.taskTemplateId}' has malformed fan-out membership.`,
        'SGOS_FANOUT_INVALID');
    }
  }
  if (new Set(memberships.map((entry) => entry.parentTaskId)).size !== memberships.length) {
    fail(`Task '${template?.taskTemplateId}' repeats a fan-out group in its lineage.`,
      'SGOS_FANOUT_INVALID');
  }
  return memberships;
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
  const membershipByTemplate = new Map();
  const fanoutLimits = new Map();
  for (const template of templates.values()) {
    const memberships = taskFanoutMemberships(template);
    membershipByTemplate.set(template.taskTemplateId, memberships);
    for (const membership of memberships) {
      const prior = fanoutLimits.get(membership.parentTaskId);
      if (prior != null && prior !== membership.maximumParallel) {
        fail(`Fan-out '${membership.parentTaskId}' has inconsistent parallel ceilings.`,
          'SGOS_FANOUT_INVALID');
      }
      fanoutLimits.set(membership.parentTaskId, membership.maximumParallel);
    }
  }
  const activeIds = activeTaskIds(process);
  const active = [...activeIds].map((taskInstanceId) => {
    const task = process.taskInstances[taskInstanceId];
    const template = templates.get(task.taskTemplateId);
    return {
      taskInstanceId,
      entries: canonicalSgosResourceEntries(template.resources),
      memberships: membershipByTemplate.get(task.taskTemplateId) ?? []
    };
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
        memberships: membershipByTemplate.get(task.taskTemplateId) ?? []
      };
    })
    .sort(taskOrder);

  const selected = [];
  const activeFanoutItems = new Map();
  for (const entry of active) {
    for (const membership of entry.memberships) {
      const items = activeFanoutItems.get(membership.parentTaskId) ?? new Set();
      items.add(membership.itemKey);
      activeFanoutItems.set(membership.parentTaskId, items);
    }
  }
  const selectedFanoutItems = new Map();
  for (const candidate of ready) {
    if (selected.length >= available) break;
    if (active.some((entry) => sgosResourceEntriesConflict(candidate.entries, entry.entries))
        || selected.some((entry) => sgosResourceEntriesConflict(candidate.entries, entry.entries))) {
      continue;
    }
    const fanoutBlocked = candidate.memberships.some((membership) => {
      const activeItems = activeFanoutItems.get(membership.parentTaskId) ?? new Set();
      const selectedItems = selectedFanoutItems.get(membership.parentTaskId) ?? new Set();
      if (activeItems.has(membership.itemKey) || selectedItems.has(membership.itemKey)) return false;
      return new Set([...activeItems, ...selectedItems]).size >= membership.maximumParallel;
    });
    if (fanoutBlocked) continue;
    for (const membership of candidate.memberships) {
      const items = selectedFanoutItems.get(membership.parentTaskId) ?? new Set();
      items.add(membership.itemKey);
      selectedFanoutItems.set(membership.parentTaskId, items);
    }
    selected.push(candidate);
  }
  return Object.freeze(selected.map(({ entries, memberships, ...entry }) => Object.freeze(entry)));
}
