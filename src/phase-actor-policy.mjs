/** Public compatibility imports; role policy and host presentation have separate owners. */
export { readOnlyAgent } from './kernel/phase-admission.mjs';
export { phaseAgentMutationRestriction, assertPhaseAgentMayMutate } from './phase-transition-routes.mjs';
