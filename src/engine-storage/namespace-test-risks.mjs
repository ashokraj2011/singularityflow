/** Registered human risk coordination. Only retained decisions mutate shared state; context is read-only. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {createNamespaceTestRiskOwner} from './namespace-test-risk-reader.mjs';
const fail=(message,code)=>{throw new SingularityFlowError(message,{code});};
export function createNamespaceTestRiskPorts(options){
  const {scope,workId,access,clock}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceTestRiskOwner({...options,observer}),
    operation='decision.test-risk',states=new WeakMap(),contexts=new WeakMap(),request=(input,workflow)=>{
      const raw=standaloneDecisionRequest(operation,input),phaseId=raw.revoke?workflow.namespaceTestRunRisks?.find(row=>row.id===raw.revoke)?.phase:raw.phaseId;
      if(!phaseId||raw.revoke&&(raw.phaseId||raw.commandId||raw.argvSha256||raw.causeClass||raw.cause||raw.expires)||!raw.revoke&&!raw.phaseId)fail(
        'Select an exact phase command and environment cause, or an original risk to revoke.','TEST_RUN_RISK_INVALID');return {...raw,phaseId};},
    port=createNamespaceRecordedMutationPort(options,{operation,request,requestUsesWorkflow:true,owner:owned.owner,contract:namespaceDecisionContract,
      finish:(value,revision)=>({workId,phase:value.phase,recordKind:'test-run-risk',record:value.outcome.record,revision,pushed:false,
        actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})}),
    decision={operations:[operation],async load(input,options){const context=await port.load(input,options);states.set(context,{input});return context;},
      async prepare(context,_request,options){const state=states.get(context);state.prepared=await port.prepare(context,state.input,options);return standaloneDecisionRequest(operation,state.input);},
      async resolve(context,raw){return {...raw,phaseId:context.phase.id};},commit(context,_intent,options){return port.commit(context,states.get(context).prepared,options);},
      finish(context,_intent,accepted){return port.finish(context,states.get(context).prepared,accepted);}},contextOperation='test-risk.context',
    context={async load(input,{signal}={}){if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:contextOperation,signal}),scope.projectId,contextOperation),
        captured=await observer.capture({signal}),phaseId=input.phaseId??captured.snapshot.workflow.currentPhase,
        value={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow,phase:captured.snapshot.workflow.phases[phaseId]};
      if(!value.phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');contexts.set(value,{captured,principal});return value;
    },async read(context,{signal}={}){const state=contexts.get(context);if(!state)fail('Use the issued risk context.','ENGINE_INPUT_INVALID');
      const value=await owned.context(state.captured.snapshot,context.phase.id,{signal,at:projectEnrollmentTimestamp(await clock.now())});
      phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:contextOperation,signal}),scope.projectId,contextOperation,{expected:state.principal});
      const fresh=await observer.capture({signal});if(fresh.snapshot.revision!==state.captured.snapshot.revision||fresh.basis.authorityVersion!==state.captured.basis.authorityVersion)
        fail('The Story or risk authority changed during inspection.','ENGINE_CONTEXT_CHANGED');return value;}};
  const recoveryDecision=createNamespaceRecordedMutationPort(options,{operation:'test-risk.confirm-recovery',explicitIdentity:true,
    request:input=>standaloneDecisionRequest('test-risk.confirm-recovery',input),owner:owned.owner,contract:namespaceDecisionContract,
    finish:(value,revision,{replayed})=>({workId,phase:value.phase,recordKind:'test-run-risk',record:value.outcome.record,revision:replayed?null:revision,
      retained:replayed,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  return Object.freeze({decision,recoveryDecision,context,owned});
}
