/** Package entry stays pure. Choosing a host, store or project is explicit construction. */
export { createEngine, ENGINE_CONTRACT, ENGINE_OPERATIONS, ENGINE_HELPERS } from '../../../src/engine-sdk/index.mjs';
export { SingularityFlowError, outcomeClassOf, OUTCOME_CLASSES,
  OUTCOME_CLASS_BY_CODE, OUTCOME_CLASS_BY_STATUS } from '../../../src/foundation/failures.mjs';
