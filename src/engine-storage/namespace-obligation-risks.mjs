/** One registered mutation path; application callers cannot supply evidence observations or allow flags. */
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {createNamespaceObligationRiskOwner} from './namespace-obligation-risk-reader.mjs';
export function createNamespaceObligationRiskPort(options){
  const observer=createNamespaceStoryObserver(options),owned=createNamespaceObligationRiskOwner({...options,observer});
  const base=createNamespaceRecordedMutationPort(options,{operation:'decision.risk',requestUsesWorkflow:true,explicitIdentity:true,
    request:(input,workflow)=>({...standaloneDecisionRequest('decision.risk',input),phaseId:workflow.currentPhase}),owner:owned.owner,contract:namespaceDecisionContract,
    finish:(value,revision,{replayed})=>({profile:'sflow-namespace-obligation-risk-outcome/v1',workId:options.workId,phase:value.phase,recordKind:'obligation-risk',record:value.outcome.record,revision:replayed?null:revision,pushed:false,retained:replayed,
      actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  return {...base,async prepare(...args){const {phaseId,...intent}=await base.prepare(...args);return intent;},
    commit(context,intent,options){return base.commit(context,{...intent,phaseId:context.workflow.currentPhase},options);}};
}
