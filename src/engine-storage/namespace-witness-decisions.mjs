/** Registered human witness and read context; observation and conditional mutation have separate owners. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {stepGroups,fallbackAuthorities} from '../kernel/approval-fallback.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceWitnessOwners} from './namespace-witness-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
export function createNamespaceWitnessPorts(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceWitnessOwners({observer,scope,workId}),
    request=(input,workflow)=>({...standaloneDecisionRequest('decision.witness',input),phaseId:workflow.currentPhase}),
    base=createNamespaceRecordedMutationPort(options,{operation:'decision.witness',request,owner:owned.owner,contract:namespaceDecisionContract,
      explicitIdentity:true,requestUsesWorkflow:true,finish:(value,revision)=>({workId,phase:value.phase,recordKind:'witness',record:value.outcome.record,
        revision,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  const decision={...base,async prepare(...args){const {phaseId,...value}=await base.prepare(...args);return value;},
    commit(context,intent,options){return base.commit(context,{...intent,phaseId:context.workflow.currentPhase},options);}},contexts=new WeakMap();
  const witnessContext={
    async load(input,{signal}={}){if(input.workId!=null&&input.workId!==workId)throw new SingularityFlowError('Use the bound Story.',{code:'ACTIVE_SUBJECT_MISMATCH'});
      const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:'witness.context',signal}),scope.projectId,'witness.context'),
        snapshot=(await observer.inspect({signal})).snapshot,context={subject:{kind:'story',id:workId},workflow:snapshot.workflow};contexts.set(context,{snapshot,principal,input});return context;},
    async read(context,{signal}={}){const s=contexts.get(context);if(!s)throw new SingularityFlowError('Use the issued witness context.',{code:'ENGINE_INPUT_INVALID'});
      const source=await owned.status(s.snapshot,s.input,{signal}),groups=[...new Set(source.eligible.flatMap(id=>stepGroups(s.snapshot.workflow,id)))].sort();
      phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:'witness.context',signal}),scope.projectId,'witness.context',{expected:s.principal});
      if((await observer.inspect({signal})).snapshot.revision!==s.snapshot.revision)throw new SingularityFlowError('The witness candidate changed during inspection.',{code:'ENGINE_CONTEXT_CHANGED'});
      return {schemaVersion:1,profile:'sflow-namespace-witness-context/v1',workId,phase:s.snapshot.workflow.currentPhase,revision:s.snapshot.revision,
        clauseId:s.input.clauseId,slot:source.slot,file:source.identity.file,contextBinding:source.identity.contextBinding,
        authorities:groups.length?groups:fallbackAuthorities(s.snapshot.workflow,source.eligible),result:source.result};}
  };
  return Object.freeze({decision,witnessContext});
}
