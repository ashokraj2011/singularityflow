/** Conditional human amendments; SDK and readers share their exact planning/source owner. */
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespacePlanDecisionOwners} from './namespace-plan-decisions-reader.mjs';
export function createNamespacePlanDecisionPort(options){
  const {scope,workId,sources}=options,observer=createNamespaceStoryObserver(options),owned=createNamespacePlanDecisionOwners({observer,scope,workId,sources}),
    request=(input,workflow)=>({...standaloneDecisionRequest('decision.plan',input),phaseId:workflow.currentPhase}),
    base=createNamespaceRecordedMutationPort(options,{operation:'decision.plan',request,owner:owned.owner,contract:namespaceDecisionContract,
      explicitIdentity:true,requestUsesWorkflow:true,finish:(value,revision)=>({workId,phase:value.phase,recordKind:'plan-amendment',record:value.outcome.record,
        revision,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  return {...base,async prepare(...args){const {phaseId,...value}=await base.prepare(...args);return value;},
    commit(context,intent,options){return base.commit(context,{...intent,phaseId:context.workflow.currentPhase},options);}};
}
