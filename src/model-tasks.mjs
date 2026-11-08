export { MODEL_TASKS, DUAL_INTENT_CONTRACT_CLASS, assertModelTask, taskForContractClass, mappedContractClasses, generationTaskForPhase } from './kernel/configuration-policy.mjs';
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
