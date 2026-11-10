/** One explicit namespace review path, separate from authoring and human phase approval. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceSourceReviewOwners} from './namespace-source-review-reader.mjs';
export function createNamespaceSourceReviewPorts(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceSourceReviewOwners({observer,scope,workId}),contexts=new WeakMap();
  function decision(operation,owner){return createNamespaceRecordedMutationPort(options,{operation,owner,request:input=>standaloneDecisionRequest(operation,input),
    contract:namespaceDecisionContract,requiresHuman:operation==='source-review.decide',explicitIdentity:true,
    finish:(value,revision)=>({workId,phase:value.phase,recordKind:operation==='source-review.record'?'source-review':'source-review-disposition',record:value.outcome.record,
      revision,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});}
  const sourceReviewContext={async load(input,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)throw new SingularityFlowError('Use the bound Story.',{code:'ACTIVE_SUBJECT_MISMATCH'});
    const operation='source-review.context',principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation),
      snapshot=(await observer.inspect({signal})).snapshot,phaseId=input.phaseId??snapshot.workflow.currentPhase,
      context={subject:{kind:'story',id:workId},workflow:snapshot.workflow,phase:snapshot.workflow.phases[phaseId]};
    contexts.set(context,{snapshot,phaseId,principal});return context;
  },async read(context,{signal}={}){const s=contexts.get(context);if(!s)throw new SingularityFlowError('Use the issued review context.',{code:'ENGINE_INPUT_INVALID'});
    const value=await owned.inspect(s.snapshot,s.phaseId,{signal});
    phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:'source-review.context',signal}),scope.projectId,'source-review.context',{expected:s.principal});
    if((await observer.inspect({signal})).snapshot.revision!==s.snapshot.revision)throw new SingularityFlowError('The source-review context changed while reading.',{code:'ENGINE_CONTEXT_CHANGED'});
    return value;
  }};
  return Object.freeze({sourceReviewContext,record:decision('source-review.record',owned.recordOwner),decide:decision('source-review.decide',owned.decisionOwner)});
}
