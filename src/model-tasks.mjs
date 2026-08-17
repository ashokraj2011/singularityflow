/**
 * The task taxonomy. `[ADP:REQ-010]` `[ADP:REQ-011]`
 *
 * Work is routed by what it *is*, not by who sells the model that does it. A phase declares that
 * its generation is `reason`; a skill's contract class implies `relay`; configuration alone says
 * which model a task resolves to. The model market changes monthly and this vocabulary should not,
 * which is why the enum is closed and coarse: six kinds of work, extended only by a reviewed schema
 * change rather than a configuration edit `[ADP:CON-005]`.
 *
 * Nothing here consults a model. Task assignment is a lookup from pinned context — a classifier
 * choosing the model would be the routing decision made by the thing being routed `[ADP:CON-001]`.
 */
import { SingularityFlowError } from './util.mjs';

/**
 * The closed v1 enum, in the order a reader should meet it: dispatch, then questions, then the
 * three kinds of production, then prose.
 */
export const MODEL_TASKS = Object.freeze([
  'relay',      // dispatch and faithful narration of a deterministic result
  'clarify',    // formulating the questions a human must answer
  'reason',     // design, planning, trade-off analysis
  'code',       // implementation and test generation
  'analyze',    // assisted convergence and review commentary
  'summarize'   // narrative prose passes
]);

/**
 * Contract class → task.
 *
 * Dispatch classes run a CLI command or a deterministic planner and reproduce its result
 * without adding judgment, which is exactly `relay`. `deterministic-mutation` is included here and
 * the specification's own list omits it — an omission rather than a decision, since its contract
 * ("let the CLI validate and mutate state; preserve its exact result") is the relay contract with a
 * write behind it. Leaving it unmapped would have given every skill of that class no task at all,
 * which is the one outcome the taxonomy exists to prevent.
 *
 * `clarification-and-artifact` is the only class that does two different jobs, so it does not
 * appear here: it resolves through `taskForContractClass` with the intent it is being asked for.
 */
const CONTRACT_CLASS_TASKS = Object.freeze({
  'guided-actions': 'relay',
  'conversational-guidance': 'relay',
  'concise-relay': 'relay',
  'explicit-selection': 'relay',
  'governed-review': 'relay',
  'deterministic-mutation': 'relay'
});

/** The class that asks questions before it drafts, and therefore needs to be told which it is doing. */
export const DUAL_INTENT_CONTRACT_CLASS = 'clarification-and-artifact';

export function assertModelTask(task, label = 'Model task') {
  if (!MODEL_TASKS.includes(task)) {
    throw new SingularityFlowError(
      `${label} '${task}' is not one of ${MODEL_TASKS.join(', ')}. The task enum is closed: adding one is a reviewed schema change, not a configuration edit.`,
      { code: 'MODEL_TASK_UNKNOWN', details: { task, allowed: [...MODEL_TASKS] } }
    );
  }
  return task;
}

/**
 * The task a skill's contract class performs. `[ADP:REQ-011]`
 *
 * `intent` matters only for the dual-intent class: asking the unresolved questions is `clarify`,
 * and drafting the artifact afterwards is whatever the phase declared its generation to be — the
 * skill does not get its own opinion about how hard its phase's drafting is.
 */
export function taskForContractClass(contractClass, { intent = 'questions', generationTask = null } = {}) {
  if (contractClass === DUAL_INTENT_CONTRACT_CLASS) {
    if (intent === 'questions') return 'clarify';
    if (!generationTask) {
      throw new SingularityFlowError(
        `Drafting under '${DUAL_INTENT_CONTRACT_CLASS}' needs the phase's declared generation task; none was supplied.`,
        { code: 'MODEL_TASK_UNRESOLVED', details: { contractClass, intent } }
      );
    }
    return assertModelTask(generationTask, 'Phase generation task');
  }
  const task = CONTRACT_CLASS_TASKS[contractClass];
  if (!task) {
    throw new SingularityFlowError(
      `Contract class '${contractClass}' declares no model task. Every class must name one, or work of that class routes nowhere.`,
      { code: 'MODEL_TASK_UNMAPPED', details: { contractClass, mapped: Object.keys(CONTRACT_CLASS_TASKS) } }
    );
  }
  return task;
}

/** Every contract class this module can route, for the check that keeps it level with the registry. */
export function mappedContractClasses() {
  return Object.freeze([...Object.keys(CONTRACT_CLASS_TASKS), DUAL_INTENT_CONTRACT_CLASS].sort());
}

/**
 * The task a phase's generation performs. `[ADP:REQ-012]`
 *
 * Declared per phase and folded through the standard policy layers before it is pinned, so what a
 * story routes by is the approved answer rather than whatever the configuration says today. A phase
 * that declares nothing routes as `reason`: generation is drafting, and drafting is the task that
 * degrades most visibly when it is under-served.
 */
export function generationTaskForPhase(definition, phaseId) {
  const declared = definition?.phases?.[phaseId]?.generation?.task;
  return declared ? assertModelTask(declared, `Phase '${phaseId}' generation task`) : 'reason';
}
