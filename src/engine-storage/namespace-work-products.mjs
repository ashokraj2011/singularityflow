/** Explicit registered work-product operations; no repository, model or runtime discovery. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {workProductMutationRequest,workProductContinuations} from '../kernel/work-products.mjs';
import {phaseAccessIdentity,phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceWorkProductContract} from './namespace-work-product-contract.mjs';
import {createNamespaceWorkProductOwners} from './namespace-work-products-reader.mjs';
import {createNamespaceDataExecutionPort} from './namespace-data-execution.mjs';
const fail=(message,code='ENGINE_INPUT_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function createNamespaceWorkProductPorts(options){
  const {scope,workId}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceWorkProductOwners({observer,scope,workId}),contexts=new WeakMap();
  const finish=(value,revision,{replayed=false}={})=>({workId,phase:value.phase,generation:value.generation,revision,pushed:false,retained:replayed,record:value.outcome.record});
  function mutation(operation){return createNamespaceRecordedMutationPort(options,{operation,request:input=>workProductMutationRequest(operation,input),
    owner:owned.owners.get(operation),contract:namespaceWorkProductContract,requiresHuman:operation==='work-product.amend',explicitIdentity:true,finish});}
  const retain=mutation('work-product.retain'),dataMutation=mutation('data.execute');
  const context={
    async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      const captured=await observer.capture({signal}),phaseId=input.phaseId??captured.snapshot.workflow.currentPhase,
        facts=await options.access.current({projectId:scope.projectId,workId,operation:'work-product.context',signal});
      phaseAccessIdentity(facts,scope.projectId);phaseTransitionAccess(facts,scope.projectId,'work-product.context');
      const phase=captured.snapshot.workflow.phases[phaseId];if(!phase)fail('Select an actual work-product phase.','ENGINE_PHASE_UNAVAILABLE');
      const issued={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow,phase};contexts.set(issued,captured.snapshot);return issued;
    },
    async read(context,{signal}={}){
      const snapshot=contexts.get(context);if(!snapshot)fail('Use the issued work-product context.');
      const selected=await owned.context(snapshot,context.phase.id,{signal}),latest=selected.state.executions.filter(row=>row.phase===context.phase.id&&row.generation===selected.binding.generation).at(-1);
      return {workId,phase:context.phase.id,generation:selected.binding.generation,expected:selected.contextSha256,
        inputs:selected.phase.inputs,outputs:selected.phase.outputs,missing:selected.missing,assets:selected.assets.map(row=>row.asset),
        criteria:selected.phase.criteria,latestExecution:latest??null,actions:workProductContinuations(snapshot.workflow,selected).map(action=>({...action,surface:'sdk'}))};
    }
  };
  return {workProduct:retain,workProductAmend:mutation('work-product.amend'),workProductContext:context,...(options.data?{dataExecution:createNamespaceDataExecutionPort(options,{observer,owned,mutation:dataMutation,finish})}:{})};
}
