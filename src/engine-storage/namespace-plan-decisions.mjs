/** Conditional human plan decisions; exact observation and persistence have separate owners. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_PLAN_CORRECTION_SCHEMAS,namespacePlanCorrectionRecordProfile} from '../foundation/record-schema.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespacePlanDecisionOwners} from './namespace-plan-decisions-reader.mjs';
export function createNamespacePlanDecisionPorts(options){
  const {scope,workId,sources,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespacePlanDecisionOwners({observer,scope,workId,sources});
  function decision(operation,owner,recordKind){
    const request=(input,workflow)=>({...standaloneDecisionRequest(operation,input),phaseId:workflow.currentPhase}),
      base=createNamespaceRecordedMutationPort(options,{operation,request,owner,contract:namespaceDecisionContract,
        explicitIdentity:true,requestUsesWorkflow:true,finish:(value,revision)=>({workId,phase:value.phase,recordKind,record:value.outcome.record,
          revision,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
    return {...base,async prepare(...args){const {phaseId,...value}=await base.prepare(...args);return value;},
      commit(context,intent,options){return base.commit(context,{...intent,phaseId:context.workflow.currentPhase},options);}};
  }
  const states=new WeakMap(),operation='plan.correction.context',correctionContext={
    async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)throw new SingularityFlowError('Use the bound Story.',{code:'ACTIVE_SUBJECT_MISMATCH'});
      const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation),
        snapshot=(await observer.inspect({signal})).snapshot,context={subject:{kind:'story',id:workId},workflow:snapshot.workflow};
      states.set(context,{snapshot,principal,request:standaloneDecisionRequest(operation,input)});return context;
    },
    async read(context,{signal}={}){const state=states.get(context);if(!state)throw new SingularityFlowError('Use the issued plan-correction context.',{code:'ENGINE_INPUT_INVALID'});
      const value=await owned.correctionPreview(state.snapshot,state.request,{signal}),profile=namespacePlanCorrectionRecordProfile('context',{schemaVersion:NAMESPACE_PLAN_CORRECTION_SCHEMAS.context.currentVersion});
      phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation,{expected:state.principal});
      if((await observer.inspect({signal})).snapshot.revision!==state.snapshot.revision)throw new SingularityFlowError('The exact plan changed during review.',{code:'ENGINE_CONTEXT_CHANGED'});
      return {schemaVersion:profile.version,format:profile.format,workId,phase:state.snapshot.workflow.currentPhase,revision:state.snapshot.revision,
        request:state.request,preview:value.preview,recording:value.recording,owner:{phase:value.preview.ownerPhase,generation:value.preview.ownerGeneration,
          mapSha256:value.preview.ownerMapSha256,proof:value.identity.owner},authorities:value.groups};}
  };
  return Object.freeze({decision:decision('decision.plan',owned.owner,'plan-amendment'),
    correctionRecord:decision('plan.correction.record',owned.correctionOwner,'plan-row-correction'),correctionContext});
}
export function createNamespacePlanDecisionPort(options){return createNamespacePlanDecisionPorts(options).decision;}
