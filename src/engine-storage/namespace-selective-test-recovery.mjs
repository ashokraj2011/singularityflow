/** Registry coordination for reviewed selection. One shared conditional mutation writer. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceSelectiveTestRecoveryOwner} from './namespace-selective-test-recovery-reader.mjs';
const operation='test-recovery.select-confirm',fail=(message,code,details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function createNamespaceSelectiveTestRecoveryPorts(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceSelectiveTestRecoveryOwner({...options,observer}),
    readOperation='test-recovery.select-context',contexts=new WeakMap(),request=(input,workflow)=>{
      const raw=standaloneDecisionRequest(operation,input),phaseId=raw.revoke?workflow.namespaceSelectiveTestRecoveries?.find(row=>row.id===raw.revoke)?.phase:raw.phaseId;
      if(!phaseId)fail('Select an exact reviewed phase or an original decision to revoke.','SELECTIVE_TEST_RECOVERY_INVALID');return {...raw,phaseId};};
  const decision=createNamespaceRecordedMutationPort(options,{operation,explicitIdentity:true,request,requestUsesWorkflow:true,owner:owned.owner,contract:namespaceDecisionContract,
    finish:(value,revision,{replayed})=>({workId,phase:value.phase,recordKind:'selective-test-recovery',record:value.outcome.record,revision:replayed?null:revision,
      retained:replayed,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  const context={async load(input,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
    const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:readOperation,signal}),scope.projectId,readOperation),captured=await observer.capture({signal}),
      value={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow,phase:captured.snapshot.workflow.phases[input.phaseId]};
    if(!value.phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');contexts.set(value,{input,captured,principal});return value;
  },async read(context,{signal}={}){
    const state=contexts.get(context);if(!state)fail('Use the issued selection context.','ENGINE_INPUT_INVALID');
    const source=await owned.context(state.captured.snapshot,state.input,{signal});
    phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:readOperation,signal}),scope.projectId,readOperation,{expected:state.principal});
    const fresh=await observer.capture({signal});if(fresh.snapshot.revision!==state.captured.snapshot.revision||fresh.basis.authorityVersion!==state.captured.basis.authorityVersion)fail('Selection authority or Story changed.','ENGINE_CONTEXT_CHANGED');
    return {...source.context.value,expectedContext:source.context.sha256,revision:state.captured.snapshot.revision,authorities:testRunRiskAuthorities(context.workflow,context.phase.id),
      actions:[{operation,inputs:{workId,phaseId:context.phase.id,baselineOperationId:state.input.baselineOperationId,selection:state.input.selection,expectedContext:source.context.sha256},
        requiredInputs:['operationId','reason','expires','followUpOwner','remediationRef'],prerequisites:['authenticated-test-risk-authority']}]};
  }};
  return Object.freeze({context,decision,owned});
}
