export { normalizeReworkLoops, normalizeRepairBudget } from './kernel/configuration-policy.mjs';
import { SingularityFlowError } from './foundation/failures.mjs';
import {consumeRepairAttemptValue} from './kernel/test-recovery.mjs';
export {repairBudgetPhaseForRejection} from './kernel/test-recovery.mjs';

/** Native v1 error and safe command guidance remain outside the shared value rules. */
export function consumeRepairAttempt(workflow,phase,request){
  try{const {targetPhase,actor,at,changeRequestId,sourcePhase=null}=request;
    return consumeRepairAttemptValue(workflow,phase,{targetPhase,actor,at,changeRequestId,sourcePhase});}catch(error){
    if(error.code!=='REPAIR_BUDGET_EXHAUSTED')throw error;
    const {resetTarget,sourceSubmitted,...details}=error.details,policy=phase.repairBudget,sourcePhase=request.sourcePhase,
      route=resetTarget?`singularity-flow reject ${sourcePhase.id} --work-id ${workflow.workItem?.id} --to ${resetTarget} --reason <reason>`:null,
      resetCommand=sourceSubmitted?route:null;
    throw new SingularityFlowError(
      `Phase '${phase.id}' repair budget is exhausted (${details.consumed}/${policy.maxAttempts}). `
      +(resetCommand?`Return the submission to '${policy.resetOnPhase}' instead, which resets the budget once it has a new approved generation: ${resetCommand}. Otherwise ask the approvers for direction.`
      :route?`Once '${sourcePhase.id}' is submitted, its approvers may return it to '${policy.resetOnPhase}', which resets the budget once it has a new approved generation; a return is refused before then. Otherwise ask the approvers for direction.`
      :'No allowed return resets it from here; ask the approvers for direction (approve the submission as it stands, or have a workflow maintainer change the budget for new Stories).'),
      {code:'REPAIR_BUDGET_EXHAUSTED',details:{...details,resetCommand}});
  }
}
