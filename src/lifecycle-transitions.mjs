/** Compatibility exports; native presentation and pure aggregate mutations have separate owners. */
export { cancelledStoryRefusal } from './phase-transition-routes.mjs';
export {
  nextPhaseAfterSkillAmendment, advanceCompletedPhase, skipPhaseRange, resetPhaseForRework, resetPhaseRangeForRework, reopenPhaseRange, resetDecisionRounds, clearDecisionState, clearApprovalDisposition, automaticApprovalDisposition, completionPhaseOf
} from './kernel/lifecycle-transitions.mjs';
