/** Human recovery confirmation uses the existing conditional mutation coordinator. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceTestRecoveryOwner} from './namespace-test-recovery-reader.mjs';
export function createNamespaceTestRecoveryPorts(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceTestRecoveryOwner({observer,scope,workId}),
    operation='test-recovery.context',contexts=new WeakMap(),fail=(message,code)=>{throw new SingularityFlowError(message,{code});};
  const context={async load(input,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
    const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation),
      captured=await observer.capture({signal}),phaseId=input.phaseId??captured.snapshot.workflow.currentPhase,
      value={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow,phase:captured.snapshot.workflow.phases[phaseId]};
    if(!value.phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');
    contexts.set(value,{captured,phaseId,principal,reuse:input.reuse??null});return value;
  },async read(context,{signal}={}){
    const state=contexts.get(context);if(!state)fail('Use the issued recovery context.','ENGINE_INPUT_INVALID');
    const value=await owned.context(state.captured.snapshot,{signal,...(state.reuse?{reuse:state.reuse}:{})});
    phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation,{expected:state.principal});
    const fresh=await observer.capture({signal});
    if(fresh.snapshot.revision!==state.captured.snapshot.revision||fresh.basis.authorityVersion!==state.captured.basis.authorityVersion)fail(
      'Recovery authority or the Story changed during reading.','ENGINE_CONTEXT_CHANGED');
    const version=value.context.value.reuse==='never'?1:2;
    return {schemaVersion:version,profile:'sflow-namespace-test-recovery-review/v'+version,workId,phase:state.phaseId,revision:state.captured.snapshot.revision,
      expectedContext:value.context.sha256,agreement:value.context.value,previous:value.previous,
      authorities:testRunRiskAuthorities(context.workflow,state.phaseId),
      actions:[{operation:'test-recovery.confirm',inputs:{workId,phaseId:state.phaseId,expectedContext:value.context.sha256,...(state.reuse?{reuse:state.reuse}:{})},requiredInputs:['operationId','reason']}]};
  }};
  const decision=createNamespaceRecordedMutationPort(options,{operation:'test-recovery.confirm',explicitIdentity:true,
    request:input=>standaloneDecisionRequest('test-recovery.confirm',input),owner:owned.owner,contract:namespaceDecisionContract,
    finish:(value,revision)=>({workId,phase:value.phase,recordKind:'test-recovery-agreement',record:value.outcome.record,revision,pushed:false,
      actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  return Object.freeze({context,decision,owned});
}
