/** Conditional scope writes and read contexts; original record observations have a separate owner. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {scopeAuthorities} from '../kernel/scope-decisions.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceScopeDecisionOwners,NAMESPACE_SCOPE_DECISION_OPERATIONS} from './namespace-scope-reader.mjs';
export {createNamespaceScopeDecisionOwners,NAMESPACE_SCOPE_DECISION_OPERATIONS} from './namespace-scope-reader.mjs';
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceScopeDecisionPorts(options,runtime=null) {
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceScopeDecisionOwners({observer,scope,workId,runtime}),ports=new Map();
  for(const [operation,owner]of owned.owners){
    const request=(input,workflow)=>{const value=standaloneDecisionRequest(operation,input);return {...value,reason:value.reason.trim(),phaseId:workflow.currentPhase};};
    const base=createNamespaceRecordedMutationPort(options,{operation,request,owner,contract:namespaceDecisionContract,
      explicitIdentity:true,requestUsesWorkflow:true,finish:(value,revision)=>({workId,phase:value.phase,recordKind:operation==='decision.scope'?'scope-disposition':operation==='decision.applicability'?'applicability':'completeness-review',
        record:value.outcome.record,revision,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
    ports.set(operation,{...base,async prepare(...args){const {phaseId,...intent}=await base.prepare(...args);return intent;},
      commit(context,intent,options){return base.commit(context,{...intent,phaseId:context.workflow.currentPhase},options);}});
  }
  const contexts=new WeakMap(),scopeContext={
    async load(input,{signal}={}){if(input.workId!=null&&input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:'scope.context',signal}),scope.projectId,'scope.context');
      const snapshot=(await observer.inspect({signal})).snapshot,context={subject:{kind:'story',id:workId},workflow:snapshot.workflow};contexts.set(context,snapshot);return context;},
    async read(context,{signal}={}){const snapshot=contexts.get(context);if(!snapshot)throw error('Use the issued scope context.','ENGINE_INPUT_INVALID');
      const source=await owned.inventory(snapshot,'decision.completeness',{signal}),workflow=snapshot.workflow;
      await source.fresh();
      if((await observer.inspect({signal})).snapshot.revision!==snapshot.revision)throw error('Scope changed during inspection.','ENGINE_CONTEXT_CHANGED');
      return {workId,revision:snapshot.revision,inventory:source.inventory,knownClauseIds:source.knownClauseIds,authorities:scopeAuthorities(workflow),
        completenessReview:(workflow.completenessReviews??[]).findLast(row=>!row.withdrawnAt&&row.inventorySha256===source.inventory.inventorySha256)??null};}
  };
  return {ports,scopeContext};
}
