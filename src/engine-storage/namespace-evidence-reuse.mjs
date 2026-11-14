/** Human reuse coordination over the same accepted conditional-mutation path as other decisions. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {createNamespaceEvidenceReuseOwner} from './namespace-evidence-reuse-reader.mjs';
const fail=(message,code)=>{throw new SingularityFlowError(message,{code});};
export function createNamespaceEvidenceReusePorts(options){
  const {scope,workId,access,clock}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceEvidenceReuseOwner({...options,observer}),
    operation='decision.evidence-reuse',states=new WeakMap(),contexts=new WeakMap(),
    request=(input,workflow)=>{const raw=standaloneDecisionRequest(operation,input),phaseId=raw.revoke
      ?workflow.namespaceEvidenceReuses?.find(row=>row.id===raw.revoke)?.phase:raw.phaseId;
      if(Boolean(raw.revoke)===Boolean(raw.phaseId)||raw.revoke&&(raw.attemptId||raw.expires)||!phaseId||!raw.revoke&&!raw.attemptId)fail(
        'Select a returned original task and receiving phase, or an existing reuse decision to revoke.','EVIDENCE_REUSE_INVALID');
      return {...raw,phaseId};},
    port=createNamespaceRecordedMutationPort(options,{operation,request,requestUsesWorkflow:true,owner:owned.owner,contract:namespaceDecisionContract,
      finish:(value,revision)=>({workId,phase:value.phase,recordKind:'evidence-reuse',record:value.outcome.record,revision,pushed:false,
        actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  const decision={operations:[operation],
    async load(input,options){const context=await port.load(input,options);states.set(context,{input});return context;},
    async prepare(context,_request,options){const state=states.get(context);state.prepared=await port.prepare(context,state.input,options);
      return standaloneDecisionRequest(operation,state.input);},
    async resolve(context,raw){return {...raw,phaseId:context.phase.id};},
    commit(context,_intent,options){return port.commit(context,states.get(context).prepared,options);},
    finish(context,_intent,accepted){return port.finish(context,states.get(context).prepared,accepted);}};
  const contextOperation='evidence-reuse.context',context={async load(input,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
    const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:contextOperation,signal}),scope.projectId,contextOperation),
      captured=await observer.capture({signal}),phaseId=input.phaseId??captured.snapshot.workflow.currentPhase,
      value={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow,phase:captured.snapshot.workflow.phases[phaseId]};
    if(!value.phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');contexts.set(value,{captured,principal,input});return value;
  },async read(context,{signal}={}){
    const state=contexts.get(context);if(!state)fail('Use the issued reuse context.','ENGINE_INPUT_INVALID');
    const value=await owned.context(state.captured.snapshot,context.phase.id,{signal,at:projectEnrollmentTimestamp(await clock.now()),...(state.input.producerOperationId?{producerOperationId:state.input.producerOperationId,producerPhaseId:state.input.producerPhaseId??context.phase.id}:{})});
    phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:contextOperation,signal}),scope.projectId,contextOperation,{expected:state.principal});
    const fresh=await observer.capture({signal});
    if(fresh.snapshot.revision!==state.captured.snapshot.revision||fresh.basis.authorityVersion!==state.captured.basis.authorityVersion)fail(
      'The Story or reuse authority changed during inspection.','ENGINE_CONTEXT_CHANGED');return value;
  }};
  return Object.freeze({decision,context,owned});
}
